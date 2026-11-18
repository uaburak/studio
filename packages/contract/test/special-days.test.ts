import { describe, expect, it } from "vitest";
import {
  computedHijriMonthStart,
  DIYANET_BAYRAM_DATES,
  julianDayOf,
  newMoon,
  SPECIAL_DAY_RULE_IDS,
  type SpecialDay,
  specialDayLabel,
  specialDaysBetween,
  specialDaysByDate,
} from "../src/index.ts";

const iso = (jd: number) => new Date((jd - 2440587.5) * 86_400_000).toISOString().slice(0, 16);
const addDays = (date: string, n: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

describe("new moons (Meeus ch. 49)", () => {
  // Conjunctions of well-known solar eclipses and new moons, UTC.
  it.each([
    ["2023-04-20T04:12", "2023-04-20"],
    ["2024-04-08T18:21", "2024-04-08"],
    ["2024-06-06T12:38", "2024-06-06"],
    ["2025-03-29T10:58", "2025-03-29"],
    ["2026-03-19T01:23", "2026-03-19"],
  ])("%s", (expected, day) => {
    const k = Math.round((julianDayOf(day) - 2451550.09766) / 29.530588861);
    const got = newMoon(k).jd;
    const want = Date.parse(`${expected}:00Z`) / 86_400_000 + 2440587.5;
    expect(Math.abs(got - want) * 24 * 60, `${iso(got)} vs ${expected}`).toBeLessThan(5);
  });
});

/**
 * Diyanet's dates (the first day of Ramazan Bayramı = 1 Şevval, of Kurban Bayramı = 10 Zilhicce).
 * 2019–2026 are past bayrams; 2025–2030 are the dates Diyanet announced in its calendar
 * (`DIYANET_BAYRAM_DATES`). The computation must reproduce all of them on its own.
 */
const BAYRAMS: Array<[number, number, string, string]> = [
  [2019, 1440, "2019-06-04", "2019-08-11"],
  [2020, 1441, "2020-05-24", "2020-07-31"],
  [2021, 1442, "2021-05-13", "2021-07-20"],
  [2022, 1443, "2022-05-02", "2022-07-09"],
  [2023, 1444, "2023-04-21", "2023-06-28"],
  [2024, 1445, "2024-04-10", "2024-06-16"],
  [2025, 1446, "2025-03-30", "2025-06-06"],
  [2026, 1447, "2026-03-20", "2026-05-27"],
  [2027, 1448, "2027-03-09", "2027-05-16"],
  [2028, 1449, "2028-02-26", "2028-05-05"],
  [2029, 1450, "2029-02-14", "2029-04-24"],
  [2030, 1451, "2030-02-04", "2030-04-13"],
];

describe("Hijri month starts (Diyanet criterion)", () => {
  it.each(BAYRAMS)("%i bayrams", (_year, hijriYear, ramazan, kurban) => {
    expect(computedHijriMonthStart(hijriYear, 10)).toBe(ramazan);
    expect(addDays(computedHijriMonthStart(hijriYear, 12), 9)).toBe(kurban);
  });

  it("the Diyanet table agrees with the computation", () => {
    for (const row of DIYANET_BAYRAM_DATES) {
      const match = BAYRAMS.find(([year]) => year === row.year);
      expect(match, String(row.year)).toBeDefined();
      expect(row.ramazanBayrami).toBe(match?.[2]);
      expect(row.kurbanBayrami).toBe(match?.[3]);
    }
  });

  // Other religious days in Diyanet's calendars (a kandil is listed on the evening's date).
  const OTHER: Array<[string, string[]]> = [
    ["ramazan-baslangici", ["2023-03-23", "2024-03-11", "2025-03-01", "2026-02-19"]],
    ["kadir-gecesi", ["2023-04-17", "2024-04-05", "2025-03-26", "2026-03-16"]],
    ["hicri-yilbasi", ["2023-07-19", "2024-07-07", "2025-06-26", "2026-06-16"]],
    ["asure-gunu", ["2023-07-28", "2024-07-16", "2025-07-05", "2026-06-25"]],
    ["mevlid-kandili", ["2023-09-26", "2024-09-14", "2025-09-03", "2026-08-24"]],
    ["regaip-kandili", ["2023-01-26", "2025-01-02", "2025-12-25"]],
    ["mirac-kandili", ["2023-02-17", "2024-02-06", "2025-01-26", "2026-01-15"]],
    ["berat-kandili", ["2023-03-06", "2024-02-24", "2025-02-13", "2026-02-02"]],
  ];
  const all = specialDaysBetween("2023-01-01", "2026-12-31");
  it.each(OTHER)("%s", (ruleId, dates) => {
    const got = all.filter((d) => d.ruleId === ruleId).map((d) => d.date);
    for (const date of dates) expect(got, date).toContain(date);
  });
});

function find(days: SpecialDay[], ruleId: string, year?: number): SpecialDay | undefined {
  return days.find((d) => d.ruleId === ruleId && (!year || d.date.startsWith(String(year))));
}

describe("specialDaysBetween", () => {
  const year2026 = specialDaysBetween("2026-01-01", "2026-12-31");

  it("has the fixed public holidays", () => {
    for (const [rule, date] of [
      ["yilbasi", "2026-01-01"],
      ["23-nisan", "2026-04-23"],
      ["1-mayis", "2026-05-01"],
      ["19-mayis", "2026-05-19"],
      ["15-temmuz", "2026-07-15"],
      ["30-agustos", "2026-08-30"],
      ["29-ekim", "2026-10-29"],
    ] as const) {
      const day = find(year2026, rule);
      expect(day?.date, rule).toBe(date);
      expect(day?.holiday).toBe("full");
      expect(day?.category).toBe("resmi");
    }
    expect(find(year2026, "cumhuriyet-arifesi")?.holiday).toBe("half");
  });

  it("computes the moving days", () => {
    expect(find(year2026, "anneler-gunu")?.date).toBe("2026-05-10");
    expect(find(year2026, "babalar-gunu")?.date).toBe("2026-06-21");
    expect(find(year2026, "black-friday")?.date).toBe("2026-11-27");
    expect(find(year2026, "cyber-monday")?.date).toBe("2026-11-30");
    const y2027 = specialDaysBetween("2027-01-01", "2027-12-31");
    expect(find(y2027, "anneler-gunu")?.date).toBe("2027-05-09");
    expect(find(y2027, "black-friday")?.date).toBe("2027-11-26");
    const all = specialDaysBetween("2024-01-01", "2026-12-31", { allSectors: true });
    expect(find(all, "programcilar-gunu", 2024)?.date).toBe("2024-09-12"); // leap year
    expect(find(all, "programcilar-gunu", 2026)?.date).toBe("2026-09-13");
    expect(find(all, "dunya-saati", 2026)?.date).toBe("2026-03-28");
    expect(find(all, "guvenli-internet-gunu", 2026)?.date).toBe("2026-02-10");
    expect(find(all, "mimarlik-gunu", 2026)?.date).toBe("2026-10-05");
  });

  it("gives the bayrams their length, their eve and a confirmed date", () => {
    const ramazan = find(year2026, "ramazan-bayrami");
    expect(ramazan).toMatchObject({ date: "2026-03-20", days: 3, holiday: "full" });
    expect(ramazan?.approximate).toBe(false);
    expect(find(year2026, "ramazan-bayrami-arifesi")).toMatchObject({
      date: "2026-03-19",
      holiday: "half",
    });
    expect(find(year2026, "kurban-bayrami")).toMatchObject({ date: "2026-05-27", days: 4 });
    expect(find(year2026, "kurban-bayrami-arifesi")?.date).toBe("2026-05-26");
    // A kandil is computed only (±1 day).
    expect(find(year2026, "mevlid-kandili")?.approximate).toBe(true);
    // A bayram beyond the table is computed only too.
    const later = specialDaysBetween("2031-01-01", "2031-12-31");
    expect(find(later, "ramazan-bayrami")?.approximate).toBe(true);
  });

  it("lets an owner override a year's bayram", () => {
    const computed = find(specialDaysBetween("2031-01-01", "2031-12-31"), "ramazan-bayrami");
    expect(computed).toBeDefined();
    const moved = addDays(computed?.date ?? "", 1);
    const days = specialDaysBetween("2031-01-01", "2031-12-31", {
      overrides: [{ year: 2031, ramazanBayrami: moved }],
    });
    expect(find(days, "ramazan-bayrami")).toMatchObject({ date: moved, approximate: false });
    expect(find(days, "ramazan-bayrami-arifesi")?.date).toBe(computed?.date);
    // Overrides win over the Diyanet table too.
    const fixed = specialDaysBetween("2027-01-01", "2027-12-31", {
      overrides: [{ year: 2027, kurbanBayrami: "2027-05-17" }],
    });
    expect(find(fixed, "kurban-bayrami")?.date).toBe("2027-05-17");
    expect(find(fixed, "kurban-bayrami-arifesi")?.date).toBe("2027-05-16");
  });

  it("brings sector days in by tag and boosts matching days", () => {
    const plain = specialDaysBetween("2026-12-01", "2026-12-31");
    expect(find(plain, "dunya-toprak-gunu")).toBeUndefined();
    const farm = specialDaysBetween("2026-12-01", "2026-12-31", { tags: ["tarim"] });
    expect(find(farm, "dunya-toprak-gunu")).toMatchObject({
      date: "2026-12-05",
      category: "sektor",
    });
    expect(find(farm, "turk-kahvesi-gunu")).toBeUndefined();
    // A non-sector day with a matching tag becomes "high".
    const shop = specialDaysBetween("2026-11-01", "2026-11-30", { tags: ["eticaret"] });
    expect(find(shop, "11-11")?.importance).toBe("high");
    expect(find(plain, "11-11")).toBeUndefined();
    expect(find(specialDaysBetween("2026-11-01", "2026-11-30"), "11-11")?.importance).toBe("low");
  });

  it("leaves out switched-off categories", () => {
    const days = specialDaysBetween("2026-01-01", "2026-12-31", {
      disabledCategories: ["dini", "ticari"],
    });
    expect(days.some((d) => d.category === "dini" || d.category === "ticari")).toBe(false);
    expect(find(days, "29-ekim")).toBeDefined();
  });

  it("includes a bayram that started before the range and sorts by date", () => {
    const days = specialDaysBetween("2026-05-29", "2026-06-02");
    expect(find(days, "kurban-bayrami")?.date).toBe("2026-05-27");
    const dates = days.map((d) => d.date);
    expect([...dates].sort()).toEqual(dates);
  });

  it("covers every rule over a few years without errors", () => {
    const days = specialDaysBetween("2025-01-01", "2027-12-31", { allSectors: true });
    const rules = new Set(days.map((d) => d.ruleId));
    for (const id of SPECIAL_DAY_RULE_IDS) expect(rules, id).toContain(id);
  });
});

describe("calendar helpers", () => {
  it("spreads multi-day bayrams over their days", () => {
    const days = specialDaysBetween("2026-03-01", "2026-03-31");
    const byDate = specialDaysByDate(days);
    expect(byDate.get("2026-03-21")?.map((d) => d.ruleId)).toContain("ramazan-bayrami");
    expect(byDate.get("2026-03-22")?.map((d) => d.ruleId)).toContain("ramazan-bayrami");
    expect(byDate.get("2026-03-23")?.map((d) => d.ruleId) ?? []).not.toContain("ramazan-bayrami");
    const bayram = find(days, "ramazan-bayrami") as SpecialDay;
    expect(specialDayLabel(bayram, "2026-03-20")).toBe("Ramazan Bayramı");
    expect(specialDayLabel(bayram, "2026-03-22")).toBe("Ramazan Bayramı (3. gün)");
  });
});
