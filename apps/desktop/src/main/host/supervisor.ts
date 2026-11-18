// Keeps one child process running (port of StudioMac/Host/ServiceSupervisor.swift): launches
// it, relaunches it with exponential backoff when it exits, gives up after too many quick
// crashes, and stops it on request. Time and processes are injected for tests.
import type { ServicePhase } from "../../shared/ipc.ts";
import type { ProcessLauncher, ProcessSpec, RunningProcess } from "./process.ts";

export interface SupervisorPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  /** A run at least this long resets the crash counter. */
  stableAfterMs: number;
  /** Consecutive quick crashes before giving up (until `start` again). */
  maxQuickFailures: number;
  stopGraceMs: number;
}

export const DEFAULT_POLICY: SupervisorPolicy = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  stableAfterMs: 60_000,
  maxQuickFailures: 8,
  stopGraceMs: 8_000,
};

/** Delay before relaunch number `failures` (1-based): base, 2x, 4x, … capped. */
export function backoffDelay(policy: SupervisorPolicy, failures: number): number {
  let delay = policy.baseDelayMs;
  for (let i = 1; i < Math.max(failures, 1); i++) {
    delay *= 2;
    if (delay >= policy.maxDelayMs) return policy.maxDelayMs;
  }
  return Math.min(delay, policy.maxDelayMs);
}

export interface SupervisorDeps {
  policy?: Partial<SupervisorPolicy>;
  /** Resolves after `ms`, or early when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export class ServiceSupervisor {
  readonly policy: SupervisorPolicy;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private phaseValue: ServicePhase = { kind: "idle" };
  private loop: Promise<void> | undefined;
  private current: RunningProcess | undefined;
  private stopping = false;
  private sleepAbort = new AbortController();
  launches = 0;
  onChange: ((phase: ServicePhase) => void) | undefined;

  constructor(
    readonly name: string,
    private readonly makeSpec: () => ProcessSpec,
    private readonly launcher: ProcessLauncher,
    deps: SupervisorDeps = {},
  ) {
    this.policy = { ...DEFAULT_POLICY, ...deps.policy };
    this.sleep = deps.sleep ?? defaultSleep;
    this.now = deps.now ?? Date.now;
  }

  get phase(): ServicePhase {
    return this.phaseValue;
  }

  private setPhase(phase: ServicePhase): void {
    if (JSON.stringify(phase) === JSON.stringify(this.phaseValue)) return;
    this.phaseValue = phase;
    this.onChange?.(phase);
  }

  get isActive(): boolean {
    return this.loop !== undefined;
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.sleepAbort = new AbortController();
    this.loop = this.run().finally(() => {
      this.loop = undefined;
    });
  }

  /**
   * Terminate the child (SIGTERM, then SIGKILL after the grace period — the policy's, or
   * `graceMs` when the whole host stops under one deadline); no relaunch.
   */
  async stop(graceMs = this.policy.stopGraceMs): Promise<void> {
    this.stopping = true;
    this.sleepAbort.abort();
    const loop = this.loop;
    if (this.current) await this.current.terminate(graceMs);
    await loop;
    this.loop = undefined;
    this.setPhase({ kind: "stopped" });
  }

  private async run(): Promise<void> {
    let quickFailures = 0;
    while (!this.stopping) {
      const started = this.now();
      let process: RunningProcess;
      try {
        process = this.launcher.launch(this.makeSpec());
      } catch (error) {
        this.setPhase({ kind: "failed", message: (error as Error).message });
        break;
      }
      this.current = process;
      this.launches += 1;
      this.setPhase({ kind: "running", pid: process.pid });
      const status = await process.waitForExit();
      this.current = undefined;
      if (this.stopping) break;

      if (this.now() - started >= this.policy.stableAfterMs) quickFailures = 0;
      quickFailures += 1;
      if (quickFailures > this.policy.maxQuickFailures) {
        this.setPhase({
          kind: "failed",
          message: `${this.name} art arda ${quickFailures - 1} kez kapandı (son çıkış kodu ${status}).`,
        });
        break;
      }
      const delayMs = backoffDelay(this.policy, quickFailures);
      this.setPhase({ kind: "restarting", exitStatus: status, delayMs });
      await this.sleep(delayMs, this.sleepAbort.signal);
    }
    if (this.phaseValue.kind !== "failed" && this.stopping) this.setPhase({ kind: "stopped" });
  }
}
