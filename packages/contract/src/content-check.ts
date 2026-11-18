import { z } from "zod";
import { EntityId, PageQuery, type Platform, pageOf, Timestamp } from "./common.ts";

/**
 * Generation checks ("Kontroller", roadmap 13): every post / carousel / story / Reel passes a
 * set of checks after it is generated or edited, and on demand ("Kontrolleri çalıştır").
 *
 * The checks follow the roadmap's gates (the 7th, human approval, is the existing approve by
 * hash + schedule):
 *   1. brief      — the request has what the design needs (brief, platforms, filled slots),
 *   2. brand      — colours, fonts and logo usage against the kit / tokens and the brand's skills,
 *   3. layout     — text overflow, safe areas (story / Reels), contrast (WCAG), legibility,
 *   4. text       — caption and hashtag limits per platform, banned words, Turkish spelling,
 *   5. accuracy   — product names and claims against Ürünler and the brand facts,
 *   6. visual     — image resolution, distortion, logo legibility.
 *
 * Deterministic checks (design-kit lint on the rendered slides, caption rules) run first;
 * one cheap model pass covers language, voice and product / claim accuracy. Fixable
 * deterministic findings (text that overflows, a layer outside the safe area, poor contrast, a
 * caption over the limit) can be fixed automatically: that stores a new version.
 *
 * Results are stored per content version as check runs (`content_check_runs`,
 * `/api/contents/{id}/checks`); per-brand settings (`brand_check_settings`,
 * `/api/brands/{brandId}/check-settings`) switch checks off, list banned words and set the
 * strictness. The `content.check` job runs the checks on demand (and applies fixes).
 */

export const CheckCategory = z
  .enum(["brief", "brand", "layout", "text", "accuracy", "visual"])
  .meta({ id: "CheckCategory" });
export type CheckCategory = z.infer<typeof CheckCategory>;

/** Step number (roadmap 13) and Turkish label of each category, in order. */
export const CHECK_CATEGORIES: Record<CheckCategory, { step: number; label: string }> = {
  brief: { step: 1, label: "Brief" },
  brand: { step: 2, label: "Marka uyumu" },
  layout: { step: 3, label: "Yerleşim" },
  text: { step: 4, label: "Metin" },
  accuracy: { step: 5, label: "İçerik doğruluğu" },
  visual: { step: 6, label: "Görsel kalite" },
};

/** Stable ids: stored results and brand settings refer to them. Never rename one. */
export const CHECK_IDS = [
  "brief.completeness",
  "brand.colors",
  "brand.fonts",
  "brand.logo",
  "brand.voice",
  "layout.overflow",
  "layout.safe-area",
  "layout.contrast",
  "layout.legibility",
  "layout.consistency",
  "text.caption-length",
  "text.hashtags",
  "text.banned-words",
  "text.language",
  "accuracy.products",
  "accuracy.claims",
  "visual.resolution",
  "visual.distortion",
  "visual.logo-legibility",
] as const;
export const CheckId = z.enum(CHECK_IDS).meta({ id: "CheckId" });
export type CheckId = z.infer<typeof CheckId>;

export function isCheckId(value: string): value is CheckId {
  return (CHECK_IDS as readonly string[]).includes(value);
}

export interface CheckMeta {
  category: CheckCategory;
  /** Short Turkish label ("Metin taşması"). */
  label: string;
  /** One Turkish line: what is checked. */
  description: string;
  /** Who decides: rules on the render / text, the model pass, or both. */
  source: "deterministic" | "model" | "both";
  /** An automatic fix exists for (some of) its findings. */
  fixable: boolean;
}

export const CHECK_CATALOG: Record<CheckId, CheckMeta> = {
  "brief.completeness": {
    category: "brief",
    label: "Brief eksiksiz",
    description: "Brief, hedef platform ve görsel yuvaları tasarım için yeterli.",
    source: "deterministic",
    fixable: false,
  },
  "brand.colors": {
    category: "brand",
    label: "Marka renkleri",
    description: "Renkler marka kiti ve token'lardan geliyor.",
    source: "deterministic",
    fixable: false,
  },
  "brand.fonts": {
    category: "brand",
    label: "Marka fontları",
    description: "Metinler marka fontlarıyla yazılı ve fontlar yüklü.",
    source: "deterministic",
    fixable: false,
  },
  "brand.logo": {
    category: "brand",
    label: "Logo kullanımı",
    description: "Logo kitteki dosyadan, boşluk alanı korunmuş, üzerine metin binmiyor.",
    source: "deterministic",
    fixable: false,
  },
  "brand.voice": {
    category: "brand",
    label: "Ses tonu ve skill kuralları",
    description: "Metinler markanın ses tonuna ve skill kurallarına uyuyor.",
    source: "model",
    fixable: false,
  },
  "layout.overflow": {
    category: "layout",
    label: "Metin taşması",
    description: "Metin kutusuna sığıyor, kesilmiyor, başka metinle çakışmıyor.",
    source: "deterministic",
    fixable: true,
  },
  "layout.safe-area": {
    category: "layout",
    label: "Güvenli alan",
    description:
      "Metin ve logo platformun güvenli alanında (story / Reels arayüzü altında kalmıyor).",
    source: "deterministic",
    fixable: true,
  },
  "layout.contrast": {
    category: "layout",
    label: "Okunabilirlik kontrastı",
    description: "Metin arka planına karşı WCAG kontrastını sağlıyor (4.5:1, büyük metin 3:1).",
    source: "deterministic",
    fixable: true,
  },
  "layout.legibility": {
    category: "layout",
    label: "Yazı boyutu",
    description: "Metinler telefonda okunacak büyüklükte, Türkçe harfler satırlara çarpmıyor.",
    source: "deterministic",
    fixable: false,
  },
  "layout.consistency": {
    category: "layout",
    label: "Carousel tutarlılığı",
    description: "Logo, sayaç ve fontlar her slaytta aynı yerde ve doğru; slaytlar aynı boyutta.",
    source: "deterministic",
    fixable: false,
  },
  "text.caption-length": {
    category: "text",
    label: "Açıklama uzunluğu",
    description: "Açıklama her hedef platformun karakter sınırında.",
    source: "deterministic",
    fixable: true,
  },
  "text.hashtags": {
    category: "text",
    label: "Hashtag'ler",
    description: "Hashtag sayısı platform sınırında, tekrar yok.",
    source: "deterministic",
    fixable: true,
  },
  "text.banned-words": {
    category: "text",
    label: "Yasak kelimeler",
    description: "Markanın yasak kelime listesindeki ifadeler geçmiyor.",
    source: "deterministic",
    fixable: false,
  },
  "text.language": {
    category: "text",
    label: "Yazım ve dil bilgisi",
    description: "Türkçe yazım, noktalama ve dil bilgisi.",
    source: "model",
    fixable: false,
  },
  "accuracy.products": {
    category: "accuracy",
    label: "Ürün adları",
    description: "Ürün adları ve özellikleri Ürünler listesiyle uyumlu.",
    source: "model",
    fixable: false,
  },
  "accuracy.claims": {
    category: "accuracy",
    label: "İddialar ve rakamlar",
    description: "Rakamlar ve iddialar markanın doğrulanmış bilgilerinde var.",
    source: "both",
    fixable: false,
  },
  "visual.resolution": {
    category: "visual",
    label: "Çözünürlük",
    description: "Görseller yeterli çözünürlükte, yükleniyor ve dosya platform sınırında.",
    source: "deterministic",
    fixable: false,
  },
  "visual.distortion": {
    category: "visual",
    label: "Bozulma",
    description: "Görseller esnetilmemiş, yuvalar oranlarına uygun.",
    source: "deterministic",
    fixable: false,
  },
  "visual.logo-legibility": {
    category: "visual",
    label: "Logo okunurluğu",
    description: "Logo okunacak büyüklükte.",
    source: "deterministic",
    fixable: false,
  },
};

/** Checks in display order (by category, then as listed). */
export function checksByCategory(): { category: CheckCategory; checks: CheckId[] }[] {
  return CheckCategory.options.map((category) => ({
    category,
    checks: CHECK_IDS.filter((id) => CHECK_CATALOG[id].category === category),
  }));
}

/** Category of an id (an unknown id from a newer worker: its prefix, else `brief`). */
export function checkCategoryOf(id: string): CheckCategory {
  if (isCheckId(id)) return CHECK_CATALOG[id].category;
  const prefix = id.split(".")[0] ?? "";
  return CheckCategory.safeParse(prefix).success ? (prefix as CheckCategory) : "brief";
}

// --- results ------------------------------------------------------------------------------------

/**
 * - `pass`: nothing found,
 * - `warn`: worth a look; approval is not blocked (except with strictness `strict`),
 * - `fail`: should be fixed before approval (the approve button asks first),
 * - `fixed`: was found and fixed automatically (the fix is in this version),
 * - `skipped`: could not run (no model available, not applicable, text changed since).
 */
export const CheckStatus = z
  .enum(["pass", "warn", "fail", "fixed", "skipped"])
  .meta({ id: "CheckStatus" });
export type CheckStatus = z.infer<typeof CheckStatus>;

export const CheckSource = z.enum(["deterministic", "model"]).meta({ id: "CheckSource" });
export type CheckSource = z.infer<typeof CheckSource>;

/**
 * - `relaxed` (Esnek): cosmetic warnings are dropped; model findings stay warnings,
 * - `standard` (Standart),
 * - `strict` (Sıkı): warnings also block approval (the approve button asks first).
 */
export const CheckStrictness = z
  .enum(["relaxed", "standard", "strict"])
  .meta({ id: "CheckStrictness" });
export type CheckStrictness = z.infer<typeof CheckStrictness>;

/** What started a check run. */
export const CheckTrigger = z
  .enum(["generate", "render", "manual", "fix"])
  .meta({ id: "CheckTrigger" });
export type CheckTrigger = z.infer<typeof CheckTrigger>;

/** Where a finding is: a slide (0-based) and / or a layer (`data-layer` id). */
export const CheckRef = z
  .object({
    slide: z.number().int().min(0).max(19).nullable(),
    layer: z.string().min(1).max(64).nullable(),
  })
  .meta({ id: "CheckRef" });
export type CheckRef = z.infer<typeof CheckRef>;

export const MAX_CHECK_RESULTS = 200;
export const MAX_CHECK_MESSAGE = 600;

export const ContentCheckResult = z
  .object({
    /** A `CheckId` (kept a string so results of a newer worker still read). */
    checkId: z.string().min(1).max(64),
    category: CheckCategory,
    status: CheckStatus,
    /** Turkish, for the list ("Başlık kutusuna sığmıyor (yazı 72 px)."). */
    message: z.string().max(MAX_CHECK_MESSAGE),
    /** Slides / layers to highlight (empty for the caption or the whole post). */
    refs: z.array(CheckRef).max(20),
    /** Measured facts (ratio, px, the quoted text, the suggestion …). */
    evidence: z.record(z.string(), z.unknown()).nullable(),
    source: CheckSource,
    /** "Düzelt" can fix it automatically (a new version). */
    fixable: z.boolean(),
  })
  .meta({ id: "ContentCheckResult" });
export type ContentCheckResult = z.infer<typeof ContentCheckResult>;
export type ContentCheckResultInput = z.input<typeof ContentCheckResult>;

export const CheckSummary = z
  .object({
    pass: z.number().int().min(0),
    warn: z.number().int().min(0),
    fail: z.number().int().min(0),
    fixed: z.number().int().min(0),
    skipped: z.number().int().min(0),
  })
  .meta({ id: "CheckSummary" });
export type CheckSummary = z.infer<typeof CheckSummary>;

/** Does this result hold approval back (the approve button asks before approving)? */
export function isBlockingResult(
  result: Pick<ContentCheckResult, "status">,
  strictness: CheckStrictness,
): boolean {
  return result.status === "fail" || (strictness === "strict" && result.status === "warn");
}

/** Counts per status and the number of blocking results. */
export function summarizeCheckResults(
  results: readonly Pick<ContentCheckResult, "status">[],
  strictness: CheckStrictness,
): { summary: CheckSummary; blocking: number } {
  const summary: CheckSummary = { pass: 0, warn: 0, fail: 0, fixed: 0, skipped: 0 };
  let blocking = 0;
  for (const r of results) {
    summary[r.status] += 1;
    if (isBlockingResult(r, strictness)) blocking += 1;
  }
  return { summary, blocking };
}

export const CheckVersionNumber = z.coerce.number().int().min(1);

/** One run of the checks over one content version. */
export const ContentCheckRun = z
  .object({
    id: EntityId,
    contentId: EntityId,
    brandId: EntityId,
    /** Checked version (1, 2, 3 …). */
    version: z.number().int().min(1),
    versionId: EntityId.nullable(),
    trigger: CheckTrigger,
    /** The job that ran it (`content.generate`, `content.render`, `content.check`). */
    jobId: z.string().nullable(),
    /** The brand's strictness when it ran (decides `blocking`). */
    strictness: CheckStrictness,
    summary: CheckSummary,
    /** Results that hold approval back. */
    blocking: z.number().int().min(0),
    /** In display order: problems first, then passes. */
    results: z.array(ContentCheckResult),
    /** Model of the language / brand / product pass (`null` when it did not run). */
    model: z.string().nullable(),
    /** This version is an automatic fix of that version. */
    fromVersion: z.number().int().min(1).nullable(),
    /** An automatic fix of this version was stored as that version. */
    fixedVersion: z.number().int().min(1).nullable(),
    note: z.string(),
    createdAt: Timestamp,
  })
  .meta({ id: "ContentCheckRun" });
export type ContentCheckRun = z.infer<typeof ContentCheckRun>;

/** What the worker stores; the server computes `summary` and `blocking`. */
export const ContentCheckRunCreate = z
  .object({
    version: z.number().int().min(1),
    trigger: CheckTrigger,
    jobId: z.string().max(128).optional(),
    strictness: CheckStrictness.default("standard"),
    results: z.array(ContentCheckResult).max(MAX_CHECK_RESULTS),
    model: z.string().max(128).nullable().optional(),
    fromVersion: z.number().int().min(1).optional(),
    fixedVersion: z.number().int().min(1).optional(),
    note: z.string().max(1_000).default(""),
  })
  .meta({ id: "ContentCheckRunCreate" });
export type ContentCheckRunCreate = z.input<typeof ContentCheckRunCreate>;

export const ContentCheckRunListQuery = PageQuery.extend({
  /** Only runs of this version. */
  version: CheckVersionNumber.optional(),
});
export type ContentCheckRunListQuery = z.input<typeof ContentCheckRunListQuery>;

/** Newest first. */
export const ContentCheckRunList = pageOf(ContentCheckRun, "ContentCheckRunList");
export type ContentCheckRunList = z.infer<typeof ContentCheckRunList>;

// --- brand settings -----------------------------------------------------------------------------

export const MAX_BANNED_WORDS = 100;
export const BannedWord = z.string().trim().min(1).max(60);

const uniqueFold = (list: readonly string[]) =>
  new Set(list.map((w) => w.toLocaleLowerCase("tr-TR"))).size === list.length;

/** The brand's check settings (defaults until saved once: `updatedAt: null`). */
export const BrandCheckSettings = z
  .object({
    brandId: EntityId,
    /** Switched-off checks (every other check runs). */
    disabledChecks: z.array(z.string()),
    /** Words / phrases that must not appear (caption and slide text; Turkish suffixes too). */
    bannedWords: z.array(z.string()),
    strictness: CheckStrictness,
    /** Fix fixable findings right after a generation (a new version). */
    autoFix: z.boolean(),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: "BrandCheckSettings" });
export type BrandCheckSettings = z.infer<typeof BrandCheckSettings>;

export const BrandCheckSettingsPut = z
  .object({
    disabledChecks: z
      .array(CheckId)
      .max(CHECK_IDS.length)
      .refine((l) => new Set(l).size === l.length, "a check is listed twice")
      .default([]),
    bannedWords: z
      .array(BannedWord)
      .max(MAX_BANNED_WORDS)
      .refine(uniqueFold, "a word is listed twice")
      .default([]),
    strictness: CheckStrictness.default("standard"),
    autoFix: z.boolean().default(true),
  })
  .meta({ id: "BrandCheckSettingsPut" });
export type BrandCheckSettingsPut = z.input<typeof BrandCheckSettingsPut>;

export function defaultCheckSettings(brandId: string): BrandCheckSettings {
  return {
    brandId,
    disabledChecks: [],
    bannedWords: [],
    strictness: "standard",
    autoFix: true,
    updatedAt: null,
  };
}

export function isCheckEnabled(
  settings: Pick<BrandCheckSettings, "disabledChecks">,
  id: CheckId,
): boolean {
  return !settings.disabledChecks.includes(id);
}

// --- platform text limits -----------------------------------------------------------------------

/**
 * Caption limits per platform (characters as people count them; hashtags `null` = no hard
 * limit). Instagram refuses a caption over 2,200 characters or with more than 30 hashtags.
 */
export const CAPTION_LIMITS: Record<Platform, { characters: number; hashtags: number | null }> = {
  instagram: { characters: 2_200, hashtags: 30 },
  facebook: { characters: 63_206, hashtags: null },
  linkedin: { characters: 3_000, hashtags: null },
};

// --- content.check ------------------------------------------------------------------------------

/**
 * `content.check`: run the checks on a version (default: the current one) and store the run.
 * With `fix` the fixable findings (all, or of the listed checks) are fixed: a new version
 * (and / or a shorter caption) is stored and checked again.
 */
export const ContentCheckPayload = z
  .object({
    version: z.number().int().min(1).optional(),
    fix: z.union([z.boolean(), z.array(CheckId).max(CHECK_IDS.length)]).optional(),
    /** Include the model pass (language, voice, products, claims). Default true. */
    model: z.boolean().optional(),
  })
  .meta({ id: "ContentCheckPayload" });
export type ContentCheckPayload = z.infer<typeof ContentCheckPayload>;
export type ContentCheckPayloadInput = z.input<typeof ContentCheckPayload>;

/** Compact check outcome in job outputs (`checks` of `content.generate` / `content.check`). */
export const ContentCheckBrief = z
  .object({
    runId: EntityId.nullable(),
    /** The version the outcome describes (the fixed one when an automatic fix ran). */
    version: z.number().int().min(1),
    summary: CheckSummary,
    blocking: z.number().int().min(0),
    /** The version an automatic fix stored (null when nothing was fixed into a new version). */
    fixedVersion: z.number().int().min(1).nullable(),
    /** Up to 8 problems and fixes, worst first. */
    highlights: z
      .array(z.object({ checkId: z.string(), status: CheckStatus, message: z.string() }))
      .max(8),
    /** The checks could not run (the generation itself still succeeded). */
    error: z.string().optional(),
  })
  .meta({ id: "ContentCheckBrief" });
export type ContentCheckBrief = z.infer<typeof ContentCheckBrief>;

const STATUS_ORDER: Record<CheckStatus, number> = {
  fail: 0,
  warn: 1,
  fixed: 2,
  skipped: 3,
  pass: 4,
};

/** Display order: fail, warn, fixed, skipped, pass; within a status by category step. */
export function sortCheckResults<T extends Pick<ContentCheckResult, "status" | "category">>(
  results: readonly T[],
): T[] {
  return results
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.r.status] - STATUS_ORDER[b.r.status] ||
        CHECK_CATEGORIES[a.r.category].step - CHECK_CATEGORIES[b.r.category].step ||
        a.i - b.i,
    )
    .map(({ r }) => r);
}
