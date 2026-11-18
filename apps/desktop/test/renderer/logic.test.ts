import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shortcutCommand } from "../../src/renderer/components/shell/app-shell.tsx";
import { searchConversations } from "../../src/renderer/components/shell/overlays.tsx";
import { groupConversations } from "../../src/renderer/components/shell/sidebar.tsx";
import { rewriteSocketUrl } from "../../src/renderer/lib/api.ts";
import {
  allocateAlias,
  canSend,
  insertMention,
  makeMessage,
  mentionQuery,
  mentionSuggestions,
  sendButtonMode,
} from "../../src/renderer/lib/composer.ts";
import {
  formatAgo,
  formatDuration,
  formatReset,
  timeSuffix,
} from "../../src/renderer/lib/format.ts";
import {
  canGoNext,
  canGoPrev,
  counterText,
  fitRect,
  lightboxKey,
  reduceLightbox,
} from "../../src/renderer/lib/lightbox.ts";
import {
  type MenuEntry,
  menuKey,
  moveActive,
  shortcutIndex,
} from "../../src/renderer/lib/menu-nav.ts";
import { choiceFor, lastChoice, saveChoicePatch } from "../../src/renderer/lib/models.ts";
import { ScrollFollower, showJumpToLatest } from "../../src/renderer/lib/scroll-follow.ts";
import { jobsBoard, ringMeter, usageMeters } from "../../src/renderer/lib/usage.ts";
import { parseRoute, routeKey, useAppStore } from "../../src/renderer/state/app-store.ts";
import { renderTokensCss, type TokenDoc } from "../../src/shared/tokens.ts";
import { conversation, T } from "./fixtures.ts";

describe("design tokens", () => {
  const root = join(import.meta.dirname, "../..");
  const doc = JSON.parse(
    readFileSync(join(root, "src/renderer/design/tokens.json"), "utf8"),
  ) as TokenDoc;

  it("tokens.css is generated from the Wecra tokens (run `pnpm tokens` after changing them)", () => {
    expect(readFileSync(join(root, "src/renderer/styles/tokens.css"), "utf8")).toBe(
      renderTokensCss(doc),
    );
  });

  it("every theme role points at an existing primitive in both modes", () => {
    for (const [role, modes] of Object.entries(doc.theme)) {
      expect(doc.primitives[modes.dark], `${role} dark`).toBeDefined();
      expect(doc.primitives[modes.light], `${role} light`).toBeDefined();
    }
    expect(doc.primitives["orange/500"]).toBe("#FF6A00");
    expect(doc.theme["accent/default"]).toEqual({ dark: "orange/500", light: "orange/500" });
  });
});

describe("format", () => {
  it("formats durations and Turkish time suffixes", () => {
    expect(formatDuration(9_000)).toBe("9sn");
    expect(formatDuration(69_000)).toBe("1dk 9sn");
    expect(formatDuration(3_840_000)).toBe("1sa 4dk");
    expect(timeSuffix("22:30")).toBe("22:30'da");
    expect(timeSuffix("14:00")).toBe("14:00'te");
    expect(timeSuffix("10:40")).toBe("10:40'ta");
    expect(timeSuffix("09:15")).toBe("09:15'te");
    expect(timeSuffix("12:00")).toBe("12:00'de");
  });

  it("says when a limit resets and how long ago something happened", () => {
    const now = new Date("2026-11-17T12:00:00+03:00");
    expect(formatReset("2026-11-17T22:30:00+03:00", now)).toBe("22:30'da sıfırlanır");
    expect(formatReset("2026-11-18T14:00:00+03:00", now)).toBe("Çar 14:00'te sıfırlanır");
    expect(formatAgo("2026-11-17T11:56:00+03:00", now)).toBe("4dk önce");
    expect(formatAgo("2026-11-16T10:00:00+03:00", now)).toBe("Dün 10:00");
  });
});

describe("scroll follow", () => {
  const at = (scrollTop: number, scrollHeight = 2000, clientHeight = 800) => ({
    scrollTop,
    scrollHeight,
    clientHeight,
  });

  it("pins new content to the bottom while following, without moving otherwise", () => {
    const f = new ScrollFollower();
    expect(f.onResize(at(1200, 2300))).toBe(1500);
    // The programmatic scroll does not stop following.
    expect(f.onScroll(at(1500, 2300))).toBe(true);
    // The reader scrolls up: content that keeps growing no longer moves the view.
    f.onUserScrollUp();
    expect(f.onScroll(at(900, 2300))).toBe(false);
    expect(f.onResize(at(900, 2600))).toBeNull();
    expect(showJumpToLatest(f.following, at(900, 2600))).toBe(true);
    // Back at the end: following again.
    expect(f.onScroll(at(1790, 2600))).toBe(true);
    expect(showJumpToLatest(f.following, at(1790, 2600))).toBe(false);
  });

  it("an upward scroll by the reader stops following; send resumes it", () => {
    const f = new ScrollFollower();
    f.onScroll(at(1200));
    expect(f.onScroll(at(1000))).toBe(false);
    f.resume();
    expect(f.following).toBe(true);
    expect(f.onResize(at(1000))).toBe(1200);
  });
});

describe("lightbox paging", () => {
  it("pages within the group and closes from the first Esc unless zoomed", () => {
    let s = { index: 1, count: 3, zoomed: false };
    expect(counterText(s)).toBe("2 / 3");
    s = reduceLightbox(s, { kind: "next" }) ?? s;
    expect(s.index).toBe(2);
    expect(canGoNext(s)).toBe(false);
    expect(reduceLightbox(s, { kind: "next" })).toEqual(s);
    s = reduceLightbox(s, { kind: "prev" }) ?? s;
    expect(canGoPrev(s)).toBe(true);
    s = reduceLightbox(s, { kind: "toggleZoom" }) ?? s;
    expect(s.zoomed).toBe(true);
    const unzoomed = reduceLightbox(s, { kind: "close" });
    expect(unzoomed?.zoomed).toBe(false);
    expect(reduceLightbox(unzoomed ?? s, { kind: "close" })).toBeNull();
  });

  it("maps keys and fits images into the window", () => {
    expect(lightboxKey("ArrowRight")).toEqual({ kind: "next" });
    expect(lightboxKey("Escape")).toEqual({ kind: "close" });
    expect(lightboxKey("a")).toBeNull();
    const r = fitRect({ width: 800, height: 1000 }, { width: 1424, height: 949 });
    expect(r.height).toBeCloseTo(949 - 64 - 72);
    expect(r.x + r.width / 2).toBeCloseTo(712);
  });
});

describe("menu keyboard navigation", () => {
  const entries: MenuEntry[] = [
    { type: "label", label: "Model" },
    { id: "a", label: "Opus", shortcut: "1" },
    { id: "b", label: "Sonnet", disabled: true, shortcut: "2" },
    { type: "separator" },
    { id: "c", label: "Efor", shortcut: "E", submenu: [{ id: "c1", label: "Orta" }] },
    { id: "d", label: "Sil", shortcut: "D", danger: true },
  ];

  it("skips labels, separators and disabled items, wrapping around", () => {
    expect(moveActive(entries, -1, 1)).toBe(1);
    expect(moveActive(entries, 1, 1)).toBe(4);
    expect(moveActive(entries, 5, 1)).toBe(1);
    expect(moveActive(entries, 1, -1)).toBe(5);
  });

  it("activates by Enter or shortcut letter and opens submenus", () => {
    expect(menuKey(entries, 1, "Enter", false)).toEqual({ kind: "activate", index: 1 });
    expect(menuKey(entries, 4, "ArrowRight", false)).toEqual({ kind: "openSubmenu", index: 4 });
    expect(menuKey(entries, -1, "d", false)).toEqual({ kind: "activate", index: 5 });
    expect(menuKey(entries, -1, "e", false)).toEqual({ kind: "openSubmenu", index: 4 });
    expect(shortcutIndex(entries, "2")).toBe(-1); // disabled
    expect(menuKey(entries, 1, "Escape", false)).toEqual({ kind: "close", all: true });
    expect(menuKey(entries, 0, "ArrowLeft", true)).toEqual({ kind: "close", all: false });
    expect(menuKey(entries, 1, "End", false)).toEqual({ kind: "move", index: 5 });
  });
});

describe("composer logic", () => {
  it("finds the @query at the caret (not inside e-mail addresses)", () => {
    expect(mentionQuery("şuna bak @ima", 13)).toEqual({ start: 9, query: "ima" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail a@ima", 10)).toBeNull();
    expect(mentionQuery("@image bak", 10)).toBeNull();
  });

  it("suggests prefix matches first and inserts the mention", () => {
    const c = (alias: string) => ({ alias, assetId: null, previewUrl: null, isDraft: false });
    expect(
      mentionSuggestions([c("logo-image"), c("image"), c("image-1")], "ima").map((s) => s.alias),
    ).toEqual(["image", "image-1", "logo-image"]);
    expect(insertMention("bak @im şuna", 4, 7, "image")).toEqual({
      text: "bak @image şuna",
      caret: 11,
    });
  });

  it("allocates free aliases and decides what can be sent", () => {
    expect(allocateAlias("image", new Set(["image", "image-1"]))).toBe("image-2");
    const uploading = {
      id: "1",
      alias: "image",
      previewUrl: "",
      filename: "a.png",
      state: { kind: "uploading" as const },
    };
    const uploaded = { ...uploading, state: { kind: "uploaded" as const, assetId: "as1" } };
    expect(canSend("merhaba", [uploading])).toBe(false);
    expect(canSend("", [uploaded])).toBe(true);
    expect(canSend("  ", [])).toBe(false);
    expect(makeMessage(" selam ", [uploaded], "m1")).toEqual({
      clientMessageId: "m1",
      text: "selam",
      attachments: [{ assetId: "as1", alias: "image" }],
    });
    expect(sendButtonMode(false, true)).toBe("stop");
    expect(sendButtonMode(true, true)).toBe("send");
    expect(sendButtonMode(false, false)).toBe("idle");
  });
});

describe("model choice", () => {
  const settings = {
    agent: {
      last: { model: "opus", effort: "high" },
      conversations: { c1: { model: "haiku", effort: "nope" } },
    },
  };
  it("uses the conversation's choice, else the last one, else the fallback", () => {
    expect(choiceFor(settings, "c1")).toEqual({ model: "haiku", effort: "high" });
    expect(choiceFor(settings, "c2")).toEqual({ model: "opus", effort: "high" });
    expect(lastChoice({ agent: { last: null, conversations: {} } })).toEqual({
      model: "gemini-flash-lite",
      effort: "medium",
    });
    expect(saveChoicePatch({ model: "sonnet", effort: "low" }, "c9")).toEqual({
      agent: {
        last: { model: "sonnet", effort: "low" },
        conversations: { c9: { model: "sonnet", effort: "low" } },
      },
    });
  });
});

describe("usage and jobs", () => {
  it("orders meters and picks the busiest window for the ring", () => {
    const usage = {
      source: "x",
      observedAt: T,
      windows: [
        { kind: "weekly" as const, usedPercent: 75, limited: false },
        { kind: "five_hour" as const, usedPercent: 45, limited: false },
      ],
    };
    expect(usageMeters(usage).map((m) => [m.title, m.percentText])).toEqual([
      ["5 saatlik limit", "%45"],
      ["Haftalık · tüm modeller", "%75"],
    ]);
    expect(ringMeter(usage)?.percent).toBe(75);
  });

  it("splits jobs into running, queued and finished", () => {
    const job = (id: string, status: "running" | "queued" | "succeeded", updatedAt = T) => ({
      id,
      type: "content.generate" as const,
      status,
      payload: {},
      createdAt: T,
      updatedAt,
    });
    const board = jobsBoard(
      [
        job("a", "running"),
        job("b", "queued"),
        job("c", "succeeded"),
        job("d", "succeeded", "2026-11-17T09:00:00.000Z"),
      ],
      Date.parse("2026-11-17T09:30:00.000Z"),
    );
    expect(board.running.map((j) => j.id)).toEqual(["a"]);
    expect(board.queued.map((j) => j.id)).toEqual(["b"]);
    expect(board.finished.map((j) => j.id)).toEqual(["c"]);
  });
});

describe("window state", () => {
  it("keeps back / forward history", () => {
    const s = useAppStore.getState();
    s.navigate({ kind: "new" });
    s.navigate({ kind: "conversation", id: "c1" });
    s.navigate({ kind: "conversation", id: "c2" });
    useAppStore.getState().goBack();
    expect(useAppStore.getState().route).toEqual({ kind: "conversation", id: "c1" });
    useAppStore.getState().goForward();
    expect(useAppStore.getState().route).toEqual({ kind: "conversation", id: "c2" });
    expect(parseRoute(routeKey({ kind: "conversation", id: "x" }))).toEqual({
      kind: "conversation",
      id: "x",
    });
    expect(parseRoute("garbage")).toEqual({ kind: "new" });
  });

  it("panel icons switch the pane; the selected icon closes the panel", () => {
    const s = useAppStore.getState();
    s.closePanel();
    s.togglePanel("jobs");
    expect(useAppStore.getState()).toMatchObject({ panelPresented: true, panelPane: "jobs" });
    useAppStore.getState().togglePanel("details");
    expect(useAppStore.getState()).toMatchObject({ panelPresented: true, panelPane: "details" });
    useAppStore.getState().togglePanel("details");
    expect(useAppStore.getState().panelPresented).toBe(false);
  });

  it("maps Claude Code's shortcuts", () => {
    const k = (key: string, extra: Partial<KeyboardEvent> = {}) =>
      shortcutCommand({
        key,
        metaKey: true,
        altKey: false,
        ctrlKey: false,
        shiftKey: false,
        ...extra,
      });
    expect(k("n")).toBe("new-chat");
    expect(k("k")).toBe("search");
    expect(k("\\")).toBe("toggle-sidebar");
    expect(k("[")).toBe("back");
    expect(k("i", { altKey: true })).toBe("toggle-panel");
    // The AppKit app's Git and Yardım menus (⇧ keeps ⌘N / ⌘K their own).
    expect(k("P", { shiftKey: true })).toBe("go-posts");
    expect(k("K", { shiftKey: true })).toBe("go-calendar");
    expect(k("M", { shiftKey: true })).toBe("go-media");
    expect(k("N", { shiftKey: true })).toBe("new-brand");
    expect(k("B", { shiftKey: true })).toBe("brand-settings");
    expect(k("?", { shiftKey: true })).toBe("help-shortcuts");
    expect(k("Z", { shiftKey: true })).toBeNull();
    expect(
      shortcutCommand({ key: "n", metaKey: false, altKey: false, ctrlKey: false, shiftKey: false }),
    ).toBeNull();
  });
});

describe("sidebar and search", () => {
  it("groups conversations by brand, most recent first, with Genel last", () => {
    const brands = [
      {
        id: "b1",
        name: "MTM Agro",
        slug: "m",
        defaultLanguage: "tr",
        status: "active" as const,
        createdAt: T,
        updatedAt: T,
      },
      {
        id: "b2",
        name: "Partner",
        slug: "p",
        defaultLanguage: "tr",
        status: "active" as const,
        createdAt: T,
        updatedAt: T,
      },
    ];
    const groups = groupConversations(
      [
        conversation({ id: "1", brandId: "b1", lastActivityAt: "2026-11-10T00:00:00.000Z" }),
        conversation({ id: "2", brandId: "b2", lastActivityAt: "2026-11-15T00:00:00.000Z" }),
        conversation({ id: "3", brandId: null }),
      ],
      brands,
      null,
    );
    expect(groups.map((g) => [g.label, g.conversations.map((c) => c.id)])).toEqual([
      ["Partner", ["2"]],
      ["MTM Agro", ["1"]],
      ["Genel", ["3"]],
    ]);
  });

  it("searches titles without caring about Turkish letters", () => {
    const list = [
      conversation({ id: "1", title: "Şişe görseli" }),
      conversation({ id: "2", title: "Hasat" }),
    ];
    expect(searchConversations(list, "sise").map((c) => c.id)).toEqual(["1"]);
    expect(searchConversations(list, "HASAT").map((c) => c.id)).toEqual(["2"]);
  });

  it("points WebSockets at the local API", () => {
    expect(rewriteSocketUrl("ws://localhost:5183/api/conversations/c1/stream?after=4", 8790)).toBe(
      "ws://127.0.0.1:8790/api/conversations/c1/stream?after=4",
    );
    expect(rewriteSocketUrl("studio://app/api/jobs/stream", 8791)).toBe(
      "ws://127.0.0.1:8791/api/jobs/stream",
    );
  });
});

describe("right panel helpers", () => {
  it("reads context use from the last finished run", async () => {
    const { contextUse, accountRow } = await import(
      "../../src/renderer/components/panels/right-panel.tsx"
    );
    const use = contextUse({
      id: "r",
      conversationId: "c",
      triggerMessageId: "m",
      jobId: null,
      status: "completed",
      attempt: 1,
      model: "opus",
      effort: null,
      usage: { inputTokens: 10, cacheReadTokens: 30_000, cacheWriteTokens: 10_000 },
      error: null,
      createdAt: T,
      updatedAt: T,
      startedAt: T,
      finishedAt: T,
    });
    expect(use?.used).toBe(40_010);
    expect(use?.limit).toBe(200_000);
    expect(Math.round(use?.percent ?? 0)).toBe(20);
    expect(contextUse(null)).toBeNull();
    expect(accountRow("instagram", undefined)).toEqual({
      label: "Instagram",
      value: "Bağla",
      tone: "action",
    });
  });
});
