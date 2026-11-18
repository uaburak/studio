// Special days and plan similarity as plain values (N5, N6), tested without views: the small
// labels the Takvim cells, the week header and the Planlar view show, the "Benzer: 12 Ekim postu"
// mark of a plan item, the brand's special-day settings form and the bayram date corrections.
import {
  type BrandPlanningSettings,
  type BrandPlanningSettingsPut,
  effectiveSectorTags,
  type PlanItem,
  type ReligiousDayOverride,
  SECTOR_TAGS,
  type SectorTag,
  SIMILAR_FIELD_LABEL,
  SPECIAL_DAY_CATEGORIES,
  SPECIAL_DAY_CATEGORY_LABEL,
  type SpecialDay,
  type SpecialDayCategory,
  type SpecialDayOverrides,
  similarLabel,
  specialDayLabel,
  specialDaysBetween,
  specialDaysByDate,
} from "@studio/contract";
import { addDays, type DayKey, type MonthKey, monthGrid } from "./calendar-model.ts";

// --- calendar labels ---------------------------------------------------------------------------

/** How a label looks: a public holiday, a religious day, a day of remembrance, anything else. */
export type DayLabelTone = "holiday" | "religious" | "remembrance" | "other";

export interface DayLabel {
  /** Unique per day (a bayram has one label on each of its days). */
  key: string;
  text: string;
  /** Tooltip: what kind of day it is, the holiday, the note. */
  title: string;
  tone: DayLabelTone;
}

export function dayLabelTone(day: Pick<SpecialDay, "holiday" | "category" | "tone">): DayLabelTone {
  if (day.holiday === "full") return "holiday";
  if (day.category === "dini") return "religious";
  if (day.tone === "anma") return "remembrance";
  return "other";
}

export function dayLabelTitle(day: SpecialDay, on: DayKey): string {
  return [
    specialDayLabel(day, on),
    day.holiday === "full" ? "Resmî tatil" : day.holiday === "half" ? "Yarım gün resmî tatil" : "",
    SPECIAL_DAY_CATEGORY_LABEL[day.category],
    day.approximate ? "Tarih hesaplandı, ±1 gün kayabilir" : "",
    day.note ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const IMPORTANCE_RANK = { high: 0, normal: 1, low: 2 } as const;

/** Labels per day (bayrams on each of their days), holidays and important days first. */
export function labelsByDay(days: readonly SpecialDay[]): Map<DayKey, DayLabel[]> {
  const out = new Map<DayKey, DayLabel[]>();
  for (const [date, list] of specialDaysByDate(days)) {
    const sorted = [...list].sort(
      (a, b) =>
        Number(b.holiday === "full") - Number(a.holiday === "full") ||
        IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance],
    );
    out.set(
      date,
      sorted.map((d) => ({
        key: `${d.id}-${date}`,
        text: specialDayLabel(d, date),
        title: dayLabelTitle(d, date),
        tone: dayLabelTone(d),
      })),
    );
  }
  return out;
}

/** The days a month grid shows (its first to last cell). */
export function gridRange(month: MonthKey): { from: DayKey; to: DayKey } {
  const cells = monthGrid(month);
  return { from: cells[0]?.day ?? "", to: cells[cells.length - 1]?.day ?? "" };
}

/** The week of `days` (Monday first). */
export function weekRange(days: readonly DayKey[]): { from: DayKey; to: DayKey } {
  const first = days[0] ?? "";
  return { from: first, to: days[days.length - 1] ?? addDays(first, 6) };
}

// --- plan items ------------------------------------------------------------------------------------

/** An item's marks; plans cached from an older server have none. */
export function marksOf(item: Partial<Pick<PlanItem, "similar">>): PlanItem["similar"] {
  return item.similar ?? [];
}

/** "Benzer: 12 Ekim postu" for an item with near-duplicates (the best match); null otherwise. */
export function similarText(item: Partial<Pick<PlanItem, "similar">>): string | null {
  const best = marksOf(item)[0];
  return best ? `Benzer: ${similarLabel(best)}` : null;
}

/** Tooltip: every match with its title and what was alike. */
export function similarTitle(item: Partial<Pick<PlanItem, "similar">>): string {
  return marksOf(item)
    .map(
      (s) =>
        `${similarLabel(s)}: “${s.title}” (${SIMILAR_FIELD_LABEL[s.field]} benzerliği %${Math.round(s.score * 100)})`,
    )
    .join("\n");
}

/** The special days of a plan's period worth showing above its items (low priority left out). */
export function planSpecialDays(days: readonly SpecialDay[]): SpecialDay[] {
  return days.filter((d) => d.importance !== "low" || d.holiday !== null);
}

// --- brand settings form -----------------------------------------------------------------------------

export interface PlanningDraft {
  tags: Set<SectorTag>;
  disabled: Set<SpecialDayCategory>;
  /** The tags are the suggestion from the brand profile (never saved yet). */
  suggested: boolean;
}

export function planningDraft(settings: BrandPlanningSettings): PlanningDraft {
  return {
    tags: new Set(effectiveSectorTags(settings)),
    disabled: new Set(settings.disabledCategories),
    suggested: settings.updatedAt === null && settings.suggestedTags.length > 0,
  };
}

export function toggleTag(draft: PlanningDraft, tag: SectorTag): PlanningDraft {
  const tags = new Set(draft.tags);
  if (tags.has(tag)) tags.delete(tag);
  else tags.add(tag);
  return { ...draft, tags, suggested: false };
}

export function toggleDayCategory(
  draft: PlanningDraft,
  category: SpecialDayCategory,
  on: boolean,
): PlanningDraft {
  const disabled = new Set(draft.disabled);
  if (on) disabled.delete(category);
  else disabled.add(category);
  return { ...draft, disabled };
}

/** The PUT body, in catalogue order. */
export function planningPut(draft: PlanningDraft): BrandPlanningSettingsPut {
  return {
    sectorTags: SECTOR_TAGS.filter((t) => draft.tags.has(t)),
    disabledCategories: SPECIAL_DAY_CATEGORIES.filter((c) => draft.disabled.has(c)),
  };
}

/** Examples of a category's days, for the settings form. */
export const CATEGORY_EXAMPLES: Record<SpecialDayCategory, string> = {
  resmi: "Yılbaşı, 23 Nisan, 19 Mayıs, 30 Ağustos, 29 Ekim",
  dini: "Ramazan ve Kurban Bayramı, kandiller, Ramazan'ın başlangıcı",
  anma: "10 Kasım, 18 Mart, 6 Şubat",
  ticari: "Sevgililer Günü, Anneler Günü, 11.11, Black Friday, yılbaşı gecesi",
  toplumsal: "Kadınlar Günü, Öğretmenler Günü",
  sektor: "Seçtiğin sektörlerin günleri (ör. Dünya Çiftçiler Günü)",
};

// --- bayram dates (every brand) ------------------------------------------------------------------------

export interface BayramRow {
  year: number;
  /** First days in effect (override or computed / Diyanet). */
  ramazan: string;
  kurban: string;
  /** Without the owner's correction. */
  computedRamazan: string;
  computedKurban: string;
  /** Computed only (not in Diyanet's table): ±1 day. */
  approximate: boolean;
}

function firstDay(days: readonly SpecialDay[], ruleId: string): SpecialDay | undefined {
  return days.find((d) => d.ruleId === ruleId);
}

/** Bayram dates per year: computed (or Diyanet's) and the owner's corrections. */
export function bayramRows(
  years: readonly number[],
  overrides: SpecialDayOverrides["overrides"],
): BayramRow[] {
  return years.map((year) => {
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const base = specialDaysBetween(from, to).filter((d) => d.date.startsWith(`${year}-`));
    const own = overrides.find((o) => o.year === year);
    const ramazan = firstDay(base, "ramazan-bayrami");
    const kurban = firstDay(base, "kurban-bayrami");
    return {
      year,
      ramazan: own?.ramazanBayrami ?? ramazan?.date ?? "",
      kurban: own?.kurbanBayrami ?? kurban?.date ?? "",
      computedRamazan: ramazan?.date ?? "",
      computedKurban: kurban?.date ?? "",
      approximate: Boolean(ramazan?.approximate || kurban?.approximate),
    };
  });
}

/** The corrections to save: only dates that differ from the computed ones; other years kept. */
export function overridesPut(
  rows: readonly BayramRow[],
  existing: SpecialDayOverrides["overrides"],
): ReligiousDayOverride[] {
  const shown = new Set(rows.map((r) => r.year));
  const kept: ReligiousDayOverride[] = existing.filter((o) => !shown.has(o.year));
  const changed = rows.flatMap((r): ReligiousDayOverride[] => {
    const ramazan = r.ramazan && r.ramazan !== r.computedRamazan ? r.ramazan : null;
    const kurban = r.kurban && r.kurban !== r.computedKurban ? r.kurban : null;
    return ramazan || kurban
      ? [{ year: r.year, ramazanBayrami: ramazan, kurbanBayrami: kurban }]
      : [];
  });
  return [...kept, ...changed].sort((a, b) => a.year - b.year);
}
