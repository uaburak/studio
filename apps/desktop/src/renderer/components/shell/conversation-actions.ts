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
      // Back / forward do not lead into it any more (the Arşiv page still opens it).
      useAppStore.getState().forgetRoute({ kind: "conversation", id: conversation.id });
      void queryClient.invalidateQueries({ queryKey: queryKeys.archivedConversations });
      store.showToast({
        message: `“${conversation.title || "Adsız sohbet"}” arşivlendi`,
        action: { label: "Geri al", run: () => void unarchive(conversation) },
      });
    } catch (error) {
      store.showToast({ message: describeError(error), tone: "danger" });
    }
  }

  /** Back to the sidebar (the toast's "Geri al", the Arşiv page). */
  async function unarchive(conversation: Conversation): Promise<boolean> {
    try {
      updateCached(await api.conversations.update(conversation.id, { status: "active" }));
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversations });
      void queryClient.invalidateQueries({ queryKey: queryKeys.archivedConversations });
      return true;
    } catch (error) {
      useAppStore.getState().showToast({
        message: `Sohbet arşivden çıkarılamadı: ${describeError(error)}`,
        tone: "danger",
      });
      return false;
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
      conversation.status === "archived"
        ? {
            id: "unarchive",
            label: "Arşivden çıkar",
            shortcut: "A",
            onSelect: () => void unarchive(conversation),
          }
        : {
            id: "archive",
            label: "Arşivle",
            shortcut: "A",
            onSelect: () => void archive(conversation),
          },
    ];
  }

  return { rename, archive, unarchive, menu };
}
