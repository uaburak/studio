import { z } from "zod";
import {
  hijriMonthKey,
  hijriToIso,
  hijriYearsBetween,
  isoOfJulianDay,
  julianDayOf,
} from "./hijri.ts";

/*
 * Türkiye's special days for content planning (N5): official public holidays (fixed dates and
 * the religious bayrams computed from the Hijri calendar, see hijri.ts), other religious days,
 * days of remembrance, commercial and social days, and sector days that only matter to brands
 * with a matching sector tag (tarım, sağlık, eğitim…). Pure functions over `YYYY-MM-DD` dates:
 * the API, the worker (plan prompt) and the desktop (Takvim, Planlar) all compute the same list.
 */

/** `YYYY-MM-DD`. */
const Day = z.iso.date();

export const SpecialDayCategory = z
  .enum(["resmi", "dini", "anma", "ticari", "toplumsal", "sektor"])
  .meta({ id: "SpecialDayCategory" });
export type SpecialDayCategory = z.infer<typeof SpecialDayCategory>;
export const SPECIAL_DAY_CATEGORIES = SpecialDayCategory.options;

export const SPECIAL_DAY_CATEGORY_LABEL: Record<SpecialDayCategory, string> = {
  resmi: "Resmî tatiller ve millî bayramlar",
  dini: "Dinî bayramlar ve günler",
  anma: "Anma günleri",
  ticari: "Ticari günler",
  toplumsal: "Toplumsal günler",
  sektor: "Sektör günleri",
};

export const SectorTag = z
  .enum([
    "tarim",
    "gida",
    "saglik",
    "egitim",
    "teknoloji",
    "cevre",
    "moda",
    "eticaret",
    "evcil",
    "turizm",
    "finans",
    "spor",
    "insaat",
    "hukuk",
    "kultur",
  ])
  .meta({ id: "SectorTag" });
export type SectorTag = z.infer<typeof SectorTag>;
export const SECTOR_TAGS = SectorTag.options;

export const SECTOR_TAG_LABEL: Record<SectorTag, string> = {
  tarim: "Tarım",
  gida: "Gıda ve içecek",
  saglik: "Sağlık",
  egitim: "Eğitim",
  teknoloji: "Teknoloji",
  cevre: "Çevre",
  moda: "Moda ve güzellik",
  eticaret: "Perakende ve e-ticaret",
  evcil: "Evcil hayvan",
  turizm: "Turizm",
  finans: "Finans",
  spor: "Spor",
  insaat: "Mimarlık ve inşaat",
  hukuk: "Hukuk",
  kultur: "Kültür ve sanat",
};

/** How a post on that day should sound. */
export const SpecialDayTone = z
  .enum(["kutlama", "milli", "dini", "anma", "ticari", "farkindalik"])
  .meta({ id: "SpecialDayTone" });
export type SpecialDayTone = z.infer<typeof SpecialDayTone>;

export const SPECIAL_DAY_TONE_GUIDE: Record<SpecialDayTone, string> = {
  kutlama: "sıcak, kutlama tonu; ürün ancak hafifçe görünür",
  milli:
    "millî bayram: gururlu, ölçülü kutlama; bayrak ve Atatürk görselleri saygıyla, satış dili yok",
  dini: "dinî gün: saygılı, sade tebrik; indirim ya da satış çağrısı yok, mizah yok",
  anma: "anma: ciddi ve sade; ürün, kampanya, emoji ve renkli neşeli tasarım yok",
  ticari:
    "kampanya dili serbest; ancak markanın gerçek bir kampanyası yoksa uydurma, genel içerik yap",
  farkindalik: "farkındalık / bilgi tonu; markanın uzmanlığıyla ilgili faydalı bir bilgi",
};

export const SpecialDayImportance = z
  .enum(["high", "normal", "low"])
  .meta({ id: "SpecialDayImportance" });
export type SpecialDayImportance = z.infer<typeof SpecialDayImportance>;

/** One special day (or a multi-day bayram) in a period. */
export const SpecialDay = z
  .object({
    /** `<ruleId>-<YYYY>`: stable per year. */
    id: z.string(),
    ruleId: z.string(),
    /** First day. */
    date: Day,
    /** Length in days (Ramazan Bayramı 3, Kurban Bayramı 4, otherwise 1). */
    days: z.number().int().min(1),
    name: z.string(),
    category: SpecialDayCategory,
    /** Sector tags the day belongs to (sector days) or matters most for. */
    tags: z.array(SectorTag),
    /** Public holiday: the whole day(s) or half a day (arife, 28 Ekim). */
    holiday: z.enum(["full", "half"]).nullable(),
    tone: SpecialDayTone,
    /** For this brand: `high` = worth a post, `normal` = fits, `low` = only if it suits the brand. */
    importance: SpecialDayImportance,
    /** Days before the day when a teaser / campaign post makes sense (0 = on the day). */
    leadDays: z.number().int().min(0),
    note: z.string().nullable(),
    /** Computed from the Hijri calendar and not confirmed by Diyanet or an override (±1 day). */
    approximate: z.boolean(),
  })
  .meta({ id: "SpecialDay" });
export type SpecialDay = z.infer<typeof SpecialDay>;

/**
 * An owner's correction of a year's religious bayram dates (the first day), when Diyanet's
 * announced date differs from the computed one.
 */
export const ReligiousDayOverride = z
  .object({
    year: z.number().int().min(2000).max(2100),
    ramazanBayrami: Day.nullable().default(null),
    kurbanBayrami: Day.nullable().default(null),
  })
  .meta({ id: "ReligiousDayOverride" });
export type ReligiousDayOverride = z.input<typeof ReligiousDayOverride>;

/**
 * First days of Ramazan and Kurban Bayramı as Diyanet announced them (its "Dinî Günler"
 * calendar). The computation agrees with every entry (test/special-days.test.ts); the table pins
 * them anyway, so a future change to the computation cannot move an announced date.
 */
export const DIYANET_BAYRAM_DATES: readonly {
  year: number;
  ramazanBayrami: string;
  kurbanBayrami: string;
}[] = [
  { year: 2025, ramazanBayrami: "2025-03-30", kurbanBayrami: "2025-06-06" },
  { year: 2026, ramazanBayrami: "2026-03-20", kurbanBayrami: "2026-05-27" },
  { year: 2027, ramazanBayrami: "2027-03-09", kurbanBayrami: "2027-05-16" },
  { year: 2028, ramazanBayrami: "2028-02-26", kurbanBayrami: "2028-05-05" },
  { year: 2029, ramazanBayrami: "2029-02-14", kurbanBayrami: "2029-04-24" },
  { year: 2030, ramazanBayrami: "2030-02-04", kurbanBayrami: "2030-04-13" },
];

// --- rules ------------------------------------------------------------------------------------

type When =
  | { kind: "fixed"; month: number; day: number }
  /** `n`-th `weekday` (0 = Sunday) of `month`; `n = -1` is the last one. */
  | { kind: "nth"; month: number; weekday: number; n: number }
  /** A day of the Hijri calendar. */
  | { kind: "hijri"; month: number; day: number }
  /** Regaip Kandili: the Thursday evening before the first Friday of Recep. */
  | { kind: "regaip" }
  /** Computed from the year. */
  | { kind: "custom"; of(year: number): string };

interface Rule {
  id: string;
  name: string;
  category: SpecialDayCategory;
  when: When;
  days?: number;
  holiday?: "full" | "half";
  tone: SpecialDayTone;
  importance: SpecialDayImportance;
  /** Sector days: the tags that bring the day in. Other days: tags that make it `high`. */
  tags?: SectorTag[];
  leadDays?: number;
  note?: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;
export function addDaysIso(iso: string, delta: number): string {
  return isoOfJulianDay(julianDayOf(iso) + delta);
}
/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(iso: string): number {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  if (n > 0) {
    const first = ymd(year, month, 1);
    const shift = (weekday - weekdayOf(first) + 7) % 7;
    return addDaysIso(first, shift + (n - 1) * 7);
  }
  const last = isoOfJulianDay(
    julianDayOf(ymd(month === 12 ? year + 1 : year, (month % 12) + 1, 1)) - 1,
  );
  const back = (weekdayOf(last) - weekday + 7) % 7;
  return addDaysIso(last, -back);
}

/** Black Friday: the Friday after the fourth Thursday of November (US Thanksgiving). */
function blackFriday(year: number): string {
  return addDaysIso(nthWeekday(year, 11, 4, 4), 1);
}

const RAMAZAN_BAYRAMI = { kind: "hijri", month: 10, day: 1 } as const;
const KURBAN_BAYRAMI = { kind: "hijri", month: 12, day: 10 } as const;

const AG = ["tarim", "cevre"] as SectorTag[];

/** The catalogue. Dates of religious days follow Diyanet's convention (a kandil is listed on the evening's date). */
const RULES: readonly Rule[] = [
  // Resmî tatiller ve millî bayramlar
  {
    id: "yilbasi",
    name: "Yılbaşı",
    category: "resmi",
    when: { kind: "fixed", month: 1, day: 1 },
    holiday: "full",
    tone: "kutlama",
    importance: "high",
    note: "Yeni yıl tebriği; 31 Aralık akşamı ya da 1 Ocak sabahı.",
  },
  {
    id: "23-nisan",
    name: "Ulusal Egemenlik ve Çocuk Bayramı",
    category: "resmi",
    when: { kind: "fixed", month: 4, day: 23 },
    holiday: "full",
    tone: "milli",
    importance: "high",
    tags: ["egitim"],
  },
  {
    id: "1-mayis",
    name: "Emek ve Dayanışma Günü",
    category: "resmi",
    when: { kind: "fixed", month: 5, day: 1 },
    holiday: "full",
    tone: "kutlama",
    importance: "normal",
    note: "Emeğe teşekkür tonu; siyasi slogan yok.",
  },
  {
    id: "19-mayis",
    name: "Atatürk'ü Anma, Gençlik ve Spor Bayramı",
    category: "resmi",
    when: { kind: "fixed", month: 5, day: 19 },
    holiday: "full",
    tone: "milli",
    importance: "high",
    tags: ["spor", "egitim"],
  },
  {
    id: "15-temmuz",
    name: "Demokrasi ve Millî Birlik Günü",
    category: "resmi",
    when: { kind: "fixed", month: 7, day: 15 },
    holiday: "full",
    tone: "anma",
    importance: "normal",
    note: "Anma tonu; kampanya yapma.",
  },
  {
    id: "30-agustos",
    name: "Zafer Bayramı",
    category: "resmi",
    when: { kind: "fixed", month: 8, day: 30 },
    holiday: "full",
    tone: "milli",
    importance: "high",
  },
  {
    id: "cumhuriyet-arifesi",
    name: "Cumhuriyet Bayramı arifesi",
    category: "resmi",
    when: { kind: "fixed", month: 10, day: 28 },
    holiday: "half",
    tone: "milli",
    importance: "low",
    note: "Öğleden sonra resmî tatil.",
  },
  {
    id: "29-ekim",
    name: "Cumhuriyet Bayramı",
    category: "resmi",
    when: { kind: "fixed", month: 10, day: 29 },
    holiday: "full",
    tone: "milli",
    importance: "high",
  },

  // Dinî bayramlar ve günler
  {
    id: "ramazan-bayrami-arifesi",
    name: "Ramazan Bayramı arifesi",
    category: "dini",
    when: { kind: "hijri", month: 9, day: 0 },
    holiday: "half",
    tone: "dini",
    importance: "normal",
    note: "Öğleden sonra resmî tatil; bayram tebriği arife akşamı ya da ilk gün paylaşılabilir.",
  },
  {
    id: "ramazan-bayrami",
    name: "Ramazan Bayramı",
    category: "dini",
    when: RAMAZAN_BAYRAMI,
    days: 3,
    holiday: "full",
    tone: "dini",
    importance: "high",
    note: "Tebrik postu (ilk gün ya da arife); indirim çağrısı yapma.",
  },
  {
    id: "kurban-bayrami-arifesi",
    name: "Kurban Bayramı arifesi",
    category: "dini",
    when: { kind: "hijri", month: 12, day: 9 },
    holiday: "half",
    tone: "dini",
    importance: "normal",
    note: "Öğleden sonra resmî tatil.",
  },
  {
    id: "kurban-bayrami",
    name: "Kurban Bayramı",
    category: "dini",
    when: KURBAN_BAYRAMI,
    days: 4,
    holiday: "full",
    tone: "dini",
    importance: "high",
    note: "Tebrik postu; kurban görseli kullanma, sade tasarım.",
  },
  {
    id: "ramazan-baslangici",
    name: "Ramazan ayının başlangıcı",
    category: "dini",
    when: { kind: "hijri", month: 9, day: 1 },
    tone: "dini",
    importance: "normal",
    note: '"Hoş geldin Ramazan" tonu; ay boyunca iftar / sahur temalı içerik olabilir.',
  },
  {
    id: "kadir-gecesi",
    name: "Kadir Gecesi",
    category: "dini",
    when: { kind: "hijri", month: 9, day: 26 },
    tone: "dini",
    importance: "low",
  },
  {
    id: "regaip-kandili",
    name: "Regaip Kandili",
    category: "dini",
    when: { kind: "regaip" },
    tone: "dini",
    importance: "low",
  },
  {
    id: "mirac-kandili",
    name: "Miraç Kandili",
    category: "dini",
    when: { kind: "hijri", month: 7, day: 26 },
    tone: "dini",
    importance: "low",
  },
  {
    id: "berat-kandili",
    name: "Berat Kandili",
    category: "dini",
    when: { kind: "hijri", month: 8, day: 14 },
    tone: "dini",
    importance: "low",
  },
  {
    id: "mevlid-kandili",
    name: "Mevlid Kandili",
    category: "dini",
    when: { kind: "hijri", month: 3, day: 11 },
    tone: "dini",
    importance: "low",
  },
  {
    id: "hicri-yilbasi",
    name: "Hicri Yılbaşı",
    category: "dini",
    when: { kind: "hijri", month: 1, day: 1 },
    tone: "dini",
    importance: "low",
  },
  {
    id: "asure-gunu",
    name: "Aşure Günü",
    category: "dini",
    when: { kind: "hijri", month: 1, day: 10 },
    tone: "dini",
    importance: "low",
    tags: ["gida"],
  },

  // Anma günleri
  {
    id: "6-subat",
    name: "6 Şubat depremlerinin yıl dönümü",
    category: "anma",
    when: { kind: "fixed", month: 2, day: 6 },
    tone: "anma",
    importance: "normal",
    note: "Yalnızca sade bir anma; o gün kampanya ve neşeli post paylaşma.",
  },
  {
    id: "istiklal-marsi",
    name: "İstiklal Marşı'nın Kabulü",
    category: "anma",
    when: { kind: "fixed", month: 3, day: 12 },
    tone: "milli",
    importance: "low",
  },
  {
    id: "canakkale",
    name: "Çanakkale Zaferi ve Şehitleri Anma Günü",
    category: "anma",
    when: { kind: "fixed", month: 3, day: 18 },
    tone: "anma",
    importance: "high",
  },
  {
    id: "10-kasim",
    name: "Atatürk'ü Anma Günü",
    category: "anma",
    when: { kind: "fixed", month: 11, day: 10 },
    tone: "anma",
    importance: "high",
    note: "Sade, siyah-beyaz anma; ürün ve kampanya yok. Saat 09.05'e dikkat; o gün başka post paylaşma.",
  },

  // Ticari günler
  {
    id: "sevgililer-gunu",
    name: "Sevgililer Günü",
    category: "ticari",
    when: { kind: "fixed", month: 2, day: 14 },
    tone: "ticari",
    importance: "normal",
    tags: ["moda", "eticaret", "gida"],
    leadDays: 7,
  },
  {
    id: "anneler-gunu",
    name: "Anneler Günü",
    category: "ticari",
    when: { kind: "nth", month: 5, weekday: 0, n: 2 },
    tone: "kutlama",
    importance: "high",
    tags: ["moda", "eticaret", "gida"],
    leadDays: 7,
    note: "Mayıs'ın ikinci pazarı; hediye fikirleri bir hafta önceden.",
  },
  {
    id: "babalar-gunu",
    name: "Babalar Günü",
    category: "ticari",
    when: { kind: "nth", month: 6, weekday: 0, n: 3 },
    tone: "kutlama",
    importance: "normal",
    tags: ["moda", "eticaret"],
    leadDays: 7,
    note: "Haziran'ın üçüncü pazarı.",
  },
  {
    id: "11-11",
    name: "11.11 indirim günü",
    category: "ticari",
    when: { kind: "fixed", month: 11, day: 11 },
    tone: "ticari",
    importance: "low",
    tags: ["moda", "eticaret"],
    leadDays: 3,
  },
  {
    id: "black-friday",
    name: "Black Friday (Kara Cuma)",
    category: "ticari",
    when: { kind: "custom", of: blackFriday },
    tone: "ticari",
    importance: "normal",
    tags: ["moda", "eticaret", "teknoloji"],
    leadDays: 7,
    note: 'Türkiye\'de "Efsane Cuma", "Muhteşem Cuma" gibi adlarla da anılır; gerçek kampanya yoksa paylaşma.',
  },
  {
    id: "cyber-monday",
    name: "Cyber Monday (Siber Pazartesi)",
    category: "ticari",
    when: { kind: "custom", of: (y) => addDaysIso(blackFriday(y), 3) },
    tone: "ticari",
    importance: "low",
    tags: ["eticaret", "teknoloji"],
    leadDays: 2,
  },
  {
    id: "yilbasi-gecesi",
    name: "Yılbaşı gecesi",
    category: "ticari",
    when: { kind: "fixed", month: 12, day: 31 },
    tone: "kutlama",
    importance: "normal",
    tags: ["moda", "eticaret", "gida", "turizm"],
    leadDays: 14,
    note: "Hediye ve kutlama içerikleri Aralık ortasından başlar.",
  },

  // Toplumsal günler
  {
    id: "kadinlar-gunu",
    name: "Dünya Kadınlar Günü",
    category: "toplumsal",
    when: { kind: "fixed", month: 3, day: 8 },
    tone: "kutlama",
    importance: "high",
    note: "İndirim değil; kadınlara saygı ve dayanışma tonu.",
  },
  {
    id: "ogretmenler-gunu",
    name: "Öğretmenler Günü",
    category: "toplumsal",
    when: { kind: "fixed", month: 11, day: 24 },
    tone: "kutlama",
    importance: "normal",
    tags: ["egitim"],
  },
  {
    id: "cocuk-haklari",
    name: "Dünya Çocuk Hakları Günü",
    category: "toplumsal",
    when: { kind: "fixed", month: 11, day: 20 },
    tone: "farkindalik",
    importance: "low",
    tags: ["egitim"],
  },
  {
    id: "kadina-siddet",
    name: "Kadına Yönelik Şiddete Karşı Uluslararası Mücadele Günü",
    category: "toplumsal",
    when: { kind: "fixed", month: 11, day: 25 },
    tone: "anma",
    importance: "low",
  },
  {
    id: "engelliler-gunu",
    name: "Dünya Engelliler Günü",
    category: "toplumsal",
    when: { kind: "fixed", month: 12, day: 3 },
    tone: "farkindalik",
    importance: "low",
    tags: ["saglik"],
  },
  {
    id: "kadin-haklari",
    name: "Kadın Hakları Günü",
    category: "toplumsal",
    when: { kind: "fixed", month: 12, day: 5 },
    tone: "farkindalik",
    importance: "low",
    note: "Türk kadınına seçme ve seçilme hakkının verilişi (1934).",
  },

  // Sektör günleri
  {
    id: "dunya-ciftciler-gunu",
    name: "Dünya Çiftçiler Günü",
    category: "sektor",
    when: { kind: "fixed", month: 5, day: 14 },
    tone: "kutlama",
    importance: "high",
    tags: ["tarim"],
  },
  {
    id: "dunya-gida-gunu",
    name: "Dünya Gıda Günü",
    category: "sektor",
    when: { kind: "fixed", month: 10, day: 16 },
    tone: "farkindalik",
    importance: "high",
    tags: ["tarim", "gida"],
  },
  {
    id: "dunya-toprak-gunu",
    name: "Dünya Toprak Günü",
    category: "sektor",
    when: { kind: "fixed", month: 12, day: 5 },
    tone: "farkindalik",
    importance: "high",
    tags: AG,
  },
  {
    id: "dunya-ari-gunu",
    name: "Dünya Arı Günü",
    category: "sektor",
    when: { kind: "fixed", month: 5, day: 20 },
    tone: "farkindalik",
    importance: "normal",
    tags: AG,
  },
  {
    id: "dunya-su-gunu",
    name: "Dünya Su Günü",
    category: "sektor",
    when: { kind: "fixed", month: 3, day: 22 },
    tone: "farkindalik",
    importance: "normal",
    tags: AG,
  },
  {
    id: "dunya-ormancilik-gunu",
    name: "Dünya Ormancılık Günü",
    category: "sektor",
    when: { kind: "fixed", month: 3, day: 21 },
    tone: "farkindalik",
    importance: "low",
    tags: ["cevre"],
  },
  {
    id: "dunya-sut-gunu",
    name: "Dünya Süt Günü",
    category: "sektor",
    when: { kind: "fixed", month: 6, day: 1 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["tarim", "gida"],
  },
  {
    id: "dunya-meteoroloji-gunu",
    name: "Dünya Meteoroloji Günü",
    category: "sektor",
    when: { kind: "fixed", month: 3, day: 23 },
    tone: "farkindalik",
    importance: "low",
    tags: ["tarim"],
  },
  {
    id: "colesme-gunu",
    name: "Çölleşme ve Kuraklıkla Mücadele Günü",
    category: "sektor",
    when: { kind: "fixed", month: 6, day: 17 },
    tone: "farkindalik",
    importance: "normal",
    tags: AG,
  },
  {
    id: "gida-israfi-gunu",
    name: "Gıda Kaybı ve İsrafı Farkındalık Günü",
    category: "sektor",
    when: { kind: "fixed", month: 9, day: 29 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["gida", "tarim", "cevre"],
  },
  {
    id: "gida-guvenligi-gunu",
    name: "Dünya Gıda Güvenliği Günü",
    category: "sektor",
    when: { kind: "fixed", month: 6, day: 7 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["gida"],
  },
  {
    id: "kahve-gunu",
    name: "Uluslararası Kahve Günü",
    category: "sektor",
    when: { kind: "fixed", month: 10, day: 1 },
    tone: "kutlama",
    importance: "normal",
    tags: ["gida"],
  },
  {
    id: "turk-kahvesi-gunu",
    name: "Dünya Türk Kahvesi Günü",
    category: "sektor",
    when: { kind: "fixed", month: 12, day: 5 },
    tone: "kutlama",
    importance: "normal",
    tags: ["gida"],
  },
  {
    id: "cay-gunu",
    name: "Uluslararası Çay Günü",
    category: "sektor",
    when: { kind: "fixed", month: 5, day: 21 },
    tone: "kutlama",
    importance: "low",
    tags: ["gida"],
  },
  {
    id: "ascilar-gunu",
    name: "Dünya Aşçılar Günü",
    category: "sektor",
    when: { kind: "fixed", month: 10, day: 20 },
    tone: "kutlama",
    importance: "low",
    tags: ["gida"],
  },
  {
    id: "cikolata-gunu",
    name: "Dünya Çikolata Günü",
    category: "sektor",
    when: { kind: "fixed", month: 7, day: 7 },
    tone: "kutlama",
    importance: "low",
    tags: ["gida"],
  },
  {
    id: "dunya-kanser-gunu",
    name: "Dünya Kanser Günü",
    category: "sektor",
    when: { kind: "fixed", month: 2, day: 4 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["saglik"],
  },
  {
    id: "tip-bayrami",
    name: "Tıp Bayramı",
    category: "sektor",
    when: { kind: "fixed", month: 3, day: 14 },
    tone: "kutlama",
    importance: "high",
    tags: ["saglik"],
  },
  {
    id: "dunya-saglik-gunu",
    name: "Dünya Sağlık Günü",
    category: "sektor",
    when: { kind: "fixed", month: 4, day: 7 },
    tone: "farkindalik",
    importance: "high",
    tags: ["saglik"],
  },
  {
    id: "hemsireler-gunu",
    name: "Uluslararası Hemşireler Günü",
    category: "sektor",
    when: { kind: "fixed", month: 5, day: 12 },
    tone: "kutlama",
    importance: "normal",
    tags: ["saglik"],
  },
  {
    id: "eczacilik-gunu",
    name: "Eczacılık Günü",
    category: "sektor",
    when: { kind: "fixed", month: 5, day: 14 },
    tone: "kutlama",
    importance: "normal",
    tags: ["saglik"],
  },
  {
    id: "tutunsuz-gun",
    name: "Dünya Tütünsüz Günü",
    category: "sektor",
    when: { kind: "fixed", month: 5, day: 31 },
    tone: "farkindalik",
    importance: "low",
    tags: ["saglik"],
  },
  {
    id: "dunya-kalp-gunu",
    name: "Dünya Kalp Günü",
    category: "sektor",
    when: { kind: "fixed", month: 9, day: 29 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["saglik", "spor"],
  },
  {
    id: "ruh-sagligi-gunu",
    name: "Dünya Ruh Sağlığı Günü",
    category: "sektor",
    when: { kind: "fixed", month: 10, day: 10 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["saglik"],
  },
  {
    id: "diyabet-gunu",
    name: "Dünya Diyabet Günü",
    category: "sektor",
    when: { kind: "fixed", month: 11, day: 14 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["saglik", "gida"],
  },
  {
    id: "dis-hekimleri-gunu",
    name: "Diş Hekimleri Günü",
    category: "sektor",
    when: { kind: "fixed", month: 11, day: 22 },
    tone: "kutlama",
    importance: "normal",
    tags: ["saglik"],
  },
  {
    id: "egitim-gunu",
    name: "Uluslararası Eğitim Günü",
    category: "sektor",
    when: { kind: "fixed", month: 1, day: 24 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["egitim"],
  },
  {
    id: "okuma-yazma-gunu",
    name: "Dünya Okuma Yazma Günü",
    category: "sektor",
    when: { kind: "fixed", month: 9, day: 8 },
    tone: "farkindalik",
    importance: "low",
    tags: ["egitim", "kultur"],
  },
  {
    id: "dunya-ogretmenler-gunu",
    name: "Dünya Öğretmenler Günü",
    category: "sektor",
    when: { kind: "fixed", month: 10, day: 5 },
    tone: "kutlama",
    importance: "low",
    tags: ["egitim"],
  },
  {
    id: "kitap-gunu",
    name: "Dünya Kitap ve Telif Hakları Günü",
    category: "sektor",
    when: { kind: "fixed", month: 4, day: 23 },
    tone: "farkindalik",
    importance: "low",
    tags: ["egitim", "kultur"],
  },
  {
    id: "veri-koruma-gunu",
    name: "Veri Koruma Günü",
    category: "sektor",
    when: { kind: "fixed", month: 1, day: 28 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["teknoloji", "finans", "hukuk"],
  },
  {
    id: "guvenli-internet-gunu",
    name: "Güvenli İnternet Günü",
    category: "sektor",
    when: { kind: "nth", month: 2, weekday: 2, n: 2 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["teknoloji", "egitim"],
    note: "Şubat'ın ikinci salısı.",
  },
  {
    id: "yedekleme-gunu",
    name: "Dünya Yedekleme Günü",
    category: "sektor",
    when: { kind: "fixed", month: 3, day: 31 },
    tone: "farkindalik",
    importance: "low",
    tags: ["teknoloji"],
  },
  {
    id: "telekomunikasyon-gunu",
    name: "Dünya Telekomünikasyon ve Bilgi Toplumu Günü",
    category: "sektor",
    when: { kind: "fixed", month: 5, day: 17 },
    tone: "farkindalik",
    importance: "low",
    tags: ["teknoloji"],
  },
  {
    id: "programcilar-gunu",
    name: "Programcılar Günü",
    category: "sektor",
    when: { kind: "custom", of: (y) => addDaysIso(ymd(y, 1, 1), 255) },
    tone: "kutlama",
    importance: "normal",
    tags: ["teknoloji"],
    note: "Yılın 256. günü.",
  },
  {
    id: "bilgisayar-guvenligi-gunu",
    name: "Bilgisayar Güvenliği Günü",
    category: "sektor",
    when: { kind: "fixed", month: 11, day: 30 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["teknoloji"],
  },
  {
    id: "dunya-gunu",
    name: "Dünya Günü (Earth Day)",
    category: "sektor",
    when: { kind: "fixed", month: 4, day: 22 },
    tone: "farkindalik",
    importance: "high",
    tags: ["cevre"],
  },
  {
    id: "dunya-cevre-gunu",
    name: "Dünya Çevre Günü",
    category: "sektor",
    when: { kind: "fixed", month: 6, day: 5 },
    tone: "farkindalik",
    importance: "high",
    tags: ["cevre", "tarim"],
  },
  {
    id: "dunya-saati",
    name: "Dünya Saati (Earth Hour)",
    category: "sektor",
    when: { kind: "nth", month: 3, weekday: 6, n: -1 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["cevre"],
    note: "Mart'ın son cumartesi akşamı, bir saat ışıklar kapanır.",
  },
  {
    id: "plastik-posetsiz-gun",
    name: "Uluslararası Plastik Poşetsiz Gün",
    category: "sektor",
    when: { kind: "fixed", month: 7, day: 3 },
    tone: "farkindalik",
    importance: "low",
    tags: ["cevre", "eticaret"],
  },
  {
    id: "ozon-gunu",
    name: "Ozon Tabakasını Koruma Günü",
    category: "sektor",
    when: { kind: "fixed", month: 9, day: 16 },
    tone: "farkindalik",
    importance: "low",
    tags: ["cevre"],
  },
  {
    id: "hayvanlari-koruma-gunu",
    name: "Dünya Hayvanları Koruma Günü",
    category: "sektor",
    when: { kind: "fixed", month: 10, day: 4 },
    tone: "farkindalik",
    importance: "high",
    tags: ["evcil"],
  },
  {
    id: "kedi-gunu",
    name: "Uluslararası Kedi Günü",
    category: "sektor",
    when: { kind: "fixed", month: 8, day: 8 },
    tone: "kutlama",
    importance: "normal",
    tags: ["evcil"],
  },
  {
    id: "kopek-gunu",
    name: "Uluslararası Köpek Günü",
    category: "sektor",
    when: { kind: "fixed", month: 8, day: 26 },
    tone: "kutlama",
    importance: "normal",
    tags: ["evcil"],
  },
  {
    id: "turizm-haftasi",
    name: "Turizm Haftası başlangıcı",
    category: "sektor",
    when: { kind: "fixed", month: 4, day: 15 },
    tone: "kutlama",
    importance: "low",
    tags: ["turizm"],
  },
  {
    id: "dunya-turizm-gunu",
    name: "Dünya Turizm Günü",
    category: "sektor",
    when: { kind: "fixed", month: 9, day: 27 },
    tone: "kutlama",
    importance: "high",
    tags: ["turizm"],
  },
  {
    id: "tasarruf-gunu",
    name: "Dünya Tasarruf Günü",
    category: "sektor",
    when: { kind: "fixed", month: 10, day: 31 },
    tone: "farkindalik",
    importance: "normal",
    tags: ["finans"],
  },
  {
    id: "spor-gunu",
    name: "Kalkınma ve Barış için Uluslararası Spor Günü",
    category: "sektor",
    when: { kind: "fixed", month: 4, day: 6 },
    tone: "kutlama",
    importance: "normal",
    tags: ["spor"],
  },
  {
    id: "mimarlik-gunu",
    name: "Dünya Mimarlık Günü",
    category: "sektor",
    when: { kind: "nth", month: 10, weekday: 1, n: 1 },
    tone: "kutlama",
    importance: "normal",
    tags: ["insaat"],
    note: "Ekim'in ilk pazartesi.",
  },
  {
    id: "sehircilik-gunu",
    name: "Dünya Şehircilik Günü",
    category: "sektor",
    when: { kind: "fixed", month: 11, day: 8 },
    tone: "farkindalik",
    importance: "low",
    tags: ["insaat"],
  },
  {
    id: "avukatlar-gunu",
    name: "Avukatlar Günü",
    category: "sektor",
    when: { kind: "fixed", month: 4, day: 5 },
    tone: "kutlama",
    importance: "high",
    tags: ["hukuk"],
  },
  {
    id: "tiyatro-gunu",
    name: "Dünya Tiyatro Günü",
    category: "sektor",
    when: { kind: "fixed", month: 3, day: 27 },
    tone: "kutlama",
    importance: "normal",
    tags: ["kultur"],
  },
  {
    id: "muzeler-gunu",
    name: "Uluslararası Müzeler Günü",
    category: "sektor",
    when: { kind: "fixed", month: 5, day: 18 },
    tone: "kutlama",
    importance: "normal",
    tags: ["kultur", "turizm"],
  },
  {
    id: "muzik-gunu",
    name: "Dünya Müzik Günü",
    category: "sektor",
    when: { kind: "fixed", month: 6, day: 21 },
    tone: "kutlama",
    importance: "normal",
    tags: ["kultur"],
  },
];

/** Every rule id (for tests and settings screens). */
export const SPECIAL_DAY_RULE_IDS: readonly string[] = RULES.map((r) => r.id);

// --- religious dates ---------------------------------------------------------------------------

/**
 * Fixed Hijri month starts from Diyanet's table and the owner's overrides (the overrides win).
 * A bayram date fixes its month: Ramazan Bayramı is 1 Şevval, Kurban Bayramı 10 Zilhicce.
 */
export function fixedHijriMonthStarts(
  overrides: readonly ReligiousDayOverride[] = [],
): Map<string, string> {
  const out = new Map<string, string>();
  const put = (bayram: "ramazan" | "kurban", date: string) => {
    const month = bayram === "ramazan" ? 10 : 12;
    const start = bayram === "ramazan" ? date : addDaysIso(date, -9);
    // The Hijri year whose computed month start is closest to the given one.
    let best: { year: number; distance: number } | null = null;
    for (const year of hijriYearsBetween(start, start)) {
      const computed = hijriToIso(year, month, 1).date;
      const distance = Math.abs(julianDayOf(computed) - julianDayOf(start));
      if (!best || distance < best.distance) best = { year, distance };
    }
    if (best && best.distance <= 5) out.set(hijriMonthKey(best.year, month), start);
  };
  for (const row of DIYANET_BAYRAM_DATES) {
    put("ramazan", row.ramazanBayrami);
    put("kurban", row.kurbanBayrami);
  }
  for (const raw of overrides) {
    const row = ReligiousDayOverride.parse(raw);
    if (row.ramazanBayrami) put("ramazan", row.ramazanBayrami);
    if (row.kurbanBayrami) put("kurban", row.kurbanBayrami);
  }
  return out;
}

/** Regaip Kandili: the Thursday evening before the first Friday of Recep. */
function regaip(year: number, fixed: Map<string, string>): { date: string; fixed: boolean } {
  const start = hijriToIso(year, 7, 1, fixed);
  const shift = (5 - weekdayOf(start.date) + 7) % 7; // first Friday on or after 1 Recep
  return { date: addDaysIso(start.date, shift - 1), fixed: start.fixed };
}

// --- the list ------------------------------------------------------------------------------------

export interface SpecialDayOptions {
  /** The brand's sector tags: sector days with these tags come in, other days get a boost. */
  tags?: readonly SectorTag[];
  /** Categories the owner switched off for the brand. */
  disabledCategories?: readonly SpecialDayCategory[];
  /** Owner corrections of bayram dates. */
  overrides?: readonly ReligiousDayOverride[];
  /** Every sector day, whatever the tags (a catalogue view). */
  allSectors?: boolean;
}

function yearsBetween(from: string, to: string): number[] {
  const out: number[] = [];
  for (let y = Number(from.slice(0, 4)) - 1; y <= Number(to.slice(0, 4)); y++) out.push(y);
  return out;
}

/** Occurrences (first day + whether it is confirmed) of a rule that may touch `from`…`to`. */
function occurrences(
  rule: Rule,
  from: string,
  to: string,
  fixed: Map<string, string>,
): { date: string; fixed: boolean }[] {
  const when = rule.when;
  switch (when.kind) {
    case "regaip":
      return hijriYearsBetween(from, to).map((year) => regaip(year, fixed));
    case "hijri":
      return hijriYearsBetween(from, to).map((year) => {
        // `day: 0` is the eve (arife) of the next month's first day.
        if (when.day > 0) return hijriToIso(year, when.month, when.day, fixed);
        const next = hijriToIso(year, when.month + 1, 1, fixed);
        return { date: addDaysIso(next.date, -1), fixed: next.fixed };
      });
    case "fixed":
      return yearsBetween(from, to).map((y) => ({
        date: ymd(y, when.month, when.day),
        fixed: true,
      }));
    case "nth":
      return yearsBetween(from, to).map((y) => ({
        date: nthWeekday(y, when.month, when.weekday, when.n),
        fixed: true,
      }));
    case "custom":
      return yearsBetween(from, to).map((y) => ({ date: when.of(y), fixed: true }));
  }
}

/**
 * The special days that touch `from`…`to` (inclusive), first day first, for a brand with the
 * given tags and switched-off categories. Sector days come in only for matching tags (or
 * `allSectors`); a day whose tags match the brand's becomes `high`.
 */
export function specialDaysBetween(
  from: string,
  to: string,
  options: SpecialDayOptions = {},
): SpecialDay[] {
  const tags = new Set(options.tags ?? []);
  const disabled = new Set(options.disabledCategories ?? []);
  const fixed = fixedHijriMonthStarts(options.overrides);
  const out: SpecialDay[] = [];
  for (const rule of RULES) {
    if (disabled.has(rule.category)) continue;
    const ruleTags = rule.tags ?? [];
    const matches = ruleTags.some((t) => tags.has(t));
    if (rule.category === "sektor" && !matches && !options.allSectors) continue;
    const religious = rule.when.kind === "hijri" || rule.when.kind === "regaip";
    for (const occurrence of occurrences(rule, from, to, fixed)) {
      const days = rule.days ?? 1;
      const last = addDaysIso(occurrence.date, days - 1);
      if (last < from || occurrence.date > to) continue;
      out.push({
        id: `${rule.id}-${occurrence.date.slice(0, 4)}`,
        ruleId: rule.id,
        date: occurrence.date,
        days,
        name: rule.name,
        category: rule.category,
        tags: [...ruleTags],
        holiday: rule.holiday ?? null,
        tone: rule.tone,
        importance: matches && rule.category !== "sektor" ? "high" : rule.importance,
        leadDays: rule.leadDays ?? 0,
        note: rule.note ?? null,
        approximate: religious && !occurrence.fixed,
      });
    }
  }
  const rank = { high: 0, normal: 1, low: 2 } as const;
  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      rank[a.importance] - rank[b.importance] ||
      a.name.localeCompare(b.name, "tr"),
  );
}

/** The days each special day covers (`YYYY-MM-DD` → days), for calendar cells. */
export function specialDaysByDate(days: readonly SpecialDay[]): Map<string, SpecialDay[]> {
  const out = new Map<string, SpecialDay[]>();
  for (const day of days) {
    for (let i = 0; i < day.days; i++) {
      const key = addDaysIso(day.date, i);
      out.set(key, [...(out.get(key) ?? []), day]);
    }
  }
  return out;
}

/** "Ramazan Bayramı (2. gün)" for the `index`-th day (0-based) of a multi-day bayram. */
export function specialDayLabel(day: SpecialDay, onDate?: string): string {
  if (day.days <= 1 || !onDate) return day.name;
  const index = Math.round(julianDayOf(onDate) - julianDayOf(day.date));
  return index <= 0 ? day.name : `${day.name} (${index + 1}. gün)`;
}
