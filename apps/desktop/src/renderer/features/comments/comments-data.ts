// Server data of the comment inbox (N16): counts for the sidebar, threads, and the actions —
// reply, hide / delete, retry, read marks, "Yanıt öner" (watched until its job ends) and "Şimdi
// yenile". Finished comment reads refresh everything.
import type {
  CommentFilter,
  CommentList,
  CommentModerate,
  CommentThread,
  Job,
} from "@studio/contract";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { isHostUp, useHost, useJobList } from "../../state/studio.tsx";
import { useRefreshOnJobList } from "../performance/performance-data.ts";

export const commentKeys = {
  all: ["comments"] as const,
  summary: (brandId: string | null) => ["comments", "summary", brandId] as const,
  threads: (brandId: string | null, filter: CommentFilter, contentId: string | null) =>
    ["comments", "threads", brandId, filter, contentId] as const,
};

/** Re-read the counts at least this often (the worker reads every 15 minutes). */
const SUMMARY_REFRESH_MS = 60_000;

export function useCommentSummary(brandId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  useRefreshOnJobList(["comments.sync"], [commentKeys.all]);
  return useQuery({
    queryKey: commentKeys.summary(brandId),
    queryFn: () => api.comments.summary(brandId ? { brandId } : {}),
    enabled: up,
    refetchInterval: SUMMARY_REFRESH_MS,
    staleTime: 10_000,
  });
}

/** Unread comments of the brand (all brands without one), for the sidebar. */
export function useUnreadComments(brandId: string | null): number {
  return useCommentSummary(brandId).data?.unread ?? 0;
}

export function useCommentThreads(
  brandId: string | null,
  filter: CommentFilter,
  contentId: string | null,
) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useInfiniteQuery({
    queryKey: commentKeys.threads(brandId, filter, contentId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }): Promise<CommentList> =>
      api.comments.list({
        ...(brandId ? { brandId } : {}),
        ...(contentId ? { contentId } : {}),
        filter,
        limit: 20,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: up && brandId !== null,
    refetchInterval: SUMMARY_REFRESH_MS,
  });
}

/** The inbox's actions; each refreshes the lists and shows a Turkish toast on failure. */
export function useCommentActions(brandId: string | null) {
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  const refresh = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: commentKeys.all }),
    [queryClient],
  );
  const run = useCallback(
    async <T>(fn: () => Promise<T>, done?: string): Promise<T | null> => {
      try {
        const out = await fn();
        if (done) showToast({ message: done });
        refresh();
        return out;
      } catch (error) {
        showToast({ message: describeError(error), tone: "danger" });
        return null;
      }
    },
    [refresh, showToast],
  );
  return {
    reply: (id: string, text: string) =>
      run(
        () => api.comments.reply(id, { text }),
        "Yanıt sıraya alındı; Mac'teki worker gönderecek.",
      ),
    moderate: (id: string, action: CommentModerate["action"]) =>
      run(() => api.comments.moderate(id, { action })),
    retry: (id: string) => run(() => api.comments.retryAction(id)),
    markRead: (ids: string[]) =>
      ids.length ? run(() => api.comments.read({ ids })) : Promise.resolve(null),
    markAllRead: () =>
      brandId ? run(() => api.comments.read({ brandId }), "Hepsi okundu sayıldı.") : null,
    sync: () =>
      run(
        () => api.comments.sync(brandId ? { brandId } : {}),
        "Yorumlar okunuyor; Mac'teki worker bitirince liste yenilenir.",
      ),
  };
}

export type SuggestState =
  | { kind: "idle" }
  | { kind: "working"; jobId: string }
  | { kind: "ready"; text: string }
  | { kind: "failed"; message: string };

/** How often a running "Yanıt öner" job is asked about outside the live job feed. */
const SUGGEST_POLL_MS = 1_500;

/**
 * "Yanıt öner": queue `comments.suggest`, watch the job (the live feed, or by asking), and hand
 * back the draft. The draft is never sent: the owner edits and presses "Gönder".
 */
export function useReplySuggestion(comment: Pick<CommentThread, "id">) {
  const api = useApi();
  const queryClient = useQueryClient();
  const jobs = useJobList();
  const [state, setState] = useState<SuggestState>({ kind: "idle" });
  const jobId = state.kind === "working" ? state.jobId : null;
  const live = jobId ? jobs.find((j) => j.id === jobId) : undefined;
  const polled = useQuery({
    queryKey: ["comments", "suggest-job", jobId],
    queryFn: (): Promise<Job> => api.jobs.get(jobId as string),
    enabled: jobId !== null,
    refetchInterval: SUGGEST_POLL_MS,
  });
  const job = live ?? polled.data;
  useEffect(() => {
    if (!jobId || !job || job.id !== jobId) return;
    if (job.status === "succeeded") {
      const text = (job.output as { suggestion?: unknown } | undefined)?.suggestion;
      setState(
        typeof text === "string" && text
          ? { kind: "ready", text }
          : { kind: "failed", message: "Taslak boş geldi; yeniden deneyin." },
      );
      void queryClient.invalidateQueries({ queryKey: commentKeys.all });
    } else if (job.status === "failed" || job.status === "cancelled") {
      setState({ kind: "failed", message: job.error ?? "Taslak yazılamadı." });
    }
  }, [job, jobId, queryClient]);
  const start = useCallback(
    async (instruction?: string) => {
      try {
        const created = await api.comments.suggest(comment.id, instruction ? { instruction } : {});
        setState({ kind: "working", jobId: created.id });
      } catch (error) {
        setState({ kind: "failed", message: describeError(error) });
      }
    },
    [api, comment.id],
  );
  const reset = useCallback(() => setState({ kind: "idle" }), []);
  return { state, start, reset };
}
