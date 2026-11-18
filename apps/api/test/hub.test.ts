import {
  abortAllDurableObjects,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  decodeJobStreamMessage,
  decodeMessage,
  encodeMessage,
  Job,
  type JobDispatchMessage,
  type JobStreamMessage,
  type ProtocolMessage,
  WorkerPresence,
  type WorkerToHubMessage,
} from "@studio/contract";
import { beforeEach, describe, expect, it } from "vitest";
import { api, BASE, createBrand, createContent, expectError, localFetch } from "./helpers.ts";

const hub = () => env.HUB.getByName("main");

/** A WebSocket opened through the Worker, with an inbox of decoded frames. */
async function openSocket<M>(path: string, decode: (raw: unknown) => M, headers = {}) {
  const res = await localFetch(`${BASE}${path}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
  if (res.status !== 101) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on response");
  ws.accept();
  const inbox: M[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    inbox.push(decode(event.data));
    for (const wake of waiters.splice(0)) wake();
  });
  async function next(timeoutMs = 2000): Promise<M> {
    const deadline = Date.now() + timeoutMs;
    while (inbox.length === 0) {
      if (Date.now() > deadline) throw new Error("timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
    return inbox.shift() as M;
  }
  return { ws, inbox, next };
}

let pingSeq = 1000;

/** A fake Mac worker speaking the hub protocol. */
async function connectWorker(
  opts: {
    workerId?: string;
    capabilities?: string[];
    concurrency?: number;
    activeJobIds?: string[];
  } = {},
) {
  const socket = await openSocket(
    "/api/hub",
    (raw) => {
      const decoded = decodeMessage(raw);
      if (!decoded.ok) throw new Error(decoded.error);
      return decoded.message;
    },
    { Authorization: `Bearer ${env.WORKER_TOKEN}` },
  );
  const send = (message: WorkerToHubMessage) => socket.ws.send(encodeMessage(message));
  /** Everything the hub sent before it answered a fresh ping (i.e. after processing all prior frames). */
  async function sync(): Promise<ProtocolMessage[]> {
    const ts = ++pingSeq;
    send({ type: "ping", ts });
    const got: ProtocolMessage[] = [];
    for (;;) {
      const m = await socket.next();
      if (m.type === "pong" && m.ts === ts) return got;
      got.push(m);
    }
  }
  send({
    type: "hello",
    protocolVersion: 1,
    workerId: opts.workerId ?? "mac-test",
    capabilities: opts.capabilities ?? ["demo.echo"],
    ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    ...(opts.activeJobIds ? { activeJobIds: opts.activeJobIds } : {}),
  });
  const initial = await sync();
  return { ...socket, send, sync, initial };
}

const dispatches = (messages: ProtocolMessage[]) =>
  messages.filter((m): m is JobDispatchMessage => m.type === "job.dispatch");

async function createJob(body: Record<string, unknown> = {}): Promise<Job> {
  const res = await api("POST", "/api/jobs", {
    type: "demo.echo",
    payload: { text: "merhaba" },
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return Job.parse(res.body);
}

async function getJob(id: string): Promise<Job> {
  const res = await api("GET", `/api/jobs/${id}`);
  expect(res.status).toBe(200);
  return Job.parse(res.body);
}

async function expireLease(id: string) {
  await env.DB.prepare("update jobs set lease_expires_at = ? where id = ?")
    .bind(Date.now() - 1000, id)
    .run();
}

async function presence(): Promise<WorkerPresence> {
  const res = await api("GET", "/api/workers/presence");
  expect(res.status).toBe(200);
  return WorkerPresence.parse(res.body);
}

beforeEach(async () => {
  // Fresh hub instance (sockets dropped), no leftover open jobs, no alarm.
  await abortAllDurableObjects();
  await env.DB.prepare(
    "update jobs set status = 'cancelled', lease_expires_at = null where status in ('queued', 'running')",
  ).run();
  await runInDurableObject(hub(), async (_instance, state) => {
    await state.storage.deleteAlarm();
    await state.storage.deleteAll();
  });
});

describe("worker authentication", () => {
  it("rejects a missing or wrong token and accepts the right one", async () => {
    const noToken = await localFetch(`${BASE}/api/hub`, {
      headers: { Upgrade: "websocket" },
    });
    expect(noToken.status).toBe(401);
    const wrong = await localFetch(`${BASE}/api/hub`, {
      headers: { Upgrade: "websocket", Authorization: "Bearer nope" },
    });
    expect(wrong.status).toBe(401);
    const worker = await connectWorker();
    expect(worker.initial).toEqual([]);
    worker.ws.close(1000);
  });
});

describe("dispatch", () => {
  it("keeps a job queued while no worker is connected and dispatches it on connect", async () => {
    const job = await createJob({ payload: { text: "kuyruk" } });
    expect(job).toMatchObject({ status: "queued", attempts: 0, maxAttempts: 3, priority: 0 });
    expect(await presence()).toMatchObject({ online: false, queueLength: 1 });

    const worker = await connectWorker();
    const [dispatch] = dispatches(worker.initial);
    expect(dispatch?.job.id).toBe(job.id);
    expect(dispatch?.attempt).toBe(1);
    expect(await getJob(job.id)).toMatchObject({
      status: "running",
      workerId: "mac-test",
      attempts: 1,
    });

    worker.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    worker.send({
      type: "job.progress",
      jobId: job.id,
      progress: 0.4,
      message: "yarısı",
      attempt: 1,
    });
    await worker.sync();
    const running = await getJob(job.id);
    expect(running).toMatchObject({ progress: 0.4, progressMessage: "yarısı" });
    expect(running.startedAt).toBeDefined();
    const live = await presence();
    expect(live).toMatchObject({ online: true, queueLength: 0 });
    expect(live.currentJobs.map((j) => j.id)).toEqual([job.id]);
    expect(live.workers[0]).toMatchObject({ workerId: "mac-test", concurrency: 1 });

    worker.send({
      type: "job.result",
      jobId: job.id,
      status: "succeeded",
      output: { text: "kuyruk" },
      attempt: 1,
    });
    expect(await worker.sync()).toEqual([{ type: "job.result.ack", jobId: job.id }]);
    const done = await getJob(job.id);
    expect(done).toMatchObject({ status: "succeeded", output: { text: "kuyruk" }, progress: 1 });
    expect(done.finishedAt).toBeDefined();
    worker.ws.close(1000);
  });

  it("dispatches a job created while the worker is connected", async () => {
    const worker = await connectWorker();
    const job = await createJob();
    expect(dispatches(await worker.sync()).map((d) => d.job.id)).toEqual([job.id]);
    worker.ws.close(1000);
  });

  it("respects concurrency, priority, then FIFO", async () => {
    const a = await createJob();
    const b = await createJob();
    const urgent = await createJob({ priority: 5 });

    const worker = await connectWorker({ concurrency: 1 });
    expect(dispatches(worker.initial).map((d) => d.job.id)).toEqual([urgent.id]);

    for (const [finished, expected] of [
      [urgent, a],
      [a, b],
    ] as const) {
      worker.send({ type: "job.result", jobId: finished.id, status: "succeeded", output: {} });
      const got = await worker.sync();
      expect(dispatches(got).map((d) => d.job.id)).toEqual([expected.id]);
    }
    worker.ws.close(1000);
  });

  it("fills up to the announced concurrency", async () => {
    await createJob();
    await createJob();
    await createJob();
    const worker = await connectWorker({ concurrency: 2 });
    expect(dispatches(worker.initial)).toHaveLength(2);
    expect((await presence()).queueLength).toBe(1);
    worker.ws.close(1000);
  });

  it("leaves job types the worker cannot run in the queue", async () => {
    const brand = await createBrand();
    const job = await createJob({ type: "brand.analyze", brandId: brand.id, payload: {} });
    const worker = await connectWorker({ capabilities: ["demo.echo"] });
    expect(dispatches(worker.initial)).toEqual([]);
    expect((await getJob(job.id)).status).toBe("queued");
    worker.ws.close(1000);
  });

  it("gives canvas jobs to the Mac app's canvas runner, which is not the Mac worker", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    const canvas = await createJob({
      type: "canvas.apply",
      contentId: content.id,
      payload: {
        version: 1,
        operations: [
          { tool: "update_nodes", args: { updates: [{ nodeId: "1:2", characters: "A" }] } },
        ],
      },
    });
    // An operation outside Wecra's write tools is refused when the job is created.
    expectError(
      await api("POST", "/api/jobs", {
        type: "canvas.apply",
        contentId: content.id,
        payload: { version: 1, operations: [{ tool: "run_command", args: {} }] },
      }),
      400,
      "validation_error",
    );
    const echo = await createJob();
    const runner = await connectWorker({
      workerId: "studio-canvas",
      capabilities: ["canvas.read", "canvas.apply"],
    });
    expect(dispatches(runner.initial).map((d) => d.job.id)).toEqual([canvas.id]);
    // The runner alone: the Mac is not online (no chat, no generation), its time is not "last seen".
    const alone = await presence();
    expect(alone.online).toBe(false);
    expect(alone.lastSeenAt).toBeNull();
    expect(alone.workers.map((w) => w.workerId)).toEqual(["studio-canvas"]);
    expect((await getJob(echo.id)).status).toBe("queued");
    // Claude commands go to the Mac worker only.
    expectError(await api("POST", "/api/workers/claude/status"), 409, "conflict");

    const worker = await connectWorker();
    expect(dispatches(worker.initial).map((d) => d.job.id)).toEqual([echo.id]);
    const both = await presence();
    expect(both.online).toBe(true);
    expect(both.workers.map((w) => w.workerId)).toEqual(["mac-test", "studio-canvas"]);
    expect((await runner.sync()).filter((m) => m.type === "worker.command")).toEqual([]);
    runner.ws.close(1000);
    worker.ws.close(1000);
  });
});

describe("leases", () => {
  it("requeues a job whose lease expired and dispatches it again as attempt 2", async () => {
    const job = await createJob();
    const worker = await connectWorker();
    worker.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    await worker.sync();

    await expireLease(job.id);
    expect(await runDurableObjectAlarm(hub())).toBe(true);
    const [again] = dispatches(await worker.sync());
    expect(again).toMatchObject({ attempt: 2, job: { id: job.id } });
    expect(await getJob(job.id)).toMatchObject({ status: "running", attempts: 2 });
    worker.ws.close(1000);
  });

  it("does not count a dispatch the worker never acknowledged", async () => {
    const job = await createJob();
    const worker = await connectWorker();
    await expireLease(job.id);
    await runDurableObjectAlarm(hub());
    const [again] = dispatches(await worker.sync());
    expect(again?.attempt).toBe(1);
    expect((await getJob(job.id)).attempts).toBe(1);
    worker.ws.close(1000);
  });

  it("fails the job with a clear error after max attempts", async () => {
    const job = await createJob({ maxAttempts: 2 });
    const worker = await connectWorker();
    for (const attempt of [1, 2]) {
      worker.send({ type: "job.ack", jobId: job.id, attempt });
      await worker.sync();
      await expireLease(job.id);
      await runDurableObjectAlarm(hub());
      await worker.sync();
    }
    const failed = await getJob(job.id);
    expect(failed).toMatchObject({ status: "failed", attempts: 2 });
    expect(failed.error).toMatch(/lost the job.*gave up after 2 attempt/);
    worker.ws.close(1000);
  });

  it("heartbeats keep the lease alive and unknown jobs get a cancel", async () => {
    const job = await createJob();
    const worker = await connectWorker();
    worker.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    await expireLease(job.id);
    worker.send({ type: "job.heartbeat", jobIds: [job.id, "no-such-job"] });
    expect(await worker.sync()).toEqual([
      {
        type: "job.cancel",
        jobId: "no-such-job",
        reason: "job is no longer assigned to this worker",
      },
    ]);
    await runDurableObjectAlarm(hub());
    expect(dispatches(await worker.sync())).toEqual([]);
    expect(await getJob(job.id)).toMatchObject({ status: "running", attempts: 1 });
    worker.ws.close(1000);
  });

  it("requeues retryable failures while attempts remain", async () => {
    const job = await createJob();
    const worker = await connectWorker();
    worker.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    worker.send({
      type: "job.result",
      jobId: job.id,
      status: "failed",
      error: "rate limited",
      retryable: true,
    });
    const got = await worker.sync();
    expect(got[0]).toEqual({ type: "job.result.ack", jobId: job.id });
    expect(dispatches(got)[0]?.attempt).toBe(2);
    worker.ws.close(1000);
  });
});

describe("idempotency", () => {
  it("accepts a result once and acknowledges duplicates", async () => {
    const job = await createJob();
    const worker = await connectWorker();
    worker.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    worker.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    worker.send({ type: "job.progress", jobId: job.id, progress: 0.5 });
    worker.send({ type: "job.progress", jobId: job.id, progress: 0.5 });
    worker.send({ type: "job.result", jobId: job.id, status: "succeeded", output: { n: 1 } });
    await worker.sync();
    const first = await getJob(job.id);

    worker.send({ type: "job.result", jobId: job.id, status: "failed", error: "late duplicate" });
    worker.send({ type: "job.progress", jobId: job.id, progress: 0.1 });
    expect(await worker.sync()).toEqual([
      { type: "job.result.ack", jobId: job.id },
      { type: "job.cancel", jobId: job.id, reason: "job is no longer assigned to this worker" },
    ]);
    expect(await getJob(job.id)).toEqual(first);
    expect(first).toMatchObject({ status: "succeeded", output: { n: 1 }, attempts: 1 });
    worker.ws.close(1000);
  });

  it("acknowledges results for unknown jobs so the worker can forget them", async () => {
    const worker = await connectWorker();
    worker.send({ type: "job.result", jobId: "ghost", status: "succeeded", output: {} });
    expect(await worker.sync()).toEqual([{ type: "job.result.ack", jobId: "ghost" }]);
    worker.ws.close(1000);
  });
});

describe("cancellation", () => {
  it("cancels a queued job immediately", async () => {
    const job = await createJob();
    const res = await api("POST", `/api/jobs/${job.id}/cancel`);
    expect(res.status).toBe(200);
    expect(Job.parse(res.body).status).toBe("cancelled");
    const worker = await connectWorker();
    expect(dispatches(worker.initial)).toEqual([]);
    worker.ws.close(1000);
  });

  it("asks the worker to abort a running job and records its confirmation", async () => {
    const job = await createJob();
    const worker = await connectWorker();
    worker.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    await worker.sync();

    const res = await api("POST", `/api/jobs/${job.id}/cancel`);
    expect(res.status).toBe(200);
    const pending = Job.parse(res.body);
    expect(pending.status).toBe("running");
    expect(pending.cancelRequestedAt).toBeDefined();
    expect(await worker.sync()).toEqual([
      { type: "job.cancel", jobId: job.id, reason: "cancelled by user" },
    ]);

    worker.send({ type: "job.result", jobId: job.id, status: "cancelled", error: "aborted" });
    await worker.sync();
    expect((await getJob(job.id)).status).toBe("cancelled");
    expectError(await api("POST", `/api/jobs/${job.id}/cancel`), 409, "invalid_transition");
    expectError(await api("POST", "/api/jobs/missing/cancel"), 404, "not_found");
    worker.ws.close(1000);
  });

  it("marks the job cancelled when the worker never confirms", async () => {
    const job = await createJob();
    const worker = await connectWorker();
    worker.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    await worker.sync();
    worker.ws.close(1000);

    await api("POST", `/api/jobs/${job.id}/cancel`);
    await expireLease(job.id);
    await runDurableObjectAlarm(hub());
    expect((await getJob(job.id)).status).toBe("cancelled");
  });
});

describe("reconnect and restart", () => {
  it("accepts a result produced while disconnected, exactly once, without re-dispatch", async () => {
    const job = await createJob();
    const first = await connectWorker();
    first.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    await first.sync();
    first.ws.close(1001, "gone");

    const second = await connectWorker({ activeJobIds: [job.id] });
    expect(dispatches(second.initial)).toEqual([]);
    second.send({ type: "job.result", jobId: job.id, status: "succeeded", output: { ok: 1 } });
    second.send({ type: "job.result", jobId: job.id, status: "succeeded", output: { ok: 2 } });
    expect(await second.sync()).toEqual([
      { type: "job.result.ack", jobId: job.id },
      { type: "job.result.ack", jobId: job.id },
    ]);
    expect(await getJob(job.id)).toMatchObject({ status: "succeeded", output: { ok: 1 } });
    second.ws.close(1000);
  });

  it("takes a job back that was requeued while the worker was away", async () => {
    const job = await createJob();
    const first = await connectWorker();
    first.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    await first.sync();
    first.ws.close(1001, "gone");

    await expireLease(job.id);
    await runDurableObjectAlarm(hub());
    expect(await getJob(job.id)).toMatchObject({ status: "queued", attempts: 1 });

    const second = await connectWorker({ activeJobIds: [job.id] });
    expect(dispatches(second.initial)).toEqual([]);
    expect(await getJob(job.id)).toMatchObject({ status: "running", attempts: 1 });
    second.send({ type: "job.result", jobId: job.id, status: "succeeded", output: {} });
    await second.sync();
    expect((await getJob(job.id)).status).toBe("succeeded");
    second.ws.close(1000);
  });

  it("requeues jobs a restarted worker no longer has", async () => {
    const job = await createJob();
    const first = await connectWorker();
    first.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    await first.sync();
    first.ws.close(1001, "gone");

    const restarted = await connectWorker({ activeJobIds: [] });
    const [again] = dispatches(restarted.initial);
    expect(again).toMatchObject({ attempt: 2, job: { id: job.id } });
    restarted.ws.close(1000);
  });

  it("recovers after the hub restarts: no job lost, none dispatched twice", async () => {
    const running = await createJob();
    const worker = await connectWorker();
    worker.send({ type: "job.ack", jobId: running.id, attempt: 1 });
    await worker.sync();
    const waiting = await createJob(); // queued behind the running one (concurrency 1)

    await abortAllDurableObjects(); // hub restart: in-memory state and sockets are gone
    const back = await connectWorker({ activeJobIds: [running.id] });
    expect(dispatches(back.initial)).toEqual([]);
    back.send({ type: "job.result", jobId: running.id, status: "succeeded", output: {} });
    const got = await back.sync();
    expect(dispatches(got).map((d) => d.job.id)).toEqual([waiting.id]);
    expect(await getJob(running.id)).toMatchObject({ status: "succeeded", attempts: 1 });
    back.ws.close(1000);
  });

  it("keeps serving a hibernated worker socket after eviction", async () => {
    const job = await createJob();
    const worker = await connectWorker();
    worker.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    await worker.sync();

    await evictDurableObject(hub()); // sockets hibernate, attachments survive
    worker.send({ type: "job.result", jobId: job.id, status: "succeeded", output: { after: 1 } });
    expect(await worker.sync()).toEqual([{ type: "job.result.ack", jobId: job.id }]);
    expect(await getJob(job.id)).toMatchObject({ status: "succeeded", output: { after: 1 } });
    worker.ws.close(1000);
  });

  it("hands back released jobs without consuming an attempt and stops dispatching to a draining worker", async () => {
    const job = await createJob();
    const leaving = await connectWorker();
    leaving.send({ type: "job.ack", jobId: job.id, attempt: 1 });
    leaving.send({ type: "worker.drain" });
    leaving.send({ type: "job.release", jobId: job.id, attempt: 1, reason: "shutdown" });
    expect(dispatches(await leaving.sync())).toEqual([]);
    expect(await getJob(job.id)).toMatchObject({ status: "queued", attempts: 0 });
    expect((await presence()).online).toBe(false);
    leaving.ws.close(1000);

    const next = await connectWorker({ workerId: "mac-test", activeJobIds: [] });
    expect(dispatches(next.initial)[0]?.attempt).toBe(1);
    next.ws.close(1000);
  });
});

describe("client stream", () => {
  const stream = (query = "") =>
    openSocket<JobStreamMessage>(`/api/jobs/stream${query}`, (raw) => {
      const decoded = decodeJobStreamMessage(raw);
      if (!decoded.ok) throw new Error(decoded.error);
      return decoded.message;
    });

  it("sends a snapshot, then every change of the watched job", async () => {
    const job = await createJob();
    const client = await stream(`?jobId=${job.id}`);
    const snapshot = await client.next();
    expect(snapshot.type).toBe("jobs.snapshot");
    if (snapshot.type === "jobs.snapshot") {
      expect(snapshot.jobs.map((j) => j.id)).toEqual([job.id]);
      expect(snapshot.presence.online).toBe(false);
    }

    const worker = await connectWorker();
    worker.send({ type: "job.progress", jobId: job.id, progress: 0.3, message: "çalışıyor" });
    worker.send({ type: "job.result", jobId: job.id, status: "succeeded", output: { x: 1 } });
    await worker.sync();

    const updates: Job[] = [];
    while (updates.at(-1)?.status !== "succeeded") {
      const m = await client.next();
      if (m.type === "job.updated") updates.push(m.job);
    }
    expect(updates.map((j) => j.status)).toEqual(["running", "running", "succeeded"]);
    expect(updates[1]).toMatchObject({ progress: 0.3, progressMessage: "çalışıyor" });

    client.ws.send(JSON.stringify({ type: "ping", ts: 5 }));
    let pong: JobStreamMessage | undefined;
    while (pong?.type !== "pong") pong = await client.next();
    expect(pong).toEqual({ type: "pong", ts: 5 });
    client.ws.close(1000);
    worker.ws.close(1000);
  });

  it("filters by brand and pushes presence changes", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const client = await stream(`?brandId=${brand.id}`);
    expect((await client.next()).type).toBe("jobs.snapshot");

    const worker = await connectWorker({ capabilities: [] });
    let seen: JobStreamMessage;
    do seen = await client.next();
    while (seen.type !== "presence");
    expect(seen.type === "presence" && seen.presence.online).toBe(true);

    await createJob({ type: "brand.analyze", brandId: other.id, payload: {} });
    const mine = await createJob({ type: "brand.analyze", brandId: brand.id, payload: {} });
    const jobUpdates: string[] = [];
    while (jobUpdates.length === 0) {
      const m = await client.next();
      if (m.type === "job.updated") jobUpdates.push(m.job.id);
    }
    expect(jobUpdates).toEqual([mine.id]);
    client.ws.close(1000);
    worker.ws.close(1000);
  });

  it("validates the stream filter", async () => {
    const notUpgrade = await localFetch(`${BASE}/api/jobs/stream`);
    expect(notUpgrade.status).toBe(426);
    const missing = await localFetch(`${BASE}/api/jobs/stream?jobId=nope`, {
      headers: { Upgrade: "websocket" },
    });
    expect(missing.status).toBe(404);
    const both = await localFetch(`${BASE}/api/jobs/stream?jobId=a&brandId=b`, {
      headers: { Upgrade: "websocket" },
    });
    expect(both.status).toBe(400);
  });
});

describe("worker usage", () => {
  const report = {
    windows: [
      {
        kind: "five_hour" as const,
        usedPercent: 42,
        resetsAt: "2026-11-16T18:00:00.000Z",
        limited: false,
      },
      { kind: "weekly" as const, usedPercent: 91.5, limited: false },
    ],
    source: "claude-cli",
    observedAt: "2026-11-16T14:00:00.000Z",
  };

  it("stores the latest report, serves it in presence and keeps it across hub restarts", async () => {
    expect((await presence()).usage).toBeUndefined();
    const client = await openSocket<JobStreamMessage>("/api/jobs/stream", (raw) => {
      const decoded = decodeJobStreamMessage(raw);
      if (!decoded.ok) throw new Error(decoded.error);
      return decoded.message;
    });
    expect((await client.next()).type).toBe("jobs.snapshot");

    const worker = await connectWorker();
    worker.send({ type: "worker.usage", ...report });
    await worker.sync();
    expect((await presence()).usage).toEqual(report);

    let seen: JobStreamMessage;
    do seen = await client.next();
    while (!(seen.type === "presence" && seen.presence.usage));
    expect(seen.type === "presence" && seen.presence.usage).toEqual(report);

    const newer = { ...report, windows: [{ kind: "other" as const, limited: true }] };
    worker.send({ type: "worker.usage", ...newer });
    await worker.sync();
    expect((await presence()).usage).toEqual(newer);
    client.ws.close(1000);
    worker.ws.close(1000);

    await abortAllDurableObjects(); // hub restart: DO storage survives
    expect((await presence()).usage).toEqual(newer);
  });

  it("ignores a malformed usage report", async () => {
    const worker = await connectWorker();
    worker.ws.send(
      JSON.stringify({ type: "worker.usage", windows: [{ kind: "daily" }], source: "x" }),
    );
    await worker.sync();
    expect((await presence()).usage).toBeUndefined();
    worker.ws.close(1000);
  });
});
