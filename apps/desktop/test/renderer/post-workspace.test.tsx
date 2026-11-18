// The post workspace inside the app's layout: opening a post turns the centre into Wecra's
// canvas and the right panel into the post's panel (Wecra's Design panel, the caption, the
// Sohbet), Wecra's Layers sit in the sidebar (where the conversations are otherwise), the dock carries Wecra's tools or the
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
// once on the session's document, the import has nothing to read. `viewerMode` records Wecra's
// read only switch (Engine.setViewerMode).
const viewerMode: boolean[] = [];
vi.mock("../../src/renderer/features/post-editor/wecra/host.tsx", async () => {
  const { encodeMessage, newDocumentMessage } = await import("@shared/schema/codec");
  const kiwi = encodeMessage(newDocumentMessage());
  return {
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
            encodeDocumentKiwi: () => kiwi,
            setViewerMode: (on: boolean) => viewerMode.push(on),
          },
          withRealType: (n: unknown) => n,
          focusCanvas: () => {},
        });
      }, [source, onReady]);
      return <div data-testid="wecra-canvas" data-wecra-region="canvas" tabIndex={-1} />;
    },
    WecraScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    WecraDesignPanel: () => <section aria-label="Wecra Tasarım paneli" />,
    WecraLayers: ({ sidebar }: { sidebar?: boolean }) => (
      <div role="tree" aria-label="Wecra katmanları" data-sidebar={sidebar ? "" : undefined} />
    ),
    WecraToolbar: () => <div role="toolbar" aria-label="Wecra araçları" />,
    WecraZoomMenu: () => <button type="button">100%</button>,
  };
});
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
import { runMenuCommand } from "../../src/renderer/components/shell/app-shell.tsx";
import { PostEditor } from "../../src/renderer/features/post-detail/editor.ts";
import { PostDetailLayer } from "../../src/renderer/features/post-detail/post-detail.tsx";
import { postChatText, scopedInstruction } from "../../src/renderer/features/post-editor/chat.ts";
import { DemoChat } from "../../src/renderer/features/post-editor/demo/chat-fixtures.ts";
import { editLock, unlockWarning } from "../../src/renderer/features/post-editor/edit-lock.ts";
import { WorkspaceSlot } from "../../src/renderer/features/post-editor/slots.tsx";
import { ModeDock } from "../../src/renderer/features/post-editor/ui/mode-dock.tsx";
import {
  BundleImages,
  encodeBundle,
} from "../../src/renderer/features/post-editor/wecra/bundle.ts";
import { ownsEvent } from "../../src/renderer/features/post-editor/wecra/embed.ts";
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
import { flushApp, installAppFlush, registerAppFlush } from "../../src/renderer/lib/app-flush.ts";
import { bridge } from "../../src/renderer/lib/bridge.ts";
import { navKeyTakenByCanvas, swipeBlockedAt } from "../../src/renderer/lib/nav-gestures.ts";
import { sessionOf, useAppStore } from "../../src/renderer/state/app-store.ts";
import { contentFor, FakeContentApi, hashedVersion, T } from "./post-fixtures.ts";

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

async function setup(options: { type?: Content["type"]; status?: Content["status"] } = {}) {
  const fake = new FakeContentApi();
  const v1 = await hashedVersion("p1", 1);
  const c = contentFor(v1, {
    targetPlatforms: ["instagram"],
    type: options.type ?? "post",
    ...(options.status
      ? {
          status: options.status,
          approval: { versionId: v1.id, contentHash: v1.contentHash, approvedAt: T },
        }
      : {}),
  });
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
      <WorkspaceSlot name="sidebar" />
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
    // Wecra's canvas, its Layers in the sidebar, the dock with Wecra's tools (Düzenle).
    expect(await screen.findByTestId("wecra-canvas")).toBeInTheDocument();
    const layers = await within(slot("sidebar")).findByRole("region", { name: "Katmanlar" });
    expect(within(layers).getByRole("tree", { name: "Wecra katmanları" })).toHaveAttribute(
      "data-sidebar",
    );
    // No layers card on the canvas any more.
    expect(within(workspace() as HTMLElement).queryByRole("tree")).toBeNull();
    expect(within(workspace() as HTMLElement).queryByText("Katmanlar")).toBeNull();
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
    // The sidebar's layers go with the post.
    expect(within(slot("sidebar")).queryByRole("region", { name: "Katmanlar" })).toBeNull();
  });

  it("has exactly one back: the app's (no back or close of its own in the title or the canvas)", async () => {
    await setup();
    await openPost();
    await screen.findByTestId("wecra-canvas");
    const back = /dön|^Geri|Kapat|Postlar/;
    expect(within(slot("title")).queryAllByRole("button", { name: back })).toEqual([]);
    expect(within(workspace() as HTMLElement).queryAllByRole("button", { name: back })).toEqual([]);
  });

  it("folds the sidebar's layers under their header and back (remembered)", async () => {
    await setup();
    await openPost();
    const layers = await within(slot("sidebar")).findByRole("region", { name: "Katmanlar" });
    const header = within(layers).getByRole("button", { name: "Katmanlar" });
    expect(header).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(header);
    expect(within(layers).queryByRole("tree")).toBeNull();
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(useWorkspaceStore.getState().layersOpen).toBe(false);
    expect(localStorage.getItem("studio.post-workspace.layers-open")).toBe("0");
    await userEvent.click(header);
    expect(within(layers).getByRole("tree", { name: "Wecra katmanları" })).toBeInTheDocument();
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

// --- read only, keys, gestures, flush ----------------------------------------------------------

describe("the canvas read only (E3)", () => {
  it("opens an approved post locked; Düzenle says what it costs, then unlocks", async () => {
    await setup({ status: "approved" });
    await openPost();
    await screen.findByTestId("wecra-canvas");
    const notice = await screen.findByRole("status", { name: "Salt okunur" });
    expect(notice).toHaveTextContent("Onaylı post; tuval kilitli.");
    // Wecra's viewer mode is on; the dock has no tools.
    await waitFor(() => expect(viewerMode.at(-1)).toBe(true));
    expect(screen.queryByRole("toolbar", { name: "Wecra araçları" })).toBeNull();
    expect(within(screen.getByTestId("mode-dock")).getByText("Salt okunur")).toBeInTheDocument();

    await userEvent.click(within(notice).getByRole("button", { name: "Düzenle" }));
    const dialog = await screen.findByRole("dialog", { name: "Düzenlemeye açılsın mı?" });
    expect(dialog).toHaveTextContent(/onay kalkar/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Düzenle" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Salt okunur" })).toBeNull());
    expect(viewerMode.at(-1)).toBe(false);
    expect(screen.getByRole("toolbar", { name: "Wecra araçları" })).toBeInTheDocument();
  });

  it("never unlocks a published post; it offers a copy instead", async () => {
    await setup({ status: "published" });
    await openPost();
    const notice = await screen.findByRole("status", { name: "Salt okunur" });
    expect(notice).toHaveTextContent(/Yayınlandı/);
    expect(within(notice).queryByRole("button", { name: "Düzenle" })).toBeNull();
    expect(within(notice).getByRole("button", { name: "Kopyasını oluştur" })).toBeInTheDocument();
  });

  it("knows why the canvas is locked and what unlocks it", async () => {
    const v1 = await hashedVersion("p1", 1);
    const v2 = await hashedVersion("p1", 2);
    const base = new PostEditor({} as never, contentFor(v2), v2).getSnapshot();
    expect(editLock(base)).toBeNull();
    const approved = { ...base, content: { ...base.content, status: "approved" as const } };
    expect(editLock(approved)).toMatchObject({ kind: "approval", status: "approved" });
    expect(editLock(approved, { unlocked: true })).toBeNull();
    expect(
      editLock({ ...base, content: { ...base.content, status: "scheduled" as const } }),
    ).toMatchObject({ kind: "approval", status: "scheduled" });
    expect(
      editLock(
        { ...base, content: { ...base.content, status: "publishing" as const } },
        {
          unlocked: true,
        },
      ),
    ).toMatchObject({ kind: "publishing" });
    // An older version is looked at ("Bu sürüme dön" makes it current).
    expect(editLock({ ...base, displayed: v1 })).toMatchObject({
      kind: "old-version",
      shown: 1,
      current: 2,
    });
    // An AI run that may make a version: the canvas waits.
    expect(editLock(base, { chatWorking: true })).toMatchObject({ kind: "busy" });
    expect(editLock(base, { jobRunning: true })).toMatchObject({ kind: "busy" });
    expect(editLock({ ...base, activity: { kind: "revising", message: "" } })).toMatchObject({
      kind: "busy",
    });
    // Düzenle's warning names the schedules it cancels.
    expect(unlockWarning("approved", [])).toMatch(/onay kalkar/);
    expect(unlockWarning("scheduled", ["Instagram @mtmagro · 18 Kas 10:00"])).toMatch(
      /iptal edilir: Instagram @mtmagro · 18 Kas 10:00/,
    );
  });
});

describe("keys and gestures on the canvas (E8)", () => {
  it("keeps ⌘[ / ⌘] on the canvas for Wecra; elsewhere they go back", async () => {
    await setup();
    await openPost();
    const canvas = await screen.findByTestId("wecra-canvas");
    // Wecra's own key handler takes them only on the canvas and its layers.
    const bracket = (target: EventTarget) =>
      Object.defineProperty(
        new KeyboardEvent("keydown", { key: "[", code: "BracketLeft", metaKey: true }),
        "target",
        { value: target },
      );
    expect(ownsEvent(bracket(canvas))).toBe(true);
    expect(ownsEvent(bracket(document.body))).toBe(false);

    // On the canvas: used (the menu's Geri that carries the key does nothing).
    expect(fireEvent.keyDown(canvas, { key: "[", code: "BracketLeft", metaKey: true })).toBe(false);
    expect(navKeyTakenByCanvas()).toBe(true);
    act(() => runMenuCommand("back"));
    expect(workspace()).toBeInTheDocument();

    // On a Studio control the key is the app's: back.
    const title = within(slot("title")).getByRole("button", { name: new RegExp(TITLE) });
    await new Promise((r) => setTimeout(r, 650));
    expect(fireEvent.keyDown(title, { key: "[", code: "BracketLeft", metaKey: true })).toBe(true);
    act(() => runMenuCommand("back"));
    await waitFor(() => expect(workspace()).toBeNull());
  });

  it("treats a sideways two-finger pan over the canvas as the canvas's, not back", async () => {
    await setup();
    await openPost();
    const canvas = await screen.findByTestId("wecra-canvas");
    expect(swipeBlockedAt(canvas)).toBe(true);
    // The rest of the window still swipes.
    expect(swipeBlockedAt(within(slot("title")).getAllByRole("button")[0] ?? null)).toBe(false);
  });
});

describe("close / quit flush (E14)", () => {
  it("answers the main process once every open post wrote its draft", async () => {
    const order: string[] = [];
    const off = registerAppFlush({
      flush: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push("draft");
      },
      flushSync: () => order.push("sync"),
    });
    let request: ((id: number) => void) | null = null;
    const flushDone = vi.fn((id: number) => order.push(`done ${id}`));
    const uninstall = installAppFlush({
      onFlushRequest: (l) => {
        request = l;
        return () => {
          request = null;
        };
      },
      flushDone,
    });
    (request as ((id: number) => void) | null)?.(7);
    await waitFor(() => expect(flushDone).toHaveBeenCalledWith(7));
    expect(order).toEqual(["draft", "done 7"]);
    // A reload: written without waiting.
    window.dispatchEvent(new Event("beforeunload"));
    expect(order.at(-1)).toBe("sync");
    uninstall();
    off();
    await flushApp();
  });

  it("registers the open post's draft writer while it is open", async () => {
    await setup();
    await openPost();
    await screen.findByTestId("wecra-canvas");
    // Nothing unsaved: the flush finishes at once.
    await expect(flushApp()).resolves.toBeUndefined();
  });
});

describe("the post's draft on this Mac (S5)", () => {
  /** A draft of p1 made on `baseVersion` (its document differs from the version's). */
  async function putDraft(baseVersion: number) {
    const { encodeMessage, newDocumentMessage } = await import("@shared/schema/codec");
    await bridge().drafts?.save({
      contentId: "p1",
      baseVersion,
      baseVersionId: `p1-v${baseVersion}`,
      savedAt: Date.parse(T),
      baseHash: "0".repeat(64),
      docHash: "1".repeat(64),
      bundle: encodeBundle(encodeMessage(newDocumentMessage()), new BundleImages(), []),
    });
  }

  it("puts a draft of the version back quietly; Vazgeç drops it", async () => {
    await putDraft(1);
    await setup();
    await openPost();
    const note = await screen.findByRole("status", { name: "Taslak" });
    expect(note).toHaveTextContent("Kaydedilmemiş değişiklikler geri yüklendi.");
    expect(within(slot("title")).getByText("Kaydedilmedi")).toBeInTheDocument();
    await userEvent.click(within(note).getByRole("button", { name: "Vazgeç" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Taslak" })).toBeNull());
    expect(await bridge().drafts?.load("p1")).toBeNull();
  });

  it("offers a draft on a locked post: Taslağı aç goes through Düzenle's warning", async () => {
    await putDraft(1);
    await setup({ status: "approved" });
    await openPost();
    const offer = await screen.findByRole("status", { name: "Taslak" });
    expect(offer).toHaveTextContent("Bu postta kaydedilmemiş değişikliklerin var");
    await userEvent.click(within(offer).getByRole("button", { name: "Taslağı aç" }));
    const dialog = await screen.findByRole("dialog", { name: "Düzenlemeye açılsın mı?" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Düzenle" }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Salt okunur" })).toBeNull());
    // The draft is on the canvas now, editable, no question left.
    await waitFor(() => expect(screen.queryByRole("status", { name: "Taslak" })).toBeNull());
    expect(await screen.findByRole("toolbar", { name: "Wecra araçları" })).toBeInTheDocument();
    await bridge().drafts?.remove("p1");
  });
});
