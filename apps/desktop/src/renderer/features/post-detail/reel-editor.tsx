// Düzenle tab of a reel (port of StudioMac's ReelEditorView): the hook, the scenes (motion
// graphics), timed text overlays (footage, narration), the voice-over text, the closing line,
// burned-in captions and durations. "Videoyu yeniden oluştur" sends only what changed as a
// `content.render` job with `format: "mp4"` and a `reel` patch (no AI); the result is a new
// version, undone with ⌘Z like any other edit.
import { readReelVersionInfo, reelDurationIssues } from "@studio/contract";
import { useEffect, useMemo, useState } from "react";
import { Button, Checkbox, IconButton, Spinner, TextField } from "../../components/ui/controls.tsx";
import { IconPlus, IconRedo, IconTrash, IconUndo, IconWarning } from "../../components/ui/icons.tsx";
import {
  activeVersion,
  canRedo,
  canUndo,
  type EditorSnapshot,
  hasApproval,
  type PostEditor,
  reelEditBlocker,
} from "./editor.ts";
import {
  addOverlay,
  addScene,
  clockText,
  draftIsDirty,
  draftPatch,
  draftProblems,
  draftTotalMs,
  MAX_OVERLAYS,
  MAX_SCENES,
  parseSeconds,
  REEL_RECIPE_LABEL,
  type ReelDraft,
  reelDraft,
  removeOverlay,
  removeScene,
  secondsText,
  showsCaptionsSwitch,
  updateOverlay,
  updateScene,
} from "./reel-draft.ts";

const FIELD =
  "selectable w-full resize-none rounded-[12px] bg-field px-3 py-2 text-body text-fg outline-none shadow-[inset_0_0_0_1px_var(--border-hairline)] placeholder:text-fg-3";

export function ReelEditor({ snapshot, editor }: { snapshot: EditorSnapshot; editor: PostEditor }) {
  const version = activeVersion(snapshot);
  const html = version?.slides[0]?.html ?? "";
  const spec = useMemo(() => readReelVersionInfo(html).spec, [html]);
  const [draft, setDraft] = useState<ReelDraft | null>(() => (spec ? reelDraft(spec) : null));
  // A new version (this edit's result, an AI edit, undo) starts a fresh draft.
  useEffect(() => setDraft(spec ? reelDraft(spec) : null), [spec]);
  const blocker = reelEditBlocker(snapshot);
  const rendering = snapshot.activity.kind === "rendering";
  const lastUndo = snapshot.undo.at(-1);
  const lastRedo = snapshot.redo.at(-1);

  const header = (
    <div className="flex items-center gap-1">
      <span className="min-w-0 flex-1 text-footnote text-fg-2">
        {draft
          ? `${REEL_RECIPE_LABEL[draft.base.recipe]} · ${clockText(draftTotalMs(draft))}`
          : "Reels"}
      </span>
      <IconButton
        icon={<IconUndo size={15} strokeWidth={1.5} />}
        label={lastUndo ? `Geri al: ${lastUndo.name}` : "Geri al"}
        shortcut="⌘Z"
        disabled={!canUndo(snapshot)}
        onClick={() => void editor.undo()}
      />
      <IconButton
        icon={<IconRedo size={15} strokeWidth={1.5} />}
        label={lastRedo ? `Yinele: ${lastRedo.name}` : "Yinele"}
        shortcut="⇧⌘Z"
        disabled={!canRedo(snapshot)}
        onClick={() => void editor.redo()}
      />
    </div>
  );

  if (!draft) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <p className="text-body text-fg-2">{blocker ?? "Bu Reels düzenlenebilir bilgi taşımıyor."}</p>
      </div>
    );
  }

  const editable = blocker === null;
  const total = draftTotalMs(draft);
  const issues = reelDurationIssues(total, snapshot.content.targetPlatforms);
  const problems = draftProblems(draft);
  const dirty = draftIsDirty(draft);
  const change = (next: ReelDraft) => setDraft(next);
  const render = async () => {
    const patch = draftPatch(draft);
    if (!patch) return;
    await editor.renderReel(patch);
  };

  return (
    <div className="flex flex-col gap-4" data-testid="reel-editor">
      {header}
      {blocker && <p className="text-footnote text-fg-2">{blocker}</p>}
      {issues.length > 0 && (
        <div className="flex flex-col gap-1">
          {issues.map((issue) => (
            <p key={issue.platform} className="flex items-start gap-1.5 text-footnote text-warning">
              <IconWarning size={13} className="mt-0.5 shrink-0" />
              {issue.message}
            </p>
          ))}
        </div>
      )}

      <Section title="Kanca">
        <TextField
          aria-label="Kanca"
          className="w-full"
          placeholder="İlk 2 saniyedeki cümle"
          value={draft.hook}
          disabled={!editable}
          onChange={(e) => change({ ...draft, hook: e.target.value })}
        />
      </Section>

      {draft.base.recipe === "motion_graphics" && (
        <Section title="Sahneler">
          {draft.scenes.map((scene, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: scenes have no id; order is the identity
            <div key={i} className="flex items-center gap-1.5">
              <TextField
                aria-label={`Sahne ${i + 1}`}
                className="min-w-0 flex-1"
                placeholder={`Sahne ${i + 1}`}
                value={scene.headline}
                disabled={!editable}
                onChange={(e) => change(updateScene(draft, i, { headline: e.target.value }))}
              />
              <SecondsField
                label={`Sahne ${i + 1} süresi`}
                ms={scene.durationMs}
                disabled={!editable}
                onCommit={(ms) => change(updateScene(draft, i, { durationMs: ms }))}
              />
              <span className="text-footnote text-fg-2">sn</span>
              <IconButton
                icon={<IconTrash size={13} strokeWidth={1.5} />}
                label="Sahneyi kaldır"
                size={24}
                disabled={!editable || draft.scenes.length <= 1}
                onClick={() => change(removeScene(draft, i))}
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            disabled={!editable || draft.scenes.length >= MAX_SCENES}
            onClick={() => change(addScene(draft))}
          >
            <IconPlus size={12} /> Sahne ekle
          </Button>
        </Section>
      )}

      {draft.base.recipe === "footage_edit" && (
        <Section title="Video süresi">
          <div className="flex items-center gap-1.5">
            <SecondsField
              label="Video süresi"
              ms={draft.durationMs}
              disabled={!editable}
              onCommit={(ms) => change({ ...draft, durationMs: ms })}
            />
            <span className="text-footnote text-fg-2">sn</span>
          </div>
        </Section>
      )}

      {draft.base.recipe === "narration" && (
        <Section title="Seslendirme metni">
          <textarea
            aria-label="Seslendirme metni"
            className={FIELD}
            rows={5}
            value={draft.narrationScript}
            disabled={!editable}
            onChange={(e) => change({ ...draft, narrationScript: e.target.value })}
          />
          <p className="text-footnote text-fg-3">
            Metin değişirse ses yeniden üretilir; video süresi sese göre ayarlanır.
          </p>
        </Section>
      )}

      {(draft.base.recipe === "footage_edit" ||
        (draft.base.recipe === "narration" && draft.overlays.length > 0)) && (
        <Section title="Metin katmanları">
          {draft.overlays.map((overlay, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: overlays have no id; order is the identity
            <div key={i} className="flex items-center gap-1.5">
              <TextField
                aria-label={`Metin ${i + 1}`}
                className="min-w-0 flex-1"
                placeholder="Metin"
                value={overlay.text}
                disabled={!editable}
                onChange={(e) => change(updateOverlay(draft, i, { text: e.target.value }))}
              />
              <SecondsField
                label={`Metin ${i + 1} başlangıcı`}
                ms={overlay.startMs}
                disabled={!editable}
                onCommit={(ms) => change(updateOverlay(draft, i, { startMs: ms }))}
              />
              <span className="text-footnote text-fg-2">–</span>
              <SecondsField
                label={`Metin ${i + 1} bitişi`}
                ms={overlay.endMs}
                disabled={!editable}
                onCommit={(ms) => change(updateOverlay(draft, i, { endMs: ms }))}
              />
              <span className="text-footnote text-fg-2">sn</span>
              <IconButton
                icon={<IconTrash size={13} strokeWidth={1.5} />}
                label="Metni kaldır"
                size={24}
                disabled={!editable}
                onClick={() => change(removeOverlay(draft, i))}
              />
            </div>
          ))}
          <Button
            size="sm"
            variant="secondary"
            className="self-start"
            disabled={!editable || draft.overlays.length >= MAX_OVERLAYS}
            onClick={() => change(addOverlay(draft))}
          >
            <IconPlus size={12} /> Metin ekle
          </Button>
        </Section>
      )}

      <Section title="Kapanış">
        <TextField
          aria-label="Kapanış"
          className="w-full"
          placeholder="Kapanış cümlesi ya da marka imzası"
          value={draft.cta}
          disabled={!editable}
          onChange={(e) => change({ ...draft, cta: e.target.value })}
        />
      </Section>

      {showsCaptionsSwitch(draft) && (
        <Checkbox
          checked={draft.captions}
          disabled={!editable}
          onChange={(captions) => change({ ...draft, captions })}
        >
          Konuşmayı altyazı olarak videoya yaz
        </Checkbox>
      )}

      {problems.length > 0 && dirty && (
        <div className="flex flex-col gap-0.5" role="alert">
          {problems.map((p) => (
            <p key={p} className="text-footnote text-danger">
              {p}
            </p>
          ))}
        </div>
      )}

      {editable && hasApproval(snapshot.content) && dirty && (
        <p className="text-footnote text-warning">
          Videoyu değiştirmek yeni bir sürüm oluşturur ve onayı kaldırır; bekleyen zamanlamalar
          iptal olur.
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty || rendering}
          onClick={() => setDraft(reelDraft(draft.base))}
        >
          Vazgeç
        </Button>
        <span title="Yeni video sürümü üret (AI kullanılmaz)">
          <Button
            size="sm"
            variant="primary"
            disabled={!editable || !dirty || problems.length > 0}
            onClick={() => void render()}
          >
            {rendering && <Spinner size={12} />}
            Videoyu yeniden oluştur
          </Button>
        </span>
      </div>
      <p className="text-footnote text-fg-3">
        Değişiklikler AI kullanılmadan yeni bir video sürümü olarak kaydedilir; ⌘Z geri alır. Daha
        büyük değişiklikler için aşağıya “Neyi değiştireyim?” yaz.
      </p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-footnote text-fg-2">{title}</span>
      {children}
    </div>
  );
}

/** Seconds with a decimal comma ("2,5"); committed on blur / ↩, reported in milliseconds. */
function SecondsField({
  label,
  ms,
  disabled,
  onCommit,
}: {
  label: string;
  ms: number;
  disabled: boolean;
  onCommit(ms: number): void;
}) {
  const [text, setText] = useState(secondsText(ms));
  useEffect(() => setText(secondsText(ms)), [ms]);
  const commit = () => {
    const value = parseSeconds(text);
    if (value === null) setText(secondsText(ms));
    else if (value !== ms) onCommit(value);
  };
  return (
    <TextField
      aria-label={label}
      title={label}
      inputMode="decimal"
      className="w-[58px] shrink-0 px-2 text-right tabular-nums"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}
