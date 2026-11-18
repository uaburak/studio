// Takvim pane of the right panel (Wecra "Panel – Takvim"): the month with a dot per kind of post
// (problems first), the selected day's agenda (time, platform, title, status), drag a pending
// schedule onto another day to move it or cancel it from its row, "Takvimi aç →" opens the
// full calendar.
import { useEffect, useMemo, useRef, useState } from "react";
import { IconCalendar } from "../../components/ui/icons.tsx";
import { describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { openPost } from "../../state/post-opener.ts";
import { PaneMessage, TextLink } from "../pane-ui.tsx";
import { usePanelBrandId } from "../panel-brand.ts";
import { useCalendarData, useReschedule } from "./calendar-data.ts";
import {
  addMonths,
  dayKey,
  daySummaries,
  dayTitle,
  defaultDay,
  entriesOn,
  type MonthKey,
  monthOf,
  nearestActiveMonth,
  sameMonth,
} from "./calendar-model.ts";
import {
  AgendaRow,
  CancelEntryButton,
  MiniMonth,
  MonthHeader,
  useCancelEntry,
} from "./calendar-views.tsx";

export function CalendarPane() {
  const brandId = usePanelBrandId();
  if (!brandId) {
    return (
      <PaneMessage
        icon={<IconCalendar size={18} />}
        text="Takvim için başlıktaki menüden bir marka seç."
      />
    );
  }
  return <CalendarPaneBody key={brandId} brandId={brandId} />;
}

function CalendarPaneBody({ brandId }: { brandId: string }) {
  const navigate = useAppStore((s) => s.navigate);
  const data = useCalendarData(brandId);
  const reschedule = useReschedule(brandId);
  const cancel = useCancelEntry();
  const today = dayKey(new Date());
  const [month, setMonth] = useState<MonthKey>(() => monthOf(today));
  const [selected, setSelected] = useState<string | null>(today);
  const summaries = useMemo(() => daySummaries(data.entries), [data.entries]);

  // First load of a brand: show the nearest month that has posts.
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

  const go = (delta: number) => {
    const next = addMonths(month, delta);
    setMonth(next);
    setSelected(defaultDay(next, data.entries, today));
  };

  const shownDay = selected && sameMonth(monthOf(selected), month) ? selected : null;
  const agenda = shownDay ? entriesOn(data.entries, shownDay) : [];

  return (
    <div className="flex flex-col gap-2.5">
      <MonthHeader month={month} onPrev={() => go(-1)} onNext={() => go(1)} />
      <MiniMonth
        month={month}
        today={today}
        selected={shownDay}
        summaries={summaries}
        onSelect={(day) => {
          setSelected(day);
          if (!sameMonth(monthOf(day), month)) setMonth(monthOf(day));
        }}
        onDropSchedule={(scheduleId, day) => {
          const entry = data.entries.find((e) => e.scheduleId === scheduleId);
          if (!entry) return;
          void reschedule(entry, day).then((ok) => ok && setSelected(day));
        }}
      />
      <div className="h-px bg-hairline" />
      {data.error ? (
        <p className="text-footnote text-danger">{describeError(data.error)}</p>
      ) : data.loading ? (
        <p className="text-footnote text-fg-3">Yükleniyor…</p>
      ) : (
        <>
          {shownDay && <h3 className="text-body font-medium text-fg">{dayTitle(shownDay)}</h3>}
          {shownDay && agenda.length === 0 && (
            <p className="text-footnote text-fg-3">Bu gün için paylaşım yok.</p>
          )}
          {agenda.length > 0 && (
            <div className="flex flex-col">
              {agenda.map((entry) => (
                <div key={entry.id} className="flex items-center gap-1">
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
                  <CancelEntryButton entry={entry} onCancel={cancel.ask} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
      <div className="pt-1">
        <TextLink onClick={() => navigate({ kind: "calendar" })}>Takvimi aç →</TextLink>
      </div>
      {cancel.dialog}
    </div>
  );
}
