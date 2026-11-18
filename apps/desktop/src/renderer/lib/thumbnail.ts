// Small copies of pictures for grids (A4): `GET /api/assets/{id}/thumbnail?w=` — the API resizes
// on the Mac (WebP, cached next to the original) and falls back to the original bytes when a file
// cannot be resized. Grids ask for their tile's CSS width × the screen's pixel ratio.
import { assetThumbnailPath, THUMBNAILABLE_MIME_TYPES } from "@studio/contract";
import { assetUrl } from "./api.ts";

/** The device pixel ratio, 2 on Retina; 1 where there is no window (tests). */
function pixelRatio(): number {
  const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? Math.min(ratio, 3) : 1;
}

/** `<img src>` of `assetId` for a tile `cssWidth` px wide. */
export function thumbUrl(assetId: string, cssWidth: number): string {
  return assetThumbnailPath(assetId, Math.round(cssWidth * pixelRatio()));
}

/** A library file's picture: its thumbnail when the API can resize that type (not SVG), else the file. */
export function tileUrl(asset: { id: string; mimeType: string }, cssWidth: number): string {
  return (THUMBNAILABLE_MIME_TYPES as readonly string[]).includes(asset.mimeType)
    ? thumbUrl(asset.id, cssWidth)
    : assetUrl(asset.id);
}
