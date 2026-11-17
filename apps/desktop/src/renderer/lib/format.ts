// Turkish formatting used across the UI (dates, durations, percentages).

/** "9sn", "1dk 9sn", "1sa 4dk" — the live timer of a running step or job. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}sa ${m}dk` : `${h}sa`;
  if (m > 0) return s > 0 ? `${m}dk ${s}sn` : `${m}dk`;
  return `${s}sn`;
}

const WEEKDAYS = ["Paz", "Pzt", "Sal", "Çar", "Per", "Cum", "Cmt"];
const MONTHS = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

function hm(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "şimdi", "4dk önce", "1sa önce", "Dün 10:00", "12 Kas" — finished jobs, last activity. */
export function formatAgo(iso: string | Date, now: Date = new Date()): string {
  const date = typeof iso === "string" ? new Date(iso) : iso;
  const diff = Math.max(0, now.getTime() - date.getTime());
  if (diff < 60_000) return "şimdi";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}dk önce`;
  if (sameDay(date, now)) return `${Math.floor(diff / 3_600_000)}sa önce`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Dün ${hm(date)}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** Turkish locative suffix after a time ("22:30'da", "14:00'te", "10:40'ta"). */
export function timeSuffix(time: string): string {
  // The suffix follows the last spoken word: "yirmi iki otuz" → 'da, "on dört" → 'te.
  const minutes = Number.parseInt(time.slice(-2), 10);
  const n = minutes === 0 ? Number.parseInt(time.slice(0, 2), 10) : minutes;
  // [vowel, voiceless] of: sıfır, bir … dokuz, and on, yirmi, otuz, kırk, elli.
  const units: [string, boolean][] = [
    ["a", false],
    ["e", false],
    ["e", false],
    ["e", true],
    ["e", true],
    ["e", true],
    ["a", false],
    ["e", false],
    ["e", false],
    ["a", false],
  ];
  const tens: Record<number, [string, boolean]> = {
    10: ["a", false],
    20: ["e", false],
    30: ["a", false],
    40: ["a", true],
    50: ["e", false],
  };
  const [vowel, voiceless] =
    n % 10 !== 0 || n === 0 ? (units[n % 10] ?? ["e", false]) : (tens[n] ?? ["e", false]);
  return `${time}'${voiceless ? "t" : "d"}${vowel}`;
}

/** "22:30'da sıfırlanır" today, "Çar 14:00'te sıfırlanır" later. */
export function formatReset(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const time = hm(date);
  const prefix = sameDay(date, now) ? "" : `${WEEKDAYS[date.getDay()]} `;
  return `${prefix}${timeSuffix(time)} sıfırlanır`;
}

/** "%45". */
export function percentText(value: number): string {
  return `%${Math.round(value)}`;
}

/** "18 Kas" from an ISO date (yyyy-mm-dd). */
export function shortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map((x) => Number.parseInt(x, 10));
  if (!y || !m || !d) return isoDate;
  return `${d} ${MONTHS[m - 1]}`;
}

/** "487,2k" token counts. */
export function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(".", ",")}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(".", ",")}k`;
  return String(value);
}

export function capitalizeTr(text: string): string {
  if (!text) return text;
  return text.charAt(0).toLocaleUpperCase("tr-TR") + text.slice(1);
}
