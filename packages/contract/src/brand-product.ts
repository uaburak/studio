import { z } from "zod";
import { EntityId, nonEmptyUpdate, PageQuery, pageOf, Timestamp } from "./common.ts";

/**
 * A brand's products ("Ürünler" on the brand profile): what the brand sells or makes, so posts
 * can show and name them correctly. Each product has a name, photos (ordinary `image` assets
 * of the same brand; the first one is the cover), a short description, a category, free tags
 * and notes (what to stress, what to avoid).
 *
 * Stored in D1 (`brand_products`), one row per product
 * (`/api/brands/{brandId}/products[/{productId}]`).
 */

export const MAX_PRODUCT_IMAGES = 8;
export const MAX_PRODUCT_TAGS = 12;

const ProductName = z.string().trim().min(1).max(120);
const ProductDescription = z.string().trim().max(500);
const ProductCategory = z.string().trim().max(80);
const ProductTag = z.string().trim().min(1).max(40);
const ProductNotes = z.string().max(4000);

const uniqueIds = (ids: readonly string[]) => new Set(ids).size === ids.length;
const uniqueTags = (tags: readonly string[]) =>
  new Set(tags.map((t) => t.toLocaleLowerCase("tr-TR"))).size === tags.length;

const ProductTags = z
  .array(ProductTag)
  .max(MAX_PRODUCT_TAGS)
  .refine(uniqueTags, "a tag is listed twice");
const ProductImages = z
  .array(EntityId)
  .max(MAX_PRODUCT_IMAGES)
  .refine(uniqueIds, "a photo is listed twice");

export const BrandProduct = z
  .object({
    id: EntityId,
    brandId: EntityId,
    name: z.string(),
    /**
     * Mention name in chats (`@boro`), unique in the brand across products and posts (see
     * mention.ts). Always sent by this server; absent from older ones.
     */
    slug: z.string().optional(),
    /** Short description ("" when none). */
    description: z.string(),
    /** Free category ("" when none): "Gübre", "Tohum". */
    category: z.string(),
    tags: z.array(z.string()),
    notes: z.string(),
    /** `image` assets of the brand, in order; the first one is the cover. */
    imageAssetIds: z.array(EntityId),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "BrandProduct" });
export type BrandProduct = z.infer<typeof BrandProduct>;

export const BrandProductCreate = z
  .object({
    name: ProductName,
    description: ProductDescription.default(""),
    category: ProductCategory.default(""),
    tags: ProductTags.default([]),
    notes: ProductNotes.default(""),
    imageAssetIds: ProductImages.default([]),
  })
  .meta({ id: "BrandProductCreate" });
export type BrandProductCreate = z.input<typeof BrandProductCreate>;

export const BrandProductUpdate = z
  .object({
    name: ProductName.optional(),
    description: ProductDescription.optional(),
    category: ProductCategory.optional(),
    tags: ProductTags.optional(),
    notes: ProductNotes.optional(),
    imageAssetIds: ProductImages.optional(),
  })
  .refine(nonEmptyUpdate, "at least one field is required")
  .meta({ id: "BrandProductUpdate" });
export type BrandProductUpdate = z.input<typeof BrandProductUpdate>;

export const BrandProductListQuery = PageQuery;
export type BrandProductListQuery = z.input<typeof BrandProductListQuery>;

/** Oldest first (the order they were added in). */
export const BrandProductList = pageOf(BrandProduct, "BrandProductList");
export type BrandProductList = z.infer<typeof BrandProductList>;
