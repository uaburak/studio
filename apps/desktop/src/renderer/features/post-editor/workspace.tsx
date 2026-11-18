// The post editor (Wecra's "Post Editor" design, done in code): a full-window workspace over the
// app — the top bar, slides and layers on the left, the canvas (Wecra's engine over the slides'
// own HTML), the inspector / caption on the right, tools and the AI prompt bar below.
//
// Everything that changes the design goes through the draft (model/draft.ts): instant on the
// canvas, saved as `content.render` jobs on its own. Approving and scheduling save first.
import type { Content } from "@studio/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn, IconButton, SegmentedControl, type TagTone } from "../../components/ui/controls.tsx";
import { IconClose, IconWarning } from "../../components/ui/icons.tsx";
import { MenuButton } from "../../components/ui/menu.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import {
  activeVersion,
  approveBlocker,
  canApprove,
  changesVersion,
  type EditorSnapshot,
  editBlocker,
  hasApproval,
  type PostEditor,
} from "../post-detail/editor.ts";
import { mediaSource } from "../posts/slides.ts";
import { useRenderKit } from "./data.ts";
import { findLayer, layerKey } from "./model/document.ts";
import type { SlidePatchInput } from "./model/draft.ts";
import { matchShortcut, type ShortcutCommand } from "./model/shortcuts.ts";
import { useEditorSession } from "./session.ts";
import { CanvasArea } from "./ui/canvas-view.tsx";
import { CaptionPanel } from "./ui/caption-panel.tsx";
import {
  IconCrop,
  IconSparkles,
  IconTextCenter,
  IconTextLeft,
  IconTextRight,
  IconWand,
} from "./ui/glyphs.tsx";
import { Inspector } from "./ui/inspector.tsx";
import { LeftPanel, layerTitle } from "./ui/left-panel.tsx";
import { PromptBar, type PromptBarHandle, scopedInstruction, ToolsPill } from "./ui/prompt-bar.tsx";
import { TopBar } from "./ui/top-bar.tsx";

export type RightTab = "design" | "caption";

export interface WorkspaceProps {
  editor: PostEditor;
  snapshot: EditorSnapshot;
  brandName: string | null;
  status: { label: string; tone: TagTone };
  schedule: { label: string; disabled: string | null; open(): void };
  approvalFirst: boolean;
  onClose(): void;
  onPreview(): void;
  /** Runs the approval (the content checks may ask first); default: approve at once. */
  guardApproval?: (approve: () => void) => void;
  /** Debounce before saving on its own (tests). */
  autosaveMs?: number;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

export function PostEditorWorkspace(props: WorkspaceProps) {
  const { editor, snapshot, onClose } = props;
  const content: Content = snapshot.content;
  const api = useApi();
  const kit = useRenderKit(content.brandId);
  const session = useEditorSession(
    editor,
    snapshot,
    kit,
    props.autosaveMs !== undefined ? { autosaveMs: props.autosaveMs } : {},
  );
  const { draft, draftState, canvas, canvasState } = session;
  const [tab, setTab] = useState<RightTab>("design");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const prompt = useRef<PromptBarHandle | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const imageTarget = useRef<string | null>(null);
  const version = activeVersion(snapshot);
  const blocker = editBlocker(snapshot);

  const describe = useCallback(
    (key: string) => {
      const layer = findLayer(canvas.editorSlides, key);
      return layer ? { slide: layer.slide, id: layer.id, label: layerTitle(layer) } : null;
    },
    [canvas],
  );

  const sendAi = useCallback(
    async (text: string, scope: readonly string[]) => {
      if (!(await draft.flush())) {
        session.notify("Taslak kaydedilemedi; AI düzenlemesi için önce kaydedilmeli.", "error");
        return false;
      }
      return editor.sendInstruction(scopedInstruction(text, scope, describe));
    },
    [draft, editor, describe, session],
  );

  const approve = useCallback(async () => {
    if (!(await draft.flush())) return;
    await editor.whenIdle();
    await editor.verify();
    if (!canApprove(editor.getSnapshot())) return;
    const run = () => void editor.approve();
    if (props.guardApproval) props.guardApproval(run);
    else run();
  }, [draft, editor, props.guardApproval]);

  const openSchedule = useCallback(async () => {
    if (!(await draft.flush())) return;
    props.schedule.open();
  }, [draft, props.schedule]);

  const close = useCallback(() => {
    canvas.endTextEdit(true);
    void draft.flush();
    onClose();
  }, [canvas, draft, onClose]);

  const pickImage = (key: string | null) => {
    imageTarget.current = key;
    fileInput.current?.click();
  };

  const placeFile = async (file: File) => {
    const target = imageTarget.current;
    imageTarget.current = null;
    try {
      session.notify("Görsel yükleniyor…");
      const asset = await api.assets.upload({ brandId: content.brandId, kind: "image", file });
      const src = mediaSource(asset.id, asset.mimeType);
      if (target) {
        const layer = canvas.layer(target);
        if (!layer) return;
        canvas.applyOps(
          [
            layer.type === "slot"
              ? ({ op: "fillSlot", layer: layer.id, src, slide: layer.slide } as SlidePatchInput)
              : ({
                  op: "replaceImage",
                  layer: layer.id,
                  src,
                  slide: layer.slide,
                } as SlidePatchInput),
          ],
          layer.type === "slot" ? "Yuvayı doldur" : "Görseli değiştir",
        );
        return;
      }
      // A new picture layer in the middle of the active slide (half its width).
      const index = canvasState.activeSlide;
      const slide = canvas.editorSlides[index];
      if (!slide) return;
      const taken = new Set(slide.layers.map((l) => l.id));
      let n = 1;
      while (taken.has(`image-${n}`)) n++;
      const w = Math.round(slide.width / 2);
      const bitmap = await createImageBitmap(file).catch(() => null);
      const h = bitmap ? Math.round((w * bitmap.height) / bitmap.width) : w;
      bitmap?.close();
      const id = `image-${n}`;
      const ok = canvas.applyOps(
        [
          {
            op: "insertLayer",
            parent: null,
            index: slide.roots.length,
            html: `<img data-layer="${id}" data-type="image" src="${src}" alt="" style="position: absolute; left: ${Math.round((slide.width - w) / 2)}px; top: ${Math.round((slide.height - h) / 2)}px; width: ${w}px; height: ${h}px; object-fit: cover">`,
            leading: "\n    ",
            slide: index,
          } as SlidePatchInput,
        ],
        "Görsel yerleştir",
      );
      if (ok) setTimeout(() => canvas.selectLayers([layerKey(index, id)]), 0);
    } catch (e) {
      session.notify(`Görsel yüklenemedi: ${describeError(e)}`, "error");
    }
  };

  const run = useCallback(
    (command: ShortcutCommand): boolean => {
      const sel = canvasState.selection;
      const layers = sel
        .map((k) => canvas.layer(k))
        .filter((l): l is NonNullable<typeof l> => l !== null);
      switch (command) {
        case "tool.move":
          canvas.setTool("MOVE");
          return true;
        case "tool.hand":
          canvas.setTool("HAND");
          return true;
        case "tool.scale":
          canvas.setTool("SCALE");
          return true;
        case "layer.text":
          canvas.setTool("TEXT");
          return true;
        case "layer.shape":
          canvas.setTool("RECTANGLE");
          return true;
        case "image.place":
          pickImage(null);
          return true;
        case "ai.focus":
          prompt.current?.focus(undefined, sel);
          return true;
        case "undo": {
          const name = draft.undo();
          if (name) session.notify(`Geri alındı: ${name}`);
          return true;
        }
        case "redo": {
          const name = draft.redo();
          if (name) session.notify(`Yinelendi: ${name}`);
          return true;
        }
        case "layer.duplicate":
          if (!layers.length) return false;
          canvas.applyOps(
            layers.map(
              (l) =>
                ({
                  op: "duplicateLayer",
                  layer: l.id,
                  offset: { x: 24, y: 24 },
                  slide: l.slide,
                }) as SlidePatchInput,
            ),
            "Çoğalt",
          );
          return true;
        case "layer.delete":
          if (!layers.length) return false;
          canvas.applyOps(
            layers.map(
              (l) => ({ op: "deleteLayer", layer: l.id, slide: l.slide }) as SlidePatchInput,
            ),
            "Sil",
          );
          canvas.selectLayers([]);
          return true;
        case "layer.forward":
        case "layer.backward":
          if (layers.length !== 1) return false;
          canvas.restack((layers[0] as { key: string }).key, command === "layer.forward" ? 1 : -1);
          return true;
        case "layer.group":
          session.notify(
            "Gruplama henüz yok: tasarım sözleşmesinde gruplar AI'nın kurduğu düzenlerdir.",
          );
          return true;
        case "slide.prev":
        case "slide.next": {
          const next = canvasState.activeSlide + (command === "slide.next" ? 1 : -1);
          canvas.selectSlide(next, { zoom: canvasState.focus !== null });
          if (canvasState.focus !== null && next >= 0 && next < canvas.editorSlides.length)
            canvas.setFocus(next);
          return true;
        }
        case "slide.add":
        case "slide.duplicate":
          session.notify(
            "Kare ekleme ve çoğaltma sohbetten yapılır (AI kareyi tasarım sistemine göre kurar).",
          );
          return true;
        case "zoom.fit":
          canvas.command("ZOOM_TO_FIT");
          return true;
        case "zoom.selection":
          if (sel.length) canvas.command("ZOOM_TO_SELECTION");
          else canvas.zoomToSlide(canvasState.activeSlide);
          return true;
        case "zoom.100":
          canvas.command("ZOOM_TO_100");
          return true;
        case "zoom.in":
          canvas.command("ZOOM_IN");
          return true;
        case "zoom.out":
          canvas.command("ZOOM_OUT");
          return true;
        case "view.safeArea":
          canvas.setSafeArea(!canvasState.safeArea);
          return true;
        case "view.rulers":
          canvas.setRulers(!canvasState.rulers);
          return true;
        case "view.snapping":
          canvas.setSnapping(!canvasState.snapping);
          session.notify(canvasState.snapping ? "Yapışma kapalı" : "Yapışma açık");
          return true;
        case "versions.open":
          setVersionsOpen((o) => !o);
          return true;
        case "versions.save":
          void (async () => {
            if (!draft.dirty) {
              session.notify("Kaydedilecek değişiklik yok.");
              return;
            }
            if (await draft.flush()) session.notify("Sürüm kaydedildi.");
          })();
          return true;
        case "preview":
          props.onPreview();
          return true;
        case "approve":
          void approve();
          return true;
        case "schedule":
          void openSchedule();
          return true;
        case "caption.tab":
          setTab((t) => (t === "caption" ? "design" : "caption"));
          return true;
        case "select.all": {
          const slide = canvas.editorSlides[canvasState.activeSlide];
          if (!slide) return false;
          canvas.selectLayers(slide.roots.map((id) => layerKey(slide.index, id)));
          return true;
        }
        case "text.edit": {
          const only = layers.length === 1 ? layers[0] : null;
          if (only?.type === "text") {
            canvas.startTextEdit(only.key);
            return true;
          }
          return false;
        }
        case "escape":
          if (canvasState.cropping) {
            canvas.endCrop();
            return true;
          }
          if (versionsOpen) {
            setVersionsOpen(false);
            return true;
          }
          if (canvasState.tool !== "MOVE") {
            canvas.setTool("MOVE");
            return true;
          }
          if (sel.length) {
            // Esc selects the parent first (a layer in a group), then nothing.
            const first = layers[0];
            if (layers.length === 1 && first?.parent)
              canvas.selectLayers([layerKey(first.slide, first.parent)]);
            else canvas.selectLayers([]);
            return true;
          }
          if (canvasState.focus !== null) {
            canvas.setFocus(null);
            return true;
          }
          close();
          return true;
      }
      return false;
    },
    [
      canvasState,
      canvas,
      draft,
      session,
      versionsOpen,
      approve,
      openSchedule,
      close,
      props.onPreview,
    ],
  );

  // Keys on the canvas come through the controller; elsewhere in the window, here.
  const runKey = useCallback(
    (e: KeyboardEvent): boolean => {
      const shortcut = matchShortcut(e);
      if (!shortcut) return false;
      // Arrows with a selection nudge (the engine's); ⌫ / ↩ belong to text fields.
      return run(shortcut.command);
    },
    [run],
  );
  useEffect(() => {
    canvas.keyHandler = runKey;
    return () => {
      canvas.keyHandler = null;
    };
  }, [canvas, runKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || useAppStore.getState().lightbox) return;
      if (isTyping(e.target)) {
        // ⌘S / ⌘Z still work from a field? Only ⌘S and ⌘↩ (they never edit the field).
        const s = matchShortcut(e);
        if (
          s &&
          (s.command === "versions.save" || s.command === "approve" || s.command === "schedule")
        ) {
          e.preventDefault();
          run(s.command);
        }
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "CANVAS") return;
      // Menus, lists, segmented controls and other dialogs keep their own keys.
      if (
        target?.closest?.(
          '[role="menu"],[role="listbox"]:not([data-editor-list]),[role="radiogroup"],[role="tablist"],[role="dialog"]:not([data-post-editor])',
        )
      )
        return;
      const s = matchShortcut(e);
      if (!s) return;
      // Arrows without a canvas focus turn the slides only when nothing is selected.
      if (
        (s.command === "slide.prev" || s.command === "slide.next") &&
        canvasState.selection.length > 0
      )
        return;
      if (run(s.command)) {
        e.preventDefault();
        // The app's own shortcuts (⌘K search …) stay out while the editor is open.
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [run, canvasState.selection.length]);

  const busy =
    snapshot.activity.kind === "revising"
      ? {
          label: snapshot.activity.message || "AI düzenliyor",
          ...(snapshot.revisionJobId ? { cancel: () => void editor.cancelRevision() } : {}),
        }
      : null;

  // Unsaved edits are saved first: approving waits for that render, then checks the hash.
  const approveDisabled =
    draftState.pending.length > 0 && !draftState.saving && !hasApproval(content)
      ? null
      : approveBlocker(snapshot);

  const selectionToolbar = (() => {
    const layers = canvasState.selection
      .map((k) => canvas.layer(k))
      .filter((l): l is NonNullable<typeof l> => l !== null);
    const first = layers[0];
    if (!first || canvasState.editing) return null;
    const image = layers.length === 1 && (first.type === "image" || first.type === "slot");
    return (
      <div className="glass flex h-9 items-center gap-0.5 rounded-full p-1 shadow-md">
        <button
          type="button"
          onClick={() => prompt.current?.focus(image ? "Bu görseli " : "", canvasState.selection)}
          className="flex h-7 items-center gap-1.5 rounded-full bg-accent-subtle px-2.5 text-body font-medium text-accent-text hover:bg-accent/25"
        >
          <IconSparkles size={13} /> {image ? "Görsel üret" : "AI ile düzenle"}
        </button>
        {image ? (
          <>
            <button
              type="button"
              onClick={() => pickImage(first.key)}
              className="h-7 rounded-full px-2.5 text-body text-fg hover:bg-control"
            >
              Değiştir
            </button>
            <button
              type="button"
              onClick={() => void sendAi("Arka planı kaldır", canvasState.selection)}
              className="h-7 rounded-full px-2.5 text-body text-fg hover:bg-control"
            >
              Arka planı kaldır
            </button>
            <IconButton
              size={28}
              icon={<IconCrop size={14} />}
              label="Kırp"
              onClick={() => canvas.startCrop(first.key)}
            />
          </>
        ) : first.type === "text" ? (
          <>
            <IconButton
              size={28}
              icon={<IconTextLeft size={14} />}
              label="Sola yasla"
              onClick={() =>
                canvas.applyOps(
                  layers.map(
                    (l) =>
                      ({
                        op: "setTypography",
                        layer: l.id,
                        textAlign: "left",
                        slide: l.slide,
                      }) as SlidePatchInput,
                  ),
                  "Hizalama",
                )
              }
            />
            <IconButton
              size={28}
              icon={<IconTextCenter size={14} />}
              label="Ortala"
              onClick={() =>
                canvas.applyOps(
                  layers.map(
                    (l) =>
                      ({
                        op: "setTypography",
                        layer: l.id,
                        textAlign: "center",
                        slide: l.slide,
                      }) as SlidePatchInput,
                  ),
                  "Hizalama",
                )
              }
            />
            <IconButton
              size={28}
              icon={<IconTextRight size={14} />}
              label="Sağa yasla"
              onClick={() =>
                canvas.applyOps(
                  layers.map(
                    (l) =>
                      ({
                        op: "setTypography",
                        layer: l.id,
                        textAlign: "right",
                        slide: l.slide,
                      }) as SlidePatchInput,
                  ),
                  "Hizalama",
                )
              }
            />
            <MenuButton
              label="Marka rengi"
              width={200}
              entries={kit.swatches.map((sw) => ({
                id: sw.token,
                label: sw.token,
                detail: sw.value,
                icon: <span className="size-3 rounded-full" style={{ background: sw.value }} />,
                onSelect: () =>
                  canvas.applyOps(
                    layers.map(
                      (l) =>
                        ({
                          op: "setColor",
                          layer: l.id,
                          property: "color",
                          value: { token: sw.token },
                          slide: l.slide,
                        }) as unknown as SlidePatchInput,
                    ),
                    "Marka rengi",
                  ),
              }))}
            >
              {({ ref, onClick, onKeyDown, open, ...aria }) => (
                <IconButton
                  ref={ref}
                  size={28}
                  icon={<IconWand size={14} />}
                  label="Marka rengi"
                  selected={open}
                  onClick={onClick}
                  onKeyDown={onKeyDown}
                  {...aria}
                />
              )}
            </MenuButton>
          </>
        ) : null}
      </div>
    );
  })();

  return (
    <div
      role="dialog"
      data-post-editor=""
      aria-label={`Post editörü: ${content.title}`}
      className="fixed inset-0 z-40 flex flex-col bg-page text-fg animate-fade-in"
    >
      <TopBar
        session={session}
        editor={editor}
        snapshot={snapshot}
        status={props.status}
        onBack={close}
        onPreview={props.onPreview}
        onApprove={() => void approve()}
        onSchedule={() => void openSchedule()}
        approve={{
          visible: props.approvalFirst,
          disabled: approveDisabled,
          busy: snapshot.approving,
        }}
        schedule={{ label: props.schedule.label, disabled: props.schedule.disabled }}
        versionsOpen={versionsOpen}
        setVersionsOpen={setVersionsOpen}
      />
      <div className="flex min-h-0 flex-1">
        <LeftPanel
          session={session}
          content={content}
          version={version}
          brandName={props.brandName}
        />
        <CanvasArea
          session={session}
          selectionToolbar={selectionToolbar}
          bottom={
            <>
              <ToolsPill
                session={session}
                onPlaceImage={() => pickImage(null)}
                onAi={() => prompt.current?.focus(undefined, canvasState.selection)}
              />
              <PromptBar
                ref={prompt}
                session={session}
                busy={busy}
                disabled={
                  changesVersion(snapshot.activity) && snapshot.activity.kind !== "rendering"
                    ? "Bekle…"
                    : blocker && snapshot.activity.kind !== "revising"
                      ? blocker
                      : null
                }
                onSend={sendAi}
              />
            </>
          }
        />
        <aside
          className="flex w-[280px] shrink-0 flex-col border-l border-hairline bg-sidebar"
          aria-label="Özellikler"
        >
          <div className="px-3 pt-3 pb-1">
            <SegmentedControl<RightTab>
              className="w-full [&>button]:flex-1"
              label="Sağ panel"
              value={tab}
              onChange={setTab}
              options={[
                { value: "design", label: "Tasarım" },
                { value: "caption", label: "Açıklama" },
              ]}
            />
          </div>
          {blocker && snapshot.activity.kind !== "revising" && (
            <div className="mx-3 mt-2 flex items-start gap-2 rounded-[10px] bg-warning/12 px-2.5 py-2 text-footnote text-fg-2">
              <IconWarning size={12} className="mt-0.5 shrink-0 text-warning" />
              {blocker}
            </div>
          )}
          {hasApproval(content) && !blocker && (
            <p className="mx-3 mt-2 rounded-[10px] bg-control px-2.5 py-2 text-footnote text-fg-2">
              Tasarımı değiştirmek yeni bir sürüm oluşturur ve onayı kaldırır; bekleyen zamanlamalar
              iptal olur.
            </p>
          )}
          <div className="scroll-area min-h-0 flex-1">
            {tab === "design" ? (
              <Inspector
                session={session}
                kit={kit}
                actions={{
                  ai: (instruction, keys) => void sendAi(instruction, keys),
                  replaceImage: (key) => pickImage(key),
                }}
              />
            ) : (
              <CaptionPanel snapshot={snapshot} editor={editor} />
            )}
          </div>
        </aside>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void placeFile(file);
        }}
      />
      <Toasts session={session} snapshot={snapshot} editor={editor} />
    </div>
  );
}

function Toasts({
  session,
  snapshot,
  editor,
}: {
  session: ReturnType<typeof useEditorSession>;
  snapshot: EditorSnapshot;
  editor: PostEditor;
}) {
  const items = [
    ...session.toasts,
    ...(snapshot.error ? [{ id: -1, message: snapshot.error, tone: "error" as const }] : []),
    ...(snapshot.notice ? [{ id: -2, message: snapshot.notice, tone: "notice" as const }] : []),
  ];
  useEffect(() => {
    if (!snapshot.notice) return;
    const t = setTimeout(() => editor.clearNotice(), 4000);
    return () => clearTimeout(t);
  }, [snapshot.notice, editor]);
  if (items.length === 0) return null;
  return (
    <div className="pointer-events-none fixed top-14 right-[296px] z-50 flex w-[320px] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className={cn(
            "glass pointer-events-auto flex items-start gap-2 rounded-[12px] px-3 py-2 text-body",
            t.tone === "error" ? "text-fg" : "text-fg-2",
          )}
        >
          {t.tone === "error" && <IconWarning size={14} className="mt-0.5 shrink-0 text-danger" />}
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{t.message}</span>
          <IconButton
            size={24}
            icon={<IconClose size={12} />}
            label="Kapat"
            tooltip={false}
            onClick={() => {
              if (t.id === -1) editor.clearError();
              else if (t.id === -2) editor.clearNotice();
              else session.dismiss(t.id);
            }}
          />
        </div>
      ))}
    </div>
  );
}
