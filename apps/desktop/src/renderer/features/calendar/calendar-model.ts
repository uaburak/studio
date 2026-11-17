// The calendar as plain values (local time, Monday first), tested without views. Port of
// StudioMac's CalendarModel / MiniCalendar (Calendar/CalendarView.swift,
// Inspector/PanelPaneContent.swift) and StudioKit's ScheduleDisplayState / CalendarMath:
// a brand's schedules plus its dated posts (accepted plan items), the month grid with a dot per
// kind of post (problems first), the selected day's agenda and drag-to-reschedule.
import type {
  Content,
  ContentStatus,
  ContentType,
  Plan,
  Platform,
  PublishingMode,
  Schedule,
  SocialAccount,
} from "@studio/contract";

// --- days and months ------------------------------------------------------------------------------

/** "2026-11-18" (local). */
export type DayKey = string;

export interface MonthKey {
  year: number;
  /** 1…12. */
  month: number;
}

export const WEEKDAY_LABELS = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
export const MONTH_NAMES = [
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
const WEEKDAY_NAMES = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];

const pad = (n: number) => String(n).padStart(2, "0");

export function dayKey(date: Date | number): DayKey {
  const d = typeof date === "number" ? new Date(date) : date;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDay(key: DayKey): { year: number; month: number; day: number } {
  const [y, m, d] = key.split("-").map((x) => Number.parseInt(x, 10));
  return { year: y ?? 1970, month: m ?? 1, day: d ?? 1 };
}

/** Local midnight of `key`. */
export function dateOfDay(key: DayKey): Date {
  const { year, month, day } = parseDay(key);
  return new Date(year, month - 1, day);
}

export function addDays(key: DayKey, delta: number): DayKey {
  const d = dateOfDay(key);
  d.setDate(d.getDate() + delta);
  return dayKey(d);
}

export function monthOf(key: DayKey): MonthKey {
  const { year, month } = parseDay(key);
  return { year, month };
}

export function sameMonth(a: MonthKey, b: MonthKey): boolean {
  return a.year === b.year && a.month === b.month;
}

export function addMonths(m: MonthKey, delta: number): MonthKey {
  const index = m.year * 12 + (m.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** "Kasım 2026". */
export function monthTitle(m: MonthKey): string {
  return `${MONTH_NAMES[m.month - 1]} ${m.year}`;
}

/** "18 Kasım Çarşamba". */
export function dayTitle(key: DayKey): string {
  const d = dateOfDay(key);
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]} ${WEEKDAY_NAMES[d.getDay()]}`;
}

/** "18 Kas – 24 Kas" style short day ("18 Kas"). */
export function shortDay(key: DayKey): string {
  const d = dateOfDay(key);
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()]?.slice(0, 3)}`;
}

/** Monday of the week that holds `key`. */
export function weekStart(key: DayKey): DayKey {
  const weekday = (dateOfDay(key).getDay() + 6) % 7; // Monday = 0
  return addDays(key, -weekday);
}

/** Mon…Sun of the week that holds `key`. */
export function weekDays(key: DayKey): DayKey[] {
  const start = weekStart(key);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

export interface GridCell {
  day: DayKey;
  /** False for the leading / trailing days of the neighbouring months. */
  inMonth: boolean;
}

/** Whole weeks (Monday first) covering `month`, with the neighbouring months' days around it. */
export function monthGrid(month: MonthKey): GridCell[] {
  const first: DayKey = `${month.year}-${pad(month.month)}-01`;
  const daysInMonth = new Date(month.year, month.month, 0).getDate();
  const leading = (dateOfDay(first).getDay() + 6) % 7;
  const total = Math.ceil((leading + daysInMonth) / 7) * 7;
  const start = addDays(first, -leading);
  return Array.from({ length: total }, (_, i) => {
    const day = addDays(start, i);
    return { day, inMonth: sameMonth(monthOf(day), month) };
  });
}

// --- schedule state (StudioKit ScheduleDisplayState) --------------------------------------------

export type ScheduleState =
  /** Pending; this Mac publishes it at the time (it must be on). */
  | { kind: "waitingOnMac" }
  /** Pending, cloud mode, but the order has not reached the cloud yet (or was refused). */
  | { kind: "sendingToCloud"; error: string | null }
  /** Pending and at the cloud publisher: goes out even if the Mac is off. */
  | { kind: "inCloud" }
  | { kind: "publishing" }
  | { kind: "published"; permalink: string | null }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" };

export function scheduleState(schedule: Schedule, mode: PublishingMode): ScheduleState {
  switch (schedule.status) {
    case "pending":
      if (schedule.delivery === "cloud" && schedule.cloudSyncedAt) return { kind: "inCloud" };
      if (mode === "cloud" || schedule.delivery === "cloud") {
        return { kind: "sendingToCloud", error: schedule.lastError ?? null };
      }
      return { kind: "waitingOnMac" };
    case "publishing":
      return { kind: "publishing" };
    case "published":
      return { kind: "published", permalink: schedule.permalink ?? null };
    case "failed":
      return { kind: "failed", reason: schedule.lastError ?? "Yayın başarısız oldu." };
    default:
      return { kind: "cancelled" };
  }
}

export function scheduleLabel(state: ScheduleState): string {
  switch (state.kind) {
    case "waitingOnMac":
      return "Zamanlandı";
    case "sendingToCloud":
      return state.error === null ? "Buluta gönderiliyor" : "Buluta gönderilemedi";
    case "inCloud":
      return "Bulutta";
    case "publishing":
      return "Yayınlanıyor";
    case "published":
      return "Yayınlandı";
    case "failed":
      return "Hata";
    case "cancelled":
      return "İptal edildi";
  }
}

/** One line under the label. */
export function scheduleDetail(state: ScheduleState): string | null {
  switch (state.kind) {
    case "waitingOnMac":
      return "Mac açık olmalı: yayını bu Mac yapacak.";
    case "sendingToCloud":
      return state.error ?? "Bulut yayıncıya aktarılıyor.";
    case "inCloud":
      return "Mac kapalı olsa da zamanında paylaşılır.";
    case "publishing":
      return "Platforma gönderiliyor.";
    case "failed":
      return state.reason;
    default:
      return null;
  }
}

/** Orange is only for what waits on the owner. */
export function needsOwner(state: ScheduleState): boolean {
  return state.kind === "failed" || (state.kind === "sendingToCloud" && state.error !== null);
}

/** Pending schedules can be cancelled and moved. */
export function canMove(state: ScheduleState): boolean {
  return (
    state.kind === "waitingOnMac" || state.kind === "sendingToCloud" || state.kind === "inCloud"
  );
}

// --- entries --------------------------------------------------------------------------------------

/** Dot kinds, problems first (the grid shows at most three per day in this order). */
export type EntryKind = "error" | "scheduled" | "approved" | "planned" | "published";
export const DOT_ORDER: EntryKind[] = ["error", "scheduled", "approved", "planned", "published"];
export const MAX_DOTS = 3;

export type StatusTone = "accent" | "warning" | "neutral" | "success" | "danger";

export interface CalendarEntry {
  id: string;
  day: DayKey;
  /** Sort time (ms): the schedule's time; dated posts sort after the day's schedules. */
  at: number;
  /** "10:00", or "—" for a dated post without a schedule. */
  time: string;
  title: string;
  platform: Platform | null;
  contentType: ContentType | null;
  /** "MTM Agro · kaydırmalı". */
  meta: string;
  /** "@mtmagro" for a schedule's account. */
  handle: string | null;
  status: string;
  tone: StatusTone;
  kind: EntryKind;
  /** One line explaining the state (Mac must be on, the error …). */
  detail: string | null;
  contentId: string;
  scheduleId: string | null;
  /** The schedule's time (ms), null for a dated post. */
  scheduledAt: number | null;
  /** A pending schedule: it can be dragged onto another day. */
  canMove: boolean;
  /** Failed / refused: waiting on the owner. */
  needsOwner: boolean;
}

export const CONTENT_TYPE_LABEL: Record<ContentType, string> = {
  post: "tek görsel",
  carousel: "kaydırmalı",
  story: "hikâye",
  reel: "Reels",
};

export const PLATFORM_LABEL: Record<Platform, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  linkedin: "LinkedIn",
};

/** A dated post's status (no schedule on the calendar). */
export function contentStatus(status: ContentStatus): {
  label: string;
  tone: StatusTone;
  kind: EntryKind;
} {
  switch (status) {
    case "published":
      return { label: "Yayınlandı", tone: "success", kind: "published" };
    case "scheduled":
      return { label: "Zamanlandı", tone: "accent", kind: "scheduled" };
    case "publishing":
      return { label: "Yayınlanıyor", tone: "accent", kind: "scheduled" };
    case "approved":
      return { label: "Onaylandı · zamanlanmadı", tone: "neutral", kind: "approved" };
    case "failed":
      return { label: "Yayın hatası", tone: "danger", kind: "error" };
    case "in_review":
      return { label: "Onay bekliyor", tone: "warning", kind: "planned" };
    default:
      return { label: "Taslak", tone: "neutral", kind: "planned" };
  }
}

function scheduleTone(state: ScheduleState): { tone: StatusTone; kind: EntryKind } {
  switch (state.kind) {
    case "published":
      return { tone: "success", kind: "published" };
    case "failed":
      return { tone: "danger", kind: "error" };
    case "sendingToCloud":
      return state.error !== null
        ? { tone: "danger", kind: "error" }
        : { tone: "accent", kind: "scheduled" };
    case "cancelled":
      return { tone: "neutral", kind: "planned" };
    default:
      return { tone: "accent", kind: "scheduled" };
  }
}

const hm = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function handleOf(account: SocialAccount | undefined): string | null {
  if (!account) return null;
  const handle = account.handle.trim();
  if (!handle) return null;
  return handle.startsWith("@") || account.platform !== "instagram" ? handle : `@${handle}`;
}

export interface EntriesInput {
  schedules: readonly Schedule[];
  contents: readonly Content[];
  plans: readonly Plan[];
  accounts?: readonly SocialAccount[];
  brandName?: string | null;
  mode?: PublishingMode;
}

/**
 * Every entry, sorted by day, time and title. A post that has a schedule shows only its
 * schedule rows; other accepted plan items show on their plan date.
 */
export function buildEntries(input: EntriesInput): CalendarEntry[] {
  const mode = input.mode ?? "local";
  const contentById = new Map(input.contents.map((c) => [c.id, c]));
  const accountById = new Map((input.accounts ?? []).map((a) => [a.id, a]));
  const metaOf = (content: Content | undefined, fallback: string) => {
    const parts = [
      input.brandName?.trim() || null,
      content ? CONTENT_TYPE_LABEL[content.type] : fallback,
    ];
    return parts.filter(Boolean).join(" · ");
  };
  const entries: CalendarEntry[] = [];
  const scheduled = new Set<string>();

  for (const schedule of input.schedules) {
    if (schedule.status === "cancelled") continue;
    const at = Date.parse(schedule.scheduledAt);
    if (Number.isNaN(at)) continue;
    const state = scheduleState(schedule, mode);
    const content = contentById.get(schedule.contentId);
    const { tone, kind } = scheduleTone(state);
    scheduled.add(schedule.contentId);
    entries.push({
      id: `sch-${schedule.id}`,
      day: dayKey(at),
      at,
      time: hm(at),
      title: content?.title.trim() || "Post",
      platform: schedule.platform,
      contentType: content?.type ?? null,
      meta: metaOf(content, PLATFORM_LABEL[schedule.platform]),
      handle: handleOf(accountById.get(schedule.socialAccountId)),
      status: scheduleLabel(state),
      tone,
      kind,
      detail: scheduleDetail(state),
      contentId: schedule.contentId,
      scheduleId: schedule.id,
      scheduledAt: at,
      canMove: canMove(state),
      needsOwner: needsOwner(state),
    });
  }

  // Dated posts: accepted plan items with a content and a day (the newest plan wins).
  const dated = new Map<string, { date: string; platforms: Platform[] }>();
  for (const plan of [...input.plans].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    for (const item of plan.items) {
      if (item.contentId && item.date) {
        dated.set(item.contentId, { date: item.date, platforms: item.platforms });
      }
    }
  }
  for (const [contentId, { date, platforms }] of dated) {
    if (scheduled.has(contentId)) continue;
    const content = contentById.get(contentId);
    if (!content) continue;
    const status = contentStatus(content.status);
    const platform = content.targetPlatforms[0] ?? platforms[0] ?? null;
    const { year, month, day } = parseDay(date);
    entries.push({
      id: `post-${contentId}`,
      day: date,
      at: new Date(year, month - 1, day, 23, 59, 59).getTime(),
      time: "—",
      title: content.title.trim() || "Post",
      platform,
      contentType: content.type,
      meta: metaOf(content, platform ? PLATFORM_LABEL[platform] : ""),
      handle: null,
      status: status.label,
      tone: status.tone,
      kind: status.kind,
      detail: null,
      contentId,
      scheduleId: null,
      scheduledAt: null,
      canMove: false,
      needsOwner: content.status === "failed",
    });
  }

  return entries.sort(
    (a, b) => a.day.localeCompare(b.day) || a.at - b.at || a.title.localeCompare(b.title, "tr"),
  );
}

export interface DaySummary {
  /** One dot per kind, problems first, at most MAX_DOTS. */
  dots: EntryKind[];
  count: number;
}

export function daySummaries(entries: readonly CalendarEntry[]): Map<DayKey, DaySummary> {
  const byDay = new Map<DayKey, CalendarEntry[]>();
  for (const e of entries) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e]);
  const out = new Map<DayKey, DaySummary>();
  for (const [day, list] of byDay) {
    const kinds = new Set(list.map((e) => e.kind));
    out.set(day, {
      dots: DOT_ORDER.filter((k) => kinds.has(k)).slice(0, MAX_DOTS),
      count: list.length,
    });
  }
  return out;
}

export function entriesOn(entries: readonly CalendarEntry[], day: DayKey): CalendarEntry[] {
  return entries.filter((e) => e.day === day);
}

/** Schedules waiting on the owner (failed, refused by the cloud). */
export function needsAttention(entries: readonly CalendarEntry[]): CalendarEntry[] {
  return entries.filter((e) => e.needsOwner);
}

/** The day the pane selects in `month`: today in this month, else its first day with posts, else the 1st. */
export function defaultDay(
  month: MonthKey,
  entries: readonly CalendarEntry[],
  today: DayKey,
): DayKey {
  if (sameMonth(monthOf(today), month)) return today;
  const days = entries.map((e) => e.day).filter((d) => sameMonth(monthOf(d), month));
  return days.sort()[0] ?? `${month.year}-${pad(month.month)}-01`;
}

/** The month (of those with entries) nearest to `current`; `current` when it has entries. */
export function nearestActiveMonth(entries: readonly CalendarEntry[], current: MonthKey): MonthKey {
  const months = new Map<string, MonthKey>();
  for (const e of entries) {
    const m = monthOf(e.day);
    months.set(`${m.year}-${m.month}`, m);
  }
  if (months.size === 0 || months.has(`${current.year}-${current.month}`)) return current;
  const index = (m: MonthKey) => m.year * 12 + m.month;
  return [...months.values()].sort(
    (a, b) => Math.abs(index(a) - index(current)) - Math.abs(index(b) - index(current)),
  )[0] as MonthKey;
}

// --- moving (drag to reschedule) ----------------------------------------------------------------

/** Hours of the week view; schedules outside sit on the first / last row. */
export const WEEK_HOURS = Array.from({ length: 18 }, (_, i) => i + 6);

export function weekRowHour(ms: number): number {
  const hour = new Date(ms).getHours();
  return Math.min(Math.max(hour, WEEK_HOURS[0] as number), WEEK_HOURS.at(-1) as number);
}

/**
 * Where a drop lands: the same local time on `day` (month grid), or `day` at `hour` keeping the
 * minutes (week view).
 */
export function moveTarget(originalMs: number, day: DayKey, hour?: number): number {
  const original = new Date(originalMs);
  const { year, month, day: d } = parseDay(day);
  const h = hour === undefined ? original.getHours() : Math.max(0, Math.min(23, hour));
  return new Date(year, month - 1, d, h, original.getMinutes(), 0, 0).getTime();
}

/** The API refuses times in the past; this is the earliest it accepts, with a margin. */
export function earliestSchedule(nowMs: number): number {
  return nowMs + 60_000;
}

export type MoveCheck =
  | { kind: "move"; target: number }
  | { kind: "same" }
  | { kind: "refused"; reason: string };

export function checkMove(
  entry: Pick<CalendarEntry, "canMove" | "scheduledAt" | "scheduleId">,
  day: DayKey,
  nowMs: number,
  hour?: number,
): MoveCheck {
  if (!entry.scheduleId || entry.scheduledAt === null || !entry.canMove) {
    return { kind: "refused", reason: "Yalnızca bekleyen zamanlamalar taşınabilir." };
  }
  const target = moveTarget(entry.scheduledAt, day, hour);
  if (Math.abs(target - entry.scheduledAt) < 30_000) return { kind: "same" };
  if (target < earliestSchedule(nowMs)) {
    return { kind: "refused", reason: "Geçmiş bir zamana taşınamaz." };
  }
  return { kind: "move", target };
}

/** The schedule list with `id` moved to `target` (optimistic update). */
export function withMovedSchedule(
  schedules: readonly Schedule[],
  id: string,
  target: number,
): Schedule[] {
  const iso = new Date(target).toISOString();
  return schedules.map((s) => (s.id === id ? { ...s, scheduledAt: iso } : s));
}

// --- drag payload ---------------------------------------------------------------------------------

export const SCHEDULE_DRAG_MIME = "application/x-studio-schedule";
