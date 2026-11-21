import { z } from "zod";
import { ClaudeAccount, GeminiAccount, WorkerCommand } from "./agent.ts";
import { AiProviderStatus } from "./ai.ts";
import { ApprovalRequest } from "./approval.ts";
import { Job, JobId, WorkerPresence, WorkerUsage } from "./job.ts";
import { ToolStatus } from "./tools.ts";

/**
 * Worker <-> hub WebSocket protocol.
 *
 * Every frame is a JSON text message with a `type` discriminator.
 * Direction:
 *   worker -> hub: hello, job.ack, job.progress, job.heartbeat, job.result,
 *                  job.release, worker.drain, worker.usage, worker.claude, ping, pong
 *   hub -> worker: job.dispatch, job.cancel, job.result.ack, worker.command, ping, pong
 *
 * Job lifecycle on the wire (see apps/api/README.md for the full picture):
 *   hub  job.dispatch {job, attempt}  -> worker
 *   hub  <- job.ack {jobId, attempt}          (lease starts)
 *   hub  <- job.progress / job.heartbeat      (lease renewed)
 *   hub  <- job.result {status}               (worker keeps it in an outbox)
 *   hub  job.result.ack {jobId}       -> worker (outbox entry dropped)
 * Results are idempotent: the hub accepts the first one and acknowledges
 * every duplicate, so the worker can resend its outbox after a reconnect.
 *
 * Bump PROTOCOL_VERSION on breaking changes; the hub rejects workers that
 * announce an incompatible version in `hello`. Everything added in F1-6 is
 * optional or a new message type, so version 1 still holds.
 */
export const PROTOCOL_VERSION = 1;

/** Upper bound for list fields in frames, to keep messages small. */
export const MAX_ACTIVE_JOBS_IN_FRAME = 100;

export const HelloMessage = z.object({
  type: z.literal("hello"),
  protocolVersion: z.number().int().positive(),
  workerId: z.string().min(1).max(128),
  /** Job types this worker can execute. */
  capabilities: z.array(z.string().min(1)),
  workerVersion: z.string().optional(),
  /** Jobs the worker runs at the same time (default 1). */
  concurrency: z.number().int().min(1).max(16).optional(),
  /**
   * Jobs this worker still holds: running, or finished with a result not yet
   * acknowledged. The hub keeps these assigned (or reclaims them) and
   * requeues any other job it thought this worker had. Omit (old workers)
   * to skip that reconciliation and rely on leases alone.
   */
  activeJobIds: z.array(JobId).max(MAX_ACTIVE_JOBS_IN_FRAME).optional(),
});

export const JobDispatchMessage = z.object({
  type: z.literal("job.dispatch"),
  job: Job,
  /** Attempt number of this dispatch (1-based); echo it in ack/progress/result. */
  attempt: z.number().int().min(1).optional(),
});

/** Worker took the dispatched job; the hub starts the lease. */
export const JobAckMessage = z.object({
  type: z.literal("job.ack"),
  jobId: JobId,
  attempt: z.number().int().min(1).optional(),
});

export const JobProgressMessage = z.object({
  type: z.literal("job.progress"),
  jobId: JobId,
  /** 0..1 */
  progress: z.number().min(0).max(1),
  message: z.string().max(2_000).optional(),
  attempt: z.number().int().min(1).optional(),
});

/** Lease renewal for every job the worker is still executing. */
export const JobHeartbeatMessage = z.object({
  type: z.literal("job.heartbeat"),
  jobIds: z.array(JobId).max(MAX_ACTIVE_JOBS_IN_FRAME),
});

export const JobResultMessage = z.object({
  type: z.literal("job.result"),
  jobId: JobId,
  /** `cancelled` confirms a `job.cancel`. */
  status: z.enum(["succeeded", "failed", "cancelled"]),
  output: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(10_000).optional(),
  attempt: z.number().int().min(1).optional(),
  /**
   * For `failed`: the failure is transient, run it again if attempts remain.
   * Default false: handler failures are final.
   */
  retryable: z.boolean().optional(),
});

/** Worker gives a job back unfinished (e.g. graceful shutdown); no attempt is consumed. */
export const JobReleaseMessage = z.object({
  type: z.literal("job.release"),
  jobId: JobId,
  attempt: z.number().int().min(1).optional(),
  reason: z.string().max(500).optional(),
});

/** Worker is shutting down: send it no new jobs on this connection. */
export const WorkerDrainMessage = z.object({
  type: z.literal("worker.drain"),
});

/**
 * Remaining subscription usage as the worker sees it. The hub keeps the
 * latest report (durably) and shows it in presence as `usage`.
 */
export const WorkerUsageMessage = WorkerUsage.extend({
  type: z.literal("worker.usage"),
});

/**
 * The Mac's Claude sign-in as the worker sees it (after `hello`, on every
 * change and after a `worker.command`). The hub keeps the latest one and
 * shows it in presence as `claude`.
 */
export const WorkerClaudeMessage = z.object({
  type: z.literal("worker.claude"),
  account: ClaudeAccount,
});

/**
 * The Mac's Gemini API / CLI readiness as the worker sees it. The hub keeps
 * the latest one and shows it in presence as `gemini`.
 */
export const WorkerGeminiMessage = z.object({
  type: z.literal("worker.gemini"),
  account: GeminiAccount,
});

/**
 * The Mac's other AI providers (Codex CLI, OpenAI API, Antigravity CLI) as the worker sees
 * them. The hub keeps the latest list and shows it in presence as `providers`.
 */
export const WorkerProvidersMessage = z.object({
  type: z.literal("worker.providers"),
  providers: z.array(AiProviderStatus).max(16),
});

/**
 * The tools Studio uses on the Mac (tools.ts) as the worker sees them: after `hello`, after every
 * `tool.install` / `tool.uninstall` and while one runs. The hub keeps the latest list and shows
 * it in presence as `tools` and at `GET /api/tools`.
 */
export const WorkerToolsMessage = z.object({
  type: z.literal("worker.tools"),
  tools: z.array(ToolStatus).max(16),
});

/** Hub forwards an app request about AI sign-in / status (start Claude login, re-read Claude/Gemini status). */
export const WorkerCommandMessage = z.object({
  type: z.literal("worker.command"),
  command: WorkerCommand,
});

/** Hub asks the worker to abort a job; the worker answers with a `cancelled` result. */
export const JobCancelMessage = z.object({
  type: z.literal("job.cancel"),
  jobId: JobId,
  reason: z.string().max(500).optional(),
});

/** Hub stored (or already had) the result; the worker may forget it. */
export const JobResultAckMessage = z.object({
  type: z.literal("job.result.ack"),
  jobId: JobId,
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
  JobAckMessage,
  JobProgressMessage,
  JobHeartbeatMessage,
  JobResultMessage,
  JobReleaseMessage,
  WorkerDrainMessage,
  WorkerUsageMessage,
  WorkerClaudeMessage,
  WorkerGeminiMessage,
  WorkerProvidersMessage,
  WorkerToolsMessage,
  JobCancelMessage,
  JobResultAckMessage,
  WorkerCommandMessage,
  PingMessage,
  PongMessage,
]);

export type HelloMessage = z.infer<typeof HelloMessage>;
export type JobDispatchMessage = z.infer<typeof JobDispatchMessage>;
export type JobAckMessage = z.infer<typeof JobAckMessage>;
export type JobProgressMessage = z.infer<typeof JobProgressMessage>;
export type JobHeartbeatMessage = z.infer<typeof JobHeartbeatMessage>;
export type JobResultMessage = z.infer<typeof JobResultMessage>;
export type JobReleaseMessage = z.infer<typeof JobReleaseMessage>;
export type WorkerDrainMessage = z.infer<typeof WorkerDrainMessage>;
export type WorkerUsageMessage = z.infer<typeof WorkerUsageMessage>;
export type WorkerClaudeMessage = z.infer<typeof WorkerClaudeMessage>;
export type WorkerGeminiMessage = z.infer<typeof WorkerGeminiMessage>;
export type WorkerProvidersMessage = z.infer<typeof WorkerProvidersMessage>;
export type WorkerToolsMessage = z.infer<typeof WorkerToolsMessage>;
export type WorkerCommandMessage = z.infer<typeof WorkerCommandMessage>;
export type JobCancelMessage = z.infer<typeof JobCancelMessage>;
export type JobResultAckMessage = z.infer<typeof JobResultAckMessage>;
export type PingMessage = z.infer<typeof PingMessage>;
export type PongMessage = z.infer<typeof PongMessage>;
export type ProtocolMessage = z.infer<typeof ProtocolMessage>;
export type ProtocolMessageType = ProtocolMessage["type"];

/** Messages the worker sends. */
export type WorkerToHubMessage = Extract<
  ProtocolMessage,
  {
    type:
      | "hello"
      | "job.ack"
      | "job.progress"
      | "job.heartbeat"
      | "job.result"
      | "job.release"
      | "worker.drain"
      | "worker.usage"
      | "worker.claude"
      | "worker.gemini"
      | "worker.providers"
      | "worker.tools"
      | "ping"
      | "pong";
  }
>;
/** Messages the hub sends. */
export type HubToWorkerMessage = Extract<
  ProtocolMessage,
  { type: "job.dispatch" | "job.cancel" | "job.result.ack" | "worker.command" | "ping" | "pong" }
>;

export type DecodeResult = { ok: true; message: ProtocolMessage } | { ok: false; error: string };

/** Serialize a message. Throws if the message does not match the schema. */
export function encodeMessage(message: ProtocolMessage): string {
  return JSON.stringify(ProtocolMessage.parse(message));
}

function parseFrame<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): { ok: true; message: z.output<S> } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "frame must be a text (JSON) message" };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "frame is not valid JSON" };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }
  return { ok: true, message: parsed.data };
}

/**
 * Parse and validate an incoming frame. Never throws: malformed JSON,
 * binary frames and schema violations all come back as `{ ok: false }`.
 */
export function decodeMessage(raw: unknown): DecodeResult {
  return parseFrame(ProtocolMessage, raw);
}

// --- Client job stream (GET /api/jobs/stream) ---------------------------------
//
// Web and iOS clients open a WebSocket to /api/jobs/stream (optionally
// ?jobId= or ?brandId=). The hub sends one `jobs.snapshot` right away, then
// `job.updated` for every change of a matching job and `presence` when the
// worker comes or goes. Clients may send `ping` and get `pong`; anything
// else they send is ignored. After a reconnect the new snapshot replaces
// local state, so no update is ever lost for good.

export const JobsSnapshotEvent = z.object({
  type: z.literal("jobs.snapshot"),
  /** Matching jobs, newest first (at most 50; page older ones via GET /api/jobs). */
  jobs: z.array(Job),
  presence: WorkerPresence,
});

export const JobUpdatedEvent = z.object({
  type: z.literal("job.updated"),
  job: Job,
});

export const PresenceEvent = z.object({
  type: z.literal("presence"),
  presence: WorkerPresence,
});

/**
 * An approval request (approval.ts) was created or decided: sent to sockets watching its brand
 * or everything. Lists showing "Onay bekliyor" refresh on it. Clients that do not know the type
 * ignore it.
 */
export const ApprovalUpdatedEvent = z.object({
  type: z.literal("approval.updated"),
  approval: ApprovalRequest,
});

export const JobStreamMessage = z.discriminatedUnion("type", [
  JobsSnapshotEvent,
  JobUpdatedEvent,
  PresenceEvent,
  PongMessage,
  ApprovalUpdatedEvent,
]);

export type ApprovalUpdatedEvent = z.infer<typeof ApprovalUpdatedEvent>;
export type JobsSnapshotEvent = z.infer<typeof JobsSnapshotEvent>;
export type JobUpdatedEvent = z.infer<typeof JobUpdatedEvent>;
export type PresenceEvent = z.infer<typeof PresenceEvent>;
export type JobStreamMessage = z.infer<typeof JobStreamMessage>;

export type JobStreamDecodeResult =
  | { ok: true; message: JobStreamMessage }
  | { ok: false; error: string };

export function encodeJobStreamMessage(message: JobStreamMessage): string {
  return JSON.stringify(JobStreamMessage.parse(message));
}

/** Parse a frame from the job stream. Never throws. */
export function decodeJobStreamMessage(raw: unknown): JobStreamDecodeResult {
  return parseFrame(JobStreamMessage, raw);
}
