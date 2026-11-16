import type { Job, JobType } from "@studio/contract";
import { z } from "zod";

/** What a handler gets besides its payload. */
export interface JobContext {
  jobId: string;
  /** 1-based attempt number from the hub (undefined for very old hubs). */
  attempt: number | undefined;
  workerId: string;
  /**
   * Aborted when the job is cancelled or the worker shuts down. Pass it to
   * fetch / child processes and check it between steps; throwing after it
   * fired reports the job as cancelled (or hands it back on shutdown).
   */
  signal: AbortSignal;
  /** Report progress 0..1 (clamped) with an optional human-readable message. */
  progress(value: number, message?: string): void;
  /** Log a line tagged with the job id (local worker log). */
  log(message: string, extra?: unknown): void;
}

export interface JobHandlerDefinition<P, O extends Record<string, unknown>> {
  /** Validates `job.payload`; a mismatch fails the job before `run` is called. */
  payload: z.ZodType<P>;
  run(payload: P, ctx: JobContext): Promise<O>;
}

/** Identity helper so `run` gets the payload type inferred from the schema. */
export function defineHandler<P, O extends Record<string, unknown>>(
  definition: JobHandlerDefinition<P, O>,
): JobHandlerDefinition<P, O> {
  return definition;
}

/** Throw from a handler for transient failures (rate limit, network); the hub retries while attempts remain. */
export class RetryableError extends Error {
  override name = "RetryableError";
}

export class UnknownJobTypeError extends Error {
  override name = "UnknownJobTypeError";
  constructor(readonly jobType: string) {
    super(`unsupported job type: ${jobType}`);
  }
}

export class InvalidPayloadError extends Error {
  override name = "InvalidPayloadError";
}

// biome-ignore lint/suspicious/noExplicitAny: handlers have heterogeneous payload types
type AnyDefinition = JobHandlerDefinition<any, Record<string, unknown>>;

/** type -> handler. The registered types are the worker's `capabilities`. */
export class JobRegistry {
  private readonly handlers = new Map<string, AnyDefinition>();

  register<P, O extends Record<string, unknown>>(
    type: JobType,
    definition: JobHandlerDefinition<P, O>,
  ): this {
    if (this.handlers.has(type)) throw new Error(`handler for ${type} registered twice`);
    this.handlers.set(type, definition as AnyDefinition);
    return this;
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  /** Validate the payload and run the handler. Throws UnknownJobTypeError / InvalidPayloadError. */
  async run(job: Pick<Job, "type" | "payload">, ctx: JobContext): Promise<Record<string, unknown>> {
    const definition = this.handlers.get(job.type);
    if (!definition) throw new UnknownJobTypeError(job.type);
    const parsed = definition.payload.safeParse(job.payload);
    if (!parsed.success) {
      throw new InvalidPayloadError(`invalid payload: ${z.prettifyError(parsed.error)}`);
    }
    return definition.run(parsed.data, ctx);
  }
}
