// The post workspace inside the app's layout: opening a post turns the centre into Wecra's
// canvas and the right panel into the post's panel (Wecra's Design panel, the caption, the
// Sohbet), Wecra's Layers sit on a card on the canvas, the dock carries Wecra's tools or the
// message box, back is only the app's (the title area has no back of its own), the Sohbet /
// Düzenle mode is remembered per post, and the Sohbet is a conversation bound to the post.
// Wecra's editor itself (WebGL, the engine) is stood in for here: test/engine drives the real one.
import type { ApiClient, Content, ContentVersion } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Wecra's components in Studio's places, stood in for (jsdom has no WebGL): the canvas is up at
// once on the session's document, the import has nothing to read.
vi.mock("../../src/renderer/features/post-editor/wecra/host.tsx", () => ({
  WecraEditor: ({ source, onReady }: { source: unknown; onReady?: (ed: unknown) => void }) => {
    useEffect(() => {
      onReady?.({
        source,
        store: { page: "0:1" },
        engine: {
          destroyed: false,
          command: () => 0,
          readNode: () => null,
          readNodes: () => [],
          setSelection: () => 0,
        },
        withRealType: (n: unknown) => n,
        focusCanvas: () => {},
      });
    }, [source, onReady]);
    return <div data-testid="wecra-canvas" data-wecra-region="canvas" />;
  },
  WecraScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  WecraDesignPanel: () => <section aria-label="Wecra Tasarım paneli" />,
  WecraLayers: () => <div role="tree" aria-label="Wecra katmanları" />,
  WecraToolbar: () => <div role="toolbar" aria-label="Wecra araçları" />,
  WecraZoomMenu: () => <button type="button">100%</button>,
}));
vi.mock("../../src/renderer/features/post-editor/wecra/import.ts", () => ({
  captureSlides: async () => [],
  importSlides: async () => [],
}));
vi.mock("../../src/renderer/features/post-editor/wecra/fonts.ts", () => ({
  installStudioFonts: () => {},
}));
vi.mock("@/engine/hooks", () => ({
  useTool: () => "MOVE",
  useSelection: () => ({ pageId: "0:1", refs: [] }),
}));

import { RightPanel } from "../../src/renderer/components/panels/right-panel.tsx";
import { PostEditor } from "../../src/renderer/features/post-detail/editor.ts";
import { PostDetailLayer } from "../../src/renderer/features/post-detail/post-detail.tsx";
import { postChatText, scopedInstruction } from "../../src/renderer/features/post-editor/chat.ts";
import { DemoChat } from "../../src/renderer/features/post-editor/demo/chat-fixtures.ts";
import { WorkspaceSlot } from "../../src/renderer/features/post-editor/slots.tsx";
import { ModeDock } from "../../src/renderer/features/post-editor/ui/mode-dock.tsx";
import {
  DEFAULT_MODE,
  modeOf,
  openedView,
  useWorkspaceStore,
  type WorkspaceMode,
} from "../../src/renderer/features/post-editor/workspace-store.ts";
import { postKeys } from "../../src/renderer/features/posts/data.ts";
import { usePostsStore } from "../../src/renderer/features/posts/store.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { sessionOf, useAppStore } from "../../src/renderer/state/app-store.ts";
import { contentFor, FakeContentApi, hashedVersion } from "./post-fixtures.ts";

const TITLE = "Hasat sonrası toprak bakımı";

function resetStores() {
  localStorage.clear();
  useWorkspaceStore.setState({
    modes: {},
    chats: {},
    layersOpen: true,
    editTab: "design",
    active: null,
  });
  useAppStore.setState({
    route: { kind: "posts" },
    post: null,
    back: [],
    forward: [],
    panelPresented: false,
    panelPane: "calendar",
    panelReturn: null,
    toasts: [],
    lightbox: null,
  });
  usePostsStore.setState({ opened: null, selectedId: null, deleting: null });
}

beforeEach(resetStores);
beforeAll(async () => {
  await import("../../src/renderer/features/post-editor/workspace.tsx");
}, 30_000);
afterEach(() => {
  vi.restoreAllMocks();
});

// --- state -----------------------------------------------------------------------------------

describe("workspace state", () => {
  it("opens a post on Düzenle and remembers the mode per post on this Mac", () => {
    const s = useWorkspaceStore.getState();
    expect(DEFAULT_MODE).toBe("edit");
    expect(modeOf(s, "p1")).toBe("edit");
    s.setMode("p1", "chat");
    expect(modeOf(useWorkspaceStore.getState(), "p1")).toBe("chat");
    expect(modeOf(useWorkspaceStore.getState(), "p2")).toBe("edit");
    // Another window (or a restart) reads the same memory.
    useWorkspaceStore.setState({ modes: {} });
    useWorkspaceStore.getState().reload();
    expect(modeOf(useWorkspaceStore.getState(), "p1")).toBe("chat");
    expect(JSON.parse(localStorage.getItem("studio.post-workspace.modes") ?? "{}")).toEqual({
      p1: "chat",
    });
  });

  it("puts posts with slides on the canvas and keeps reels in the detail", () => {
    expect(openedView({ type: "carousel" })).toBe("canvas");
    expect(openedView({ type: "post" })).toBe("canvas");
    expect(openedView({ type: "story" })).toBe("canvas");
    expect(openedView({ type: "reel" })).toBe("detail");
  });

  it("lends the right panel to the open post and gives it back", () => {
    const app = useAppStore.getState();
    app.showPostPanel();
    let s = useAppStore.getState();
    expect(s.panelPresented).toBe(true);
    expect(s.panelPane).toBe("post");
    // The session never saves the post's panel: it saves what the post took over.
    expect(sessionOf(s).panelPane).toBe("calendar");
    expect(sessionOf(s).panelPresented).toBe(false);
    s.releasePostPanel();
    s = useAppStore.getState();
    expect(s.panelPresented).toBe(false);
    expect(s.panelPane).toBe("calendar");
    // A pane picked while the post was open stays.
    s.showPostPanel();
    useAppStore.getState().togglePanel("media");
    useAppStore.getState().releasePostPanel();
    expect(useAppStore.getState().panelPane).toBe("media");
    expect(useAppStore.getState().panelPresented).toBe(true);
  });

  it("writes the post's reference on the first message and the scope on every one", () => {
    const describe = (key: string) =>
      key === "0:headline" ? { slide: 0, id: "headline", label: "Başlık" } : null;
    const first = postChatText({
      first: true,
      content: { id: "p1", title: TITLE },
      version: { version: 3 },
      text: "Kısalt",
      scope: ["0:headline"],
      describe,
    });
    expect(first).toBe(
      `“${TITLE}” postu (id: p1, v3) için:\n${scopedInstruction("Kısalt", ["0:headline"], describe)}`,
    );
    expect(first).toContain("Kapsam: Kare 1 › headline (Başlık)");
    const later = postChatText({
      first: false,
      content: { id: "p1", title: TITLE },
      version: { version: 3 },
      text: "Biraz daha",
      scope: [],
      describe,
    });
    expect(later).toBe("Biraz daha");
  });
});

// --- the dock ---------------------------------------------------------------------------------

describe("mode dock", () => {
  function Dock({ onMode }: { onMode(mode: WorkspaceMode): void }) {
    const [mode, setMode] = useState<WorkspaceMode>("edit");
    return (
      <ModeDock
        mode={mode}
        onMode={(m) => {
          onMode(m);
          setMode(m);
        }}
        edit={
          <div role="toolbar" aria-label="Araçlar">
            <button type="button">Seç</button>
          </div>
        }
        chat={<textarea aria-label="Post hakkında yaz" />}
      />
    );
  }

  it("is one object: tools on Düzenle, the message box on Sohbet, the switch on its right", async () => {
    const onMode = vi.fn();
    render(<Dock onMode={onMode} />);
    const dock = screen.getByTestId("mode-dock");
    expect(dock).toHaveAttribute("data-mode", "edit");
    expect(within(dock).getByRole("toolbar", { name: "Araçlar" })).toBeInTheDocument();
    expect(within(dock).queryByRole("textbox")).toBeNull();
    const modes = within(dock).getByRole("radiogroup", { name: "Mod" });
    expect(within(modes).getByRole("radio", { name: /Düzenle/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await userEvent.click(within(modes).getByRole("radio", { name: /Sohbet/ }));
    expect(onMode).toHaveBeenLastCalledWith("chat");
    // The same object (no second dock), now the message box.
    expect(screen.getAllByTestId("mode-dock")).toHaveLength(1);
    expect(screen.getByTestId("mode-dock")).toBe(dock);
    expect(dock).toHaveAttribute("data-mode", "chat");
    expect(within(dock).getByRole("textbox", { name: "Post hakkında yaz" })).toBeInTheDocument();
    await waitFor(() => expect(within(dock).queryByRole("toolbar")).toBeNull());

    // ← → move the switch too.
    fireEvent.keyDown(within(modes).getByRole("radio", { name: /Sohbet/ }), { key: "ArrowRight" });
    expect(onMode).toHaveBeenLastCalledWith("edit");
    expect(await within(dock).findByRole("toolbar", { name: "Araçlar" })).toBeInTheDocument();
    await waitFor(() => expect(within(dock).queryByRole("textbox")).toBeNull());
  });
});

// --- the open post ---------------------------------------------------------------------------

async function setup(options: { type?: Content["type"] } = {}) {
  const fake = new FakeContentApi();
  const v1 = await hashedVersion("p1", 1);
  const c = contentFor(v1, { targetPlatforms: ["instagram"], type: options.type ?? "post" });
  fake.add(c, [v1]);
  const chat = new DemoChat();
  chat.replyMs = 30;
  chat.reply = () => "Başlığı kısalttım.";
  const api = {
    ...fake.api,
    conversations: chat.conversations,
    agentRuns: chat.agentRuns,
    brandProfiles: {
      current: async () => {
        throw Object.assign(new Error("no profile"), { status: 404 });
      },
    },
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The board's copy and the version (the app has them cached when a card is opened).
  queryClient.setQueryData(postKeys.content("p1"), c);
  queryClient.setQueryData(postKeys.version("p1", 1), v1 as ContentVersion);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api as unknown as ApiClient}>
        <Harness />
      </ApiContext.Provider>
    </QueryClientProvider>,
  );
  return { fake, chat, view };
}

/** The shell's parts the post renders into, the board under it, and the right panel. */
function Harness() {
  const pane = useAppStore((s) => s.panelPane);
  const presented = useAppStore((s) => s.panelPresented);
  return (
    <div>
      <header>
        <WorkspaceSlot name="title" />
        <WorkspaceSlot name="panel-header" />
      </header>
      <div style={{ position: "relative" }}>
        <section aria-label="Postlar">Tahta</section>
        <PostDetailLayer />
      </div>
      {presented && pane === "post" ? <RightPanel width={357} /> : null}
    </div>
  );
}

const workspace = () => screen.queryByRole("region", { name: `Post: ${TITLE}` });
const slot = (name: string) =>
  document.querySelector(`[data-workspace-slot="${name}"]`) as HTMLElement;

async function openPost() {
  act(() => usePostsStore.getState().open("p1"));
  // The workspace (with Wecra's editor) is loaded with the first post opened.
  await waitFor(() => expect(workspace()).toBeInTheDocument(), { timeout: 15_000 });
}

describe("opening a post", () => {
  it("turns the centre into Wecra's canvas and the right panel into the post's panel; back returns", async () => {
    await setup();
    await openPost();
    // Wecra's canvas, its Layers on the canvas's card, the dock with Wecra's tools (Düzenle).
    expect(await screen.findByTestId("wecra-canvas")).toBeInTheDocument();
    const card = await screen.findByRole("complementary", { name: "Katmanlar" });
    expect(within(card).getByRole("tree", { name: "Wecra katmanları" })).toBeInTheDocument();
    expect(screen.getByTestId("mode-dock")).toHaveAttribute("data-mode", "edit");
    expect(screen.getByRole("toolbar", { name: "Wecra araçları" })).toBeInTheDocument();
    // The shell shows the post: its title area, its panel (Tasarım: Wecra's Design panel).
    expect(useWorkspaceStore.getState().active).toBe("p1");
    expect(useAppStore.getState().panelPane).toBe("post");
    expect(useAppStore.getState().panelPresented).toBe(true);
    expect(
      within(slot("title")).getByRole("button", { name: new RegExp(TITLE) }),
    ).toBeInTheDocument();
    expect(within(slot("title")).getByRole("button", { name: "Onayla" })).toBeInTheDocument();
    expect(within(slot("panel-header")).getByRole("radio", { name: "Tasarım" })).toBeChecked();
    expect(within(slot("panel-header")).getByRole("button", { name: "100%" })).toBeInTheDocument();
    expect(
      await within(slot("panel")).findByRole("region", { name: "Wecra Tasarım paneli" }),
    ).toBeInTheDocument();
    // No post detail in between.
    expect(screen.queryByRole("dialog", { name: /Açık post/ })).toBeNull();

    // Back (⌘[ / the top bar's back) returns to the board and gives the panel back.
    act(() => useAppStore.getState().goBack());
    await waitFor(() => expect(workspace()).toBeNull());
    expect(usePostsStore.getState().opened).toBeNull();
    expect(useWorkspaceStore.getState().active).toBeNull();
    expect(useAppStore.getState().panelPane).toBe("calendar");
    expect(useAppStore.getState().panelPresented).toBe(false);
    expect(screen.getByRole("region", { name: "Postlar" })).toBeInTheDocument();
  });

  it("has exactly one back: the app's (no back or close of its own in the title or the canvas)", async () => {
    await setup();
    await openPost();
    await screen.findByTestId("wecra-canvas");
    const back = /dön|^Geri|Kapat|Postlar/;
    expect(within(slot("title")).queryAllByRole("button", { name: back })).toEqual([]);
    expect(within(workspace() as HTMLElement).queryAllByRole("button", { name: back })).toEqual([]);
  });

  it("folds the layers card into a pill and back (remembered)", async () => {
    await setup();
    await openPost();
    const card = await screen.findByRole("complementary", { name: "Katmanlar" });
    await userEvent.click(within(card).getByRole("button", { name: "Katmanları gizle" }));
    expect(screen.queryByRole("complementary", { name: "Katmanlar" })).toBeNull();
    expect(useWorkspaceStore.getState().layersOpen).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Katmanları göster" }));
    expect(screen.getByRole("complementary", { name: "Katmanlar" })).toBeInTheDocument();
  });

  it("remembers Sohbet for the post and opens it there next time", async () => {
    await setup();
    await openPost();
    await userEvent.click(screen.getByRole("radio", { name: /Sohbet/ }));
    expect(screen.getByTestId("mode-dock")).toHaveAttribute("data-mode", "chat");
    expect(within(slot("panel")).getByText("Bu post hakkında sohbet")).toBeInTheDocument();
    expect(modeOf(useWorkspaceStore.getState(), "p1")).toBe("chat");

    act(() => useAppStore.getState().goBack());
    await waitFor(() => expect(workspace()).toBeNull());
    await openPost();
    expect(screen.getByTestId("mode-dock")).toHaveAttribute("data-mode", "chat");
    expect(screen.getByRole("radio", { name: /Sohbet/ })).toHaveAttribute("aria-checked", "true");
    expect(within(slot("panel")).getByText("Bu post hakkında sohbet")).toBeInTheDocument();
  });

  it("keeps reels in the post detail (they are edited in chat)", async () => {
    await setup({ type: "reel" });
    act(() => usePostsStore.getState().open("p1"));
    expect(await screen.findByRole("dialog", { name: `Açık post: ${TITLE}` })).toBeInTheDocument();
    expect(workspace()).toBeNull();
    expect(useAppStore.getState().panelPane).toBe("calendar");
  });
});

describe("the post's panel", () => {
  it("switches with the mode and its tabs; a mode switch brings it back over another pane", async () => {
    await setup();
    await openPost();
    // Düzenle › Açıklama: the caption editor.
    await userEvent.click(within(slot("panel-header")).getByRole("radio", { name: "Açıklama" }));
    expect(within(slot("panel")).getByRole("textbox", { name: "Açıklama" })).toHaveValue(
      "Hasat bitti ama iş bitmedi.",
    );
    // Sohbet: the chat panel, the header says so.
    await userEvent.click(screen.getByRole("radio", { name: /Sohbet/ }));
    expect(slot("panel").querySelector('[data-post-panel="chat"]')).not.toBeNull();
    expect(within(slot("panel-header")).getByText("Sohbet")).toBeInTheDocument();
    // Back to Düzenle: the tab picked stays.
    await userEvent.click(screen.getByRole("radio", { name: /Düzenle/ }));
    expect(slot("panel").querySelector('[data-post-panel="edit"]')).not.toBeNull();
    expect(within(slot("panel-header")).getByRole("radio", { name: "Açıklama" })).toBeChecked();
    // Another pane from the top bar; the mode switch brings the post's panel back.
    act(() => useAppStore.getState().togglePanel("calendar"));
    expect(useAppStore.getState().panelPane).toBe("calendar");
    await userEvent.click(screen.getByRole("radio", { name: /Sohbet/ }));
    expect(useAppStore.getState().panelPane).toBe("post");
    expect(useAppStore.getState().panelPresented).toBe(true);
  });
});

describe("the post's Sohbet", () => {
  it("creates the post's conversation, sends with the post's reference, follows the reply", async () => {
    const refresh = vi.spyOn(PostEditor.prototype, "refresh");
    const { chat, fake } = await setup();
    await openPost();
    await screen.findByTestId("wecra-canvas");
    await userEvent.click(screen.getByRole("radio", { name: /Sohbet/ }));
    const dock = screen.getByTestId("mode-dock");
    const input = within(dock).getByRole("textbox", { name: "Post hakkında yaz" });
    await userEvent.type(input, "Kısalt{Enter}");

    await waitFor(() => expect(chat.sent).toHaveLength(1));
    expect(chat.created).toEqual([{ brandId: "b1", title: TITLE }]);
    const conversationId = useWorkspaceStore.getState().chats.p1;
    expect(conversationId).toBeTruthy();
    expect(chat.sent[0]?.conversationId).toBe(conversationId);
    expect(chat.sent[0]?.text).toBe(`“${TITLE}” postu (id: p1, v1) için:\nKısalt`);
    // The transcript is in the panel; the reply's end re-reads the post (new versions land).
    expect(await within(slot("panel")).findByText("Başlığı kısalttım.")).toBeInTheDocument();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(input).toHaveValue("");

    // ⌘↩ in the message box never approves the post.
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", metaKey: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(fake.approveCalls).toHaveLength(0);

    // The next message continues the same conversation, without the post's reference.
    await userEvent.type(input, "Biraz daha{Enter}");
    await waitFor(() => expect(chat.sent).toHaveLength(2));
    expect(chat.created).toHaveLength(1);
    expect(chat.sent[1]).toEqual({ conversationId, text: "Biraz daha" });
  });
});
