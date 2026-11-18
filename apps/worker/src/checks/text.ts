/**
 * Caption and copy helpers of the generation checks (pure): the trailing hashtag block,
 * character counts as people count them, banned-word matching that also catches Turkish
 * suffixes ("ücretsiz" → "ücretsizdir"), and the caption fixes (trim to a limit, keep at most
 * N unique hashtags).
 */

const isTagWord = (w: string) => /^#[\p{L}\p{N}_]+$/u.test(w);

export interface CaptionParts {
  body: string;
  /** The trailing lines made only of `#tags`, in order. */
  hashtags: string[];
}

/** Trailing lines made only of `#tags` become `hashtags` (same rule as the apps' editor). */
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

export function joinCaption(parts: CaptionParts): string {
  const tags = parts.hashtags.join(" ");
  if (!parts.body) return tags;
  if (!tags) return parts.body;
  return `${parts.body}\n\n${tags}`;
}

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

/** Every `#tag` in the text (body and trailing block), in order. */
export function hashtagsIn(text: string): string[] {
  return [...text.matchAll(/(?<![\p{L}\p{N}_#])#[\p{L}\p{N}_]+/gu)].map((m) => m[0]);
}

const fold = (s: string) => s.toLocaleLowerCase("tr-TR");

/** Hashtags that occur more than once (case-insensitive), each once. */
export function duplicateHashtags(text: string): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const tag of hashtagsIn(text)) {
    const key = fold(tag);
    if (seen.has(key)) dup.add(tag);
    seen.add(key);
  }
  return [...dup];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface BannedMatch {
  /** The banned entry as the brand wrote it. */
  word: string;
  /** What the text says (with suffix). */
  match: string;
  index: number;
}

/**
 * Banned words / phrases in `text`: case-insensitive (Turkish İ/ı), at a word start, any
 * suffix allowed after the last word (Turkish agglutination), spaces in a phrase match any
 * whitespace. Each banned entry is reported once per text.
 */
export function findBannedWords(text: string, words: readonly string[]): BannedMatch[] {
  if (!text.trim() || words.length === 0) return [];
  const lower = fold(text);
  const out: BannedMatch[] = [];
  for (const word of words) {
    const w = fold(word.trim());
    if (!w) continue;
    const pattern = w.split(/\s+/).map(escapeRegExp).join("\\s+");
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}[\\p{L}\\p{N}'’]*`, "u");
    const m = re.exec(lower);
    if (!m) continue;
    out.push({ word, match: text.slice(m.index, m.index + m[0].length), index: m.index });
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * The caption shortened to `limit` characters: the hashtag block is kept when it fits, the body
 * is cut at the last sentence end (else the last word) before the budget and ends with "…" when
 * cut mid-sentence. Returns the caption unchanged when it already fits.
 */
export function trimCaption(caption: string, limit: number): string {
  if (characterCount(caption) <= limit) return caption;
  const parts = splitCaption(caption);
  let tags = parts.hashtags;
  const tagText = () => (tags.length ? `\n\n${tags.join(" ")}` : "");
  // Hashtags take at most a third of the room.
  while (tags.length > 0 && characterCount(tagText()) > Math.floor(limit / 3)) {
    tags = tags.slice(0, -1);
  }
  const budget = limit - characterCount(tagText());
  const graphemes = Array.from(
    new Intl.Segmenter("tr", { granularity: "grapheme" }).segment(parts.body),
    (s) => s.segment,
  );
  const head = graphemes.slice(0, Math.max(0, budget)).join("");
  let body = head;
  const sentenceEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
    head.lastIndexOf("\n"),
  );
  if (sentenceEnd >= head.length * 0.5) {
    body = head.slice(0, sentenceEnd + 1).trimEnd();
  } else {
    const room = Array.from(head)
      .slice(0, Math.max(0, budget - 1))
      .join("");
    const space = room.lastIndexOf(" ");
    body = `${(space > room.length * 0.5 ? room.slice(0, space) : room).trimEnd()}…`;
  }
  const out = joinCaption({ body, hashtags: tags });
  return characterCount(out) <= limit ? out : Array.from(out).slice(0, limit).join("");
}

/**
 * At most `max` hashtags, duplicates removed (case-insensitive). Only the trailing block is
 * changed; tags in the body stay (and count toward `max`).
 */
export function limitHashtags(caption: string, max: number | null): string {
  const parts = splitCaption(caption);
  const bodyTags = new Set(hashtagsIn(parts.body).map(fold));
  const kept: string[] = [];
  const seen = new Set<string>(bodyTags);
  for (const tag of parts.hashtags) {
    const key = fold(tag);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(tag);
  }
  const room = max === null ? kept.length : Math.max(0, max - bodyTags.size);
  return joinCaption({ body: parts.body, hashtags: kept.slice(0, room) });
}

/** First `max` characters with an ellipsis (for messages). */
export function excerpt(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
