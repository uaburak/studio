export type GeminiErrorCode = "auth" | "rate_limit" | "transient" | "timeout" | "spawn" | "api";

export class GeminiError extends Error {
  override name = "GeminiError";
  constructor(
    readonly code: GeminiErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isGeminiError(error: unknown): error is GeminiError {
  return error instanceof GeminiError;
}

/** Turkish user-facing explanation of a Gemini failure (never includes API keys). */
export function describeGeminiError(error: GeminiError): string {
  switch (error.code) {
    case "auth":
      return "Gemini kimlik doğrulaması başarısız (.env dosyasındaki GEMINI_API_KEY geçersiz ya da eksik olabilir).";
    case "rate_limit":
      return "Gemini kota / hız sınırına ulaşıldı (HTTP 429). Kısa süre sonra tekrar deneyin ya da farklı bir Gemini modeli seçin.";
    case "transient":
      return "Gemini servisi şu an yanıt veremiyor (geçici ağ veya sunucu hatası). Kısa süre sonra yeniden denenecek.";
    case "timeout":
      return "Gemini çağrısı zaman aşımına uğradı.";
    case "spawn":
      return "Mac'te `gemini` CLI komutu çalıştırılamadı. `.env` dosyasına `GEMINI_API_KEY` ekleyin veya Gemini CLI kurun.";
    default:
      return `Gemini çağrısı başarısız oldu: ${error.message.slice(0, 300)}`;
  }
}
