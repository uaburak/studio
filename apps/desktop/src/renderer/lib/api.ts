// The typed API client of the renderer. HTTP goes to the page's own origin (`/api/…`): the
// Vite dev proxy or the `studio://` protocol forwards it to the local API. WebSockets connect
// straight to ws://127.0.0.1:<apiPort>. The main process adds the app's owner secret to both
// (the page never sees it), which is what makes the API count them as the Mac itself.
import { type ApiClient, createApiClient } from "@studio/contract";
import { createContext, useContext } from "react";

/** ws(s)://<anything>/api/… → ws://127.0.0.1:<port>/api/… */
export function rewriteSocketUrl(url: string, port: number): string {
  const parsed = new URL(url, "http://placeholder");
  return `ws://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
}

export function socketClassFor(port: () => number | null): typeof WebSocket {
  const Base = globalThis.WebSocket;
  return class ApiWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      const p = port() ?? 8790;
      super(rewriteSocketUrl(String(url), p), protocols);
    }
  } as typeof WebSocket;
}

export function createStudioClient(port: () => number | null): ApiClient {
  return createApiClient({ baseUrl: "", WebSocket: socketClassFor(port) });
}

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("ApiContext missing");
  return client;
}

/** `<img src>` of an asset's bytes (same origin). */
export function assetUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}/content`;
}

export function imageUrl(image: { assetId: string; url?: string | undefined }): string {
  return image.url ?? assetUrl(image.assetId);
}

// --- errors in plain Turkish (U12) ---------------------------------------------------------------

/** What each API error code means for the user, and what to do. */
const CODE_MESSAGES: Record<string, string> = {
  validation_error: "Gönderilen bilgilerde bir sorun var; alanları kontrol edip tekrar dene.",
  not_found: "Aranan kayıt bulunamadı; silinmiş olabilir. Sayfayı yenileyip tekrar dene.",
  conflict: "Bu işlem şu anki durumla çakışıyor; sayfayı yenileyip tekrar dene.",
  invalid_transition:
    "Bu adım şu an yapılamaz; durum değişmiş olabilir. Sayfayı yenileyip tekrar dene.",
  hash_mismatch: "Dosya yüklenirken bozuldu; tekrar dene.",
  payload_too_large: "Dosya çok büyük; daha küçük bir dosya dene.",
  unsupported_media_type: "Bu dosya türü desteklenmiyor.",
  unauthorized: "Bu işlem için izin yok; Studio'yu yeniden başlatmayı dene.",
  forbidden: "Bu işlem bu cihazdan yapılamaz.",
  rate_limited: "Çok sık istek gönderildi; biraz bekleyip tekrar dene.",
  internal_error: "Sunucuda beklenmeyen bir hata oldu; biraz sonra tekrar dene.",
  unavailable: "Studio sunucusu hazır değil; biraz bekleyip tekrar dene.",
};

const UNREACHABLE = "Studio sunucusuna ulaşılamadı.";
const GENERIC = "Bir şeyler ters gitti; tekrar dene.";

/** Turkish letters that English server text never has: such a message is already for people. */
const TURKISH = /[çğıöşüÇĞİÖŞÜ]/;

export interface ErrorDescription {
  /** Short, Turkish, says what to do. */
  message: string;
  /** The original text (server or system), for "Ayrıntı"; null when it adds nothing. */
  detail: string | null;
}

function rawMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.replace(/^\/api\/[^:]*: /, "").trim();
}

function codeOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/** The user's message for an error, and the original text for the details. */
export function explainError(error: unknown): ErrorDescription {
  const raw = rawMessage(error);
  const detail = raw && raw !== "undefined" ? raw : null;
  if (/Failed to fetch|NetworkError|Load failed|ECONNREFUSED|fetch failed/i.test(raw)) {
    return { message: UNREACHABLE, detail: null };
  }
  // A message written in Turkish (ours, or the API's own) is shown as it is.
  if (detail && TURKISH.test(detail)) return { message: detail, detail: null };
  const code = codeOf(error);
  if (code && CODE_MESSAGES[code]) return { message: CODE_MESSAGES[code], detail };
  const status = statusOf(error);
  if (status === 503 || status === 502)
    return { message: CODE_MESSAGES.unavailable as string, detail };
  if (status !== undefined && status >= 500) {
    return { message: CODE_MESSAGES.internal_error as string, detail };
  }
  if (/does not match the contract/i.test(raw)) {
    return {
      message: "Sunucunun yanıtı beklenen biçimde değil; Studio'yu güncelleyip tekrar dene.",
      detail,
    };
  }
  return { message: GENERIC, detail };
}

/** A short Turkish message for an error (details: `explainError`). */
export function describeError(error: unknown): string {
  return explainError(error).message;
}
