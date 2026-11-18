// "Yorumlar" (N16): comments under the current brand's published Instagram and Facebook posts.
// Filter by post and by "Okunmamış" / "Yanıtlanmamış"; open a thread to read it (marks it read),
// reply, ask for a draft ("Yanıt öner": the AI writes in the brand's voice, the owner edits and
// sends — nothing goes out by itself), hide / show or delete. The Mac's worker reads new comments
// every 15 minutes while it runs and sends what was queued.
import type { CommentFilter, CommentThread, PostComment } from "@studio/contract";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, cn, SegmentedControl, Spinner, TagPill } from "../../components/ui/controls.tsx";
import { ConfirmDialog } from "../../components/ui/dialog.tsx";
import {
  IconCheck,
  IconComments,
  IconEye,
  IconEyeOff,
  IconHeart,
  IconRefresh,
  IconSend,
  IconSparkles,
  IconTrash,
  IconWarning,
  PlatformIcon,
} from "../../components/ui/icons.tsx";
import { describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { PageHeader, PaneMessage } from "../pane-ui.tsx";
import { usePanelBrand } from "../panel-brand.ts";
import {
  useCommentActions,
  useCommentSummary,
  useCommentThreads,
  useReplySuggestion,
} from "./comments-data.ts";
import {
  actionText,
  commentTime,
  postOptions,
  replyLimit,
  syncLine,
  threadUnreadIds,
} from "./comments-model.ts";

const FILTERS: { value: CommentFilter; label: string }[] = [
  { value: "all", label: "Tümü" },
  { value: "unread", label: "Okunmamış" },
  { value: "unanswered", label: "Yanıtlanmamış" },
];

const FIELD =
  "selectable w-full resize-none rounded-[12px] bg-field px-3 py-2 text-body text-fg outline-none shadow-[inset_0_0_0_1px_var(--border-hairline)] placeholder:text-fg-3";

export default function CommentsPage() {
  const { brandId, brand } = usePanelBrand();
  if (!brandId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Yorumlar" />
        <div className="px-8">
          <PaneMessage
            icon={<IconComments size={18} />}
            text="Yorumlar için kenar çubuğunun altındaki menüden bir marka seç."
          />
        </div>
      </div>
    );
  }
  return <CommentsBody key={brandId} brandId={brandId} brandName={brand?.name ?? ""} />;
}

export function CommentsBody({ brandId, brandName }: { brandId: string; brandName: string }) {
  const [filter, setFilter] = useState<CommentFilter>("all");
  const [contentId, setContentId] = useState<string | null>(null);
  const summary = useCommentSummary(brandId);
  const threads = useCommentThreads(brandId, filter, contentId);
  const actions = useCommentActions(brandId);
  const items = useMemo(() => threads.data?.pages.flatMap((p) => p.items) ?? [], [threads.data]);
  const posts = useMemo(() => postOptions(items, summary.data), [items, summary.data]);
  const unread = summary.data?.unread ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Yorumlar"
        subtitle={`${brandName ? `${brandName} · ` : ""}${syncLine(summary.data)}`}
        actions={
          <>
            <Button
              icon={<IconCheck size={14} strokeWidth={1.75} />}
              disabled={unread === 0}
              onClick={() => void actions.markAllRead()}
            >
              Tümünü okundu say
            </Button>
            <Button
              icon={<IconRefresh size={14} strokeWidth={1.75} />}
              onClick={() => void actions.sync()}
            >
              Şimdi yenile
            </Button>
          </>
        }
      >
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <SegmentedControl<CommentFilter>
            label="Yorum süzgeci"
            value={filter}
            onChange={setFilter}
            options={FILTERS.map((f) =>
              f.value === "unread" && unread > 0 ? { ...f, count: unread } : f,
            )}
          />
          <select
            aria-label="Post"
            className="h-7 max-w-[280px] rounded-[8px] bg-field px-2 text-body text-fg"
            value={contentId ?? ""}
            onChange={(e) => setContentId(e.target.value || null)}
          >
            <option value="">Bütün postlar</option>
            {posts.map((p) => (
              <option key={p.contentId} value={p.contentId}>
                {p.title}
                {p.unread ? ` (${p.unread} okunmamış)` : ""}
              </option>
            ))}
          </select>
        </div>
        {(summary.data?.needsReconnect.length ?? 0) > 0 && (
          <p className="mt-2 flex items-start gap-1.5 text-footnote text-warning">
            <IconWarning size={13} className="mt-0.5 shrink-0" />
            <span>
              {summary.data?.needsReconnect.map((a) => a.handle).join(", ")}: yorumlar okunamıyor.
              Ayarlar → Hesaplar'dan yeniden bağlayıp yorum izinlerini onaylayın.
            </span>
          </p>
        )}
      </PageHeader>
      <div className="scroll-area min-h-0 flex-1 px-8 pb-8">
        {threads.isLoading && (
          <p className="flex items-center gap-2 text-body text-fg-2">
            <Spinner size={12} /> Yorumlar yükleniyor…
          </p>
        )}
        {threads.error && (
          <PaneMessage icon={<IconWarning size={18} />} text={describeError(threads.error)} />
        )}
        {!threads.isLoading && !threads.error && items.length === 0 && (
          <PaneMessage
            icon={<IconComments size={18} />}
            text={
              filter === "unread"
                ? "Okunmamış yorum yok."
                : filter === "unanswered"
                  ? "Yanıt bekleyen yorum yok."
                  : "Henüz yorum yok."
            }
            detail="Yayınlanan Instagram ve Facebook postlarının son 30 günlük yorumları burada görünür."
          />
        )}
        <div className="flex max-w-[860px] flex-col gap-3">
          {items.map((t) => (
            <ThreadCard key={t.id} thread={t} actions={actions} />
          ))}
        </div>
        {threads.hasNextPage && (
          <div className="mt-4">
            <Button
              disabled={threads.isFetchingNextPage}
              onClick={() => void threads.fetchNextPage()}
            >
              Daha fazla göster
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

type Actions = ReturnType<typeof useCommentActions>;

export function ThreadCard({ thread, actions }: { thread: CommentThread; actions: Actions }) {
  const openPost = useAppStore((s) => s.openPost);
  const unreadIds = threadUnreadIds(thread);
  const [replying, setReplying] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<PostComment | null>(null);
  const reported = useRef(false);
  // Shown means read (once per card).
  useEffect(() => {
    if (reported.current || unreadIds.length === 0) return;
    reported.current = true;
    void actions.markRead(unreadIds);
  }, [unreadIds, actions]);

  return (
    <article
      aria-label={`${thread.author ?? "Yorum"}: ${thread.text}`}
      className={cn(
        "flex flex-col gap-2 rounded-[14px] px-4 py-3 shadow-[inset_0_0_0_1px_var(--border-hairline)]",
        unreadIds.length > 0 && "bg-accent-subtle/40",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-footnote text-fg-2">
        <PlatformIcon platform={thread.platform} size={13} className="shrink-0 text-icon" />
        {thread.contentTitle && thread.contentId ? (
          <button
            type="button"
            className="min-w-0 truncate text-left hover:underline"
            onClick={() => openPost(thread.contentId as string)}
          >
            {thread.contentTitle}
          </button>
        ) : (
          <span className="truncate">Post</span>
        )}
        {thread.permalink && (
          <a
            href={thread.permalink}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-accent-text hover:underline"
          >
            Gönderiyi aç
          </a>
        )}
        <span className="flex-1" />
        {unreadIds.length > 0 && <TagPill tone="accent">Yeni</TagPill>}
        {!thread.answered && !thread.own && <TagPill tone="warning">Yanıt bekliyor</TagPill>}
      </div>
      <CommentRow comment={thread} actions={actions} onDelete={() => setConfirmDelete(thread)} />
      {thread.replies.length > 0 && (
        <div className="ml-5 flex flex-col gap-2 border-l border-hairline pl-3">
          {thread.replies.map((r) => (
            <CommentRow
              key={r.id}
              comment={r}
              actions={actions}
              onDelete={() => setConfirmDelete(r)}
            />
          ))}
        </div>
      )}
      {thread.deletedAt === null &&
        (replying ? (
          <ReplyBox thread={thread} actions={actions} onClose={() => setReplying(false)} />
        ) : (
          <div>
            <Button
              size="sm"
              icon={<IconSend size={12} strokeWidth={1.75} />}
              onClick={() => setReplying(true)}
            >
              Yanıtla
            </Button>
          </div>
        ))}
      <ConfirmDialog
        open={confirmDelete !== null}
        title="Yorum silinsin mi?"
        message="Yorum platformdan da silinir; geri alınamaz. Gizlemek isterseniz Gizle'yi kullanın."
        confirmLabel="Sil"
        destructive
        onConfirm={() => {
          const target = confirmDelete;
          setConfirmDelete(null);
          if (target) void actions.moderate(target.id, "delete");
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </article>
  );
}

function CommentRow({
  comment,
  actions,
  onDelete,
}: {
  comment: PostComment;
  actions: Actions;
  onDelete(): void;
}) {
  const pending = comment.pendingAction ? actionText(comment.pendingAction) : null;
  const gone = comment.deletedAt !== null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-body">
            <span className="font-medium text-fg">
              {comment.own ? "Siz" : (comment.author ?? "Kullanıcı")}
            </span>{" "}
            <span
              className={cn(
                "selectable [overflow-wrap:anywhere]",
                gone || comment.hidden ? "text-fg-3" : "text-fg",
                gone && "line-through",
              )}
            >
              {comment.text}
            </span>
          </p>
          <p className="flex items-center gap-2 text-caption text-fg-3">
            <span>{commentTime(comment.createdAt)}</span>
            {(comment.likeCount ?? 0) > 0 && (
              <span className="flex items-center gap-0.5">
                <IconHeart size={10} /> {comment.likeCount}
              </span>
            )}
            {comment.hidden && !gone && <span>Gizli</span>}
            {gone && <span>Silindi</span>}
          </p>
        </div>
        {!gone && (
          <div className="flex shrink-0 items-center gap-1">
            {!(comment.own && comment.platform === "instagram") && (
              <Button
                variant="ghost"
                size="sm"
                icon={comment.hidden ? <IconEye size={12} /> : <IconEyeOff size={12} />}
                onClick={() =>
                  void actions.moderate(comment.id, comment.hidden ? "unhide" : "hide")
                }
              >
                {comment.hidden ? "Göster" : "Gizle"}
              </Button>
            )}
            <Button variant="ghost" size="sm" icon={<IconTrash size={12} />} onClick={onDelete}>
              Sil
            </Button>
          </div>
        )}
      </div>
      {pending && (
        <p
          className={cn(
            "flex items-center gap-2 text-footnote",
            pending.failed ? "text-danger" : "text-fg-2",
          )}
        >
          {!pending.failed && <Spinner size={10} />}
          <span className="min-w-0 flex-1">{pending.text}</span>
          {pending.failed && (
            <Button size="sm" variant="ghost" onClick={() => void actions.retry(comment.id)}>
              Yeniden dene
            </Button>
          )}
        </p>
      )}
    </div>
  );
}

export function ReplyBox({
  thread,
  actions,
  onClose,
}: {
  thread: CommentThread;
  actions: Actions;
  onClose(): void;
}) {
  const limit = replyLimit(thread.platform);
  const [text, setText] = useState(thread.suggestion ?? "");
  const [sending, setSending] = useState(false);
  const suggestion = useReplySuggestion(thread);
  const s = suggestion.state;
  // A finished draft fills the box (the owner edits; nothing is sent by itself).
  useEffect(() => {
    if (s.kind === "ready") setText(s.text);
  }, [s]);
  const length = [...text].length;
  const send = async () => {
    if (!text.trim() || length > limit) return;
    setSending(true);
    const done = await actions.reply(thread.id, text.trim());
    setSending(false);
    if (done) onClose();
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        aria-label="Yanıt"
        className={FIELD}
        rows={3}
        value={text}
        placeholder={
          thread.platform === "instagram" ? `@${thread.author ?? ""} ` : "Yanıtınızı yazın"
        }
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.metaKey) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {s.kind === "working" && (
        <p className="flex items-center gap-1.5 text-footnote text-fg-2">
          <Spinner size={10} /> Taslak yazılıyor…
        </p>
      )}
      {s.kind === "ready" && (
        <p className="text-footnote text-fg-2">Taslak hazır, düzenleyip gönderin.</p>
      )}
      {s.kind === "failed" && <p className="text-footnote text-danger">{s.message}</p>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          icon={sending ? <Spinner size={10} /> : <IconSend size={12} strokeWidth={1.75} />}
          disabled={sending || !text.trim() || length > limit}
          onClick={() => void send()}
        >
          Gönder
        </Button>
        <Button
          size="sm"
          icon={<IconSparkles size={12} strokeWidth={1.75} />}
          disabled={s.kind === "working"}
          onClick={() => void suggestion.start()}
        >
          Yanıt öner
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Vazgeç
        </Button>
        <span
          className={cn(
            "ml-auto text-caption tabular-nums",
            length > limit ? "text-danger" : "text-fg-3",
          )}
        >
          {length}/{limit}
        </span>
      </div>
    </div>
  );
}
