/**
 * How a failed engagement call (insights, comments) is handled. Unlike publishing nothing is
 * resumed: a sync reads again later. What matters is whether to stop for this account (token,
 * permission, rate limit), skip one object (deleted) or try again next round.
 */

import { GraphError } from "../errors.ts";
import { redact } from "../redact.ts";

export type EngagementErrorKind =
  /** The media / post / comment no longer exists (deleted on the platform). */
  | "deleted"
  /** The token lacks a permission (`instagram_manage_insights`, `pages_read_engagement` …). */
  | "permission"
  /** The token is invalid or expired: reconnect the account. */
  | "auth"
  /** Meta's request limit: wait `retryAfterMs` (or a default) before the next call. */
  | "rate_limit"
  /** Network, 5xx, transient Meta errors: try again next round. */
  | "transient"
  /** Meta refused the request (an unsupported metric, a bad parameter). */
  | "invalid"
  | "other";

export interface EngagementError {
  kind: EngagementErrorKind;
  /** Turkish, user-presentable, redacted. */
  message: string;
  retryAfterMs: number | null;
  /** Meta's code / subcode, when it was a Graph error. */
  code: number | null;
  subcode: number | null;
}

/** Default wait after a rate limit Meta did not time (15 minutes). */
export const RATE_LIMIT_DEFAULT_WAIT_MS = 15 * 60_000;

const MESSAGES: Record<EngagementErrorKind, string> = {
  deleted: "Gönderi platformda bulunamadı (silinmiş olabilir).",
  permission:
    "Hesabın bu bilgi için izni yok; hesabı yeniden bağlayıp istatistik ve yorum izinlerini onaylayın.",
  auth: "Hesabın erişim izni geçersiz ya da süresi dolmuş; hesabı yeniden bağlayın.",
  rate_limit: "Meta istek sınırına ulaşıldı; biraz sonra yeniden denenecek.",
  transient: "Meta'ya ulaşılamadı; bir sonraki eşitlemede yeniden denenecek.",
  invalid: "Meta isteği geçersiz buldu.",
  other: "Meta beklenmeyen bir hata döndürdü.",
};

/** True for "object does not exist" answers (code 100 / subcode 33, or IG's media errors). */
export function isMissingObject(err: GraphError): boolean {
  const { code, subcode, message } = err.info;
  if (code === 100 && subcode === 33) return true;
  return code === 100 && /does not exist|cannot be loaded|not available/i.test(message);
}

/** An account-level failure inside a read that otherwise reports per object (stop for the account). */
export class EngagementCallError extends Error {
  override readonly name = "EngagementCallError";
  constructor(readonly error: EngagementError) {
    super(error.message);
  }
}

export function classifyEngagementError(
  err: unknown,
  secrets: readonly (string | undefined)[] = [],
): EngagementError {
  if (err instanceof EngagementCallError) return err.error;
  if (!(err instanceof GraphError)) {
    const detail = redact(err instanceof Error ? err.message : String(err), secrets);
    return {
      kind: "other",
      message: `${MESSAGES.other} (${detail.slice(0, 200)})`,
      retryAfterMs: null,
      code: null,
      subcode: null,
    };
  }
  const info = err.info;
  let kind: EngagementErrorKind;
  if (isMissingObject(err)) kind = "deleted";
  else
    switch (info.category) {
      case "rate_limit":
        kind = "rate_limit";
        break;
      case "auth":
        kind = "auth";
        break;
      case "permission":
        kind = "permission";
        break;
      case "transient":
      case "network":
      case "not_ready":
        kind = "transient";
        break;
      case "invalid_request":
      case "media":
        kind = "invalid";
        break;
      default:
        kind = "other";
    }
  return {
    kind,
    message: MESSAGES[kind],
    retryAfterMs:
      kind === "rate_limit" ? (info.retryAfterMs ?? RATE_LIMIT_DEFAULT_WAIT_MS) : info.retryAfterMs,
    code: info.code,
    subcode: info.subcode,
  };
}
