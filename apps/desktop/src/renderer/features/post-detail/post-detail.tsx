// The opened post over the centre (Wecra "Post detayı", the Mac's PostDetailOverlay): the
// slide stage on the left, on the right the breadcrumb, title, status, Post / Düzenle /
// Sürümler, "Neyi değiştireyim?" and the actions (Onayla, Zamanla, Sohbette aç).
//
// Keys: Esc deselects the layer or closes, ←/→ change slides (nudge the selected layer on
// Düzenle, ⇧ for 10 px), ⌘Z / ⇧⌘Z undo and redo, ⌘↩ approves, Space quick look,
// ⌫ hides the selected layer or asks to delete the post.
import type { Content, ContentVersion } from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Button,
  cn,
  IconButton,
  SegmentedControl,
  Spinner,
  TagPill,
  TextField,
} from "../../components/ui/controls.tsx";
import { ConfirmDialog } from "../../components/ui/dialog.tsx";
import {
  IconChevronRight,
  IconClose,
  IconEllipsis,
  IconSend,
  IconWarning,
} from "../../components/ui/icons.tsx";
import { MenuButton, type MenuEntry } from "../../components/ui/menu.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { routeKey, useAppStore } from "../../state/app-store.ts";
import { startChat } from "../../state/chat-draft.ts";
import { usePostOpener } from "../../state/post-opener.ts";
import { useAccounts, useBrands, useJobs } from "../../state/studio.tsx";
import { usePostActions } from "../posts/actions.ts";
import {
  cardState,
  deletionBlocker,
  type PostCard,
  pickSchedule,
  STATE_LABEL,
  STATE_TONE,
} from "../posts/board.ts";
import {
  storeContent,
  storeVersion,
  useContent,
  useContentSchedules,
  useFinishedContentJobs,
  usePlans,
  usePublishingStatus,
  useVersion,
} from "../posts/data.ts";
import { dayTime, localDate } from "../posts/dates.ts";
import { type DetailTab, usePostsStore } from "../posts/store.ts";
import {
  CaptionCard,
  LayerEditor,
  MetaRows,
  PublishHistory,
  VersionsList,
} from "./detail-panels.tsx";
import {
  activeVersion,
  approveBlocker,
  canApprove,
  changesVersion,
  type EditorSnapshot,
  editBlocker,
  hasApproval,
  isLocked,
  isViewingCurrent,
  PostEditor,
} from "./editor.ts";
import { defaultScheduleDate, needsApproval, schedulableAccounts } from "./schedule.ts";
import { ScheduleSheet } from "./schedule-sheet.tsx";
import { SlideStage } from "./slide-stage.tsx";

/**
 * Mounted once in the centre column: registers the app's post opener, follows finished jobs
 * and shows the opened post and the delete confirmation.
 */
export function PostDetailLayer() {
  const opened = usePostsStore((s) => s.opened);
  const opener = useCallback(
    (request: { contentId: string; origin?: OpenedOrigin }) =>
      usePostsStore.getState().open(request.contentId, { origin: request.origin ?? null }),
    [],
  );
  usePostOpener(opener);
  // Finished generation / render / publish jobs refresh the posts they touched.
  useFinishedContentJobs();
  // Going somewhere else (sidebar, ⌘N, back) closes the opened post.
  const route = useAppStore((s) => routeKey(s.route));
  const lastRoute = useRef(route);
  useEffect(() => {
    if (lastRoute.current === route) return;
    lastRoute.current = route;
    usePostsStore.getState().close();
  }, [route]);
  return (
    <>
      {opened && <PostDetail key={opened.contentId} contentId={opened.contentId} />}
      <DeletePostDialog />
    </>
  );
}

type OpenedOrigin = { x: number; y: number; width: number; height: number } | null;

function DeletePostDialog() {
  const deleting = usePostsStore((s) => s.deleting);
  const actions = usePostActions();
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      open={!!deleting}
      title={deleting ? `“${deleting.title}” silinsin mi?` : ""}
      message="Post, tüm sürümleri ve render edilmiş görselleriyle birlikte silinir. Bu işlem geri alınamaz."
      confirmLabel="Sil"
      destructive
      busy={busy}
      onClose={() => usePostsStore.getState().askDelete(null)}
      onConfirm={async () => {
        if (!deleting) return;
        setBusy(true);
        await actions.remove(deleting);
        setBusy(false);
        usePostsStore.getState().askDelete(null);
      }}
    />
  );
}

/** The cached copy from the board, while the post itself loads. */
function cachedContent(
  queryClient: ReturnType<typeof useQueryClient>,
  id: string,
): Content | undefined {
  for (const [, list] of queryClient.getQueriesData<Content[]>({
    queryKey: ["posts", "contents"],
  })) {
    const found = list?.find((c) => c.id === id);
    if (found) return found;
  }
  return undefined;
}

function PostDetail({ contentId }: { contentId: string }) {
  const queryClient = useQueryClient();
  const content = useContent(contentId);
  const seed = content.data ?? cachedContent(queryClient, contentId);
  const version = useVersion(contentId, seed?.currentVersion?.version);
  const close = () => usePostsStore.getState().close();

  if (!seed) {
    return (
      <Shell onClose={close} title="Post">
        <div className="flex flex-1 items-center justify-center gap-2 text-body text-fg-2">
          {content.error ? (
            <>
              <IconWarning size={15} className="text-danger" />
              {describeError(content.error)}
            </>
          ) : (
            <>
              <Spinner /> Post yükleniyor…
            </>
          )}
        </div>
      </Shell>
    );
  }
  if (seed.currentVersion && version.isLoading) {
    return (
      <Shell onClose={close} title={seed.title}>
        <div className="flex flex-1 items-center justify-center gap-2 text-body text-fg-2">
          <Spinner /> Sürüm yükleniyor…
        </div>
      </Shell>
    );
  }
  return <Editor content={seed} version={version.data ?? null} />;
}

function Shell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-label={`Açık post: ${title}`}
      className="absolute inset-0 z-30 flex flex-col bg-page animate-fade-in"
    >
      <div className="absolute top-3 right-3 z-10">
        <IconButton icon={<IconClose size={16} />} label="Kapat" shortcut="Esc" onClick={onClose} />
      </div>
      {children}
    </div>
  );
}

function Editor({ content, version }: { content: Content; version: ContentVersion | null }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const { presence } = useJobs();
  const presenceRef = useRef(presence);
  presenceRef.current = presence;
  // The editor lives as long as the opened post (the component's key).
  const [editor] = useState(
    () =>
      new PostEditor(api, content, version, {
        workerOnline: () => presenceRef.current?.online ?? false,
        onChange: (c, v) => {
          storeContent(queryClient, c);
          if (v) storeVersion(queryClient, v);
        },
      }),
  );
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  useEffect(() => {
    editor.activate();
    void editor.load();
    return () => editor.dispose();
  }, [editor]);
  // A job for this post finished elsewhere (chat, AI image, the Mac): follow it.
  useFinishedContentJobs((id) => {
    if (id === content.id) void editor.refresh();
  });
  return <EditorView editor={editor} snapshot={snapshot} />;
}

const TABS: { value: DetailTab; label: string }[] = [
  { value: "post", label: "Post" },
  { value: "edit", label: "Düzenle" },
  { value: "versions", label: "Sürümler" },
];

export function EditorView({ editor, snapshot }: { editor: PostEditor; snapshot: EditorSnapshot }) {
  const tab = usePostsStore((s) => s.opened?.tab ?? "post");
  const setTab = usePostsStore((s) => s.setTab);
  const close = () => usePostsStore.getState().close();
  const actions = usePostActions();
  const brands = useBrands();
  const accounts = useAccounts();
  const publishing = usePublishingStatus();
  const schedules = useContentSchedules(snapshot.content.id);
  const plans = usePlans(snapshot.content.brandId);
  const [instruction, setInstruction] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const { content } = snapshot;
  const brand = brands.data?.find((b) => b.id === content.brandId);
  const planItem =
    plans.data?.flatMap((p) => p.items).find((item) => item.contentId === content.id) ?? null;
  const schedule = pickSchedule(schedules.data ?? []);
  const card: PostCard = {
    id: content.id,
    content,
    version: snapshot.current,
    planItem,
    schedule,
    job: null,
  };
  const state = cardState(card);
  const allAccounts = accounts.data ?? [];
  const targets = schedulableAccounts(allAccounts, content);
  const version = activeVersion(snapshot);
  const viewingCurrent = isViewingCurrent(snapshot);
  const busy = changesVersion(snapshot.activity);
  const blocker = approveBlocker(snapshot);
  const approved = hasApproval(content);
  const locked = isLocked(content);
  const scheduleDate = useMemo(
    () => defaultScheduleDate({ schedule, planItem }),
    // Recomputed when the sheet opens.
    [scheduleOpen],
  );

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  // Notices fade after a while.
  useEffect(() => {
    if (!snapshot.notice) return;
    const t = setTimeout(() => editor.clearNotice(), 5_000);
    return () => clearTimeout(t);
  }, [snapshot.notice, editor]);

  const quickLook = () => actions.quickLook(content, version);
  const openInChat = () => {
    close();
    startChat(
      `“${content.title}” postu (id: ${content.id}${version ? `, v${version.version}` : ""}) için: `,
      content.brandId,
    );
  };
  const askInChat = () => {
    const text = instruction.trim();
    if (!text) return openInChat();
    close();
    startChat(
      `“${content.title}” postunu düzenle (id: ${content.id}${version ? `, v${version.version}` : ""}): ${text}`,
      content.brandId,
    );
  };
  const sendInstruction = async () => {
    const text = instruction.trim();
    if (!text) return;
    setInstruction("");
    const ok = await editor.sendInstruction(text);
    if (!ok) setInstruction((current) => current || text);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target.isContentEditable;
    if (useAppStore.getState().lightbox || scheduleOpen) return;
    const s = editor.getSnapshot();
    const selected = s.selectedLayerId;
    if (event.key === "Escape") {
      if (typing) {
        (target as HTMLInputElement).blur();
        return;
      }
      event.preventDefault();
      // On Düzenle Esc first lets go of the selected layer.
      if (selected && tab === "edit") editor.selectLayer(null);
      else close();
      return;
    }
    if (typing) return;
    const meta = event.metaKey && !event.ctrlKey;
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      void (event.shiftKey ? editor.redo() : editor.undo());
      return;
    }
    if (meta && event.key === "Enter") {
      event.preventDefault();
      void editor.approve();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = event.shiftKey ? 10 : 1;
    if (tab === "edit" && selected && !editBlocker(s)) {
      const nudges: Record<string, [number, number]> = {
        ArrowLeft: [-step, 0],
        ArrowRight: [step, 0],
        ArrowUp: [0, -step],
        ArrowDown: [0, step],
      };
      const delta = nudges[event.key];
      if (delta) {
        event.preventDefault();
        editor.nudge(selected, delta[0], delta[1]);
        return;
      }
      if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        editor.setHidden(selected, true);
        return;
      }
    }
    switch (event.key) {
      case "ArrowLeft":
        event.preventDefault();
        editor.selectSlide(s.slideIndex - 1);
        return;
      case "ArrowRight":
        event.preventDefault();
        editor.selectSlide(s.slideIndex + 1);
        return;
      case " ":
        event.preventDefault();
        quickLook();
        return;
      case "Backspace":
      case "Delete":
        event.preventDefault();
        actions.askDelete(content);
        return;
    }
  };

  const more: MenuEntry[] = [
    {
      id: "quicklook",
      label: "Hızlı bakış",
      shortcut: "␣",
      disabled: !version?.slides.some((s) => s.renderedAssetId),
      onSelect: quickLook,
    },
    {
      id: "caption",
      label: "Açıklamayı kopyala",
      disabled: !content.caption.trim(),
      onSelect: () => void actions.copyCaption(content),
    },
    { id: "chat", label: "Sohbette aç", onSelect: openInChat },
    { type: "separator" },
    {
      id: "duplicate",
      label: "Çoğalt",
      onSelect: async () => {
        const copy = await actions.duplicate(content);
        if (copy) usePostsStore.getState().open(copy.id);
      },
    },
    {
      id: "delete",
      label: "Sil…",
      danger: true,
      disabled: !!deletionBlocker(content),
      ...(deletionBlocker(content) ? { detail: deletionBlocker(content) ?? "" } : {}),
      onSelect: () => actions.askDelete(content),
    },
  ];

  const statusText =
    schedule && (state === "scheduled" || state === "publishing")
      ? `${STATE_LABEL[state]} · ${dayTime(new Date(schedule.scheduledAt))}`
      : schedule && state === "published"
        ? `${STATE_LABEL[state]} · ${dayTime(new Date(schedule.scheduledAt))}`
        : STATE_LABEL[state];

  // Primary: approve and schedule (or schedule, move the schedule, retry a failed one).
  const approvalFirst = needsApproval(content);
  const scheduleLabel = approvalFirst
    ? "Onayla ve zamanla"
    : content.status === "scheduled"
      ? "Zamanlamayı değiştir"
      : content.status === "failed"
        ? "Yeniden zamanla"
        : "Zamanla";
  const scheduleDisabledReason = locked
    ? "Yayınlanmış ya da yayınlanan post zamanlanamaz."
    : targets.length === 0
      ? "Bu postun platformlarında bağlı hesap yok; Ayarlar'dan hesap bağla."
      : busy
        ? "Değişiklik render edilirken zamanlanamaz."
        : approvalFirst && blocker
          ? blocker
          : null;

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`Açık post: ${content.title}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="absolute inset-0 z-30 flex bg-page outline-none animate-fade-in"
    >
      <div className="flex min-h-0 min-w-0 flex-1 gap-10 px-10 py-7">
        <SlideStage
          snapshot={snapshot}
          editor={editor}
          editing={tab === "edit"}
          brandName={brand?.name}
          onQuickLook={quickLook}
        />
        <div className="flex min-h-0 max-w-[560px] min-w-[320px] flex-1 flex-col">
          <div className="flex shrink-0 items-start gap-2">
            <nav
              aria-label="Konum"
              className="flex min-w-0 flex-1 items-center gap-1 pt-1.5 text-footnote text-fg-3"
            >
              <button type="button" className="hover:text-fg-2" onClick={close}>
                Postlar
              </button>
              <IconChevronRight size={11} className="shrink-0" />
              <span className="truncate">{brand?.name ?? "Marka"}</span>
              {planItem?.pillar && (
                <>
                  <IconChevronRight size={11} className="shrink-0" />
                  <span className="truncate">{planItem.pillar}</span>
                </>
              )}
            </nav>
            <MenuButton entries={more} placement="bottom-end" label="Post işlemleri" width={220}>
              {({ ref, onClick, onKeyDown: key, open, ...aria }) => (
                <IconButton
                  ref={ref}
                  icon={<IconEllipsis size={16} strokeWidth={1.5} />}
                  label="Diğer işlemler"
                  selected={open}
                  onClick={onClick}
                  onKeyDown={key}
                  {...aria}
                />
              )}
            </MenuButton>
            <IconButton
              icon={<IconClose size={16} strokeWidth={1.5} />}
              label="Kapat"
              shortcut="Esc"
              onClick={close}
            />
          </div>
          <h1 className="selectable mt-2 text-title font-semibold text-fg [overflow-wrap:anywhere]">
            {content.title}
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <TagPill tone={STATE_TONE[state]}>{statusText}</TagPill>
            {version && (
              <TagPill tone={viewingCurrent ? "neutral" : "warning"}>
                v{version.version}
                {!viewingCurrent && " · eski sürüm"}
              </TagPill>
            )}
            {snapshot.hashState === "mismatch" && !approved && (
              <TagPill tone="danger">Sürüm doğrulanamadı</TagPill>
            )}
          </div>
          <SegmentedControl<DetailTab>
            className="mt-4 self-start"
            label="Post bölümleri"
            value={tab}
            onChange={setTab}
            options={TABS.map((t) =>
              t.value === "versions" && snapshot.summaries.length > 0
                ? { ...t, count: snapshot.summaries.length }
                : t,
            )}
          />
          <div className="scroll-area -mr-3 mt-4 min-h-0 flex-1 pr-3">
            {tab === "post" && (
              <div className="flex flex-col gap-4 pb-2">
                <CaptionCard snapshot={snapshot} editor={editor} />
                <MetaRows
                  snapshot={snapshot}
                  accounts={allAccounts}
                  brand={brand}
                  schedule={schedule}
                  planDate={planItem?.date ? localDate(planItem.date) : null}
                />
                <PublishHistory
                  schedules={schedules.data ?? []}
                  accounts={allAccounts}
                  mode={publishing.data?.mode ?? "local"}
                />
              </div>
            )}
            {tab === "edit" && <LayerEditor snapshot={snapshot} editor={editor} />}
            {tab === "versions" && <VersionsList snapshot={snapshot} editor={editor} />}
          </div>

          {(snapshot.error || snapshot.notice) && (
            <div
              role={snapshot.error ? "alert" : "status"}
              className={cn(
                "mt-3 flex shrink-0 items-start gap-2 rounded-[10px] px-3 py-2 text-body",
                snapshot.error ? "bg-danger/10 text-fg" : "bg-control text-fg-2",
              )}
            >
              {snapshot.error && <IconWarning size={14} className="mt-0.5 shrink-0 text-danger" />}
              <span className="selectable min-w-0 flex-1">{snapshot.error ?? snapshot.notice}</span>
              <IconButton
                icon={<IconClose size={12} />}
                label="Kapat"
                size={24}
                tooltip={false}
                onClick={() => (snapshot.error ? editor.clearError() : editor.clearNotice())}
              />
            </div>
          )}

          <div className="mt-3 flex shrink-0 items-center gap-2">
            <TextField
              aria-label="AI'dan değişiklik iste"
              className="min-w-0 flex-1"
              placeholder={
                snapshot.activity.kind === "revising"
                  ? "AI düzenliyor…"
                  : viewingCurrent
                    ? "Neyi değiştireyim?"
                    : "Eski sürüm: önce geri yükle"
              }
              disabled={snapshot.activity.kind === "revising" || locked}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (e.metaKey) askInChat();
                  else void sendInstruction();
                }
              }}
            />
            <IconButton
              icon={<IconSend size={14} strokeWidth={1.75} />}
              label="AI ile düzenle (yeni sürüm)"
              shortcut="↩"
              disabled={!instruction.trim() || busy || !viewingCurrent || locked}
              onClick={() => void sendInstruction()}
            />
            <Button variant="ghost" onClick={askInChat}>
              Sohbette sor
            </Button>
          </div>

          <div className="mt-3 flex shrink-0 flex-wrap items-center gap-2 pb-1">
            <span title={scheduleDisabledReason ?? undefined}>
              <Button
                variant="primary"
                disabled={!!scheduleDisabledReason}
                onClick={() => setScheduleOpen(true)}
              >
                {scheduleLabel}
              </Button>
            </span>
            {approvalFirst && (
              <span title={blocker ?? "Bu sürümü onayla (⌘↩)"}>
                <Button
                  variant="secondary"
                  disabled={!canApprove(snapshot)}
                  onClick={() => void editor.approve()}
                >
                  {snapshot.approving ? "Onaylanıyor…" : "Onayla"}
                </Button>
              </span>
            )}
            {tab !== "edit" && content.type !== "reel" && !locked && (
              <Button variant="secondary" onClick={() => setTab("edit")}>
                Düzenle
              </Button>
            )}
            <Button variant="ghost" onClick={openInChat}>
              Sohbette aç
            </Button>
          </div>
        </div>
      </div>
      <ScheduleSheet
        open={scheduleOpen}
        content={content}
        slideHtml={snapshot.current?.slides[0]?.html ?? null}
        hash={snapshot.approvableHash}
        accounts={allAccounts}
        initialDate={scheduleDate}
        onClose={() => {
          setScheduleOpen(false);
          root.current?.focus({ preventScroll: true });
        }}
        onDone={(fresh) => {
          editor.replaceContent(fresh);
          void schedules.refetch();
        }}
      />
    </div>
  );
}
