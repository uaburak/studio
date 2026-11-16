/**
 * Subscription usage without spending any (A5): `claude -p /usage` is the CLI's local
 * command — no model call, no turn (`num_turns: 0`, `total_cost_usd: 0`, `local_command:
 * "usage"`; checked on this Mac with CLI 2.1.292). Its text lists the plan's windows:
 *
 *   Current session: 100% used · resets Nov 16 at 7:10pm (Europe/Istanbul)
 *   Current week (all models): 49% used · resets Nov 18 at 2pm (Europe/Istanbul)
 *   Current week (Fable): 32% used · resets Nov 18 at 2pm (Europe/Istanbul)
 *
 * (parsed like Wecra's `parseClaudeUsage`). The worker reads it at startup and after
 * each chat turn (at most once a minute) and merges it with the live `rate_limit_event`
 * windows of its calls; the result goes to the hub as `worker.usage`.
 */
import { execFile } from "node:child_process";
import type { Logger } from "../log.ts";
import { silentLogger } from "../log.ts";
import type { UsageReport, UsageTracker, UsageWindow } from "./usage.ts";

export const USAGE_COMMAND_ARGS = [
  "-p",
  "/usage",
  "--output-format",
  "json",
  "--no-session-persistence",
  "--strict-mcp-config",
  "--tools",
  "",
  // No user settings: a user's SessionEnd hook would otherwise run on every read.
  "--setting-sources",
  "",
];

export const USAGE_SOURCE = "claude -p /usage";

const LINE = /^\s*([^:\n]{2,60}):\s*(\d{1,3}(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Window name and kind from the CLI's label ("Current session", "Current week (Fable)"). */
export function windowOfLabel(label: string): Pick<UsageWindow, "kind" | "name"> {
  const l = label.trim().toLowerCase();
  if (/session|5[- ]?hour/.test(l)) return { kind: "five_hour", name: "five_hour" };
  const week = /week(?:ly)?\s*(?:\(([^)]*)\))?/.exec(l);
  if (week) {
    const scope = (week[1] ?? "").trim();
    if (!scope || /all models/.test(scope)) return { kind: "weekly", name: "seven_day" };
    const slug = scope.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    return { kind: "other", name: `seven_day_${slug}` };
  }
  return { kind: "other", name: l.replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "other" };
}

/** Offset (ms) of `timeZone` from UTC at `date`. */
function zoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * "Nov 16 at 7:10pm (Europe/Istanbul)", "Nov 18 at 2pm (Europe/Istanbul)" or
 * "7pm (Europe/Istanbul)" -> the instant. Null when it cannot be read.
 */
export function parseResetText(text: string, now: Date): Date | null {
  const m =
    /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?\s*$/i.exec(
      text.trim(),
    );
  if (!m) return null;
  let hour = Number(m[4]);
  const minute = Number(m[5] ?? 0);
  const meridiem = m[6]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const zone = m[7]?.trim();
  const tz = zone && isZone(zone) ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offsetNow = zoneOffsetMs(now, tz);
  const local = new Date(now.getTime() + offsetNow);
  let year = m[3] ? Number(m[3]) : local.getUTCFullYear();
  let month = local.getUTCMonth();
  let day = local.getUTCDate();
  if (m[1]) {
    const idx = MONTHS.indexOf(m[1].toLowerCase());
    if (idx < 0) return null;
    month = idx;
    day = Number(m[2]);
  }
  const at = (y: number) => {
    const guess = Date.UTC(y, month, day, hour, minute);
    const first = guess - zoneOffsetMs(new Date(guess), tz);
    return first - (zoneOffsetMs(new Date(first), tz) - zoneOffsetMs(new Date(guess), tz));
  };
  let instant = at(year);
  if (!m[1] && instant <= now.getTime()) instant += 86_400_000; // "7pm": the next one
  if (m[1] && !m[3] && instant < now.getTime() - 2 * 86_400_000) instant = at(++year);
  return new Date(instant);
}

function isZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** `claude -p /usage --output-format json` stdout -> windows; null when it said nothing usable. */
export function parseUsageCommandOutput(stdout: string, now: Date): UsageReport | null {
  let out: {
    local_command?: string;
    result?: unknown;
    is_error?: boolean;
    num_turns?: number;
    total_cost_usd?: number;
  };
  try {
    out = JSON.parse(stdout) as typeof out;
  } catch {
    return null;
  }
  if (out.local_command !== "usage" || out.is_error || typeof out.result !== "string") return null;
  const windows: UsageWindow[] = [];
  for (const line of out.result.split("\n")) {
    const m = LINE.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const usedPercent = Math.min(100, Math.round(Number(m[2]) * 10) / 10);
    const resetsAt = m[3] ? parseResetText(m[3], now) : null;
    const { kind, name } = windowOfLabel(m[1]);
    if (windows.some((w) => w.name === name)) continue;
    windows.push({
      kind,
      ...(name ? { name } : {}),
      usedPercent,
      ...(resetsAt ? { resetsAt: resetsAt.toISOString() } : {}),
      limited: usedPercent >= 100,
    });
  }
  return windows.length > 0
    ? { windows, source: USAGE_SOURCE, observedAt: now.toISOString() }
    : null;
}

/**
 * Newer windows replace older ones with the same name; windows the newer report does not
 * mention are kept (a call's rate-limit event has no per-model week, `/usage` does).
 */
export function mergeUsage(previous: UsageReport | null, next: UsageReport): UsageReport {
  if (!previous) return next;
  const key = (w: UsageWindow) => w.name ?? w.kind;
  const names = new Set(next.windows.map(key));
  const kept = previous.windows
    .filter((w) => !names.has(key(w)))
    .map((w) => {
      // A reset time that already passed means that window starts over.
      if (w.resetsAt && Date.parse(w.resetsAt) <= Date.parse(next.observedAt)) {
        return { ...w, limited: false };
      }
      return w;
    });
  return { ...next, windows: [...next.windows, ...kept].slice(0, 16) };
}

/** Run `claude -p /usage` (allow-listed env) and parse it. */
export function readCliUsage(options: {
  bin: string;
  env: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  now?: () => Date;
}): Promise<UsageReport | null> {
  return new Promise((resolve) => {
    execFile(
      options.bin,
      USAGE_COMMAND_ARGS,
      {
        env: options.env,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        timeout: options.timeoutMs ?? 20_000,
        maxBuffer: 2_000_000,
      },
      (error, stdout) => {
        if (error && !stdout) {
          resolve(null);
          return;
        }
        resolve(parseUsageCommandOutput(String(stdout), (options.now ?? (() => new Date()))()));
      },
    );
  });
}

/** `/usage` at most once per `minIntervalMs` (≥ 60 s), merged into the tracker. */
export class UsagePoller {
  private lastRun: number | undefined;
  private running: Promise<UsageReport | null> | undefined;
  private readonly logger: Logger;

  constructor(
    private readonly options: {
      read: () => Promise<UsageReport | null>;
      tracker: UsageTracker;
      minIntervalMs?: number;
      logger?: Logger;
      now?: () => number;
    },
  ) {
    this.logger = options.logger ?? silentLogger;
  }

  /** Read now unless the last read is younger than the interval. */
  refresh(): Promise<UsageReport | null> {
    const now = (this.options.now ?? Date.now)();
    const interval = Math.max(60_000, this.options.minIntervalMs ?? 60_000);
    if (this.running) return this.running;
    if (this.lastRun !== undefined && now - this.lastRun < interval) {
      return Promise.resolve(this.options.tracker.latest());
    }
    this.lastRun = now;
    this.running = (async () => {
      try {
        const report = await this.options.read();
        if (report) {
          this.options.tracker.merge(report);
          this.logger.debug(
            `claude /usage: ${report.windows.map((w) => `${w.name ?? w.kind} ${w.usedPercent ?? "?"}%`).join(", ")}`,
          );
        }
        return report;
      } catch (error) {
        this.logger.debug(`claude /usage failed: ${(error as Error).message}`);
        return null;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }
}
