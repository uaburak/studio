import { describe, expect, it } from "vitest";
import {
  DemoEchoPayload,
  decodeJobStreamMessage,
  decodeMessage,
  encodeJobStreamMessage,
  encodeMessage,
  isTerminalJobStatus,
  type Job,
  JobCreate,
  type JobStreamMessage,
  JobStreamQuery,
  PROTOCOL_VERSION,
  type ProtocolMessage,
  type WorkerPresence,
} from "../src/index.ts";

const now = "2026-11-16T10:00:00.000Z";

const job: Job = {
  id: "job_1",
  type: "demo.echo",
  status: "queued",
  payload: { text: "merhaba" },
  createdAt: now,
  updatedAt: now,
};

const samples: ProtocolMessage[] = [
  {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    workerId: "mac-1",
    capabilities: ["demo.echo"],
    workerVersion: "0.0.0",
  },
  { type: "job.dispatch", job },
  { type: "job.progress", jobId: "job_1", progress: 0.5, message: "yarısı bitti" },
  { type: "job.result", jobId: "job_1", status: "succeeded", output: { text: "x" } },
  { type: "job.result", jobId: "job_1", status: "failed", error: "boom" },
  { type: "ping", ts: 1 },
  { type: "pong", ts: 1 },
  // F1-6 additions
  {
    type: "hello",
    protocolVersion: PROTOCOL_VERSION,
    workerId: "mac-1",
    capabilities: ["demo.echo"],
    concurrency: 2,
    activeJobIds: ["job_1"],
  },
  { type: "job.dispatch", job: { ...job, attempts: 1, maxAttempts: 3, priority: 0 }, attempt: 1 },
  { type: "job.ack", jobId: "job_1", attempt: 1 },
  { type: "job.progress", jobId: "job_1", progress: 1, attempt: 2 },
  { type: "job.heartbeat", jobIds: ["job_1", "job_2"] },
  { type: "job.result", jobId: "job_1", status: "cancelled", attempt: 1 },
  { type: "job.result", jobId: "job_1", status: "failed", error: "429", retryable: true },
  { type: "job.release", jobId: "job_1", attempt: 1, reason: "shutdown" },
  { type: "worker.drain" },
  { type: "job.cancel", jobId: "job_1", reason: "cancelled by user" },
  { type: "job.result.ack", jobId: "job_1" },
];

describe("protocol round trip", () => {
  for (const message of samples) {
    it(`encodes and decodes ${message.type}`, () => {
      const raw = encodeMessage(message);
      expect(typeof raw).toBe("string");
      const decoded = decodeMessage(raw);
      expect(decoded).toEqual({ ok: true, message });
    });
  }
});

describe("protocol rejects malformed frames", () => {
  const bad: Array<[string, unknown]> = [
    ["non-string frame", new Uint8Array([1, 2, 3])],
    ["invalid JSON", "{not json"],
    ["JSON that is not an object", "42"],
    ["missing type", JSON.stringify({ ts: 1 })],
    ["unknown type", JSON.stringify({ type: "job.explode", jobId: "x" })],
    ["ping without ts", JSON.stringify({ type: "ping" })],
    ["progress out of range", JSON.stringify({ type: "job.progress", jobId: "a", progress: 2 })],
    ["result with bad status", JSON.stringify({ type: "job.result", jobId: "a", status: "ok" })],
    [
      "dispatch with invalid job",
      JSON.stringify({ type: "job.dispatch", job: { ...job, status: "weird" } }),
    ],
    [
      "hello with empty workerId",
      JSON.stringify({ type: "hello", protocolVersion: 1, workerId: "", capabilities: [] }),
    ],
    [
      "hello with zero concurrency",
      JSON.stringify({
        type: "hello",
        protocolVersion: 1,
        workerId: "w",
        capabilities: [],
        concurrency: 0,
      }),
    ],
    ["ack without jobId", JSON.stringify({ type: "job.ack" })],
    ["dispatch with attempt 0", JSON.stringify({ type: "job.dispatch", job, attempt: 0 })],
    [
      "heartbeat with too many ids",
      JSON.stringify({
        type: "job.heartbeat",
        jobIds: Array.from({ length: 101 }, (_, i) => `j${i}`),
      }),
    ],
    ["cancel without jobId", JSON.stringify({ type: "job.cancel" })],
  ];

  for (const [name, raw] of bad) {
    it(`rejects ${name}`, () => {
      const decoded = decodeMessage(raw);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.error.length).toBeGreaterThan(0);
    });
  }

  it("encodeMessage throws on invalid input", () => {
    expect(() =>
      encodeMessage({ type: "job.progress", jobId: "a", progress: -1 } as ProtocolMessage),
    ).toThrow();
  });
});

describe("compatibility", () => {
  it("still accepts the original (pre-F1-6) frames and job shape", () => {
    const old = JSON.stringify({ type: "job.dispatch", job });
    expect(decodeMessage(old).ok).toBe(true);
    const oldHello = JSON.stringify({
      type: "hello",
      protocolVersion: 1,
      workerId: "w",
      capabilities: ["demo.echo"],
    });
    expect(decodeMessage(oldHello).ok).toBe(true);
    expect(DemoEchoPayload.parse({ text: "x" })).toEqual({ text: "x" });
    expect(JobCreate.parse({ type: "demo.echo" })).toEqual({ type: "demo.echo", payload: {} });
  });

  it("validates the new job create options", () => {
    expect(JobCreate.safeParse({ type: "demo.echo", priority: 101 }).success).toBe(false);
    expect(JobCreate.safeParse({ type: "demo.echo", maxAttempts: 0 }).success).toBe(false);
    expect(JobCreate.parse({ type: "demo.echo", priority: -5, maxAttempts: 2 })).toMatchObject({
      priority: -5,
      maxAttempts: 2,
    });
    expect(isTerminalJobStatus("cancelled")).toBe(true);
    expect(isTerminalJobStatus("running")).toBe(false);
  });
});

describe("job stream frames", () => {
  const presence: WorkerPresence = {
    online: true,
    lastSeenAt: now,
    workers: [
      {
        workerId: "mac-1",
        capabilities: ["demo.echo"],
        concurrency: 1,
        connectedAt: now,
        lastSeenAt: now,
        draining: false,
      },
    ],
    currentJobs: [{ id: "job_1", type: "demo.echo", progress: 0.5 }],
    queueLength: 2,
  };
  const frames: JobStreamMessage[] = [
    { type: "jobs.snapshot", jobs: [job], presence },
    { type: "job.updated", job: { ...job, status: "running", cancelRequestedAt: now } },
    { type: "presence", presence: { ...presence, online: false, lastSeenAt: null, workers: [] } },
    { type: "pong", ts: 3 },
  ];
  for (const frame of frames) {
    it(`round-trips ${frame.type}`, () => {
      expect(decodeJobStreamMessage(encodeJobStreamMessage(frame))).toEqual({
        ok: true,
        message: frame,
      });
    });
  }

  it("rejects worker frames and junk on the client stream", () => {
    expect(decodeJobStreamMessage(JSON.stringify({ type: "job.dispatch", job })).ok).toBe(false);
    expect(decodeJobStreamMessage("nope").ok).toBe(false);
  });

  it("accepts one filter at most", () => {
    expect(JobStreamQuery.safeParse({ jobId: "a" }).success).toBe(true);
    expect(JobStreamQuery.safeParse({}).success).toBe(true);
    expect(JobStreamQuery.safeParse({ jobId: "a", brandId: "b" }).success).toBe(false);
  });
});
