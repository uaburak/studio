/**
 * Error model.
 *
 * - `GraphError`: a failed Graph API call, with Meta's fields parsed
 *   (code, subcode, is_transient, fbtrace_id) and a coarse category.
 * - `PublishError`: what a publisher reports to its caller. It carries a
 *   stable machine `code`, a Turkish user-presentable `message`, and a
 *   suggested `action` so the scheduler and UI can react without parsing text.
 *
 * Every message is redacted before it is stored; tokens never appear here.
 */

import { redact } from "./redact.ts";

export type GraphErrorCategory =
  | "rate_limit"
  | "auth"
  | "permission"
  | "transient"
  | "publish_limit"
  | "spam_block"
  | "duplicate"
  | "media"
  | "not_ready"
  | "container_expired"
  | "account_restricted"
  | "invalid_request"
  | "network"
  | "unknown";

export interface GraphErrorInfo {
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
  type: string | null;
  /** Developer-facing message from Meta (redacted). */
  message: string;
  /** Localised title/message Meta suggests showing the user, if any. */
  userTitle: string | null;
  userMessage: string | null;
  fbtraceId: string | null;
  isTransient: boolean;
  category: GraphErrorCategory;
  /** How long Meta asks us to wait, when it says so (rate-limit headers, Retry-After). */
  retryAfterMs: number | null;
  /** Method and path (no query string, no token) of the failed call. */
  request: string;
}

export class GraphError extends Error {
  override readonly name = "GraphError";
  readonly info: GraphErrorInfo;

  constructor(info: GraphErrorInfo) {
    super(
      `Graph API error ${info.code ?? info.httpStatus ?? "network"}${
        info.subcode ? `/${info.subcode}` : ""
      } on ${info.request}: ${info.message}`,
    );
    this.info = info;
  }

  toJSON(): GraphErrorInfo {
    return this.info;
  }
}

/** Codes from https://developers.facebook.com/docs/graph-api/overview/rate-limiting */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const isBucCode = (code: number) => code >= 80000 && code <= 80014;
/** Access-token subcodes from https://developers.facebook.com/docs/graph-api/guides/error-handling */
const TOKEN_SUBCODES = new Set([458, 459, 460, 463, 464, 467, 492]);
/** Instagram subcodes Meta documents as "retry". */
const IG_RETRY_SUBCODES = new Set([2207001, 2207003, 2207032]);
/** Instagram subcodes that mean "create a new container and retry". */
const IG_RECREATE_SUBCODES = new Set([2207020, 2207053, 2207006]);
const IG_MEDIA_SUBCODES = new Set([
  2207004, 2207005, 2207009, 2207010, 2207023, 2207026, 2207028, 2207035, 2207036, 2207037, 2207040,
  2207052, 2207057,
]);

export function classifyGraphError(e: {
  httpStatus: number | null;
  code: number | null;
  subcode: number | null;
  isTransient: boolean;
}): GraphErrorCategory {
  const { code, subcode, httpStatus } = e;
  if (code === null && httpStatus === null) return "network";
  if (code !== null && (RATE_LIMIT_CODES.has(code) || isBucCode(code))) return "rate_limit";
  if (code === 9 || subcode === 2207042) return "publish_limit";
  if (code === 190 || code === 102 || (subcode !== null && TOKEN_SUBCODES.has(subcode)))
    return "auth";
  if (code === 10 || code === 3 || (code !== null && code >= 200 && code <= 299))
    return "permission";
  if (code === 368 || subcode === 2207051) return "spam_block";
  if (code === 506) return "duplicate";
  if (code === 25 || subcode === 2207050) return "account_restricted";
  if (code === 9007 || subcode === 2207027) return "not_ready";
  if (subcode !== null && IG_RECREATE_SUBCODES.has(subcode)) return "container_expired";
  if (subcode === 2207008) return "transient";
  if (subcode !== null && IG_RETRY_SUBCODES.has(subcode)) return "transient";
  if (subcode !== null && IG_MEDIA_SUBCODES.has(subcode)) return "media";
  if (code !== null && [36000, 36001, 36003, 36004, 352, 9004].includes(code)) return "media";
  if (e.isTransient || code === 1 || code === 2 || code === 341) return "transient";
  if (httpStatus !== null && (httpStatus >= 500 || httpStatus === 429)) return "transient";
  if (code === 100) return "invalid_request";
  return "unknown";
}

// --- PublishError --------------------------------------------------------------

/** What the caller should do about a failure. */
export type PublishErrorAction =
  /** Try again later; the state machine resumes where it stopped. */
  | "retry"
  /** The account must be reconnected (token expired/revoked or scope missing). */
  | "reauth"
  /** The content itself must change (format, size, caption...). */
  | "fix_content"
  /** The daily publishing quota is used up; resume after it frees up. */
  | "wait_quota"
  /** A human must look (account restricted, spam block, uncertain publish). */
  | "manual_check";

export type PublishErrorCode =
  | "VALIDATION_FAILED"
  | "RATE_LIMITED"
  | "TOKEN_INVALID"
  | "PERMISSION_MISSING"
  | "TRANSIENT"
  | "QUOTA_EXCEEDED"
  | "BLOCKED_AS_SPAM"
  | "DUPLICATE_POST"
  | "MEDIA_REJECTED"
  | "CONTAINER_EXPIRED"
  | "CONTAINER_FAILED"
  | "PROCESSING_TIMEOUT"
  | "ACCOUNT_RESTRICTED"
  | "INVALID_REQUEST"
  | "MEDIA_SOURCE_MISSING"
  | "UPLOAD_FAILED"
  | "PUBLISH_UNCERTAIN"
  | "INVALID_STATE"
  | "GRAPH_ERROR";

/** JSON-serialisable error, safe to persist in workflow state and show in UI. */
export interface PublishErrorData {
  code: PublishErrorCode;
  /** Turkish, user-presentable. */
  message: string;
  action: PublishErrorAction;
  retryable: boolean;
  retryAfterMs: number | null;
  graph: GraphErrorInfo | null;
  /** Validation issues, when `code === "VALIDATION_FAILED"`. */
  issues?: { code: string; message: string; path: string }[];
  /** Redacted technical detail for unexpected errors. */
  detail?: string;
}

export class PublishError extends Error {
  override readonly name = "PublishError";
  readonly data: PublishErrorData;

  constructor(data: PublishErrorData) {
    super(`${data.code}: ${data.message}`);
    this.data = data;
  }

  get code(): PublishErrorCode {
    return this.data.code;
  }

  toJSON(): PublishErrorData {
    return this.data;
  }
}

export function publishError(
  code: PublishErrorCode,
  message: string,
  extra: Partial<Omit<PublishErrorData, "code" | "message">> = {},
): PublishErrorData {
  const action = extra.action ?? DEFAULT_ACTION[code];
  return {
    code,
    message,
    action,
    retryable: extra.retryable ?? (action === "retry" || action === "wait_quota"),
    retryAfterMs: extra.retryAfterMs ?? null,
    graph: extra.graph ?? null,
    ...(extra.issues ? { issues: extra.issues } : {}),
  };
}

const DEFAULT_ACTION: Record<PublishErrorCode, PublishErrorAction> = {
  VALIDATION_FAILED: "fix_content",
  RATE_LIMITED: "retry",
  TOKEN_INVALID: "reauth",
  PERMISSION_MISSING: "reauth",
  TRANSIENT: "retry",
  QUOTA_EXCEEDED: "wait_quota",
  BLOCKED_AS_SPAM: "manual_check",
  DUPLICATE_POST: "fix_content",
  MEDIA_REJECTED: "fix_content",
  CONTAINER_EXPIRED: "retry",
  CONTAINER_FAILED: "fix_content",
  PROCESSING_TIMEOUT: "retry",
  ACCOUNT_RESTRICTED: "manual_check",
  INVALID_REQUEST: "fix_content",
  MEDIA_SOURCE_MISSING: "fix_content",
  UPLOAD_FAILED: "retry",
  PUBLISH_UNCERTAIN: "manual_check",
  INVALID_STATE: "manual_check",
  GRAPH_ERROR: "manual_check",
};

/** Turkish explanations for Instagram subcodes we can name precisely. */
const IG_SUBCODE_TR: Record<number, string> = {
  2207003: "Instagram medyayı indirirken zaman aşımına uğradı.",
  2207004: "Görsel çok büyük; Instagram en fazla 8 MB kabul ediyor.",
  2207005: "Görsel biçimi desteklenmiyor; Instagram yalnızca JPEG kabul ediyor.",
  2207006: "Medya bulunamadı; izin eksik ya da token süresi dolmuş olabilir.",
  2207008: "Instagram geçici bir yayın hatası verdi.",
  2207009: "Görselin en-boy oranı geçersiz; 4:5 ile 1.91:1 arasında olmalı.",
  2207010:
    "Açıklama çok uzun ya da çok fazla etiket içeriyor (en fazla 2.200 karakter, 30 hashtag, 20 @).",
  2207020: "Medyanın süresi dolmuş; yeniden yüklenmesi gerekiyor.",
  2207023: "Bilinmeyen medya türü.",
  2207026: "Video biçimi desteklenmiyor; MOV ya da MP4 olmalı.",
  2207028: "Carousel öğe sayısı geçersiz.",
  2207040: "Çok fazla @ etiketi var; en fazla 20.",
  2207042: "Günlük Instagram paylaşım sınırına ulaşıldı.",
  2207050:
    "Instagram hesabı kısıtlanmış; Instagram uygulamasına girip istenen adımları tamamlayın.",
  2207051: "Instagram bu işlemi spam şüphesiyle engelledi.",
  2207052: "Instagram medyayı verilen adresten alamadı; adres herkese açık olmalı.",
  2207053: "Bilinmeyen bir yükleme hatası oluştu.",
  2207057: "Kapak karesi (thumb_offset) video süresinin içinde olmalı.",
};

const CATEGORY_TO_CODE: Record<GraphErrorCategory, PublishErrorCode> = {
  rate_limit: "RATE_LIMITED",
  auth: "TOKEN_INVALID",
  permission: "PERMISSION_MISSING",
  transient: "TRANSIENT",
  network: "TRANSIENT",
  publish_limit: "QUOTA_EXCEEDED",
  spam_block: "BLOCKED_AS_SPAM",
  duplicate: "DUPLICATE_POST",
  media: "MEDIA_REJECTED",
  not_ready: "TRANSIENT",
  container_expired: "CONTAINER_EXPIRED",
  account_restricted: "ACCOUNT_RESTRICTED",
  invalid_request: "INVALID_REQUEST",
  unknown: "GRAPH_ERROR",
};

const CATEGORY_TR: Record<GraphErrorCategory, string> = {
  rate_limit: "Meta istek sınırına ulaşıldı; biraz sonra yeniden denenecek.",
  auth: "Hesabın erişim izni geçersiz ya da süresi dolmuş; hesabı yeniden bağlayın.",
  permission:
    "Uygulamanın bu işlem için gerekli izni yok; hesabı yeniden bağlayıp izinleri onaylayın.",
  transient: "Meta tarafında geçici bir hata oluştu; yeniden denenecek.",
  network: "Meta'ya bağlanılamadı; yeniden denenecek.",
  publish_limit: "Günlük paylaşım sınırına ulaşıldı.",
  spam_block: "Meta bu paylaşımı spam şüphesiyle engelledi.",
  duplicate: "Aynı içerik art arda paylaşılamaz; içeriği değiştirin.",
  media: "Meta medyayı kabul etmedi.",
  not_ready: "Medya henüz yayına hazır değil.",
  container_expired: "Yükleme kabının süresi doldu; yeniden oluşturulacak.",
  account_restricted: "Hesap kısıtlanmış; platform uygulamasına girip istenen adımları tamamlayın.",
  invalid_request: "Meta isteği geçersiz buldu.",
  unknown: "Meta beklenmeyen bir hata döndürdü.",
};

/** Convert a GraphError into a user-presentable PublishErrorData. */
export function fromGraphError(err: GraphError): PublishErrorData {
  const info = err.info;
  const code = CATEGORY_TO_CODE[info.category];
  const subcodeText = info.subcode !== null ? IG_SUBCODE_TR[info.subcode] : undefined;
  const message = subcodeText ?? CATEGORY_TR[info.category];
  return publishError(code, message, {
    graph: info,
    retryAfterMs: info.retryAfterMs,
  });
}

/**
 * Normalise anything thrown inside a step into PublishErrorData. Unknown
 * errors keep a redacted `detail` for debugging.
 */
export function toPublishError(
  err: unknown,
  secrets: Iterable<string | undefined> = [],
): PublishErrorData {
  if (err instanceof PublishError) return err.data;
  if (err instanceof GraphError) return fromGraphError(err);
  const detail = redact(
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    secrets,
  );
  return {
    ...publishError("GRAPH_ERROR", "Beklenmeyen bir hata oluştu.", { action: "manual_check" }),
    detail,
  };
}
