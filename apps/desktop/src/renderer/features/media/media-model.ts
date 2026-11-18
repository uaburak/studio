// The media library as plain values (tested without views): a brand's assets newest first,
// the kind filters with counts, the search (file name, kind, "AI" for generated pictures, and
// what Vision read in a picture: Turkish tags, its text, colours, shape — N12; Turkish-insensitive),
// the tag chips, lightbox images and the AI image request. Port of StudioMac's
// MediaModel / MediaPaneContent (Media/MediaView.swift, Inspector/PanelPaneContent.swift).
import {
  type Asset,
  type AssetKind,
  analysisSearchText,
  type ImageGeneratePayloadInput,
  type ProductPosition,
} from "@studio/contract";
import type { ChatImage } from "../../lib/transcript.ts";

export type MediaFilter = "all" | "images" | "videos" | "documents";

export const MEDIA_FILTERS: { id: MediaFilter; label: string }[] = [
  { id: "all", label: "Tümü" },
  { id: "images", label: "Görseller" },
  { id: "videos", label: "Videolar" },
  { id: "documents", label: "Belgeler" },
];

export const KIND_LABEL: Record<AssetKind, string> = {
  image: "Görsel",
  video: "Video",
  audio: "Ses",
  document: "Belge",
  font: "Yazı tipi",
  logo: "Logo",
  other: "Diğer",
};

export function filterMatches(filter: MediaFilter, kind: AssetKind): boolean {
  switch (filter) {
    case "all":
      return true;
    case "images":
      return kind === "image" || kind === "logo";
    case "videos":
      return kind === "video";
    case "documents":
      return kind === "document";
  }
}

/** Images (and logos) can be previewed, shown as thumbnails and dragged into the composer. */
export function isImageAsset(asset: Pick<Asset, "kind" | "mimeType">): boolean {
  return (asset.kind === "image" || asset.kind === "logo") && asset.mimeType.startsWith("image/");
}

/** Turkish-insensitive fold ("İ" / "i", "ş" / "s" …). */
export function fold(text: string): string {
  return text.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
}

export function searchTokens(query: string): string[] {
  return fold(query)
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function assetSearchText(asset: Asset): string {
  const words = [asset.originalFilename ?? "", KIND_LABEL[asset.kind], asset.kind, asset.mimeType];
  if (asset.source === "generated") words.push("ai yapay zeka üretilen");
  words.push(analysisSearchText(asset.analysis));
  return fold(words.join(" "));
}

/** The brand's most common Turkish tags (N12), for the chips over the grid. */
export function topTags(assets: readonly Asset[], max = 12): { label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    const seen = new Set<string>();
    for (const tag of asset.analysis?.tags ?? []) {
      if (seen.has(tag.label)) continue;
      seen.add(tag.label);
      counts.set(tag.label, (counts.get(tag.label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "tr"))
    .slice(0, max);
}

/** Second line under a tile: the size, then the picture's first tags when Vision read it. */
export function tileDetail(asset: Asset): string {
  const tags = (asset.analysis?.tags ?? []).slice(0, 2).map((t) => t.label);
  if (tags.length === 0) return assetMeta(asset);
  const size = asset.width && asset.height ? `${asset.width}×${asset.height} · ` : "";
  return `${size}${tags.join(", ")}`;
}

/** Tooltip of a tile: what Vision read (tags, text). */
export function analysisTooltip(asset: Asset): string | undefined {
  const a = asset.analysis;
  if (!a) return undefined;
  const parts: string[] = [];
  if (a.tags.length > 0) parts.push(`Etiketler: ${a.tags.map((t) => t.label).join(", ")}`);
  if (a.text) parts.push(`Yazı: ${a.text.replace(/\n/g, " · ").slice(0, 160)}`);
  if (a.colors.length > 0) parts.push(`Renkler: ${a.colors.map((c) => c.name).join(", ")}`);
  if (a.caption) parts.push(a.caption);
  if (a.note) parts.push(a.note);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Newest first, of `filter`, every search word somewhere in the asset's text. */
export function filterAssets(
  assets: readonly Asset[],
  query: string,
  filter: MediaFilter = "all",
): Asset[] {
  const tokens = searchTokens(query);
  return [...assets]
    .filter((a) => filterMatches(filter, a.kind))
    .filter((a) => {
      if (tokens.length === 0) return true;
      const text = assetSearchText(a);
      return tokens.every((t) => text.includes(t));
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export function mediaCounts(assets: readonly Asset[]): Record<MediaFilter, number> {
  const out: Record<MediaFilter, number> = { all: 0, images: 0, videos: 0, documents: 0 };
  for (const a of assets) {
    for (const f of MEDIA_FILTERS) if (filterMatches(f.id, a.kind)) out[f.id] += 1;
  }
  return out;
}

/** "MTM Agro · 128 görsel". */
export function mediaSummary(brandName: string | null | undefined, imageCount: number): string {
  const count = `${imageCount} görsel`;
  return brandName ? `${brandName} · ${count}` : count;
}

/** Lightbox images of image assets (caption: the file name). */
export function lightboxImages(assets: readonly Asset[]): ChatImage[] {
  return assets.filter(isImageAsset).map((a) => ({
    assetId: a.id,
    width: a.width,
    height: a.height,
    caption: a.originalFilename,
  }));
}

/** "1080×1350 · 2,4 MB". */
export function assetMeta(asset: Asset): string {
  const parts: string[] = [];
  if (asset.width && asset.height) parts.push(`${asset.width}×${asset.height}`);
  else parts.push(KIND_LABEL[asset.kind]);
  parts.push(formatBytes(asset.bytes));
  return parts.join(" · ");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`;
}

/** File name for "Farklı kaydet…": the original name, else `<kind>-<id>.<ext>`. */
export function downloadName(asset: Asset): string {
  if (asset.originalFilename?.trim()) return asset.originalFilename.trim();
  const ext = asset.mimeType.split("/")[1]?.replace("jpeg", "jpg").replace("+xml", "") ?? "bin";
  return `${asset.kind}-${asset.id.slice(0, 8)}.${ext}`;
}

// --- AI image generation (`image.generate`) ----------------------------------------------------------

export const ASPECT_RATIOS = [
  { value: "4:5", label: "4:5 Post" },
  { value: "9:16", label: "9:16 Hikâye/Reels" },
  { value: "1:1", label: "1:1 Kare" },
] as const;

export const IMAGE_SIZES = [
  { value: "2K", label: "2K" },
  { value: "1K", label: "1K" },
] as const;

export type AspectRatio = (typeof ASPECT_RATIOS)[number]["value"];
export type ImageSize = (typeof IMAGE_SIZES)[number]["value"];

/** Where the real product goes in a label-preserving picture (U9). */
export const PRODUCT_POSITIONS: { value: ProductPosition; label: string }[] = [
  { value: "auto", label: "Otomatik" },
  { value: "bottom-center", label: "Alt orta" },
  { value: "bottom-left", label: "Sol alt" },
  { value: "bottom-right", label: "Sağ alt" },
  { value: "center", label: "Orta" },
];

/** The product's height in the picture (share of its height). */
export const PRODUCT_SIZES = [
  { value: "small", label: "Küçük", scale: 0.45 },
  { value: "medium", label: "Orta", scale: 0.62 },
  { value: "large", label: "Büyük", scale: 0.78 },
] as const;
export type ProductSize = (typeof PRODUCT_SIZES)[number]["value"];

export interface ImageRequestForm {
  prompt: string;
  aspectRatio: AspectRatio;
  imageSize: ImageSize;
  referenceAssetId: string | null;
  preserveProductLabel: boolean;
  /** U9 (with `preserveProductLabel`): position, size, the label's exact text if known. */
  productPosition?: ProductPosition;
  productSize?: ProductSize;
  labelText?: string;
}

/** The job payload, or a Turkish reason it cannot be sent. */
export function imageRequestPayload(
  form: ImageRequestForm,
): { ok: true; payload: ImageGeneratePayloadInput } | { ok: false; reason: string } {
  const prompt = form.prompt.trim();
  if (!prompt) return { ok: false, reason: "Görseli tarif eden bir metin yaz." };
  if (prompt.length > 4000) return { ok: false, reason: "Tarif en fazla 4000 karakter olabilir." };
  const label = form.preserveProductLabel && form.referenceAssetId !== null;
  const labelText = form.labelText?.trim() ?? "";
  if (label && labelText.length > 4000) {
    return { ok: false, reason: "Etiket metni en fazla 4000 karakter olabilir." };
  }
  const scale = PRODUCT_SIZES.find((s) => s.value === form.productSize)?.scale;
  return {
    ok: true,
    payload: {
      prompt,
      aspectRatio: form.aspectRatio,
      imageSize: form.imageSize,
      referenceAssetIds: form.referenceAssetId ? [form.referenceAssetId] : [],
      preserveProductLabel: form.preserveProductLabel,
      ...(label && form.productPosition && form.productPosition !== "auto"
        ? { productPosition: form.productPosition }
        : {}),
      ...(label && scale !== undefined && form.productSize !== "medium"
        ? { productScale: scale }
        : {}),
      ...(label && labelText ? { labelText } : {}),
    },
  };
}

/** Files the library takes (the API's allow-list decides; this only filters obvious misses). */
export const UPLOAD_ACCEPT =
  "image/png,image/jpeg,image/webp,image/gif,image/svg+xml,video/mp4,video/quicktime,application/pdf,audio/mpeg,audio/mp4,audio/wav";
