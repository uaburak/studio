// Local files: what an upload tool may read, and where binary responses are written.
//
// Uploads read only regular files inside the user's home folder, with a media extension Studio
// accepts, below the size limit, never from hidden folders (`.ssh`, `.config` …) or ~/Library
// (Studio's own secrets live there). Symlinks are followed first and the target is checked.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Largest upload Studio accepts (video / audio / PDF; images are 20 MiB). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** apps/contract ASSET_MIME_RULES by extension. */
export const UPLOAD_MIME_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".wecra": "application/vnd.wecra.document+zip",
};

export class FileRefused extends Error {}

export interface UploadFile {
  path: string;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Checks and reads a file the agent wants to upload. */
export function readUploadFile(
  input: string,
  options: { home?: string; maxBytes?: number } = {},
): UploadFile {
  const home = realpathSync(options.home ?? homedir());
  const maxBytes = options.maxBytes ?? MAX_UPLOAD_BYTES;
  if (typeof input !== "string" || input.trim() === "") throw new FileRefused("dosya yolu boş");
  const expanded = input.startsWith("~/") ? join(home, input.slice(2)) : input;
  if (!isAbsolute(expanded)) {
    throw new FileRefused("dosya yolu mutlak olmalı (absolute path required)");
  }
  let real: string;
  try {
    real = realpathSync(resolve(expanded));
  } catch {
    throw new FileRefused(`dosya bulunamadı (not found): ${input}`);
  }
  if (!inside(home, real)) {
    throw new FileRefused("yalnızca ev klasörünüzdeki dosyalar yüklenebilir (home folder only)");
  }
  const parts = relative(home, real).split(sep);
  if (parts.some((p) => p.startsWith(".")) || parts[0] === "Library") {
    throw new FileRefused(
      "gizli klasörlerden ve ~/Library'den dosya okunmaz (hidden folders and ~/Library refused)",
    );
  }
  const stat = lstatSync(real);
  if (!stat.isFile()) throw new FileRefused("normal bir dosya değil (not a regular file)");
  if (stat.size === 0) throw new FileRefused("dosya boş (empty file)");
  if (stat.size > maxBytes) {
    throw new FileRefused(`dosya çok büyük: ${stat.size} bayt, sınır ${maxBytes} (too large)`);
  }
  const mimeType = UPLOAD_MIME_TYPES[extname(real).toLowerCase()];
  if (!mimeType) {
    throw new FileRefused(
      `bu dosya türü Studio'ya yüklenemez (unsupported type): ${extname(real) || "uzantısız"}`,
    );
  }
  const bytes = readFileSync(real);
  if (statSync(real).size !== bytes.length) throw new FileRefused("dosya okunurken değişti");
  return { path: real, name: basename(real), mimeType, bytes };
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
  "font/ttf": ".ttf",
  "font/otf": ".otf",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
};

/** Folder for binary responses (per user temp folder, 0700). */
export function outputDirectory(base = tmpdir()): string {
  const dir = join(base, "studio-mcp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Saves a binary response and returns its path. */
export function saveBinary(
  bytes: Uint8Array,
  contentType: string,
  hint: string,
  base?: string,
): string {
  const mime = contentType.split(";")[0]?.trim() ?? "";
  const ext = EXTENSIONS[mime] ?? ".bin";
  const safeHint = hint.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 60) || "file";
  const file = join(outputDirectory(base), `${safeHint}-${randomUUID().slice(0, 8)}${ext}`);
  writeFileSync(file, bytes, { mode: 0o600 });
  return file;
}
