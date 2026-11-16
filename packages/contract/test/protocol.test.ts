import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  encodeMessage,
  type Job,
  PROTOCOL_VERSION,
  type ProtocolMessage,
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
