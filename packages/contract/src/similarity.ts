/*
 * Cheap near-duplicate detection for plan items (N6), local and free: normalised Turkish text,
 * character trigram shingles per word, Jaccard similarity.
 *
 * Turkish is agglutinative ("kış", "kışa", "kışın"), so whole-word overlap misses obvious
 * repeats; trigrams anchored at the start of each word ("^ki", "kis", "isa") survive the suffixes.
 *
 * The signal must be precise or it is noise that pushes the agent to rewrite good plans, so
 * everything a brand's posts share by design is removed before comparing:
 * - numbers (numbering "03 ·", years, dates) and hashtags;
 * - recurring title segments: a series name ("Bu haftanın şarkısı · <şarkı>") or a pillar prefix
 *   ("Topluluk · …") that appears as a separate segment in two or more titles;
 * - pillar names;
 * - words in many texts of the brand (its name, its main product) and trigrams in many texts
 *   (suffix variants of the brand's vocabulary: "şarkı", "şarkını", "şarkısı").
 * Items of the same plan are compared by title and opening line only: briefs of one plan share
 * the brand's message by design.
 */

const FOLD: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  i̇: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

/** Lower-cased (Turkish rules), diacritics folded, only letters and digits, single spaces. */
export function normalizeTurkish(text: string): string {
  return text
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşüâîû]|i̇/g, (c) => FOLD[c] ?? c)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/#[\p{L}\p{N}_]+/gu, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Function words and planning filler that say nothing about the topic. */
const STOPWORDS = new Set([
  "ve",
  "ile",
  "icin",
  "bir",
  "bu",
  "su",
  "o",
  "da",
  "de",
  "ki",
  "mi",
  "mu",
  "ne",
  "cok",
  "en",
  "gibi",
  "daha",
  "her",
  "olan",
  "olarak",
  "ama",
  "veya",
  "ya",
  "hem",
  "kadar",
  "sonra",
  "once",
  "nasil",
  "neden",
  "icinde",
  "uzerine",
  "hakkinda",
  "sen",
  "siz",
  "biz",
  "ben",
  "senin",
  "sizin",
  "bizim",
  "post",
  "postu",
  "paylasim",
  "gorsel",
  "carousel",
  "story",
  "reel",
  "reels",
  "video",
  "icerik",
  "metin",
  "baslik",
  "kanca",
  "cta",
  "marka",
  "markanin",
  "musteri",
  "takipci",
  "takipciler",
  "instagram",
  "linkedin",
  "facebook",
  // Words every special-day or campaign post shares ("… Günü kutlaması", "… indirimi").
  "gun",
  "gunu",
  "gunun",
  "gunumuz",
  "gunler",
  "gunleri",
  // Words of recurring series titles ("Bu haftanın şarkısı", "Ayın ürünü").
  "hafta",
  "haftanin",
  "haftalik",
  "ayin",
  "aylik",
  "bugun",
  "bugunun",
]);

/** Stems of the same kind of filler, with any suffix ("kutlaması", "mesajımız"). */
const STOP_STEMS = ["kutla", "tebrik", "mesaj", "duyuru", "kampanya", "indirim", "firsat"];

/** Topic words of a text (normalised, stop words out, at least two letters). */
export function topicWords(text: string): string[] {
  return normalizeTurkish(text)
    .split(" ")
    .filter(
      (w) =>
        w.length >= 2 &&
        !/\d/.test(w) &&
        !STOPWORDS.has(w) &&
        !STOP_STEMS.some((stem) => w.startsWith(stem)),
    );
}

/** Character trigrams anchored at the start of each word ("kisa" → ^ki, kis, isa). */
export function shingles(
  words: readonly string[],
  drop: ReadonlySet<string> = new Set(),
): Set<string> {
  const out = new Set<string>();
  for (const word of words) {
    if (drop.has(word)) continue;
    const w = `^${word}`;
    if (w.length <= 3) {
      out.add(w);
      continue;
    }
    for (let i = 0; i + 3 <= w.length; i++) out.add(w.slice(i, i + 3));
  }
  return out;
}

export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const x of a) if (b.has(x)) shared++;
  return shared / (a.size + b.size - shared);
}

/** A text to compare: what the post is about, its opening line, its brief, its pillar. */
export interface SimilarityText {
  title: string;
  hook?: string | null;
  brief?: string | null;
  /** Content pillar: its words are shared by design and say nothing about the topic. */
  pillar?: string | null;
}

export type SimilarityField = "title" | "hook" | "topic";

/** Thresholds (Jaccard of trigram sets) above which two texts count as near-duplicates. */
export const SIMILARITY_THRESHOLDS: Record<SimilarityField, number> = {
  title: 0.5,
  hook: 0.5,
  topic: 0.35,
};

/**
 * From this score a near-duplicate is strong: the same topic said almost the same way. Only
 * strong ones are worth stopping the plan agent for; weaker ones are a mark on the card.
 */
export const STRONG_SIMILARITY = 0.6;

export function isStrongSimilarity(match: { score: number }): boolean {
  return match.score >= STRONG_SIMILARITY;
}

/** Fewer distinct trigrams than this: too short to judge. */
const MIN_SHINGLES = 5;
/** A word in more than this share of the texts is the brand's vocabulary, not a topic. */
const COMMON_WORD_SHARE = 0.25;
/** …once there are at least this many texts. */
const COMMON_WORD_MIN_TEXTS = 6;
/** A trigram in more than this share of the texts carries no topic (suffix variants included). */
const COMMON_SHINGLE_SHARE = 0.2;
/** …once there are at least this many texts. */
const COMMON_SHINGLE_MIN_TEXTS = 10;

/** Title segments: "03 · Bu haftanın şarkısı · Halil Sezai – Olsun" → three segments. */
const SEGMENT_SPLIT = /\s*[·•|:–—/]\s*|\s+-\s+/;

/** The normalised topic-word segments of a title or hook (empty ones, e.g. "03", out). */
function segmentsOf(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .split(SEGMENT_SPLIT)
    .map((seg) => topicWords(seg).join(" "))
    .filter(Boolean);
}

/**
 * Recurring title labels: a series name or pillar prefix leading two or more titles as its own
 * segment ("Bu haftanın şarkısı · …", "Topluluk · …"). Only the leading segment counts: a shared
 * later segment ("… · Halil Sezai – Olsun") is the topic itself.
 */
export function seriesSegments(texts: readonly SimilarityText[]): Set<string> {
  const df = new Map<string, number>();
  for (const t of texts) {
    const [lead, ...rest] = segmentsOf(t.title);
    if (!lead || rest.length === 0) continue;
    df.set(lead, (df.get(lead) ?? 0) + 1);
  }
  return new Set([...df].filter(([, n]) => n >= 2).map(([seg]) => seg));
}

/** The words of a title or hook without its series segments (all kept if nothing else is left). */
function wordsWithoutSeries(
  text: string | null | undefined,
  series: ReadonlySet<string>,
): string[] {
  const segs = segmentsOf(text);
  const kept = segs.filter((s) => !series.has(s));
  return (kept.length > 0 ? kept : segs).join(" ").split(" ").filter(Boolean);
}

/** Words that appear in too many of the texts to tell them apart, and the pillars' words. */
export function commonWords(texts: readonly SimilarityText[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const w of topicWords(t.pillar ?? "")) out.add(w);
  if (texts.length < COMMON_WORD_MIN_TEXTS) return out;
  const df = new Map<string, number>();
  for (const t of texts) {
    for (const w of new Set(topicWords(`${t.title} ${t.hook ?? ""}`))) {
      df.set(w, (df.get(w) ?? 0) + 1);
    }
  }
  for (const [word, n] of df) if (n / texts.length > COMMON_WORD_SHARE) out.add(word);
  return out;
}

interface Prepared {
  title: Set<string>;
  hook: Set<string>;
  topic: Set<string>;
}

interface Vocabulary {
  words: ReadonlySet<string>;
  series: ReadonlySet<string>;
  shingles: ReadonlySet<string>;
}

function without(set: Set<string>, drop: ReadonlySet<string>): Set<string> {
  if (drop.size === 0) return set;
  return new Set([...set].filter((s) => !drop.has(s)));
}

function prepare(t: SimilarityText, vocab: Vocabulary): Prepared {
  // The brief's first sentence is its message; the rest is design direction ("sade, tipografik
  // tasarım…") that every brief of the brand shares.
  const brief = t.brief ? firstSentences(t.brief, 1) : "";
  const title = wordsWithoutSeries(t.title, vocab.series);
  const hook = wordsWithoutSeries(t.hook, vocab.series);
  const sh = (words: string[]) => without(shingles(words, vocab.words), vocab.shingles);
  return {
    title: sh(title),
    hook: sh(hook),
    // Only when there is more than the title to compare.
    topic: hook.length || brief ? sh([...title, ...hook, ...topicWords(brief)]) : new Set<string>(),
  };
}

/** What the texts share by design: common and pillar words, series segments, common trigrams. */
function vocabulary(texts: readonly SimilarityText[]): Vocabulary {
  const words = commonWords(texts);
  const series = seriesSegments(texts);
  const common = new Set<string>();
  if (texts.length >= COMMON_SHINGLE_MIN_TEXTS) {
    const df = new Map<string, number>();
    for (const t of texts) {
      const set = shingles(
        [...wordsWithoutSeries(t.title, series), ...wordsWithoutSeries(t.hook, series)],
        words,
      );
      for (const s of set) df.set(s, (df.get(s) ?? 0) + 1);
    }
    for (const [s, n] of df) if (n / texts.length > COMMON_SHINGLE_SHARE) common.add(s);
  }
  return { words, series, shingles: common };
}

/** The first `n` sentences (the brief's main message; the rest is design detail). */
function firstSentences(text: string, n: number): string {
  const parts = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return parts.slice(0, n).join(" ");
}

export interface SimilarityMatch {
  field: SimilarityField;
  score: number;
}

/**
 * The best comparison that passes its threshold. `withTopic: false` compares only titles and
 * opening lines (items of one plan share the brand's message in their briefs by design).
 */
function compare(a: Prepared, b: Prepared, withTopic = true): SimilarityMatch | null {
  const pairs: Array<[SimilarityField, Set<string>, Set<string>]> = [
    ["hook", a.hook, b.hook],
    // A title against an opening line catches "same hook, new title".
    ["hook", a.title, b.hook],
    ["hook", a.hook, b.title],
    ["title", a.title, b.title],
  ];
  if (withTopic) pairs.push(["topic", a.topic, b.topic]);
  for (const [field, x, y] of pairs) {
    if (x.size < MIN_SHINGLES || y.size < MIN_SHINGLES) continue;
    const score = jaccard(x, y);
    if (score >= SIMILARITY_THRESHOLDS[field]) return { field, score };
  }
  return null;
}

/** Similarity of two texts (null when they are not near-duplicates). */
export function textSimilarity(
  a: SimilarityText,
  b: SimilarityText,
  options: { withTopic?: boolean } = {},
): SimilarityMatch | null {
  const vocab = vocabulary([a, b]);
  return compare(prepare(a, vocab), prepare(b, vocab), options.withTopic ?? true);
}

export interface SimilarityHit extends SimilarityMatch {
  /** Index into `against` (or into `items` for `sameList` hits). */
  index: number;
  sameList: boolean;
}

/**
 * For each item: the texts of `against` it nearly repeats, and (`withinList`) the earlier items
 * of the same list it repeats by title or opening line, best match first, at most `limit` per
 * item.
 */
export function findNearDuplicates(
  items: readonly SimilarityText[],
  against: readonly SimilarityText[],
  options: { withinList?: boolean; limit?: number } = {},
): SimilarityHit[][] {
  const limit = options.limit ?? 2;
  const vocab = vocabulary([...items, ...against]);
  const preparedItems = items.map((t) => prepare(t, vocab));
  const preparedAgainst = against.map((t) => prepare(t, vocab));
  return preparedItems.map((item, i) => {
    const hits: SimilarityHit[] = [];
    preparedAgainst.forEach((other, index) => {
      const match = compare(item, other);
      if (match) hits.push({ ...match, index, sameList: false });
    });
    if (options.withinList) {
      for (let j = 0; j < i; j++) {
        const match = compare(item, preparedItems[j] as Prepared, false);
        if (match) hits.push({ ...match, index: j, sameList: true });
      }
    }
    return hits.sort((x, y) => y.score - x.score).slice(0, limit);
  });
}
