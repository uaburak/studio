// The full calendar ("Takvimi aç"): month grid with the posts in each day, or a week with hour
// rows; problems listed on top; drag a pending schedule onto another day (or hour) to move it,
// or cancel it from its row; a click on a post opens it.
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, cn, IconButton, SegmentedControl } from "../../components/ui/controls.tsx";
import {
  IconAlert,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
} from "../../components/ui/icons.tsx";
import { describeError } from "../../lib/api.ts";
import { openPost } from "../../state/post-opener.ts";
import { PageHeader, PaneMessage } from "../pane-ui.tsx";
import { usePanelBrand } from "../panel-brand.ts";
import { useCalendarData, useReschedule } from "./calendar-data.ts";
import {
  addDays,
  addMonths,
  type CalendarEntry,
  type DayKey,
  dayKey,
  dayTitle,
  defaultDay,
  entriesOn,
  type MonthKey,
  monthGrid,
  monthOf,
  monthTitle,
  nearestActiveMonth,
  needsAttention,
  parseDay,
  sameMonth,
  shortDay,
  WEEK_HOURS,
  WEEKDAY_LABELS,
  weekDays,
  weekRowHour,
} from "./calendar-model.ts";
import {
  AgendaRow,
  CancelEntryButton,
  DOT_COLOR,
  EntryIcon,
  StatusTag,
  startScheduleDrag,
  useCancelEntry,
  useScheduleDropTarget,
} from "./calendar-views.tsx";

type View = "month" | "week";

const rectOf = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
};

export default function CalendarPage() {
  const { brandId, brand } = usePanelBrand();
  if (!brandId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Takvim" />
        <div className="px-8">
          <PaneMessage
            icon={<IconCalendar size={18} />}
            text="Takvim için kenar çubuğunun altındaki menüden bir marka seç."
          />
        </div>
      </div>
    );
  }
  return <CalendarPageBody key={brandId} brandId={brandId} brandName={brand?.name ?? ""} />;
}

function CalendarPageBody({ brandId, brandName }: { brandId: string; brandName: string }) {
  const data = useCalendarData(brandId);
  const reschedule = useReschedule(brandId);
  const cancel = useCancelEntry();
  const today = dayKey(new Date());
  const [view, setView] = useState<View>("month");
  const [month, setMonth] = useState<MonthKey>(() => monthOf(today));
  const [selected, setSelected] = useState<DayKey>(today);
  const [scope, setScope] = useState<"day" | "month">("day");

  const jumped = useRef(false);
  useEffect(() => {
    if (!data.loaded || jumped.current) return;
    jumped.current = true;
    const nearest = nearestActiveMonth(data.entries, month);
    if (!sameMonth(nearest, month)) {
      setMonth(nearest);
      setSelected(defaultDay(nearest, data.entries, today));
    }
  }, [data.loaded, data.entries, month, today]);

  const week = weekDays(selected);
  const title =
    view === "week"
      ? `${shortDay(week[0] as DayKey)} – ${shortDay(week[6] as DayKey)} ${parseDay(week[6] as DayKey).year}`
      : monthTitle(month);

  const go = (delta: number) => {
    if (view === "week") {
      const next = addDays(selected, delta * 7);
      setSelected(next);
      setMonth(monthOf(next));
    } else {
      const next = addMonths(month, delta);
      setMonth(next);
      setSelected(defaultDay(next, data.entries, today));
    }
  };

  const select = (day: DayKey) => {
    setSelected(day);
    if (!sameMonth(monthOf(day), month)) setMonth(monthOf(day));
  };

  const move = (scheduleId: string, target: string) => {
    const entry = data.entries.find((e) => e.scheduleId === scheduleId);
    if (!entry) return;
    const [day, hour] = target.split("|");
    void reschedule(entry, day as DayKey, hour === undefined ? undefined : Number(hour)).then(
      (ok) => ok && select(day as DayKey),
    );
  };

  const open = (entry: CalendarEntry, el: Element) => openPost(entry.contentId, rectOf(el));
  const attention = needsAttention(data.entries);
  const listed =
    scope === "day"
      ? entriesOn(data.entries, selected)
      : data.entries.filter((e) => sameMonth(monthOf(e.day), month));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Takvim"
        subtitle={brandName || undefined}
        actions={
          <>
            <Button
              size="md"
              onClick={() => {
                setSelected(today);
                setMonth(monthOf(today));
              }}
            >
              Bugün
            </Button>
            <IconButton
              icon={<IconChevronLeft size={16} strokeWidth={1.5} />}
              label={view === "week" ? "Önceki hafta" : "Önceki ay"}
              onClick={() => go(-1)}
            />
            <IconButton
              icon={<IconChevronRight size={16} strokeWidth={1.5} />}
              label={view === "week" ? "Sonraki hafta" : "Sonraki ay"}
              onClick={() => go(1)}
            />
            <span className="min-w-[150px] text-center text-body-lg font-medium text-fg tabular-nums">
              {title}
            </span>
            <SegmentedControl<View>
              label="Görünüm"
              value={view}
              onChange={setView}
              options={[
                { value: "month", label: "Ay" },
                { value: "week", label: "Hafta" },
              ]}
            />
          </>
        }
      />
      <div className="scroll-area min-h-0 flex-1 px-8 pb-10">
        {data.error && (
          <p className="mb-3 text-body text-danger" role="alert">
            {describeError(data.error)}
          </p>
        )}
        {attention.length > 0 && (
          <section
            aria-label="İlgini bekleyenler"
            className="mb-4 rounded-[12px] bg-accent-subtle px-4 py-3"
          >
            <div className="mb-1 flex items-center gap-2 text-body font-medium text-accent-text">
              <IconAlert size={14} strokeWidth={1.75} />
              {attention.length === 1
                ? "Bir paylaşım ilgini bekliyor"
                : `${attention.length} paylaşım ilgini bekliyor`}
            </div>
            <ul className="flex flex-col">
              {attention.slice(0, 5).map((e) => (
                <li key={e.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={(event) => open(e, event.currentTarget)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-full py-1 text-left text-body text-fg hover:underline"
                  >
                    <span className="text-fg-2 tabular-nums">
                      {shortDay(e.day)} {e.time}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{e.title}</span>
                    <span className="truncate text-footnote text-fg-2">{e.detail ?? e.status}</span>
                  </button>
                  <CancelEntryButton entry={e} onCancel={cancel.ask} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {view === "month" ? (
          <MonthGrid
            month={month}
            today={today}
            selected={selected}
            entries={data.entries}
            onSelect={select}
            onOpen={open}
            onMove={move}
          />
        ) : (
          <WeekGrid
            days={week}
            today={today}
            entries={data.entries}
            onSelect={select}
            onOpen={open}
            onMove={move}
          />
        )}
        <section className="mt-6 max-w-[720px]">
          <div className="mb-2 flex items-center gap-3">
            <h2 className="min-w-0 flex-1 text-heading font-semibold text-fg">
              {scope === "day" ? dayTitle(selected) : monthTitle(month)}
            </h2>
            <SegmentedControl<"day" | "month">
              label="Liste"
              value={scope}
              onChange={setScope}
              options={[
                { value: "day", label: "Seçili gün" },
                { value: "month", label: "Tüm ay" },
              ]}
            />
          </div>
          {data.loading && <p className="text-body text-fg-3">Yükleniyor…</p>}
          {!data.loading && listed.length === 0 && (
            <p className="text-body text-fg-3">
              {scope === "day" ? "Bu gün için paylaşım yok." : "Bu ay paylaşım yok."}
            </p>
          )}
          <div className="flex flex-col">
            {listed.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3">
                {scope === "month" && (
                  <span className="w-12 shrink-0 text-footnote text-fg-3">
                    {shortDay(entry.day)}
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <AgendaRow
                    entry={entry}
                    onOpen={(e, rect) =>
                      openPost(e.contentId, {
                        x: rect.left,
                        y: rect.top,
                        width: rect.width,
                        height: rect.height,
                      })
                    }
                  />
                </div>
                {entry.detail && (
                  <span className="hidden w-[260px] shrink-0 truncate text-footnote text-fg-3 xl:block">
                    {entry.detail}
                  </span>
                )}
                <span className="flex w-6 shrink-0 justify-center">
                  <CancelEntryButton entry={entry} onCancel={cancel.ask} />
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
      {cancel.dialog}
    </div>
  );
}

function EntryChip({
  entry,
  onOpen,
}: {
  entry: CalendarEntry;
  onOpen(entry: CalendarEntry, el: Element): void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: draggable chip
    <div
      role="button"
      tabIndex={0}
      draggable={entry.canMove}
      onDragStart={(event) => startScheduleDrag(event, entry)}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(entry, event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") onOpen(entry, event.currentTarget);
      }}
      title={`${entry.time} · ${entry.title} · ${entry.status}${entry.detail ? ` — ${entry.detail}` : ""}`}
      data-entry={entry.id}
      className="flex h-6 min-w-0 items-center gap-1.5 rounded-[6px] px-1.5 text-footnote text-fg hover:bg-control"
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", DOT_COLOR[entry.kind])} />
      {entry.scheduleId && <span className="shrink-0 text-fg-3 tabular-nums">{entry.time}</span>}
      <span className="min-w-0 flex-1 truncate">{entry.title}</span>
    </div>
  );
}

function MonthGrid({
  month,
  today,
  selected,
  entries,
  onSelect,
  onOpen,
  onMove,
}: {
  month: MonthKey;
  today: DayKey;
  selected: DayKey;
  entries: CalendarEntry[];
  onSelect(day: DayKey): void;
  onOpen(entry: CalendarEntry, el: Element): void;
  onMove(scheduleId: string, target: string): void;
}) {
  const cells = monthGrid(month);
  const byDay = useMemo(() => {
    const map = new Map<DayKey, CalendarEntry[]>();
    for (const e of entries) map.set(e.day, [...(map.get(e.day) ?? []), e]);
    return map;
  }, [entries]);
  const drop = useScheduleDropTarget(onMove);
  return (
    <div className="overflow-hidden rounded-[12px] border border-hairline">
      <div className="grid grid-cols-7 border-b border-hairline">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="px-2.5 py-2 text-footnote text-fg-3">
            {d}
          </div>
        ))}
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a month of draggable chips, not a data table */}
      <div className="grid grid-cols-7" role="grid" aria-label={monthTitle(month)}>
        {cells.map((cell, i) => {
          const list = byDay.get(cell.day) ?? [];
          const isToday = cell.day === today;
          const isSelected = cell.day === selected;
          return (
            // biome-ignore lint/a11y/useSemanticElements: a day cell holding draggable chips
            <div
              key={cell.day}
              role="gridcell"
              tabIndex={-1}
              aria-selected={isSelected}
              data-day={cell.day}
              onClick={() => onSelect(cell.day)}
              onKeyDown={(event) => {
                if (event.key === "Enter") onSelect(cell.day);
              }}
              {...drop.props(cell.day)}
              className={cn(
                "flex min-h-[112px] min-w-0 flex-col gap-0.5 border-hairline p-1.5 transition-colors duration-150",
                i % 7 !== 6 && "border-r",
                i < cells.length - 7 && "border-b",
                !cell.inMonth && "bg-[color-mix(in_srgb,var(--fill-field)_60%,transparent)]",
                isSelected && "bg-field",
                drop.over === cell.day && "shadow-[inset_0_0_0_1.5px_var(--accent-default)]",
              )}
            >
              <div className="flex h-6 items-center px-1">
                <span
                  className={cn(
                    "flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-footnote tabular-nums",
                    isToday
                      ? "bg-accent font-semibold text-on-accent"
                      : cell.inMonth
                        ? "text-fg"
                        : "text-fg-3",
                  )}
                >
                  {parseDay(cell.day).day}
                </span>
              </div>
              {list.slice(0, 3).map((entry) => (
                <EntryChip key={entry.id} entry={entry} onOpen={onOpen} />
              ))}
              {list.length > 3 && (
                <span className="px-1.5 text-caption text-fg-3">+{list.length - 3} daha</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WeekGrid({
  days,
  today,
  entries,
  onSelect,
  onOpen,
  onMove,
}: {
  days: DayKey[];
  today: DayKey;
  entries: CalendarEntry[];
  onSelect(day: DayKey): void;
  onOpen(entry: CalendarEntry, el: Element): void;
  onMove(scheduleId: string, target: string): void;
}) {
  const drop = useScheduleDropTarget(onMove);
  const cell = (day: DayKey, hour: number) =>
    entries.filter((e) => e.day === day && e.scheduledAt !== null && weekRowHour(e.at) === hour);
  return (
    <div className="overflow-hidden rounded-[12px] border border-hairline">
      <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-hairline">
        <div />
        {days.map((day, i) => (
          <button
            key={day}
            type="button"
            onClick={() => onSelect(day)}
            className={cn(
              "flex items-baseline gap-1.5 px-2.5 py-2 text-left text-footnote",
              day === today ? "text-accent-text" : "text-fg-2",
            )}
          >
            {WEEKDAY_LABELS[i]}
            <span className={cn("text-body-lg", day === today ? "font-semibold" : "text-fg")}>
              {parseDay(day).day}
            </span>
          </button>
        ))}
      </div>
      {/* Dated posts without a time. */}
      <div className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-hairline">
        <div className="px-2 py-1.5 text-caption text-fg-3">Gün</div>
        {days.map((day) => (
          <div key={day} className="min-w-0 border-l border-hairline p-1">
            {entries
              .filter((e) => e.day === day && e.scheduledAt === null)
              .map((entry) => (
                <EntryChip key={entry.id} entry={entry} onOpen={onOpen} />
              ))}
          </div>
        ))}
      </div>
      {WEEK_HOURS.map((hour) => (
        <div
          key={hour}
          className="grid grid-cols-[56px_repeat(7,minmax(0,1fr))] border-b border-hairline last:border-b-0"
        >
          <div className="px-2 py-1.5 text-caption text-fg-3 tabular-nums">
            {String(hour).padStart(2, "0")}:00
          </div>
          {days.map((day) => {
            const target = `${day}|${hour}`;
            return (
              <div
                key={target}
                data-slot={target}
                {...drop.props(target)}
                className={cn(
                  "min-h-10 min-w-0 border-l border-hairline p-0.5",
                  drop.over === target && "shadow-[inset_0_0_0_1.5px_var(--accent-default)]",
                )}
              >
                {cell(day, hour).map((entry) => (
                  // biome-ignore lint/a11y/useSemanticElements: draggable event block
                  <div
                    key={entry.id}
                    role="button"
                    tabIndex={0}
                    draggable={entry.canMove}
                    onDragStart={(event) => startScheduleDrag(event, entry)}
                    onClick={(event) => onOpen(entry, event.currentTarget)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") onOpen(entry, event.currentTarget);
                    }}
                    title={`${entry.title} · ${entry.status}`}
                    className="mb-0.5 flex min-w-0 items-center gap-1.5 rounded-[6px] bg-field px-1.5 py-1 text-footnote text-fg hover:bg-control"
                  >
                    <span className="flex size-3.5 shrink-0 items-center justify-center text-icon">
                      <EntryIcon entry={entry} size={13} />
                    </span>
                    <span className="shrink-0 text-fg-3 tabular-nums">{entry.time}</span>
                    <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                    <span className="hidden 2xl:inline-flex">
                      <StatusTag tone={entry.tone}>{entry.status}</StatusTag>
                    </span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
