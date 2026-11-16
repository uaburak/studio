import { z } from "zod";
import { EntityId, jsonWithin, PageQuery, pageOf, Timestamp } from "./common.ts";

export const JobId = z.string().min(1).max(128);
export type JobId = z.infer<typeof JobId>;

/**
 * Known job types. Extend this enum as the worker learns new work.
 * - `demo.echo` exists only to prove the hub <-> worker round trip.
 * - `content.generate`, `content.render`, `brand.analyze` are reserved for
 *   the generation pipeline (F1-3) and brand profiling (F1-4); their payload
 *   schemas are defined by those tasks. Until then the payload is free-form.
 */
export const JobType = z
  .enum(["demo.echo", "content.generate", "content.render", "brand.analyze"])
  .meta({ id: "JobType" });
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z
  .enum(["queued", "running", "succeeded", "failed", "cancelled"])
  .meta({ id: "JobStatus" });
export type JobStatus = z.infer<typeof JobStatus>;

/** Which references a job type needs at creation time. */
export const JOB_TYPE_REQUIREMENTS = {
  "demo.echo": { brand: false, content: false },
  "content.generate": { brand: true, content: true },
  "content.render": { brand: true, content: true },
  "brand.analyze": { brand: true, content: false },
} as const satisfies Record<JobType, { brand: boolean; content: boolean }>;

export const MAX_JOB_PAYLOAD_BYTES = 100_000;
export const JOB_PRIORITY_MIN = -100;
export const JOB_PRIORITY_MAX = 100;
export const DEFAULT_JOB_MAX_ATTEMPTS = 3;
export const MAX_JOB_ATTEMPTS = 10;

/** Statuses a job never leaves. */
export const TERMINAL_JOB_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly JobStatus[];
export function isTerminalJobStatus(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

export const Job = z
  .object({
    id: JobId,
    type: JobType,
    status: JobStatus,
    /** Type-specific input. Validate with the per-type payload schema. */
    payload: z.record(z.string(), z.unknown()),
    /** Brand the job works for (absent for brand-less jobs such as `demo.echo`). */
    brandId: EntityId.optional(),
    /** Content item the job works on, when relevant. */
    contentId: EntityId.optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    startedAt: Timestamp.optional(),
    finishedAt: Timestamp.optional(),
    /** 0..1, last reported progress. */
    progress: z.number().min(0).max(1).optional(),
    /** Type-specific output (the job result) when status is `succeeded`. */
    output: z.record(z.string(), z.unknown()).optional(),
    /** Human-readable error when status is `failed`. */
    error: z.string().optional(),
    // --- queue fields (F1-6); optional so older producers stay valid ---
    /** Higher runs first; FIFO within the same priority. Default 0. */
    priority: z.number().int().optional(),
    /** Dispatch attempts so far (an attempt counts once the worker acknowledged it). */
    attempts: z.number().int().min(0).optional(),
    /** After this many lost attempts the job fails. */
    maxAttempts: z.number().int().min(1).optional(),
    /** Worker that runs (or last ran) the job. */
    workerId: z.string().optional(),
    /** Message attached to the last progress report. */
    progressMessage: z.string().optional(),
    /** Set while a cancel is pending on the worker (status is still `running`). */
    cancelRequestedAt: Timestamp.optional(),
  })
  .meta({ id: "Job" });
export type Job = z.infer<typeof Job>;

export const JobCreate = z
  .object({
    type: JobType,
    payload: z
      .record(z.string(), z.unknown())
      .refine(jsonWithin(MAX_JOB_PAYLOAD_BYTES), "payload is too large")
      .default({}),
    /** Required for brand/content jobs; derived from `contentId` when omitted. */
    brandId: EntityId.optional(),
    contentId: EntityId.optional(),
    /** Higher runs first (default 0); FIFO within the same priority. */
    priority: z.number().int().min(JOB_PRIORITY_MIN).max(JOB_PRIORITY_MAX).optional(),
    /** Attempts before the job fails when its worker keeps disappearing (default 3). */
    maxAttempts: z.number().int().min(1).max(MAX_JOB_ATTEMPTS).optional(),
  })
  .meta({ id: "JobCreate" });
export type JobCreate = z.input<typeof JobCreate>;

export const JobListQuery = PageQuery.extend({
  brandId: EntityId.optional(),
  contentId: EntityId.optional(),
  status: JobStatus.optional(),
  type: JobType.optional(),
});
export type JobListQuery = z.input<typeof JobListQuery>;

export const JobList = pageOf(Job, "JobList");
export type JobList = z.infer<typeof JobList>;

// --- demo.echo -------------------------------------------------------------

export const DemoEchoPayload = z.object({
  text: z.string().max(10_000),
  /** Optional artificial duration, to exercise progress, cancel and requeue. */
  delayMs: z.number().int().min(0).max(600_000).optional(),
  /** Progress reports spread over `delayMs` (default 4). */
  steps: z.number().int().min(1).max(100).optional(),
});
export type DemoEchoPayload = z.infer<typeof DemoEchoPayload>;

export const DemoEchoOutput = z.object({
  text: z.string(),
  reversed: z.string(),
  workerId: z.string(),
});
export type DemoEchoOutput = z.infer<typeof DemoEchoOutput>;

/** Per-type payload schemas known so far; other types accept any object. */
export const JOB_PAYLOAD_SCHEMAS: Partial<Record<JobType, z.ZodType>> = {
  "demo.echo": DemoEchoPayload,
};

// --- Live updates and worker presence (F1-6) --------------------------------

/** Filter for `GET /api/jobs/stream`: one job, one brand, or (neither) all jobs. */
export const JobStreamQuery = z
  .object({ jobId: JobId.optional(), brandId: EntityId.optional() })
  .refine((q) => !(q.jobId && q.brandId), "pass jobId or brandId, not both");
export type JobStreamQuery = z.input<typeof JobStreamQuery>;

export const ConnectedWorker = z
  .object({
    workerId: z.string(),
    workerVersion: z.string().optional(),
    capabilities: z.array(z.string()),
    /** Jobs the worker runs at the same time. */
    concurrency: z.number().int().min(1),
    connectedAt: Timestamp,
    lastSeenAt: Timestamp,
    /** True after the worker announced a graceful shutdown. */
    draining: z.boolean(),
  })
  .meta({ id: "ConnectedWorker" });
export type ConnectedWorker = z.infer<typeof ConnectedWorker>;

export const PresenceJob = z
  .object({
    id: JobId,
    type: JobType,
    brandId: EntityId.optional(),
    workerId: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    progressMessage: z.string().optional(),
    startedAt: Timestamp.optional(),
  })
  .meta({ id: "PresenceJob" });
export type PresenceJob = z.infer<typeof PresenceJob>;

/** "Is the Mac online?" — `GET /api/workers/presence` and the job stream. */
export const WorkerPresence = z
  .object({
    online: z.boolean(),
    /** Last message from any worker; null if no worker ever connected. */
    lastSeenAt: Timestamp.nullable(),
    workers: z.array(ConnectedWorker),
    /** Jobs currently `running`. */
    currentJobs: z.array(PresenceJob),
    /** Jobs waiting in `queued`. */
    queueLength: z.number().int().min(0),
  })
  .meta({ id: "WorkerPresence" });
export type WorkerPresence = z.infer<typeof WorkerPresence>;
