// Turkish dates of the posts screens (local time): card dates, the month title, the schedule
// sheet's date and time fields.

export const MONTHS_LONG = [
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
const MONTHS_SHORT = [
  "Oca",
  "Şub",
  "Mar",
  "Nis",
  "May",
  "Haz",
  "Tem",
  "Ağu",
  "Eyl",
  "Eki",
  "Kas",
  "Ara",
];
const WEEKDAYS_LONG = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

const pad = (n: number) => String(n).padStart(2, "0");

export function hm(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** "18 Kas" */
export function shortDay(date: Date): string {
  return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()]}`;
}

/** "18 Kas 10:00" */
export function shortDayTime(date: Date): string {
  return `${shortDay(date)} ${hm(date)}`;
}

/** "18 Kasım 10:00" */
export function dayTime(date: Date): string {
  return `${date.getDate()} ${MONTHS_LONG[date.getMonth()]} ${hm(date)}`;
}

/** "18 Kasım 2026, Çarşamba 10:00" (time left out when `withTime` is false). */
export function longDay(date: Date, withTime = true): string {
  const day = `${date.getDate()} ${MONTHS_LONG[date.getMonth()]} ${date.getFullYear()}, ${WEEKDAYS_LONG[date.getDay()]}`;
  return withTime ? `${day} ${hm(date)}` : day;
}

/** "yyyy-mm-dd" (plan dates) → local midnight. */
export function localDate(iso: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// --- months -------------------------------------------------------------------------------------

/** "2026-11" */
export type MonthKey = string;

export function monthKeyOf(date: Date): MonthKey {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

export function addMonths(key: MonthKey, delta: number): MonthKey {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y ?? 2026, (m ?? 1) - 1 + delta, 1);
  return monthKeyOf(d);
}

/** "Kasım 2026" */
export function monthTitle(key: MonthKey): string {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS_LONG[(m ?? 1) - 1]} ${y}`;
}

/** "Kasım" */
export function monthName(key: MonthKey): string {
  const m = Number(key.split("-")[1] ?? 1);
  return MONTHS_LONG[m - 1] ?? "";
}

// --- form fields --------------------------------------------------------------------------------

/** `<input type="date">` value. */
export function dateInput(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `<input type="time">` value. */
export function timeInput(date: Date): string {
  return hm(date);
}

/** Local date + time fields → the moment (null when either does not parse). */
export function fromInputs(date: string, time: string): Date | null {
  const day = localDate(date);
  const t = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!day || !t) return null;
  const h = Number(t[1]);
  const min = Number(t[2]);
  if (h > 23 || min > 59) return null;
  day.setHours(h, min, 0, 0);
  return day;
}

/** "Yerel saat (Europe/Istanbul)" */
export function timeZoneLabel(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Yerel saat (${zone})`;
}
