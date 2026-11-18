import { z } from "zod";
import { EntityId, Timestamp } from "./common.ts";
import { ContentType } from "./content.ts";
import { IsoDate, MAX_PLAN_PERIOD_DAYS, monthPeriod, type PlanItemSimilar } from "./plan.ts";
import { findNearDuplicates, normalizeTurkish, topicWords } from "./similarity.ts";
import {
  addDaysIso,
  ReligiousDayOverride,
  SECTOR_TAGS,
  SectorTag,
  SPECIAL_DAY_CATEGORIES,
  SpecialDay,
  SpecialDayCategory,
} from "./special-days.ts";

/*
 * Planning context (N5, N6): the brand's special-day settings (sector tags, switched-off
 * categories), owner corrections of the bayram dates, and the compact history of the brand's last
 * months that the plan agent reads before planning (posts with their topic, pillar, opening line,
 * type and day; other plans; what was rejected, left out or deleted). Plan items are compared
 * with that history (similarity.ts) and near-duplicates are marked on the item (`similar`).
 */

const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;

// --- brand settings ------------------------------------------------------------------------------

/** `GET /api/brands/{brandId}/planning-settings`: defaults (`updatedAt: null`) until saved once. */
export const BrandPlanningSettings = z
  .object({
    brandId: EntityId,
    /** Sector tags the owner chose (used once saved; before that `suggestedTags`). */
    sectorTags: z.array(SectorTag),
    /** Special-day categories switched off for this brand. */
    disabledCategories: z.array(SpecialDayCategory),
    /** Tags guessed from the brand profile and products. */
    suggestedTags: z.array(SectorTag),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: "BrandPlanningSettings" });
export type BrandPlanningSettings = z.infer<typeof BrandPlanningSettings>;

export const BrandPlanningSettingsPut = z
  .object({
    sectorTags: z
      .array(SectorTag)
      .max(SECTOR_TAGS.length)
      .refine(unique, "a tag is listed twice")
      .default([]),
    disabledCategories: z
      .array(SpecialDayCategory)
      .max(SPECIAL_DAY_CATEGORIES.length)
      .refine(unique, "a category is listed twice")
      .default([]),
  })
  .meta({ id: "BrandPlanningSettingsPut" });
export type BrandPlanningSettingsPut = z.input<typeof BrandPlanningSettingsPut>;

/** The tags in effect: the owner's once saved, the suggestion before. */
export function effectiveSectorTags(
  settings: Pick<BrandPlanningSettings, "sectorTags" | "suggestedTags" | "updatedAt">,
): SectorTag[] {
  return settings.updatedAt === null ? settings.suggestedTags : settings.sectorTags;
}

// --- bayram date overrides (every brand) --------------------------------------------------------

export const MAX_RELIGIOUS_DAY_OVERRIDES = 40;

/** `GET /api/special-days/overrides`. */
export const SpecialDayOverrides = z
  .object({
    overrides: z.array(
      z.object({
        year: z.number().int(),
        ramazanBayrami: IsoDate.nullable(),
        kurbanBayrami: IsoDate.nullable(),
      }),
    ),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: "SpecialDayOverrides" });
export type SpecialDayOverrides = z.infer<typeof SpecialDayOverrides>;

export const SpecialDayOverridesPut = z
  .object({
    overrides: z
      .array(ReligiousDayOverride)
      .max(MAX_RELIGIOUS_DAY_OVERRIDES)
      .refine((l) => unique(l.map((o) => o.year)), "a year is listed twice")
      .refine(
        (l) =>
          l.every(
            (o) =>
              (!o.ramazanBayrami || o.ramazanBayrami.startsWith(`${o.year}-`)) &&
              (!o.kurbanBayrami || o.kurbanBayrami.startsWith(`${o.year}-`)),
          ),
        "a date must fall in its year",
      ),
  })
  .meta({ id: "SpecialDayOverridesPut" });
export type SpecialDayOverridesPut = z.input<typeof SpecialDayOverridesPut>;

// --- special days query -------------------------------------------------------------------------

export const MAX_SPECIAL_DAYS_SPAN = 400;

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** `GET /api/special-days?from&to[&brandId]`. */
export const SpecialDaysQuery = z
  .object({ from: IsoDate, to: IsoDate, brandId: EntityId.optional() })
  .refine((q) => q.from <= q.to, "from must not be after to")
  .refine(
    (q) => spanDays(q.from, q.to) < MAX_SPECIAL_DAYS_SPAN,
    `at most ${MAX_SPECIAL_DAYS_SPAN} days`,
  );
export type SpecialDaysQuery = z.input<typeof SpecialDaysQuery>;

export const SpecialDayList = z
  .object({
    from: IsoDate,
    to: IsoDate,
    /** The brand's tags in effect (empty without a brand). */
    tags: z.array(SectorTag),
    disabledCategories: z.array(SpecialDayCategory),
    days: z.array(SpecialDay),
  })
  .meta({ id: "SpecialDayList" });
export type SpecialDayList = z.infer<typeof SpecialDayList>;

// --- history -------------------------------------------------------------------------------------

/**
 * - `post`: a post of the brand (published, scheduled, approved or a draft);
 * - `planned`: an item of another open plan (not accepted yet);
 * - `rejected`: an item of a rejected plan;
 * - `skipped`: an item left out when its plan was accepted;
 * - `deleted`: a post in the trash.
 */
export const PlanningHistoryKind = z
  .enum(["post", "planned", "rejected", "skipped", "deleted"])
  .meta({ id: "PlanningHistoryKind" });
export type PlanningHistoryKind = z.infer<typeof PlanningHistoryKind>;

export const PlanningHistoryEntry = z
  .object({
    kind: PlanningHistoryKind,
    contentId: EntityId.nullable(),
    planId: EntityId.nullable(),
    planItemId: EntityId.nullable(),
    /** The post's day: published / scheduled, else its plan day, else when it was made. */
    date: IsoDate.nullable(),
    title: z.string(),
    /** Opening line: the caption's first line, or the plan item's planned hook. */
    hook: z.string().nullable(),
    /** The brief's first sentences (for the similarity check; not shown to the agent). */
    brief: z.string().nullable(),
    pillar: z.string().nullable(),
    contentType: ContentType,
    /** Content status for posts (`published`, `scheduled`…), null otherwise. */
    status: z.string().nullable(),
    /** Why the plan was rejected (the owner's words), when given. */
    reason: z.string().nullable(),
  })
  .meta({ id: "PlanningHistoryEntry" });
export type PlanningHistoryEntry = z.infer<typeof PlanningHistoryEntry>;

export const PlanningHistory = z
  .object({
    from: IsoDate,
    to: IsoDate,
    /** Newest first. */
    entries: z.array(PlanningHistoryEntry),
    /** More entries existed than were sent. */
    truncated: z.boolean(),
  })
  .meta({ id: "PlanningHistory" });
export type PlanningHistory = z.infer<typeof PlanningHistory>;

/** Months of history before the planned period. */
export const HISTORY_MONTHS = 3;
export const MAX_HISTORY_ENTRIES = 120;

/** History window: the first day of the month three months before the period, to its end. */
export function historyWindow(
  periodStart: string,
  periodEnd: string,
): { from: string; to: string } {
  const year = Number(periodStart.slice(0, 4));
  const month = Number(periodStart.slice(5, 7));
  const index = year * 12 + (month - 1) - HISTORY_MONTHS;
  const from = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`;
  return { from, to: periodEnd };
}

/** First meaningful line of a caption (hashtags, mentions and emoji stripped), ≤ 160 characters. */
export function hookOf(caption: string | null | undefined): string | null {
  if (!caption) return null;
  for (const raw of caption.split(/\r?\n/)) {
    const line = raw
      .replace(/[#@][\p{L}\p{N}_.]+/gu, " ")
      .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (/[\p{L}\p{N}]/u.test(line)) return line.length > 160 ? `${line.slice(0, 157)}…` : line;
  }
  return null;
}

/** The brief a plan item's post is generated from: its brief plus the planned opening line. */
export function briefWithHook(brief: string, hook: string | null | undefined): string {
  const line = hook?.trim();
  if (!line || brief.includes(line)) return brief;
  return `${brief.trim()}\n\nAçılış cümlesi (kanca): ${line}`.trim();
}

export const PlanningContextQuery = z
  .object({ periodStart: IsoDate, periodEnd: IsoDate })
  .refine((q) => q.periodStart <= q.periodEnd, "periodEnd must not be before periodStart")
  .refine(
    (q) => spanDays(q.periodStart, q.periodEnd) < MAX_PLAN_PERIOD_DAYS,
    `a plan covers at most ${MAX_PLAN_PERIOD_DAYS} days`,
  );
export type PlanningContextQuery = z.input<typeof PlanningContextQuery>;

/** `GET /api/brands/{brandId}/planning-context`: what the plan agent reads before planning. */
export const PlanningContext = z
  .object({
    brandId: EntityId,
    periodStart: IsoDate,
    periodEnd: IsoDate,
    settings: BrandPlanningSettings,
    /** Special days of the period for this brand (tags and categories applied). */
    specialDays: z.array(SpecialDay),
    history: PlanningHistory,
  })
  .meta({ id: "PlanningContext" });
export type PlanningContext = z.infer<typeof PlanningContext>;

// --- similarity marks -----------------------------------------------------------------------------

export interface SimilarityCandidate {
  /** The item's id (null before it is saved). */
  id?: string | null;
  title: string;
  hook?: string | null;
  brief?: string | null;
  date?: string | null;
}

/**
 * Near-duplicates of each item among the history and the plan's earlier items (best first, at
 * most two). The plan's own items in the history (same `planItemId`) are skipped.
 */
export function planItemSimilarities(
  items: readonly SimilarityCandidate[],
  history: readonly PlanningHistoryEntry[],
): PlanItemSimilar[][] {
  const own = new Set(items.map((i) => i.id).filter((id): id is string => !!id));
  const against = history.filter((e) => !(e.planItemId && own.has(e.planItemId)));
  const hits = findNearDuplicates(items, against, { withinList: true, limit: 2 });
  return hits.map((list) =>
    list.map((hit): PlanItemSimilar => {
      const score = Math.round(hit.score * 100) / 100;
      if (hit.sameList) {
        const other = items[hit.index] as SimilarityCandidate;
        return {
          kind: "same_plan",
          contentId: null,
          planItemId: other.id ?? null,
          title: other.title,
          date: other.date ?? null,
          field: hit.field,
          score,
        };
      }
      const entry = against[hit.index] as PlanningHistoryEntry;
      return {
        kind: entry.kind,
        contentId: entry.contentId,
        planItemId: entry.planItemId,
        title: entry.title,
        date: entry.date,
        field: hit.field,
        score,
      };
    }),
  );
}

const MONTHS_TR = [
  "Ocak",
  "Şubat",
  "Mart",
  "Nisan",
  "Mayıs",
  "Haziran",
  "Temmuz",
  "Ağustos",
  "Eylül",
  "Ekim",
  "Kasım",
  "Aralık",
];

/** `"2026-10-12"` → `"12 Ekim"`. */
export function dayMonthTr(iso: string): string {
  const month = MONTHS_TR[Number(iso.slice(5, 7)) - 1] ?? "";
  return `${Number(iso.slice(8, 10))} ${month}`;
}

function quoted(title: string): string {
  const t = title.trim();
  return `“${t.length > 40 ? `${t.slice(0, 39)}…` : t}”`;
}

/** What a mark points at, for "Benzer: …" (e.g. "12 Ekim postu"). */
export function similarLabel(s: Pick<PlanItemSimilar, "kind" | "title" | "date">): string {
  const day = s.date ? dayMonthTr(s.date) : null;
  switch (s.kind) {
    case "post":
      return day ? `${day} postu` : `${quoted(s.title)} postu`;
    case "planned":
      return day ? `${day} için planlanan post` : `planlanan ${quoted(s.title)}`;
    case "rejected":
      return `reddedilen ${quoted(s.title)}`;
    case "skipped":
      return `plandan çıkarılan ${quoted(s.title)}`;
    case "deleted":
      return day ? `silinen ${day} postu` : `silinen ${quoted(s.title)}`;
    case "same_plan":
      return day ? `bu plandaki ${day} postu` : `bu plandaki ${quoted(s.title)}`;
  }
}

export const SIMILAR_FIELD_LABEL: Record<PlanItemSimilar["field"], string> = {
  title: "konu",
  hook: "kanca",
  topic: "içerik",
};

// --- planning turns ---------------------------------------------------------------------------------

/** Today in Türkiye (UTC+3 all year since 2016). */
export function istanbulToday(now: Date): string {
  return new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
}

const MONTH_STEMS = [
  "ocak",
  "subat",
  "mart",
  "nisan",
  "mayis",
  "haziran",
  "temmuz",
  "agustos",
  "eylul",
  "ekim",
  "kasim",
  "aralik",
];
const MONTH_RE = new RegExp(`\\b(${MONTH_STEMS.join("|")}|araligi|araliga|aralikta)\\w*`, "g");

function monthsIn(normalized: string): number[] {
  const out: number[] = [];
  for (const match of normalized.matchAll(MONTH_RE)) {
    const word = match[1] ?? "";
    const index = MONTH_STEMS.findIndex((m) => word.startsWith(m));
    if (index >= 0 && !out.includes(index + 1)) out.push(index + 1);
  }
  return out;
}

/** Whether a message asks for planning (a plan, a calendar, posts for a month). */
export function looksLikePlanning(text: string): boolean {
  const n = normalizeTurkish(text);
  if (/\b(plan\w*|takvim\w*|aylik|haftalik|ozel gun\w*)\b/.test(n)) return true;
  return monthsIn(n).length > 0 && /\b(post\w*|icerik\w*|paylasim\w*)\b/.test(n);
}

const NUMBER_WORDS: Record<string, number> = { bir: 1, iki: 2, uc: 3, dort: 4 };

const monthKey = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/** The month after today's. */
export function nextMonthPeriod(today: string): { periodStart: string; periodEnd: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return monthPeriod(month === 12 ? monthKey(year + 1, 1) : monthKey(year, month + 1));
}

/**
 * The period a planning message most likely means: the months it names (the next occurrence of
 * each; "2027" moves them), "bu ay", "N hafta", otherwise the next month.
 */
export function planningPeriodFromText(
  text: string,
  today: string,
): { periodStart: string; periodEnd: string } {
  return namedPeriod(text, today) ?? nextMonthPeriod(today);
}

/** The period a message names (months, "bu ay", "N hafta"), or null when it names none. */
export function namedPeriod(
  text: string,
  today: string,
): { periodStart: string; periodEnd: string } | null {
  const n = normalizeTurkish(text);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));

  const weeks = /\b(\d|bir|iki|uc|dort) hafta/.exec(n);
  if (weeks && !monthsIn(n).length) {
    const count = Number(weeks[1]) || NUMBER_WORDS[weeks[1] ?? ""] || 1;
    const start = addDaysIso(today, 1);
    return { periodStart: start, periodEnd: addDaysIso(start, Math.min(count * 7, 91) - 1) };
  }
  if (/\bbu (ay|ayki|ayin)\b/.test(n) && !monthsIn(n).length)
    return monthPeriod(monthKey(year, month));

  const named = monthsIn(n);
  if (named.length === 0) return null;
  const explicitYear = /\b(20\d\d)\b/.exec(n);
  const keys = named
    .map((m) => {
      if (explicitYear) return monthKey(Number(explicitYear[1]), m);
      return monthKey(m < month ? year + 1 : year, m);
    })
    .sort();
  const first = monthPeriod(keys[0] as string);
  const last = monthPeriod(keys[keys.length - 1] as string);
  const end =
    spanDays(first.periodStart, last.periodEnd) < MAX_PLAN_PERIOD_DAYS
      ? last.periodEnd
      : addDaysIso(first.periodStart, MAX_PLAN_PERIOD_DAYS - 1);
  return { periodStart: first.periodStart, periodEnd: end };
}

// --- sector tags from the brand ----------------------------------------------------------------------

/** Word stems per tag (normalised: no Turkish letters); a word matches when it starts with one. */
const TAG_KEYWORDS: Record<SectorTag, readonly string[]> = {
  tarim: [
    "tarim",
    "ciftci",
    "gubre",
    "tohum",
    "zirai",
    "ziraat",
    "hasat",
    "sera",
    "tarla",
    "fide",
    "sulama",
    "agro",
    "toprak",
    "bitki",
    "hububat",
    "bugday",
    "fidan",
  ],
  gida: [
    "gida",
    "yemek",
    "restoran",
    "kafe",
    "kahve",
    "tatli",
    "pasta",
    "firin",
    "mutfak",
    "lezzet",
    "menu",
    "icecek",
    "cikolata",
    "lokanta",
    "catering",
    "lezzetli",
  ],
  saglik: [
    "saglik",
    "klinik",
    "hastane",
    "doktor",
    "hekim",
    "eczane",
    "ilac",
    "tedavi",
    "diyetisyen",
    "fizyoterapi",
    "medikal",
    "tibbi",
    "poliklinik",
  ],
  egitim: [
    "egitim",
    "okul",
    "kurs",
    "ogrenci",
    "ogretmen",
    "akademi",
    "universite",
    "kolej",
    "dershane",
    "ogrenim",
  ],
  teknoloji: [
    "teknoloji",
    "yazilim",
    "dijital",
    "bilisim",
    "siber",
    "saas",
    "donanim",
    "elektronik",
    "uygulama",
    "yapay",
  ],
  cevre: [
    "surdurulebilir",
    "cevre",
    "geri",
    "karbon",
    "yenilenebilir",
    "ekolojik",
    "iklim",
    "dogaya",
  ],
  moda: [
    "moda",
    "giyim",
    "butik",
    "kozmetik",
    "guzellik",
    "makyaj",
    "cilt",
    "kuafor",
    "taki",
    "aksesuar",
    "ayakkabi",
    "tekstil",
    "parfum",
  ],
  eticaret: ["magaza", "eticaret", "perakende", "alisveris", "siparis", "kargo", "indirim"],
  evcil: ["evcil", "kedi", "kopek", "veteriner", "mama", "petshop"],
  turizm: ["otel", "turizm", "tatil", "seyahat", "pansiyon", "resort", "konaklama", "acente"],
  finans: [
    "finans",
    "banka",
    "sigorta",
    "yatirim",
    "muhasebe",
    "kredi",
    "odeme",
    "borsa",
    "fintek",
  ],
  spor: ["spor", "fitness", "antrenman", "kosu", "yoga", "pilates", "sporcu"],
  insaat: ["insaat", "mimar", "yapi", "emlak", "gayrimenkul", "dekorasyon", "konut"],
  hukuk: ["hukuk", "avukat", "noter", "dava"],
  kultur: ["sanat", "galeri", "muze", "tiyatro", "konser", "muzik", "kitap", "yayinevi", "sinema"],
};

function stemMatches(word: string, stem: string): boolean {
  if (stem.length <= 4)
    return word === stem || (word.startsWith(stem) && word.length <= stem.length + 3);
  return word.startsWith(stem);
}

/**
 * Sector tags guessed from the brand: its name, product names / categories / tags (strong) and
 * the profile's voice, rules and facts (weak). A tag needs two hits (a strong one counts two);
 * at most three, best first.
 */
export function suggestSectorTags(input: {
  strong: readonly string[];
  weak: readonly string[];
}): SectorTag[] {
  const strong = topicWords(input.strong.join(" "));
  const weak = topicWords(input.weak.join(" "));
  const scores: Array<[SectorTag, number]> = [];
  for (const tag of SECTOR_TAGS) {
    let score = 0;
    for (const stem of TAG_KEYWORDS[tag]) {
      if (strong.some((w) => stemMatches(w, stem))) score += 2;
      else if (weak.some((w) => stemMatches(w, stem))) score += 1;
    }
    if (score >= 2) scores.push([tag, score]);
  }
  return scores
    .sort((a, b) => b[1] - a[1] || SECTOR_TAGS.indexOf(a[0]) - SECTOR_TAGS.indexOf(b[0]))
    .slice(0, 3)
    .map(([tag]) => tag);
}
