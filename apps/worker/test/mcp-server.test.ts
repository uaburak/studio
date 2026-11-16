import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Content } from "@studio/contract";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { StudioToolExecutor } from "../src/chat/tools.ts";
import { executorGrant } from "../src/chat/turn.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import {
  isAllowedHost,
  type McpGrant,
  StudioMcpServer,
  writeMcpConfig,
} from "../src/mcp/server.ts";
import { createFakeApi, NOW } from "./fake-api.ts";

const servers: StudioMcpServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function started(options: ConstructorParameters<typeof StudioMcpServer>[0] = {}) {
  const server = new StudioMcpServer(options);
  servers.push(server);
  const url = await server.start();
  return { server, url };
}

/** Raw HTTP (fetch would not let us forge Host). */
function raw(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: u.hostname,
        port: Number(u.port),
        path: u.pathname,
        method: init.method ?? "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...init.headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          text += c;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string>,
            text,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body === undefined ? undefined : JSON.stringify(init.body));
  });
}

const rpc = (id: number | undefined, method: string, params?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  ...(id !== undefined ? { id } : {}),
  method,
  ...(params ? { params } : {}),
});

/** JSON-RPC body of a JSON or SSE answer. */
function bodyOf(res: { headers: Record<string, string>; text: string }) {
  if (String(res.headers["content-type"]).includes("text/event-stream")) {
    const data = res.text.split("\n").find((l) => l.startsWith("data: "));
    return JSON.parse(data?.slice(6) ?? "null");
  }
  return res.text ? JSON.parse(res.text) : null;
}

const echoGrant = (calls: string[] = []): McpGrant => ({
  label: "run_test",
  tools: () => [
    { name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } },
    { name: "slow", description: "slow", inputSchema: { type: "object", properties: {} } },
  ],
  call: async (name, args, { signal }) => {
    calls.push(name);
    if (name === "slow") {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, Number(args.ms ?? 300));
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(signal.reason);
        });
      });
    }
    return { content: [{ type: "text", text: JSON.stringify({ name, args }) }] };
  },
});

describe("Studio MCP server (Streamable HTTP)", () => {
  it("refuses requests without or with a wrong token, foreign hosts and web origins", async () => {
    const { server, url } = await started();
    const token = server.grant(echoGrant());
    const auth = { authorization: `Bearer ${token}` };
    expect((await raw(url, { body: rpc(1, "ping") })).status).toBe(401);
    expect(
      (await raw(url, { body: rpc(1, "ping"), headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
    // DNS rebinding: a name that resolves to 127.0.0.1 but is not ours.
    expect(
      (await raw(url, { body: rpc(1, "ping"), headers: { ...auth, host: "evil.example:80" } }))
        .status,
    ).toBe(403);
    // A web page (cross-site POST carries Origin).
    expect(
      (
        await raw(url, {
          body: rpc(1, "ping"),
          headers: { ...auth, origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect((await raw(url, { method: "GET", headers: auth })).status).toBe(405);
    const ok = await raw(url, { body: rpc(1, "ping"), headers: auth });
    expect(ok.status).toBe(200);
    expect(bodyOf(ok)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(isAllowedHost("localhost:1234")).toBe(true);
    expect(isAllowedHost("127.0.0.1.nip.io:1234")).toBe(false);
  });

  it("initializes a session, lists and calls tools, and keeps sessions to their token", async () => {
    const { server, url } = await started();
    const calls: string[] = [];
    const token = server.grant(echoGrant(calls));
    const other = server.grant(echoGrant());
    const auth = { authorization: `Bearer ${token}` };
    const init = await raw(url, {
      body: rpc(1, "initialize", { protocolVersion: "2025-06-18" }),
      headers: auth,
    });
    const session = init.headers["mcp-session-id"] as string;
    expect(session).toMatch(/[0-9a-f-]{36}/);
    expect(bodyOf(init).result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "studio" },
    });
    const note = await raw(url, {
      body: rpc(undefined, "notifications/initialized"),
      headers: { ...auth, "mcp-session-id": session },
    });
    expect(note.status).toBe(202);
    const list = bodyOf(
      await raw(url, {
        body: rpc(2, "tools/list"),
        headers: { ...auth, "mcp-session-id": session },
      }),
    );
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual(["echo", "slow"]);
    const call = bodyOf(
      await raw(url, {
        body: rpc(3, "tools/call", { name: "echo", arguments: { a: 1 } }),
        headers: { ...auth, "mcp-session-id": session },
      }),
    );
    expect(JSON.parse(call.result.content[0].text)).toEqual({ name: "echo", args: { a: 1 } });
    expect(calls).toEqual(["echo"]);
    const unknown = bodyOf(
      await raw(url, {
        body: rpc(4, "tools/call", { name: "rm_rf", arguments: {} }),
        headers: auth,
      }),
    );
    expect(unknown.error.code).toBe(-32602);
    // Another run's token cannot use this session.
    const stolen = await raw(url, {
      body: rpc(5, "tools/list"),
      headers: { authorization: `Bearer ${other}`, "mcp-session-id": session },
    });
    expect(stolen.status).toBe(403);
  });

  it("answers a long call as an SSE stream with keep-alives, and revoking ends the run's calls", async () => {
    const { server, url } = await started({ deferAfterMs: 50, keepAliveMs: 40 });
    const token = server.grant(echoGrant());
    const auth = { authorization: `Bearer ${token}` };
    const slow = await raw(url, {
      body: rpc(1, "tools/call", { name: "slow", arguments: { ms: 200 } }),
      headers: auth,
    });
    expect(slow.headers["content-type"]).toContain("text/event-stream");
    expect(slow.text).toContain(": keep-alive");
    expect(JSON.parse(bodyOf(slow).result.content[0].text).name).toBe("slow");

    // A call still running when the run ends is aborted; the token stops working.
    const pending = raw(url, {
      body: rpc(2, "tools/call", { name: "slow", arguments: { ms: 5_000 } }),
      headers: auth,
    });
    await new Promise((r) => setTimeout(r, 100));
    server.revoke(token);
    const aborted = bodyOf(await pending);
    expect(aborted.result.isError).toBe(true);
    expect((await raw(url, { body: rpc(3, "ping"), headers: auth })).status).toBe(401);
    expect(server.activeGrants).toBe(0);
  });

  it("writes the run's mcp.json readable by the owner only", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mcp-cfg-"));
    const file = path.join(dir, "mcp.json");
    await writeMcpConfig(file, "http://127.0.0.1:1/mcp", "tok");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      mcpServers: {
        studio: {
          type: "http",
          url: "http://127.0.0.1:1/mcp",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });
  });
});

describe("Studio tools over MCP", () => {
  function content(): Content {
    return {
      id: "cnt_1",
      brandId: "brand_1",
      type: "post",
      title: "Bahar",
      brief: "Tarla",
      status: "in_review",
      targetPlatforms: ["instagram"],
      caption: "",
      currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) },
      approval: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  async function setup(opts: { consentTimeoutMs?: number } = {}) {
    const { api, state } = createFakeApi();
    state.contents.set("cnt_1", content());
    const controller = new AbortController();
    const writer = new TurnWriter({
      api,
      runId: "run_1",
      attempt: 1,
      signal: controller.signal,
      flushIntervalMs: 5,
    });
    const executor = new StudioToolExecutor({
      api,
      writer,
      runId: "run_1",
      conversationId: "conv_1",
      initialBrandId: "brand_1",
      initialOpenPlan: null,
      aliases: [],
      signal: controller.signal,
      consentPollIntervalMs: 10,
      consentTimeoutMs: opts.consentTimeoutMs ?? 5_000,
    });
    const { server, url } = await started({ deferAfterMs: 30, keepAliveMs: 20 });
    const token = server.grant(executorGrant(executor, "run_1"));
    const call = async (name: string, args: Record<string, unknown>) => {
      const res = await raw(url, {
        body: rpc(7, "tools/call", { name, arguments: args }),
        headers: { authorization: `Bearer ${token}` },
      });
      return bodyOf(res).result as {
        content: { type: string; text?: string; data?: string; mimeType?: string }[];
        isError?: boolean;
      };
    };
    return { api, state, call, server, token, controller };
  }

  it("holds a consent-gated call until the owner allows it", async () => {
    const { state, call } = await setup();
    const allow = setInterval(() => {
      const card = state.parts.find((p) => p.type === "consent" && p.state === "pending");
      if (card?.type === "consent") state.decideConsent(card.consentId, true);
    }, 15);
    try {
      const res = await call("approve_content", { contentId: "cnt_1" });
      expect(JSON.parse(res.content[0]?.text ?? "{}")).toMatchObject({ allowed: true, ok: true });
    } finally {
      clearInterval(allow);
    }
    expect(state.parts.find((p) => p.type === "consent")).toMatchObject({
      tool: "approve_content",
      state: "allowed",
    });
    expect(state.contentApprovals).toEqual([{ id: "cnt_1", hash: "a".repeat(64) }]);
  });

  it("denies when the owner says no, and expires an unanswered card", async () => {
    const denied = await setup();
    const deny = setInterval(() => {
      const card = denied.state.parts.find((p) => p.type === "consent" && p.state === "pending");
      if (card?.type === "consent") denied.state.decideConsent(card.consentId, false);
    }, 15);
    try {
      const res = await denied.call("approve_content", { contentId: "cnt_1" });
      expect(JSON.parse(res.content[0]?.text ?? "{}")).toMatchObject({
        allowed: false,
        reason: "denied_by_owner",
      });
    } finally {
      clearInterval(deny);
    }
    expect(denied.state.contentApprovals).toEqual([]);

    const expired = await setup({ consentTimeoutMs: 80 });
    const res = await expired.call("approve_content", { contentId: "cnt_1" });
    expect(JSON.parse(res.content[0]?.text ?? "{}")).toMatchObject({
      allowed: false,
      reason: "expired",
    });
    expect(expired.state.parts.find((p) => p.type === "consent")).toMatchObject({
      state: "expired",
    });
    expect(expired.state.contentApprovals).toEqual([]);
  });

  it("returns pictures as image content blocks (view_alias)", async () => {
    const { state, call } = await setup();
    const png = new Uint8Array(
      await sharp({ create: { width: 30, height: 20, channels: 3, background: "#3366aa" } })
        .png()
        .toBuffer(),
    );
    state.assets.set("asset_photo", { bytes: png, contentType: "image/png" });
    state.aliases.set("conv_1", [
      {
        id: "alias_1",
        conversationId: "conv_1",
        alias: "urun",
        previousAliases: ["image"],
        assetId: "asset_photo",
        kind: "image",
        mimeType: "image/png",
        width: 30,
        height: 20,
        filename: "urun.png",
        contentPath: "/api/assets/asset_photo/content",
        messageId: "msg_1",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const res = await call("view_alias", { alias: "@image" });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]?.text ?? "{}")).toMatchObject({ alias: "urun" });
    expect(res.content[1]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
    expect(Buffer.from(res.content[1]?.data ?? "", "base64").subarray(0, 2)).toEqual(
      Buffer.from([0xff, 0xd8]),
    );
    const listed = await call("list_aliases", { withThumbnails: true });
    expect(listed.content.filter((c) => c.type === "image")).toHaveLength(1);
    expect(state.parts.filter((p) => p.type === "tool_step").map((p) => p.label)).toEqual([
      "@urun görseline bakıldı",
      "Görseller listelendi",
    ]);
  });

  it("a stopped run ends a held consent call (the card stays for the API to expire)", async () => {
    const { state, call, controller } = await setup();
    const pending = call("approve_content", { contentId: "cnt_1" });
    await new Promise((r) => setTimeout(r, 80));
    controller.abort(new Error("run cancelled"));
    const res = await pending;
    expect(res.isError).toBe(true);
    expect(state.contentApprovals).toEqual([]);
  });
});
