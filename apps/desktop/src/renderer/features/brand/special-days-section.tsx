// Marka Kiti → Özel günler (N5): the brand's sector tags (which sector days the plan agent and
// Takvim show) and the special-day categories switched off, saved as you go; below it the bayram
// dates for every brand, correctable when Diyanet's announced date differs from the computed one.
import {
  type Brand,
  dayMonthTr,
  istanbulToday,
  SECTOR_TAG_LABEL,
  SECTOR_TAGS,
  SPECIAL_DAY_CATEGORIES,
  SPECIAL_DAY_CATEGORY_LABEL,
} from "@studio/contract";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn, Spinner, Switch, TextField } from "../../components/ui/controls.tsx";
import { describeError } from "../../lib/api.ts";
import {
  usePlanningSettings,
  usePlanningSettingsActions,
  useSpecialDayOverrideActions,
  useSpecialDayOverrides,
} from "../calendar/special-days-data.ts";
import {
  type BayramRow,
  bayramRows,
  CATEGORY_EXAMPLES,
  overridesPut,
  type PlanningDraft,
  planningDraft,
  planningPut,
  toggleDayCategory,
  toggleTag,
} from "../calendar/special-days-model.ts";

type SaveState = "idle" | "saving" | "saved" | { error: string };

function SaveLine({ state }: { state: SaveState }) {
  if (state === "idle") return null;
  if (state === "saving")
    return (
      <span className="flex items-center gap-1.5 text-footnote text-fg-3">
        <Spinner size={11} /> Kaydediliyor
      </span>
    );
  if (state === "saved") return <span className="text-footnote text-fg-3">Kaydedildi</span>;
  return <span className="text-footnote text-danger">{state.error}</span>;
}

/** Saves `value` a moment after the last change. */
function useDebouncedSave<T>(save: (value: T) => Promise<unknown>) {
  const [state, setState] = useState<SaveState>("idle");
  const [pending, setPending] = useState<{ value: T } | null>(null);
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(async () => {
      setState("saving");
      try {
        await saveRef.current(pending.value);
        setState("saved");
      } catch (error) {
        setState({ error: describeError(error) });
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [pending]);
  return { state, queue: (value: T) => setPending({ value }) };
}

export function SpecialDaysSection({ brand }: { brand: Pick<Brand, "id"> }) {
  const settings = usePlanningSettings(brand.id);
  const actions = usePlanningSettingsActions(brand.id);
  const [draft, setDraft] = useState<PlanningDraft | null>(null);
  const saver = useDebouncedSave((d: PlanningDraft) => actions.put(planningPut(d)));

  useEffect(() => {
    if (settings.data && draft === null) setDraft(planningDraft(settings.data));
  }, [settings.data, draft]);

  const change = (next: PlanningDraft) => {
    setDraft(next);
    saver.queue(next);
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Özel günler">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-heading font-semibold text-fg">Özel günler</h2>
          <p className="text-body text-fg-2">
            Plan önerirken ve Takvim'de gösterilen Türkiye özel günleri. Sektör seçersen o sektörün
            günleri de eklenir; markaya uymayan türleri kapatabilirsin.
          </p>
        </div>
        <SaveLine state={saver.state} />
      </div>
      {settings.error ? (
        <p className="text-body text-danger">{describeError(settings.error)}</p>
      ) : !draft ? (
        <p className="flex items-center gap-1.5 text-body text-fg-3">
          <Spinner size={12} /> Ayarlar yükleniyor…
        </p>
      ) : (
        <SpecialDaysForm draft={draft} onChange={change} />
      )}
      <BayramDates />
    </section>
  );
}

/** The form (sector tags, categories). */
export function SpecialDaysForm({
  draft,
  onChange,
}: {
  draft: PlanningDraft;
  onChange(next: PlanningDraft): void;
}) {
  return (
    <div className="flex max-w-[960px] flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-[12px] p-3 shadow-[inset_0_0_0_1px_var(--border-hairline)]">
        <span className="text-body text-fg">Sektör</span>
        <span className="text-footnote text-fg-2">
          {draft.suggested
            ? "Marka profilinden ve ürünlerden önerildi; değiştirebilirsin."
            : "Seçtiğin sektörlerin günleri (ör. Tarım: Dünya Çiftçiler Günü, Dünya Toprak Günü) plana ve takvime eklenir."}
        </span>
        <ul className="flex flex-wrap gap-1.5" aria-label="Sektörler">
          {SECTOR_TAGS.map((tag) => {
            const on = draft.tags.has(tag);
            return (
              <li key={tag}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => onChange(toggleTag(draft, tag))}
                  className={cn(
                    "flex h-7 items-center rounded-full px-3 text-footnote transition-colors duration-150",
                    on ? "bg-accent-subtle text-accent-text" : "bg-control text-fg-2 hover:text-fg",
                  )}
                >
                  {SECTOR_TAG_LABEL[tag]}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      <ul className="flex flex-col rounded-[12px] py-1 shadow-[inset_0_0_0_1px_var(--border-hairline)]">
        {SPECIAL_DAY_CATEGORIES.map((category) => {
          const on = !draft.disabled.has(category);
          return (
            <li key={category} className="flex items-start gap-3 px-3 py-1.5">
              <span className="min-w-0 flex-1">
                <span className={cn("block text-body", on ? "text-fg" : "text-fg-3")}>
                  {SPECIAL_DAY_CATEGORY_LABEL[category]}
                </span>
                <span className="block text-footnote text-fg-2">{CATEGORY_EXAMPLES[category]}</span>
              </span>
              <span className="pt-0.5">
                <Switch
                  checked={on}
                  onChange={(value) => onChange(toggleDayCategory(draft, category, value))}
                  label={`${SPECIAL_DAY_CATEGORY_LABEL[category]} ${on ? "açık" : "kapalı"}`}
                />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Bayram dates of this year and the next two (every brand). */
function BayramDates() {
  const overrides = useSpecialDayOverrides();
  const actions = useSpecialDayOverrideActions();
  const year = Number(istanbulToday(new Date()).slice(0, 4));
  const years = useMemo(() => [year, year + 1, year + 2], [year]);
  const [rows, setRows] = useState<BayramRow[] | null>(null);
  const saver = useDebouncedSave((next: BayramRow[]) =>
    actions.put(overridesPut(next, overrides.data?.overrides ?? [])),
  );

  useEffect(() => {
    if (overrides.data && rows === null) setRows(bayramRows(years, overrides.data.overrides));
  }, [overrides.data, rows, years]);

  if (!rows) return null;
  const edit = (y: number, patch: Partial<Pick<BayramRow, "ramazan" | "kurban">>) => {
    const next = rows.map((r) => (r.year === y ? { ...r, ...patch } : r));
    setRows(next);
    saver.queue(next);
  };
  return (
    <section
      className="flex max-w-[960px] flex-col gap-2 rounded-[12px] p-3 shadow-[inset_0_0_0_1px_var(--border-hairline)]"
      aria-label="Bayram tarihleri"
    >
      <div className="flex items-end gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-body text-fg">Bayram tarihleri (tüm markalar)</span>
          <span className="block text-footnote text-fg-2">
            Diyanet takviminden ya da hesapla gelir. Diyanet'in açıkladığı ilk gün farklıysa düzelt;
            arife ve bayramın diğer günleri ona göre kayar.
          </span>
        </span>
        <SaveLine state={saver.state} />
      </div>
      <table className="w-full max-w-[640px] table-fixed text-body">
        <thead>
          <tr className="text-left text-footnote text-fg-3">
            <th className="w-[72px] py-1 font-normal">Yıl</th>
            <th className="py-1 font-normal">Ramazan Bayramı</th>
            <th className="py-1 font-normal">Kurban Bayramı</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.year} className="align-top">
              <td className="py-1.5 text-fg-2 tabular-nums">{r.year}</td>
              {(["ramazan", "kurban"] as const).map((which) => {
                const computed = which === "ramazan" ? r.computedRamazan : r.computedKurban;
                const value = r[which];
                return (
                  <td key={which} className="py-1.5 pr-3">
                    <TextField
                      type="date"
                      aria-label={`${r.year} ${which === "ramazan" ? "Ramazan" : "Kurban"} Bayramı ilk günü`}
                      value={value}
                      min={`${r.year}-01-01`}
                      max={`${r.year}-12-31`}
                      onChange={(e) => edit(r.year, { [which]: e.target.value || computed })}
                    />
                    <span className="mt-0.5 block text-caption text-fg-3">
                      {value === computed
                        ? r.approximate
                          ? `Hesaplandı (±1 gün): ${dayMonthTr(computed)}`
                          : `Diyanet: ${dayMonthTr(computed)}`
                        : `Düzeltildi (hesaplanan: ${dayMonthTr(computed)})`}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
