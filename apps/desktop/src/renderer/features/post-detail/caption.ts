// The caption as the editor shows it: the body and the trailing hashtag block, and the platform
// limits under the editor. Port of StudioKit's CaptionParts / CaptionLimits.
import type { Platform } from "@studio/contract";

export interface CaptionParts {
  body: string;
  hashtags: string[];
}

const isTagWord = (w: string) => w.startsWith("#") && w.length > 1;

/** Trailing lines made only of `#tags` become `hashtags`. */
export function splitCaption(caption: string): CaptionParts {
  const lines = caption.split("\n");
  let tags: string[] = [];
  while (lines.length > 0) {
    const trimmed = (lines.at(-1) ?? "").trim();
    if (!trimmed) {
      lines.pop();
      continue;
    }
    const words = trimmed.split(/[ \t]+/).filter(Boolean);
    if (words.length === 0 || !words.every(isTagWord)) break;
    tags = [...words, ...tags];
    lines.pop();
  }
  return { body: lines.join("\n").trim(), hashtags: tags };
}

/** Free text ("venta, #bor  çinko") → `#tags`. */
export function parseHashtags(text: string): string[] {
  return text
    .split(/[ ,\n\t]+/)
    .filter(Boolean)
    .map((w) => (w.startsWith("#") ? w : `#${w}`))
    .filter((w) => w.length > 1);
}

export function joinCaption(parts: CaptionParts): string {
  const tags = parts.hashtags.join(" ");
  if (!parts.body) return tags;
  if (!tags) return parts.body;
  return `${parts.body}\n\n${tags}`;
}

/** The caption the editor would save from its two fields. */
export function composeCaption(body: string, hashtags: string): string {
  return joinCaption({ body: body.trim(), hashtags: parseHashtags(hashtags) });
}

export const CAPTION_LIMIT: Record<Platform, number> = {
  instagram: 2_200,
  facebook: 63_206,
  linkedin: 3_000,
};

export const HASHTAG_LIMIT: Partial<Record<Platform, number>> = { instagram: 30 };

/** Characters as people count them (an emoji is one). */
export function characterCount(text: string): number {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter("tr", { granularity: "grapheme" });
    let n = 0;
    for (const _ of segmenter.segment(text)) n += 1;
    return n;
  }
  return Array.from(text).length;
}

export function hashtagCount(caption: string): number {
  return caption.split(/\s+/).filter(isTagWord).length;
}

export interface CaptionUsage {
  platform: Platform;
  characters: number;
  limit: number;
  hashtags: number;
  hashtagLimit: number | null;
  over: boolean;
  /** "1.234 / 2.200" */
  label: string;
}

const grouped = (n: number) => n.toLocaleString("tr-TR");

/** One usage line per target platform (Instagram when none is set). */
export function captionUsage(caption: string, platforms: readonly Platform[]): CaptionUsage[] {
  const targets = platforms.length > 0 ? platforms : (["instagram"] as Platform[]);
  const characters = characterCount(caption);
  const hashtags = hashtagCount(caption);
  return targets.map((platform) => {
    const limit = CAPTION_LIMIT[platform];
    const hashtagLimit = HASHTAG_LIMIT[platform] ?? null;
    return {
      platform,
      characters,
      limit,
      hashtags,
      hashtagLimit,
      over: characters > limit || (hashtagLimit !== null && hashtags > hashtagLimit),
      label: `${grouped(characters)} / ${grouped(limit)}`,
    };
  });
}
