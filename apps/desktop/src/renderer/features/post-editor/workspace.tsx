// The open post, inside the app's layout (Wecra's "Post Editor" as an app mode, not a screen):
// the centre column becomes Wecra's own editor — its engine draws the slides as frames and does
// everything Wecra does there (selection, handles, guides, auto layout, constraints, text, images,
// effects, its keys, clipboard and context menu) — with Wecra's Layers on a card at its left edge
// and one floating dock at its bottom (Wecra's tools, or the post's message box, with the
// Sohbet / Düzenle switch). The right panel becomes the post's panel (Düzenle: Wecra's Design
// panel, and the caption; Sohbet: the post's conversation) and the top bar's title area shows
// the post (title, state, versions, save state, Onayla, Zamanla). The sidebar and the top bar
// stay the app's, and so does back (the top bar's ‹ ›, ⌘[): the post has no back button of its
// own.
//
// The document is Wecra's (wecra/session.ts): a version saved from the canvas opens its saved
// document; any other version (the AI's) is imported from its HTML once. Saving exports the
// slides through Wecra's engine as the new version's renders. Approving, scheduling, a chat
// message and leaving save first.
import type { Content } from "@studio/contract";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { EditorController } from "@/editor/controller";
import { useTool } from "@/engine/hooks";
import {
  cn,
  IconButton,
  SegmentedControl,
  Spinner,
  type TagTone,
} from "../../components/ui/controls.tsx";
import { IconClose, IconWarning } from "../../components/ui/icons.tsx";
import type { MenuEntry } from "../../components/ui/menu.tsx";
import { useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import {
  activeVersion,
  approveBlocker,
  canApprove,
  changesVersion,
  type EditorSnapshot,
  type PostEditor,
} from "../post-detail/editor.ts";
import { usePostChat } from "./chat.ts";
import { useRenderKit } from "./data.ts";
import { InSlot } from "./slots.tsx";
import { CaptionPanel } from "./ui/caption-panel.tsx";
import { ChatHeader, ChatPanel } from "./ui/chat-panel.tsx";
import { LAYERS_CARD_INSET, LAYERS_CARD_WIDTH, LayersCard } from "./ui/layers-card.tsx";
import { ChatInput, type ChatInputHandle, ModeDock } from "./ui/mode-dock.tsx";
import { type SaveControl, TitleBar } from "./ui/title-bar.tsx";
import { installStudioFonts } from "./wecra/fonts.ts";
import {
  WecraDesignPanel,
  WecraEditor,
  WecraScope,
  WecraToolbar,
  WecraZoomMenu,
} from "./wecra/host.tsx";
import { type ChatLayers, describeNode, NO_LAYERS, useChatLayers } from "./wecra/scope.ts";
import { WecraPostSession, type WecraSessionState } from "./wecra/session.ts";
import { type EditTab, modeOf, useWorkspaceStore, type WorkspaceMode } from "./workspace-store.ts";

export interface WorkspaceProps {
  editor: PostEditor;
  snapshot: EditorSnapshot;
  brandName: string | null;
  status: { label: string; tone: TagTone };
  schedule: { label: string; disabled: string | null; open(): void };
  approvalFirst: boolean;
  /** The post's "…" menu (quick look, copy caption, open in chat, duplicate, delete). */
  menu?: MenuEntry[];
  /** Back to where the post was opened from (the app's back does it; kept for the shell). */
  onClose(): void;
  onPreview(): void;
  /** Runs the approval (the content checks may ask first); default: approve at once. */
  guardApproval?: (approve: () => void) => void;
  /** The approve guard's question and the schedule sheet. */
  dialogs?: ReactNode;
  /** Pause before saving on its own (tests; 0: never). */
  autosaveMs?: number;
}

interface Toast {
  id: number;
  message: string;
  tone: "error" | "notice";
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
  (target instanceof Element &&
    !!target.closest("[data-post-workspace],[data-workspace-slot],[data-wecra-region]"));

/** The dock's height and margin: zoom to fit keeps the slides above it. */
const DOCK_INSET = 68;

export function PostWorkspace(props: WorkspaceProps) {
  const { editor, snapshot } = props;
  const content: Content = snapshot.content;
  const api = useApi();
  const kit = useRenderKit(content.brandId);
  const version = activeVersion(snapshot);
  const mode = useWorkspaceStore((s) => modeOf(s, content.id));
  const editTab = useWorkspaceStore((s) => s.editTab);
  const layersOpen = useWorkspaceStore((s) => s.layersOpen);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const root = useRef<HTMLElement | null>(null);
  const chatInput = useRef<ChatInputHandle | null>(null);
  const pendingFocus = useRef<{ prefill?: string } | null>(null);

  const notify = useCallback((message: string, tone: Toast["tone"] = "notice") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, tone }]);
    if (tone === "notice") setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);

  // The post's Wecra document (one session per opened post).
  const latest = useRef({ content, kit, editor });
  latest.current = { content, kit, editor };
  const [session] = useState(
    () =>
      new WecraPostSession({
        api,
        content: () => latest.current.content,
        kit: () => latest.current.kit,
        refresh: () => latest.current.editor.refresh(),
        ...(props.autosaveMs !== undefined ? { autosaveMs: props.autosaveMs } : {}),
      }),
  );
  const ws = useSyncExternalStore(session.subscribe, session.getState);
  const ed = ws.editor;
  useEffect(() => {
    session.activate();
    return () => {
      // Leaving the post (the app's back, the sidebar): unsaved edits are saved — read from the
      // editor now, before it goes.
      void session.flush({ closing: true });
      session.dispose();
    };
  }, [session]);
  // The brand's fonts for Wecra's text engine, before a document opens.
  const fontsFor = useRef<object | null>(null);
  if (fontsFor.current !== kit) {
    fontsFor.current = kit;
    installStudioFonts(kit);
  }
  // The version shown is the document on the canvas (an older one too: saving makes it current).
  useEffect(() => {
    if (version) void session.open(version);
  }, [session, version]);
  useEffect(() => {
    if (ws.saveError) notify(ws.saveError, "error");
  }, [ws.saveError, notify]);
  useEffect(() => {
    for (const w of ws.warnings) notify(w, "notice");
  }, [ws.warnings, notify]);

  // The shell shows the post: its title in the top bar, its panel on the right.
  useEffect(() => {
    useWorkspaceStore.getState().setActive(content.id);
    useAppStore.getState().showPostPanel();
    return () => {
      if (useWorkspaceStore.getState().active === content.id)
        useWorkspaceStore.getState().setActive(null);
      useAppStore.getState().releasePostPanel();
    };
  }, [content.id]);

  const setMode = useCallback(
    (next: WorkspaceMode, focus?: { prefill?: string }) => {
      useWorkspaceStore.getState().setMode(content.id, next);
      // A mode switch brings the post's panel back (if another pane was picked meanwhile).
      useAppStore.getState().showPostPanel();
      if (next === "chat") {
        pendingFocus.current = focus ?? {};
        if (chatInput.current) {
          chatInput.current.focus(focus?.prefill);
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
    chatInput.current?.focus(f.prefill);
  }, [mode]);

  const describe = useCallback(
    (key: string) => (ws.editor ? describeNode(ws.editor, key) : null),
    [ws.editor],
  );

  const chat = usePostChat({
    content,
    version,
    flush: () => session.flush(),
    describe,
    notify,
    onReplyEnd: () => void editor.refresh(),
  });

  const save: SaveControl = {
    dirty: ws.dirty,
    saving: ws.saving,
    error: ws.saveError,
    lastSavedAt: ws.lastSavedAt,
    save: (note) => session.save(note),
    flush: () => session.flush(),
    notify,
  };

  const approve = useCallback(async () => {
    if (!(await session.flush())) return;
    await editor.whenIdle();
    await editor.verify();
    if (!canApprove(editor.getSnapshot())) return;
    const run = () => void editor.approve();
    if (props.guardApproval) props.guardApproval(run);
    else run();
  }, [session, editor, props.guardApproval]);

  const openSchedule = useCallback(async () => {
    if (!(await session.flush())) return;
    props.schedule.open();
  }, [session, props.schedule]);

  // The workspace's own keys (the canvas's are Wecra's): save, approve, schedule.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || useAppStore.getState().lightbox) return;
      if (!inWorkspace(e.target) || !e.metaKey || e.ctrlKey || e.altKey) return;
      const box = e.target instanceof HTMLTextAreaElement;
      if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        e.stopPropagation();
        void (async () => {
          if (!ws.dirty) return notify("Kaydedilecek değişiklik yok.");
          if (await session.save()) notify("Sürüm kaydedildi.");
        })();
      } else if (e.key === "Enter" && !box && !(isTyping(e.target) && !e.shiftKey)) {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) void openSchedule();
        else void approve();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [session, ws.dirty, approve, openSchedule, notify]);

  // Unsaved edits are saved first: approving waits for that save, then checks the hash.
  const approveDisabled = ws.dirty && !ws.saving ? null : approveBlocker(snapshot);
  const chatDisabled =
    changesVersion(snapshot.activity) && snapshot.activity.kind !== "rendering" ? "Bekle…" : null;

  const setLayersOpen = (open: boolean) => useWorkspaceStore.getState().setLayersOpen(open);
  const insets = {
    left: layersOpen ? LAYERS_CARD_INSET + LAYERS_CARD_WIDTH + 16 : 24,
    bottom: DOCK_INSET,
  };

  const dock = (layers: ChatLayers) => (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center">
      <ModeDock
        mode={mode}
        onMode={(m) => setMode(m)}
        edit={
          ed ? <WecraToolbar /> : <span className="flex h-8 items-center px-3 text-fg-3">…</span>
        }
        chat={
          <ChatInput
            ref={chatInput}
            layers={layers}
            working={chat.working}
            disabled={chatDisabled}
            onSend={chat.send}
            onStop={chat.stop}
          />
        }
      />
    </div>
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
      <div className="@container relative min-w-0 flex-1 overflow-hidden" data-canvas-column="">
        {session.source && (
          <WecraEditor source={session.source} onReady={session.attach} insets={insets} />
        )}
        {ed ? (
          <WecraScope ed={ed}>
            <ToolFollower ed={ed} onEdit={() => mode !== "edit" && setMode("edit")} />
            <LayersCard open={layersOpen} onOpenChange={setLayersOpen} />
            <WithChatLayers ed={ed}>{dock}</WithChatLayers>
          </WecraScope>
        ) : (
          dock(NO_LAYERS)
        )}
        <Status state={ws} onRetry={() => version && void session.reopen(version)} />
        <Toasts
          toasts={toasts}
          snapshot={snapshot}
          editor={editor}
          onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))}
        />
      </div>

      <InSlot name="title">
        <TitleBar
          save={save}
          editor={editor}
          snapshot={snapshot}
          status={props.status}
          menu={props.menu ?? []}
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
            {ed && editTab === "design" && (
              <WecraScope ed={ed}>
                <WecraZoomMenu />
              </WecraScope>
            )}
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
          {mode === "chat" ? (
            <ChatPanel chat={chat} onStarter={(text) => chatInput.current?.focus(text)} />
          ) : editTab === "caption" ? (
            <div className="scroll-area min-h-0 flex-1">
              <CaptionPanel snapshot={snapshot} editor={editor} />
            </div>
          ) : ed ? (
            <WecraScope ed={ed}>
              <WecraDesignPanel className="min-h-0 flex-1" />
            </WecraScope>
          ) : (
            <div className="flex flex-1 items-center justify-center gap-2 text-body text-fg-3">
              <Spinner size={12} /> Tasarım paneli hazırlanıyor…
            </div>
          )}
        </div>
      </InSlot>
      {props.dialogs}
    </section>
  );
}

/** Tasarım · Açıklama */
export function EditTabs({ tab, onTab }: { tab: EditTab; onTab(tab: EditTab): void }) {
  return (
    <SegmentedControl<EditTab>
      label="Düzenle paneli"
      value={tab}
      onChange={onTab}
      options={[
        { value: "design", label: "Tasarım" },
        { value: "caption", label: "Açıklama" },
      ]}
    />
  );
}

/** Picking a tool on the canvas (V, T, R … or the toolbar) is editing: the dock shows the tools. */
function ToolFollower({ ed, onEdit }: { ed: EditorController; onEdit(): void }) {
  const tool = useTool(ed.store);
  const last = useRef(tool);
  useEffect(() => {
    if (last.current !== tool) onEdit();
    last.current = tool;
  }, [tool, onEdit]);
  return null;
}

function WithChatLayers({
  ed,
  children,
}: {
  ed: EditorController;
  children: (layers: ChatLayers) => ReactNode;
}) {
  return <>{children(useChatLayers(ed))}</>;
}

/** Opening, importing, or why the document could not be opened. */
function Status({ state, onRetry }: { state: WecraSessionState; onRetry(): void }) {
  if (state.phase === "ready" && state.editor) return null;
  const text =
    state.phase === "error"
      ? state.error
      : state.phase === "importing"
        ? "Kareler Wecra katmanlarına aktarılıyor…"
        : "Tasarım açılıyor…";
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div
        role={state.phase === "error" ? "alert" : "status"}
        className="glass pointer-events-auto flex max-w-[420px] items-center gap-2 rounded-full px-4 py-2 text-body text-fg-2"
      >
        {state.phase === "error" ? (
          <IconWarning size={14} className="shrink-0 text-danger" />
        ) : (
          <Spinner size={12} />
        )}
        <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
        {state.phase === "error" && (
          <button type="button" className="shrink-0 underline" onClick={onRetry}>
            Yeniden dene
          </button>
        )}
      </div>
    </div>
  );
}

function Toasts({
  toasts,
  snapshot,
  editor,
  onDismiss,
}: {
  toasts: Toast[];
  snapshot: EditorSnapshot;
  editor: PostEditor;
  onDismiss(id: number): void;
}) {
  const items = [
    ...toasts,
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
              else onDismiss(t.id);
            }}
          />
        </div>
      ))}
    </div>
  );
}
