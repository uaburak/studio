// Child processes of the host (port of StudioMac/Host/ProcessLauncher.swift).
//
// Each child runs in its own process group (detached), stdin from /dev/null, stdout+stderr
// appended to its log file, with exactly the environment the host built (nothing else is
// inherited). When a child exits, whatever is left of its group (e.g. workerd under wrangler)
// is killed so nothing outlives it.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { constants } from "node:os";
import { dirname } from "node:path";
import { redactSecrets } from "./redact.ts";

export interface ProcessSpec {
  name: string;
  executable: string;
  args: string[];
  /** The complete environment (nothing is inherited from the app). */
  env: Record<string, string>;
  cwd: string;
  /** stdout and stderr are appended here. */
  logFile: string;
}

export interface RunningProcess {
  readonly pid: number;
  /** Exit code, or 128 + signal number when killed by a signal. */
  waitForExit(): Promise<number>;
  /** SIGTERM to the process; SIGKILL to its whole group after `graceMs`. Resolves once exited. */
  terminate(graceMs: number): Promise<void>;
}

export interface ProcessLauncher {
  launch(spec: ProcessSpec): RunningProcess;
}

export class LaunchError extends Error {}

/** 128 + signal number, like a shell reports a killed child. */
export function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) return 128 + (constants.signals[signal] ?? 0);
  return -1;
}

function stamp(): string {
  return new Date().toISOString();
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // group already gone
  }
}

/** The header line of a child's log: never the secrets (they travel in the environment). */
export function logHeader(spec: Pick<ProcessSpec, "name" | "executable" | "args">): string {
  return `${spec.name}: ${redactSecrets([spec.executable, ...spec.args].join(" "))}`;
}

export class SpawnLauncher implements ProcessLauncher {
  launch(spec: ProcessSpec): RunningProcess {
    mkdirSync(dirname(spec.logFile), { recursive: true });
    appendFileSync(spec.logFile, `\n=== ${stamp()} ${logHeader(spec)}\n`);
    const fd = openSync(spec.logFile, "a");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.executable, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } catch (error) {
      closeSync(fd);
      throw new LaunchError(`${spec.name} başlatılamadı: ${(error as Error).message}`);
    }
    // The child has its own copy of the descriptor.
    closeSync(fd);
    if (child.pid === undefined) {
      // Spawning failed (ENOENT, EACCES, …): Node reports it later as an "error" event, which
      // would crash the app without a listener.
      child.once("error", () => undefined);
      throw new LaunchError(`${spec.name} başlatılamadı: ${spec.executable} çalıştırılamıyor`);
    }
    return new SpawnedProcess(child, spec);
  }
}

class SpawnedProcess implements RunningProcess {
  readonly pid: number;
  private status: number | null = null;
  private readonly exited: Promise<number>;

  constructor(child: ReturnType<typeof spawn>, spec: ProcessSpec) {
    this.pid = child.pid as number;
    this.exited = new Promise((resolve) => {
      let settled = false;
      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        // Leftovers of the group (children of the child) must not outlive it.
        killGroup(this.pid, "SIGKILL");
        try {
          appendFileSync(spec.logFile, `=== ${stamp()} ${spec.name} bitti (çıkış kodu ${code})\n`);
        } catch {
          // log folder removed
        }
        this.status = code;
        resolve(code);
      };
      child.once("exit", (code, signal) => finish(exitCode(code, signal)));
      child.once("error", () => finish(-1));
    });
  }

  waitForExit(): Promise<number> {
    return this.exited;
  }

  async terminate(graceMs: number): Promise<void> {
    if (this.status !== null) return;
    try {
      process.kill(this.pid, "SIGTERM");
    } catch {
      // already gone
    }
    const killer = setTimeout(() => killGroup(this.pid, "SIGKILL"), graceMs);
    await this.exited;
    clearTimeout(killer);
  }
}

// --- one-shot children (D1 migrations) ------------------------------------------------------

export type OneShotOutcome =
  | { kind: "exited"; code: number }
  /** Did not finish in time; it was terminated (SIGTERM, then SIGKILL to its group). */
  | { kind: "timedOut" }
  /** The host stopped meanwhile; the child was terminated. */
  | { kind: "cancelled" };

/**
 * Waits for `process` to exit, at most `timeoutMs`. Returns `timedOut` even when the child
 * cannot be reaped afterwards, so a caller never waits longer than timeout + grace + 2 s.
 */
export function waitOneShot(
  process: RunningProcess,
  timeoutMs: number,
  options: { graceMs?: number; signal?: AbortSignal } = {},
): Promise<OneShotOutcome> {
  const graceMs = options.graceMs ?? 3_000;
  return new Promise((resolve) => {
    let done = false;
    let expired = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const settle = (outcome: OneShotOutcome) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => {
      void process.terminate(graceMs);
      settle({ kind: "cancelled" });
    };
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    void process.waitForExit().then((code) => {
      settle(expired ? { kind: "timedOut" } : { kind: "exited", code });
    });
    timers.push(
      setTimeout(() => {
        expired = true;
        void process.terminate(graceMs);
        timers.push(setTimeout(() => settle({ kind: "timedOut" }), graceMs + 2_000));
      }, timeoutMs),
    );
  });
}
