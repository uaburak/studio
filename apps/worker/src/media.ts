/**
 * Images for the model: size-capped download, decoded once, downscaled so the
 * long edge fits the model's useful resolution, re-encoded as JPEG (PNG when it
 * has transparency). Originals stay untouched for the renderer.
 */
import sharp from "sharp";
import type { ClaudeContentBlock, ClaudeImageMediaType } from "./claude/runner.ts";

export interface ImageInfo {
  width: number;
  height: number;
  format: string;
  hasAlpha: boolean;
}

export interface ModelImage {
  mediaType: ClaudeImageMediaType;
  data: Uint8Array;
  width: number;
  height: number;
  /** Size of the original. */
  original: ImageInfo;
}

const RASTER = new Set(["jpeg", "png", "webp", "gif", "avif", "tiff", "heif"]);

export async function imageInfo(bytes: Uint8Array): Promise<ImageInfo> {
  const meta = await sharp(bytes, { animated: false }).metadata();
  return {
    width: meta.width ?? 0,
    height: meta.height ?? 0,
    format: meta.format ?? "unknown",
    hasAlpha: Boolean(meta.hasAlpha),
  };
}

/**
 * Prepare an image for a model call. Returns null for files that are not raster
 * images (SVG, PDF) or cannot be decoded.
 */
export async function prepareModelImage(
  bytes: Uint8Array,
  options: { maxEdge?: number; quality?: number } = {},
): Promise<ModelImage | null> {
  let info: ImageInfo;
  try {
    info = await imageInfo(bytes);
  } catch {
    return null;
  }
  if (!RASTER.has(info.format) || info.width === 0 || info.height === 0) return null;
  const maxEdge = options.maxEdge ?? 1568;
  const pipeline = sharp(bytes, { animated: false }).rotate().resize({
    width: maxEdge,
    height: maxEdge,
    fit: "inside",
    withoutEnlargement: true,
  });
  const asPng = info.hasAlpha;
  const out = asPng
    ? await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true })
    : await pipeline
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: options.quality ?? 85, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
  return {
    mediaType: asPng ? "image/png" : "image/jpeg",
    data: new Uint8Array(out.data),
    width: out.info.width,
    height: out.info.height,
    original: info,
  };
}

export function imageBlock(image: Pick<ModelImage, "mediaType" | "data">): ClaudeContentBlock {
  return { type: "image", mediaType: image.mediaType, data: image.data };
}

/** File extension the renderer's content-type table knows, from a mime type. */
export function extensionForMime(mimeType: string): string {
  const bare = mimeType.split(";")[0]?.trim().toLowerCase();
  switch (bare) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/svg+xml":
      return ".svg";
    case "image/avif":
      return ".avif";
    default:
      return "";
  }
}
