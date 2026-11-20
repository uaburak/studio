/**
 * Typed brand tokens (`brand.json`, stored as `BrandProfile.tokens` in @studio/contract).
 * Every value that ends up in brand.css is validated here, so a brand profile (which may
 * be drafted by a model) cannot inject CSS.
 */
import { z } from "zod";

const TokenName = z.string().regex(/^[a-z][a-z0-9-]{0,47}$/, "token names are kebab-case");
const HexColor = z
  .string()
  .regex(
    /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    "colours are #RGB, #RRGGBB or #RRGGBBAA",
  );
const FamilyName = z
  .string()
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} -]{0,63}$/u, "font family: letters, digits, spaces, hyphens");
const FilePath = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/, "relative file path inside the brand folder")
  .refine((p) => !p.split("/").some((s) => s === ".." || s === "."), "no . or .. segments");
const Em = z.string().regex(/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:em|px)$/, "e.g. -0.01em");
const Range2 = z.tuple([z.number().min(1).max(1000), z.number().min(1).max(1000)]);
const UnicodeRange = z
  .string()
  .regex(
    /^U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?(?:\s*,\s*U\+[0-9A-Fa-f?]{1,6}(?:-[0-9A-Fa-f]{1,6})?)*$/,
  );

/** `{ value: "#66B052", ... }` or just `"#66B052"`. Extra keys (origin, use) are kept as documentation. */
export const ColorTokenSchema = z.union([HexColor, z.looseObject({ value: HexColor })]);

export const FontFileSchema = z.union([
  FilePath,
  z.object({
    path: FilePath,
    style: z.enum(["normal", "italic"]).optional(),
    weight: z.union([Range2, z.number().min(1).max(1000)]).optional(),
    stretch: Range2.optional(),
    /** `latin`, `latin-ext` or an explicit `U+...` list. */
    unicodeRange: z.union([z.enum(["latin", "latin-ext"]), UnicodeRange]).optional(),
  }),
]);
export type FontFile = z.infer<typeof FontFileSchema>;

export const FontRoleSchema = z.looseObject({
  family: FamilyName,
  files: z.array(FontFileSchema).max(32).default([]),
  /**
   * The family is a font installed on the Mac that renders (Chromium uses it by name). `files`,
   * when given, are the fallback for a machine without it: brand.css loads them under
   * `fallbackFamilyName(family)` and puts that family right after the installed one.
   */
  system: z.boolean().optional(),
  /** Weights the brand uses / the installed family offers (documentation for designers and models). */
  weights: z.array(z.number().int().min(1).max(1000)).max(32).optional(),
  axes: z
    .object({
      wght: Range2.optional(),
      wdth: z.tuple([z.number().min(25).max(200), z.number().min(25).max(200)]).optional(),
    })
    .optional(),
  fallback: z.enum(["sans-serif", "serif", "monospace", "system-ui"]).default("sans-serif"),
  /** Defaults every type style of this role inherits. */
  default: z
    .looseObject({
      weight: z.number().min(1).max(1000).optional(),
      stretch: z
        .string()
        .regex(/^\d{2,3}%$/)
        .optional(),
      style: z.enum(["normal", "italic"]).optional(),
      transform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(),
      tracking: Em.optional(),
      leading: z.number().min(0.5).max(4).optional(),
    })
    .optional(),
  license: z.string().optional(),
});
export type FontRole = z.infer<typeof FontRoleSchema>;

export const TypeStyleSchema = z.looseObject({
  font: TokenName,
  size: z.number().min(1).max(1000),
  weight: z.number().min(1).max(1000),
  leading: z.number().min(0.5).max(4),
  tracking: Em.optional(),
  transform: z.enum(["none", "uppercase", "lowercase", "capitalize"]).optional(),
  style: z.enum(["normal", "italic"]).optional(),
  stretch: z
    .string()
    .regex(/^\d{2,3}%$/)
    .optional(),
});
export type TypeStyle = z.infer<typeof TypeStyleSchema>;

export const LogoTokenSchema = z.looseObject({
  path: FilePath,
  intrinsic: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
  aspect: z.number().positive().optional(),
  /** Background the logo is made for. */
  on: z.enum(["light", "dark", "any"]).optional(),
  /** Minimum clear space around the logo, as a fraction of its rendered height (default 0.5). */
  clearSpace: z.number().min(0).max(4).optional(),
});

export const BrandComponentsConfigSchema = z
  .object({
    badge: z
      .object({
        shape: z.enum(["hexagon", "circle", "square", "pill"]),
        size: z.number().min(24).max(400),
        fontSize: z.number().min(12).max(200),
        ink: TokenName,
      })
      .partial()
      .optional(),
    band: z
      .object({
        height: z.number().min(2).max(400),
        tabWidth: z.number().min(0).max(1080),
        tabHeight: z.number().min(0).max(200),
      })
      .partial()
      .optional(),
    signOff: z
      .object({ logoHeight: z.number().min(8).max(400), fontSize: z.number().min(12).max(200) })
      .partial()
      .optional(),
    counter: z
      .object({ fontSize: z.number().min(12).max(200), muted: TokenName })
      .partial()
      .optional(),
  })
  .optional();

export const BrandUsageSchema = z
  .object({
    /** Colour token names for the roles the base CSS and components need. */
    background: TokenName,
    text: TokenName,
    accent: TokenName,
    muted: TokenName,
    slotFill: TokenName,
    slotInk: TokenName,
    /** Font roles used for running text and display type. */
    textFont: TokenName,
    displayFont: TokenName,
  })
  .partial()
  .optional();

function stripMeta(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMeta);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!k.startsWith("$")) out[k] = stripMeta(v);
    return out;
  }
  return value;
}

export const BrandTokensSchema = z.preprocess(
  stripMeta,
  z.looseObject({
    id: z.string().max(64).optional(),
    name: z.string().max(120).optional(),
    version: z.string().max(32).optional(),
    status: z.string().max(32).optional(),
    color: z
      .record(TokenName, ColorTokenSchema)
      .refine((c) => Object.keys(c).length > 0, "at least one colour"),
    font: z
      .record(TokenName, FontRoleSchema)
      .refine((f) => Object.keys(f).length > 0, "at least one font role"),
    type: z.record(TokenName, TypeStyleSchema).default({}),
    space: z
      .looseObject({
        unit: z.number().positive().optional(),
        margin: z.number().min(0).max(1000),
        gutter: z.number().min(0).max(1000).optional(),
        columns: z.number().int().min(1).max(24).optional(),
        scale: z.array(z.number().int().min(0).max(2000)).max(32).default([]),
      })
      .default({ margin: 72, scale: [] }),
    radius: z.record(TokenName, z.number().min(0).max(10000)).default({}),
    rule: z
      .looseObject({
        width: z.number().min(1).max(2000),
        thickness: z.number().min(1).max(200),
        color: TokenName.optional(),
      })
      .optional(),
    logos: z.record(TokenName, LogoTokenSchema).default({}),
    assets: z.record(z.string(), z.looseObject({ path: FilePath })).default({}),
    usage: BrandUsageSchema,
    components: BrandComponentsConfigSchema,
  }),
);
export type BrandTokens = z.infer<typeof BrandTokensSchema>;
export type BrandTokensInput = z.input<typeof BrandTokensSchema>;

export function parseBrandTokens(input: unknown): BrandTokens {
  return BrandTokensSchema.parse(input);
}

export function colorValue(token: z.infer<typeof ColorTokenSchema>): string {
  return typeof token === "string" ? token : token.value;
}

/** Resolved usage roles with fallbacks that work for most brand.json files. */
export interface ResolvedUsage {
  background: string;
  text: string;
  accent: string;
  muted: string;
  slotFill: string;
  slotInk: string;
  textFont: string;
  displayFont: string;
}

export function resolveUsage(t: BrandTokens): ResolvedUsage {
  const colors = Object.keys(t.color);
  const pick = (explicit: string | undefined, ...candidates: (string | undefined)[]) => {
    if (explicit && colors.includes(explicit)) return explicit;
    for (const c of candidates) if (c && colors.includes(c)) return c;
    return colors[0] as string;
  };
  const fonts = Object.keys(t.font);
  const pickFont = (explicit: string | undefined, ...candidates: string[]) => {
    if (explicit && fonts.includes(explicit)) return explicit;
    for (const c of candidates) if (fonts.includes(c)) return c;
    return fonts[0] as string;
  };
  const u = t.usage ?? {};
  const background = pick(u.background, "paper", "white", "background", "bg");
  const text = pick(u.text, "graphite", "ink", "text", "black");
  const accent = pick(u.accent, t.rule?.color, "accent", "primary", "green", "brand");
  return {
    background,
    text,
    accent,
    muted: pick(u.muted, "stone", "muted", "grey", "gray", text),
    slotFill: pick(u.slotFill, "mist", "surface", "light", background),
    slotInk: pick(u.slotInk, "green-deep", "accent-deep", accent),
    textFont: pickFont(u.textFont, "text", "body"),
    displayFont: pickFont(u.displayFont, "display", "headline", "text"),
  };
}

/** Font family names the linter accepts (`font-family` rule). */
export function brandFontFamilies(t: BrandTokens): string[] {
  return [...new Set(Object.values(t.font).map((f) => f.family))];
}

/**
 * Families that come from fonts installed on the rendering Mac: `system: true`, and a role with
 * no files (brand.css declares no @font-face for it, so the name can only reach an installed
 * font — the neutral default's Helvetica Neue). Such a family is never "loaded" by the page.
 */
export function brandSystemFontFamilies(t: BrandTokens): string[] {
  return [
    ...new Set(
      Object.values(t.font).flatMap((f) => (f.system || f.files.length === 0 ? [f.family] : [])),
    ),
  ];
}

/** Family name brand.css gives a system role's fallback files: `Avenir Next Fallback`. */
export function fallbackFamilyName(family: string): string {
  return `${family} Fallback`;
}

/** Token names for patch validation (`PatchContext.colorTokens` / `fontTokens`). */
export function brandPatchContext(t: BrandTokens): { colorTokens: string[]; fontTokens: string[] } {
  return { colorTokens: Object.keys(t.color), fontTokens: Object.keys(t.font) };
}
