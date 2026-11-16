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

export const DemoEchoPayload = z.object({ text: z.string().max(10_000) });
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
