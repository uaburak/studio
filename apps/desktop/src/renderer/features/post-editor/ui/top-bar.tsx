// The editor's top bar: back to the post, title and state, the version chip (versions popover:
// save a named version, show / restore an older one), save state, undo / redo, zoom, Önizle,
// Onayla, Zamanla.
import { useState } from "react";
import {
  Button,
  cn,
  IconButton,
  Spinner,
  TagPill,
  type TagTone,
} from "../../../components/ui/controls.tsx";
import { IconChevronLeft, IconClock, IconRedo, IconUndo } from "../../../components/ui/icons.tsx";
import { Popover } from "../../../components/ui/popover.tsx";
import { formatAgo } from "../../../lib/format.ts";
import {
  activeVersion,
  type EditorSnapshot,
  isViewingCurrent,
  type PostEditor,
} from "../../post-detail/editor.ts";
import type { EditorSession } from "../session.ts";
import { useCanvasView } from "./canvas-view.tsx";
import { IconMinus, IconPlus } from "./glyphs.tsx";

const ORIGIN: Record<string, string> = {
  generated: "AI ilk taslak",
  ai_edit: "AI düzenlemesi",
  manual_edit: "Düzenleme",
};

export function TopBar({
  session,
  editor,
  snapshot,
  status,
  onBack,
  onPreview,
  onApprove,
  onSchedule,
  approve,
  schedule,
  versionsOpen,
  setVersionsOpen,
}: {
  session: EditorSession;
  editor: PostEditor;
  snapshot: EditorSnapshot;
  status: { label: string; tone: TagTone };
  onBack(): void;
  onPreview(): void;
  onApprove(): void;
  onSchedule(): void;
  approve: { visible: boolean; disabled: string | null; busy: boolean };
  schedule: { label: string; disabled: string | null };
  versionsOpen: boolean;
  setVersionsOpen(open: boolean): void;
}) {
  const { draft, draftState: d, canvas } = session;
  const [chip, setChip] = useState<HTMLElement | null>(null);
  const version = activeVersion(snapshot);
  const view = useCanvasView(canvas);
  const viewingCurrent = isViewingCurrent(snapshot);
  const lastUndo = d.undo.at(-1);
  const lastRedo = d.redo.at(-1);
  const saveLabel = d.saving
    ? "Kaydediliyor…"
    : d.saveError
      ? "Kaydedilemedi"
      : d.pending.length > 0
        ? "Kaydedilmedi"
        : d.lastSavedAt
          ? "Kaydedildi"
          : "";

  return (
    <header className="drag flex h-11 shrink-0 items-center gap-2 border-b border-hairline bg-sidebar pr-2 pl-[84px]">
      <IconButton
        icon={<IconChevronLeft size={16} />}
        label="Posta dön"
        shortcut="Esc"
        onClick={onBack}
      />
      <h1 className="min-w-0 max-w-[260px] truncate text-body font-semibold text-fg">
        {snapshot.content.title}
      </h1>
      <TagPill tone={status.tone}>{status.label}</TagPill>
      <button
        ref={setChip}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={versionsOpen}
        onClick={() => setVersionsOpen(!versionsOpen)}
        className={cn(
          "no-drag flex h-7 items-center gap-1.5 rounded-full px-2.5 text-body",
          versionsOpen ? "bg-control-hover text-fg" : "bg-control text-fg hover:bg-control-hover",
          !viewingCurrent && "text-warning",
        )}
        title="Sürümler (⇧⌘V)"
      >
        <IconClock size={13} />
        {version ? `v${version.version}` : "Sürüm yok"}
        {version && <span className="text-fg-3">· {formatAgo(version.createdAt)}</span>}
        {!viewingCurrent && <span>· eski</span>}
      </button>
      {saveLabel && (
        <span
          className={cn(
            "flex items-center gap-1.5 text-footnote",
            d.saveError ? "text-danger" : "text-fg-3",
          )}
        >
          {d.saving && <Spinner size={11} />}
          {saveLabel}
          {d.saveError && (
            <button type="button" className="no-drag underline" onClick={() => void draft.retry()}>
              Yeniden dene
            </button>
          )}
        </span>
      )}
      <div className="flex-1" />
      <IconButton
        icon={<IconUndo size={15} strokeWidth={1.5} />}
        label={lastUndo ? `Geri al: ${lastUndo.name}` : "Geri al"}
        shortcut="⌘Z"
        disabled={!lastUndo}
        onClick={() => draft.undo()}
      />
      <IconButton
        icon={<IconRedo size={15} strokeWidth={1.5} />}
        label={lastRedo ? `Yinele: ${lastRedo.name}` : "Yinele"}
        shortcut="⇧⌘Z"
        disabled={!lastRedo}
        onClick={() => draft.redo()}
      />
      <div className="no-drag flex h-7 items-center rounded-full bg-control">
        <IconButton
          size={28}
          icon={<IconMinus size={13} />}
          label="Uzaklaştır"
          shortcut="⌘−"
          onClick={() => canvas.command("ZOOM_OUT")}
        />
        <button
          type="button"
          className="w-12 text-center text-footnote text-fg tabular-nums"
          title="Tüm kareleri sığdır (⇧1)"
          onClick={() => canvas.command("ZOOM_TO_FIT")}
        >
          %{Math.round(view.camera.zoom * 100)}
        </button>
        <IconButton
          size={28}
          icon={<IconPlus size={13} />}
          label="Yakınlaştır"
          shortcut="⌘+"
          onClick={() => canvas.command("ZOOM_IN")}
        />
      </div>
      <Button variant="secondary" onClick={onPreview}>
        Önizle
      </Button>
      {approve.visible && (
        <span title={approve.disabled ?? "Bu sürümü onayla (⌘↩)"}>
          <Button variant="secondary" disabled={!!approve.disabled} onClick={onApprove}>
            {approve.busy ? "Onaylanıyor…" : "Onayla"}
          </Button>
        </span>
      )}
      <span title={schedule.disabled ?? "⇧⌘↩"}>
        <Button variant="primary" disabled={!!schedule.disabled} onClick={onSchedule}>
          {schedule.label}
        </Button>
      </span>
      <VersionsPopover
        anchor={chip}
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        session={session}
        editor={editor}
        snapshot={snapshot}
      />
    </header>
  );
}

function VersionsPopover({
  anchor,
  open,
  onClose,
  session,
  editor,
  snapshot,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose(): void;
  session: EditorSession;
  editor: PostEditor;
  snapshot: EditorSnapshot;
}) {
  const { draft, draftState: d } = session;
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const current = snapshot.content.currentVersion?.version;
  const shown = activeVersion(snapshot)?.version;
  const save = async () => {
    const note = name.trim();
    setNaming(false);
    setName("");
    if (draft.dirty) {
      const ok = await draft.flush(note || undefined);
      if (ok) session.notify(note ? `“${note}” sürümü kaydedildi.` : "Sürüm kaydedildi.");
    } else {
      session.notify("Kaydedilecek değişiklik yok; son sürüm güncel.");
    }
  };
  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      placement="bottom-start"
      label="Sürümler"
    >
      <div className="flex w-[336px] flex-col">
        <div className="flex items-start gap-2 px-3 pt-3 pb-2">
          <div className="min-w-0 flex-1">
            <div className="text-body font-semibold text-fg">Sürümler</div>
            <div className="text-footnote text-fg-3">Bu Mac'te saklanır · her kayıt bir render</div>
          </div>
          <Button size="sm" variant="ghost" onClick={() => setNaming(true)}>
            Sürüm kaydet
          </Button>
        </div>
        {naming && (
          <div className="flex items-center gap-1.5 px-3 pb-2">
            <input
              // biome-ignore lint/a11y/noAutofocus: the field the button opened
              autoFocus
              aria-label="Sürüm adı"
              placeholder="Sürüm adı (isteğe bağlı)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") {
                  e.stopPropagation();
                  setNaming(false);
                }
              }}
              className="h-7 min-w-0 flex-1 rounded-[8px] bg-field px-2 text-body text-fg outline-none"
            />
            <Button size="sm" variant="primary" onClick={() => void save()}>
              Kaydet
            </Button>
          </div>
        )}
        <div
          role="listbox"
          aria-label="Sürüm listesi"
          className="scroll-area flex max-h-[320px] flex-col gap-0.5 px-1.5 pb-1.5"
        >
          {d.pending.length > 0 || d.inflight ? (
            <div className="flex h-12 items-center gap-2.5 rounded-[10px] bg-control px-2">
              <span className="min-w-0 flex-1">
                <span className="block text-body text-fg">
                  Taslak · kaydedilmemiş değişiklikler
                </span>
                <span className="block text-footnote text-fg-3">
                  {d.saving
                    ? "Kaydediliyor…"
                    : `${d.undo.length} adım · birazdan kendiliğinden kaydedilir`}
                </span>
              </span>
            </div>
          ) : null}
          {snapshot.summaries.map((v) => {
            const isCurrent = v.version === current;
            const isShown = v.version === shown;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the list is also reachable from the Sürümler tab
              <div
                key={v.id}
                role="option"
                tabIndex={-1}
                aria-selected={isShown}
                onClick={async () => {
                  if (draft.dirty) await draft.flush();
                  void editor.selectVersion(v.version);
                }}
                className={cn(
                  "group flex h-12 cursor-default items-center gap-2.5 rounded-[10px] px-2",
                  isShown ? "bg-control" : "hover:bg-control",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body text-fg">
                    v{v.version} ·{" "}
                    {v.note?.trim() ? v.note.split("\n")[0] : (ORIGIN[v.origin] ?? v.origin)}
                  </span>
                  <span className="block text-footnote text-fg-3">{formatAgo(v.createdAt)}</span>
                </span>
                {isCurrent ? (
                  <TagPill tone="accent">Güncel</TagPill>
                ) : isShown ? (
                  <Button
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      void editor.restoreDisplayed();
                    }}
                  >
                    Geri yükle
                  </Button>
                ) : (
                  <span className="text-footnote text-fg-3 opacity-0 group-hover:opacity-100">
                    Göster
                  </span>
                )}
              </div>
            );
          })}
          {snapshot.summaries.length === 0 && (
            <p className="px-2 py-3 text-body text-fg-3">Sürümler yükleniyor…</p>
          )}
        </div>
        <div className="border-t border-hairline px-3 py-2 text-footnote text-fg-3">
          AI değişikliğinden önce taslak kendiliğinden kaydedilir.
        </div>
      </div>
    </Popover>
  );
}
