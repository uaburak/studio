// The open post in the app's top bar (its title area): the title with the post's menu, its
// state, the version chip (versions popover: save a named version, show / restore an older one),
// the save state, and at the right Onayla and Zamanla. Back is the app's own (the top bar's ‹ ›,
// ⌘[, a swipe): the title area has no back button of its own.
import { useState } from "react";
import { Button, cn, Spinner, TagPill, type TagTone } from "../../../components/ui/controls.tsx";
import { IconChevronDown, IconClock } from "../../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../../components/ui/menu.tsx";
import { Popover } from "../../../components/ui/popover.tsx";
import { formatAgo } from "../../../lib/format.ts";
import {
  activeVersion,
  type EditorSnapshot,
  isViewingCurrent,
  type PostEditor,
} from "../../post-detail/editor.ts";

/** The canvas's saving, as the title area shows and drives it. */
export interface SaveControl {
  dirty: boolean;
  saving: boolean;
  error: string | null;
  lastSavedAt: number | null;
  /** Saves now (a version; `note` names it). */
  save(note?: string): Promise<boolean>;
  /** Saves unsaved edits (true also when there are none). */
  flush(): Promise<boolean>;
  notify(message: string): void;
}

const ORIGIN: Record<string, string> = {
  generated: "AI ilk taslak",
  ai_edit: "AI düzenlemesi",
  manual_edit: "Düzenleme",
};

export function TitleBar({
  save,
  editor,
  snapshot,
  status,
  menu,
  onApprove,
  onSchedule,
  approve,
  schedule,
  versionsOpen,
  setVersionsOpen,
}: {
  save: SaveControl;
  editor: PostEditor;
  snapshot: EditorSnapshot;
  status: { label: string; tone: TagTone };
  menu: MenuEntry[];
  onApprove(): void;
  onSchedule(): void;
  approve: { visible: boolean; disabled: string | null; busy: boolean };
  schedule: { label: string; disabled: string | null };
  versionsOpen: boolean;
  setVersionsOpen(open: boolean): void;
}) {
  const [chip, setChip] = useState<HTMLElement | null>(null);
  const version = activeVersion(snapshot);
  const viewingCurrent = isViewingCurrent(snapshot);
  const saveLabel = save.saving
    ? "Kaydediliyor…"
    : save.error
      ? "Kaydedilemedi"
      : save.dirty
        ? "Kaydedilmedi"
        : save.lastSavedAt
          ? "Kaydedildi"
          : "";

  return (
    <>
      <MenuButton
        entries={() =>
          approve.visible
            ? [
                {
                  id: "approve",
                  label: approve.busy ? "Onaylanıyor…" : "Onayla",
                  shortcut: "⌘↩",
                  disabled: !!approve.disabled,
                  ...(approve.disabled ? { detail: approve.disabled } : {}),
                  onSelect: onApprove,
                },
                { type: "separator" },
                ...menu,
              ]
            : menu
        }
        placement="bottom-start"
        label="Post işlemleri"
        width={232}
      >
        {({ ref, onClick, onKeyDown, open, ...aria }) => (
          <button
            ref={ref}
            type="button"
            {...aria}
            onClick={onClick}
            onKeyDown={onKeyDown}
            className={cn(
              "no-drag flex h-7 min-w-10 shrink items-center gap-1.5 rounded-full px-2.5 text-body-lg text-fg transition-colors hover:bg-control",
              open && "bg-control",
            )}
          >
            <span className="truncate">{snapshot.content.title}</span>
            <IconChevronDown size={12} strokeWidth={1.75} className="shrink-0 text-fg-2" />
          </button>
        )}
      </MenuButton>
      <span className="hidden shrink-0 @[600px]:inline-flex">
        <TagPill tone={status.tone}>{status.label}</TagPill>
      </span>
      <button
        ref={setChip}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={versionsOpen}
        onClick={() => setVersionsOpen(!versionsOpen)}
        className={cn(
          "no-drag flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-body",
          versionsOpen ? "bg-control-hover text-fg" : "bg-control text-fg hover:bg-control-hover",
          !viewingCurrent && "text-warning",
        )}
        title="Sürümler (⇧⌘V)"
      >
        <IconClock size={13} />
        {version ? `v${version.version}` : "Sürüm yok"}
        {version && (
          <span className="hidden text-fg-3 @[760px]:inline">· {formatAgo(version.createdAt)}</span>
        )}
        {!viewingCurrent && <span>· eski</span>}
      </button>
      {saveLabel && (
        <span
          role="status"
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-footnote",
            save.error ? "text-danger" : "text-fg-3",
          )}
          title={save.error ?? undefined}
        >
          {save.saving && <Spinner size={11} />}
          <span className={cn(!save.error && "hidden @[700px]:inline")}>{saveLabel}</span>
          {save.error && (
            <button type="button" className="no-drag underline" onClick={() => void save.save()}>
              Yeniden dene
            </button>
          )}
        </span>
      )}
      <div className="min-w-2 flex-1" />
      {approve.visible && (
        // Narrow: Onayla moves into the title's menu (⌘↩ works everywhere).
        <span
          title={approve.disabled ?? "Bu sürümü onayla (⌘↩)"}
          className="hidden shrink-0 @[480px]:inline-flex"
        >
          <Button variant="secondary" disabled={!!approve.disabled} onClick={onApprove}>
            {approve.busy ? "Onaylanıyor…" : "Onayla"}
          </Button>
        </span>
      )}
      <span title={schedule.disabled ?? "⇧⌘↩"} className="shrink-0">
        <Button
          variant="primary"
          aria-label={schedule.label}
          disabled={!!schedule.disabled}
          onClick={onSchedule}
        >
          <span className="hidden @[720px]:inline">{schedule.label}</span>
          <span className="@[720px]:hidden">Zamanla</span>
        </Button>
      </span>
      <span
        aria-hidden="true"
        className="mx-1 hidden h-5 w-px shrink-0 bg-hairline @[340px]:block"
      />
      <VersionsPopover
        anchor={chip}
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        save={save}
        editor={editor}
        snapshot={snapshot}
      />
    </>
  );
}

function VersionsPopover({
  anchor,
  open,
  onClose,
  save: control,
  editor,
  snapshot,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose(): void;
  save: SaveControl;
  editor: PostEditor;
  snapshot: EditorSnapshot;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const current = snapshot.content.currentVersion?.version;
  const shown = activeVersion(snapshot)?.version;
  const save = async () => {
    const note = name.trim();
    setNaming(false);
    setName("");
    if (control.dirty || note) {
      const ok = await control.save(note || undefined);
      if (ok) control.notify(note ? `“${note}” sürümü kaydedildi.` : "Sürüm kaydedildi.");
    } else {
      control.notify("Kaydedilecek değişiklik yok; son sürüm güncel.");
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
            <div className="text-footnote text-fg-3">
              Bu Mac'te saklanır · her kayıt Wecra'nın render'ı
            </div>
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
              className="h-7 min-w-0 flex-1 rounded-full bg-field px-3 text-body text-fg outline-none"
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
          {control.dirty || control.saving ? (
            <div className="flex h-12 items-center gap-2.5 rounded-[14px] bg-control px-2.5">
              <span className="min-w-0 flex-1">
                <span className="block text-body text-fg">
                  Taslak · kaydedilmemiş değişiklikler
                </span>
                <span className="block text-footnote text-fg-3">
                  {control.saving ? "Kaydediliyor…" : "Birazdan kendiliğinden kaydedilir"}
                </span>
              </span>
            </div>
          ) : null}
          {snapshot.summaries.map((v) => {
            const isCurrent = v.version === current;
            const isShown = v.version === shown;
            return (
              // biome-ignore lint/a11y/useKeyWithClickEvents: the popover's list is pointer-driven
              <div
                key={v.id}
                role="option"
                tabIndex={-1}
                aria-selected={isShown}
                onClick={async () => {
                  if (control.dirty) await control.flush();
                  void editor.selectVersion(v.version);
                }}
                className={cn(
                  "group flex h-12 cursor-default items-center gap-2.5 rounded-[14px] px-2.5",
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
            <p className="px-2.5 py-3 text-body text-fg-3">Sürümler yükleniyor…</p>
          )}
        </div>
        <div className="border-t border-hairline px-3 py-2 text-footnote text-fg-3">
          AI değişikliğinden önce taslak kendiliğinden kaydedilir.
        </div>
      </div>
    </Popover>
  );
}
