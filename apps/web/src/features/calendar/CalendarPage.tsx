import type { Schedule } from "@studio/contract";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { fetchAllPages, useApi } from "../../api.ts";
import {
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconGrid,
  IconList,
  IconPlatform,
  IconPlus,
} from "../../components/icons.tsx";
import { BrandMark, PageHeader } from "../../components/page.tsx";
import { EmptyState, ErrorState, Notice } from "../../components/states.tsx";
import { Button, cx, IconButton, Segmented, Spinner } from "../../components/ui.tsx";
import { useBrandName, useBrands } from "../../lib/brand-context.tsx";
import {
  buildMonthGrid,
  dayKey,
  formatDayHeading,
  formatMonthTitle,
  formatOffset,
  formatTime,
  shiftMonth,
  userTimeZone,
  utcRangeForDays,
  utcToZoned,
  WEEKDAYS_SHORT,
} from "../../lib/datetime.ts";
import { PLATFORM_LABELS, SCHEDULE_STATUS } from "../../lib/labels.ts";
import { queryKeys } from "../../lib/query-keys.ts";
import { ScheduleDetailDialog } from "./ScheduleDetailDialog.tsx";
import { ScheduleDialog } from "./ScheduleDialog.tsx";

type View = "ay" | "liste";

/** Group schedules by wall-clock day in `timeZone`. */
export function groupByDay(schedules: Schedule[], timeZone: string): Map<string, Schedule[]> {
  const map = new Map<string, Schedule[]>();
  for (const s of schedules) {
    const key = dayKey(utcToZoned(new Date(s.scheduledAt), timeZone));
    const list = map.get(key);
    if (list) list.push(s);
    else map.set(key, [s]);
  }
  return map;
}

const STATUS_STRIPE: Record<Schedule["status"], string> = {
  pending: "bg-info",
  publishing: "bg-warn",
  published: "bg-good",
  failed: "bg-bad",
  cancelled: "bg-ink-3",
};

export function CalendarPage() {
  const api = useApi();
  const { brandId } = useBrands();
  const brandName = useBrandName();
  const timeZone = userTimeZone();
  const today = utcToZoned(new Date(), timeZone);
  const todayKey = dayKey(today);

  const [params, setParams] = useSearchParams();
  const view: View = params.get("gorunum") === "liste" ? "liste" : "ay";
  const monthParam = /^(\d{4})-(\d{2})$/.exec(params.get("ay") ?? "");
  const year = monthParam ? Number(monthParam[1]) : today.year;
  const month = monthParam ? Number(monthParam[2]) : today.month;

  const [showCancelled, setShowCancelled] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string>(todayKey);
  const [openSchedule, setOpenSchedule] = useState<Schedule | null>(null);
  const [creating, setCreating] = useState(false);

  const weeks = useMemo(() => buildMonthGrid(year, month), [year, month]);
  const first = weeks[0]?.[0];
  const range = useMemo(
    () => (first ? utcRangeForDays(first, weeks.length * 7, timeZone) : null),
    [first, weeks.length, timeZone],
  );

  const setParam = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };
  const goMonth = (delta: number) => {
    const m = shiftMonth(year, month, delta);
    setParam({ ay: `${m.year}-${String(m.month).padStart(2, "0")}` });
  };

  const filters = { brandId: brandId ?? undefined, from: range?.from, to: range?.to };
  const query = useQuery({
    queryKey: queryKeys.schedules.list(filters),
    queryFn: () =>
      fetchAllPages((cursor) => api.schedules.list({ ...filters, limit: 100, cursor })),
    enabled: range !== null,
  });

  const schedules = useMemo(
    () => (query.data ?? []).filter((s) => showCancelled || s.status !== "cancelled"),
    [query.data, showCancelled],
  );
  const byDay = useMemo(() => groupByDay(schedules, timeZone), [schedules, timeZone]);

  // Titles for the chips (shared cache with the content page).
  const contentIds = [...new Set(schedules.map((s) => s.contentId))];
  const contents = useQueries({
    queries: contentIds.map((id) => ({
      queryKey: queryKeys.contents.one(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => api.contents.get(id, { signal }),
      staleTime: 60_000,
    })),
  });
  const titleOf = (id: string) => contents.find((q) => q.data?.id === id)?.data?.title ?? "İçerik";

  const pendingCount = schedules.filter((s) => s.status === "pending").length;
  const monthDays = [...byDay.entries()]
    .filter(([key]) => key.startsWith(`${year}-${String(month).padStart(2, "0")}`))
    .sort(([a], [b]) => a.localeCompare(b));
  const selectedList = byDay.get(selectedDay) ?? [];

  const chip = (s: Schedule, compact = false) => (
    <button
      key={s.id}
      type="button"
      onClick={() => setOpenSchedule(s)}
      className={cx(
        "group flex w-full items-center gap-1.5 overflow-hidden rounded-md bg-surface-2 text-left hover:bg-surface-3",
        compact ? "h-6 gap-1 pr-1.5 text-[11px]" : "h-11 pr-3 text-[13px]",
        s.status === "cancelled" && "line-through opacity-60",
      )}
      title={`${formatTime(s.scheduledAt, timeZone)} · ${titleOf(s.contentId)} · ${SCHEDULE_STATUS[s.status].label}`}
    >
      <span className={cx("h-full w-1 shrink-0", STATUS_STRIPE[s.status])} aria-hidden="true" />
      <span className="shrink-0 font-mono text-ink-2 tabular-nums">
        {formatTime(s.scheduledAt, timeZone)}
      </span>
      {!compact && <IconPlatform platform={s.platform} size={16} className="shrink-0 text-ink-3" />}
      <span className="truncate font-medium text-ink">{titleOf(s.contentId)}</span>
      {!compact && (
        <span className="ml-auto shrink-0 text-[12px] text-ink-3">
          {SCHEDULE_STATUS[s.status].label}
        </span>
      )}
      <span className="sr-only">
        {PLATFORM_LABELS[s.platform]}, {SCHEDULE_STATUS[s.status].label}
      </span>
    </button>
  );

  return (
    <>
      <PageHeader
        title="Takvim"
        description={`Zamanlanan paylaşımlar · ${timeZone} (${formatOffset(new Date(), timeZone)})`}
        actions={
          <Button variant="primary" icon={<IconPlus size={18} />} onClick={() => setCreating(true)}>
            Yeni zamanlama
          </Button>
        }
      />

      <Notice tone="warn">
        <strong>Otomatik yayın henüz yok (Faz 3).</strong> Takvimdeki kayıtlar planı tutar; zamanı
        gelince hiçbir şey paylaşılmaz.{" "}
        {pendingCount > 0 && `Bu ay ${pendingCount} bekleyen zamanlama var.`}
      </Notice>

      <div className="mt-6 mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <IconButton label="Önceki ay" onClick={() => goMonth(-1)}>
            <IconChevronLeft />
          </IconButton>
          <h2
            className="min-w-44 text-center font-display text-[30px] leading-none text-ink capitalize"
            aria-live="polite"
          >
            {formatMonthTitle(year, month)}
          </h2>
          <IconButton label="Sonraki ay" onClick={() => goMonth(1)}>
            <IconChevronRight />
          </IconButton>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setParam({ ay: null });
            setSelectedDay(todayKey);
          }}
        >
          Bugün
        </Button>
        {query.isFetching && <Spinner className="text-ink-3" />}
        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <input
              type="checkbox"
              checked={showCancelled}
              onChange={(e) => setShowCancelled(e.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            İptal edilenler
          </label>
          <Segmented
            name="calendar-view"
            label="Görünüm"
            size="sm"
            value={view}
            onChange={(v) => setParam({ gorunum: v === "liste" ? "liste" : null })}
            options={[
              {
                value: "ay",
                label: (
                  <>
                    <IconGrid size={14} /> Ay
                  </>
                ),
              },
              {
                value: "liste",
                label: (
                  <>
                    <IconList size={14} /> Liste
                  </>
                ),
              },
            ]}
          />
        </div>
      </div>

      {query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : view === "ay" ? (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="overflow-hidden rounded-2xl bg-surface shadow-card ring-1 ring-line/70">
            <div className="grid grid-cols-7 border-b border-line">
              {WEEKDAYS_SHORT.map((d) => (
                <div
                  key={d}
                  className="py-2 text-center text-[11px] font-semibold tracking-wide text-ink-3 uppercase"
                >
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {weeks.flat().map((day) => {
                const list = byDay.get(day.key) ?? [];
                const isToday = day.key === todayKey;
                const isSelected = day.key === selectedDay;
                return (
                  <div
                    key={day.key}
                    className={cx(
                      "relative min-h-16 border-r border-b border-line p-1 sm:min-h-28 sm:p-1.5 [&:nth-child(7n)]:border-r-0",
                      !day.inMonth && "bg-bg/60",
                      isSelected && "bg-accent/5",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedDay(day.key)}
                      aria-pressed={isSelected}
                      aria-label={`${formatDayHeading(day)}${list.length ? `, ${list.length} zamanlama` : ""}`}
                      className={cx(
                        "flex size-7 items-center justify-center rounded-full text-[12px] font-medium tabular-nums",
                        isToday
                          ? "bg-accent text-accent-ink"
                          : day.inMonth
                            ? "text-ink hover:bg-surface-2"
                            : "text-ink-3",
                        isSelected && !isToday && "ring-2 ring-accent",
                      )}
                    >
                      {day.day}
                    </button>
                    {/* Phones: dots. Larger screens: chips. */}
                    {list.length > 0 && (
                      <div
                        className="mt-1 flex flex-wrap gap-0.5 px-1 sm:hidden"
                        aria-hidden="true"
                      >
                        {list.slice(0, 4).map((s) => (
                          <span
                            key={s.id}
                            className={cx("size-1.5 rounded-full", STATUS_STRIPE[s.status])}
                          />
                        ))}
                      </div>
                    )}
                    <div className="mt-1 hidden flex-col gap-0.5 sm:flex">
                      {list.slice(0, 3).map((s) => chip(s, true))}
                      {list.length > 3 && (
                        <button
                          type="button"
                          onClick={() => setSelectedDay(day.key)}
                          className="px-1 text-left text-[11px] font-medium text-ink-3 hover:text-ink"
                        >
                          +{list.length - 3} daha
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <section aria-label="Seçili gün" className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-display text-[24px] leading-tight text-ink">
                {formatDayHeading(parseKey(selectedDay))}
              </h3>
              <Button
                size="sm"
                variant="ghost"
                icon={<IconPlus size={16} />}
                onClick={() => setCreating(true)}
              >
                Ekle
              </Button>
            </div>
            {query.isPending ? (
              <div className="skeleton h-11 rounded-md" />
            ) : selectedList.length === 0 ? (
              <p className="text-sm text-ink-3">Bu gün için zamanlama yok.</p>
            ) : (
              <div className="flex flex-col gap-1.5">{selectedList.map((s) => chip(s))}</div>
            )}
          </section>
        </div>
      ) : query.isPending ? (
        <div className="skeleton h-40 rounded-2xl" />
      ) : monthDays.length === 0 ? (
        <EmptyState title="Bu ay zamanlama yok" glyph={<IconCalendar size={24} />}>
          Onaylı bir içeriği zamanlayın; burada gün gün listelenir.
        </EmptyState>
      ) : (
        <ol className="flex flex-col gap-6">
          {monthDays.map(([key, list]) => (
            <li key={key}>
              <h3
                className={cx(
                  "mb-2 flex items-center gap-2 text-[13px] font-semibold",
                  key === todayKey ? "text-accent" : "text-ink-2",
                )}
              >
                {formatDayHeading(parseKey(key))}
                {key === todayKey && <span className="font-normal">· bugün</span>}
              </h3>
              <div className="flex flex-col gap-1.5">
                {list.map((s) => (
                  <div key={s.id} className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">{chip(s)}</div>
                    {!brandId && <BrandMark id={s.brandId} name={brandName(s.brandId)} size={24} />}
                  </div>
                ))}
              </div>
            </li>
          ))}
        </ol>
      )}

      <ScheduleDetailDialog
        schedule={openSchedule}
        contentTitle={openSchedule ? titleOf(openSchedule.contentId) : undefined}
        onClose={() => setOpenSchedule(null)}
      />
      <ScheduleDialog
        open={creating}
        onClose={() => setCreating(false)}
        // A future selected day prefills the date; otherwise the default slot (tomorrow 10:00).
        {...(selectedDay > todayKey ? { initialDate: selectedDay } : {})}
      />
    </>
  );
}

function parseKey(key: string) {
  const [y, m, d] = key.split("-").map(Number);
  return { year: y ?? 1970, month: m ?? 1, day: d ?? 1 };
}
