// Post actions shared by the board, its cards and the opened post: quick look (the lightbox
// with the rendered slides), copy the caption, duplicate, delete (after the confirmation).
import type { Content, ContentVersion } from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { deletionBlocker } from "./board.ts";
import { invalidatePosts } from "./data.ts";
import { usePostsStore } from "./store.ts";

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

      /** Ask first (the board's and the detail's confirmation dialog). */
      askDelete(content: Content) {
        const blocker = deletionBlocker(content);
        if (blocker) {
          toast({ message: blocker });
          return;
        }
        usePostsStore.getState().askDelete(content);
      },

      async remove(content: Content): Promise<boolean> {
        const blocker = deletionBlocker(content);
        if (blocker) {
          toast({ message: blocker, tone: "danger" });
          return false;
        }
        try {
          await api.contents.delete(content.id);
          const store = usePostsStore.getState();
          if (store.opened?.contentId === content.id) store.close();
          // Back / forward must not reopen the deleted post.
          useAppStore.getState().forgetPost(content.id);
          if (store.selectedId === content.id) store.select(null);
          queryClient.removeQueries({ queryKey: ["posts", "content", content.id] });
          await invalidatePosts(queryClient);
          toast({ message: `“${content.title}” silindi.` });
          return true;
        } catch (e) {
          toast({ message: `${content.title}: ${describeError(e)}`, tone: "danger" });
          return false;
        }
      },
    };
  }, [api, queryClient]);
}

export type PostActions = ReturnType<typeof usePostActions>;
