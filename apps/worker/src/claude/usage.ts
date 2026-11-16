/**
 * Subscription usage as the CLI reports it, without extra calls.
 *
 * Every call's stream carries a `rate_limit_event` (seen in the recorded real fixture):
 *   { status: "allowed" | "allowed_warning" | "rejected", resetsAt: <unix s>, rateLimitType: "five_hour",
 *     overageStatus, isUsingOverage,
 *     unifiedWindows: { five_hour: { utilization: 0.71, resetsAt }, seven_day: { utilization: 0.44, resetsAt } } }
 * `utilization` is 0..1 of the window. A usage-limit error carries the same event with
 * status `rejected` (or only a reset time in its text). The result line has no window data.
 * The latest report is kept on disk so a restart can announce it before the next call.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClaudeUsageLimitError } from "./errors.ts";
import { isRejectedStatus, type RateLimitInfo } from "./limits.ts";

export type UsageWindowKind = "five_hour" | "weekly" | "other";

export interface UsageWindow {
  kind: UsageWindowKind;
  /** 0..100 */
  usedPercent?: number;
  /** ISO timestamp. */
  resetsAt?: string;
  /** True when this window refuses calls right now. */
  limited: boolean;
  /** The CLI's own window name (`five_hour`, `seven_day`, `seven_day_opus`, ...). */
  name?: string;
}

export interface UsageReport {
  windows: UsageWindow[];
  /** `rate_limit_event`, `usage_limit_error`, or `<source> (cached)` after a restart. */
  source: string;
  /** ISO timestamp of the observation. */
  observedAt: string;
}

function kindOf(name: string): UsageWindowKind {
  if (name === "five_hour") return "five_hour";
  if (name === "seven_day" || name === "weekly") return "weekly";
  return "other";
}

const iso = (unixSeconds: number | undefined) =>
  typeof unixSeconds === "number" && Number.isFinite(unixSeconds) && unixSeconds > 0
    ? new Date(unixSeconds * 1000).toISOString()
    : undefined;

const percent = (utilization: number | undefined) =>
  typeof utilization === "number" && Number.isFinite(utilization)
    ? Math.round(Math.min(1, Math.max(0, utilization)) * 1000) / 10
    : undefined;

/** Windows from one `rate_limit_event.rate_limit_info`. */
export function usageFromRateLimit(
  info: RateLimitInfo,
  observedAt: Date,
  source = "rate_limit_event",
): UsageReport | null {
  const rejected = isRejectedStatus(info.status);
  const windows: UsageWindow[] = [];
  const entries = Object.entries(info.unifiedWindows ?? {});
  for (const [name, w] of entries) {
    const usedPercent = percent(w?.utilization);
    const resetsAt = iso(w?.resetsAt);
    windows.push({
      kind: kindOf(name),
      name,
      ...(usedPercent !== undefined ? { usedPercent } : {}),
      ...(resetsAt ? { resetsAt } : {}),
      limited: (rejected && info.rateLimitType === name) || (usedPercent ?? 0) >= 100,
    });
  }
  if (windows.length === 0 && (info.rateLimitType || info.resetsAt)) {
    const name = info.rateLimitType ?? "unknown";
    const resetsAt = iso(info.resetsAt);
    windows.push({
      kind: kindOf(name),
      name,
      ...(resetsAt ? { resetsAt } : {}),
      limited: rejected,
    });
  } else if (rejected && !windows.some((w) => w.limited)) {
    // Refused, but the refusing window is not among the listed ones.
    const resetsAt = iso(info.resetsAt);
    windows.push({
      kind: kindOf(info.rateLimitType ?? "other"),
      name: info.rateLimitType ?? "unknown",
      ...(resetsAt ? { resetsAt } : {}),
      limited: true,
    });
  }
  if (windows.length === 0) return null;
  return { windows, source, observedAt: observedAt.toISOString() };
}

/** Report for a usage-limit error (its rate-limit event when present, else the parsed reset time). */
export function usageFromLimitError(error: ClaudeUsageLimitError, observedAt: Date): UsageReport {
  if (error.rateLimit) {
    const fromEvent = usageFromRateLimit(
      { ...error.rateLimit, status: error.rateLimit.status ?? "rejected" },
      observedAt,
      "usage_limit_error",
    );
    if (fromEvent?.windows.some((w) => w.limited)) return fromEvent;
  }
  const name = error.rateLimit?.rateLimitType ?? "unknown";
  return {
    windows: [
      {
        kind: kindOf(name),
        name,
        resetsAt: error.resetsAt.toISOString(),
        limited: true,
      },
    ],
    source: "usage_limit_error",
    observedAt: observedAt.toISOString(),
  };
}

/** Latest usage, persisted in the state dir; listeners get every update. */
export class UsageTracker {
  private current: UsageReport | null = null;
  private readonly listeners = new Set<(report: UsageReport) => void>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string | null) {}

  /** Load the last report from disk (marked as cached). */
  async load(): Promise<UsageReport | null> {
    if (!this.file || this.current) return this.current;
    try {
      const saved = JSON.parse(await readFile(this.file, "utf8")) as UsageReport;
      if (Array.isArray(saved.windows) && typeof saved.observedAt === "string") {
        this.current = {
          ...saved,
          source: saved.source.endsWith("(cached)") ? saved.source : `${saved.source} (cached)`,
        };
      }
    } catch {
      // nothing saved yet
    }
    return this.current;
  }

  latest(): UsageReport | null {
    return this.current;
  }

  onUpdate(fn: (report: UsageReport) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  update(report: UsageReport | null): void {
    if (!report) return;
    this.current = report;
    for (const fn of this.listeners) fn(report);
    if (this.file) {
      const file = this.file;
      const body = JSON.stringify(report, null, 2);
      this.writing = this.writing
        .then(async () => {
          await mkdir(path.dirname(file), { recursive: true });
          await writeFile(`${file}.tmp`, body);
          await rename(`${file}.tmp`, file);
        })
        .catch(() => undefined);
    }
  }
}
