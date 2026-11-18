// Marka Kiti → Kontroller (roadmap 13): which generation checks run for this brand (per
// category and per check), the banned words, the strictness and the automatic fixes after a
// generation. Saved as you go, like the rest of the kit.
import type { Brand, CheckId } from "@studio/contract";
import { CHECK_CATALOG, CHECK_CATEGORIES, checksByCategory } from "@studio/contract";
import { useEffect, useRef, useState } from "react";
import {
  cn,
  IconButton,
  SegmentedControl,
  Spinner,
  Switch,
  TextField,
} from "../../components/ui/controls.tsx";
import { IconClose } from "../../components/ui/icons.tsx";
import { describeError } from "../../lib/api.ts";
import { useCheckSettings, useCheckSettingsActions } from "./checks-data.ts";
import {
  addBannedWords,
  draftPut,
  type SettingsDraft,
  STRICTNESS_OPTIONS,
  settingsDraft,
  sourceLabel,
  toggleCategory,
} from "./checks-model.ts";

type SaveState = "idle" | "saving" | "saved" | { error: string };

export function ChecksSettingsSection({ brand }: { brand: Pick<Brand, "id"> }) {
  const settings = useCheckSettings(brand.id);
  const actions = useCheckSettingsActions(brand.id);
  const [draft, setDraft] = useState<SettingsDraft | null>(null);
  const [dirty, setDirty] = useState(0);
  const [save, setSave] = useState<SaveState>("idle");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const put = useRef(actions.put);
  put.current = actions.put;

  useEffect(() => {
    if (settings.data && draft === null) setDraft(settingsDraft(settings.data));
  }, [settings.data, draft]);

  // Saved a moment after the last change.
  useEffect(() => {
    if (dirty === 0) return;
    const timer = setTimeout(async () => {
      const current = draftRef.current;
      if (!current) return;
      setSave("saving");
      try {
        await put.current(draftPut(current));
        setSave("saved");
      } catch (error) {
        setSave({ error: describeError(error) });
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [dirty]);

  const change = (next: SettingsDraft) => {
    setDraft(next);
    setDirty((n) => n + 1);
  };

  return (
    <section className="flex flex-col gap-3" aria-label="Kontroller">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-heading font-semibold text-fg">Kontroller</h2>
          <p className="text-body text-fg-2">
            Her üretimden ve düzenlemeden sonra çalışan denetimler. Sonuçlar post ayrıntısındaki
            Kontroller listesinde görünür; başarısız kontrol varsa onaydan önce sorulur.
          </p>
        </div>
        <SaveLine state={save} />
      </div>

      {settings.error ? (
        <p className="text-body text-danger">{describeError(settings.error)}</p>
      ) : !draft ? (
        <p className="flex items-center gap-1.5 text-body text-fg-3">
          <Spinner size={12} /> Ayarlar yükleniyor…
        </p>
      ) : (
        <ChecksSettingsForm draft={draft} onChange={change} />
      )}
    </section>
  );
}

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

/** The form (also in the component gallery). */
export function ChecksSettingsForm({
  draft,
  onChange,
}: {
  draft: SettingsDraft;
  onChange(next: SettingsDraft): void;
}) {
  const [typed, setTyped] = useState("");
  const strictness = STRICTNESS_OPTIONS.find((o) => o.value === draft.strictness);
  const addTyped = () => {
    if (!typed.trim()) return;
    onChange({ ...draft, bannedWords: addBannedWords(draft.bannedWords, typed) });
    setTyped("");
  };
  return (
    <div className="flex max-w-[960px] flex-col gap-4">
      <div className="flex flex-col gap-2 rounded-[12px] p-3 shadow-[inset_0_0_0_1px_var(--border-hairline)]">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-body text-fg">Sıkılık</span>
          <SegmentedControl
            label="Kontrol sıkılığı"
            value={draft.strictness}
            onChange={(strictness) => onChange({ ...draft, strictness })}
            options={STRICTNESS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </div>
        {strictness && <p className="text-footnote text-fg-2">{strictness.detail}</p>}
        <div className="flex items-start gap-3 border-t border-hairline pt-2">
          <span className="min-w-0 flex-1">
            <span className="block text-body text-fg">Üretimden sonra otomatik düzelt</span>
            <span className="block text-footnote text-fg-2">
              Taşan metni küçültür, güvenli alan dışındaki öğeyi içeri alır, kontrastı düşük metne
              marka rengi verir, sınırı aşan açıklamayı kısaltır. Düzeltme yeni sürüm olarak
              kaydedilir.
            </span>
          </span>
          <Switch
            checked={draft.autoFix}
            onChange={(autoFix) => onChange({ ...draft, autoFix })}
            label="Üretimden sonra otomatik düzelt"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {checksByCategory().map(({ category, checks }) => {
          const on = checks.filter((id) => !draft.disabled.has(id)).length;
          return (
            <div
              key={category}
              className="flex flex-col rounded-[12px] shadow-[inset_0_0_0_1px_var(--border-hairline)]"
            >
              <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium text-fg">
                    {CHECK_CATEGORIES[category].step}. {CHECK_CATEGORIES[category].label}
                  </span>
                  <span className="block text-caption text-fg-3">
                    {on === checks.length
                      ? "Hepsi açık"
                      : on === 0
                        ? "Kapalı"
                        : `${on}/${checks.length} açık`}
                  </span>
                </span>
                <Switch
                  checked={on > 0}
                  onChange={(value) =>
                    onChange({ ...draft, disabled: toggleCategory(draft.disabled, checks, value) })
                  }
                  label={`${CHECK_CATEGORIES[category].label} kontrolleri`}
                />
              </div>
              <ul className="flex flex-col pb-1.5">
                {checks.map((id) => (
                  <CheckRow
                    key={id}
                    id={id}
                    on={!draft.disabled.has(id)}
                    onToggle={(value) =>
                      onChange({ ...draft, disabled: toggleCategory(draft.disabled, [id], value) })
                    }
                  />
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 rounded-[12px] p-3 shadow-[inset_0_0_0_1px_var(--border-hairline)]">
        <span className="text-body text-fg">Yasak kelimeler</span>
        <span className="text-footnote text-fg-2">
          Açıklamada ya da slayt metinlerinde geçerse kontrol başarısız olur. Ekleri de yakalar
          (“ücretsiz” → “ücretsizdir”). Virgülle birden çok kelime ekleyebilirsin.
        </span>
        <div className="flex items-center gap-2">
          <TextField
            aria-label="Yasak kelime ekle"
            className="min-w-0 flex-1"
            placeholder="ör. bedava, garantili, 1 numara"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addTyped();
              }
            }}
            onBlur={addTyped}
          />
        </div>
        {draft.bannedWords.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Yasak kelimeler">
            {draft.bannedWords.map((word) => (
              <li
                key={word}
                className="flex h-7 items-center gap-0.5 rounded-full bg-control pr-0.5 pl-2.5 text-footnote text-fg"
              >
                {word}
                <IconButton
                  icon={<IconClose size={11} />}
                  label={`${word} kaldır`}
                  size={24}
                  tooltip={false}
                  onClick={() =>
                    onChange({
                      ...draft,
                      bannedWords: draft.bannedWords.filter((w) => w !== word),
                    })
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-footnote text-fg-3">Liste boş.</span>
        )}
      </div>
    </div>
  );
}

function CheckRow({ id, on, onToggle }: { id: CheckId; on: boolean; onToggle(on: boolean): void }) {
  const meta = CHECK_CATALOG[id];
  return (
    <li className="flex items-start gap-2.5 px-3 py-1.5">
      <span className="min-w-0 flex-1">
        <span className={cn("block text-body", on ? "text-fg" : "text-fg-3")}>
          {meta.label}
          <span className="text-caption text-fg-3">
            {" "}
            · {sourceLabel(id)}
            {meta.fixable ? " · düzeltilebilir" : ""}
          </span>
        </span>
        <span className="block text-footnote text-fg-2">{meta.description}</span>
      </span>
      <span className="pt-0.5">
        <Switch
          checked={on}
          onChange={onToggle}
          label={`${meta.label} ${on ? "açık" : "kapalı"}`}
        />
      </span>
    </li>
  );
}
