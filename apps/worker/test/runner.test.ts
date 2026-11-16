import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Job, JobResultMessage, WorkerToHubMessage } from "@studio/contract";
import { DemoEchoPayload } from "@studio/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerConfig } from "../src/config.ts";
import { demoEcho } from "../src/jobs/demo-echo.ts";
import { silentLogger } from "../src/log.ts";
import { FileOutbox, MemoryOutbox } from "../src/outbox.ts";
import {
  defineHandler,
  InvalidPayloadError,
  JobRegistry,
  RetryableError,
  UnknownJobTypeError,
} from "../src/registry.ts";
import { JobRunner } from "../src/runner.ts";
import { startWorker } from "../src/worker.ts";
import { fakeSocketFactory } from "./fake-socket.ts";

const now = "2026-11-16T10:00:00.000Z";
const job = (
  payload: Record<string, unknown>,
  id = "job_1",
  type: Job["type"] = "demo.echo",
): Job => ({
  id,
  type,
  status: "running",
  payload,
  createdAt: now,
  updatedAt: now,
});

function setup(
  opts: { registry?: JobRegistry; concurrency?: number; heartbeatIntervalMs?: number } = {},
) {
  const sent: WorkerToHubMessage[] = [];
  let connected = true;
  const outbox = new MemoryOutbox();
  const runner = new JobRunner({
    workerId: "mac-test",
    registry: opts.registry ?? new JobRegistry().register("demo.echo", demoEcho),
    outbox,
    concurrency: opts.concurrency ?? 1,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 0,
    resendAfterMs: 1000,
    send: (m) => {
      if (!connected) return false;
      sent.push(m);
      return true;
    },
  });
  return {
    sent,
    outbox,
    runner,
    setConnected: (value: boolean) => {
      connected = value;
    },
  };
}

/** A handler that runs until cancelled (or released on shutdown). */
function waitingRegistry(onStart?: () => void) {
  return new JobRegistry().register(
    "demo.echo",
    defineHandler({
      payload: DemoEchoPayload,
      run: (_payload, ctx) =>
        new Promise<Record<string, unknown>>((_resolve, reject) => {
          onStart?.();
          ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason));
        }),
    }),
  );
}

afterEach(() => vi.useRealTimers());

describe("JobRegistry", () => {
  it("lists types and validates payloads before running", async () => {
    const registry = new JobRegistry().register("demo.echo", demoEcho);
    expect(registry.types()).toEqual(["demo.echo"]);
    const ctx = {
      jobId: "j",
      job: job({}, "j"),
      attempt: 1,
      workerId: "w",
      signal: new AbortController().signal,
      progress: () => {},
      log: () => {},
    };
    await expect(registry.run({ type: "brand.analyze", payload: {} }, ctx)).rejects.toBeInstanceOf(
      UnknownJobTypeError,
    );
    await expect(
      registry.run({ type: "demo.echo", payload: { nope: 1 } }, ctx),
    ).rejects.toBeInstanceOf(InvalidPayloadError);
    await expect(
      registry.run({ type: "demo.echo", payload: { text: "ab" } }, ctx),
    ).resolves.toEqual({
      text: "ab",
      reversed: "ba",
      workerId: "w",
    });
    expect(() => registry.register("demo.echo", demoEcho)).toThrow(/twice/);
  });
});

describe("JobRunner", () => {
  it("answers ping with pong", () => {
    const { sent, runner } = setup();
    runner.handle({ type: "ping", ts: 123 });
    expect(sent).toEqual([{ type: "pong", ts: 123 }]);
  });

  it("runs demo.echo: ack -> progress -> result, kept until the hub acknowledges", async () => {
    const { sent, runner, outbox } = setup();
    runner.handle({ type: "job.dispatch", job: job({ text: "abc" }), attempt: 2 });
    await runner.idle();
    expect(sent).toEqual([
      { type: "job.ack", jobId: "job_1", attempt: 2 },
      {
        type: "job.progress",
        jobId: "job_1",
        progress: 0.5,
        message: "metin işleniyor",
        attempt: 2,
      },
      {
        type: "job.result",
        jobId: "job_1",
        status: "succeeded",
        output: { text: "abc", reversed: "cba", workerId: "mac-test" },
        attempt: 2,
      },
    ]);
    expect(runner.helloFields().activeJobIds).toEqual(["job_1"]);
    runner.handle({ type: "job.result.ack", jobId: "job_1" });
    await vi.waitFor(() => expect(outbox.size).toBe(0));
    expect(runner.helloFields()).toEqual({ concurrency: 1, activeJobIds: [] });
  });

  it("fails cleanly on an invalid payload or an unknown job type", async () => {
    const { sent, runner } = setup();
    runner.handle({ type: "job.dispatch", job: job({ nope: true }) });
    runner.handle({ type: "job.result.ack", jobId: "job_1" });
    await runner.idle();
    runner.handle({ type: "job.dispatch", job: job({}, "job_2", "content.render") });
    await runner.idle();
    const results = sent.filter((m): m is JobResultMessage => m.type === "job.result");
    expect(results[0]).toMatchObject({ jobId: "job_1", status: "failed" });
    expect(results[0]?.error).toMatch(/invalid payload/);
    expect(results[1]).toEqual({
      type: "job.result",
      jobId: "job_2",
      status: "failed",
      error: "unsupported job type: content.render",
    });
  });

  it("marks RetryableError failures as retryable", async () => {
    const registry = new JobRegistry().register(
      "demo.echo",
      defineHandler({
        payload: DemoEchoPayload,
        run: async () => {
          throw new RetryableError("rate limited");
        },
      }),
    );
    const { sent, runner } = setup({ registry });
    runner.handle({ type: "job.dispatch", job: job({ text: "x" }) });
    await runner.idle();
    expect(sent.at(-1)).toEqual({
      type: "job.result",
      jobId: "job_1",
      status: "failed",
      error: "rate limited",
      retryable: true,
    });
  });

  it("aborts a running handler on job.cancel and reports cancelled", async () => {
    const { sent, runner } = setup();
    runner.handle({
      type: "job.dispatch",
      job: job({ text: "slow", delayMs: 60_000, steps: 2 }),
      attempt: 1,
    });
    runner.handle({ type: "job.cancel", jobId: "job_1", reason: "cancelled by user" });
    await runner.idle();
    expect(sent.at(-1)).toEqual({
      type: "job.result",
      jobId: "job_1",
      status: "cancelled",
      error: "cancelled",
      attempt: 1,
    });
  });

  it("confirms a cancel for a job it does not run", () => {
    const { sent, runner } = setup();
    runner.handle({ type: "job.cancel", jobId: "ghost" });
    expect(sent).toEqual([
      {
        type: "job.result",
        jobId: "ghost",
        status: "cancelled",
        error: "not running on this worker",
      },
    ]);
  });

  it("does not run a duplicate dispatch twice and resends a finished result instead", async () => {
    let starts = 0;
    const { sent, runner } = setup({ registry: waitingRegistry(() => starts++) });
    runner.handle({ type: "job.dispatch", job: job({ text: "x" }), attempt: 1 });
    runner.handle({ type: "job.dispatch", job: job({ text: "x" }), attempt: 1 });
    expect(starts).toBe(1);
    expect(sent).toEqual([
      { type: "job.ack", jobId: "job_1", attempt: 1 },
      { type: "job.ack", jobId: "job_1", attempt: 1 },
    ]);
    runner.handle({ type: "job.cancel", jobId: "job_1" });
    await runner.idle();
    sent.length = 0;
    runner.handle({ type: "job.dispatch", job: job({ text: "x" }), attempt: 2 });
    expect(starts).toBe(1);
    expect(sent).toEqual([
      { type: "job.result", jobId: "job_1", status: "cancelled", error: "cancelled", attempt: 1 },
    ]);
  });

  it("hands a dispatch back when at capacity", () => {
    const { sent, runner } = setup({ registry: waitingRegistry() });
    runner.handle({ type: "job.dispatch", job: job({ text: "a" }, "a"), attempt: 1 });
    runner.handle({ type: "job.dispatch", job: job({ text: "b" }, "b"), attempt: 1 });
    expect(sent.at(-1)).toEqual({ type: "job.release", jobId: "b", attempt: 1, reason: "busy" });
    runner.handle({ type: "job.cancel", jobId: "a" });
  });

  it("graceful shutdown drains, aborts and releases running jobs", async () => {
    const { sent, runner, outbox } = setup({ registry: waitingRegistry(), concurrency: 2 });
    runner.handle({ type: "job.dispatch", job: job({ text: "a" }, "a"), attempt: 1 });
    runner.handle({ type: "job.dispatch", job: job({ text: "b" }, "b"), attempt: 3 });
    await runner.shutdown(1000);
    expect(sent.slice(2)).toEqual([
      { type: "worker.drain" },
      { type: "job.release", jobId: "a", attempt: 1, reason: "shutdown" },
      { type: "job.release", jobId: "b", attempt: 3, reason: "shutdown" },
    ]);
    expect(outbox.size).toBe(0);
    expect(runner.activeJobIds).toEqual([]);
    // After draining, new dispatches are refused.
    runner.handle({ type: "job.dispatch", job: job({ text: "c" }, "c"), attempt: 1 });
    expect(sent.at(-1)).toEqual({
      type: "job.release",
      jobId: "c",
      attempt: 1,
      reason: "shutdown",
    });
  });

  it("heartbeats running jobs and resends unacknowledged results", async () => {
    vi.useFakeTimers();
    const registry = new JobRegistry().register(
      "demo.echo",
      defineHandler({
        payload: DemoEchoPayload,
        run: async (_p, ctx) => {
          ctx.log("working");
          await new Promise((r) => setTimeout(r, 25_000));
          return {};
        },
      }),
    );
    const { sent, runner } = setup({ registry, heartbeatIntervalMs: 10_000 });
    runner.start();
    runner.handle({ type: "job.dispatch", job: job({ text: "x" }), attempt: 1 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent.at(-1)).toEqual({ type: "job.heartbeat", jobIds: ["job_1"] });
    await vi.advanceTimersByTimeAsync(15_000); // handler done at 25 s, result sent
    expect(sent.at(-1)).toMatchObject({ type: "job.result", status: "succeeded" });
    const count = () => sent.filter((m) => m.type === "job.result").length;
    expect(count()).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000); // no ack yet -> resent on the next tick
    expect(count()).toBe(2);
    runner.handle({ type: "job.result.ack", jobId: "job_1" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(count()).toBe(2);
    runner.stop();
  });
});

describe("resend after reconnect", () => {
  const config: WorkerConfig = {
    hubUrl: "ws://hub.test/api/hub",
    token: "t",
    workerId: "mac-test",
    concurrency: 1,
    heartbeatIntervalMs: 0,
    shutdownTimeoutMs: 1000,
    stateDir: "/nonexistent",
    backoff: { baseMs: 10, maxMs: 10, jitter: 0 },
    pingIntervalMs: 0,
    logLevel: "error",
  };

  it("keeps a result produced while offline and delivers it after hello", async () => {
    let finish: (() => void) | undefined;
    const registry = new JobRegistry().register(
      "demo.echo",
      defineHandler({
        payload: DemoEchoPayload,
        run: () =>
          new Promise<Record<string, unknown>>((resolve) => {
            finish = () => resolve({ done: true });
          }),
      }),
    );
    const fake = fakeSocketFactory();
    const worker = startWorker({
      config,
      logger: silentLogger,
      socketFactory: fake.factory,
      registry,
      outbox: new MemoryOutbox(),
    });
    const first = fake.last();
    first?.simulateOpen();
    first?.simulateMessage({ type: "job.dispatch", job: job({ text: "x" }), attempt: 1 });
    first?.simulateClose();

    finish?.(); // completes while disconnected
    await worker.runner.idle();

    await vi.waitFor(() => expect(fake.sockets).toHaveLength(2));
    const second = fake.last();
    second?.simulateOpen();
    expect(second?.sent[0]).toMatchObject({ type: "hello", activeJobIds: ["job_1"] });
    expect(second?.sent[1]).toEqual({
      type: "job.result",
      jobId: "job_1",
      status: "succeeded",
      output: { done: true },
      attempt: 1,
    });
    second?.simulateMessage({ type: "job.result.ack", jobId: "job_1" });
    await vi.waitFor(() => expect(worker.runner.helloFields().activeJobIds).toEqual([]));
    worker.stop();
  });

  it("FileOutbox keeps results across restarts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "studio-outbox-"));
    try {
      const file = path.join(dir, "state", "outbox.json");
      const a = new FileOutbox(file);
      await a.put({ type: "job.result", jobId: "j1", status: "succeeded", output: { x: 1 } });
      await a.put({ type: "job.result", jobId: "j2", status: "failed", error: "boom" });
      await a.delete("j2");
      const b = new FileOutbox(file);
      expect(b.list()).toEqual([
        { type: "job.result", jobId: "j1", status: "succeeded", output: { x: 1 } },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
