import { z } from "zod";
import { Job, JobId } from "./job.ts";

/**
 * Worker <-> hub WebSocket protocol.
 *
 * Every frame is a JSON text message with a `type` discriminator.
 * Direction:
 *   worker -> hub: hello, job.progress, job.result, ping, pong
 *   hub -> worker: job.dispatch, ping, pong
 *
 * Bump PROTOCOL_VERSION on breaking changes; the hub can reject
 * workers that announce an incompatible version in `hello`.
 */
export const PROTOCOL_VERSION = 1;

export const HelloMessage = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  workerId: z.string().min(1).max(128),
  /** Job types this worker can execute. */
  capabilities: z.array(z.string().min(1)),
  workerVersion: z.string().optional(),
});

export const JobDispatchMessage = z.object({
  type: z.literal("job.dispatch"),
  job: Job,
});

export const JobProgressMessage = z.object({
  type: z.literal("job.progress"),
  jobId: JobId,
  /** 0..1 */
  progress: z.number().min(0).max(1),
  message: z.string().max(2_000).optional(),
});

export const JobResultMessage = z.object({
  type: z.literal("job.result"),
  jobId: JobId,
  status: z.enum(["succeeded", "failed"]),
  output: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(10_000).optional(),
});

export const PingMessage = z.object({
  type: z.literal("ping"),
  /** Sender clock, ms since epoch; echoed back in pong. */
  ts: z.number(),
});

export const PongMessage = z.object({
  type: z.literal("pong"),
  ts: z.number(),
});

export const ProtocolMessage = z.discriminatedUnion("type", [
  HelloMessage,
  JobDispatchMessage,
  JobProgressMessage,
  JobResultMessage,
  PingMessage,
  PongMessage,
]);

export type HelloMessage = z.infer<typeof HelloMessage>;
export type JobDispatchMessage = z.infer<typeof JobDispatchMessage>;
export type JobProgressMessage = z.infer<typeof JobProgressMessage>;
export type JobResultMessage = z.infer<typeof JobResultMessage>;
export type PingMessage = z.infer<typeof PingMessage>;
export type PongMessage = z.infer<typeof PongMessage>;
export type ProtocolMessage = z.infer<typeof ProtocolMessage>;
export type ProtocolMessageType = ProtocolMessage["type"];

/** Messages the worker sends. */
export type WorkerToHubMessage = Extract<
  ProtocolMessage,
  { type: "hello" | "job.progress" | "job.result" | "ping" | "pong" }
>;
/** Messages the hub sends. */
export type HubToWorkerMessage = Extract<
  ProtocolMessage,
  { type: "job.dispatch" | "ping" | "pong" }
>;

export type DecodeResult = { ok: true; message: ProtocolMessage } | { ok: false; error: string };

/** Serialize a message. Throws if the message does not match the schema. */
export function encodeMessage(message: ProtocolMessage): string {
  return JSON.stringify(ProtocolMessage.parse(message));
}

/**
 * Parse and validate an incoming frame. Never throws: malformed JSON,
 * binary frames and schema violations all come back as `{ ok: false }`.
 */
export function decodeMessage(raw: unknown): DecodeResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "frame must be a text (JSON) message" };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "frame is not valid JSON" };
  }
  const parsed = ProtocolMessage.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }
  return { ok: true, message: parsed.data };
}
