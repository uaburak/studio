// Older messages of a conversation (a snapshot holds only the newest ones): "load older", going to
// a message that is not loaded yet (Onay bekleyenler, "Onaya git"), and `@` names in the post
// dock's message box.
import type {
  ApiClient,
  ConversationStreamMessage,
  MentionCandidate as EntityCandidate,
  Message,
} from "@studio/contract";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo, useRef, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OlderMessages,
  TranscriptItems,
  useOlderMessages,
} from "../../src/renderer/components/chat/chat-view.tsx";
import type { PostChat } from "../../src/renderer/features/post-editor/chat.ts";
import { ChatPanel } from "../../src/renderer/features/post-editor/ui/chat-panel.tsx";
import {
  ChatInput,
  dockMentionOptions,
} from "../../src/renderer/features/post-editor/ui/mode-dock.tsx";
import type { ChatLayers } from "../../src/renderer/features/post-editor/wecra/scope.ts";
import { chatMentionCandidates } from "../../src/renderer/lib/composer.ts";
import { buildTranscript } from "../../src/renderer/lib/transcript.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import {
  ConversationController,
  keepOlderMessages,
} from "../../src/renderer/state/conversation.ts";
import { focusMessage, useFocusRequests } from "../../src/renderer/state/focus-requests.ts";
import { alias, conversation, message, presence, state, text } from "./fixtures.ts";

afterEach(() => {
  useFocusRequests.setState({ message: null, product: null });
  useAppStore.setState({ route: { kind: "new" }, back: [], forward: [] });
});

const deps = { choice: () => ({ model: "opus", effort: "high" }) as never, saveChoice: () => {} };

/** Messages m000 … m(n-1), oldest first (ids sort like the API's UUIDv7). */
function history(n: number): Message[] {
  return Array.from({ length: n }, (_, i) =>
    message(`m${String(i).padStart(3, "0")}`, i % 2 ? "assistant" : "user", [text(`mesaj ${i}`)]),
  );
}

function snapshotOf(messages: Message[], hasMore: boolean, seq = 1): ConversationStreamMessage {
  return {
    type: "conversation.snapshot",
    seq,
    conversation: conversation(),
    messages,
    hasMoreMessages: hasMore,
    activeRun: null,
    plans: [],
    aliases: [],
    presence,
  };
}

/** A fake API over `all` (oldest first): GET .../messages pages newest first, cursor = an id. */
function pagedClient(all: Message[]) {
  const list = vi.fn(async (_id: string, query?: { limit?: number; cursor?: string }) => {
    const limit = query?.limit ?? 20;
    const before = query?.cursor ? all.filter((m) => m.id < (query.cursor as string)) : [...all];
    const newestFirst = before.reverse();
    const items = newestFirst.slice(0, limit);
    return {
      items,
      nextCursor: newestFirst.length > limit ? (items.at(-1)?.id ?? null) : null,
    };
  });
  const client = {
    conversations: { watch: vi.fn(() => ({ close: vi.fn() })), messages: { list } },
  } as unknown as ApiClient;
  return { client, list };
}

describe("older messages", () => {
  it("loads the page before the oldest message and says when there is no more", async () => {
    const all = history(130);
    const { client, list } = pagedClient(all);
    const controller = new ConversationController("c1", client, deps);
    controller.apply(snapshotOf(all.slice(-50), true));

    const loading = controller.loadOlder();
    expect(controller.getSnapshot().loadingOlder).toBe(true);
    expect(await loading).toBe(true);
    expect(list).toHaveBeenLastCalledWith("c1", { limit: 100, cursor: "m080" });
    let s = controller.getSnapshot();
    expect(s.loadingOlder).toBe(false);
    expect(s.state?.messages).toHaveLength(130);
    expect(s.state?.messages[0]?.id).toBe("m000");
    // The 80 before m080 fit in one page: nothing older is left.
    expect(s.state?.hasMoreMessages).toBe(false);

    expect(await controller.loadOlder()).toBe(false);
    s = controller.getSnapshot();
    expect(s.state?.messages.map((m) => m.id)).toEqual(all.map((m) => m.id));
  });

  it("keeps a failed load's reason and tries again", async () => {
    const all = history(60);
    const { client, list } = pagedClient(all);
    list.mockRejectedValueOnce(new Error("Sunucu yanıt vermedi"));
    const controller = new ConversationController("c1", client, deps);
    controller.apply(snapshotOf(all.slice(-50), true));
    expect(await controller.loadOlder()).toBe(false);
    expect(controller.getSnapshot().olderError).toBe("Sunucu yanıt vermedi");
    expect(await controller.loadOlder()).toBe(true);
    expect(controller.getSnapshot().olderError).toBeNull();
    expect(controller.getSnapshot().state?.messages).toHaveLength(60);
  });

  it("pages back until a message is there (or there is nothing older)", async () => {
    const all = history(320);
    const { client, list } = pagedClient(all);
    const controller = new ConversationController("c1", client, deps);
    controller.apply(snapshotOf(all.slice(-50), true));
    expect(await controller.ensureMessage("m310")).toBe(true);
    expect(list).not.toHaveBeenCalled();
    expect(await controller.ensureMessage("m005")).toBe(true);
    expect(list).toHaveBeenCalledTimes(3);
    expect(controller.getSnapshot().state?.messages[0]?.id).toBe("m000");
    expect(await controller.ensureMessage("yok")).toBe(false);
  });

  it("keeps the loaded older messages across a reconnect snapshot that overlaps them", () => {
    const all = history(200);
    const before = state({ messages: all.slice(50), hasMoreMessages: true });
    const after = state({ messages: all.slice(-50), hasMoreMessages: true, seq: 9 });
    const merged = keepOlderMessages(before, after);
    expect(merged.messages.map((m) => m.id)).toEqual(all.slice(50).map((m) => m.id));
    // No overlap (many new messages meanwhile): the snapshot as it is.
    const far = state({ messages: [message("x1", "user", [text("yeni")])], hasMoreMessages: true });
    expect(keepOlderMessages(before, far)).toBe(far);

    const { client } = pagedClient(all);
    const controller = new ConversationController("c1", client, deps);
    controller.apply(snapshotOf(all.slice(100), true));
    controller.apply(snapshotOf(all.slice(-50), true, 5));
    expect(controller.getSnapshot().state?.messages).toHaveLength(100);
  });
});

/** A transcript the way ChatView builds it, over a live controller. */
function Transcript({ controller }: { controller: ConversationController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const items = useMemo(
    () =>
      buildTranscript({ hasState: snapshot.state !== null, messages: snapshot.state?.messages }),
    [snapshot.state],
  );
  return (
    <TranscriptItems
      items={items}
      aliases={[]}
      controller={controller}
      onMention={() => {}}
      onEditPlan={() => {}}
      onEditQueued={() => {}}
    />
  );
}

describe("going to a message that is not loaded yet", () => {
  it("loads older pages until it is there, then highlights it", async () => {
    const all = history(180);
    const { client, list } = pagedClient(all);
    const controller = new ConversationController("c1", client, deps);
    controller.apply(snapshotOf(all.slice(-50), true));
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<Transcript controller={controller} />);
    expect(document.querySelector('[data-message-id="m010"]')).toBeNull();

    act(() => focusMessage("c1", "m010"));
    await waitFor(() =>
      expect(document.querySelector('[data-message-id="m010"]')).toHaveAttribute(
        "data-highlighted",
        "true",
      ),
    );
    expect(list).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect(useFocusRequests.getState().message).toBeNull();
  });

  it("drops the request when the message is not in the conversation", async () => {
    const all = history(60);
    const { client } = pagedClient(all);
    const controller = new ConversationController("c1", client, deps);
    controller.apply(snapshotOf(all.slice(-50), true));
    render(<Transcript controller={controller} />);
    act(() => focusMessage("c1", "silinmis"));
    await waitFor(() => expect(useFocusRequests.getState().message).toBeNull());
    expect(document.querySelector("[data-highlighted]")).toBeNull();
  });
});

// --- the post dock's @ -----------------------------------------------------------------------------

const entities: EntityCandidate[] = [
  {
    kind: "product",
    id: "p1",
    slug: "boro",
    label: "Boro",
    imageAssetId: null,
    detail: "Gübre",
    pendingApprovals: 0,
  },
  {
    kind: "content",
    id: "k1",
    slug: "hasat-postu",
    label: "Hasat postu",
    imageAssetId: null,
    detail: "draft",
    pendingApprovals: 0,
  },
];

const layers: ChatLayers = {
  selection: [],
  label: (key) => (key === "1:2" ? "Başlık" : key),
  search: (q) =>
    [{ key: "1:2", label: "Başlık", detail: "Kare 1" }].filter((l) =>
      l.label.toLocaleLowerCase("tr-TR").includes(q.toLocaleLowerCase("tr-TR")),
    ),
  deselect: () => {},
};

describe("@ in the post dock", () => {
  it("offers the layers, then the chat's files, products and posts", () => {
    const names = chatMentionCandidates([alias("image")], entities);
    const all = dockMentionOptions(layers.search(""), names, "");
    expect(all.map((o) => (o.type === "layer" ? `layer:${o.key}` : o.candidate.alias))).toEqual([
      "layer:1:2",
      "image",
      "boro",
      "hasat-postu",
    ]);
    const bo = dockMentionOptions(layers.search("bö"), names, "Bö");
    expect(bo.map((o) => (o.type === "name" ? o.candidate.alias : o.key))).toEqual(["boro"]);
    // A layer name with a dot is no product name.
    expect(dockMentionOptions([], names, "a.b")).toEqual([]);
  });

  it("writes a picked product as @name and keeps layer picks as scope chips", async () => {
    const onSend = vi.fn(async () => true);
    render(
      <ChatInput
        layers={layers}
        working={false}
        disabled={null}
        mentions={chatMentionCandidates([], entities)}
        onSend={onSend}
        onStop={() => {}}
      />,
    );
    const box = screen.getByRole("textbox", { name: "Post hakkında yaz" });
    fireEvent.change(box, { target: { value: "@bo", selectionStart: 3 } });
    expect(await screen.findByRole("option", { name: /Boro/ })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveValue("@boro ");

    fireEvent.change(box, { target: { value: "@boro rengi @baş", selectionStart: 16 } });
    expect(await screen.findByRole("option", { name: /Başlık/ })).toBeInTheDocument();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveValue("@boro rengi ");
    expect(screen.getByText("@Başlık")).toBeInTheDocument();

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("@boro rengi", ["1:2"]));
  });

  it("shows a sent message's products and posts as chips in the post's chat", () => {
    const controller = new ConversationController("c1", pagedClient([]).client, deps);
    controller.apply(
      snapshotOf(
        [
          message("u1", "user", [text("@boro için @hasat-postu gibi")], {
            entityMentions: [
              { kind: "product", id: "p1", name: "boro", start: 0, end: 5 },
              { kind: "content", id: "k1", name: "hasat-postu", start: 11, end: 23 },
            ],
          }),
        ],
        false,
      ),
    );
    const chat: PostChat = {
      conversationId: "c1",
      controller,
      snapshot: controller.getSnapshot(),
      working: false,
      choice: deps.choice(),
      setChoice: null,
      send: async () => true,
      stop: () => {},
      restart: () => {},
    };
    render(<ChatPanel chat={chat} onStarter={() => {}} />);
    expect(screen.getByRole("button", { name: "Ürün @boro" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post @hasat-postu" })).toBeInTheDocument();
  });
});

/** A scroller wired like ChatView's (older messages at its top). */
function Scroller({ controller }: { controller: ConversationController }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const scroller = useRef<HTMLDivElement | null>(null);
  const older = useOlderMessages(controller, snapshot, scroller);
  return (
    <div
      ref={scroller}
      data-testid="scroller"
      onScroll={older.onScroll}
      onWheel={older.onUserScroll}
    >
      <OlderMessages snapshot={snapshot} onLoad={older.load} />
      <p data-testid="count">{snapshot.state?.messages.length}</p>
    </div>
  );
}

describe("load older messages", () => {
  it("loads from the button and when the reader scrolls up to the top, keeping the view", async () => {
    const all = history(260);
    const { client } = pagedClient(all);
    const controller = new ConversationController("c1", client, deps);
    controller.apply(snapshotOf(all.slice(-50), true));
    render(<Scroller controller={controller} />);
    const el = screen.getByTestId("scroller");
    // 40 px per message.
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      get: () => Number(screen.getByTestId("count").textContent) * 40,
    });

    el.scrollTop = 300;
    fireEvent.click(screen.getByRole("button", { name: "Önceki mesajlar" }));
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("150"));
    // 2000 − 300 from the end before; the same after the page landed above.
    expect(el.scrollTop).toBe(6000 - 1700);

    // A scroll the view makes (no wheel) near the top loads nothing.
    el.scrollTop = 100;
    fireEvent.scroll(el);
    expect(controller.getSnapshot().loadingOlder).toBe(false);
    // The reader's wheel up to the top does.
    fireEvent.wheel(el, { deltaY: -40 });
    fireEvent.scroll(el);
    await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("250"));
    expect(el.scrollTop).toBe(10_000 - 5900);
    expect(screen.getByRole("button", { name: "Önceki mesajlar" })).toBeInTheDocument();
  });
});
