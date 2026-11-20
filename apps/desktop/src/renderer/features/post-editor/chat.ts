// The post's Sohbet: a conversation bound to the post (this Mac remembers which one, per post).
// The first message creates it in the post's brand, named after the post; every message tells the
// agent which post it is about and its current version (E17: the canvas makes versions between
// messages), and — for a version saved from the canvas — that the design is its Wecra document,
// edited with the canvas tools (S1, `canvas_outline` / `canvas_edit`), never regenerated from
// HTML. `@` layer chips (or the canvas selection) become the scope line in front of the request:
// Wecra's layer ids (what `canvas_edit` takes) with their names. Unsaved canvas edits become a
// version first (S5), so the agent works on what the canvas shows; when a reply ends the post is
// re-read, and versions the agent made land on the canvas (finished jobs of the post do the same,
// post-detail.tsx). While a reply runs the canvas is read only (edit-lock.ts).
import {
  type ApiClient,
  type Content,
  type ContentVersion,
  chatOnlyEngineOf,
} from "@studio/contract";
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
import { canvasOrigin } from "./wecra/slide-html.ts";
import { useWorkspaceStore } from "./workspace-store.ts";

/** A layer the AI may be pointed at: its slide, Wecra id, name and kind (wecra/scope.ts). */
export interface ScopeLayer {
  slide: number;
  /** Wecra's layer id ("12:345"): what `canvas_edit` operations name. */
  id: string;
  label: string;
  /** "metin", "görsel", "şekil" … */
  kind?: string;
}

/** The scope line an AI request gets in front of it (the layers it may change). */
export function scopedInstruction(
  text: string,
  scope: readonly string[],
  describe: (key: string) => ScopeLayer | null,
): string {
  if (scope.length === 0) return text;
  const parts = scope
    .map(describe)
    .filter((d): d is ScopeLayer => d !== null)
    .map(
      (d) =>
        `Kare ${d.slide + 1} › “${d.label.replace(/[“”]/g, '"')}” (${d.kind ? `${d.kind}, ` : ""}id ${d.id})`,
    );
  if (parts.length === 0) return text;
  return `Kapsam: ${parts.join(", ")}. Yalnızca bu katmanları değiştir; diğerlerini olduğu gibi bırak.\n${text}`;
}

/** Saved from the canvas: the version has a Wecra document (or its slides are canvas renders). */
export function isCanvasVersion(
  version:
    | (Pick<ContentVersion, "version"> & Partial<Pick<ContentVersion, "slides" | "editorDocument">>)
    | null,
): boolean {
  if (!version) return false;
  return version.editorDocument?.kind === "wecra" || canvasOrigin(version.slides?.[0]?.html).canvas;
}

/**
 * The note a request about a canvas version carries (S1): the design is the Wecra document, edited
 * with the canvas tools. Word for word on the iPhone (`CanvasOrigin.referenceNote`).
 */
export function canvasNote(version: number): string {
  return `(v${version} Mac'teki tasarım tuvalinde kaydedildi: tasarım bu sürümün Wecra belgesidir, tuvalde elle yapılan değişiklikler onda. Değişikliği canvas_outline ile okuyup canvas_edit ile yap; HTML'den yeniden üretme.)`;
}

/** The note a request about an SVG engine version carries: it is revised from its SVG. */
export function svgNote(version: number): string {
  return `(v${version} SVG motoruyla üretildi: tasarım bu sürümün SVG'sidir ve yalnızca sohbetten düzenlenir. Değişikliği revise_post ile yap.)`;
}

/** The note a request about a code engine version carries: it is revised from its program. */
export function codeNote(version: number): string {
  return `(v${version} kod motoruyla üretildi: tasarım bu sürümün Python programıdır ve yalnızca sohbetten düzenlenir. Değişikliği revise_post ile yap.)`;
}

/**
 * What every message says about the post it is about (E17: the current version each time). A
 * version saved from the canvas adds that its Wecra document is the design (`canvasNote`).
 */
export function postReference(
  content: Pick<Content, "id" | "title">,
  version:
    | (Pick<ContentVersion, "version"> & Partial<Pick<ContentVersion, "slides" | "editorDocument">>)
    | null,
): string {
  const head = `“${content.title}” postu (id: ${content.id}${version ? `, güncel sürüm v${version.version}` : ""}) için:`;
  const chatOnly = chatOnlyEngineOf(version?.slides);
  if (version && chatOnly === "svg") return `${head}\n${svgNote(version.version)}`;
  if (version && chatOnly === "code") return `${head}\n${codeNote(version.version)}`;
  if (!version || !isCanvasVersion(version)) return head;
  return `${head}\n${canvasNote(version.version)}`;
}

/** The text sent for a request: the post's reference (every message), the scope, the request. */
export function postChatText(options: {
  content: Pick<Content, "id" | "title">;
  version:
    | (Pick<ContentVersion, "version"> & Partial<Pick<ContentVersion, "slides" | "editorDocument">>)
    | null;
  text: string;
  scope: readonly string[];
  describe: (key: string) => ScopeLayer | null;
}): string {
  const scoped = scopedInstruction(options.text, options.scope, options.describe);
  return `${postReference(options.content, options.version)}\n${scoped}`;
}

/**
 * The post's current version as the API has it now (after the canvas's own save): what the agent
 * edits. `known`: the version in hand (reused when it is that one); null when unreadable.
 */
export async function currentVersion(
  api: Pick<ApiClient, "contents">,
  contentId: string,
  known: ContentVersion | null,
): Promise<ContentVersion | null> {
  try {
    const content = await api.contents.get(contentId);
    const number = content.currentVersion?.version;
    if (!number) return null;
    if (known?.version === number) return known;
    return await api.contents.versions.get(contentId, number);
  } catch {
    return known;
  }
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
  describe(key: string): ScopeLayer | null;
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
        o.notify(
          "Tuvaldeki değişiklikler sürüm olarak kaydedilemedi; mesaj gönderilmedi.",
          "error",
        );
        return false;
      }
      let id = useWorkspaceStore.getState().chats[o.content.id] ?? null;
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
      // The version the flush may just have made is the one the agent edits (E17).
      const version = await currentVersion(api, o.content.id, o.version);
      const body = postChatText({
        content: o.content,
        version,
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
