import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  decodeMessage,
  encodeMessage,
  Job,
  type ProtocolMessage,
  type ToolStatus,
  ToolsControl,
  WorkerPresence,
  type WorkerToHubMessage,
} from "@studio/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { api, BASE, expectError, localFetch } from "./helpers.ts";

/* The in-app tool manager's API: the worker's `worker.tools` report, install / uninstall jobs. */

const hub = () => env.HUB.getByName("main");
const AUTH = () => ({ Authorization: `Bearer ${env.WORKER_TOKEN}` });
let pingSeq = 7000;

async function connectWorker(workerId = "mac-tools") {
  const res = await localFetch(`${BASE}/api/hub`, { headers: { Upgrade: "websocket", ...AUTH() } });
  const ws = res.webSocket;
  if (!ws) throw new Error(`upgrade failed: ${res.status}`);
  ws.accept();
  const inbox: ProtocolMessage[] = [];
  ws.addEventListener("message", (event) => {
    const decoded = decodeMessage(event.data);
    if (decoded.ok) inbox.push(decoded.message);
  });
  const send = (m: WorkerToHubMessage) => ws.send(encodeMessage(m));
  async function sync(): Promise<ProtocolMessage[]> {
    const ts = ++pingSeq;
    send({ type: "ping", ts });
    const got: ProtocolMessage[] = [];
    const deadline = Date.now() + 3000;
    for (;;) {
      const m = inbox.shift();
      if (!m) {
        if (Date.now() > deadline) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      if (m.type === "pong" && m.ts === ts) return got;
      got.push(m);
    }
  }
  send({ type: "hello", protocolVersion: 1, workerId, capabilities: [], activeJobIds: [] });
  await sync();
  return { ws, send, sync };
}

function tool(over: Partial<ToolStatus> & Pick<ToolStatus, "id">): ToolStatus {
  return {
    label: over.id,
    purpose: "test",
    source: "test",
    sourceUrl: "https://example.com",
    sizeBytes: 1000,
    state: "missing",
    version: null,
    targetVersion: null,
    path: null,
    location: null,
    installable: true,
    removable: false,
    optional: false,
    note: null,
    error: null,
    progress: null,
    jobId: null,
    ...over,
  };
}

beforeEach(async () => {
  await abortAllDurableObjects();
  await env.DB.prepare(
    "update jobs set status = 'cancelled', lease_expires_at = null where status in ('queued', 'running')",
  ).run();
  await runInDurableObject(hub(), async (_instance, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
  });
});

describe("/api/tools", () => {
  it("is empty and offline until a worker reports; refresh needs a worker", async () => {
    const res = await api("GET", "/api/tools");
    expect(res.status).toBe(200);
    expect(ToolsControl.parse(res.body)).toEqual({
      tools: [],
      online: false,
      reportedAt: null,
      sent: 0,
    });
    expectError(await api("POST", "/api/tools/refresh"), 409, "conflict");
  });

  it("keeps the worker's report (GET and presence) and forwards a refresh", async () => {
    const w = await connectWorker();
    const tools = [
      tool({ id: "ffmpeg" }),
      tool({ id: "claude", state: "installed", location: "system", installable: false }),
    ];
    w.send({ type: "worker.tools", tools });
    await w.sync();
    const got = ToolsControl.parse((await api("GET", "/api/tools")).body);
    expect(got.tools).toEqual(tools);
    expect(got.online).toBe(true);
    expect(got.reportedAt).not.toBeNull();
    const presence = WorkerPresence.parse((await api("GET", "/api/workers/presence")).body);
    expect(presence.tools).toEqual(tools);

    const refresh = await api("POST", "/api/tools/refresh");
    expect(refresh.status).toBe(200);
    expect(ToolsControl.parse(refresh.body).sent).toBe(1);
    const frames = await w.sync();
    expect(frames).toContainEqual({ type: "worker.command", command: "tools.status" });
    w.ws.close(1000);
  });

  it("queues tool.install once, refuses system copies and non-installable tools", async () => {
    const w = await connectWorker();
    w.send({
      type: "worker.tools",
      tools: [
        tool({ id: "ffmpeg" }),
        tool({ id: "claude", state: "installed", location: "system", installable: false }),
        tool({ id: "whisper", installable: false, note: "kurulamaz" }),
        tool({ id: "cloudflared", state: "installed", location: "studio", removable: true }),
      ],
    });
    await w.sync();

    const first = await api("POST", "/api/tools/ffmpeg/install", {});
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const job = Job.parse(first.body);
    expect(job).toMatchObject({ type: "tool.install", payload: { toolId: "ffmpeg" } });
    // A second click returns the same job.
    const again = await api("POST", "/api/tools/ffmpeg/install", {});
    expect(Job.parse(again.body).id).toBe(job.id);

    expectError(await api("POST", "/api/tools/claude/install", {}), 409, "conflict");
    expectError(await api("POST", "/api/tools/whisper/install", {}), 409, "conflict");
    // Already Studio's: only with update.
    expectError(await api("POST", "/api/tools/cloudflared/install", {}), 409, "conflict");
    const update = await api("POST", "/api/tools/cloudflared/install", { update: true });
    expect(update.status).toBe(202);
    expect(Job.parse(update.body).payload).toEqual({ toolId: "cloudflared", update: true });

    // Unknown tool id: validation.
    expect((await api("POST", "/api/tools/brew/install", {})).status).toBe(400);
    w.ws.close(1000);
  });

  it("queues tool.uninstall only for Studio's own copy", async () => {
    const w = await connectWorker();
    w.send({
      type: "worker.tools",
      tools: [
        tool({ id: "claude", state: "installed", location: "system", installable: false }),
        tool({ id: "cloudflared", state: "installed", location: "studio", removable: true }),
      ],
    });
    await w.sync();
    expectError(await api("POST", "/api/tools/claude/uninstall"), 409, "conflict");
    const res = await api("POST", "/api/tools/cloudflared/uninstall");
    expect(res.status).toBe(202);
    expect(Job.parse(res.body)).toMatchObject({
      type: "tool.uninstall",
      payload: { toolId: "cloudflared" },
    });
    w.ws.close(1000);
  });
});
