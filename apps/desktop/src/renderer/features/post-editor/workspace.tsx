// The open post, inside the app's layout (Wecra's "Post Editor" as an app mode, not a screen):
// the centre column becomes the canvas — the slides' own HTML under Wecra's engine, the
// floating layers list on its left edge, one floating dock at its bottom (the edit tools, or the
// post's message box, with the Sohbet / Düzenle switch) — the right panel becomes the post's
// panel (Düzenle: the properties panel and the caption; Sohbet: the post's conversation), and
// the top bar's title area shows the post (title, state, versions, Onayla, Zamanla). The sidebar
// and the top bar stay the app's; back (⌘[) returns to where the post was opened from.
//
// Everything that changes the design goes through the draft (model/draft.ts): instant on the
// canvas, saved as `content.render` jobs on its own. Approving, scheduling and chat messages
// save first.
import type { Content } from "@studio/contract";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cn, IconButton, type TagTone } from "../../components/ui/controls.tsx";
import { IconClose, IconWarning } from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import {
  activeVersion,
  approveBlocker,
  canApprove,
  changesVersion,
  type EditorSnapshot,
  hasApproval,
  type PostEditor,
} from "../post-detail/editor.ts";
import { mediaSource } from "../posts/slides.ts";
import { usePostChat } from "./chat.ts";
import { useRenderKit } from "./data.ts";
import { findLayer, layerKey } from "./model/document.ts";
import type { SlidePatchInput } from "./model/draft.ts";
import { presetFor, presetsForSlide } from "./model/safe-areas.ts";
import { matchShortcut, type ShortcutCommand } from "./model/shortcuts.ts";
import { type EditorSession, useEditorSession } from "./session.ts";
import { InSlot } from "./slots.tsx";
import { CanvasArea } from "./ui/canvas-view.tsx";
import { ChatHeader, ChatPanel } from "./ui/chat-panel.tsx";
import { EditPanel, EditTabs } from "./ui/edit-panel.tsx";
import {
  IconCrop,
  IconSparkles,
  IconTextCenter,
  IconTextLeft,
  IconTextRight,
  IconWand,
} from "./ui/glyphs.tsx";
import { LAYERS_DOCK_WIDTH, LayersDock, layerTitle } from "./ui/layers-dock.tsx";
import { ChatInput, type ChatInputHandle, EditTools, ModeDock } from "./ui/mode-dock.tsx";
import { TitleBar } from "./ui/title-bar.tsx";
import { modeOf, useWorkspaceStore, type WorkspaceMode } from "./workspace-store.ts";

export interface WorkspaceProps {
  editor: PostEditor;
  snapshot: EditorSnapshot;
  brandName: string | null;
  status: { label: string; tone: TagTone };
  schedule: { label: string; disabled: string | null; open(): void };
  approvalFirst: boolean;
  /** The post's "…" menu (quick look, copy caption, open in chat, duplicate, delete). */
  menu?: MenuEntry[];
  /** Back to where the post was opened from. */
  onClose(): void;
  onPreview(): void;
  /** Runs the approval (the content checks may ask first); default: approve at once. */
  guardApproval?: (approve: () => void) => void;
  /** The approve guard's question and the schedule sheet. */
  dialogs?: ReactNode;
  /** Debounce before saving on its own (tests). */
  autosaveMs?: number;
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement ||
  target instanceof HTMLTextAreaElement ||
  target instanceof HTMLSelectElement ||
  (target instanceof HTMLElement && target.isContentEditable);

/** A key belongs to the workspace when it comes from the canvas, its panels or nowhere. */
const inWorkspace = (target: EventTarget | null) =>
  target === null ||
  target === document.body ||
  (target instanceof Element && !!target.closest("[data-post-workspace],[data-workspace-slot]"));

/** Below this canvas width the layers list starts folded. */
const NARROW_CANVAS = 700;

const MOVE_TOOLS = new Set<ShortcutCommand>([
  "tool.move",
  "tool.hand",
  "tool.scale",
  "layer.text",
  "layer.shape",
]);

export function PostWorkspace(props: WorkspaceProps) {
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
  const mode = useWorkspaceStore((s) => modeOf(s, content.id));
  const editTab = useWorkspaceStore((s) => s.editTab);
  const layersWanted = useWorkspaceStore((s) => s.layersOpen);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const root = useRef<HTMLElement | null>(null);
  const chatInput = useRef<ChatInputHandle | null>(null);
  const pendingFocus = useRef<{ prefill?: string; scope?: readonly string[] } | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const imageTarget = useRef<string | null>(null);
  const version = activeVersion(snapshot);

  // The shell shows the post: its title in the top bar, its panel on the right.
  useEffect(() => {
    useWorkspaceStore.getState().setActive(content.id);
    useAppStore.getState().showPostPanel();
    root.current?.focus({ preventScroll: true });
    return () => {
      if (useWorkspaceStore.getState().active === content.id)
        useWorkspaceStore.getState().setActive(null);
      useAppStore.getState().releasePostPanel();
    };
  }, [content.id]);

  // On a narrow canvas the layers list folds into its pill until it is opened there by hand.
  const narrow = useSyncExternalStore(
    (cb) => canvas.onView(cb),
    () => canvas.getView().width > 0 && canvas.getView().width < NARROW_CANVAS,
  );
  const [openedNarrow, setOpenedNarrow] = useState(false);
  useEffect(() => {
    if (!narrow) setOpenedNarrow(false);
  }, [narrow]);
  const layersOpen = layersWanted && (!narrow || openedNarrow);
  const setLayersOpen = (open: boolean) => {
    if (narrow) setOpenedNarrow(open);
    if (open || !narrow) useWorkspaceStore.getState().setLayersOpen(open);
  };

  // Fitted slides keep clear of the layers list.
  useEffect(() => {
    canvas.setInsets({ left: layersOpen ? 12 + LAYERS_DOCK_WIDTH + 28 : 40 });
  }, [canvas, layersOpen]);

  const setMode = useCallback(
    (next: WorkspaceMode, focus?: { prefill?: string; scope?: readonly string[] }) => {
      useWorkspaceStore.getState().setMode(content.id, next);
      // A mode switch brings the post's panel back (if another pane was picked meanwhile).
      useAppStore.getState().showPostPanel();
      if (next === "chat") {
        pendingFocus.current = focus ?? {};
        if (chatInput.current) {
          chatInput.current.focus(focus?.prefill, focus?.scope);
          pendingFocus.current = null;
        }
      }
    },
    [content.id],
  );
  // The message box mounts with the switch: focus it then.
  useEffect(() => {
    if (mode !== "chat" || !pendingFocus.current) return;
    const f = pendingFocus.current;
    pendingFocus.current = null;
    chatInput.current?.focus(f.prefill, f.scope);
  }, [mode]);

  const describe = useCallback(
    (key: string) => {
      const layer = findLayer(canvas.editorSlides, key);
      return layer ? { slide: layer.slide, id: layer.id, label: layerTitle(layer) } : null;
    },
    [canvas],
  );

  const chat = usePostChat({
    content,
    version,
    flush: () => draft.flush(),
    describe,
    notify: session.notify,
    onReplyEnd: () => void editor.refresh(),
  });

  /** Ask the post's Sohbet: switch to it and send (the quick AI chips). */
  const askChat = useCallback(
    (instruction: string, scope: readonly string[]) => {
      setMode("chat");
      void chat.send(instruction, scope);
    },
    [chat, setMode],
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
      // Picking a tool is editing: the dock shows the tools.
      if (MOVE_TOOLS.has(command) && mode !== "edit") setMode("edit");
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
          setMode("chat", { scope: sel });
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
            "Kare ekleme ve çoğaltma Sohbet'ten yapılır (AI kareyi tasarım sistemine göre kurar).",
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
        case "caption.tab": {
          const store = useWorkspaceStore.getState();
          if (mode !== "edit") setMode("edit");
          else useAppStore.getState().showPostPanel();
          store.setEditTab(store.editTab === "caption" ? "design" : "caption");
          return true;
        }
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
      mode,
      setMode,
      props.onPreview,
    ],
  );

  // Keys on the canvas come through the controller; elsewhere in the workspace, here.
  const runKey = useCallback(
    (e: KeyboardEvent): boolean => {
      const shortcut = matchShortcut(e);
      if (!shortcut) return false;
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
      if (!inWorkspace(e.target)) return;
      if (isTyping(e.target)) {
        // From a field only ⌘S, and ⌘↩ / ⇧⌘↩ outside text boxes (the message box and the
        // caption keep theirs: ⌘↩ never approves while writing).
        const s = matchShortcut(e);
        const box = e.target instanceof HTMLTextAreaElement;
        if (
          s &&
          (s.command === "versions.save" ||
            (!box && (s.command === "approve" || s.command === "schedule")))
        ) {
          e.preventDefault();
          run(s.command);
        }
        return;
      }
      const target = e.target as HTMLElement | null;
      if (target?.tagName === "CANVAS") return;
      // Menus, lists, segmented controls and dialogs keep their own keys.
      if (
        target?.closest?.(
          '[role="menu"],[role="listbox"]:not([data-editor-list]),[role="radiogroup"],[role="tablist"],[role="dialog"]',
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
        // The app's own shortcuts (⌘K search …) stay out while the post is open.
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [run, canvasState.selection.length]);

  // Unsaved edits are saved first: approving waits for that render, then checks the hash.
  const approveDisabled =
    draftState.pending.length > 0 && !draftState.saving && !hasApproval(content)
      ? null
      : approveBlocker(snapshot);

  const chatDisabled =
    changesVersion(snapshot.activity) && snapshot.activity.kind !== "rendering" ? "Bekle…" : null;

  const first = canvas.editorSlides[0];
  const preset = first
    ? presetFor(content.type, content.targetPlatforms, first, session.preset)
    : null;
  const viewEntries = (): MenuEntry[] => [
    { type: "label", label: "Görünüm" },
    {
      id: "all",
      label: "Tüm kareler",
      checked: canvasState.focus === null,
      onSelect: () => canvas.setFocus(null),
    },
    {
      id: "focus",
      label: "Odak: yalnız bu kare",
      checked: canvasState.focus !== null,
      onSelect: () => canvas.setFocus(canvasState.activeSlide),
    },
    { type: "separator" },
    {
      id: "layers",
      label: "Katmanlar listesi",
      checked: layersOpen,
      onSelect: () => setLayersOpen(!layersOpen),
    },
    {
      id: "snapping",
      label: "Yapışma",
      shortcut: "⌘;",
      checked: canvasState.snapping,
      onSelect: () => canvas.setSnapping(!canvasState.snapping),
    },
    {
      id: "rulers",
      label: "Cetveller",
      shortcut: "⇧R",
      checked: canvasState.rulers,
      onSelect: () => canvas.setRulers(!canvasState.rulers),
    },
    ...(first
      ? ([
          { type: "separator" },
          { type: "label", label: "Önizleme biçimi" },
          ...presetsForSlide(first).map((p) => ({
            id: `preset-${p.id}`,
            label: p.label,
            checked: p.id === preset?.id,
            onSelect: () => session.setPreset(p.id),
          })),
        ] as MenuEntry[])
      : []),
  ];

  const selectionToolbar = (
    <SelectionToolbar
      session={session}
      kit={kit}
      onAi={(image) =>
        setMode("chat", { prefill: image ? "Bu görseli " : "", scope: canvasState.selection })
      }
      onReplace={(key) => pickImage(key)}
      onRemoveBackground={() => askChat("Arka planı kaldır", canvasState.selection)}
    />
  );

  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label={`Post: ${content.title}`}
      data-post-workspace=""
      data-mode={mode}
      className="absolute inset-0 z-30 flex bg-page outline-none animate-fade-in"
    >
      <CanvasArea
        session={session}
        selectionToolbar={selectionToolbar}
        coveredLeft={layersOpen ? 12 + LAYERS_DOCK_WIDTH : 0}
        overlay={
          <>
            <LayersDock
              session={session}
              open={layersOpen}
              onOpenChange={setLayersOpen}
              thumbs={(version?.slides ?? []).map((s) => s.renderedAssetId ?? null)}
            />
            <Toasts session={session} snapshot={snapshot} editor={editor} />
          </>
        }
        bottom={
          <ModeDock
            mode={mode}
            onMode={(m) => setMode(m)}
            edit={
              <EditTools
                session={session}
                onPlaceImage={() => pickImage(null)}
                viewEntries={viewEntries}
              />
            }
            chat={
              <ChatInput
                ref={chatInput}
                session={session}
                working={chat.working}
                disabled={chatDisabled}
                onSend={chat.send}
                onStop={chat.stop}
              />
            }
          />
        }
      />

      <InSlot name="title">
        <TitleBar
          session={session}
          editor={editor}
          snapshot={snapshot}
          status={props.status}
          menu={props.menu ?? []}
          onBack={close}
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
      </InSlot>
      <InSlot name="panel-header">
        {mode === "edit" ? (
          <>
            <EditTabs tab={editTab} onTab={(t) => useWorkspaceStore.getState().setEditTab(t)} />
            <span className="flex-1" />
          </>
        ) : (
          <ChatHeader chat={chat} title={content.title} />
        )}
      </InSlot>
      <InSlot name="panel">
        <div
          key={mode}
          data-post-panel={mode}
          className="flex min-h-0 flex-1 flex-col animate-fade-in"
        >
          {mode === "edit" ? (
            <EditPanel
              tab={editTab}
              session={session}
              kit={kit}
              editor={editor}
              snapshot={snapshot}
              actions={{ ai: askChat, replaceImage: (key) => pickImage(key) }}
            />
          ) : (
            <ChatPanel chat={chat} onStarter={(text) => chatInput.current?.focus(text)} />
          )}
        </div>
      </InSlot>

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
      {props.dialogs}
    </section>
  );
}

/** Over the selection: ask the chat, and the selection's quick edits. */
function SelectionToolbar({
  session,
  kit,
  onAi,
  onReplace,
  onRemoveBackground,
}: {
  session: EditorSession;
  kit: ReturnType<typeof useRenderKit>;
  onAi(image: boolean): void;
  onReplace(key: string): void;
  onRemoveBackground(): void;
}) {
  const { canvas, canvasState } = session;
  const layers = canvasState.selection
    .map((k) => canvas.layer(k))
    .filter((l): l is NonNullable<typeof l> => l !== null);
  const first = layers[0];
  if (!first || canvasState.editing) return null;
  const image = layers.length === 1 && (first.type === "image" || first.type === "slot");
  const align = (textAlign: "left" | "center" | "right") =>
    canvas.applyOps(
      layers.map(
        (l) =>
          ({
            op: "setTypography",
            layer: l.id,
            textAlign,
            slide: l.slide,
          }) as SlidePatchInput,
      ),
      "Hizalama",
    );
  return (
    <div className="glass flex h-9 items-center gap-0.5 rounded-full p-1 shadow-md">
      <button
        type="button"
        onClick={() => onAi(image)}
        className="flex h-7 items-center gap-1.5 rounded-full bg-accent-subtle px-2.5 text-body font-medium text-accent-text hover:bg-accent/25"
      >
        <IconSparkles size={13} /> {image ? "Görsel üret" : "Sohbette düzenle"}
      </button>
      {image ? (
        <>
          <button
            type="button"
            onClick={() => onReplace(first.key)}
            className="h-7 rounded-full px-2.5 text-body text-fg hover:bg-control"
          >
            Değiştir
          </button>
          <button
            type="button"
            onClick={onRemoveBackground}
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
            onClick={() => align("left")}
          />
          <IconButton
            size={28}
            icon={<IconTextCenter size={14} />}
            label="Ortala"
            onClick={() => align("center")}
          />
          <IconButton
            size={28}
            icon={<IconTextRight size={14} />}
            label="Sağa yasla"
            onClick={() => align("right")}
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
}

function Toasts({
  session,
  snapshot,
  editor,
}: {
  session: EditorSession;
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
    <div className="pointer-events-none absolute top-3 right-3 z-30 flex w-[320px] max-w-[calc(100%-24px)] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          role={t.tone === "error" ? "alert" : "status"}
          className={cn(
            "glass pointer-events-auto flex items-start gap-2 rounded-[16px] py-2 pr-1.5 pl-3 text-body",
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
