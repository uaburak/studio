/**
 * The one door to Claude for every job on this Mac:
 * - at most `concurrency` calls at a time (default 1); the rest wait in FIFO order;
 * - a usage limit parks *all* calls until the window resets (the job keeps its
 *   lease through heartbeats and is never failed for it), then the call is retried;
 * - transient errors (overloaded, 5xx, network) are retried a few times with backoff.
 */
import type { Logger } from "../log.ts";
import { silentLogger } from "../log.ts";
import { ClaudeError, ClaudeUsageLimitError } from "./errors.ts";
import type { ClaudeCallOptions, ClaudeCallResult, ClaudeRunner } from "./runner.ts";

export interface ParkInfo {
  until: Date;
  reason: string;
  source: ClaudeUsageLimitError["resetSource"];
}

export interface GateHooks {
  /** The call waits for a usage-limit reset (called once per park). */
  onPark?: (info: ParkInfo) => void | Promise<void>;
  /** The park is over and the call is being retried. */
  onResume?: () => void | Promise<void>;
  /** Waiting for a free slot (another call is running). */
  onQueued?: (position: number) => void;
}

export interface ClaudeGateOptions {
  runner: ClaudeRunner;
  concurrency?: number;
  /** Retries for transient errors (default 3) and their base delay (default 20 s, doubled each time). */
  transientRetries?: number;
  transientDelayMs?: number;
  /** Extra wait after the announced reset time (default 60 s). */
  resetSlackMs?: number;
  /** Longest single sleep, so a sleeping Mac re-checks the clock (default 60 s). */
  maxSleepChunkMs?: number;
  logger?: Logger;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface GateStatus {
  running: number;
  queued: number;
  parkedUntil: Date | null;
  parkReason: string | null;
}

export class ClaudeGate {
  private readonly concurrency: number;
  private running = 0;
  private readonly waiters: { resolve: () => void; reject: (e: unknown) => void }[] = [];
  private parkedUntil = 0;
  private parkReason: string | null = null;
  private parkSource: ParkInfo["source"] = "fallback";
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Calls made through the gate (attempts that reached the CLI). */
  callCount = 0;

  constructor(private readonly options: ClaudeGateOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? 1);
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableSleep;
  }

  status(): GateStatus {
    const parked = this.parkedUntil > this.now();
    return {
      running: this.running,
      queued: this.waiters.length,
      parkedUntil: parked ? new Date(this.parkedUntil) : null,
      parkReason: parked ? this.parkReason : null,
    };
  }

  /** Park every call until `until` (e.g. a limit seen by the self-test). */
  park(until: Date, reason: string, source: ParkInfo["source"] = "fallback"): void {
    if (until.getTime() <= this.parkedUntil) return;
    this.parkedUntil = until.getTime();
    this.parkReason = reason;
    this.parkSource = source;
    this.logger.warn(`claude: parked until ${until.toISOString()} (${reason})`);
  }

  async call(options: ClaudeCallOptions, hooks: GateHooks = {}): Promise<ClaudeCallResult> {
    const signal = options.signal;
    let transientFailures = 0;
    for (;;) {
      await this.waitWhileParked(signal, hooks);
      await this.acquire(signal, hooks);
      let result: ClaudeCallResult;
      try {
        // The park may have started while this call waited for its slot.
        if (this.parkedUntil > this.now()) continue;
        this.callCount++;
        result = await this.options.runner(options);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (error instanceof ClaudeUsageLimitError) {
          this.park(error.resetsAt, error.message, error.resetSource);
          // An agent turn that already wrote or called tools is not repeated blindly.
          if (error.details?.partial) throw error;
          continue;
        }
        if (error instanceof ClaudeError && error.code === "transient" && !error.details?.partial) {
          transientFailures++;
          if (transientFailures > (this.options.transientRetries ?? 3)) throw error;
          const delay = (this.options.transientDelayMs ?? 20_000) * 2 ** (transientFailures - 1);
          this.logger.warn(`claude: ${error.message}; retrying in ${Math.round(delay / 1000)} s`);
          await this.sleep(delay, signal);
          continue;
        }
        throw error;
      } finally {
        this.release();
      }
      const u = result.usage;
      const five = result.rateLimit?.unifiedWindows?.five_hour?.utilization;
      this.logger.info(
        `claude ${options.label}: ${Math.round(u.wallMs / 1000)} s, in ${u.inputTokens}+${u.cacheReadTokens}r+${u.cacheWriteTokens}w, out ${u.outputTokens} tokens, ~$${u.costUsd.toFixed(3)} list${five !== undefined ? `, 5h window ${Math.round(five * 100)}%` : ""}`,
      );
      return result;
    }
  }

  private async waitWhileParked(signal: AbortSignal | undefined, hooks: GateHooks): Promise<void> {
    if (this.parkedUntil <= this.now()) return;
    await hooks.onPark?.({
      until: new Date(this.parkedUntil),
      reason: this.parkReason ?? "usage limit",
      source: this.parkSource,
    });
    const slack = this.options.resetSlackMs ?? 60_000;
    const chunk = this.options.maxSleepChunkMs ?? 60_000;
    for (;;) {
      signal?.throwIfAborted();
      const remaining = this.parkedUntil + slack - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(remaining, chunk), signal);
    }
    await hooks.onResume?.();
  }

  private acquire(signal: AbortSignal | undefined, hooks: GateHooks): Promise<void> {
    signal?.throwIfAborted();
    if (this.running < this.concurrency) {
      this.running++;
      return Promise.resolve();
    }
    hooks.onQueued?.(this.waiters.length + 1);
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next)
      next.resolve(); // the slot passes straight to the next caller
    else this.running = Math.max(0, this.running - 1);
  }
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
