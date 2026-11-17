// App-level "open this post" action. The calendar, the media library and the chat call
// `openPost(contentId)`; the post detail (posts feature) registers the real opener with
// `usePostOpener` / `setPostOpener`. Until one is registered a toast says so.
import { useEffect } from "react";
import { useAppStore } from "./app-store.ts";

export interface PostOpenRequest {
  contentId: string;
  /** Frame the detail may zoom from (the card or row that was clicked). */
  origin?: { x: number; y: number; width: number; height: number } | null;
}

type PostOpener = (request: PostOpenRequest) => void;

let opener: PostOpener | null = null;

export function setPostOpener(next: PostOpener | null): void {
  opener = next;
}

export function hasPostOpener(): boolean {
  return opener !== null;
}

export function openPost(contentId: string, origin?: PostOpenRequest["origin"]): void {
  if (opener) {
    opener({ contentId, origin: origin ?? null });
    return;
  }
  useAppStore.getState().showToast({ message: "Post ayrıntısı henüz açılamıyor." });
}

/** Registers `handler` as the post opener while the calling component is mounted. */
export function usePostOpener(handler: PostOpener): void {
  useEffect(() => {
    setPostOpener(handler);
    return () => {
      if (opener === handler) setPostOpener(null);
    };
  }, [handler]);
}
