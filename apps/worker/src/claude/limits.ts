/**
 * Classifies a failed headless call: usage limit (park until the window resets),
 * auth (needs a human), transient (retry soon) or anything else.
 */
import type { ClaudeErrorCode } from "./errors.ts";

/** `rate_limit_event.rate_limit_info` as the CLI emits it (fields we use; all optional). */
export interface RateLimitInfo {
  /** `allowed`, `allowed_warning`, `rejected`, ... */
  status?: string;
  /** Unix seconds. */
  resetsAt?: number;
  rateLimitType?: string;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number }>;
}

export interface FailureInput {
  /** `result.result` text of an error result (or ""). */
  resultText: string;
  stderr: string;
  /** Error kinds the CLI attached to assistant messages (`"rate_limit"`, `"authentication_failed"`, ...). */
  assistantErrors: readonly string[];
  /** Texts of assistant messages that carried an error (they hold "API Error: ..." lines). */
  assistantErrorTexts: readonly string[];
  rateLimit: RateLimitInfo | undefined;
  now: Date;
  /** Used when a usage limit is detected but no reset time is known. */
  fallbackResetMs: number;
}

export interface FailureClass {
  code: Exclude<ClaudeErrorCode, "output" | "timeout" | "spawn">;
  message: string;
  resetsAt?: Date;
  resetSource?: "rate_limit_event" | "message" | "fallback";
}

const AUTH =
  /not logged in|please run \/login|\/login|invalid api key|oauth token (?:has )?(?:expired|revoked)|authentication[_ ]failed|authentication_error|invalid (?:x-api-key|bearer token)|unauthori[sz]ed|\b401\b|token (?:has )?expired|credentials? (?:are |is )?(?:missing|invalid)/i;
const USAGE =
  /usage limit|limit reached|hit your (?:\w+[ -])?limit|session limit|weekly limit|5-hour limit|five[_ ]hour|limit will reset|limit resets|resets? (?:at )?\d|out of (?:usage|extra usage|credits)|rate[_ ]limit|\b429\b/i;
const TRANSIENT =
  /overloaded|\b529\b|\b50[0234]\b|internal server error|api_error|service unavailable|bad gateway|econnreset|etimedout|econnrefused|enotfound|socket hang up|fetch failed|network error|connection error|request timed out/i;

/** Rate-limit statuses that mean "this request was refused". `allowed_warning` is only a warning. */
export function isRejectedStatus(status: string | undefined): boolean {
  return status !== undefined && /reject|exceed|block|denied/i.test(status);
}

export function classifyFailure(input: FailureInput): FailureClass {
  const text = [
    input.resultText,
    ...input.assistantErrorTexts,
    input.stderr,
    input.assistantErrors.join(" "),
  ]
    .filter(Boolean)
    .join("\n");
  const short =
    firstLine(input.resultText) ||
    firstLine(input.assistantErrorTexts[0] ?? "") ||
    firstLine(input.stderr);

  if (input.assistantErrors.some((e) => /auth/i.test(e)) || AUTH.test(text)) {
    return { code: "auth", message: short || "not logged in" };
  }
  const rejected = isRejectedStatus(input.rateLimit?.status);
  if (rejected || input.assistantErrors.includes("rate_limit") || USAGE.test(text)) {
    const reset = resetTime(input, text);
    return { code: "usage_limit", message: short || "usage limit reached", ...reset };
  }
  if (
    TRANSIENT.test(text) ||
    input.assistantErrors.some((e) => /overload|server|unknown/i.test(e))
  ) {
    return { code: "transient", message: short || "transient API error" };
  }
  return { code: "process", message: short || "claude reported an error" };
}

function resetTime(
  input: FailureInput,
  text: string,
): { resetsAt: Date; resetSource: "rate_limit_event" | "message" | "fallback" } {
  const nowMs = input.now.getTime();
  const fromEvent = input.rateLimit?.resetsAt;
  if (fromEvent && fromEvent * 1000 > nowMs) {
    return { resetsAt: new Date(fromEvent * 1000), resetSource: "rate_limit_event" };
  }
  const fromText = parseResetFromText(text, input.now);
  if (fromText && fromText.getTime() > nowMs) return { resetsAt: fromText, resetSource: "message" };
  return { resetsAt: new Date(nowMs + input.fallbackResetMs), resetSource: "fallback" };
}

/**
 * Reset time in a limit message:
 * - `Claude AI usage limit reached|1794845400` (Unix seconds),
 * - `resets 7pm`, `resets 7:30pm`, `resets at 19:40`, `resets 19.40` (next such local time).
 */
export function parseResetFromText(text: string, now: Date): Date | null {
  const epoch = /\|\s*(\d{10})\b/.exec(text) ?? /resets?(?:_at|At)?["':\s]+(\d{10})\b/.exec(text);
  if (epoch?.[1]) return new Date(Number(epoch[1]) * 1000);
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!clock?.[1]) return null;
  let hour = Number(clock[1]);
  const minute = Number(clock[2] ?? 0);
  const meridiem = clock[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  const candidate = new Date(now);
  candidate.setHours(hour, minute, 0, 0);
  if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
  return candidate;
}

function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .find(Boolean)
      ?.slice(0, 500) ?? ""
  );
}
