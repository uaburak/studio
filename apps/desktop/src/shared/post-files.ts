// Exporting a post's files on this Mac (the AppKit app's PostExporter / PostFileExport): the page
// decides which assets make the export (rendered JPEGs, PNGs or a PDF the worker renders, a
// reel's MP4 or cover) and names them; the main process asks where to save (a file for one, a
// folder for several), downloads the assets from the local API itself and writes them, opens
// the macOS share menu with them, and shows written files in Finder. The page never names a
// path: only files the main process wrote this session can be revealed.

export type PostFileFormat = "jpeg" | "png" | "pdf" | "mp4";

export interface PostFile {
  /** API asset id (`/api/assets/<id>/content`). */
  assetId: string;
  /** File name without folders ("hasat-v3-2.jpg"). */
  name: string;
}

export interface PostFilesRequest {
  format: PostFileFormat;
  files: PostFile[];
}

export type PostFilesResult =
  | { ok: true; paths: string[] }
  | { ok: false; canceled: true }
  | { ok: false; canceled?: false; message: string };

export interface PostFilesBridge {
  /** Save dialog (one file) or folder dialog (several), then download and write. */
  save(request: PostFilesRequest): Promise<PostFilesResult>;
  /** The macOS share menu with the files (downloaded to a cache folder first). */
  share(request: PostFilesRequest): Promise<PostFilesResult>;
  /** Shows files written by `save` in Finder (others are ignored). */
  reveal(paths: string[]): Promise<void>;
}

export const POST_FILES_IPC = {
  save: "post-files:save",
  share: "post-files:share",
  reveal: "post-files:reveal",
} as const;

export const FORMAT_EXTENSION: Record<PostFileFormat, string> = {
  jpeg: "jpg",
  png: "png",
  pdf: "pdf",
  mp4: "mp4",
};

export const FORMAT_LABEL: Record<PostFileFormat, string> = {
  jpeg: "JPEG",
  png: "PNG",
  pdf: "PDF",
  mp4: "Video",
};

/** An asset id as the API makes them (nothing that walks out of `/api/assets/`). */
export const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** At most this many files in one export (20 slides). */
export const MAX_POST_FILES = 20;

/**
 * A safe file name for `format`: no folders, no hidden or control characters, the format's
 * extension. Null when nothing usable is left.
 */
export function safeFileName(name: string, format: PostFileFormat): string | null {
  const ext = FORMAT_EXTENSION[format];
  const base = name
    .split(/[/\\]/)
    .pop()
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are removed on purpose
    ?.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "")
    .replace(/^\.+/, "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .trim()
    .slice(0, 120);
  if (!base) return null;
  return `${base}.${ext}`;
}

/** Validates a request from the page; returns the reason it is refused, or null. */
export function requestProblem(request: unknown): string | null {
  const r = request as Partial<PostFilesRequest> | null;
  if (!r || typeof r !== "object") return "Geçersiz istek.";
  if (!r.format || !(r.format in FORMAT_EXTENSION)) return "Bilinmeyen dosya biçimi.";
  if (!Array.isArray(r.files) || r.files.length === 0) return "Dışa aktarılacak dosya yok.";
  if (r.files.length > MAX_POST_FILES) return "Tek seferde en fazla 20 dosya.";
  for (const f of r.files) {
    if (!f || typeof f.assetId !== "string" || !ASSET_ID.test(f.assetId))
      return "Geçersiz dosya kimliği.";
    if (typeof f.name !== "string" || !safeFileName(f.name, r.format)) return "Geçersiz dosya adı.";
  }
  return null;
}
