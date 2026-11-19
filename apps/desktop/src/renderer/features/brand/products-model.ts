// The brand's products ("Ürünler") as plain values: the editor's draft, its checks (Turkish),
// the API inputs it becomes, tag typing and search. Tested without views.
import {
  type BrandProduct,
  type BrandProductCreate,
  type BrandProductUpdate,
  MAX_PRODUCT_IMAGES,
  MAX_PRODUCT_TAGS,
} from "@studio/contract";

export const PRODUCT_LIMITS = {
  name: 120,
  description: 500,
  category: 80,
  tag: 40,
  notes: 4000,
  images: MAX_PRODUCT_IMAGES,
  tags: MAX_PRODUCT_TAGS,
} as const;

export interface ProductDraft {
  name: string;
  description: string;
  category: string;
  tags: string[];
  notes: string;
  /** First one is the cover. */
  imageAssetIds: string[];
}

export function productDraft(product?: BrandProduct | null): ProductDraft {
  return {
    name: product?.name ?? "",
    description: product?.description ?? "",
    category: product?.category ?? "",
    tags: product?.tags ?? [],
    notes: product?.notes ?? "",
    imageAssetIds: product?.imageAssetIds ?? [],
  };
}

const fold = (text: string) => text.trim().toLocaleLowerCase("tr-TR");

/** The first reason the draft cannot be saved (Turkish), or null. */
export function productProblem(draft: ProductDraft): string | null {
  const name = draft.name.trim();
  if (!name) return "Ürün adı boş olamaz.";
  if (name.length > PRODUCT_LIMITS.name) {
    return `Ürün adı en fazla ${PRODUCT_LIMITS.name} karakter olabilir.`;
  }
  if (draft.description.trim().length > PRODUCT_LIMITS.description) {
    return `Kısa açıklama en fazla ${PRODUCT_LIMITS.description} karakter olabilir.`;
  }
  if (draft.category.trim().length > PRODUCT_LIMITS.category) {
    return `Kategori en fazla ${PRODUCT_LIMITS.category} karakter olabilir.`;
  }
  if (draft.tags.length > PRODUCT_LIMITS.tags) {
    return `En fazla ${PRODUCT_LIMITS.tags} etiket eklenebilir.`;
  }
  if (draft.notes.length > PRODUCT_LIMITS.notes) {
    return `Notlar en fazla ${PRODUCT_LIMITS.notes} karakter olabilir.`;
  }
  if (draft.imageAssetIds.length > PRODUCT_LIMITS.images) {
    return `En fazla ${PRODUCT_LIMITS.images} fotoğraf eklenebilir.`;
  }
  return null;
}

/** Draft → `BrandProductCreate` (trimmed). */
export function productInput(draft: ProductDraft): BrandProductCreate {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    category: draft.category.trim(),
    tags: draft.tags,
    notes: draft.notes,
    imageAssetIds: draft.imageAssetIds,
  };
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Only what changed (`BrandProductUpdate`), or null when nothing did. */
export function productPatch(
  product: BrandProduct,
  draft: ProductDraft,
): BrandProductUpdate | null {
  const next = productInput(draft);
  const patch: BrandProductUpdate = {};
  if (next.name !== product.name) patch.name = next.name;
  if (next.description !== product.description) patch.description = next.description;
  if (next.category !== product.category) patch.category = next.category;
  if (!sameList(next.tags ?? [], product.tags)) patch.tags = next.tags;
  if (next.notes !== product.notes) patch.notes = next.notes;
  if (!sameList(next.imageAssetIds ?? [], product.imageAssetIds)) {
    patch.imageAssetIds = next.imageAssetIds;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Typed tag text ("organik, yaprak gübresi") → the draft's tags with the new ones appended:
 * trimmed, at most PRODUCT_LIMITS.tag characters, no duplicates (case-insensitive), at most
 * PRODUCT_LIMITS.tags in all.
 */
export function addTags(tags: readonly string[], text: string): string[] {
  const out = [...tags];
  const seen = new Set(out.map(fold));
  for (const raw of text.split(/[,\n]/)) {
    const tag = raw.trim().replace(/^#/, "").slice(0, PRODUCT_LIMITS.tag).trim();
    if (!tag || seen.has(fold(tag))) continue;
    if (out.length >= PRODUCT_LIMITS.tags) break;
    seen.add(fold(tag));
    out.push(tag);
  }
  return out;
}

/** Search over name, category, tags and description (Turkish case folding). */
export function productMatches(product: BrandProduct, query: string): boolean {
  const q = fold(query);
  if (!q) return true;
  return [product.name, product.category, product.description, ...product.tags].some((field) =>
    fold(field).includes(q),
  );
}

/** Photo `assetId` moved to the front (the cover). */
export function makeCover(ids: readonly string[], assetId: string): string[] {
  return ids.includes(assetId) ? [assetId, ...ids.filter((id) => id !== assetId)] : [...ids];
}

/** The tone a product without a photo stands on (Postlar's dark, light or muted tile), stable
 *  per product. */
export type ProductTone = "dark" | "light" | "muted";

export function productTone(productId: string): ProductTone {
  let hash = 0;
  for (const ch of productId) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return (["dark", "light", "muted"] as const)[hash % 3] as ProductTone;
}

/** Tags as a caption's hashtags: "Yaprak gübresi" → "#yaprakgübresi". */
export function productHashtags(tags: readonly string[]): string {
  return tags
    .map((tag) => tag.replace(/^#/, "").replace(/\s+/g, "").toLocaleLowerCase("tr-TR"))
    .filter(Boolean)
    .map((tag) => `#${tag}`)
    .join(" ");
}

/** "şimdi", "12 dakika önce", "3 saat önce", "dün", "5 gün önce", "2 hafta önce", "4 ay önce". */
export function agoText(iso: string, now: Date = new Date()): string {
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime());
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "şimdi";
  if (minutes < 60) return `${minutes} dakika önce`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} saat önce`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "dün";
  if (days < 7) return `${days} gün önce`;
  if (days < 30) return `${Math.floor(days / 7)} hafta önce`;
  if (days < 365) return `${Math.floor(days / 30)} ay önce`;
  return `${Math.floor(days / 365)} yıl önce`;
}

/** "2 fotoğraf · 5 gün önce eklendi" ("güncellendi" once it was edited), like a post's status. */
export function productMetaLine(product: BrandProduct, now: Date = new Date()): string {
  const updated =
    new Date(product.updatedAt).getTime() - new Date(product.createdAt).getTime() > 60_000;
  const photos =
    product.imageAssetIds.length === 0
      ? "Fotoğraf yok"
      : `${product.imageAssetIds.length} fotoğraf`;
  const when = agoText(updated ? product.updatedAt : product.createdAt, now);
  return `${photos} · ${when} ${updated ? "güncellendi" : "eklendi"}`;
}

/** "3 ürün", "Ürün yok". */
export function productCountText(count: number): string {
  return count === 0 ? "Ürün yok" : `${count} ürün`;
}
