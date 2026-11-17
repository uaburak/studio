// A text the new chat's composer starts with: a post's "Sohbette aç", the posts screen's
// "+ Yeni post". `startChat` picks the brand, opens the new chat and puts the text in.
import { create } from "zustand";
import { useAppStore } from "./app-store.ts";

interface ChatDraftState {
  text: string | null;
  take(): string | null;
}

export const useChatDraft = create<ChatDraftState>((set, get) => ({
  text: null,
  take() {
    const text = get().text;
    if (text !== null) set({ text: null });
    return text;
  },
}));

export function startChat(text: string, brandId: string | null | undefined): void {
  const app = useAppStore.getState();
  if (brandId !== undefined) app.setCurrentBrand(brandId);
  useChatDraft.setState({ text });
  app.navigate({ kind: "new" });
  app.requestComposerFocus();
}
