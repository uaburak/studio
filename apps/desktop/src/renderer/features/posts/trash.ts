// Deleting posts safely (7): a delete moves posts to the trash ("Silinenler") and the toast's
// "Geri al" (10 s) takes them back; the trash keeps them TRASH_RETENTION_DAYS, then the API purges
// them with their files. "Kalıcı olarak sil" in Silinenler removes one for good (after asking).
import type { ApiClient, Content } from "@studio/contract";
import type { QueryClient } from "@tanstack/react-query";
import { describeError } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { mapLimit } from "./bulk.ts";
import { invalidatePosts } from "./data.ts";
import { usePostsStore } from "./store.ts";

/** "Geri al" toasts stay this long (the trash keeps posts for 30 days either way). */
export const UNDO_TOAST_MS = 10_000;

export function toast(t: Parameters<ReturnType<typeof useAppStore.getState>["showToast"]>[0]) {
  useAppStore.getState().showToast(t);
}

/** Take posts back out of the trash. */
export async function restorePosts(
  api: Pick<ApiClient, "contents">,
  queryClient: QueryClient,
  contents: readonly Pick<Content, "id" | "title">[],
): Promise<number> {
  const back = await mapLimit(contents, 4, (c) => api.contents.restore(c.id));
  await invalidatePosts(queryClient);
  const lost = back.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  const ok = contents.length - lost.length;
  if (lost.length > 0) {
    toast({
      message: `${lost.length} post geri alınamadı: ${describeError(lost[0]?.reason)}`,
      tone: "danger",
    });
  } else {
    toast({ message: ok === 1 ? "Post geri alındı." : `${ok} post geri alındı.` });
  }
  return ok;
}

/** Move posts to the trash; the toast takes them all back. Returns the moved ids. */
export async function trashPosts(
  api: Pick<ApiClient, "contents">,
  queryClient: QueryClient,
  contents: readonly Content[],
): Promise<string[]> {
  const results = await mapLimit(contents, 4, (c) => api.contents.delete(c.id));
  const done = contents.filter((_, i) => results[i]?.status === "fulfilled");
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  const gone = new Set(done.map((c) => c.id));
  for (const id of gone) {
    // Back / forward must not reopen a trashed post.
    useAppStore.getState().forgetPost(id);
    queryClient.removeQueries({ queryKey: ["posts", "content", id] });
  }
  const store = usePostsStore.getState();
  if (store.opened && gone.has(store.opened.contentId)) store.close();
  if (store.picked.some((id) => gone.has(id)))
    store.setPicked(store.picked.filter((id) => !gone.has(id)));
  if (store.selectedId && gone.has(store.selectedId)) store.select(null);
  await invalidatePosts(queryClient);
  if (done.length > 0) {
    toast({
      message:
        done.length === 1
          ? `“${done[0]?.title}” Silinenler'e taşındı.`
          : `${done.length} post Silinenler'e taşındı.`,
      durationMs: UNDO_TOAST_MS,
      action: {
        label: "Geri al",
        run: () => void restorePosts(api, queryClient, done),
      },
    });
  }
  if (failed.length > 0) {
    toast({
      message:
        failed.length === 1
          ? describeError(failed[0]?.reason)
          : `${failed.length} post silinemedi: ${describeError(failed[0]?.reason)}`,
      tone: "danger",
    });
  }
  return [...gone];
}

/** "Kalıcı olarak sil" of a post in the trash (after the confirmation). */
export async function purgePost(
  api: Pick<ApiClient, "contents">,
  queryClient: QueryClient,
  content: Pick<Content, "id" | "title">,
): Promise<boolean> {
  try {
    await api.contents.delete(content.id, undefined, { permanent: true });
    queryClient.removeQueries({ queryKey: ["posts", "content", content.id] });
    await invalidatePosts(queryClient);
    toast({ message: `“${content.title}” kalıcı olarak silindi.` });
    return true;
  } catch (e) {
    toast({ message: describeError(e), tone: "danger" });
    return false;
  }
}
