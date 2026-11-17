// Rename / archive a conversation (sidebar "…", right-click, title menu).
import type { Conversation } from "@studio/contract";
import { useQueryClient } from "@tanstack/react-query";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { queryKeys, useConversationUpdater } from "../../state/studio.tsx";
import type { MenuEntry } from "../ui/menu.tsx";

export function useConversationActions() {
  const api = useApi();
  const queryClient = useQueryClient();
  const updateCached = useConversationUpdater();

  async function rename(id: string, title: string): Promise<boolean> {
    const clean = title.trim();
    if (!clean) return false;
    try {
      updateCached(await api.conversations.update(id, { title: clean }));
      return true;
    } catch (error) {
      useAppStore.getState().showToast({ message: describeError(error), tone: "danger" });
      return false;
    }
  }

  async function archive(conversation: Conversation): Promise<void> {
    const store = useAppStore.getState();
    try {
      updateCached(await api.conversations.update(conversation.id, { status: "archived" }));
      if (store.route.kind === "conversation" && store.route.id === conversation.id) {
        store.navigate({ kind: "new" });
      }
      store.showToast({
        message: `“${conversation.title || "Adsız sohbet"}” arşivlendi`,
        action: {
          label: "Geri al",
          run: () =>
            void api.conversations
              .update(conversation.id, { status: "active" })
              .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.conversations })),
        },
      });
    } catch (error) {
      store.showToast({ message: describeError(error), tone: "danger" });
    }
  }

  function menu(conversation: Conversation): MenuEntry[] {
    return [
      {
        id: "rename",
        label: "Yeniden adlandır",
        shortcut: "R",
        onSelect: () => {
          const store = useAppStore.getState();
          store.navigate({ kind: "conversation", id: conversation.id });
          store.requestRename();
        },
      },
      {
        id: "copy-title",
        label: "Başlığı kopyala",
        shortcut: "C",
        onSelect: () => void navigator.clipboard?.writeText(conversation.title),
      },
      { type: "separator" },
      {
        id: "archive",
        label: "Arşivle",
        shortcut: "A",
        onSelect: () => void archive(conversation),
      },
    ];
  }

  return { rename, archive, menu };
}
