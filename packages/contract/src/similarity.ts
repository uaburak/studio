/*
 * Cheap near-duplicate detection for plan items (N6), local and free: normalised Turkish text,
 * character trigram shingles per word, Jaccard similarity.
 *
 * Turkish is agglutinative ("kış", "kışa", "kışın"), so whole-word overlap misses obvious
 * repeats; trigrams anchored at the start of each word ("^ki", "kis", "isa") survive the suffixes.
 * Words that appear in many texts of the same brand (its name, its main product) are dropped
 * before comparing, otherwise every post of an agricultural brand would look alike.
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
]);

/** Stems of the same kind of filler, with any suffix ("kutlaması", "mesajımız"). */
const STOP_STEMS = ["kutla", "tebrik", "mesaj", "duyuru", "kampanya", "indirim", "firsat"];

/** Topic words of a text (normalised, stop words out, at least two letters). */
export function topicWords(text: string): string[] {
  return normalizeTurkish(text)
    .split(" ")
    .filter(
      (w) => w.length >= 2 && !STOPWORDS.has(w) && !STOP_STEMS.some((stem) => w.startsWith(stem)),
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

/** A text to compare: what the post is about, its opening line, its brief. */
export interface SimilarityText {
  title: string;
  hook?: string | null;
  brief?: string | null;
}

export type SimilarityField = "title" | "hook" | "topic";

/** Thresholds (Jaccard of trigram sets) above which two texts count as near-duplicates. */
export const SIMILARITY_THRESHOLDS: Record<SimilarityField, number> = {
  title: 0.5,
  hook: 0.5,
  topic: 0.35,
};

/** Fewer distinct trigrams than this: too short to judge. */
const MIN_SHINGLES = 5;
/** A word in more than this share of the texts is the brand's vocabulary, not a topic. */
const COMMON_WORD_SHARE = 0.34;
/** …once there are at least this many texts. */
const COMMON_WORD_MIN_TEXTS = 6;

/** Words that appear in too many of the texts to tell them apart. */
export function commonWords(texts: readonly SimilarityText[]): Set<string> {
  const out = new Set<string>();
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

function prepare(t: SimilarityText, drop: ReadonlySet<string>): Prepared {
  // The brief's first sentence is its message; the rest is design direction ("sade, tipografik
  // tasarım…") that every brief of the brand shares.
  const brief = t.brief ? firstSentences(t.brief, 1) : "";
  return {
    title: shingles(topicWords(t.title), drop),
    hook: shingles(topicWords(t.hook ?? ""), drop),
    // Only when there is more than the title to compare.
    topic:
      t.hook || brief
        ? shingles(topicWords(`${t.title} ${t.hook ?? ""} ${brief}`), drop)
        : new Set<string>(),
  };
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

/** The first comparison that passes its threshold, the most specific first. */
function compare(a: Prepared, b: Prepared): SimilarityMatch | null {
  const pairs: Array<[SimilarityField, Set<string>, Set<string>]> = [
    ["hook", a.hook, b.hook],
    // A title against an opening line catches "same hook, new title".
    ["hook", a.title, b.hook],
    ["hook", a.hook, b.title],
    ["title", a.title, b.title],
    ["topic", a.topic, b.topic],
  ];
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
  drop: ReadonlySet<string> = new Set(),
): SimilarityMatch | null {
  return compare(prepare(a, drop), prepare(b, drop));
}

export interface SimilarityHit extends SimilarityMatch {
  /** Index into `against` (or into `items` for `sameList` hits). */
  index: number;
  sameList: boolean;
}

/**
 * For each item: the texts of `against` it nearly repeats, and (`withinList`) the earlier items
 * of the same list it repeats, best match first, at most `limit` per item.
 */
export function findNearDuplicates(
  items: readonly SimilarityText[],
  against: readonly SimilarityText[],
  options: { withinList?: boolean; limit?: number } = {},
): SimilarityHit[][] {
  const limit = options.limit ?? 2;
  const drop = commonWords([...items, ...against]);
  const preparedItems = items.map((t) => prepare(t, drop));
  const preparedAgainst = against.map((t) => prepare(t, drop));
  return preparedItems.map((item, i) => {
    const hits: SimilarityHit[] = [];
    preparedAgainst.forEach((other, index) => {
      const match = compare(item, other);
      if (match) hits.push({ ...match, index, sameList: false });
    });
    if (options.withinList) {
      for (let j = 0; j < i; j++) {
        const match = compare(item, preparedItems[j] as Prepared);
        if (match) hits.push({ ...match, index: j, sameList: true });
      }
    }
    return hits.sort((x, y) => y.score - x.score).slice(0, limit);
  });
}
