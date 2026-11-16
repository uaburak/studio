import type { RateLimitInfo } from "./limits.ts";

/** Why a headless Claude call failed. */
export type ClaudeErrorCode =
  /** The subscription's usage window is used up; retry after `resetsAt`. */
  | "usage_limit"
  /** Not logged in / token expired or revoked. Needs `claude auth login` on the Mac. */
  | "auth"
  /** Overloaded, 5xx, network: worth retrying soon. */
  | "transient"
  /** The call finished but the structured output is missing or unusable. */
  | "output"
  | "timeout"
  /** The `claude` binary could not be started. */
  | "spawn"
  /** Anything else the CLI reported. */
  | "process";

export class ClaudeError extends Error {
  override name = "ClaudeError";
  constructor(
    readonly code: ClaudeErrorCode,
    message: string,
    readonly details?: { stderr?: string; resultText?: string; exitCode?: number | null },
  ) {
    super(message);
  }
}

export class ClaudeUsageLimitError extends ClaudeError {
  override name = "ClaudeUsageLimitError";
  constructor(
    message: string,
    /** When the window resets (best estimate). */
    readonly resetsAt: Date,
    /** Where `resetsAt` came from: the CLI's rate-limit event, the message text, or a fallback guess. */
    readonly resetSource: "rate_limit_event" | "message" | "fallback",
    details?: ClaudeError["details"],
    /** The CLI's rate-limit event of the refused call, when it sent one (usage windows). */
    readonly rateLimit?: RateLimitInfo,
  ) {
    super("usage_limit", message, details);
  }
}

export function isClaudeError(error: unknown): error is ClaudeError {
  return error instanceof ClaudeError;
}

/** Turkish, user-facing explanation of a Claude failure (shown in chat and job errors). */
export function describeClaudeError(error: ClaudeError): string {
  switch (error.code) {
    case "auth":
      return "Claude oturumu yok ya da süresi doldu. Mac'te bir terminalde `claude auth login` çalıştırın, sonra tekrar deneyin.";
    case "usage_limit":
      return `Claude kullanım sınırı doldu; ${formatClock((error as ClaudeUsageLimitError).resetsAt)} civarında sıfırlanıyor.`;
    case "transient":
      return "Claude şu an yanıt veremiyor (yoğunluk ya da ağ hatası). Kısa süre sonra yeniden denenecek.";
    case "timeout":
      return "Claude çağrısı zaman aşımına uğradı.";
    case "output":
      return "Claude'un yanıtı beklenen biçimde değildi.";
    case "spawn":
      return "Mac'te `claude` komutu çalıştırılamadı (kurulu ve PATH'te mi?).";
    default:
      return `Claude çağrısı başarısız oldu: ${error.message.slice(0, 300)}`;
  }
}

/** `17:40` (or `18 Kas 17:40` when not today), Europe/Istanbul. */
export function formatClock(date: Date, now: Date = new Date()): string {
  const tz = "Europe/Istanbul";
  const day = (d: Date) => d.toLocaleDateString("tr-TR", { timeZone: tz });
  const time = date.toLocaleTimeString("tr-TR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
  });
  if (day(date) === day(now)) return time;
  const dateText = date.toLocaleDateString("tr-TR", {
    timeZone: tz,
    day: "numeric",
    month: "short",
  });
  return `${dateText} ${time}`;
}
