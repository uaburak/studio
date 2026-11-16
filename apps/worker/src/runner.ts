import type {
  HelloMessage,
  Job,
  JobResultMessage,
  ProtocolMessage,
  WorkerToHubMessage,
} from "@studio/contract";
import { MAX_ACTIVE_JOBS_IN_FRAME } from "@studio/contract";
import { type Logger, silentLogger } from "./log.ts";
import type { Outbox } from "./outbox.ts";
import { type JobContext, type JobRegistry, RetryableError } from "./registry.ts";

/** Abort reasons the runner uses; handlers only see an aborted signal. */
class AbortReason extends Error {
  constructor(readonly kind: "cancel" | "shutdown") {
    super(kind === "cancel" ? "job cancelled" : "worker shutting down");
    this.name = "AbortError";
  }
}

interface ActiveJob {
  job: Job;
  attempt: number | undefined;
  controller: AbortController;
  done: Promise<void>;
}

export interface JobRunnerOptions {
  workerId: string;
  registry: JobRegistry;
  outbox: Outbox;
  /** Send to the hub; returns false when not connected (the frame is dropped). */
  send: (message: WorkerToHubMessage) => boolean;
  /** Jobs run at the same time (announced to the hub in `hello`). */
  concurrency: number;
  /** Lease heartbeat for running jobs; also resends unacknowledged results. 0 disables the timer. */
  heartbeatIntervalMs: number;
  /** Resend a result the hub has not acknowledged after this long (default 30 s). */
  resendAfterMs?: number;
  logger?: Logger;
}

/**
 * Executes dispatched jobs. Owns everything stateful on the worker side:
 * - acknowledges dispatches, runs handlers with an AbortSignal, forwards progress;
 * - keeps every result in the outbox until the hub sends `job.result.ack`
 *   (resent after reconnect and periodically), so none is lost or doubled;
 * - aborts on `job.cancel` and reports `cancelled`;
 * - on shutdown aborts running jobs and hands them back (`job.release`).
 * All I/O goes through `send`, so tests can drive it without a socket.
 */
export class JobRunner {
  private readonly active = new Map<string, ActiveJob>();
  private readonly lastSent = new Map<string, number>();
  private readonly logger: Logger;
  private timer: ReturnType<typeof setInterval> | undefined;
  private draining = false;

  constructor(private readonly options: JobRunnerOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  /** Extra `hello` fields: what this worker still holds and how much it can run. */
  helloFields(): Pick<HelloMessage, "concurrency" | "activeJobIds"> {
    const ids = new Set([...this.active.keys(), ...this.options.outbox.list().map((r) => r.jobId)]);
    return {
      concurrency: this.options.concurrency,
      activeJobIds: [...ids].slice(0, MAX_ACTIVE_JOBS_IN_FRAME),
    };
  }

  /** Called right after `hello` went out on a fresh connection. */
  onConnected(): void {
    if (this.draining) this.options.send({ type: "worker.drain" });
    for (const result of this.options.outbox.list()) this.sendResult(result);
  }

  start(): void {
    if (this.timer || this.options.heartbeatIntervalMs <= 0) return;
    this.timer = setInterval(() => this.tick(), this.options.heartbeatIntervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get activeJobIds(): string[] {
    return [...this.active.keys()];
  }

  /** Resolves when no job is running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled([...this.active.values()].map((a) => a.done));
    }
  }

  handle(message: ProtocolMessage): void {
    switch (message.type) {
      case "ping":
        this.options.send({ type: "pong", ts: message.ts });
        return;
      case "job.dispatch":
        this.onDispatch(message.job, message.attempt);
        return;
      case "job.cancel":
        this.onCancel(message.jobId, message.reason);
        return;
      case "job.result.ack":
        this.lastSent.delete(message.jobId);
        void this.options.outbox
          .delete(message.jobId)
          .catch((error: unknown) => this.logger.error("could not update the outbox", error));
        return;
      case "pong":
        return;
      default:
        this.logger.debug(`ignoring unexpected message from hub: ${message.type}`);
    }
  }

  /**
   * Graceful shutdown: stop taking work, abort running jobs and hand them
   * back, then give unacknowledged results a moment to reach the hub.
   */
  async shutdown(timeoutMs: number): Promise<void> {
    this.draining = true;
    this.options.send({ type: "worker.drain" });
    for (const entry of this.active.values()) entry.controller.abort(new AbortReason("shutdown"));
    const deadline = Date.now() + timeoutMs;
    await Promise.race([this.idle(), sleep(timeoutMs)]);
    if (this.active.size > 0) {
      this.logger.warn(
        `${this.active.size} job(s) did not stop in time; the hub requeues them when their lease expires`,
      );
    }
    while (this.options.outbox.size > 0 && Date.now() < deadline) await sleep(50);
    if (this.options.outbox.size > 0) {
      this.logger.warn(
        `${this.options.outbox.size} result(s) kept in the outbox for the next start`,
      );
    }
    this.stop();
  }

  // --- internals -------------------------------------------------------------------

  private onDispatch(job: Job, attempt: number | undefined): void {
    const ack = () =>
      this.options.send({ type: "job.ack", jobId: job.id, ...withAttempt(attempt) });
    if (this.active.has(job.id)) {
      ack(); // duplicate dispatch: already running it
      return;
    }
    const finished = this.options.outbox.get(job.id);
    if (finished) {
      this.sendResult(finished); // done already, the hub just has not heard yet
      return;
    }
    if (this.draining || this.active.size >= this.options.concurrency) {
      this.options.send({
        type: "job.release",
        jobId: job.id,
        ...withAttempt(attempt),
        reason: this.draining ? "shutdown" : "busy",
      });
      return;
    }
    ack();
    this.run(job, attempt);
  }

  private onCancel(jobId: string, reason: string | undefined): void {
    const entry = this.active.get(jobId);
    if (entry) {
      this.logger.info(`job ${jobId} cancel requested${reason ? ` (${reason})` : ""}`);
      entry.controller.abort(new AbortReason("cancel"));
      return;
    }
    if (this.options.outbox.get(jobId)) return; // finished; the result is on its way
    // Not ours (any more): confirm so the hub can settle it.
    this.options.send({
      type: "job.result",
      jobId,
      status: "cancelled",
      error: "not running on this worker",
    });
  }

  private run(job: Job, attempt: number | undefined): void {
    const controller = new AbortController();
    const { workerId, registry } = this.options;
    const log = (message: string, extra?: unknown) =>
      this.logger.info(`[job ${job.id}] ${message}`, extra);
    const ctx: JobContext = {
      jobId: job.id,
      attempt,
      workerId,
      signal: controller.signal,
      progress: (value, message) => {
        if (controller.signal.aborted) return;
        this.options.send({
          type: "job.progress",
          jobId: job.id,
          progress: Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)),
          ...(message !== undefined ? { message: message.slice(0, 2000) } : {}),
          ...withAttempt(attempt),
        });
      },
      log,
    };

    this.logger.info(`job ${job.id} (${job.type}) started${attempt ? `, attempt ${attempt}` : ""}`);
    const entry: ActiveJob = { job, attempt, controller, done: Promise.resolve() };
    this.active.set(job.id, entry);

    entry.done = (async () => {
      let result: JobResultMessage;
      try {
        const output = await registry.run(job, ctx);
        result = { type: "job.result", jobId: job.id, status: "succeeded", output };
        this.logger.info(`job ${job.id} succeeded`);
      } catch (error) {
        const reason = controller.signal.reason;
        if (controller.signal.aborted && reason instanceof AbortReason) {
          if (reason.kind === "shutdown") {
            this.active.delete(job.id);
            const sent = this.options.send({
              type: "job.release",
              jobId: job.id,
              ...withAttempt(attempt),
              reason: "shutdown",
            });
            this.logger.info(
              `job ${job.id} handed back${sent ? "" : " (not connected; the hub requeues it later)"}`,
            );
            return;
          }
          result = { type: "job.result", jobId: job.id, status: "cancelled", error: "cancelled" };
          this.logger.info(`job ${job.id} cancelled`);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          result = {
            type: "job.result",
            jobId: job.id,
            status: "failed",
            error: message.slice(0, 10_000),
            ...(error instanceof RetryableError ? { retryable: true } : {}),
          };
          this.logger.warn(`job ${job.id} failed: ${message}`);
        }
      }
      const final = { ...result, ...withAttempt(attempt) };
      // Into the outbox before it leaves: if the send is lost, it is resent.
      try {
        await this.options.outbox.put(final);
      } catch (error) {
        this.logger.error(`could not persist the result of ${job.id}`, error);
      }
      this.active.delete(job.id);
      this.sendResult(final);
    })();
  }

  private sendResult(result: JobResultMessage): void {
    if (this.options.send(result)) this.lastSent.set(result.jobId, Date.now());
  }

  private tick(): void {
    if (this.active.size > 0) {
      this.options.send({
        type: "job.heartbeat",
        jobIds: this.activeJobIds.slice(0, MAX_ACTIVE_JOBS_IN_FRAME),
      });
    }
    const resendAfter = this.options.resendAfterMs ?? 30_000;
    const now = Date.now();
    for (const result of this.options.outbox.list()) {
      if (now - (this.lastSent.get(result.jobId) ?? 0) >= resendAfter) this.sendResult(result);
    }
  }
}

function withAttempt(attempt: number | undefined): { attempt?: number } {
  return attempt !== undefined ? { attempt } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
