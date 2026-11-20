// Turning API responses into MCP tool results: secrets redacted, the owner secret scrubbed,
// large JSON cut into pages (`response_offset`), binary bodies saved to a temp file.
import type { StudioResponse } from "./client.ts";
import { saveBinary } from "./files.ts";
import { redact, redactText } from "./safety.ts";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  [key: string]: unknown;
}

/** Characters of JSON returned per call; the rest is read with `response_offset`. */
export const MAX_RESULT_CHARS = 40_000;
/** Images up to this size are also returned inline as MCP image content. */
export const MAX_INLINE_IMAGE_BYTES = 1024 * 1024;

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export type Scrub = (text: string) => string;

export function textResult(text: string, isError = false): ToolResult {
  return isError
    ? { content: [{ type: "text", text }], isError }
    : { content: [{ type: "text", text }] };
}

/** Redacted, scrubbed JSON text, cut at `offset` + MAX_RESULT_CHARS with a note on how to go on. */
export function jsonText(value: unknown, scrub: Scrub, offset = 0): string {
  const full = scrub(JSON.stringify(redact(value)));
  if (full.length <= MAX_RESULT_CHARS && offset === 0) return full;
  const start = Math.min(Math.max(0, Math.floor(offset)), full.length);
  const end = Math.min(start + MAX_RESULT_CHARS, full.length);
  const chunk = full.slice(start, end);
  const note =
    end < full.length
      ? `\n\n[Yanıt kesildi: ${start}-${end} / ${full.length} karakter. Devamı için aynı çağrıyı ` +
        `response_offset=${end} ile yapın; listelerde limit / cursor da kullanılabilir. ` +
        `(Truncated: call again with response_offset=${end}, or page with limit / cursor.)]`
      : `\n\n[Yanıtın son bölümü: ${start}-${end} / ${full.length} karakter.]`;
  return chunk + note;
}

export function jsonResult(value: unknown, scrub: Scrub, offset = 0, isError = false): ToolResult {
  return textResult(jsonText(value, scrub, offset), isError);
}

/** One API response as a tool result (HTTP errors become `isError` results with the body). */
export function responseResult(
  res: StudioResponse,
  scrub: Scrub,
  options: { offset?: number; hint: string; tmpDir?: string },
): ToolResult {
  const isError = res.status >= 400;
  if (res.bytes) {
    const mime = res.contentType.split(";")[0]?.trim() ?? "";
    const file = saveBinary(res.bytes, mime, options.hint, options.tmpDir);
    const content: ToolContent[] = [
      {
        type: "text",
        text: `HTTP ${res.status}: ${mime || "binary"} ${res.bytes.length} bayt, kaydedildi (saved to): ${file}`,
      },
    ];
    if (!isError && INLINE_IMAGE_TYPES.has(mime) && res.bytes.length <= MAX_INLINE_IMAGE_BYTES) {
      content.push({
        type: "image",
        data: Buffer.from(res.bytes).toString("base64"),
        mimeType: mime,
      });
    }
    return isError ? { content, isError } : { content };
  }
  if (res.json !== undefined) {
    const value = isError ? { httpStatus: res.status, error: res.json } : res.json;
    return jsonResult(value, scrub, options.offset ?? 0, isError);
  }
  if (res.status === 204 || !res.text) {
    return textResult(`HTTP ${res.status}${isError ? "" : " (tamam / ok)"}`, isError);
  }
  return jsonResult(
    { httpStatus: res.status, text: scrub(redactText(res.text)) },
    scrub,
    options.offset ?? 0,
    isError,
  );
}
