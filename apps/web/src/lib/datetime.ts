/**
 * Time zone helpers. The API stores and returns UTC (`...Z`); the UI shows and
 * accepts wall-clock time in the user's zone. Conversion uses Intl only (no
 * date library): we read the zone's UTC offset at an instant and correct once
 * for DST boundaries.
 */

export interface WallTime {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function userTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    partsFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** Wall-clock parts of `instant` in `timeZone` (seconds included). */
function zonedParts(instant: Date, timeZone: string) {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in ms (Istanbul: +3h). */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - whole;
}

/**
 * Wall-clock time in `timeZone` -> UTC instant. In a DST gap (a wall time
 * that does not exist) the result lands after the gap; in an overlap the
 * earlier instant wins.
 */
export function zonedToUtc(wall: WallTime, timeZone: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const first = zoneOffsetMs(new Date(guess), timeZone);
  let result = guess - first;
  const second = zoneOffsetMs(new Date(result), timeZone);
  if (second !== first) {
    const alt = guess - second;
    // Prefer the candidate that maps back to the requested wall time.
    result = sameWall(utcToZoned(new Date(alt), timeZone), wall) ? alt : result;
  }
  return new Date(result);
}

function sameWall(a: WallTime, b: WallTime): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/** UTC instant -> wall-clock time in `timeZone`. */
export function utcToZoned(instant: Date, timeZone: string): WallTime {
  const { year, month, day, hour, minute } = zonedParts(instant, timeZone);
  return { year, month, day, hour, minute };
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** `YYYY-MM-DD` key of the wall date (used for grouping by day). */
export function dayKey(wall: Pick<WallTime, "year" | "month" | "day">): string {
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** Values for `<input type="date">` / `<input type="time">`. */
export function toDateInput(wall: WallTime): string {
  return dayKey(wall);
}

export function toTimeInput(wall: WallTime): string {
  return `${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** Parse `<input type="date">` + `<input type="time">` values; null when invalid. */
export function parseWallInputs(date: string, time: string): WallTime | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  const t = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time.trim());
  if (!d || !t) return null;
  const wall = {
    year: Number(d[1]),
    month: Number(d[2]),
    day: Number(d[3]),
    hour: Number(t[1]),
    minute: Number(t[2]),
  };
  if (wall.month < 1 || wall.month > 12 || wall.hour > 23 || wall.minute > 59) return null;
  if (wall.day < 1 || wall.day > daysInMonth(wall.year, wall.month)) return null;
  return wall;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Add whole days to a wall date (calendar arithmetic, zone-independent). */
export function addDays<T extends Pick<WallTime, "year" | "month" | "day">>(
  wall: T,
  days: number,
): T {
  const d = new Date(Date.UTC(wall.year, wall.month - 1, wall.day + days));
  return { ...wall, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** 0 = Monday ... 6 = Sunday (Turkish weeks start on Monday). */
export function weekdayMondayFirst(wall: Pick<WallTime, "year" | "month" | "day">): number {
  const sundayFirst = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay();
  return (sundayFirst + 6) % 7;
}

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
  key: string;
  inMonth: boolean;
}

/** Monday-first weeks covering the whole month (4-6 rows of 7 days). */
export function buildMonthGrid(year: number, month: number): CalendarDay[][] {
  const first = { year, month, day: 1 };
  let cursor = addDays(first, -weekdayMondayFirst(first));
  const last = { year, month, day: daysInMonth(year, month) };
  const weeks: CalendarDay[][] = [];
  while (weeks.length === 0 || dayKey(cursor) <= dayKey(last)) {
    const week: CalendarDay[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({ ...cursor, key: dayKey(cursor), inMonth: cursor.month === month });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** UTC bounds `[from, to)` of whole wall days, for API range queries. */
export function utcRangeForDays(
  firstDay: Pick<WallTime, "year" | "month" | "day">,
  dayCount: number,
  timeZone: string,
): { from: string; to: string } {
  const start = zonedToUtc({ ...firstDay, hour: 0, minute: 0 }, timeZone);
  const end = zonedToUtc({ ...addDays(firstDay, dayCount), hour: 0, minute: 0 }, timeZone);
  return { from: start.toISOString(), to: end.toISOString() };
}

export function shiftMonth(year: number, month: number, delta: number) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

// --- Display -----------------------------------------------------------------

const LOCALE = "tr-TR";

export function formatDateTime(iso: string, timeZone = userTimeZone()): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatDate(iso: string, timeZone = userTimeZone()): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone = userTimeZone()): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone, hour: "2-digit", minute: "2-digit" }).format(
    new Date(iso),
  );
}

export function formatMonthTitle(year: number, month: number): string {
  return new Intl.DateTimeFormat(LOCALE, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

export function formatDayHeading(wall: Pick<WallTime, "year" | "month" | "day">): string {
  return new Intl.DateTimeFormat(LOCALE, {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(wall.year, wall.month - 1, wall.day)));
}

export const WEEKDAYS_SHORT = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"] as const;

/** "3 dk önce", "2 sa önce", "dün" ... (falls back to a date after a week). */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const diff = now.getTime() - new Date(iso).getTime();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto", style: "short" });
  const sign = diff >= 0 ? -1 : 1;
  if (abs < 45_000) return "şimdi";
  if (abs < 3_600_000) return rtf.format(sign * Math.round(abs / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(sign * Math.round(abs / 3_600_000), "hour");
  if (abs < 7 * 86_400_000) return rtf.format(sign * Math.round(abs / 86_400_000), "day");
  return formatDate(iso);
}

/** Readable offset label: "GMT+3". */
export function formatOffset(instant: Date, timeZone: string): string {
  const minutes = Math.round(zoneOffsetMs(instant, timeZone) / 60_000);
  const sign = minutes >= 0 ? "+" : "−";
  const h = Math.floor(Math.abs(minutes) / 60);
  const m = Math.abs(minutes) % 60;
  return `GMT${sign}${h}${m ? `:${pad(m)}` : ""}`;
}
