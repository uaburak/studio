// Marka Kiti → Skill'ler: the brand's Markdown instructions for the agent (formats with pixel
// layouts, tone, do / don't), like Wecra's `mtm` / `partner` skills. Enabled ones go into chat
// turns and post generations of the brand. List with on / off switches on the left; the editor
// (Markdown with a preview, version history with restore) on the right; "AI ile çıkar" drafts
// one from the brand's sample posts, kit and profile (it arrives switched off).
import {
  type Brand,
  type BrandSkill,
  type BrandSkillVersion,
  isTerminalJobStatus,
} from "@studio/contract";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../../components/chat/markdown.tsx";
import {
  Button,
  cn,
  SegmentedControl,
  Spinner,
  Switch,
  TagPill,
  TextField,
} from "../../components/ui/controls.tsx";
import { ConfirmDialog } from "../../components/ui/dialog.tsx";
import { IconPlus, IconRestore, IconSparkles, IconTrash } from "../../components/ui/icons.tsx";
import { Popover } from "../../components/ui/popover.tsx";
import { describeError } from "../../lib/api.ts";
import { formatAgo, percentText } from "../../lib/format.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useWorkerOnline } from "./brand-data.ts";
import {
  useBrandSkills,
  useSkillActions,
  useSkillDraftJobs,
  useSkillVersions,
} from "./skills-data.ts";
import {
  addSkillBlocker,
  bodyLength,
  formChanged,
  formOf,
  newSkillForm,
  ORIGIN_LABEL,
  type SkillForm,
  skillDraftBlocker,
  skillFormProblem,
  skillMeta,
} from "./skills-model.ts";

type Selection = { kind: "skill"; id: string } | { kind: "new" } | null;
type EditorTab = "edit" | "preview" | "history";

export function SkillsSection({ brand }: { brand: Brand }) {
  const skills = useBrandSkills(brand.id);
  const actions = useSkillActions(brand.id);
  const list = skills.data ?? [];
  const showToast = useAppStore((s) => s.showToast);
  const [selection, setSelection] = useState<Selection>(null);
  const [pending, setPending] = useState<Selection | undefined>(undefined);
  const dirtyRef = useRef(false);

  const selected =
    selection?.kind === "skill" ? (list.find((s) => s.id === selection.id) ?? null) : null;
  // The first skill opens by itself; a deleted one closes.
  useEffect(() => {
    if (selection === null && list[0]) setSelection({ kind: "skill", id: list[0].id });
    if (selection?.kind === "skill" && skills.data && !list.some((s) => s.id === selection.id)) {
      setSelection(list[0] ? { kind: "skill", id: list[0].id } : null);
    }
  }, [list, selection, skills.data]);

  const select = (next: Selection) => {
    if (dirtyRef.current) setPending(next);
    else setSelection(next);
  };
  const addBlocker = addSkillBlocker(list.length);

  return (
    <section className="flex flex-col gap-3" aria-label="Skill'ler">
      <div className="flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-heading font-semibold text-fg">Skill'ler</h2>
          <p className="text-body text-fg-2">
            Ajanın bu marka için uyduğu talimatlar: format ölçüleri, yerleşim, ton, yapılacaklar ve
            yapılmayacaklar. Açık olanlar sohbete ve post üretimine eklenir.
          </p>
        </div>
        <DraftButton
          brand={brand}
          count={list.length}
          onDrafted={(skillId) => {
            setSelection({ kind: "skill", id: skillId });
          }}
        />
        <Button
          size="sm"
          icon={<IconPlus size={12} strokeWidth={2} />}
          disabled={addBlocker !== null}
          title={addBlocker ?? undefined}
          onClick={() => select({ kind: "new" })}
        >
          Yeni skill
        </Button>
      </div>

      {skills.error ? (
        <p className="text-body text-danger">{describeError(skills.error)}</p>
      ) : skills.isLoading ? (
        <p className="text-body text-fg-3">Yükleniyor…</p>
      ) : list.length === 0 && selection?.kind !== "new" ? (
        <p className="text-body text-fg-3">
          Henüz skill yok. “Yeni skill” ile yaz ya da “AI ile çıkar” ile örnek postlardan ve marka
          kitinden bir taslak çıkar.
        </p>
      ) : (
        <div className="flex min-h-[420px] items-stretch gap-4">
          <ul aria-label="Skill listesi" className="flex w-[280px] shrink-0 flex-col gap-1">
            {list.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                selected={selection?.kind === "skill" && selection.id === skill.id}
                onSelect={() => select({ kind: "skill", id: skill.id })}
                onToggle={async (enabled) => {
                  try {
                    await actions.update(skill.id, { enabled });
                  } catch (error) {
                    showToast({ message: describeError(error), tone: "danger" });
                  }
                }}
              />
            ))}
            {selection?.kind === "new" && (
              <li className="rounded-[10px] bg-control px-3 py-2 text-body text-fg">
                Yeni skill
                <div className="text-footnote text-fg-3">kaydedilmedi</div>
              </li>
            )}
          </ul>
          <div className="min-w-0 flex-1">
            {selection?.kind === "new" ? (
              <SkillEditor
                key="new"
                brandId={brand.id}
                skill={null}
                others={list}
                onDirty={(d) => {
                  dirtyRef.current = d;
                }}
                onSaved={(skill) => {
                  dirtyRef.current = false;
                  setSelection({ kind: "skill", id: skill.id });
                }}
                onCancel={() => {
                  dirtyRef.current = false;
                  setSelection(list[0] ? { kind: "skill", id: list[0].id } : null);
                }}
              />
            ) : selected ? (
              <SkillEditor
                key={selected.id}
                brandId={brand.id}
                skill={selected}
                others={list.filter((s) => s.id !== selected.id)}
                onDirty={(d) => {
                  dirtyRef.current = d;
                }}
                onSaved={() => {
                  dirtyRef.current = false;
                }}
                onCancel={() => {
                  dirtyRef.current = false;
                }}
              />
            ) : null}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pending !== undefined}
        title="Kaydedilmemiş değişiklikler"
        message="Bu skill'deki değişiklikler kaydedilmedi. Bırakıp devam edilsin mi?"
        confirmLabel="Değişiklikleri bırak"
        destructive
        onClose={() => setPending(undefined)}
        onConfirm={() => {
          dirtyRef.current = false;
          setSelection(pending ?? null);
          setPending(undefined);
        }}
      />
    </section>
  );
}

function SkillRow({
  skill,
  selected,
  onSelect,
  onToggle,
}: {
  skill: BrandSkill;
  selected: boolean;
  onSelect(): void;
  onToggle(enabled: boolean): void;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-2.5 rounded-[10px] px-3 py-2 transition-colors duration-150",
        selected ? "bg-control" : "hover:bg-control/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected || undefined}
        className="min-w-0 flex-1 text-left"
      >
        <span className={cn("block truncate font-mono text-mono", !skill.enabled && "text-fg-3")}>
          {skill.name}
        </span>
        <span className="block truncate text-footnote text-fg-2">
          {skill.description || "Açıklama yok"}
        </span>
        <span className="block text-caption text-fg-3">{skillMeta(skill)}</span>
      </button>
      <span className="pt-0.5">
        <Switch
          checked={skill.enabled}
          onChange={onToggle}
          label={`${skill.name} ${skill.enabled ? "açık" : "kapalı"}`}
        />
      </span>
    </li>
  );
}

function DraftButton({
  brand,
  count,
  onDrafted,
}: {
  brand: Brand;
  count: number;
  onDrafted(skillId: string): void;
}) {
  const actions = useSkillActions(brand.id);
  const { running, all } = useSkillDraftJobs(brand.id);
  const workerOnline = useWorkerOnline();
  const showToast = useAppStore((s) => s.showToast);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState("");
  const [starting, setStarting] = useState(false);
  const [watching, setWatching] = useState<string | null>(null);
  const blocker = skillDraftBlocker({
    archived: brand.status === "archived",
    workerOnline,
    count,
  });

  // The job this button started: open its skill when it is done, say why when it failed.
  const watched = watching ? all.find((j) => j.id === watching) : undefined;
  useEffect(() => {
    if (!watched || !isTerminalJobStatus(watched.status)) return;
    setWatching(null);
    if (watched.status === "succeeded") {
      const skillId = typeof watched.output?.skillId === "string" ? watched.output.skillId : null;
      const name = typeof watched.output?.name === "string" ? watched.output.name : "skill";
      showToast({ message: `Skill taslağı hazır: ${name} (kapalı; okuyup aç).` });
      if (skillId) onDrafted(skillId);
    } else if (watched.status === "failed") {
      showToast({
        message: watched.error ?? "Skill taslağı çıkarılamadı.",
        tone: "danger",
      });
    }
  }, [watched, showToast, onDrafted]);

  if (running) {
    return (
      <span className="flex items-center gap-2 text-body text-fg-2" role="status">
        <Spinner size={13} />
        {running.progressMessage ?? "Skill çıkarılıyor…"}
        {running.progress !== undefined && (
          <span className="text-fg-3 tabular-nums">{percentText(running.progress * 100)}</span>
        )}
      </span>
    );
  }
  return (
    <>
      <Button
        ref={setAnchor}
        size="sm"
        icon={<IconSparkles size={12} strokeWidth={1.75} />}
        title={blocker ?? undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (blocker) {
            showToast({ message: blocker });
            return;
          }
          setOpen((o) => !o);
        }}
      >
        AI ile çıkar
      </Button>
      <Popover
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        placement="bottom-end"
        label="AI ile skill çıkar"
        className="w-[360px]"
      >
        <form
          className="flex flex-col gap-2.5"
          onSubmit={async (event) => {
            event.preventDefault();
            setStarting(true);
            try {
              const job = await actions.draft(focus);
              setWatching(job.id);
              setOpen(false);
              setFocus("");
              showToast({ message: "Skill çıkarılıyor; bitince listede kapalı olarak görünür." });
            } catch (error) {
              showToast({ message: describeError(error), tone: "danger" });
            } finally {
              setStarting(false);
            }
          }}
        >
          <p className="text-body text-fg-2">
            Örnek postlar, marka kiti ve profilden bir skill taslağı yazılır. Taslak kapalı gelir;
            okuyup düzelttikten sonra açarsın.
          </p>
          <TextField
            aria-label="Odak"
            placeholder="Odak (isteğe bağlı): ör. carousel formatı"
            value={focus}
            maxLength={2000}
            autoFocus
            onChange={(e) => setFocus(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Vazgeç
            </Button>
            <Button variant="primary" type="submit" disabled={starting}>
              {starting ? "Başlatılıyor…" : "Çıkar"}
            </Button>
          </div>
        </form>
      </Popover>
    </>
  );
}

function SkillEditor({
  brandId,
  skill,
  others,
  onDirty,
  onSaved,
  onCancel,
}: {
  brandId: string;
  skill: BrandSkill | null;
  others: readonly BrandSkill[];
  onDirty(dirty: boolean): void;
  onSaved(skill: BrandSkill): void;
  onCancel(): void;
}) {
  const actions = useSkillActions(brandId);
  const showToast = useAppStore((s) => s.showToast);
  const [form, setForm] = useState<SkillForm>(() => (skill ? formOf(skill) : newSkillForm(others)));
  const [tab, setTab] = useState<EditorTab>("edit");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const versions = useSkillVersions(brandId, skill?.id ?? null);

  // A newer version from elsewhere (restore, AI) replaces an untouched form.
  const changed = formChanged(form, skill);
  const lastVersion = useRef(skill?.version);
  useEffect(() => {
    if (skill && skill.version !== lastVersion.current) {
      lastVersion.current = skill.version;
      setForm(formOf(skill));
    }
  }, [skill]);
  useEffect(() => onDirty(skill ? changed : true), [changed, skill, onDirty]);

  const problem = skillFormProblem(form, others);
  const set = (patch: Partial<SkillForm>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (problem) return;
    setSaving(true);
    try {
      const saved = skill
        ? await actions.update(skill.id, {
            name: form.name.trim(),
            description: form.description.trim(),
            body: form.body,
            ...(form.note.trim() ? { note: form.note.trim() } : {}),
          })
        : await actions.create({
            name: form.name.trim(),
            description: form.description.trim(),
            body: form.body,
            ...(form.note.trim() ? { note: form.note.trim() } : {}),
          });
      lastVersion.current = saved.version;
      setForm(formOf(saved));
      onSaved(saved);
      showToast({
        message: skill ? `${saved.name} v${saved.version} kaydedildi.` : `${saved.name} eklendi.`,
      });
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  const tabs: { value: EditorTab; label: string; count?: number }[] = [
    { value: "edit", label: "Düzenle" },
    { value: "preview", label: "Önizleme" },
    ...(skill
      ? [
          {
            value: "history" as const,
            label: "Geçmiş",
            count: versions.data?.length ?? skill.version,
          },
        ]
      : []),
  ];

  return (
    <div className="flex h-full flex-col gap-3 rounded-[12px] p-4 shadow-[inset_0_0_0_1px_var(--border-hairline)]">
      <div className="flex flex-wrap items-center gap-2">
        <TextField
          aria-label="Skill adı"
          className="w-[220px] font-mono"
          value={form.name}
          invalid={problem?.startsWith("Ad") === true}
          onChange={(e) => set({ name: e.target.value.toLowerCase() })}
        />
        <TextField
          aria-label="Açıklama"
          className="min-w-[220px] flex-1"
          placeholder="Ne zaman kullanılır (tek cümle)"
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
        />
        {skill && (
          <span className="flex items-center gap-1.5 text-footnote text-fg-3">
            v{skill.version}
            {skill.origin !== "manual" && <TagPill>{ORIGIN_LABEL[skill.origin]}</TagPill>}
            {!skill.enabled && <TagPill tone="warning">Kapalı</TagPill>}
          </span>
        )}
      </div>

      <div className="flex items-center gap-3">
        <SegmentedControl<EditorTab> label="Görünüm" value={tab} onChange={setTab} options={tabs} />
        <span className="ml-auto text-caption text-fg-3 tabular-nums">{bodyLength(form.body)}</span>
      </div>

      <div className="min-h-[300px] flex-1">
        {tab === "edit" && (
          <textarea
            aria-label="Skill metni (Markdown)"
            value={form.body}
            spellCheck={false}
            onChange={(e) => set({ body: e.target.value })}
            className="selectable h-full min-h-[300px] w-full resize-y rounded-[10px] bg-field px-3 py-2 font-mono text-mono text-fg shadow-[inset_0_0_0_1px_var(--border-hairline)] outline-none"
          />
        )}
        {tab === "preview" && (
          <div className="max-h-[560px] min-h-[300px] overflow-y-auto rounded-[10px] bg-field px-4 py-3 shadow-[inset_0_0_0_1px_var(--border-hairline)]">
            {form.body.trim() ? (
              <Markdown source={form.body} />
            ) : (
              <p className="text-body text-fg-3">Boş.</p>
            )}
          </div>
        )}
        {tab === "history" && skill && (
          <VersionHistory
            skill={skill}
            versions={versions.data ?? []}
            loading={versions.isLoading}
            dirty={changed}
            onRestore={async (version) => {
              try {
                const restored = await actions.restore(skill.id, version);
                lastVersion.current = restored.version;
                setForm(formOf(restored));
                setTab("edit");
                showToast({ message: `v${version} geri yüklendi (v${restored.version}).` });
              } catch (error) {
                showToast({ message: describeError(error), tone: "danger" });
              }
            }}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <TextField
          aria-label="Değişiklik notu"
          className="min-w-[200px] flex-1"
          placeholder="Değişiklik notu (isteğe bağlı)"
          value={form.note}
          maxLength={500}
          onChange={(e) => set({ note: e.target.value })}
        />
        {problem && changed && (
          <span className="text-footnote text-danger" role="status">
            {problem}
          </span>
        )}
        {skill && (
          <Button
            variant="ghost"
            icon={<IconTrash size={13} strokeWidth={1.75} />}
            onClick={() => setConfirmDelete(true)}
          >
            Sil
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={skill !== null && !changed}
          onClick={() => {
            setForm(skill ? formOf(skill) : newSkillForm(others));
            if (!skill) onCancel();
          }}
        >
          Vazgeç
        </Button>
        <Button
          variant="primary"
          disabled={saving || problem !== null || (skill !== null && !changed)}
          onClick={() => void save()}
        >
          {saving ? "Kaydediliyor…" : skill ? "Kaydet" : "Ekle"}
        </Button>
      </div>

      {skill && (
        <ConfirmDialog
          open={confirmDelete}
          title={`${skill.name} silinsin mi?`}
          message="Skill ve bütün sürümleri kalıcı olarak silinir. Yalnızca kullanılmasın istiyorsan kapatman yeterli."
          confirmLabel="Sil"
          destructive
          onClose={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setConfirmDelete(false);
            try {
              await actions.remove(skill.id);
              onCancel();
              showToast({ message: `${skill.name} silindi.` });
            } catch (error) {
              showToast({ message: describeError(error), tone: "danger" });
            }
          }}
        />
      )}
    </div>
  );
}

function VersionHistory({
  skill,
  versions,
  loading,
  dirty,
  onRestore,
}: {
  skill: BrandSkill;
  versions: readonly BrandSkillVersion[];
  loading: boolean;
  dirty: boolean;
  onRestore(version: number): void;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = useMemo(() => versions.find((v) => v.version === open) ?? null, [versions, open]);
  if (loading) return <p className="text-body text-fg-3">Yükleniyor…</p>;
  return (
    <div className="flex max-h-[560px] flex-col gap-1 overflow-y-auto">
      {dirty && (
        <p className="pb-1 text-footnote text-warning">
          Kaydedilmemiş değişikliklerin var; geri yükleme onları bırakır.
        </p>
      )}
      {versions.map((v) => {
        const current = v.version === skill.version;
        return (
          <div
            key={v.id}
            className="rounded-[10px] shadow-[inset_0_0_0_1px_var(--border-hairline)]"
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                aria-expanded={open === v.version}
                onClick={() => setOpen((o) => (o === v.version ? null : v.version))}
              >
                <span className="text-body text-fg">
                  v{v.version}
                  {current && <span className="text-fg-3"> · şu anki</span>}
                  {v.name !== skill.name && (
                    <span className="font-mono text-fg-3"> · {v.name}</span>
                  )}
                </span>
                <span className="block truncate text-footnote text-fg-3">
                  {formatAgo(v.createdAt)} · {ORIGIN_LABEL[v.origin]}
                  {v.note ? ` · ${v.note}` : ""}
                </span>
              </button>
              {!current && (
                <Button
                  size="sm"
                  icon={<IconRestore size={12} strokeWidth={1.75} />}
                  onClick={() => onRestore(v.version)}
                >
                  Geri yükle
                </Button>
              )}
            </div>
            {shown?.id === v.id && (
              <div className="border-hairline border-t px-4 py-3">
                <Markdown source={v.body} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
