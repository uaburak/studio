// Pure helpers of the comment inbox (N16): reply limits, action states and times in words, the
// post filter's options.
import {
  COMMENT_REPLY_MAX,
  COMMENTS_SYNC_MINUTES,
  type CommentAction,
  type CommentSummary,
  type CommentThread,
} from "@studio/contract";
import { ago } from "../performance/performance-model.ts";

/** Characters a reply may have on the comment's platform. */
export function replyLimit(platform: string): number {
  return platform === "instagram" ? COMMENT_REPLY_MAX.instagram : COMMENT_REPLY_MAX.facebook;
}

const KIND_RUNNING: Record<CommentAction["kind"], string> = {
  reply: "Yanıt gönderiliyor…",
  hide: "Gizleniyor…",
  unhide: "Gösteriliyor…",
  delete: "Siliniyor…",
};

const KIND_PENDING: Record<CommentAction["kind"], string> = {
  reply: "Yanıt sırada; Mac'teki worker gönderecek.",
  hide: "Gizleme sırada.",
  unhide: "Gösterme sırada.",
  delete: "Silme sırada.",
};

const KIND_FAILED: Record<CommentAction["kind"], string> = {
  reply: "Yanıt gönderilemedi",
  hide: "Gizlenemedi",
  unhide: "Gösterilemedi",
  delete: "Silinemedi",
};

/** An unfinished (or failed) action in words; `failed` gets "Yeniden dene". */
export function actionText(action: CommentAction): { text: string; failed: boolean } {
  if (action.status === "failed")
    return {
      text: `${KIND_FAILED[action.kind]}${action.error ? `: ${action.error}` : "."}`,
      failed: true,
    };
  return {
    text: action.status === "pending" ? KIND_PENDING[action.kind] : KIND_RUNNING[action.kind],
    failed: false,
  };
}

/** Someone else's comment in the thread that is not read yet. */
export function threadUnreadIds(thread: CommentThread): string[] {
  return [thread, ...thread.replies]
    .filter((c) => !c.own && c.readAt === null && c.deletedAt === null)
    .map((c) => c.id);
}

/** Posts to filter by: the ones in the loaded threads (title, newest first, unique). */
export function postOptions(
  threads: readonly CommentThread[],
  summary?: CommentSummary | null,
): { contentId: string; title: string; unread: number }[] {
  const out = new Map<string, { contentId: string; title: string; unread: number }>();
  for (const t of threads) {
    if (!t.contentId || out.has(t.contentId)) continue;
    out.set(t.contentId, { contentId: t.contentId, title: t.contentTitle ?? "Post", unread: 0 });
  }
  for (const c of summary?.contents ?? []) {
    const known = out.get(c.contentId);
    if (known) known.unread = c.unread;
  }
  return [...out.values()];
}

/** "Son okuma: 5 dk önce · Mac açıkken 15 dakikada bir okunur." */
export function syncLine(
  summary: CommentSummary | null | undefined,
  now: Date = new Date(),
): string {
  const last = summary?.lastSyncAt
    ? `Son okuma: ${ago(summary.lastSyncAt, now)}`
    : "Yorumlar henüz okunmadı";
  return `${last} · Mac açıkken ${COMMENTS_SYNC_MINUTES} dakikada bir okunur.`;
}

/** A comment's time: "5 dk önce" up to a day, then "12 Kas 14:05". */
export function commentTime(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(iso);
  if (ms < 24 * 3_600_000) return ago(iso, now);
  return new Date(iso).toLocaleString("tr-TR", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
