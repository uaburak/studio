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

/** "3 ürün", "Ürün yok". */
export function productCountText(count: number): string {
  return count === 0 ? "Ürün yok" : `${count} ürün`;
}
