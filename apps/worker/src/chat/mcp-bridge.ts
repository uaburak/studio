/**
 * Ephemeral local MCP bridge for CLI agents (`claude` and `gemini` CLI).
 *
 * For the duration of one chat turn, the worker runs an authenticated HTTP
 * server on `127.0.0.1:0` that dispatches `tools/list` and `tools/call`
 * directly to the turn's in-process `StudioToolExecutor` (so streamed text,
 * `tool_step` parts, `putPlan`, and 5-minute `consent` cards all flow through
 * the turn's single `TurnWriter`).
 *
 * A tiny zero-dependency pure-Node stdio JSON-RPC 2.0 script (`studio-mcp.mjs`)
 * is written into the turn's temp `workDir`, so spawning `process.execPath`
 * works identically under `tsx`, `vitest`, and the bundled `dist/main.js`.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildGeminiCliSettings, buildGeminiPolicyToml } from "../gemini/cli-sandbox.ts";
import type { StudioToolDefinition, StudioToolExecutor } from "./tools.ts";

/**
 * Studio.app runs the worker with its own binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), so
 * `process.execPath` is the app: a CLI that starts the bridge script with it must pass the same
 * variable on, or it would open a second copy of the app instead of running the script.
 */
export function nodeModeEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return env.ELECTRON_RUN_AS_NODE ? { ELECTRON_RUN_AS_NODE: "1" } : {};
}

export interface McpBridge {
  readonly url: string;
  readonly token: string;
  readonly workDir: string;
  readonly scriptPath: string;
  readonly claudeMcpConfigPath: string;
  readonly geminiSettingsPath: string;
  /** Admin-tier Gemini CLI policy: Studio's tools allowed, every other tool denied. */
  readonly geminiPolicyPath: string;
  readonly allowedTools: string[];
  /** Direct in-process HTTP handler (also useful when loopback `connect` is sandbox-blocked). */
  dispatchHttp(
    authorization: string | undefined,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

export interface McpBridgeOptions {
  workRoot?: string;
  signal?: AbortSignal;
}

type BridgeRequest =
  | { action: "list" }
  | { action: "call"; name: string; arguments?: unknown; callId?: string };

function tokensMatch(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startMcpBridge(
  executor: StudioToolExecutor,
  options: McpBridgeOptions = {},
): Promise<McpBridge> {
  const root = options.workRoot ?? tmpdir();
  await mkdir(root, { recursive: true });
  const workDir = await mkdtemp(path.join(root, "studio-mcp-"));
  const ipcDir = path.join(workDir, "mcp-ipc");
  await mkdir(ipcDir, { recursive: true, mode: 0o700 });

  const token = randomBytes(32).toString("hex");
  const sockets = new Set<Socket>();

  const dispatch = async (req: BridgeRequest): Promise<Record<string, unknown>> => {
    if (req.action === "list") {
      return { tools: executor.mcpTools() };
    }
    if (req.action === "call" && typeof req.name === "string") {
      const out = await executor.execute(req.name, req.arguments ?? {}, req.callId);
      return {
        content: [{ type: "text", text: JSON.stringify(out.data) }],
        isError: out.isError,
      };
    }
    throw new Error("invalid bridge action");
  };

  const dispatchHttp = async (
    authorization: string | undefined,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!bearer || !tokensMatch(token, bearer)) {
      return { status: 401, body: { error: "unauthorized" } };
    }
    if (!body || typeof body !== "object") {
      return { status: 400, body: { error: "invalid JSON body" } };
    }
    try {
      const result = await dispatch(body as BridgeRequest);
      return { status: 200, body: result };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        status: 200,
        body: {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: msg }) }],
          isError: true,
        },
      };
    }
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/mcp") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.byteLength;
        if (total > 2 * 1024 * 1024) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "payload_too_large" }));
          return;
        }
        chunks.push(buf);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }
      const out = await dispatchHttp(req.headers.authorization, parsed);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("unexpected server address"));
        return;
      }
      resolve(addr.port);
    });
  });
  const url = `http://127.0.0.1:${port}/mcp`;

  // File-IPC fallback loop (only triggered when a sandboxed test denies loopback `connect()`).
  const inFlight = new Set<string>();
  let closed = false;
  const pollIpc = async () => {
    if (closed) return;
    try {
      const files = await readdir(ipcDir);
      for (const file of files) {
        if (!file.startsWith("req-") || !file.endsWith(".json") || inFlight.has(file)) continue;
        inFlight.add(file);
        void (async () => {
          const reqPath = path.join(ipcDir, file);
          const id = file.slice(4, -5);
          const tmpPath = path.join(ipcDir, `.res-${id}.tmp`);
          const resPath = path.join(ipcDir, `res-${id}.json`);
          try {
            const raw = JSON.parse(await readFile(reqPath, "utf8")) as {
              token?: string;
              payload?: unknown;
            };
            await unlink(reqPath).catch(() => undefined);
            const out = await dispatchHttp(
              raw.token ? `Bearer ${raw.token}` : undefined,
              raw.payload,
            );
            await writeFile(tmpPath, JSON.stringify(out), { mode: 0o600 });
            await rename(tmpPath, resPath);
          } catch {
            // Cleaned up when bridge closes
          } finally {
            inFlight.delete(file);
          }
        })();
      }
    } catch {
      // Directory gone on close
    }
  };
  const ipcTimer = setInterval(() => void pollIpc(), 15);
  ipcTimer.unref?.();

  const configPath = path.join(workDir, "studio-mcp-config.json");
  await writeFile(configPath, JSON.stringify({ url, token, ipcDir, tools: executor.mcpTools() }), {
    mode: 0o600,
  });

  const scriptPath = path.join(workDir, "studio-mcp.mjs");
  await writeFile(scriptPath, buildMcpStdioScript(), { mode: 0o700 });

  const serverEnv = {
    STUDIO_MCP_BRIDGE_URL: url,
    STUDIO_MCP_BRIDGE_TOKEN: token,
    STUDIO_MCP_IPC_DIR: ipcDir,
    ...nodeModeEnv(),
  };

  const claudeMcpConfigPath = path.join(workDir, "claude-mcp-config.json");
  await writeFile(
    claudeMcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          studio: {
            type: "stdio",
            command: process.execPath,
            args: [scriptPath],
            env: serverEnv,
          },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  // Gemini CLI: Studio's tools only (no built-in shell, file or web tools; see cli-sandbox.ts).
  const geminiDir = path.join(workDir, ".gemini");
  await mkdir(geminiDir, { recursive: true });
  const geminiPolicyPath = path.join(geminiDir, "studio-policy.toml");
  await writeFile(geminiPolicyPath, buildGeminiPolicyToml(), { mode: 0o600 });
  const geminiSettingsPath = path.join(geminiDir, "settings.json");
  await writeFile(
    geminiSettingsPath,
    JSON.stringify(
      buildGeminiCliSettings({
        server: { command: process.execPath, args: [scriptPath], env: serverEnv },
        policyPath: geminiPolicyPath,
      }),
      null,
      2,
    ),
    { mode: 0o600 },
  );

  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(ipcTimer);
    for (const s of sockets) s.destroy();
    sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  };

  options.signal?.addEventListener("abort", () => void close(), { once: true });

  return {
    url,
    token,
    workDir,
    scriptPath,
    claudeMcpConfigPath,
    geminiSettingsPath,
    geminiPolicyPath,
    allowedTools: executor.toolNames().map((n) => `mcp__studio__${n}`),
    dispatchHttp,
    close,
  };
}

/**
 * Self-contained pure-Node stdio JSON-RPC 2.0 MCP bridge script written to
 * `<workDir>/studio-mcp.mjs` (zero external dependencies, Node 22/24 built-ins only).
 */
export function buildMcpStdioScript(): string {
  return `#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
let localCfg = {};
try {
  localCfg = JSON.parse(readFileSync(path.join(here, "studio-mcp-config.json"), "utf8"));
} catch {}

const bridgeUrl = process.env.STUDIO_MCP_BRIDGE_URL || localCfg.url;
const bridgeToken = process.env.STUDIO_MCP_BRIDGE_TOKEN || localCfg.token;
const ipcDir = process.env.STUDIO_MCP_IPC_DIR || localCfg.ipcDir;
let ipcSeq = 0;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

function callViaHttp(payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(bridgeUrl);
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: "POST",
        headers: {
          authorization: "Bearer " + bridgeToken,
          "content-type": "application/json",
          "content-length": body.byteLength,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (res.statusCode !== 200) {
              reject(new Error(data.error || ("HTTP " + res.statusCode)));
              return;
            }
            resolve(data);
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.setTimeout(0);
    req.on("error", reject);
    req.end(body);
  });
}

async function callViaIpc(payload) {
  if (!ipcDir) throw new Error("no IPC fallback directory");
  const id = process.pid + "-" + (++ipcSeq) + "-" + Date.now();
  const tmpReq = path.join(ipcDir, ".req-" + id + ".tmp");
  const reqFile = path.join(ipcDir, "req-" + id + ".json");
  const resFile = path.join(ipcDir, "res-" + id + ".json");
  writeFileSync(tmpReq, JSON.stringify({ token: bridgeToken, payload }), { mode: 0o600 });
  renameSync(tmpReq, reqFile);
  for (;;) {
    if (existsSync(resFile)) {
      const raw = JSON.parse(readFileSync(resFile, "utf8"));
      try { unlinkSync(resFile); } catch {}
      if (raw.status !== 200) throw new Error(raw.body?.error || ("IPC " + raw.status));
      return raw.body;
    }
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function callParent(payload) {
  try {
    return await callViaHttp(payload);
  } catch (err) {
    if (ipcDir && (err?.code === "EPERM" || err?.code === "EACCES")) {
      return callViaIpc(payload);
    }
    throw err;
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification (e.g. notifications/initialized)

  try {
    switch (method) {
      case "initialize":
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion:
              typeof params?.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "studio", version: "1.0.0" },
          },
        });
        return;
      case "ping":
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      case "tools/list": {
        const res = Array.isArray(localCfg.tools)
          ? { tools: localCfg.tools }
          : await callParent({ action: "list" });
        send({ jsonrpc: "2.0", id, result: { tools: res.tools ?? [] } });
        return;
      }
      case "tools/call": {
        const name = params?.name;
        if (typeof name !== "string" || !name) {
          send({
            jsonrpc: "2.0",
            id,
            error: { code: -32602, message: "tool name is required" },
          });
          return;
        }
        const res = await callParent({
          action: "call",
          name,
          arguments: params?.arguments ?? {},
          callId: String(id),
        });
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: res.content ?? [{ type: "text", text: "{}" }],
            isError: Boolean(res.isError),
          },
        });
        return;
      }
      case "resources/list":
        send({ jsonrpc: "2.0", id, result: { resources: [] } });
        return;
      case "prompts/list":
        send({ jsonrpc: "2.0", id, result: { prompts: [] } });
        return;
      default:
        send({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found: " + String(method) },
        });
    }
  } catch (err) {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          },
        ],
        isError: true,
      },
    });
  }
}

let tail = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  tail += chunk;
  const lines = tail.split("\\n");
  tail = lines.pop() ?? "";
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("Content-Length:")) continue;
    try {
      void handleMessage(JSON.parse(trimmed));
    } catch {}
  }
});
process.stdin.on("end", () => {
  const trimmed = tail.trim();
  if (trimmed) {
    try { void handleMessage(JSON.parse(trimmed)); } catch {}
  }
});
`;
}

/**
 * Stdio MCP bridge mode when `main.ts` is invoked directly with `--studio-mcp-bridge`
 * and `STUDIO_MCP_BRIDGE_URL` + `STUDIO_MCP_BRIDGE_TOKEN`.
 */
export async function runStdioMcpBridgeFromEnv(): Promise<void> {
  const bridgeUrl = process.env.STUDIO_MCP_BRIDGE_URL ?? "";
  const bridgeToken = process.env.STUDIO_MCP_BRIDGE_TOKEN ?? "";
  if (!bridgeUrl || !bridgeToken) {
    process.stderr.write("STUDIO_MCP_BRIDGE_URL and STUDIO_MCP_BRIDGE_TOKEN are required\n");
    process.exit(1);
  }

  const callHttp = (
    payload: BridgeRequest,
  ): Promise<{
    tools?: StudioToolDefinition[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  }> =>
    new Promise((resolve, reject) => {
      const parsed = new URL(bridgeUrl);
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      const req = httpRequest(
        {
          hostname: parsed.hostname,
          port: Number(parsed.port),
          path: parsed.pathname,
          method: "POST",
          headers: {
            authorization: `Bearer ${bridgeToken}`,
            "content-type": "application/json",
            "content-length": body.byteLength,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
          res.on("end", () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
                string,
                unknown
              >;
              if (res.statusCode !== 200) {
                reject(new Error(String(data.error ?? `HTTP ${res.statusCode}`)));
                return;
              }
              resolve(data);
            } catch (err) {
              reject(err);
            }
          });
        },
      );
      req.setTimeout(0);
      req.on("error", reject);
      req.end(body);
    });

  const send = (msg: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  const handle = async (msg: Record<string, unknown>) => {
    const id = msg.id;
    if (id === undefined || id === null) return;
    const method = msg.method;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    try {
      if (method === "initialize") {
        send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion:
              typeof params.protocolVersion === "string" ? params.protocolVersion : "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "studio", version: "1.0.0" },
          },
        });
        return;
      }
      if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
        return;
      }
      if (method === "tools/list") {
        const res = await callHttp({ action: "list" });
        send({ jsonrpc: "2.0", id, result: { tools: res.tools ?? [] } });
        return;
      }
      if (method === "tools/call") {
        const name = typeof params.name === "string" ? params.name : "";
        const res = await callHttp({
          action: "call",
          name,
          arguments: params.arguments ?? {},
          callId: String(id),
        });
        send({
          jsonrpc: "2.0",
          id,
          result: {
            content: res.content ?? [{ type: "text", text: "{}" }],
            isError: Boolean(res.isError),
          },
        });
        return;
      }
      send({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${String(method)}` },
      });
    } catch (error) {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
          isError: true,
        },
      });
    }
  };

  let tail = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    tail += chunk;
    const lines = tail.split("\n");
    tail = lines.pop() ?? "";
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      try {
        void handle(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // ignore non-JSON
      }
    }
  });
  await new Promise<void>((resolve) => process.stdin.on("end", () => resolve()));
}
