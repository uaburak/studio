import { z } from "zod";
import { EntityId, Timestamp } from "./common.ts";

/*
 * Media tagging and search (N12). Every uploaded picture is read on the Mac by Apple's Vision
 * framework (the worker's `studio-vision` helper; free, on-device): what is in it (Turkish tags,
 * English identifier kept), the text on it, its main colours, its shape, whether it is a cutout
 * or logo-like, and a feature print for "Benzerleri". The worker stores it with
 * `PUT /api/worker/assets/{id}/analysis`; `GET /api/assets?q=` searches it (with the file name);
 * the chat agent's `search_media` tool uses the same search.
 */

/** Bump when the worker learns to read more: older analyses are redone by the next backfill. */
export const ASSET_ANALYSIS_VERSION = 1;

/**
 * - `complete`: every part ran;
 * - `partial`: only what Node can see (colours, shape) — the Vision helper was missing; a worker
 *   with the helper redoes it;
 * - `failed`: the picture could not be read (not retried until the version changes).
 */
export const AssetAnalysisStatus = z
  .enum(["complete", "partial", "failed"])
  .meta({ id: "AssetAnalysisStatus" });
export type AssetAnalysisStatus = z.infer<typeof AssetAnalysisStatus>;

export const AssetTag = z
  .object({
    /** Vision's identifier (English), e.g. `wheat`. */
    id: z.string().min(1).max(100),
    /** Turkish label ("buğday"); the identifier in plain words when there is no translation. */
    label: z.string().min(1).max(100),
    confidence: z.number().min(0).max(1),
  })
  .meta({ id: "AssetTag" });
export type AssetTag = z.infer<typeof AssetTag>;

export const AssetColor = z
  .object({
    hex: z.string().regex(/^#[0-9a-f]{6}$/),
    /** Share of the (opaque part of the) picture, 0…1. */
    share: z.number().min(0).max(1),
    /** Turkish colour name ("kırmızı"). */
    name: z.string().min(1).max(40),
  })
  .meta({ id: "AssetColor" });
export type AssetColor = z.infer<typeof AssetColor>;

export const AssetOrientation = z
  .enum(["portrait", "landscape", "square"])
  .meta({ id: "AssetOrientation" });
export type AssetOrientation = z.infer<typeof AssetOrientation>;

export const ORIENTATION_LABELS: Record<AssetOrientation, string> = {
  portrait: "dikey",
  landscape: "yatay",
  square: "kare",
};

/** What the library knows about a picture (no feature print: that stays on the server). */
export const AssetAnalysis = z
  .object({
    status: AssetAnalysisStatus,
    tags: z.array(AssetTag).max(30),
    /** Text read on the picture (Turkish + English OCR), lines joined with newlines. */
    text: z.string().max(4000),
    colors: z.array(AssetColor).max(6),
    orientation: AssetOrientation.nullable(),
    /** Width / height. */
    aspectRatio: z.number().positive().nullable(),
    /** Transparent background: a product cutout or packshot. */
    isCutout: z.boolean(),
    /** Few colours and flat areas, or text only: probably a logo / wordmark. */
    isLogoLike: z.boolean(),
    /** A richer Turkish description by the AI, only when the owner turned it on. */
    caption: z.string().max(500).nullable(),
    /** A feature print is stored ("Benzerleri" can use this picture). */
    hasFeaturePrint: z.boolean(),
    /** What is missing, in Turkish (e.g. the Vision helper was not found). */
    note: z.string().max(500).nullable(),
    analyzedAt: Timestamp,
  })
  .meta({ id: "AssetAnalysis" });
export type AssetAnalysis = z.infer<typeof AssetAnalysis>;

/** `PUT /api/worker/assets/{id}/analysis` (worker token). */
export const AssetAnalysisPut = z
  .object({
    status: AssetAnalysisStatus,
    tags: z.array(AssetTag).max(30).default([]),
    text: z.string().max(4000).default(""),
    colors: z.array(AssetColor).max(6).default([]),
    orientation: AssetOrientation.nullable().default(null),
    aspectRatio: z.number().positive().max(1000).nullable().default(null),
    isCutout: z.boolean().default(false),
    isLogoLike: z.boolean().default(false),
    caption: z.string().max(500).nullable().default(null),
    /** Vision feature print: little-endian Float32 values, base64 (768 values = 4 KB). */
    featurePrint: z
      .object({
        revision: z.number().int().min(1).max(100),
        count: z.number().int().min(1).max(4096),
        data: z.string().min(1).max(24_000),
      })
      .nullable()
      .default(null),
    note: z.string().max(500).nullable().default(null),
    /** ASSET_ANALYSIS_VERSION the worker used. */
    version: z.number().int().min(1),
    helperVersion: z.string().max(40).nullable().default(null),
  })
  .meta({ id: "AssetAnalysisPut" });
export type AssetAnalysisPut = z.input<typeof AssetAnalysisPut>;

/** `GET /api/worker/assets/analysis/pending` (worker token). */
export const AssetAnalysisPendingQuery = z.object({
  brandId: EntityId.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  /** Also the `partial` ones (a worker that has the Vision helper redoes them). */
  includePartial: z.enum(["true", "false"]).optional(),
});
export type AssetAnalysisPendingQuery = z.input<typeof AssetAnalysisPendingQuery>;

/** `POST /api/assets/analysis/backfill`: queue tagging of every picture not read yet. */
export const AssetAnalysisBackfillResult = z
  .object({
    /** Pictures waiting (no analysis, an older version, or `partial` when asked). */
    pending: z.number().int().min(0),
    /** A `media.analyze` job waits for them (queued now, or one was already waiting). */
    queued: z.boolean(),
    jobId: z.string().nullable(),
  })
  .meta({ id: "AssetAnalysisBackfillResult" });
export type AssetAnalysisBackfillResult = z.infer<typeof AssetAnalysisBackfillResult>;

export const AssetAnalysisBackfillInput = z
  .object({
    brandId: EntityId.optional(),
    /** Redo `partial` analyses too (the worker asks for this once it has the Vision helper). */
    includePartial: z.boolean().default(false),
  })
  .meta({ id: "AssetAnalysisBackfillInput" });
export type AssetAnalysisBackfillInput = z.input<typeof AssetAnalysisBackfillInput>;

/**
 * `media.analyze` job: read pictures that have no analysis yet (the job's brand, or every brand)
 * until none is left. Queued by the API after an upload (one waiting job per brand at most) and
 * by the backfill.
 */
export const MediaAnalyzePayload = z
  .object({
    reason: z.enum(["upload", "backfill"]).default("upload"),
    includePartial: z.boolean().default(false),
  })
  .meta({ id: "MediaAnalyzePayload" });
export type MediaAnalyzePayload = z.infer<typeof MediaAnalyzePayload>;

// --- search ---------------------------------------------------------------------------------

/** Turkish-insensitive fold ("İ" / "i", "ş" / "s" …), lowercase. */
export function foldSearchText(text: string): string {
  return text.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i");
}

/** The words of a query, folded. */
export function searchQueryTokens(query: string): string[] {
  return foldSearchText(query)
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((t) => t.length > 0);
}

/** Words an analysis can be found by (Turkish tags and English identifiers, text, colours …). */
export function analysisSearchText(analysis: AssetAnalysis | null | undefined): string {
  if (!analysis) return "";
  const words: string[] = [];
  for (const tag of analysis.tags) words.push(tag.label, tag.id.replace(/_/g, " "));
  if (analysis.text) words.push(analysis.text);
  if (analysis.caption) words.push(analysis.caption);
  for (const color of analysis.colors) words.push(color.name);
  if (analysis.orientation) words.push(ORIENTATION_LABELS[analysis.orientation]);
  if (analysis.isCutout) words.push("dekupe şeffaf arka plansız kesilmiş ürün");
  if (analysis.isLogoLike) words.push("logo amblem");
  return words.join(" ");
}

export const ASSET_KIND_SEARCH_LABELS: Record<string, string> = {
  image: "Görsel",
  video: "Video",
  audio: "Ses",
  document: "Belge",
  font: "Yazı tipi",
  logo: "Logo",
  other: "Diğer",
};

export interface SearchableAsset {
  kind: string;
  mimeType: string;
  source: string;
  originalFilename: string | null;
  analysis?: AssetAnalysis | null | undefined;
}

/** Everything a file is found by, folded: name, kind, "AI" for generated, and its analysis. */
export function assetSearchText(asset: SearchableAsset): string {
  const words = [
    asset.originalFilename ?? "",
    ASSET_KIND_SEARCH_LABELS[asset.kind] ?? "",
    asset.kind,
    asset.mimeType,
  ];
  if (asset.source === "generated") words.push("ai yapay zeka üretilen");
  words.push(analysisSearchText(asset.analysis));
  return foldSearchText(words.join(" "));
}

/** Every word of the query appears somewhere in the asset's text. */
export function assetMatchesQuery(asset: SearchableAsset, query: string): boolean {
  const tokens = searchQueryTokens(query);
  if (tokens.length === 0) return true;
  const text = assetSearchText(asset);
  return tokens.every((t) => text.includes(t));
}

// --- similarity ("Benzerleri") ----------------------------------------------------------------

/** Decode a stored feature print (little-endian Float32, base64). */
export function decodeFeaturePrint(base64: string): Float32Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const out = new Float32Array(Math.floor(bytes.length / 4));
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Euclidean distance (what Vision's `computeDistance` returns); Infinity when sizes differ. */
export function featureDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Distance → 0…1 for display. Vision's revision-2 prints are unit length, so distances run 0…2;
 * in practice near-duplicates sit under 0.4 and unrelated pictures around 1 or more.
 */
export function featureSimilarity(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.max(0, Math.min(1, 1 - distance / 1.6));
}
