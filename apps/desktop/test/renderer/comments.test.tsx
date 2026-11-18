// N16 on the desktop: the inbox's helpers, the Yorumlar page (threads, read marks, filters,
// reply, "Yanıt öner" filling the box without sending, hide, delete with confirmation, retry),
// the sidebar's unread count, and the new routes.
import type { ApiClient, CommentSummary, CommentThread, PostComment } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnreadComments } from "../../src/renderer/features/comments/comments-data.ts";
import {
  actionText,
  commentTime,
  postOptions,
  replyLimit,
  syncLine,
  threadUnreadIds,
} from "../../src/renderer/features/comments/comments-model.ts";
import { CommentsBody } from "../../src/renderer/features/comments/comments-page.tsx";
import { UnreadBadge } from "../../src/renderer/features/comments/unread-badge.tsx";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import {
  parseRoute,
  type Route,
  routeKey,
  useAppStore,
} from "../../src/renderer/state/app-store.ts";

vi.mock("../../src/renderer/state/studio.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/state/studio.tsx")>();
  return { ...actual, isHostUp: () => true, useJobList: () => [] };
});

const NOW = new Date("2026-11-19T10:00:00.000Z");

function comment(over: Partial<PostComment> = {}): PostComment {
  return {
    id: "c1",
    brandId: "b1",
    socialAccountId: "a1",
    platform: "instagram",
    contentId: "p1",
    scheduleId: "s1",
    externalPostId: "1789",
    externalId: "x1",
    parentId: null,
    author: "ayse",
    text: "Fiyatı ne kadar?",
    likeCount: 2,
    hidden: false,
    own: false,
    createdAt: "2026-11-19T09:00:00.000Z",
    readAt: null,
    deletedAt: null,
    answered: false,
    pendingAction: null,
    suggestion: null,
    suggestionAt: null,
    ...over,
  };
}

function thread(over: Partial<CommentThread> = {}): CommentThread {
  return {
    ...comment(),
    replies: [],
    contentTitle: "Hasat zamanı",
    permalink: "https://www.instagram.com/p/X/",
    ...over,
  };
}

const SUMMARY: CommentSummary = {
  unread: 2,
  brands: [{ brandId: "b1", unread: 2, unanswered: 1 }],
  contents: [{ contentId: "p1", unread: 2 }],
  lastSyncAt: "2026-11-19T09:50:00.000Z",
  needsReconnect: [{ socialAccountId: "a2", handle: "MTM Agro" }],
};

function providers(ui: ReactNode, api: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
    </QueryClientProvider>,
  );
}

function fakeApi(
  threads: CommentThread[] = [
    thread({
      replies: [comment({ id: "c2", parentId: "c1", author: "veli", text: "Ben de merak ettim" })],
    }),
  ],
) {
  const comments = {
    summary: vi.fn(async () => SUMMARY),
    list: vi.fn(async () => ({ items: threads, nextCursor: null })),
    read: vi.fn(async () => ({ updated: 1 })),
    reply: vi.fn(async (id: string) => threads.find((t) => t.id === id) as CommentThread),
    moderate: vi.fn(async (id: string) => threads.find((t) => t.id === id) as CommentThread),
    retryAction: vi.fn(async (id: string) => threads.find((t) => t.id === id) as CommentThread),
    suggest: vi.fn(async () => ({ id: "job-s", type: "comments.suggest", status: "queued" })),
    sync: vi.fn(async () => ({ id: "job-c", type: "comments.sync", status: "queued" })),
  };
  const jobs = {
    get: vi.fn(async () => ({
      id: "job-s",
      type: "comments.suggest",
      status: "succeeded",
      payload: {},
      output: { suggestion: "@ayse Size DM attık 🌾" },
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })),
  };
  return { api: { comments, jobs }, comments, jobs };
}

beforeEach(() => {
  useAppStore.setState({
    route: { kind: "comments" },
    post: null,
    back: [],
    forward: [],
    toasts: [],
  });
});

afterEach(() => {
  useAppStore.setState({ toasts: [] });
});

describe("routes", () => {
  it("round-trips Performans and Yorumlar", () => {
    const routes: Route[] = [{ kind: "performance" }, { kind: "comments" }];
    for (const route of routes) expect(parseRoute(routeKey(route))).toEqual(route);
    expect(routeKey({ kind: "comments" })).toBe("comments");
  });
});

describe("inbox helpers", () => {
  it("knows reply limits, action states, unread ids, post options and times", () => {
    expect(replyLimit("instagram")).toBe(2200);
    expect(replyLimit("facebook")).toBe(8000);
    const action = {
      id: "a",
      kind: "reply" as const,
      status: "pending" as const,
      text: "x",
      error: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    };
    expect(actionText(action)).toEqual({
      text: "Yanıt sırada; Mac'teki worker gönderecek.",
      failed: false,
    });
    expect(
      actionText({ ...action, kind: "delete", status: "failed", error: "Meta istek sınırı" }),
    ).toEqual({
      text: "Silinemedi: Meta istek sınırı",
      failed: true,
    });
    const t = thread({
      replies: [
        comment({ id: "c2", parentId: "c1" }),
        comment({ id: "c3", parentId: "c1", own: true }),
        comment({ id: "c4", parentId: "c1", readAt: NOW.toISOString() }),
      ],
    });
    expect(threadUnreadIds(t)).toEqual(["c1", "c2"]);
    expect(postOptions([t, thread({ id: "t2" })], SUMMARY)).toEqual([
      { contentId: "p1", title: "Hasat zamanı", unread: 2 },
    ]);
    expect(syncLine(SUMMARY, NOW)).toBe(
      "Son okuma: 10 dk önce · Mac açıkken 15 dakikada bir okunur.",
    );
    expect(syncLine(null, NOW)).toMatch(/^Yorumlar henüz okunmadı/);
    expect(commentTime("2026-11-19T09:00:00.000Z", NOW)).toBe("1 sa önce");
    expect(commentTime("2026-11-12T11:05:00.000Z", NOW)).toMatch(/12 Kas/);
  });
});

describe("Yorumlar page", () => {
  it("lists threads with replies, marks them read, filters, warns about reconnecting", async () => {
    const user = userEvent.setup();
    const { api, comments } = fakeApi();
    providers(<CommentsBody brandId="b1" brandName="MTM Agro" />, api);
    const card = await screen.findByRole("article", { name: /ayse: Fiyatı ne kadar\?/ });
    expect(within(card).getByText("Ben de merak ettim")).toBeInTheDocument();
    expect(within(card).getByText("Yanıt bekliyor")).toBeInTheDocument();
    expect(within(card).getByText("Hasat zamanı")).toBeInTheDocument();
    // Shown → read (the thread's unread comments, once).
    await waitFor(() => expect(comments.read).toHaveBeenCalledWith({ ids: ["c1", "c2"] }));
    expect(comments.read).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/MTM Agro: yorumlar okunamıyor/)).toBeInTheDocument();
    expect(screen.getByText(/15 dakikada bir okunur/)).toBeInTheDocument();
    expect(comments.list).toHaveBeenCalledWith({ brandId: "b1", filter: "all", limit: 20 });
    await user.click(screen.getByRole("radio", { name: /Yanıtlanmamış/ }));
    await waitFor(() =>
      expect(comments.list).toHaveBeenLastCalledWith({
        brandId: "b1",
        filter: "unanswered",
        limit: 20,
      }),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Post" }), "p1");
    await waitFor(() =>
      expect(comments.list).toHaveBeenLastCalledWith({
        brandId: "b1",
        contentId: "p1",
        filter: "unanswered",
        limit: 20,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Tümünü okundu say" }));
    expect(comments.read).toHaveBeenLastCalledWith({ brandId: "b1" });
    await user.click(screen.getByRole("button", { name: "Şimdi yenile" }));
    expect(comments.sync).toHaveBeenCalledWith({ brandId: "b1" });
  });

  it("replies: Yanıt öner fills the box (never sends), Gönder queues the reply", async () => {
    const user = userEvent.setup();
    const { api, comments, jobs } = fakeApi();
    providers(<CommentsBody brandId="b1" brandName="MTM Agro" />, api);
    const card = await screen.findByRole("article", { name: /ayse:/ });
    await user.click(within(card).getByRole("button", { name: "Yanıtla" }));
    await user.click(within(card).getByRole("button", { name: "Yanıt öner" }));
    expect(comments.suggest).toHaveBeenCalledWith("c1", {});
    const box = within(card).getByRole("textbox", { name: "Yanıt" });
    await waitFor(() => expect(box).toHaveValue("@ayse Size DM attık 🌾"));
    expect(jobs.get).toHaveBeenCalledWith("job-s");
    expect(within(card).getByText("Taslak hazır, düzenleyip gönderin.")).toBeInTheDocument();
    expect(comments.reply).not.toHaveBeenCalled();
    await user.type(box, " Teşekkürler!");
    await user.click(within(card).getByRole("button", { name: "Gönder" }));
    expect(comments.reply).toHaveBeenCalledWith("c1", {
      text: "@ayse Size DM attık 🌾 Teşekkürler!",
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toMatch(/Yanıt sıraya alındı/);
  });

  it("refuses a reply over the platform's limit", async () => {
    const user = userEvent.setup();
    const { api, comments } = fakeApi();
    providers(<CommentsBody brandId="b1" brandName="" />, api);
    const card = await screen.findByRole("article", { name: /ayse:/ });
    await user.click(within(card).getByRole("button", { name: "Yanıtla" }));
    const box = within(card).getByRole("textbox", { name: "Yanıt" });
    await user.click(box);
    await user.paste("a".repeat(2201));
    expect(within(card).getByText("2201/2200")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Gönder" })).toBeDisabled();
    expect(comments.reply).not.toHaveBeenCalled();
  });

  it("hides at once, deletes only after confirming, retries a failed action", async () => {
    const user = userEvent.setup();
    const failed = thread({
      id: "t9",
      author: "bot",
      text: "Spam",
      readAt: NOW.toISOString(),
      pendingAction: {
        id: "act",
        kind: "reply",
        status: "failed",
        text: "x",
        error: "Meta istek sınırına ulaşıldı.",
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      },
    });
    const { api, comments } = fakeApi([failed]);
    providers(<CommentsBody brandId="b1" brandName="" />, api);
    const card = await screen.findByRole("article", { name: /bot: Spam/ });
    await user.click(within(card).getByRole("button", { name: "Gizle" }));
    expect(comments.moderate).toHaveBeenCalledWith("t9", { action: "hide" });
    await user.click(within(card).getByRole("button", { name: "Sil" }));
    expect(comments.moderate).toHaveBeenCalledTimes(1);
    const dialog = await screen.findByRole("dialog", { name: "Yorum silinsin mi?" });
    await user.click(within(dialog).getByRole("button", { name: "Sil" }));
    expect(comments.moderate).toHaveBeenLastCalledWith("t9", { action: "delete" });
    expect(
      within(card).getByText(/Yanıt gönderilemedi: Meta istek sınırına ulaşıldı\./),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Yeniden dene" }));
    expect(comments.retryAction).toHaveBeenCalledWith("t9");
    // Already read: no read mark.
    expect(comments.read).not.toHaveBeenCalled();
  });

  it("says when there is nothing to show", async () => {
    const { api } = fakeApi([]);
    providers(<CommentsBody brandId="b1" brandName="" />, api);
    expect(await screen.findByText("Henüz yorum yok.")).toBeInTheDocument();
  });
});

describe("sidebar unread count", () => {
  function Probe({ brandId }: { brandId: string | null }) {
    return <UnreadBadge count={useUnreadComments(brandId)} />;
  }

  it("shows the brand's unread comments, nothing at zero", async () => {
    const { api, comments } = fakeApi();
    providers(<Probe brandId="b1" />, api);
    expect(await screen.findByRole("status", { name: "2 okunmamış yorum" })).toHaveTextContent("2");
    expect(comments.summary).toHaveBeenCalledWith({ brandId: "b1" });
    const { container } = render(<UnreadBadge count={0} />);
    expect(container).toBeEmptyDOMElement();
    render(<UnreadBadge count={150} />);
    expect(screen.getByText("99+")).toBeInTheDocument();
  });
});
