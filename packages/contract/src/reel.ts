import { z } from "zod";
import { EntityId, type Platform } from "./common.ts";

/**
 * Reels (P6): the editable description of one 1080×1920 video.
 *
 * A reel version stores ONE slide whose `<main data-artboard>` carries:
 * - `data-video-asset-id`, `data-cover-asset-id`, `data-duration-ms`, `data-reel-recipe`
 *   (read by publishing and by older clients), and
 * - `data-reel-spec-b64`: base64 of the UTF-8 JSON `ReelSpec` below (what the editors show
 *   and what `content.render` re-renders from, without any AI call).
 *
 * The slide HTML (so the content hash and the approval) therefore covers the exact video.
 */

export const REEL_RECIPES = ["motion_graphics", "footage_edit", "narration"] as const;
export const ReelRecipe = z.enum(REEL_RECIPES).meta({ id: "ReelRecipe" });
export type ReelRecipe = z.infer<typeof ReelRecipe>;

/** Shortest reel any platform accepts. */
export const REEL_MIN_DURATION_MS = 3_000;
/** Longest reel Studio renders (Facebook Reels via API take at most 90 s). */
export const REEL_MAX_DURATION_MS = 90_000;

/** Duration limits per platform for vertical video publishing (`packages/publishers` rules). */
export const REEL_PLATFORM_LIMITS = {
  instagram: { minMs: 3_000, maxMs: 15 * 60_000, label: "Instagram Reels" },
  facebook: { minMs: 3_000, maxMs: 90_000, label: "Facebook Reels" },
  linkedin: { minMs: 3_000, maxMs: 30 * 60_000, label: "LinkedIn video" },
} as const satisfies Record<Platform, { minMs: number; maxMs: number; label: string }>;

const Ms = z
  .number()
  .int()
  .min(0)
  .max(30 * 60_000);

/** One motion-graphics scene (`motion_graphics`; `narration` uses headlines as visuals). */
export const ReelScene = z
  .object({
    eyebrow: z.string().max(80).default(""),
    headline: z.string().min(1).max(160),
    subhead: z.string().max(240).default(""),
    durationMs: z.number().int().min(800).max(20_000),
  })
  .meta({ id: "ReelScene" });
export type ReelScene = z.infer<typeof ReelScene>;
export type ReelSceneInput = z.input<typeof ReelScene>;

/** A timed text overlay burned into the video (`footage_edit` cut captions, titles). */
export const ReelOverlay = z
  .object({
    text: z.string().min(1).max(180),
    startMs: Ms,
    endMs: Ms,
  })
  .refine((o) => o.endMs > o.startMs, "endMs must be after startMs")
  .meta({ id: "ReelOverlay" });
export type ReelOverlay = z.infer<typeof ReelOverlay>;

/** One spoken word with its time (TTS alignment or transcription): burned-in captions. */
export const ReelWord = z
  .object({
    word: z.string().min(1).max(60),
    startMs: Ms,
    endMs: Ms,
  })
  .meta({ id: "ReelWord" });
export type ReelWord = z.infer<typeof ReelWord>;

export const ReelSpec = z
  .object({
    v: z.literal(1).default(1),
    recipe: ReelRecipe,
    /** Opening line, on screen in the first ~2 s. */
    hook: z.string().max(140).default(""),
    /** Closing line / sign-off. */
    cta: z.string().max(100).default(""),
    scenes: z.array(ReelScene).max(8).default([]),
    overlays: z.array(ReelOverlay).max(40).default([]),
    /** Voice-over text (`narration`); changing it re-synthesises the voice. */
    narrationScript: z.string().max(2_000).default(""),
    /** Word timings for burned-in captions (from TTS or the clip transcript). */
    words: z.array(ReelWord).max(2_000).default([]),
    /** Burn `words` in as captions. */
    captions: z.boolean().default(true),
    durationMs: z.number().int().min(REEL_MIN_DURATION_MS).max(REEL_MAX_DURATION_MS),
    /** Source footage (`footage_edit`) and where in it the reel starts. */
    clipAssetId: EntityId.nullable().default(null),
    clipStartMs: Ms.default(0),
    /** Music / voice track supplied by the user (replaces generated audio). */
    audioAssetId: EntityId.nullable().default(null),
    /** Still image used by the composition (product shot, background). */
    heroAssetId: EntityId.nullable().default(null),
    /** TTS voice (macOS `say` voice name or ElevenLabs voice id). */
    voice: z.string().max(64).nullable().default(null),
    /** Synthesised voice-over of `narrationScript` (reused until the script or voice changes). */
    voiceAssetId: EntityId.nullable().default(null),
    /** Frame used as the cover image; null = the worker's choice. */
    coverAtMs: Ms.nullable().default(null),
  })
  .meta({ id: "ReelSpec" });
export type ReelSpec = z.infer<typeof ReelSpec>;
export type ReelSpecInput = z.input<typeof ReelSpec>;

/**
 * Edits to a reel's spec (`content.render` payload `reel`): every field optional; arrays
 * replace the stored ones. Rendering applies it without any AI call.
 */
export const ReelSpecPatch = z
  .object({
    hook: z.string().max(140).optional(),
    cta: z.string().max(100).optional(),
    scenes: z.array(ReelScene).max(8).optional(),
    overlays: z.array(ReelOverlay).max(40).optional(),
    narrationScript: z.string().max(2_000).optional(),
    captions: z.boolean().optional(),
    durationMs: z.number().int().min(REEL_MIN_DURATION_MS).max(REEL_MAX_DURATION_MS).optional(),
    coverAtMs: Ms.nullable().optional(),
    voice: z.string().max(64).nullable().optional(),
  })
  .meta({ id: "ReelSpecPatch" });
export type ReelSpecPatch = z.infer<typeof ReelSpecPatch>;
export type ReelSpecPatchInput = z.input<typeof ReelSpecPatch>;

/**
 * Reel options of a `content.generate` job (payload key `reel`). All optional: without them
 * the worker infers the recipe from the brief and media.
 */
export const ReelGenerateOptions = z
  .object({
    recipe: ReelRecipe.optional(),
    clipAssetId: EntityId.optional(),
    audioAssetId: EntityId.optional(),
    heroAssetId: EntityId.optional(),
    /** Target length in seconds. */
    durationSec: z.number().min(3).max(90).optional(),
    voice: z.string().max(64).optional(),
    /** A complete spec: render it as is (no AI planning). */
    spec: ReelSpec.optional(),
  })
  .meta({ id: "ReelGenerateOptions" });
export type ReelGenerateOptions = z.infer<typeof ReelGenerateOptions>;
export type ReelGenerateOptionsInput = z.input<typeof ReelGenerateOptions>;

// --- Platform limits --------------------------------------------------------------

export interface ReelDurationIssue {
  platform: Platform;
  code: "reel_too_short" | "reel_too_long";
  /** Turkish, user-presentable. */
  message: string;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  if (s >= 60 && s % 60 === 0) return `${s / 60} dk`;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} sn`;
}

/** Duration problems of a reel for the given platforms (empty = publishable everywhere). */
export function reelDurationIssues(
  durationMs: number,
  platforms: readonly Platform[],
): ReelDurationIssue[] {
  const out: ReelDurationIssue[] = [];
  for (const platform of new Set(platforms)) {
    const limit = REEL_PLATFORM_LIMITS[platform];
    if (durationMs < limit.minMs) {
      out.push({
        platform,
        code: "reel_too_short",
        message: `${limit.label} en az ${seconds(limit.minMs)} olmalı; bu video ${seconds(durationMs)}.`,
      });
    } else if (durationMs > limit.maxMs) {
      out.push({
        platform,
        code: "reel_too_long",
        message: `${limit.label} en fazla ${seconds(limit.maxMs)} olabilir; bu video ${seconds(durationMs)}.`,
      });
    }
  }
  return out;
}

/** Longest reel Studio renders for these platforms. */
export function maxReelDurationMs(platforms: readonly Platform[]): number {
  let max: number = REEL_MAX_DURATION_MS;
  for (const p of platforms) max = Math.min(max, REEL_PLATFORM_LIMITS[p].maxMs);
  return max;
}

/** Clamp a requested duration into what Studio renders for these platforms. */
export function clampReelDurationMs(durationMs: number, platforms: readonly Platform[]): number {
  const rounded = Math.round(Number.isFinite(durationMs) ? durationMs : REEL_MIN_DURATION_MS);
  return Math.min(maxReelDurationMs(platforms), Math.max(REEL_MIN_DURATION_MS, rounded));
}

// --- Version slide encoding --------------------------------------------------------

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** `data-reel-spec-b64` value for a spec. */
export function encodeReelSpec(spec: ReelSpecInput): string {
  return toBase64(JSON.stringify(ReelSpec.parse(spec)));
}

/** Parse a `data-reel-spec-b64` value; null when missing or invalid. */
export function decodeReelSpec(b64: string | null | undefined): ReelSpec | null {
  if (!b64) return null;
  try {
    const parsed = ReelSpec.safeParse(JSON.parse(fromBase64(b64)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** What a reel version's slide HTML says about its video. */
export interface ReelVersionInfo {
  videoAssetId: string | null;
  coverAssetId: string | null;
  durationMs: number | null;
  recipe: ReelRecipe | null;
  spec: ReelSpec | null;
}

export function readReelVersionInfo(html: string): ReelVersionInfo {
  const attr = (name: string): string | null => {
    const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(html);
    return m?.[1] ? m[1] : null;
  };
  const spec = decodeReelSpec(attr("data-reel-spec-b64"));
  const rawRecipe = attr("data-reel-recipe");
  const recipe = ReelRecipe.safeParse(rawRecipe).success
    ? (rawRecipe as ReelRecipe)
    : (spec?.recipe ?? null);
  const rawDuration = attr("data-duration-ms");
  const durationMs =
    rawDuration && /^\d+$/.test(rawDuration) ? Number(rawDuration) : (spec?.durationMs ?? null);
  return {
    videoAssetId: attr("data-video-asset-id"),
    coverAssetId: attr("data-cover-asset-id"),
    durationMs,
    recipe,
    spec,
  };
}
