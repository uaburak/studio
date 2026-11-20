// The open post, inside the app's layout (Wecra's "Post Editor" as an app mode, not a screen):
// the centre column becomes Wecra's own editor — its engine draws the slides as frames and does
// everything Wecra does there (selection, handles, guides, auto layout, constraints, text, images,
// effects, its keys, clipboard and context menu) — with one floating dock at its bottom (Wecra's
// tools, or the post's message box, with the Sohbet / Düzenle switch). The sidebar keeps its
// navigation and shows Wecra's Layers under it, where the conversations are otherwise. The right
// panel becomes the post's panel (Düzenle: Wecra's Design panel, and the caption; Sohbet: the
// post's conversation) and the top bar's title area shows the post (title, state, versions, save
// state, Onayla, Zamanla). The top bar stays the app's, and so does back (‹ › at the sidebar's
// top-bar edge, ⌘[): the post has no back button of its own.
//
// The document is Wecra's (wecra/session.ts): a version saved from the canvas opens its saved
// document; any other version (the AI's) is imported from its HTML once. An edit is kept as the
// post's draft on this Mac (no version, approval untouched); ⌘S, Onayla, Zamanla, a chat message
// and leaving the post with changes create a version (the slides exported by Wecra's engine).
// The canvas opens read only when editing would cost something or can't be done (edit-lock.ts):
// approved / scheduled (Düzenle warns first), publishing, published, an older version, an AI run.
// A new version arriving while the canvas has unsaved edits asks first (E4).
import type { Content } from "@studio/contract";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { EditorController } from "@/editor/controller";
import { useTool } from "@/engine/hooks";
import {
  Button,
  cn,
  IconButton,
  SegmentedControl,
  Spinner,
  type TagTone,
} from "../../components/ui/controls.tsx";
import { ConfirmDialog } from "../../components/ui/dialog.tsx";
import { IconClose, IconWarning } from "../../components/ui/icons.tsx";
import type { MenuEntry } from "../../components/ui/menu.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { registerAppFlush } from "../../lib/app-flush.ts";
import { bridge } from "../../lib/bridge.ts";
import { chatMentionCandidates } from "../../lib/composer.ts";
import { noteCanvasNavKey } from "../../lib/nav-gestures.ts";
import { useAppStore } from "../../state/app-store.ts";
import { useJobsSnapshot } from "../../state/studio.tsx";
import { useMentionCandidates } from "../mentions/mentions-data.ts";
import type { RevokeControl } from "../post-detail/approval-heart.tsx";
import {
  activeVersion,
  approveBlocker,
  canApprove,
  changesVersion,
  type EditorSnapshot,
  isViewingCurrent,
  type PostEditor,
} from "../post-detail/editor.ts";
import { usePostChat } from "./chat.ts";
import { type RenderKitState, useRenderKitState } from "./data.ts";
import { type EditLock, editLock, unlockWarning, versionJobRunning } from "./edit-lock.ts";
import { InSlot } from "./slots.tsx";
import { AssetsPanel, type CanvasAssetsContext, useCanvasDrop } from "./ui/canvas-assets.tsx";
import { CaptionPanel } from "./ui/caption-panel.tsx";
import { ChatHeader, ChatPanel } from "./ui/chat-panel.tsx";
import { CanvasChecks, useCheckFailures } from "./ui/checks-tab.tsx";
import { ImportReport } from "./ui/import-report.tsx";
import { ChatInput, type ChatInputHandle, ModeDock } from "./ui/mode-dock.tsx";
import { SidebarLayers } from "./ui/sidebar-layers.tsx";
import { type SaveControl, TitleBar } from "./ui/title-bar.tsx";
import { rememberAsset } from "./wecra/assets.ts";
import { prepareBrandStyles } from "./wecra/brand-styles.ts";
import { installStudioFonts } from "./wecra/fonts.ts";
import {
  WecraDesignPanel,
  WecraEditor,
  WecraScope,
  WecraToolbar,
  WecraZoomMenu,
} from "./wecra/host.tsx";
import {
  missingFontMessage,
  useCanvasMissingFonts,
  versionMissingFonts,
} from "./wecra/missing-fonts.ts";
import {
  attachSafeAreas,
  initSafeAreas,
  postPreset,
  safeAreasByDefault,
} from "./wecra/safe-areas.ts";
import { type ChatLayers, describeNode, NO_LAYERS, useChatLayers } from "./wecra/scope.ts";
import { type DraftNotice, WecraPostSession, type WecraSessionState } from "./wecra/session.ts";
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
  /** "Onayı geri al": the heart next to the title bar's "Onaylandı". */
  revoke?: RevokeControl | null;
  /** Back to where the post was opened from (the app's back does it; kept for the shell). */
  onClose(): void;
  onPreview(): void;
  /**
   * Runs the approval through the checks of `version` (they may be waited for, and ask first:
   * `approve(true)` then sends `acknowledgeChecks`); default: approve at once.
   */
  guardApproval?: (
    approve: (acknowledgeChecks: boolean) => void,
    version?: { version: number; id?: string | null } | null,
  ) => void | Promise<void>;
  /** The approve guard waits for the checks ("Kontroller çalışıyor…"). */
  checksWaiting?: boolean;
  /** The approve guard's question and the schedule sheet. */
  dialogs?: ReactNode;
  /** The post's pending schedules ("Instagram @hesap · 18 Kas 10:00"), for Düzenle's warning. */
  scheduledTargets?: readonly string[];
  /** "Kopyasını oluştur" for a published post (null: not offered). */
  onDuplicate?: (() => void) | null;
  /** Pause after an edit before the draft is written (tests; 0: only when asked). */
  draftMs?: number;
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

/** The canvas or Wecra's layers: where ⌘[ / ⌘] are Wecra's (send backward / bring forward). */
export const inCanvas = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest('[data-wecra-region="canvas"],[data-wecra-region="layers"]');

const isNavKey = (e: KeyboardEvent) =>
  e.metaKey &&
  !e.ctrlKey &&
  !e.altKey &&
  (e.code === "BracketLeft" || e.code === "BracketRight" || e.key === "[" || e.key === "]");

/**
 * ⇧⌘K (Wecra's "Place image…") and ⇧⌘P (pixel preview) in the workspace; elsewhere they are the
 * menu's Git → Takvim and Git → Profil.
 */
const isWecraGoKey = (e: KeyboardEvent) =>
  e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && (e.code === "KeyK" || e.code === "KeyP");

/** The dock's height and margin: zoom to fit keeps the slides above it. */
const DOCK_INSET = 68;
/** What zoom to fit keeps clear of: a margin on the left, the dock at the bottom. */
const CANVAS_INSETS = { left: 24, bottom: DOCK_INSET };

export function PostWorkspace(props: WorkspaceProps) {
  const { editor, snapshot } = props;
  const content: Content = snapshot.content;
  const api = useApi();
  // The brand's kit (fonts, colours, logos) before anything is imported: never the neutral
  // stand-in while the profile loads (E10).
  const kitState = useRenderKitState(content.brandId);
  const kit = kitState.kit;
  const kitReady = kitState.status === "ready";
  const version = activeVersion(snapshot);
  const mode = useWorkspaceStore((s) => modeOf(s, content.id));
  const editTab = useWorkspaceStore((s) => s.editTab);
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
        drafts: bridge().drafts ?? null,
        report: (message) => useAppStore.getState().showToast({ message, tone: "danger" }),
        // The brand's colours and type as the document's styles, its layers linked to them.
        prepare: (ed) => prepareBrandStyles(ed, latest.current.kit),
        ...(props.draftMs !== undefined ? { draftMs: props.draftMs } : {}),
      }),
  );
  const ws = useSyncExternalStore(session.subscribe, session.getState);
  const ed = ws.editor;
  // Safe areas over the slides (the checks' insets): on by default for stories and Reels.
  const firstSlide = version?.slides[0];
  const safeArea = postPreset(
    content.type,
    content.targetPlatforms,
    firstSlide ? { width: firstSlide.width, height: firstSlide.height } : null,
  ).safeArea;
  const safeKey = JSON.stringify(safeArea);
  useEffect(() => {
    if (!ed) return;
    initSafeAreas(ed, safeAreasByDefault(content.type));
    return attachSafeAreas(ed, JSON.parse(safeKey));
  }, [ed, content.type, safeKey]);
  // Image slots, Medya drops and the brand's logo (ui/canvas-assets.tsx).
  const assets: CanvasAssetsContext | null = useMemo(
    () =>
      ed
        ? {
            ed,
            brandId: content.brandId,
            kit,
            readOnly: ws.readOnly,
            notify,
            rememberAsset: (assetId, bytes) =>
              void rememberAsset(session.images, assetId, bytes).catch(() => {}),
          }
        : null,
    [ed, content.brandId, kit, ws.readOnly, notify, session],
  );
  const drop = useCanvasDrop(assets);
  // The import report belongs to the version imported (not to the versions saved from it).
  const [reportOf, setReportOf] = useState<number | null>(null);
  useEffect(() => {
    if (ws.importReport.length) setReportOf(ws.version);
    // Only when a new report arrives (an import), not when the version moves on.
  }, [ws.importReport]);
  useEffect(() => {
    session.activate();
    return () => {
      // Leaving the post (the app's back, the sidebar): the draft is written and unsaved edits
      // become a version — read from the editor now, before it goes (E14).
      void session.close();
      session.dispose();
    };
  }, [session]);
  // The window closing, ⌘Q (asked by the main process) and a reload write the draft first.
  useEffect(
    () =>
      registerAppFlush({
        flush: () => session.writeDraft(),
        flushSync: () => session.saveDraftSync(),
      }),
    [session],
  );
  // The brand's fonts for Wecra's text engine, before a document opens.
  const fontsFor = useRef<object | null>(null);
  if (kitReady && fontsFor.current !== kit) {
    fontsFor.current = kit;
    installStudioFonts(kit);
  }

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
  // `@` in the dock: the chat's files, the brand's products and posts (as in the main composer).
  const mentionEntities = useMentionCandidates(content.brandId);
  const chatAliases = chat.snapshot?.state?.aliases;
  const mentions = useMemo(
    () => chatMentionCandidates(chatAliases ?? [], mentionEntities),
    [chatAliases, mentionEntities],
  );

  // Read only (E3): approved / scheduled until Düzenle is confirmed, publishing, published, an
  // older version, an AI run (the Sohbet answering, a revision job) that may make a version.
  const approvalKey = `${content.status}:${content.approval?.approvedAt ?? ""}`;
  const [unlockedFor, setUnlockedFor] = useState<string | null>(null);
  const [unlockAsk, setUnlockAsk] = useState<{ openDraft: boolean } | null>(null);
  const { jobs } = useJobsSnapshot();
  const jobRunning = useMemo(() => versionJobRunning(jobs, content.id), [jobs, content.id]);
  const lock = editLock(snapshot, {
    chatWorking: chat.working,
    jobRunning,
    unlocked: unlockedFor === approvalKey,
  });
  const readOnly = lock !== null;
  // Before the version opens (the session decides about the post's draft with it).
  useEffect(() => {
    session.setReadOnly(readOnly);
  }, [session, readOnly]);
  // The version shown is the document on the canvas (an older one read only: E19) — once the
  // brand's kit is here (an import with the neutral kit would bake its fonts and colours in: E10).
  useEffect(() => {
    if (version && kitReady) void session.open(version);
  }, [session, version, kitReady]);
  const unlock = useCallback(
    (openDraft: boolean) => {
      setUnlockedFor(approvalKey);
      setUnlockAsk(null);
      session.setReadOnly(false);
      if (openDraft) void session.openDraft();
    },
    [approvalKey, session],
  );

  // A used font Wecra doesn't have (E9): unsaved edits can't become a version, a version drawn
  // without it isn't approved.
  const canvasMissing = useCanvasMissingFonts(ed);
  const versionMissing = useMemo(() => versionMissingFonts(snapshot.current), [snapshot.current]);
  const fontBlocker = missingFontMessage(ws.dirty ? canvasMissing : versionMissing);

  const save: SaveControl = {
    dirty: ws.dirty,
    saving: ws.saving,
    error: ws.saveError,
    lastSavedAt: ws.lastSavedAt,
    draftSavedAt: ws.draftSavedAt,
    ready: ws.phase === "ready" && !!ws.editor && !ws.readOnly,
    blocker: ws.blocker ?? (ws.dirty ? fontBlocker : null),
    save: (note) => session.save(note),
    flush: () => session.flush(),
    notify,
  };

  // Onayla / ⌘↩: unsaved edits become a version first, then the approval goes through that exact
  // version's checks (E7). One at a time: ⌘↩ again while it saves or waits does nothing.
  const approving = useRef(false);
  const approve = useCallback(async () => {
    if (approving.current) return;
    approving.current = true;
    try {
      if (!(await session.flush())) return;
      await editor.whenIdle();
      await editor.verify();
      const s = editor.getSnapshot();
      if (!canApprove(s)) return;
      // Its renders were drawn without a font it uses (E9).
      const fonts = missingFontMessage(versionMissingFonts(s.current));
      if (fonts) return notify(fonts, "error");
      const run = (acknowledgeChecks: boolean) => void editor.approve({ acknowledgeChecks });
      if (props.guardApproval) await props.guardApproval(run, s.current);
      else run(false);
    } finally {
      approving.current = false;
    }
  }, [session, editor, props.guardApproval, notify]);

  const openSchedule = useCallback(async () => {
    if (!(await session.flush())) return;
    // Zamanla approves first: not a version drawn without a font it uses (E9).
    const fonts = props.approvalFirst
      ? missingFontMessage(versionMissingFonts(editor.getSnapshot().current))
      : null;
    if (fonts) return notify(fonts, "error");
    props.schedule.open();
  }, [session, editor, props.schedule, props.approvalFirst, notify]);

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
          const s = session.getState();
          if (!s.dirty) return notify("Kaydedilecek değişiklik yok.");
          const before = s.lastSavedAt;
          if (await session.save())
            notify(
              session.getState().lastSavedAt !== before
                ? "Sürüm kaydedildi."
                : "Kaydedilecek değişiklik yok.",
            );
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
  }, [session, approve, openSchedule, notify]);

  // ⌘[ / ⌘] on the canvas (or Wecra's layers) are Wecra's — send backward / bring forward —
  // never the app's back / forward, even when Wecra had nothing to move (E8). So are ⇧⌘K / ⇧⌘P in
  // the workspace (place image, pixel preview), never the menu's Git → Takvim / Postlar. After Wecra's own
  // handler (the window's, bubbling) the key is marked used, so the menu's Geri / İleri skip it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const navKey = isNavKey(e) && inCanvas(e.target);
      const placeKey = isWecraGoKey(e) && inWorkspace(e.target) && !isTyping(e.target);
      if (!navKey && !placeKey) return;
      const after = (ev: KeyboardEvent) => {
        window.removeEventListener("keydown", after);
        if (ev !== e) return;
        if (!ev.defaultPrevented) ev.preventDefault();
        noteCanvasNavKey(ev);
      };
      window.addEventListener("keydown", after);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Unsaved edits are saved first: approving waits for that save, then checks the hash.
  const approveDisabled = props.checksWaiting
    ? "Kontroller çalışıyor…"
    : ws.incoming
      ? "Önce yeni gelen sürüm için seç."
      : ws.dirty && !ws.saving && !ws.readOnly
        ? (ws.blocker ?? fontBlocker)
        : (approveBlocker(snapshot) ?? fontBlocker);
  const failures = useCheckFailures(content, version?.version ?? null);
  const chatDisabled =
    changesVersion(snapshot.activity) && snapshot.activity.kind !== "rendering" ? "Bekle…" : null;

  const dock = (layers: ChatLayers) => (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center">
      <ModeDock
        mode={mode}
        onMode={(m) => setMode(m)}
        edit={
          ed && !ws.readOnly ? (
            <WecraToolbar />
          ) : (
            <span className="flex h-8 items-center px-3 text-fg-3">{ed ? "Salt okunur" : "…"}</span>
          )
        }
        chat={
          <ChatInput
            ref={chatInput}
            layers={layers}
            working={chat.working}
            disabled={chatDisabled}
            mentions={mentions}
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
      <div
        className="@container relative min-w-0 flex-1 overflow-hidden"
        data-canvas-column=""
        // A two-finger sideways pan here moves the canvas, never the app's history (E8).
        data-no-swipe=""
        data-read-only={ws.readOnly ? "" : undefined}
        {...drop}
      >
        {session.source && (
          <WecraEditor source={session.source} onReady={session.attach} insets={CANVAS_INSETS} />
        )}
        {ws.fallback && <FallbackView fallback={ws.fallback} />}
        <CanvasNotices
          lock={lock}
          draft={ws.draft}
          incoming={ws.incoming}
          saving={ws.saving}
          canDuplicate={!!props.onDuplicate}
          onUnlock={() => setUnlockAsk({ openDraft: false })}
          onRestoreShown={() => void editor.restoreDisplayed()}
          onShowCurrent={() => void editor.showCurrent()}
          onDuplicate={() => props.onDuplicate?.()}
          onDiscardDraft={() => void session.discardDraft()}
          onDismissDraft={() => session.dismissDraftNotice()}
          onOpenDraft={() =>
            lock?.kind === "approval" ? setUnlockAsk({ openDraft: true }) : void session.openDraft()
          }
          onDeleteDraft={() => void session.deleteDraft()}
          onIncoming={(choice) => void session.resolveIncoming(choice)}
        />
        {ed ? (
          <WecraScope ed={ed}>
            <ToolFollower ed={ed} onEdit={() => mode !== "edit" && setMode("edit")} />
            <WithChatLayers ed={ed}>{dock}</WithChatLayers>
          </WecraScope>
        ) : (
          dock(NO_LAYERS)
        )}
        <Status state={ws} kit={kitState} onRetry={() => version && void session.reopen(version)} />
        {ws.phase === "ready" && reportOf !== null && ws.version === reportOf && version && (
          <ImportReport report={ws.importReport} versionKey={version.id} />
        )}
        <ConfirmDialog
          open={unlockAsk !== null && lock?.kind === "approval"}
          title="Düzenlemeye açılsın mı?"
          message={
            lock?.kind === "approval"
              ? unlockWarning(lock.status, props.scheduledTargets ?? [])
              : ""
          }
          confirmLabel="Düzenle"
          onClose={() => setUnlockAsk(null)}
          onConfirm={() => unlock(unlockAsk?.openDraft === true)}
        />
        <Toasts
          toasts={toasts}
          snapshot={snapshot}
          editor={editor}
          onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))}
        />
      </div>

      <InSlot name="sidebar">
        <SidebarLayers ed={ed} />
      </InSlot>
      <InSlot name="title">
        <TitleBar
          save={save}
          editor={editor}
          snapshot={snapshot}
          status={props.status}
          revoke={props.revoke ?? null}
          menu={props.menu ?? []}
          onApprove={() => void approve()}
          onSchedule={() => void openSchedule()}
          approve={{
            visible: props.approvalFirst,
            disabled: approveDisabled,
            busy: snapshot.approving || !!props.checksWaiting,
            ...(props.checksWaiting ? { busyLabel: "Kontroller çalışıyor…" } : {}),
          }}
          schedule={{ label: props.schedule.label, disabled: props.schedule.disabled }}
          versionsOpen={versionsOpen}
          setVersionsOpen={setVersionsOpen}
        />
      </InSlot>
      <InSlot name="panel-header">
        {mode === "edit" ? (
          <>
            <EditTabs
              tab={editTab}
              failures={failures}
              onTab={(t) => useWorkspaceStore.getState().setEditTab(t)}
            />
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
          ) : editTab === "checks" ? (
            <div className="scroll-area min-h-0 flex-1">
              <CanvasChecks
                content={content}
                version={version}
                isCurrent={isViewingCurrent(snapshot)}
                ed={ed}
                waiting={!!props.checksWaiting}
                onTab={(t) => useWorkspaceStore.getState().setEditTab(t)}
              />
            </div>
          ) : editTab === "caption" ? (
            <div className="scroll-area min-h-0 flex-1">
              <CaptionPanel snapshot={snapshot} editor={editor} />
            </div>
          ) : ed ? (
            <WecraScope ed={ed}>
              {assets && <AssetsPanel {...assets} />}
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

/** Tasarım · Açıklama · Kontroller (with the shown version's failures, E6) */
export function EditTabs({
  tab,
  onTab,
  failures = 0,
}: {
  tab: EditTab;
  onTab(tab: EditTab): void;
  /** Failed checks of the version shown (a red count on Kontroller). */
  failures?: number;
}) {
  return (
    <SegmentedControl<EditTab>
      label="Düzenle paneli"
      value={tab}
      onChange={onTab}
      options={[
        { value: "design", label: "Tasarım" },
        { value: "caption", label: "Açıklama" },
        {
          value: "checks",
          label: "Kontroller",
          ...(failures > 0 ? { count: failures, countTone: "danger" as const } : {}),
        },
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

/** The brand's kit loading, opening, importing, or why the document could not be opened. */
function Status({
  state,
  kit,
  onRetry,
}: {
  state: WecraSessionState;
  kit: Pick<RenderKitState, "status" | "error" | "retry">;
  onRetry(): void;
}) {
  if (
    kit.status === "ready" &&
    ((state.phase === "ready" && state.editor) || state.phase === "fallback")
  )
    return null;
  const error = kit.status === "error" || (kit.status === "ready" && state.phase === "error");
  const text =
    kit.status === "error"
      ? `Marka kiti okunamadı; tasarım marka fontları ve renkleri olmadan açılmaz. (${describeError(kit.error)})`
      : kit.status === "loading"
        ? "Marka kiti yükleniyor…"
        : state.phase === "error"
          ? state.error
          : state.phase === "importing"
            ? "Kareler Wecra katmanlarına aktarılıyor…"
            : "Tasarım açılıyor…";
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div
        role={error ? "alert" : "status"}
        className="glass pointer-events-auto flex max-w-[420px] items-center gap-2 rounded-full px-4 py-2 text-body text-fg-2"
      >
        {error ? <IconWarning size={14} className="shrink-0 text-danger" /> : <Spinner size={12} />}
        <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
        {error && (
          <button
            type="button"
            className="shrink-0 underline"
            onClick={kit.status === "error" ? kit.retry : onRetry}
          >
            Yeniden dene
          </button>
        )}
      </div>
    </div>
  );
}

const formatTime = (ms: number) =>
  new Date(ms).toLocaleString("tr-TR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** One line over the canvas: what it says, and its buttons. */
function Notice({
  children,
  actions,
  tone = "notice",
  label,
}: {
  children: ReactNode;
  actions?: ReactNode;
  tone?: "notice" | "warning";
  label: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className="glass pointer-events-auto flex max-w-[560px] items-center gap-2 rounded-full py-1.5 pr-1.5 pl-4 text-body text-fg-2"
    >
      {tone === "warning" && <IconWarning size={14} className="shrink-0 text-warning" />}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</span>
      {actions && <span className="flex shrink-0 items-center gap-1">{actions}</span>}
    </div>
  );
}

/**
 * Over the canvas: why it is read only (and what unlocks it), the post's draft (restored, or
 * offered), a new version that arrived while the canvas had unsaved edits.
 */
function CanvasNotices({
  lock,
  draft,
  incoming,
  saving,
  canDuplicate,
  onUnlock,
  onRestoreShown,
  onShowCurrent,
  onDuplicate,
  onDiscardDraft,
  onDismissDraft,
  onOpenDraft,
  onDeleteDraft,
  onIncoming,
}: {
  lock: EditLock | null;
  draft: DraftNotice | null;
  incoming: { version: number } | null;
  saving: boolean;
  canDuplicate: boolean;
  onUnlock(): void;
  onRestoreShown(): void;
  onShowCurrent(): void;
  onDuplicate(): void;
  onDiscardDraft(): void;
  onDismissDraft(): void;
  onOpenDraft(): void;
  onDeleteDraft(): void;
  onIncoming(choice: "mine" | "theirs"): void;
}) {
  // The restored note fades on its own (Vazgeç stays a while).
  const dismiss = useRef(onDismissDraft);
  dismiss.current = onDismissDraft;
  useEffect(() => {
    if (draft?.kind !== "restored") return;
    const t = setTimeout(() => dismiss.current(), 12_000);
    return () => clearTimeout(t);
  }, [draft]);
  const lockActions =
    lock?.kind === "approval" ? (
      <Button size="sm" variant="secondary" onClick={onUnlock}>
        Düzenle
      </Button>
    ) : lock?.kind === "old-version" ? (
      <>
        <Button size="sm" variant="secondary" onClick={onRestoreShown}>
          Bu sürüme dön
        </Button>
        {lock.current !== null && (
          <Button size="sm" variant="ghost" onClick={onShowCurrent}>
            Güncel sürüm
          </Button>
        )}
      </>
    ) : lock?.kind === "published" && canDuplicate ? (
      <Button size="sm" variant="secondary" onClick={onDuplicate}>
        Kopyasını oluştur
      </Button>
    ) : null;
  // A draft can be opened once nothing but the approval locks the canvas.
  const draftOpenable = !lock || lock.kind === "approval";
  if (!lock && !draft && !incoming) return null;
  return (
    <div
      data-canvas-notices=""
      className="pointer-events-none absolute inset-x-3 top-3 z-20 flex flex-col items-center gap-2"
    >
      {incoming && (
        <Notice
          label="Yeni sürüm geldi"
          tone="warning"
          actions={
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={saving}
                onClick={() => onIncoming("mine")}
              >
                Benimkini kaydet
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onIncoming("theirs")}>
                Yeni sürümü aç
              </Button>
            </>
          }
        >
          Yeni sürüm geldi (v{incoming.version}); tuvaldeki değişikliklerin henüz sürüm değil.
        </Notice>
      )}
      {lock && (
        <Notice label="Salt okunur" actions={lockActions}>
          {lock.message}
        </Notice>
      )}
      {draft?.kind === "restored" && (
        <Notice
          label="Taslak"
          actions={
            <Button size="sm" variant="ghost" onClick={onDiscardDraft}>
              Vazgeç
            </Button>
          }
        >
          Kaydedilmemiş değişiklikler geri yüklendi.
        </Notice>
      )}
      {draft?.kind === "offer" && (
        <Notice
          label="Taslak"
          tone="warning"
          actions={
            <>
              {lock?.kind !== "published" && (
                <span title={draftOpenable ? undefined : (lock?.message ?? undefined)}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!draftOpenable}
                    onClick={onOpenDraft}
                  >
                    Taslağı aç
                  </Button>
                </span>
              )}
              <Button size="sm" variant="ghost" onClick={onDeleteDraft}>
                Sil
              </Button>
            </>
          }
        >
          {draft.reason === "older"
            ? `v${draft.baseVersion} üzerinde kaydedilmemiş değişikliklerin var (${formatTime(draft.savedAt)}).`
            : `Bu postta kaydedilmemiş değişikliklerin var (${formatTime(draft.savedAt)}).`}
        </Notice>
      )}
    </div>
  );
}

/** The version's renders, read only, when its Wecra document can't be opened (E19). */
function FallbackView({ fallback }: { fallback: NonNullable<WecraSessionState["fallback"]> }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center gap-4 overflow-auto px-6 pt-16 pb-24">
      <p role="alert" className="max-w-[560px] text-center text-body text-fg-2">
        <IconWarning size={14} className="mr-1.5 inline text-warning" />
        {fallback.message}
      </p>
      <div className="flex flex-wrap justify-center gap-4">
        {fallback.images.map((img, i) => (
          <img
            key={img.src}
            src={img.src}
            alt={`Kare ${i + 1}`}
            width={img.width}
            height={img.height}
            className="h-auto max-h-[70vh] w-auto max-w-[min(420px,80vw)] rounded-[10px] shadow-sm"
          />
        ))}
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
