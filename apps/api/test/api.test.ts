import { env, exports } from "cloudflare:workers";
import { decodeMessage, encodeMessage, HealthResponse, type Job } from "@studio/contract";
import { describe, expect, it } from "vitest";
import * as entry from "../src/index.ts";

const BASE = "http://studio.test";

describe("worker entry module", () => {
  // workerd refuses to start if the entry exports anything that is not a
  // handler or Durable Object class (the Vitest plugin does not catch this).
  it("exports only the fetch handler and Durable Object classes", () => {
    expect(Object.keys(entry).sort()).toEqual(["Hub", "default"]);
  });
});

describe("GET /api/health", () => {
  it("returns a contract-valid healthy response", async () => {
    const res = await exports.default.fetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe("ok");
  });
});

describe("GET /api/openapi.json", () => {
  it("documents the health route with the contract schema", async () => {
    const res = await exports.default.fetch(`${BASE}/api/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths).toHaveProperty("/api/health");
    expect(doc.components?.schemas).toHaveProperty("HealthResponse");
  });
});

describe("D1 + Drizzle", () => {
  it("has the initial migration applied", async () => {
    const row = await env.DB.prepare(
      "select name from sqlite_master where type = 'table' and name = 'app_meta'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("app_meta");
  });
});

/** Open a WebSocket to the hub through the Worker and collect decoded frames. */
async function connectHub() {
  const res = await exports.default.fetch(`${BASE}/api/hub`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on response");
  ws.accept();
  const inbox: unknown[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    const decoded = decodeMessage(event.data);
    inbox.push(decoded.ok ? decoded.message : decoded);
    for (const wake of waiters.splice(0)) wake();
  });
  async function next(): Promise<unknown> {
    while (inbox.length === 0) await new Promise<void>((r) => waiters.push(r));
    return inbox.shift();
  }
  return { ws, next };
}

describe("Hub Durable Object", () => {
  it("rejects non-upgrade requests", async () => {
    const res = await exports.default.fetch(`${BASE}/api/hub`);
    expect(res.status).toBe(426);
  });

  it("answers protocol ping with pong", async () => {
    const { ws, next } = await connectHub();
    ws.send(encodeMessage({ type: "ping", ts: 42 }));
    expect(await next()).toEqual({ type: "pong", ts: 42 });
    ws.close(1000, "done");
  });

  it("dispatches a demo job to a connected worker and records the result", async () => {
    const { ws, next } = await connectHub();
    ws.send(
      encodeMessage({
        type: "hello",
        protocolVersion: 1,
        workerId: "test-worker",
        capabilities: ["demo.echo"],
      }),
    );

    const created = await exports.default.fetch(`${BASE}/api/dev/jobs/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "merhaba" }),
    });
    expect(created.status).toBe(202);
    const job = (await created.json()) as Job;

    const dispatch = (await next()) as { type: string; job: Job };
    expect(dispatch.type).toBe("job.dispatch");
    expect(dispatch.job.id).toBe(job.id);

    ws.send(encodeMessage({ type: "job.progress", jobId: job.id, progress: 0.5 }));
    ws.send(
      encodeMessage({
        type: "job.result",
        jobId: job.id,
        status: "succeeded",
        output: { text: "merhaba" },
      }),
    );
    // Round-trip a ping so we know the hub processed the frames above.
    ws.send(encodeMessage({ type: "ping", ts: 1 }));
    expect(await next()).toEqual({ type: "pong", ts: 1 });

    const res = await exports.default.fetch(`${BASE}/api/dev/jobs/${job.id}`);
    const finished = (await res.json()) as Job;
    expect(finished.status).toBe("succeeded");
    expect(finished.output).toEqual({ text: "merhaba" });
    ws.close(1000, "done");
  });
});
