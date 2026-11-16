import { describe, expect, it } from "vitest";
import {
  addDays,
  buildMonthGrid,
  dayKey,
  formatOffset,
  parseWallInputs,
  shiftMonth,
  utcRangeForDays,
  utcToZoned,
  weekdayMondayFirst,
  zonedToUtc,
} from "../src/lib/datetime.ts";

const wall = (year: number, month: number, day: number, hour = 0, minute = 0) => ({
  year,
  month,
  day,
  hour,
  minute,
});

describe("zonedToUtc", () => {
  it("converts Istanbul wall time (fixed +3) to UTC", () => {
    expect(zonedToUtc(wall(2026, 11, 17, 10, 0), "Europe/Istanbul").toISOString()).toBe(
      "2026-11-17T07:00:00.000Z",
    );
  });

  it("crosses the date line backwards", () => {
    expect(zonedToUtc(wall(2026, 1, 1, 1, 30), "Europe/Istanbul").toISOString()).toBe(
      "2025-12-31T22:30:00.000Z",
    );
  });

  it("handles summer and winter offsets in New York", () => {
    expect(zonedToUtc(wall(2026, 7, 1, 12, 0), "America/New_York").toISOString()).toBe(
      "2026-07-01T16:00:00.000Z",
    );
    expect(zonedToUtc(wall(2026, 12, 1, 12, 0), "America/New_York").toISOString()).toBe(
      "2026-12-01T17:00:00.000Z",
    );
  });

  it("moves a wall time inside the spring-forward gap past the gap", () => {
    // 2026-03-08 02:30 does not exist in New York; 03:30 EDT is the next real minute pattern.
    expect(zonedToUtc(wall(2026, 3, 8, 2, 30), "America/New_York").toISOString()).toBe(
      "2026-03-08T07:30:00.000Z",
    );
  });

  it("picks the earlier instant in the fall-back overlap", () => {
    expect(zonedToUtc(wall(2026, 11, 1, 1, 30), "America/New_York").toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("is UTC-identity for UTC", () => {
    expect(zonedToUtc(wall(2026, 5, 5, 5, 5), "UTC").toISOString()).toBe(
      "2026-05-05T05:05:00.000Z",
    );
  });

  it("round-trips through utcToZoned", () => {
    for (const tz of ["Europe/Istanbul", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
      const w = wall(2026, 6, 15, 23, 45);
      expect(utcToZoned(zonedToUtc(w, tz), tz)).toEqual(w);
    }
  });
});

describe("parseWallInputs", () => {
  it("parses date and time inputs", () => {
    expect(parseWallInputs("2026-11-17", "09:05")).toEqual(wall(2026, 11, 17, 9, 5));
    expect(parseWallInputs("2026-11-17", "09:05:30")).toEqual(wall(2026, 11, 17, 9, 5));
  });

  it("rejects impossible dates and malformed values", () => {
    expect(parseWallInputs("2026-02-30", "10:00")).toBeNull();
    expect(parseWallInputs("2026-13-01", "10:00")).toBeNull();
    expect(parseWallInputs("2026-11-17", "24:00")).toBeNull();
    expect(parseWallInputs("", "10:00")).toBeNull();
    expect(parseWallInputs("17.11.2026", "10:00")).toBeNull();
  });

  it("accepts Feb 29 only in leap years", () => {
    expect(parseWallInputs("2028-02-29", "10:00")).not.toBeNull();
    expect(parseWallInputs("2027-02-29", "10:00")).toBeNull();
  });
});

describe("calendar grid", () => {
  it("starts weeks on Monday", () => {
    expect(weekdayMondayFirst({ year: 2026, month: 11, day: 16 })).toBe(0); // Monday
    expect(weekdayMondayFirst({ year: 2026, month: 11, day: 1 })).toBe(6); // Sunday
  });

  it("covers November 2026 in six Monday-first weeks", () => {
    const weeks = buildMonthGrid(2026, 11);
    expect(weeks).toHaveLength(6);
    expect(weeks[0]?.[0]?.key).toBe("2026-10-26");
    expect(weeks[0]?.[6]?.key).toBe("2026-11-01");
    expect(weeks[5]?.[6]?.key).toBe("2026-12-06");
    expect(weeks.flat().filter((d) => d.inMonth)).toHaveLength(30);
  });

  it("uses exactly four weeks when the month allows it", () => {
    const weeks = buildMonthGrid(2027, 2); // starts on Monday, 28 days
    expect(weeks).toHaveLength(4);
    expect(weeks[3]?.[6]?.key).toBe("2027-02-28");
  });

  it("adds days across month and year boundaries", () => {
    expect(dayKey(addDays({ year: 2026, month: 12, day: 31 }, 1))).toBe("2027-01-01");
    expect(dayKey(addDays({ year: 2026, month: 3, day: 1 }, -1))).toBe("2026-02-28");
  });

  it("shifts months", () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 });
  });

  it("computes UTC query bounds for whole local days", () => {
    expect(utcRangeForDays({ year: 2026, month: 10, day: 26 }, 42, "Europe/Istanbul")).toEqual({
      from: "2026-10-25T21:00:00.000Z",
      to: "2026-12-06T21:00:00.000Z",
    });
  });
});

describe("formatOffset", () => {
  it("labels offsets", () => {
    expect(formatOffset(new Date("2026-11-16T00:00:00Z"), "Europe/Istanbul")).toBe("GMT+3");
    expect(formatOffset(new Date("2026-11-16T00:00:00Z"), "Asia/Kolkata")).toBe("GMT+5:30");
    expect(formatOffset(new Date("2026-11-16T00:00:00Z"), "America/New_York")).toBe("GMT−5");
  });
});
