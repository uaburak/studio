import type { ApiClient, Brand } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EditorApi, PostEditor } from "../../src/renderer/features/post-detail/editor.ts";
import { EditorView } from "../../src/renderer/features/post-detail/post-detail.tsx";
import { buildBoard } from "../../src/renderer/features/posts/board.ts";
import { ChatPostCard } from "../../src/renderer/features/posts/chat-post-card.tsx";
import { postKeys } from "../../src/renderer/features/posts/data.ts";
import { Board } from "../../src/renderer/features/posts/posts-page.tsx";
import { usePostsStore } from "../../src/renderer/features/posts/store.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { buildTranscript } from "../../src/renderer/lib/transcript.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import { message } from "./fixtures.ts";
import {
  content,
  contentFor,
  FakeContentApi,
  hashedVersion,
  job,
  schedule,
  slide,
  version,
} from "./post-fixtures.ts";

const NOW = new Date("2026-11-17T10:00:00.000Z");

const brands = [
  { id: "b1", name: "MTM Agro", status: "active" },
  { id: "b2", name: "Partner Agro", status: "active" },
] as Brand[];

function providers(ui: ReactNode, api: unknown = {}, seed?: (q: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  usePostsStore.setState({
    month: null,
    filter: "all",
    query: "",
    selectedId: null,
    opened: null,
    deleting: null,
    allBrands: false,
  });
});

afterEach(() => {
  useAppStore.setState({ toasts: [], lightbox: null });
});

describe("chat post card", () => {
  it("shows the referred post's title, status and slides and opens it", async () => {
    const v = version("p1", 2, [
      slide({ renderedAssetId: "r1" }),
      slide({ renderedAssetId: "r2" }),
    ]);
    const c = contentFor(v);
    providers(<ChatPostCard contentId="p1" version={2} note="İlk taslak" />, {}, (q) => {
      q.setQueryData(postKeys.content("p1"), c);
      q.setQueryData(postKeys.version("p1", 2), v);
    });
    expect(screen.getByText("Hasat sonrası toprak bakımı")).toBeInTheDocument();
    expect(screen.getByText("Onay bekliyor")).toBeInTheDocument();
    expect(screen.getByText("v2 · İlk taslak")).toBeInTheDocument();
    const thumbs = screen.getAllByRole("button", { name: /^Slayt/ });
    expect(thumbs).toHaveLength(2);
    expect((thumbs[1] as HTMLElement).querySelector("img")).toHaveAttribute(
      "src",
      "/api/assets/r2/content",
    );
    await userEvent.click(thumbs[0] as HTMLElement);
    expect(usePostsStore.getState().opened?.contentId).toBe("p1");
    usePostsStore.getState().close();
    await userEvent.click(
      screen.getByRole("button", { name: "Postu aç: Hasat sonrası toprak bakımı" }),
    );
    expect(usePostsStore.getState().opened?.contentId).toBe("p1");
  });

  it("says when the post is gone", () => {
    providers(<ChatPostCard contentId="nope" note={null} />);
    expect(screen.getByText("Post bulunamadı")).toBeInTheDocument();
  });

  it("comes from a content_ref part of a reply", () => {
    const items = buildTranscript({
      hasState: true,
      messages: [
        message("m1", "assistant", [
          { type: "content_ref", contentId: "p1", version: 3, note: "Hazır" },
        ]),
      ],
    });
    const reply = items.find((i) => i.kind === "assistant");
    expect(reply?.kind === "assistant" && reply.blocks[0]).toEqual({
      kind: "post",
      key: "post-0-p1",
      contentId: "p1",
      version: 3,
      note: "Hazır",
    });
  });
});

describe("posts board", () => {
  const v1 = version("p1", 1);
  const v2 = version("p2", 1);
  const cards = buildBoard({
    contents: [
      contentFor(v1, { title: "Hasat sonrası", createdAt: "2026-11-02T09:00:00.000Z" }),
      contentFor(v2, { id: "p2", title: "Bayi ağı", status: "scheduled", caption: "" }),
      content({ id: "p3", title: "Damla sulama", createdAt: "2026-11-05T09:00:00.000Z" }),
    ],
    versions: new Map([
      ["p1", v1],
      ["p2", v2],
    ]),
    schedules: [schedule({ contentId: "p2", scheduledAt: "2026-11-20T10:30:00.000Z" })],
    jobs: [job({ contentId: "p3", type: "content.generate", status: "running" })],
  });

  function renderBoard(api: unknown = {}) {
    return providers(
      <Board
        cards={cards}
        loading={false}
        error={null}
        onRetry={() => undefined}
        brands={brands}
        brandName={(id) => brands.find((b) => b.id === id)?.name}
        grouped={false}
        brandId="b1"
        now={NOW}
      />,
      api,
    );
  }

  it("shows the month, the count, the filters with counts and the cards", () => {
    renderBoard();
    expect(screen.getByRole("heading", { name: "Postlar" })).toBeInTheDocument();
    expect(screen.getByText("Kasım 2026")).toBeInTheDocument();
    expect(screen.getByText("3 post")).toBeInTheDocument();
    const filters = screen.getByRole("radiogroup", { name: "Durum" });
    expect(within(filters).getByRole("radio", { name: /^Tümü/ })).toHaveTextContent("Tümü3");
    expect(within(filters).getByRole("radio", { name: /^Taslak/ })).toHaveTextContent("Taslak1");
    expect(within(filters).getByRole("radio", { name: /^Zamanlandı/ })).toHaveTextContent(
      "Zamanlandı1",
    );
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.dataset.cardId)).toEqual(["p2", "p1", "p3"]);
    expect(within(items[0] as HTMLElement).getByText("Zamanlandı")).toBeInTheDocument();
    expect(
      within(items[0] as HTMLElement).getByText("Instagram · 20 Kas 13:30"),
    ).toBeInTheDocument();
    expect(within(items[2] as HTMLElement).getAllByText("Üretiliyor").length).toBeGreaterThan(0);
  });

  it("filters by status and searches", async () => {
    renderBoard();
    await userEvent.click(screen.getByRole("radio", { name: /^Zamanlandı/ }));
    expect(screen.getAllByRole("listitem").map((li) => li.dataset.cardId)).toEqual(["p2"]);
    await userEvent.click(screen.getByRole("radio", { name: /^Tümü/ }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Postlarda ara" }), "damla");
    expect(screen.getAllByRole("listitem").map((li) => li.dataset.cardId)).toEqual(["p3"]);
    await userEvent.clear(screen.getByRole("searchbox", { name: "Postlarda ara" }));
    await userEvent.type(screen.getByRole("searchbox", { name: "Postlarda ara" }), "yok böyle");
    expect(screen.getByText("Sonuç yok")).toBeInTheDocument();
  });

  it("moves the selection with the arrows, opens with ↩ and asks before deleting", async () => {
    renderBoard();
    const region = screen.getByRole("region", { name: "Postlar" });
    region.focus();
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(usePostsStore.getState().selectedId).toBe("p2");
    fireEvent.keyDown(region, { key: "ArrowDown" });
    expect(usePostsStore.getState().selectedId).toBe("p1");
    expect(screen.getAllByRole("listitem")[1]).toHaveAttribute("data-selected", "true");
    fireEvent.keyDown(region, { key: "Enter" });
    expect(usePostsStore.getState().opened?.contentId).toBe("p1");
    fireEvent.keyDown(region, { key: "Backspace" });
    expect(usePostsStore.getState().deleting?.id).toBe("p1");
    // A scheduled post cannot be deleted: a toast says why, no confirmation.
    usePostsStore.getState().askDelete(null);
    fireEvent.keyDown(region, { key: "ArrowUp" });
    fireEvent.keyDown(region, { key: "Delete" });
    expect(usePostsStore.getState().deleting).toBeNull();
    expect(useAppStore.getState().toasts.at(-1)?.message).toMatch(/Zamanlanmış post silinemez/);
    fireEvent.keyDown(region, { key: "Escape" });
    expect(usePostsStore.getState().selectedId).toBeNull();
  });

  it("offers quick look, copy, duplicate and delete on the card", async () => {
    const duplicate = vi.fn(async () => content({ id: "p9", title: "Hasat sonrası (kopya)" }));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderBoard({ contents: { duplicate } });
    const first = screen.getAllByRole("listitem")[1] as HTMLElement; // p1
    const tools = within(first).getByRole("toolbar", { name: "Post işlemleri" });
    await userEvent.click(within(tools).getByRole("button", { name: "Hızlı bakış" }));
    expect(useAppStore.getState().lightbox?.images.map((i) => i.assetId)).toEqual(["r1"]);
    await userEvent.click(within(tools).getByRole("button", { name: "Açıklamayı kopyala" }));
    expect(writeText).toHaveBeenCalledWith("Hasat bitti ama iş bitmedi.\n\n#hasat #toprak");
    await userEvent.click(within(tools).getByRole("button", { name: "Çoğalt" }));
    await waitFor(() => expect(duplicate).toHaveBeenCalledWith("p1"));
    expect(usePostsStore.getState().selectedId).toBe("p9");
    await userEvent.click(within(tools).getByRole("button", { name: "Sil" }));
    expect(usePostsStore.getState().deleting?.id).toBe("p1");
    // The scheduled card's delete is disabled with the reason as its label.
    const scheduled = screen.getAllByRole("listitem")[0] as HTMLElement;
    expect(
      within(scheduled).getByRole("button", { name: /Zamanlanmış post silinemez/ }),
    ).toBeDisabled();
    expect(within(scheduled).getByRole("button", { name: "Açıklamayı kopyala" })).toBeDisabled();
  });

  it("shows an empty month with a way to the nearest posts", async () => {
    usePostsStore.setState({ month: "2026-12" });
    renderBoard();
    expect(screen.getByText("Aralık 2026 için post yok")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "‹ Kasım" }));
    expect(usePostsStore.getState().month).toBe("2026-11");
  });
});

describe("opened post", () => {
  function EditorHarness({ editor }: { editor: PostEditor }) {
    const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
    return <EditorView editor={editor} snapshot={snapshot} />;
  }

  async function openEditor(versions = 2) {
    const fake = new FakeContentApi();
    const list = [];
    for (let n = 1; n <= versions; n++) list.push(await hashedVersion("p1", n));
    const current = list.at(-1);
    if (!current) throw new Error("no version");
    const c = contentFor(current, { targetPlatforms: ["instagram"] });
    fake.add(c, list);
    const editor = new PostEditor(fake.api as unknown as EditorApi, c, current, { pollMs: 0 });
    usePostsStore.getState().open("p1");
    const view = providers(<EditorHarness editor={editor} />, {
      ...fake.api,
      schedules: { list: vi.fn() },
      publishing: { status: vi.fn() },
    });
    await act(async () => {
      await editor.load();
    });
    return { fake, editor, view };
  }

  it("shows title, status, caption and meta, and approves with the verified hash", async () => {
    const { fake, editor } = await openEditor();
    expect(
      screen.getByRole("heading", { name: "Hasat sonrası toprak bakımı" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Onay bekliyor")).toBeInTheDocument();
    // The version tag and the Sürüm row.
    expect(screen.getAllByText("v2")).toHaveLength(2);
    expect(screen.getByText("Hasat bitti ama iş bitmedi.")).toBeInTheDocument();
    expect(screen.getByText("#hasat #toprak")).toBeInTheDocument();
    expect(screen.getByText("Tek görsel · 4:5")).toBeInTheDocument();
    const approve = screen.getByRole("button", { name: "Onayla" });
    await waitFor(() => expect(approve).toBeEnabled());
    await userEvent.click(approve);
    await waitFor(() => expect(fake.approveCalls).toHaveLength(1));
    expect(fake.approveCalls[0]?.hash).toBe(
      editor.getSnapshot().content.currentVersion?.contentHash,
    );
    expect(await screen.findByText("Onaylandı.")).toBeInTheDocument();
  });

  it("switches versions from the Sürümler tab and offers the restore", async () => {
    const { editor } = await openEditor(3);
    await userEvent.click(screen.getByRole("radio", { name: /^Sürümler/ }));
    const list = screen.getByRole("listbox", { name: "Sürümler" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent?.slice(0, 2)),
    ).toEqual(["v3", "v2", "v1"]);
    await userEvent.click(within(list).getAllByRole("option")[2] as HTMLElement);
    await waitFor(() => expect(editor.getSnapshot().displayed?.version).toBe(1));
    expect(screen.getByText("v1 · eski sürüm")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Bu sürümü geri yükle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Onayla" })).toBeDisabled();
  });

  // The detail (reels; posts with slides open on the canvas, post-workspace.test.tsx) keeps its
  // own Düzenle tab.
  it("edits a text layer from the detail's Düzenle tab", async () => {
    const { fake } = await openEditor(1);
    await userEvent.click(screen.getByRole("radio", { name: /^Düzenle/ }));
    const layers = screen.getByRole("listbox", { name: "Katmanlar" });
    await userEvent.click(within(layers).getByText("Hasat bitti, toprak hazır mı?"));
    const text = screen.getByRole("textbox", { name: "Metin" });
    await userEvent.clear(text);
    await userEvent.type(text, "Kış geliyor");
    await userEvent.click(screen.getByRole("button", { name: "Metni uygula" }));
    // Applied at once and saved (one render job) after a short pause.
    await waitFor(() => expect(fake.createdJobs).toHaveLength(1), { timeout: 5000 });
    expect(fake.createdJobs[0]?.payload.patches).toEqual([
      { slide: 0, op: "setText", layer: "headline", text: "Kış geliyor" },
    ]);
  });
});
