// The post's Sohbet: a conversation bound to the post (this Mac remembers which one, per post).
// The first message creates it in the post's brand, named after the post, and tells the agent
// which post (id and version) it is about; later messages continue it. `@` layer chips (or the
// canvas selection) become the scope line in front of the request. The draft is saved first, so
// the agent works on what the canvas shows; when a reply ends the post is re-read, and versions
// the agent made land on the canvas (finished jobs of the post do the same, post-detail.tsx).
import type { Content, ContentVersion } from "@studio/contract";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { describeError, useApi } from "../../lib/api.ts";
import { type AgentChoice, choiceFor, FALLBACK_CHOICE, saveChoicePatch } from "../../lib/models.ts";
import {
  ConversationController,
  type ConversationSnapshot,
  newClientMessageId,
} from "../../state/conversation.ts";
import {
  useConversationCache,
  useConversationUpdater,
  useOptionalSettings,
} from "../../state/studio.tsx";
import { useWorkspaceStore } from "./workspace-store.ts";

/** The scope line an AI request gets in front of it (the layers it may change). */
export function scopedInstruction(
  text: string,
  scope: readonly string[],
  describe: (key: string) => { slide: number; id: string; label: string } | null,
): string {
  if (scope.length === 0) return text;
  const parts = scope
    .map(describe)
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .map((d) => `Kare ${d.slide + 1} › ${d.id} (${d.label})`);
  if (parts.length === 0) return text;
  return `Kapsam: ${parts.join(", ")}. Yalnızca bu katmanları değiştir; diğerlerini olduğu gibi bırak.\n${text}`;
}

/** What the conversation's first message says about the post it is bound to. */
export function postReference(
  content: Pick<Content, "id" | "title">,
  version: Pick<ContentVersion, "version"> | null,
): string {
  return `“${content.title}” postu (id: ${content.id}${version ? `, v${version.version}` : ""}) için:`;
}

/** The text sent for a request: the post's reference on the first one, the scope, the request. */
export function postChatText(options: {
  first: boolean;
  content: Pick<Content, "id" | "title">;
  version: Pick<ContentVersion, "version"> | null;
  text: string;
  scope: readonly string[];
  describe: (key: string) => { slide: number; id: string; label: string } | null;
}): string {
  const scoped = scopedInstruction(options.text, options.scope, options.describe);
  return options.first ? `${postReference(options.content, options.version)}\n${scoped}` : scoped;
}

const EMPTY: ConversationSnapshot | null = null;
const noSubscribe = () => () => undefined;
const noSnapshot = () => EMPTY;

export interface PostChat {
  conversationId: string | null;
  controller: ConversationController | null;
  snapshot: ConversationSnapshot | null;
  /** A reply runs (sending queues). */
  working: boolean;
  choice: AgentChoice;
  setChoice: ((choice: AgentChoice) => void) | null;
  send(text: string, scope: readonly string[]): Promise<boolean>;
  stop(): void;
  /** Start over: the next message opens a new conversation for the post. */
  restart(): void;
}

export function usePostChat(options: {
  content: Content;
  version: ContentVersion | null;
  /** Saves the canvas's unsaved edits; false: they could not be saved. */
  flush(): Promise<boolean>;
  describe(key: string): { slide: number; id: string; label: string } | null;
  notify(message: string, tone?: "error" | "notice"): void;
  /** A reply ended: re-read the post (the agent may have made a version). */
  onReplyEnd(): void;
}): PostChat {
  const { content } = options;
  const api = useApi();
  const cache = useConversationCache();
  const settings = useOptionalSettings();
  const updateCached = useConversationUpdater();
  const conversationId = useWorkspaceStore((s) => s.chats[content.id] ?? null);
  const opts = useRef(options);
  opts.current = options;

  // Outside the app's providers (demo, tests) the panel keeps its own controllers.
  const locals = useRef(new Map<string, ConversationController>());
  const obtain = useCallback(
    (id: string): ConversationController => {
      if (cache) return cache.get(id);
      let controller = locals.current.get(id);
      if (!controller) {
        controller = new ConversationController(id, api, {
          choice: () => FALLBACK_CHOICE,
          saveChoice: () => undefined,
        });
        locals.current.set(id, controller);
        controller.start();
      }
      return controller;
    },
    [cache, api],
  );
  useEffect(() => {
    const own = locals.current;
    return () => {
      for (const controller of own.values()) controller.stop();
      own.clear();
    };
  }, []);

  const controller = useMemo(
    () => (conversationId ? obtain(conversationId) : null),
    [conversationId, obtain],
  );
  const snapshot = useSyncExternalStore(
    controller?.subscribe ?? noSubscribe,
    controller?.getSnapshot ?? noSnapshot,
  );
  const working = snapshot?.isReplyActive ?? false;

  // A reply ended: the post may have a new version.
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working) opts.current.onReplyEnd();
    wasWorking.current = working;
  }, [working]);

  const choice = settings ? choiceFor(settings.settings, conversationId) : FALLBACK_CHOICE;
  const setChoice = settings
    ? (next: AgentChoice) => settings.update(saveChoicePatch(next, conversationId))
    : null;

  const send = useCallback(
    async (text: string, scope: readonly string[]): Promise<boolean> => {
      const o = opts.current;
      const trimmed = text.trim();
      if (!trimmed) return false;
      if (!(await o.flush())) {
        o.notify("Taslak kaydedilemedi; mesajdan önce kaydedilmeli.", "error");
        return false;
      }
      let id = useWorkspaceStore.getState().chats[o.content.id] ?? null;
      const first = id === null;
      if (id === null) {
        try {
          const conversation = await api.conversations.create({
            brandId: o.content.brandId,
            title: o.content.title.slice(0, 200),
          });
          updateCached(conversation);
          settings?.update(saveChoicePatch(choice, conversation.id));
          useWorkspaceStore.getState().setChat(o.content.id, conversation.id);
          id = conversation.id;
        } catch (e) {
          o.notify(`Sohbet başlatılamadı: ${describeError(e)}`, "error");
          return false;
        }
      }
      const body = postChatText({
        first,
        content: o.content,
        version: o.version,
        text: trimmed,
        scope,
        describe: o.describe,
      });
      return obtain(id).send({
        clientMessageId: newClientMessageId(),
        text: body,
        attachments: [],
      });
    },
    [api, obtain, updateCached, settings, choice],
  );

  return {
    conversationId,
    controller,
    snapshot,
    working,
    choice,
    setChoice,
    send,
    stop: () => void controller?.cancelRun(),
    restart: () => useWorkspaceStore.getState().forgetChat(content.id),
  };
}
