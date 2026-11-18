// Shell improvements of Faz 5: ⌘K search over everything, the archive (page, undo, history),
// modal focus traps, Turkish error texts (U12).
import { ApiError, type Asset, type Content } from "@studio/contract";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ArchivePage, filterArchived } from "../../src/renderer/components/shell/archive-page.tsx";
import { useConversationActions } from "../../src/renderer/components/shell/conversation-actions.ts";
import {
  SearchPalette,
  searchAll,
  snippet,
} from "../../src/renderer/components/shell/overlays.tsx";
import { ConfirmDialog, Dialog } from "../../src/renderer/components/ui/dialog.tsx";
import { Sheet } from "../../src/renderer/components/ui/sheet.tsx";
import { usePostsStore } from "../../src/renderer/features/posts/store.ts";
import { describeError, explainError } from "../../src/renderer/lib/api.ts";
import { parseRoute, routeKey, useAppStore } from "../../src/renderer/state/app-store.ts";
import { alias, conversation, T } from "./fixtures.ts";
import { apiError, brand, page, renderLive, resetLive } from "./live-harness.tsx";
import { content } from "./post-fixtures.ts";

afterEach(() => {
  resetLive();
  useAppStore.setState({
    route: { kind: "new" },
    back: [],
    forward: [],
    toasts: [],
    searchOpen: false,
    lightbox: null,
  });
});

const BRANDS = [brand("b1", "MTM Agro"), brand("b2", "Partner Agro")];

function image(id: string, name: string): Asset {
  return {
    id,
    brandId: "b1",
    kind: "image",
    source: "upload",
    objectKey: id,
    mimeType: "image/png",
    bytes: 1,
    sha256: "0".repeat(64),
    width: 800,
    height: 1000,
    durationMs: null,
    originalFilename: name,
    createdAt: T,
  };
}

// --- search -----------------------------------------------------------------------------------------

const POSTS: Content[] = [
  content({ id: "p1", title: "Hasat sonrası toprak bakımı" }),
  content({ id: "p2", title: "Kış hazırlığı", caption: "Seralarda ısıtma için 5 ipucu" }),
];

describe("⌘K search", () => {
  it("groups conversations, posts (title and caption), brands and media", () => {
    const groups = searchAll(
      {
        conversations: [conversation({ id: "c1", title: "Sera kampanyası" })],
        contents: POSTS,
        brands: [...BRANDS, brand("b3", "Sera Dünyası", { status: "archived" })],
        assets: [image("m1", "sera-foto.png"), image("m2", "tarla.png")],
        aliases: [alias("sera-logo", { assetId: "m9" })],
      },
      "SERA",
    );
    expect(groups.map((g) => [g.label, g.items.map((i) => i.title)])).toEqual([
      ["Sohbetler", ["Sera kampanyası"]],
      ["Postlar", ["Kış hazırlığı"]],
      ["Medya", ["@sera-logo", "sera-foto.png"]],
    ]);
    const post = groups[1]?.items[0];
    expect(post?.subtitle).toContain("Seralarda ısıtma");
    expect(
      searchAll(
        { conversations: [], contents: POSTS, brands: BRANDS, assets: [], aliases: [] },
        "partner",
      ),
    ).toEqual([expect.objectContaining({ label: "Markalar" })]);
    expect(snippet(`${"a ".repeat(60)}hedef kelime ${"b ".repeat(60)}`, "hedef")).toMatch(
      /^….*hedef kelime.*…$/,
    );
  });

  it("is a combobox over a grouped listbox, moved with the arrows, and opens what is chosen", async () => {
    useAppStore.setState({ searchOpen: true });
    const live = renderLive(<SearchPalette />, (method, path) => {
      if (method !== "GET") return undefined;
      if (path.startsWith("/api/conversations"))
        return page([conversation({ id: "c1", title: "Kış kampanyası" })]);
      if (path.startsWith("/api/brands")) return page(BRANDS);
      if (path.startsWith("/api/contents")) return page(POSTS);
      if (path.startsWith("/api/assets")) return page([image("m1", "kış.png")]);
      return undefined;
    });
    const field = await screen.findByRole("combobox", { name: "Ara" });
    const listbox = screen.getByRole("listbox", { name: "Sonuçlar" });
    expect(field).toHaveAttribute("aria-controls", listbox.id);
    await waitFor(() => expect(field).toHaveFocus());
    await userEvent.type(field, "kış");
    await screen.findByRole("group", { name: "Postlar" });
    expect(within(listbox).getByRole("group", { name: "Sohbetler" })).toBeInTheDocument();
    expect(within(listbox).getByRole("group", { name: "Medya" })).toBeInTheDocument();
    const options = within(listbox).getAllByRole("option");
    expect(field).toHaveAttribute("aria-activedescendant", options[0]?.id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}");
    expect(field).toHaveAttribute("aria-activedescendant", options[1]?.id);
    expect(options[1]).toHaveTextContent("Kış hazırlığı");
    await userEvent.keyboard("{Enter}");
    expect(usePostsStore.getState().opened?.contentId).toBe("p2");
    expect(useAppStore.getState().searchOpen).toBe(false);
    expect(live.calls.some((c) => c.path.startsWith("/api/contents"))).toBe(true);
    usePostsStore.getState().close();
  });

  it("keeps Tab inside the palette and closes on Esc", async () => {
    useAppStore.setState({ searchOpen: true });
    renderLive(
      <>
        <button type="button">dışarıda</button>
        <SearchPalette />
      </>,
    );
    const field = await screen.findByRole("combobox", { name: "Ara" });
    await waitFor(() => expect(field).toHaveFocus());
    await userEvent.tab();
    expect(screen.getByRole("dialog", { name: "Ara" })).toContainElement(
      document.activeElement as HTMLElement,
    );
    await userEvent.keyboard("{Escape}");
    expect(useAppStore.getState().searchOpen).toBe(false);
  });
});

// --- archive ----------------------------------------------------------------------------------------

describe("Arşiv", () => {
  it("lists archived conversations, filters them and takes one back", async () => {
    const archived = [
      conversation({ id: "a1", title: "Eski kampanya", status: "archived" }),
      conversation({ id: "a2", title: "Bayram postları", status: "archived", brandId: "b2" }),
    ];
    const live = renderLive(<ArchivePage />, (method, path, body) => {
      if (method === "GET" && path.startsWith("/api/conversations?") && path.includes("archived"))
        return page(archived, "next");
      if (method === "GET" && path.startsWith("/api/brands")) return page(BRANDS);
      if (method === "PATCH" && path === "/api/conversations/a1")
        return { ...archived[0], ...(body as object) };
      return undefined;
    });
    const list = await screen.findByRole("list", { name: "Arşivlenen sohbetler" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText(/Partner Agro/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Daha fazla göster" })).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Arşivde ara" }), "bayram");
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    await userEvent.clear(screen.getByRole("searchbox", { name: "Arşivde ara" }));
    const row = within(list).getByText("Eski kampanya").closest("li") as HTMLElement;
    await userEvent.click(within(row).getByRole("button", { name: "Arşivden çıkar" }));
    await waitFor(() =>
      expect(live.calls.find((c) => c.method === "PATCH")?.body).toEqual({ status: "active" }),
    );
    await waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)?.message).toContain("arşivden çıkarıldı"),
    );
    await userEvent.click(within(list).getByText("Bayram postları"));
    expect(useAppStore.getState().route).toEqual({ kind: "conversation", id: "a2" });
  });

  it("archiving drops the conversation from back / forward; a failed undo says so", async () => {
    const target = conversation({ id: "c7", title: "Ekim" });
    let actions: ReturnType<typeof useConversationActions> | undefined;
    function Probe() {
      actions = useConversationActions();
      return null;
    }
    renderLive(<Probe />, (method, path, body) => {
      if (method === "PATCH" && path === "/api/conversations/c7") {
        if ((body as { status?: string }).status === "active")
          return apiError(409, "conflict", "conversation is busy");
        return { ...target, ...(body as object) };
      }
      return undefined;
    });
    await waitFor(() => expect(actions).toBeDefined());
    const store = useAppStore.getState();
    store.navigate({ kind: "conversation", id: "c7" });
    store.navigate({ kind: "posts" });
    store.navigate({ kind: "conversation", id: "c7" });
    await act(() => actions?.archive(target));
    const { back, route } = useAppStore.getState();
    expect(route).toEqual({ kind: "new" });
    expect(back.map((l) => routeKey(l.route))).toEqual(["new", "posts"]);
    const toast = useAppStore.getState().toasts.at(-1);
    act(() => toast?.action?.run());
    await waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)?.message).toMatch(
        /arşivden çıkarılamadı: Bu işlem şu anki durumla çakışıyor/,
      ),
    );
  });

  it("has its own route and filters by Turkish-insensitive title", () => {
    expect(parseRoute(routeKey({ kind: "archive" }))).toEqual({ kind: "archive" });
    const list = [conversation({ id: "1", title: "İLK" }), conversation({ id: "2", title: "" })];
    expect(filterArchived(list, "ilk").map((c) => c.id)).toEqual(["1"]);
    expect(filterArchived(list, "adsız").map((c) => c.id)).toEqual(["2"]);
  });
});

// --- modals -----------------------------------------------------------------------------------------

function DialogHarness({ nested = false }: { nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Aç
      </button>
      <Dialog open={open} title="Pencere" onClose={() => setOpen(false)}>
        <input aria-label="Ad" />
        <button type="button" onClick={() => setConfirm(true)}>
          Sor
        </button>
      </Dialog>
      {nested && (
        <ConfirmDialog
          open={confirm}
          title="Emin misin?"
          message="Geri alınamaz."
          confirmLabel="Sil"
          onConfirm={() => setConfirm(false)}
          onClose={() => setConfirm(false)}
        />
      )}
    </>
  );
}

describe("modal focus (Dialog, Sheet)", () => {
  it("traps Tab inside the dialog and gives focus back on close", async () => {
    render(<DialogHarness />);
    const opener = screen.getByRole("button", { name: "Aç" });
    await userEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Pencere" });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    const inside = () => dialog.contains(document.activeElement);
    for (let i = 0; i < 5; i++) {
      await userEvent.tab();
      expect(inside()).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await userEvent.tab({ shift: true });
      expect(inside()).toBe(true);
    }
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("only the top dialog answers Esc and Tab", async () => {
    render(<DialogHarness nested />);
    await userEvent.click(screen.getByRole("button", { name: "Aç" }));
    await userEvent.click(await screen.findByRole("button", { name: "Sor" }));
    const confirm = screen.getByRole("dialog", { name: "Emin misin?" });
    await waitFor(() => expect(confirm).toContainElement(document.activeElement as HTMLElement));
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(confirm.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Emin misin?" })).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Pencere" })).toBeInTheDocument();
    // Focus is back on "Sor" inside the first dialog.
    expect(screen.getByRole("button", { name: "Sor" })).toHaveFocus();
  });

  it("a sheet focuses its first field and keeps Tab inside", async () => {
    function SheetHarness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button">arkada</button>
          <Sheet open={open} title="Yeni ürün" onClose={() => setOpen(false)}>
            <input aria-label="Ürün adı" />
          </Sheet>
        </>
      );
    }
    render(<SheetHarness />);
    const field = screen.getByRole("textbox", { name: "Ürün adı" });
    await waitFor(() => expect(field).toHaveFocus());
    const sheet = screen.getByRole("dialog", { name: "Yeni ürün" });
    await userEvent.tab();
    await userEvent.tab();
    await userEvent.tab();
    expect(sheet.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

// --- U12 ------------------------------------------------------------------------------------------

describe("error texts (U12)", () => {
  it("maps API codes to Turkish with the server's text as detail", () => {
    const error = new ApiError(
      "/api/plans/p/generate: plan p is not accepted",
      409,
      "invalid_transition",
    );
    expect(explainError(error)).toEqual({
      message: "Bu adım şu an yapılamaz; durum değişmiş olabilir. Sayfayı yenileyip tekrar dene.",
      detail: "plan p is not accepted",
    });
    expect(describeError(new TypeError("Failed to fetch"))).toBe("Studio sunucusuna ulaşılamadı.");
    expect(describeError(new ApiError("/api/x returned HTTP 502", 502))).toMatch(/hazır değil/);
    // Turkish text (ours or the API's) is shown as it is.
    expect(describeError(new Error("Marka arşivlenmiş."))).toBe("Marka arşivlenmiş.");
    expect(explainError(new Error("socket hang up"))).toEqual({
      message: "Bir şeyler ters gitti; tekrar dene.",
      detail: "socket hang up",
    });
  });
});
