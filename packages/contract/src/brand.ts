import { z } from "zod";
import { EntityId, nonEmptyUpdate, PageQuery, pageOf, Timestamp } from "./common.ts";
import { GenerationEngine } from "./generation.ts";

export const BrandStatus = z.enum(["active", "archived"]).meta({ id: "BrandStatus" });
export type BrandStatus = z.infer<typeof BrandStatus>;

/** Lowercase BCP 47 language, optionally with region: `tr`, `en`, `en-US`. */
export const LanguageTag = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "expected a language tag such as `tr` or `en-US`");
export type LanguageTag = z.infer<typeof LanguageTag>;

/** URL-safe identifier, unique across brands: `mtm-agro`. */
export const BrandSlug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase letters, digits and single dashes only");
export type BrandSlug = z.infer<typeof BrandSlug>;

const BrandName = z.string().trim().min(1).max(120);

/** Free text added to the brand's generated pictures' prompts ("vintage", "retro"…); "" = none. */
export const MAX_IMAGE_STYLE_PRESET_LENGTH = 500;
const ImageStylePreset = z.string().trim().max(MAX_IMAGE_STYLE_PRESET_LENGTH);

export const Brand = z
  .object({
    id: EntityId,
    name: z.string(),
    slug: BrandSlug,
    defaultLanguage: LanguageTag,
    status: BrandStatus,
    createdAt: Timestamp,
    updatedAt: Timestamp,
    /**
     * The engine the agent uses for this brand's posts without asking (null: ask each time).
     * Always sent by this server; absent from older ones.
     */
    defaultEngine: GenerationEngine.nullable().optional(),
    /** Style preset for generated pictures ("" = none). Always sent by this server. */
    imageStylePreset: z.string().optional(),
  })
  .meta({ id: "Brand" });
export type Brand = z.infer<typeof Brand>;

export const BrandCreate = z
  .object({
    name: BrandName,
    /** Derived from `name` when omitted. */
    slug: BrandSlug.optional(),
    defaultLanguage: LanguageTag.default("tr"),
    defaultEngine: GenerationEngine.nullable().optional(),
    imageStylePreset: ImageStylePreset.optional(),
  })
  .meta({ id: "BrandCreate" });
export type BrandCreate = z.input<typeof BrandCreate>;

export const BrandUpdate = z
  .object({
    name: BrandName.optional(),
    slug: BrandSlug.optional(),
    defaultLanguage: LanguageTag.optional(),
    /** Brands are never deleted; archive them instead. */
    status: BrandStatus.optional(),
    /** null clears it (the agent asks each time). */
    defaultEngine: GenerationEngine.nullable().optional(),
    imageStylePreset: ImageStylePreset.optional(),
  })
  .refine(nonEmptyUpdate, "at least one field is required")
  .meta({ id: "BrandUpdate" });
export type BrandUpdate = z.input<typeof BrandUpdate>;

export const BrandListQuery = PageQuery.extend({ status: BrandStatus.optional() });
export type BrandListQuery = z.input<typeof BrandListQuery>;

export const BrandList = pageOf(Brand, "BrandList");
export type BrandList = z.infer<typeof BrandList>;

const TURKISH_FOLD: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  İ: "i",
  ö: "o",
  ş: "s",
  ü: "u",
};

/** `"MTM Agro / Venta"` -> `"mtm-agro-venta"`; Turkish letters are folded to ASCII. */
export function slugify(name: string): string {
  return name
    .replace(/[çğıİöşü]/gi, (ch) => TURKISH_FOLD[ch] ?? TURKISH_FOLD[ch.toLowerCase()] ?? ch)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}
