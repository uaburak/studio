// Studio assets travelling into the composer: dragged from the Medya panel / library
// (`application/x-studio-asset`) or sent with "Sohbete ekle". The composer attaches an asset of
// its conversation's brand as it is (no upload: messages take `{ assetId, alias }`); an asset of
// another brand is copied (downloaded and uploaded to the composer's brand), since the API only
// accepts attachments of the conversation's brand.
import type { Asset } from "@studio/contract";

export const STUDIO_ASSET_MIME = "application/x-studio-asset";

export interface AssetDragPayload {
  assetId: string;
  brandId: string;
  mimeType: string;
  filename: string | null;
  width: number | null;
  height: number | null;
}

export function assetDragPayload(asset: Asset): AssetDragPayload {
  return {
    assetId: asset.id,
    brandId: asset.brandId,
    mimeType: asset.mimeType,
    filename: asset.originalFilename,
    width: asset.width,
    height: asset.height,
  };
}

/** Put the asset on a drag (copy only; no `text/plain`, so text fields do not take it). */
export function writeAssetDrag(dataTransfer: DataTransfer, payloads: AssetDragPayload[]): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(STUDIO_ASSET_MIME, JSON.stringify(payloads));
}

export function hasAssetDrag(dataTransfer: Pick<DataTransfer, "types">): boolean {
  return [...dataTransfer.types].includes(STUDIO_ASSET_MIME);
}

function isPayload(value: unknown): value is AssetDragPayload {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.assetId === "string" &&
    v.assetId.length > 0 &&
    typeof v.brandId === "string" &&
    typeof v.mimeType === "string"
  );
}

/** The dragged assets (empty when the drag carries none or garbage). */
export function readAssetDrag(dataTransfer: Pick<DataTransfer, "getData">): AssetDragPayload[] {
  const raw = dataTransfer.getData(STUDIO_ASSET_MIME);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter(isPayload).map((p) => ({
      assetId: p.assetId,
      brandId: p.brandId,
      mimeType: p.mimeType,
      filename: typeof p.filename === "string" ? p.filename : null,
      width: typeof p.width === "number" ? p.width : null,
      height: typeof p.height === "number" ? p.height : null,
    }));
  } catch {
    return [];
  }
}

/**
 * What the composer does with a dropped asset: attach it as is (same brand), copy it into the
 * composer's brand, or refuse (no brand yet, or not an image).
 */
export function attachDecision(
  payload: AssetDragPayload,
  composerBrandId: string | null,
): "attach" | "copy" | "refuse" {
  if (!composerBrandId || !payload.mimeType.startsWith("image/")) return "refuse";
  return payload.brandId === composerBrandId ? "attach" : "copy";
}

// --- "Sohbete ekle": the mounted composer listens -------------------------------------------------

type AttachListener = (payloads: AssetDragPayload[]) => void;
const listeners = new Set<AttachListener>();

export function onComposerAttach(listener: AttachListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Hand assets to the composer on screen. Returns false when no composer is mounted. */
export function requestComposerAttach(payloads: AssetDragPayload[]): boolean {
  if (listeners.size === 0) return false;
  for (const l of listeners) l(payloads);
  return true;
}
