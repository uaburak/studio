// One host per state folder (P9). Before a Studio app starts its children on a state folder it
// takes `host.lock` there: created atomically (O_EXCL), holding the pid and the process's start
// time. A second app finds it held and attaches to the running API instead (LocalHost's attach
// rules) or says clearly why it cannot start. A lock whose process is gone, or whose pid now
// belongs to another process (pid reuse after a crash), is stale and taken over.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export const LOCK_FILE = "host.lock";

export interface LockInfo {
  pid: number;
  /** The holder's process start time (ms since epoch), as `ps` reports it; null: unknown. */
  startedAt: number | null;
  /** "dev" or "packaged" (shown when another app holds the lock). */
  mode: string;
  version: string;
  host: string;
  acquiredAt: string;
}

export type LockOutcome = { kind: "acquired" } | { kind: "held"; holder: LockInfo };

export interface LockDeps {
  isAlive(pid: number): boolean;
  /** Start time of a process (ms), null when it cannot be read. */
  processStartedAt(pid: number): number | null;
  now(): number;
}

/** `ps -o lstart=` → ms since epoch (local time, one-second resolution). */
export function parseLstart(text: string): number | null {
  const clean = text.trim().replace(/\s+/g, " ");
  if (!clean) return null;
  const ms = Date.parse(clean);
  return Number.isFinite(ms) ? ms : null;
}

export function processStartedAt(pid: number): number | null {
  if (!(pid > 0)) return null;
  try {
    const out = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    return parseLstart(out);
  } catch {
    return null;
  }
}

function readLock(file: string): LockInfo | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<LockInfo>;
    if (typeof value.pid !== "number") return null;
    return {
      pid: value.pid,
      startedAt: typeof value.startedAt === "number" ? value.startedAt : null,
      mode: typeof value.mode === "string" ? value.mode : "",
      version: typeof value.version === "string" ? value.version : "",
      host: typeof value.host === "string" ? value.host : "",
      acquiredAt: typeof value.acquiredAt === "string" ? value.acquiredAt : "",
    };
  } catch {
    return null;
  }
}

/** Whether the lock's holder is still the process that took it. */
export function holderAlive(holder: LockInfo, deps: LockDeps): boolean {
  if (!deps.isAlive(holder.pid)) return false;
  if (holder.startedAt === null) return true;
  const actual = deps.processStartedAt(holder.pid);
  // Unknown (ps failed): assume it is the same process rather than steal a live lock.
  if (actual === null) return true;
  return Math.abs(actual - holder.startedAt) < 2_000;
}

export class HostLock {
  private held = false;

  constructor(
    private readonly stateDir: string,
    private readonly own: { pid: number; mode: string; version: string },
    private readonly deps: LockDeps,
  ) {}

  get file(): string {
    return join(this.stateDir, LOCK_FILE);
  }

  get isHeld(): boolean {
    return this.held;
  }

  /** Takes the lock (again, when this process already holds it). */
  acquire(): LockOutcome {
    mkdirSync(this.stateDir, { recursive: true });
    const file = this.file;
    for (let attempt = 0; attempt < 4; attempt++) {
      const info: LockInfo = {
        pid: this.own.pid,
        startedAt: this.deps.processStartedAt(this.own.pid),
        mode: this.own.mode,
        version: this.own.version,
        host: hostname(),
        acquiredAt: new Date(this.deps.now()).toISOString(),
      };
      try {
        const fd = openSync(file, "wx", 0o600);
        try {
          writeSync(fd, `${JSON.stringify(info)}\n`);
        } finally {
          closeSync(fd);
        }
        this.held = true;
        return { kind: "acquired" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = readLock(file);
      if (holder?.pid === this.own.pid) {
        this.held = true;
        return { kind: "acquired" };
      }
      if (holder === null) {
        // Being written right now, or left half-written by a crash: wait it out briefly.
        let age = 0;
        try {
          age = this.deps.now() - statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (age < 5_000) {
          return {
            kind: "held",
            holder: { pid: 0, startedAt: null, mode: "", version: "", host: "", acquiredAt: "" },
          };
        }
      } else if (holderAlive(holder, this.deps)) {
        return { kind: "held", holder };
      }
      // Stale: move it out of the way atomically (two apps may race here; one rename wins).
      const aside = `${file}.stale-${this.own.pid}-${attempt}`;
      try {
        renameSync(file, aside);
        rmSync(aside, { force: true });
      } catch {
        // someone else took it over meanwhile: try again
      }
    }
    const holder = readLock(file);
    return {
      kind: "held",
      holder: holder ?? {
        pid: 0,
        startedAt: null,
        mode: "",
        version: "",
        host: "",
        acquiredAt: "",
      },
    };
  }

  /** Removes the lock when this process holds it. */
  release(): void {
    if (!this.held) return;
    this.held = false;
    const holder = readLock(this.file);
    if (holder && holder.pid !== this.own.pid) return;
    rmSync(this.file, { force: true });
  }
}

/** What the owner reads when another app runs the host on the same state folder. */
export function lockHeldMessage(holder: LockInfo): string {
  if (holder.pid <= 0) {
    return "Bu veri klasöründe başka bir Studio sunucusu açılıyor. Birkaç saniye sonra “Yeniden başlat”a tıkla.";
  }
  const kind =
    holder.mode === "packaged"
      ? "Studio uygulaması"
      : holder.mode === "dev"
        ? "geliştirme kopyası"
        : "başka bir Studio";
  const since = holder.acquiredAt
    ? ` (${new Date(holder.acquiredAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })} itibarıyla)`
    : "";
  return (
    `Bu veri klasörünü şu an başka bir Studio sunucusu kullanıyor: ${kind}, işlem ${holder.pid}${since}. ` +
    "İki sunucu aynı veritabanına yazamaz. O uygulamayı kapat ya da açılmasını bekleyip “Yeniden başlat”a tıkla; Studio çalışan sunucuya bağlanır."
  );
}

export const realLockDeps = (isAlive: (pid: number) => boolean): LockDeps => ({
  isAlive,
  processStartedAt,
  now: Date.now,
});
