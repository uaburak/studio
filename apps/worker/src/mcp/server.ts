/**
 * Studio's MCP server for the chat agent (A5), in the worker process.
 *
 * MCP "Streamable HTTP" (2025-06-18) on 127.0.0.1:<free port>/mcp, the way Wecra does it
 * (DesignerV2 src/main/agents/mcpServer.ts): JSON-RPC over POST only (GET is 405), no
 * server-initiated stream. Anything on this Mac can reach a loopback port, so:
 * - every request needs a bearer token; each chat run gets its own (`grant`), written into
 *   that turn's mcp.json (mode 0600) and revoked when the run ends;
 * - DNS rebinding: only our own host names, and no browser page (a cross-site POST always
 *   carries `Origin`);
 * - a session (`Mcp-Session-Id`) belongs to the token that opened it.
 *
 * Long tool calls (a consent card waits up to 5 minutes, `ask_user` up to 10, `wait_jobs`)
 * are answered as `text/event-stream` once they take longer than a second: the headers go
 * out at once and a keep-alive comment every 15 s, so no HTTP client times out while the
 * owner decides. Quick calls answer as plain JSON.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Logger } from "../log.ts";
import { silentLogger } from "../log.ts";

export const MCP_SERVER_NAME = "studio";
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: object;
  title?: string;
}

/** What one run may do through the server. */
export interface McpGrant {
  /** For logs (the run id). */
  label: string;
  tools(): McpToolDescriptor[];
  call(
    name: string,
    args: Record<string, unknown>,
    ctx: { callId: string; signal: AbortSignal },
  ): Promise<McpToolResult>;
  /** Server-level instructions shown to the client at `initialize`. */
  instructions?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

interface GrantEntry {
  grant: McpGrant;
  abort: AbortController;
  sessions: Set<string>;
  inFlight: Map<string, AbortController>;
}

export interface StudioMcpServerOptions {
  logger?: Logger;
  /** Answer as JSON when the call finishes within this (default 1000 ms); else SSE. */
  deferAfterMs?: number;
  /** SSE keep-alive comment interval (default 15 s). */
  keepAliveMs?: number;
  /** Request body limit (default 4 MiB). */
  maxBodyBytes?: number;
}

const rpcError = (id: JsonRpcRequest["id"], code: number, message: string): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Our own host names only (DNS rebinding guard). */
export function isAllowedHost(host: string | undefined): boolean {
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/i.test(String(host ?? ""));
}

export class StudioMcpServer {
  private server: Server | null = null;
  private port = 0;
  private readonly grants = new Map<string, GrantEntry>();
  private readonly sessions = new Map<string, string>(); // session id -> token
  private readonly sockets = new Set<Socket>();
  private readonly logger: Logger;

  constructor(private readonly options: StudioMcpServerOptions = {}) {
    this.logger = options.logger ?? silentLogger;
  }

  /** `http://127.0.0.1:<port>/mcp` once started. */
  get url(): string | null {
    return this.server ? `http://127.0.0.1:${this.port}/mcp` : null;
  }

  /** Listen on 127.0.0.1 (a free port). Idempotent. */
  async start(): Promise<string> {
    if (this.server) return this.url as string;
    const server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        this.logger.warn(`mcp: request failed: ${(error as Error).message}`);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    // Tool calls may legitimately take minutes; the SSE keep-alive keeps the client happy.
    server.requestTimeout = 0;
    server.headersTimeout = 0;
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    server.unref(); // never keeps the worker alive on its own
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    return this.url as string;
  }

  async stop(): Promise<void> {
    for (const token of [...this.grants.keys()]) this.revoke(token);
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** A new token for one run. */
  grant(grant: McpGrant): string {
    const token = randomBytes(24).toString("base64url");
    this.grants.set(token, {
      grant,
      abort: new AbortController(),
      sessions: new Set(),
      inFlight: new Map(),
    });
    return token;
  }

  /** The run is over: the token stops working, its sessions end, its calls are aborted. */
  revoke(token: string): void {
    const entry = this.grants.get(token);
    if (!entry) return;
    this.grants.delete(token);
    entry.abort.abort(new Error("the run ended"));
    for (const c of entry.inFlight.values()) c.abort(new Error("the run ended"));
    for (const id of entry.sessions) this.sessions.delete(id);
  }

  /** Tokens currently valid (tests, logs). */
  get activeGrants(): number {
    return this.grants.size;
  }

  private authorize(req: IncomingMessage): { token: string; entry: GrantEntry } | null {
    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(Array.isArray(header) ? (header[0] ?? "") : header);
    if (!m?.[1]) return null;
    for (const [token, entry] of this.grants) {
      if (sameSecret(m[1], token)) return { token, entry };
    }
    return null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (!isAllowedHost(req.headers.host)) {
      return send(403, rpcError(null, -32000, "Forbidden host"));
    }
    if (req.headers.origin && req.headers.origin !== "null") {
      return send(403, rpcError(null, -32000, "Forbidden origin"));
    }
    if ((req.url ?? "").split("?")[0] !== "/mcp") {
      return send(404, rpcError(null, -32000, "Not found"));
    }
    const auth = this.authorize(req);
    if (!auth) {
      return send(401, rpcError(null, -32001, "Unauthorized"), { "WWW-Authenticate": "Bearer" });
    }
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = typeof sessionHeader === "string" ? sessionHeader : null;
    if (req.method === "DELETE") {
      if (sessionId && this.sessions.get(sessionId) === auth.token) {
        this.sessions.delete(sessionId);
        auth.entry.sessions.delete(sessionId);
      }
      return send(200);
    }
    if (req.method !== "POST") return send(405, undefined, { Allow: "POST, DELETE" });

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, this.options.maxBodyBytes ?? 4 * 1024 * 1024));
    } catch (error) {
      if ((error as Error).message === "too large") {
        return send(413, rpcError(null, -32000, "Request too large"));
      }
      return send(400, rpcError(null, -32700, "Parse error"));
    }
    const batch = Array.isArray(body);
    const messages = (batch ? body : [body]) as JsonRpcRequest[];
    const isInit = messages.some((m) => m?.method === "initialize");

    let session = sessionId;
    if (session) {
      const owner = this.sessions.get(session);
      if (!owner) return send(404, rpcError(null, -32000, "Session not found"));
      if (owner !== auth.token) {
        return send(403, rpcError(null, -32000, "Session belongs to another token"));
      }
    } else if (isInit) {
      session = randomUUID();
      this.sessions.set(session, auth.token);
      auth.entry.sessions.add(session);
    }
    const headers: Record<string, string> = session ? { "Mcp-Session-Id": session } : {};

    // Everything but one tools/call (the common case) is answered at once.
    const single = !batch && messages[0]?.method === "tools/call" && messages[0].id !== undefined;
    if (!single) {
      const replies: JsonRpcResponse[] = [];
      for (const m of messages) {
        const reply = await this.dispatch(auth.entry, m, session ?? "");
        if (reply) replies.push(reply);
      }
      if (replies.length === 0) return send(202, undefined, headers);
      return send(200, batch ? replies : replies[0], headers);
    }

    const message = messages[0] as JsonRpcRequest;
    const pending = this.dispatch(auth.entry, message, session ?? "");
    const deferAfter = this.options.deferAfterMs ?? 1000;
    const early = await Promise.race([
      pending.then((reply) => ({ reply })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deferAfter).unref?.()),
    ]);
    if (early) return send(200, early.reply, headers);
    const accept = String(req.headers.accept ?? "");
    if (!accept.includes("text/event-stream")) {
      const reply = await pending;
      return send(200, reply, headers);
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      ...headers,
    });
    res.write(": studio\n\n");
    const keepAlive = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, this.options.keepAliveMs ?? 15_000);
    try {
      const reply = await pending;
      if (!res.writableEnded) res.end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    } finally {
      clearInterval(keepAlive);
    }
  }

  /** One JSON-RPC message; null for a notification. */
  private async dispatch(
    entry: GrantEntry,
    m: JsonRpcRequest,
    session: string,
  ): Promise<JsonRpcResponse | null> {
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      return rpcError(m?.id ?? null, -32600, "Invalid request");
    }
    const notification = m.id === undefined;
    const ok = (result: unknown): JsonRpcResponse | null =>
      notification ? null : { jsonrpc: "2.0", id: m.id ?? null, result };
    switch (m.method) {
      case "initialize": {
        const asked = m.params?.protocolVersion;
        return ok({
          protocolVersion:
            typeof asked === "string" && MCP_PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: "Studio", version: "1" },
          ...(entry.grant.instructions ? { instructions: entry.grant.instructions } : {}),
        });
      }
      case "ping":
        return ok({});
      case "notifications/cancelled": {
        const requestId = m.params?.requestId;
        if (requestId !== undefined) {
          entry.inFlight.get(`${session}:${String(requestId)}`)?.abort(new Error("cancelled"));
        }
        return null;
      }
      case "tools/list":
        return ok({
          tools: entry.grant.tools().map((t) => ({
            name: t.name,
            ...(t.title ? { title: t.title } : {}),
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const args = m.params?.arguments ?? {};
        if (!entry.grant.tools().some((t) => t.name === name)) {
          return rpcError(m.id, -32602, `Unknown tool: ${name}`);
        }
        if (typeof args !== "object" || Array.isArray(args) || args === null) {
          return rpcError(m.id, -32602, "arguments must be an object");
        }
        const key = `${session}:${String(m.id)}`;
        const call = new AbortController();
        entry.inFlight.set(key, call);
        try {
          const result = await entry.grant.call(name, args as Record<string, unknown>, {
            callId: String(m.id ?? randomUUID()),
            signal: AbortSignal.any([entry.abort.signal, call.signal]),
          });
          return ok(result);
        } catch (error) {
          return ok({
            content: [{ type: "text", text: `Hata: ${(error as Error).message}` }],
            isError: true,
          });
        } finally {
          entry.inFlight.delete(key);
        }
      }
      case "resources/list":
        return ok({ resources: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      default:
        return notification ? null : rpcError(m.id, -32601, `Method not found: ${m.method}`);
    }
  }
}

/** The `--mcp-config` JSON for one run (Streamable HTTP with the run's token). */
export function mcpConfigJson(url: string, token: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
      },
    },
    null,
    2,
  );
}

/** Write the run's mcp.json, readable by the owner only. */
export async function writeMcpConfig(file: string, url: string, token: string): Promise<void> {
  await writeFile(file, mcpConfigJson(url, token), { mode: 0o600 });
  await chmod(file, 0o600);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
