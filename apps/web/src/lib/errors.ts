import { ApiError, type ErrorCode } from "@studio/contract";

export interface ErrorView {
  title: string;
  /** Server-provided detail (English, technical) — shown smaller. */
  detail?: string;
  /** Per-field problems for validation errors. */
  issues?: { path: string; message: string }[];
  code?: ErrorCode;
  /** True for 409-family errors: the data changed or the state forbids the action. */
  conflict: boolean;
}

const TITLES: Record<ErrorCode, string> = {
  validation_error: "Girilen bilgiler geçersiz",
  not_found: "Kayıt bulunamadı",
  conflict: "İşlem şu anki durumla çakışıyor",
  invalid_transition: "Bu durum değişikliğine izin verilmiyor",
  hash_mismatch: "Sürüm değişti — onaylamak istediğiniz sürüm artık güncel değil",
  payload_too_large: "Dosya ya da veri çok büyük",
  unsupported_media_type: "Desteklenmeyen dosya türü",
  internal_error: "Sunucuda beklenmeyen bir hata oluştu",
};

const CONFLICT_CODES: ErrorCode[] = ["conflict", "invalid_transition", "hash_mismatch"];

/** ApiError messages are prefixed with the request path ("/api/x: message"). */
function stripPath(message: string): string {
  return message.replace(/^\/api\/\S*?:\s*/, "");
}

/** Map any thrown value to Turkish UI copy. */
export function describeError(error: unknown): ErrorView {
  if (error instanceof ApiError) {
    if (error.code) {
      return {
        title: TITLES[error.code],
        detail: stripPath(error.message),
        ...(error.issues?.length ? { issues: error.issues } : {}),
        code: error.code,
        conflict: CONFLICT_CODES.includes(error.code),
      };
    }
    if (error.status === undefined || error.status >= 500 || error.status === 0) {
      return {
        title: "API'ye ulaşılamıyor",
        detail: stripPath(error.message),
        conflict: false,
      };
    }
    return {
      title: `Beklenmeyen yanıt (HTTP ${error.status})`,
      detail: stripPath(error.message),
      conflict: error.status === 409,
    };
  }
  if (error instanceof TypeError) {
    return {
      title: "API'ye ulaşılamıyor",
      detail: "Ağ bağlantısını ya da yerel API sunucusunu kontrol edin.",
      conflict: false,
    };
  }
  return {
    title: "Bir şeyler ters gitti",
    detail: error instanceof Error ? error.message : String(error),
    conflict: false,
  };
}

export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "not_found" || error.status === 404);
}
