import { z } from "zod";
import { EntityId, Timestamp } from "./common.ts";

/**
 * The brand kit is the user's raw input for a brand (P2): logo files with the
 * background they are made for, font files with a family name and a licence
 * note, a colour palette picked by hand, sample post images (3–12 are needed
 * before `brand.analyze` can extract a profile) and free notes.
 *
 * It is *input*, not output: `brand.analyze` reads it (plus the images) and
 * writes a draft `BrandProfile` (tokens, DESIGN.md, VOICE.md, facts). Files are
 * ordinary brand assets (`POST /api/assets`); the kit only references them.
 *
 * Stored per brand as one JSON document (`GET/PUT /api/brands/{id}/kit`).
 */

export const MIN_KIT_SAMPLES = 3;
export const MAX_KIT_SAMPLES = 12;
export const MAX_KIT_LOGOS = 12;
export const MAX_KIT_FONTS = 12;
export const MAX_KIT_COLORS = 16;

/** Background a logo file is made for (`on` in design-kit logo tokens). */
export const BrandKitLogoBackground = z
  .enum(["any", "light", "dark"])
  .meta({ id: "BrandKitLogoBackground" });
export type BrandKitLogoBackground = z.infer<typeof BrandKitLogoBackground>;

/** Which font role a file is meant for. */
export const BrandKitFontRole = z.enum(["display", "text", "any"]).meta({ id: "BrandKitFontRole" });
export type BrandKitFontRole = z.infer<typeof BrandKitFontRole>;

/** `#RRGGBB` (upper or lower case). */
export const KitHexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "expected a colour such as #FF6A00");

/** kebab-case colour name: `primary`, `accent-deep`. */
export const KitColorName = z
  .string()
  .trim()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9-]*$/, "lowercase letters, digits and dashes, starting with a letter");

export const BrandKitLogo = z
  .object({
    assetId: EntityId,
    background: BrandKitLogoBackground.default("any"),
    label: z.string().trim().max(80).optional(),
  })
  .meta({ id: "BrandKitLogo" });
export type BrandKitLogo = z.infer<typeof BrandKitLogo>;

export const BrandKitFont = z
  .object({
    assetId: EntityId,
    /** CSS family name the file provides: `Archivo`, `Inter Display`. */
    family: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9][A-Za-z0-9 -]*$/, "letters, digits, spaces and dashes"),
    role: BrandKitFontRole.default("any"),
    /** Licence note the user wrote: where it came from, what it allows. */
    licenseNote: z.string().trim().max(500).default(""),
  })
  .meta({ id: "BrandKitFont" });
export type BrandKitFont = z.infer<typeof BrandKitFont>;

export const BrandKitColor = z
  .object({
    name: KitColorName,
    hex: KitHexColor,
    /** What it is for, in the user's words: "ana vurgu", "zemin". */
    use: z.string().trim().max(120).optional(),
  })
  .meta({ id: "BrandKitColor" });
export type BrandKitColor = z.infer<typeof BrandKitColor>;

export const BrandKitSample = z
  .object({
    assetId: EntityId,
    /** The caption that was posted with it, if the user has it. */
    caption: z.string().max(4000).optional(),
  })
  .meta({ id: "BrandKitSample" });
export type BrandKitSample = z.infer<typeof BrandKitSample>;

const uniqueBy =
  <T>(key: (item: T) => string) =>
  (items: readonly T[]) =>
    new Set(items.map(key)).size === items.length;

/** `PUT /api/brands/{id}/kit` body: the whole kit (replaces the stored one). */
export const BrandKitPut = z
  .object({
    logos: z
      .array(BrandKitLogo)
      .max(MAX_KIT_LOGOS)
      .refine(
        uniqueBy<BrandKitLogo>((l) => l.assetId),
        "a logo is listed twice",
      )
      .default([]),
    fonts: z
      .array(BrandKitFont)
      .max(MAX_KIT_FONTS)
      .refine(
        uniqueBy<BrandKitFont>((f) => f.assetId),
        "a font is listed twice",
      )
      .default([]),
    palette: z
      .array(BrandKitColor)
      .max(MAX_KIT_COLORS)
      .refine(
        uniqueBy<BrandKitColor>((c) => c.name),
        "colour names must be unique",
      )
      .default([]),
    samples: z
      .array(BrandKitSample)
      .max(MAX_KIT_SAMPLES)
      .refine(
        uniqueBy<BrandKitSample>((s) => s.assetId),
        "a sample is listed twice",
      )
      .default([]),
    notes: z.string().max(10_000).default(""),
  })
  .meta({ id: "BrandKitPut" });
export type BrandKitPut = z.input<typeof BrandKitPut>;

export const BrandKit = z
  .object({
    brandId: EntityId,
    logos: z.array(BrandKitLogo),
    fonts: z.array(BrandKitFont),
    palette: z.array(BrandKitColor),
    samples: z.array(BrandKitSample),
    notes: z.string(),
    /** null until the kit was saved once. */
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: "BrandKit" });
export type BrandKit = z.infer<typeof BrandKit>;

export function emptyBrandKit(brandId: string): BrandKit {
  return { brandId, logos: [], fonts: [], palette: [], samples: [], notes: "", updatedAt: null };
}

/**
 * Why `brand.analyze` cannot run on this kit yet (Turkish, shown as is), or
 * null when it can. Only the sample count is required; everything else helps.
 */
export function brandKitAnalysisBlocker(kit: Pick<BrandKit, "samples">): string | null {
  const n = kit.samples.length;
  if (n < MIN_KIT_SAMPLES) {
    return `Profil çıkarmak için en az ${MIN_KIT_SAMPLES} örnek post görseli gerekli (şu an ${n}).`;
  }
  if (n > MAX_KIT_SAMPLES) return `En fazla ${MAX_KIT_SAMPLES} örnek post görseli kullanılabilir.`;
  return null;
}
