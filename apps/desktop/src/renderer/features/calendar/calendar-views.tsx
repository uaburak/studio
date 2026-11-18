// Calendar building blocks shared by the Takvim pane and the full calendar page (Wecra
// "Panel – Takvim"): status tags, the month grid with dots, agenda rows, schedule drag & drop,
// cancelling a pending schedule.
import { type DragEvent, type ReactNode, useState } from "react";
import { cn, IconButton } from "../../components/ui/controls.tsx";
import {
  IconChevronLeft,
  IconChevronRight,
  IconClose,
  IconImage,
  IconReel,
  PlatformIcon,
} from "../../components/ui/icons.tsx";
import { CancelScheduleDialog } from "../post-detail/cancel-schedule.tsx";
import {
  type CalendarEntry,
  type DayKey,
  type DaySummary,
  type EntryKind,
  entryCancelLabel,
  type MonthKey,
  monthGrid,
  monthTitle,
  parseDay,
  SCHEDULE_DRAG_MIME,
  type StatusTone,
  WEEKDAY_LABELS,
} from "./calendar-model.ts";

const TAG_TONES: Record<StatusTone, string> = {
  accent: "bg-accent-subtle text-accent-text",
  warning: "bg-control text-warning",
  neutral: "bg-control text-fg-2",
  success: "bg-control text-success",
  danger: "bg-[color-mix(in_srgb,var(--status-danger)_16%,transparent)] text-danger",
};

export function StatusTag({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-full px-[7px] text-caption whitespace-nowrap",
        TAG_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export const DOT_COLOR: Record<EntryKind, string> = {
  error: "bg-danger",
  scheduled: "bg-accent",
  approved: "bg-fg-2",
  planned: "bg-fg-3",
  published: "bg-success",
};

export function EntryIcon({ entry, size = 16 }: { entry: CalendarEntry; size?: number }) {
  if (entry.contentType === "reel") return <IconReel size={size} strokeWidth={1.4} />;
  if (entry.platform) return <PlatformIcon platform={entry.platform} size={size} />;
  return <IconImage size={size} strokeWidth={1.4} />;
}

// --- drag & drop of pending schedules -------------------------------------------------------------

export function startScheduleDrag(event: DragEvent, entry: CalendarEntry) {
  if (!entry.canMove || !entry.scheduleId) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(SCHEDULE_DRAG_MIME, entry.scheduleId);
}

export function isScheduleDrag(event: DragEvent): boolean {
  return [...event.dataTransfer.types].includes(SCHEDULE_DRAG_MIME);
}

/**
 * Drop-target props for a day (or a day + hour in the week view) and whether a schedule is
 * over it. `onDrop` gets the dragged schedule id.
 */
export function useScheduleDropTarget(onDrop: (scheduleId: string, target: string) => void) {
  const [over, setOver] = useState<string | null>(null);
  const props = (target: string) => ({
    onDragOver: (event: DragEvent) => {
      if (!isScheduleDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (over !== target) setOver(target);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      setOver((o) => (o === target ? null : o));
    },
    onDrop: (event: DragEvent) => {
      if (!isScheduleDrag(event)) return;
      event.preventDefault();
      setOver(null);
      const id = event.dataTransfer.getData(SCHEDULE_DRAG_MIME);
      if (id) onDrop(id, target);
    },
  });
  return { over, props };
}

// --- mini month (pane) -------------------------------------------------------------------------------

export function MonthHeader({
  month,
  onPrev,
  onNext,
}: {
  month: MonthKey;
  onPrev(): void;
  onNext(): void;
}) {
  return (
    <div className="flex h-7 items-center gap-1">
      <h3 className="min-w-0 flex-1 text-heading font-semibold text-fg">{monthTitle(month)}</h3>
      <button
        type="button"
        aria-label="Önceki ay"
        title="Önceki ay"
        onClick={onPrev}
        className="flex size-6 items-center justify-center rounded-full text-icon hover:bg-control"
      >
        <IconChevronLeft size={14} strokeWidth={1.75} />
      </button>
      <button
        type="button"
        aria-label="Sonraki ay"
        title="Sonraki ay"
        onClick={onNext}
        className="flex size-6 items-center justify-center rounded-full text-icon hover:bg-control"
      >
        <IconChevronRight size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}

export function MiniMonth({
  month,
  today,
  selected,
  summaries,
  onSelect,
  onDropSchedule,
}: {
  month: MonthKey;
  today: DayKey;
  selected: DayKey | null;
  summaries: Map<DayKey, DaySummary>;
  onSelect(day: DayKey): void;
  onDropSchedule(scheduleId: string, day: DayKey): void;
}) {
  const cells = monthGrid(month);
  const drop = useScheduleDropTarget(onDropSchedule);
  return (
    <section aria-label={monthTitle(month)}>
      <div className="grid grid-cols-7" aria-hidden="true">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="text-center text-caption leading-[14px] text-fg-3">
            {d}
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex flex-col gap-0.5">
        {Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7)).map(
          (week) => (
            <div key={week[0]?.day} className="grid grid-cols-7">
              {week.map((cell) => {
                const summary = summaries.get(cell.day);
                const isSelected = cell.day === selected;
                const isToday = cell.day === today;
                const label = `${parseDay(cell.day).day}${summary ? `, ${summary.count} paylaşım` : ""}`;
                return (
                  <button
                    key={cell.day}
                    type="button"
                    aria-pressed={isSelected}
                    aria-current={isToday ? "date" : undefined}
                    aria-label={label}
                    data-day={cell.day}
                    data-today={isToday || undefined}
                    onClick={() => onSelect(cell.day)}
                    {...drop.props(cell.day)}
                    className={cn(
                      "flex h-9 flex-col items-center justify-center gap-0.5 rounded-full text-footnote transition-colors duration-150",
                      isSelected
                        ? "bg-accent-subtle font-semibold text-accent-text"
                        : isToday
                          ? "bg-control font-semibold text-fg"
                          : cell.inMonth
                            ? "text-fg hover:bg-control"
                            : "text-fg-3 hover:bg-control",
                      drop.over === cell.day && "shadow-[inset_0_0_0_1.5px_var(--accent-default)]",
                    )}
                  >
                    <span className="leading-4 tabular-nums">{parseDay(cell.day).day}</span>
                    {summary && summary.dots.length > 0 && (
                      <span className="flex h-1 items-center gap-0.5" aria-hidden="true">
                        {summary.dots.map((kind) => (
                          <span key={kind} className={cn("size-1 rounded-full", DOT_COLOR[kind])} />
                        ))}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ),
        )}
      </div>
    </section>
  );
}

// --- agenda ---------------------------------------------------------------------------------------

export function AgendaRow({
  entry,
  onOpen,
  showMeta = true,
}: {
  entry: CalendarEntry;
  onOpen(entry: CalendarEntry, origin: DOMRect): void;
  showMeta?: boolean;
}) {
  const tooltip = [
    entry.handle,
    entry.detail,
    entry.canMove ? "Başka bir güne sürükleyebilirsin." : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    // biome-ignore lint/a11y/useSemanticElements: a draggable row (buttons do not drag well)
    <div
      role="button"
      tabIndex={0}
      draggable={entry.canMove}
      onDragStart={(event) => startScheduleDrag(event, entry)}
      onClick={(event) => onOpen(entry, event.currentTarget.getBoundingClientRect())}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen(entry, event.currentTarget.getBoundingClientRect());
        }
      }}
      title={tooltip || undefined}
      data-entry={entry.id}
      className={cn(
        "flex min-h-12 items-center gap-2.5 rounded-[10px] px-2.5 py-2 transition-colors duration-150 hover:bg-field",
        entry.canMove && "active:cursor-grabbing",
      )}
    >
      <span className="w-8 shrink-0 text-footnote text-fg-2 tabular-nums">{entry.time}</span>
      <span className="flex size-4 shrink-0 items-center justify-center text-icon">
        <EntryIcon entry={entry} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body text-fg">{entry.title}</span>
        {showMeta && entry.meta && (
          <span className="truncate text-caption text-fg-3">{entry.meta}</span>
        )}
      </span>
      <StatusTag tone={entry.tone}>{entry.status}</StatusTag>
    </div>
  );
}

// --- cancelling a pending schedule ------------------------------------------------------------------

/** "Zamanlamayı iptal et" on a calendar row (pending schedules only). */
export function CancelEntryButton({
  entry,
  onCancel,
}: {
  entry: CalendarEntry;
  onCancel(entry: CalendarEntry): void;
}) {
  if (!entry.canCancel || !entry.scheduleId) return null;
  return (
    <IconButton
      icon={<IconClose size={12} strokeWidth={1.75} />}
      label="Zamanlamayı iptal et"
      size={24}
      onClick={(event) => {
        event.stopPropagation();
        onCancel(entry);
      }}
    />
  );
}

/** The confirmation behind `CancelEntryButton`: `ask(entry)` and the dialog to render. */
export function useCancelEntry() {
  const [entry, setEntry] = useState<CalendarEntry | null>(null);
  const dialog = (
    <CancelScheduleDialog
      open={entry !== null && entry.scheduleId !== null}
      title={entry?.title ?? ""}
      contentId={entry?.contentId ?? ""}
      targets={
        entry?.scheduleId ? [{ scheduleId: entry.scheduleId, label: entryCancelLabel(entry) }] : []
      }
      onClose={() => setEntry(null)}
    />
  );
  return { ask: (e: CalendarEntry) => setEntry(e), dialog };
}
