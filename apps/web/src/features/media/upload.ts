import { type AssetKind, type AssetMimeRule, assetMimeRule } from "@studio/contract";
import { formatBytes } from "../../lib/format.ts";

/** Browsers often leave `File.type` empty for fonts; fall back to the extension. */
const EXTENSION_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
};

/** Non-standard aliases some browsers report. */
const MIME_ALIASES: Record<string, string> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/x-m4a": "audio/mp4",
  "application/font-woff": "font/woff",
  "application/font-woff2": "font/woff2",
  "application/x-font-ttf": "font/ttf",
  "application/x-font-otf": "font/otf",
};

export function guessMimeType(file: { name: string; type: string }): string {
  const declared = MIME_ALIASES[file.type] ?? file.type;
  if (declared && assetMimeRule(declared)) return declared;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_MIME[ext] ?? declared;
}

export type FileCheck =
  | { ok: true; mimeType: string; rule: AssetMimeRule; kind: AssetKind }
  | { ok: false; error: string };

/** Mirror the API allow-list and size limits so bad files fail before upload. */
export function checkFile(file: { name: string; type: string; size: number }): FileCheck {
  const mimeType = guessMimeType(file);
  const rule = mimeType ? assetMimeRule(mimeType) : undefined;
  if (!rule) return { ok: false, error: "Desteklenmeyen dosya türü" };
  if (file.size === 0) return { ok: false, error: "Dosya boş" };
  if (file.size > rule.maxBytes)
    return { ok: false, error: `Çok büyük (en fazla ${formatBytes(rule.maxBytes)})` };
  return { ok: true, mimeType, rule, kind: rule.defaultKind };
}

/** Same bytes with a corrected type, so the multipart part carries the right mime. */
export function withMimeType(file: File, mimeType: string): File {
  return file.type === mimeType ? file : new File([file], file.name, { type: mimeType });
}

export interface MediaMetadata {
  width?: number;
  height?: number;
  durationMs?: number;
}

/** Measure images / videos / audio in the browser; the API does not decode media. */
export async function readMediaMetadata(file: File, mimeType: string): Promise<MediaMetadata> {
  const url = URL.createObjectURL(file);
  try {
    if (mimeType.startsWith("image/")) {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img.naturalWidth && img.naturalHeight
        ? { width: img.naturalWidth, height: img.naturalHeight }
        : {};
    }
    if (mimeType.startsWith("video/") || mimeType.startsWith("audio/")) {
      const el = document.createElement(mimeType.startsWith("video/") ? "video" : "audio");
      el.preload = "metadata";
      el.src = url;
      await new Promise<void>((resolve, reject) => {
        el.onloadedmetadata = () => resolve();
        el.onerror = () => reject(new Error("metadata"));
      });
      const meta: MediaMetadata = {};
      if (Number.isFinite(el.duration) && el.duration > 0)
        meta.durationMs = Math.round(el.duration * 1000);
      if (el instanceof HTMLVideoElement && el.videoWidth && el.videoHeight) {
        meta.width = el.videoWidth;
        meta.height = el.videoHeight;
      }
      return meta;
    }
    return {};
  } catch {
    return {};
  } finally {
    URL.revokeObjectURL(url);
  }
}
