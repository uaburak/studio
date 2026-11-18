export type GeminiErrorCode =
  | "auth"
  | "rate_limit"
  | "transient"
  | "timeout"
  | "spawn"
  /** The structured output is missing or is not valid JSON (worth asking again once). */
  | "output"
  | "api";

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
      return "Gemini anahtarı kabul edilmedi. Ayarlar → Yapay zekâ'dan anahtarı yeniden girin.";
    case "rate_limit":
      return "Gemini kota / hız sınırına ulaşıldı (birkaç kez bekleyip denendi). Biraz sonra yeniden deneyin ya da Google AI Studio'da kotanızı kontrol edin.";
    case "output":
      return "Gemini'nin yanıtı beklenen biçimde değildi. Yeniden deneyin.";
    case "transient":
      return "Gemini servisi şu an yanıt veremiyor (geçici ağ veya sunucu hatası). Kısa süre sonra yeniden denenecek.";
    case "timeout":
      return "Gemini çağrısı zaman aşımına uğradı.";
    case "spawn":
      return "Mac'te `gemini` CLI komutu çalıştırılamadı. `.env` dosyasına `GEMINI_API_KEY` ekleyin veya Gemini CLI kurun.";
    default:
      return "Gemini çağrısı başarısız oldu. Yeniden deneyin; sürerse başka bir model seçin.";
  }
}
