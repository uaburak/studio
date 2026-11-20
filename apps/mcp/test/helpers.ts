// Test helpers: a fake Studio API (node:http on 127.0.0.1) that enforces the owner header like
// the real one, a throwaway state folder with a fake owner secret, and an in-memory MCP client.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStudioMcp, type StudioMcp, type StudioServerOptions } from "../src/server.ts";
import { loadCachedSpec } from "../src/spec.ts";

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: Buffer;
  json?: unknown;
}

export interface FakeReply {
  status?: number;
  json?: unknown;
  bytes?: Uint8Array;
  type?: string;
}

export type Handler = (req: FakeRequest) => FakeReply | Promise<FakeReply>;

export interface FakeApi {
  url: string;
  secret: string;
  requests: FakeRequest[];
  /** `"GET /api/brands"` → handler; unknown routes answer 404. */
  routes: Map<string, Handler>;
  close(): Promise<void>;
}

export async function startFakeApi(secret: string): Promise<FakeApi> {
  const routes = new Map<string, Handler>();
  const requests: FakeRequest[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const body = Buffer.concat(chunks);
    const request: FakeRequest = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      body,
    };
    if ((req.headers["content-type"] ?? "").includes("json") && body.length > 0) {
      request.json = JSON.parse(body.toString("utf8"));
    }
    requests.push(request);
    const host = (req.headers.host ?? "").split(":")[0];
    if (host !== "127.0.0.1" && host !== "localhost") {
      res.writeHead(401).end();
      return;
    }
    if (req.headers["x-studio-owner"] !== secret) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "unauthorized" } }));
      return;
    }
    const handler = routes.get(`${request.method} ${request.path}`);
    const reply: FakeReply = handler
      ? await handler(request)
      : { status: 404, json: { error: { code: "not_found", message: request.path } } };
    if (reply.bytes) {
      res.writeHead(reply.status ?? 200, {
        "content-type": reply.type ?? "application/octet-stream",
      });
      res.end(Buffer.from(reply.bytes));
    } else if (reply.json !== undefined) {
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.json));
    } else {
      res.writeHead(reply.status ?? 204).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    secret,
    requests,
    routes,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface Harness {
  api: FakeApi;
  mcp: StudioMcp;
  client: Client;
  stateDir: string;
  homeDir: string;
  tmpDir: string;
  logFile: string;
  close(): Promise<void>;
}

/** A fake API + state folder + MCP server + connected client. */
export async function startHarness(options: Partial<StudioServerOptions> = {}): Promise<Harness> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "studio-mcp-test-")));
  const stateDir = join(root, "state");
  const homeDir = join(root, "home");
  const tmpDir = join(root, "out");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(join(stateDir, "owner-secret"), secret, { mode: 0o600 });
  const api = await startFakeApi(secret);
  const mcp = createStudioMcp({
    baseUrl: api.url,
    stateDir,
    homeDir,
    tmpDir,
    spec: loadCachedSpec(),
    ...options,
  });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcp.server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    api,
    mcp,
    client,
    stateDir,
    homeDir,
    tmpDir,
    logFile: join(stateDir, "logs", "mcp.log"),
    async close() {
      await client.close();
      await mcp.server.close();
      await api.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export interface CallOutput {
  text: string;
  isError: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

export async function call(
  h: Harness,
  name: string,
  args: Record<string, unknown> = {},
  onprogress?: (p: { progress: number; total?: number; message?: string }) => void,
): Promise<CallOutput> {
  const result = (await h.client.callTool(
    { name, arguments: args },
    undefined,
    onprogress ? { onprogress } : undefined,
  )) as { content: CallOutput["content"]; isError?: boolean };
  return {
    text: result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n"),
    isError: result.isError === true,
    content: result.content,
  };
}

export function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}
