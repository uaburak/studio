// Post actions shared by the board, its cards and the opened post: quick look (the lightbox
// with the rendered slides), copy the caption, duplicate, delete (to the trash, with "Geri al"),
// "Yeniden dene" of a failed generation, "Onayı geri al" (approved → draft), and the trash's
// restore / "Kalıcı olarak sil".
import type { Content, ContentVersion } from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { deletionBlocker, revokeState } from "./board.ts";
import { invalidatePosts, storeContent } from "./data.ts";
import { usePostsStore } from "./store.ts";
import { purgePost, restorePosts, trashPosts } from "./trash.ts";

export function usePostActions() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMemo(() => {
    const toast = useAppStore.getState().showToast;
    return {
      /** The rendered slides in the image viewer (Space on the board and in the post), from
       *  slide `slideIndex`, zooming out of `source` (the card's or the stage's picture). */
      quickLook(
        content: Content,
        version: ContentVersion | null,
        from: { source?: Element | null; slideIndex?: number } = {},
      ) {
        const slides = version?.slides ?? [];
        const images = slides.flatMap((s) =>
          s.renderedAssetId
            ? [
                {
                  assetId: s.renderedAssetId,
                  width: s.width,
                  height: s.height,
                  caption: content.title,
                },
              ]
            : [],
        );
        if (images.length === 0) {
          toast({ message: "Bu postun henüz render edilmiş bir görseli yok." });
          return;
        }
        const shown = slides[from.slideIndex ?? 0]?.renderedAssetId;
        const index = Math.max(
          0,
          images.findIndex((i) => i.assetId === shown),
        );
        // The source shows that one slide; the others fade out when closed on them.
        useAppStore.getState().openLightbox({
          images,
          index,
          sourceOf: (i) => (i === index ? (from.source ?? null) : null),
        });
      },

      async copyCaption(content: Content) {
        if (!content.caption.trim()) {
          toast({ message: "Bu postun açıklaması boş." });
          return;
        }
        try {
          await navigator.clipboard.writeText(content.caption);
          toast({ message: "Açıklama kopyalandı." });
        } catch {
          toast({ message: "Açıklama kopyalanamadı.", tone: "danger" });
        }
      },

      async duplicate(content: Content): Promise<Content | null> {
        try {
          const copy = await api.contents.duplicate(content.id);
          await invalidatePosts(queryClient);
          usePostsStore.getState().select(copy.id);
          toast({
            message: `“${copy.title}” oluşturuldu.`,
            action: { label: "Aç", run: () => usePostsStore.getState().open(copy.id) },
          });
          return copy;
        } catch (e) {
          toast({ message: `${content.title}: ${describeError(e)}`, tone: "danger" });
          return null;
        }
      },

      /**
       * ⌫ / "Sil": to the trash at once (the toast's "Geri al" takes it back; no question). A
       * post that cannot be deleted says why.
       */
      askDelete(content: Content) {
        const blocker = deletionBlocker(content);
        if (blocker) {
          toast({ message: blocker });
          return;
        }
        void trashPosts(api, queryClient, [content]);
      },

      async remove(content: Content): Promise<boolean> {
        const blocker = deletionBlocker(content);
        if (blocker) {
          toast({ message: blocker, tone: "danger" });
          return false;
        }
        return (await trashPosts(api, queryClient, [content])).length > 0;
      },

      /**
       * "Onayı geri al…": ask first (the confirmation in the post layer). A scheduled post says
       * why it can't (its schedule has to be cancelled first). `onDone` gets the fresh post.
       */
      askRevoke(content: Content, onDone?: (fresh: Content) => void) {
        const state = revokeState(content);
        if (state === null) return;
        if (state !== "ok") {
          toast({ message: `${state}; onay, zamanlama iptal edilince geri alınabilir.` });
          return;
        }
        usePostsStore.getState().askRevoke(content, onDone);
      },

      /** Approved → draft (`POST /contents/{id}/transition`): the approval is cleared. */
      async revokeApproval(content: Content): Promise<Content | null> {
        const state = revokeState(content);
        if (state !== "ok") {
          if (state) toast({ message: state, tone: "danger" });
          return null;
        }
        try {
          const fresh = await api.contents.transition(content.id, "draft");
          storeContent(queryClient, fresh);
          await invalidatePosts(queryClient, content.id);
          toast({ message: `“${content.title}” onayı geri alındı; post taslağa döndü.` });
          return fresh;
        } catch (e) {
          toast({ message: `${content.title}: ${describeError(e)}`, tone: "danger" });
          return null;
        }
      },

      /** Take a post back out of the trash ("Silinenler"). */
      async restore(content: Pick<Content, "id" | "title">): Promise<boolean> {
        return (await restorePosts(api, queryClient, [content])) > 0;
      },

      /** "Kalıcı olarak sil…": ask first (the detail's confirmation dialog). */
      askPurge(content: Content) {
        usePostsStore.getState().askDelete(content);
      },

      purge(content: Pick<Content, "id" | "title">): Promise<boolean> {
        return purgePost(api, queryClient, content);
      },

      /** "Yeniden dene" of a failed job (a plan item's generation goes through its plan). */
      async retry(jobId: string, title?: string): Promise<boolean> {
        try {
          await api.jobs.retry(jobId);
          await invalidatePosts(queryClient);
          toast({
            message: title ? `“${title}” yeniden üretime alındı.` : "İş yeniden kuyruğa alındı.",
          });
          return true;
        } catch (e) {
          toast({ message: describeError(e), tone: "danger" });
          return false;
        }
      },
    };
  }, [api, queryClient]);
}

export type PostActions = ReturnType<typeof usePostActions>;
