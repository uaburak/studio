// The canvas document's pictures as the brand's assets (E13): a version's bundle carries
// references, not bytes (bundle.ts, format 2). Before a version is created every picture the
// document uses gets an asset — the one that already has its bytes (same SHA-256: the opened
// bundle's references, a picture the import read from the brand's media, an earlier upload) or a
// new upload. An unchanged picture is never uploaded again. One that can't be an asset (not
// PNG / JPEG / GIF / WebP, over the API's limit) stays inside the bundle.
import { ASSET_MIME_RULES } from "@studio/contract";
import type { BundleImageRef, BundleImages } from "./bundle.ts";
import { sha256Hex } from "./hash.ts";

/** PNG, JPEG, GIF or WebP, by the file's first bytes (null: none of them). */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const at = (i: number) => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  )
    return "image/webp";
  return null;
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Uploads one picture as an asset of the post's brand. */
export type UploadImage = (input: { file: Blob; filename: string }) => Promise<{ id: string }>;

/** How the pictures of one save went. */
export interface SharedImages {
  uploaded: number;
  reused: number;
  /** Kept inside the bundle (no asset possible). */
  inside: number;
}

/** The asset an image read from the brand's media is (`/api/assets/<id>/content`), or null. */
export function assetIdOfUrl(url: string): string | null {
  const m = /\/api\/assets\/([^/?#]+)\/content(?:[?#]|$)/.exec(url);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

/** A picture the import read from the brand's media: its bytes are that asset (dedupe). */
export async function rememberAsset(
  images: BundleImages,
  assetId: string,
  bytes: Uint8Array,
): Promise<void> {
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) return;
  images.remember({ assetId, sha256: await sha256Hex(bytes), mimeType, bytes: bytes.byteLength });
}

/**
 * The pictures whose bytes are a known asset (the import's, from the brand's media) linked to it
 * now, without uploading — so the draft keeps references, not the pictures' bytes.
 */
export async function linkKnownImages(images: BundleImages): Promise<number> {
  let linked = 0;
  for (const [sha1, bytes] of images.map) {
    if (images.assets.has(sha1)) continue;
    const known = images.known.get(await sha256Hex(bytes));
    if (known) {
      images.link(sha1, known);
      linked++;
    }
  }
  return linked;
}

/** Every picture `used` (SHA-1s of `images`) linked to an asset: a known one, else uploaded once. */
export async function shareImages(
  images: BundleImages,
  used: readonly string[],
  upload: UploadImage,
  concurrency = 4,
): Promise<SharedImages> {
  const result: SharedImages = { uploaded: 0, reused: 0, inside: 0 };
  const todo = used.filter((sha1) => !images.assets.has(sha1) && images.map.has(sha1));
  const one = async (sha1: string) => {
    const bytes = images.map.get(sha1) as Uint8Array;
    const sha256 = await sha256Hex(bytes);
    const known = images.known.get(sha256);
    if (known) {
      images.link(sha1, known);
      result.reused++;
      return;
    }
    const mimeType = sniffImageMime(bytes);
    const rule = mimeType ? ASSET_MIME_RULES[mimeType as keyof typeof ASSET_MIME_RULES] : null;
    if (!mimeType || !rule || bytes.byteLength > rule.maxBytes) {
      result.inside++;
      return;
    }
    const asset = await upload({
      file: new Blob([bytes as BlobPart], { type: mimeType }),
      filename: `tuval-gorseli.${EXT[mimeType] ?? "png"}`,
    });
    const ref: BundleImageRef = { assetId: asset.id, sha256, mimeType, bytes: bytes.byteLength };
    images.link(sha1, ref);
    result.uploaded++;
  };
  const queue = [...todo];
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, queue.length)) },
    async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await one(next);
    },
  );
  await Promise.all(workers);
  return result;
}
