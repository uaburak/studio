// Logic of the audit's posts work (A3, A4, N1–N4, 7): failed generation on the board, version
// polling with backoff, stable cards, multi-select, bulk splits and times, the plan page's item
// states, the estimate wording, the virtual grid and the media usage groups.
import type { AssetUsage, Content, GenerationEstimate, Plan, PlanItem } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { usageGroups } from "../../src/renderer/features/media/asset-delete.tsx";
import {
  buildBoard,
  cardState,
  filterMatches,
  generationFailure,
  type PostCard,
  rangeSelection,
  toggleSelection,
  visibleSelection,
} from "../../src/renderer/features/posts/board.ts";
import {
  approvable,
  approvalLosses,
  daysBetween,
  deletable,
  mapLimit,
  revisable,
  schedulable,
  spreadTimes,
} from "../../src/renderer/features/posts/bulk.ts";
import {
  boardJobSignature,
  RENDER_POLL_FIRST_MS,
  renderPollInterval,
  reuseCards,
  versionMonths,
} from "../../src/renderer/features/posts/data.ts";
import {
  basisLine,
  budgetLine,
  durationText,
  estimateLine,
  needsEstimate,
} from "../../src/renderer/features/posts/estimate.tsx";
import { failureText } from "../../src/renderer/features/posts/failure.ts";
import {
  draftError,
  draftOf,
  draftPatch,
  failedItemIds,
  generateSummary,
  itemAction,
  itemFailure,
  itemState,
  newItemDraft,
  planCounts,
  planGroups,
  planTitle,
} from "../../src/renderer/features/posts/plan-model.ts";
import { gridWindow } from "../../src/renderer/lib/virtual-grid.ts";
import { content, contentFor, job, schedule, slide, T, version } from "./post-fixtures.ts";

function card(over: Partial<PostCard> = {}): PostCard {
  const c = over.content ?? content();
  return {
    id: c.id,
    content: c,
    version: null,
    planItem: null,
    schedule: null,
    job: null,
    ...over,
  };
}

function item(over: Partial<PlanItem> = {}): PlanItem {
  return {
    id: "it1",
    planId: "pl1",
    position: 0,
    date: "2026-11-20",
    platforms: ["instagram"],
    contentType: "post",
    title: "Kış bakımı",
    brief: "Toprak",
    pillar: null,
    hook: null,
    similar: [],
    imageSlot: "none",
    imageBrief: null,
    status: "accepted",
    contentId: "p1",
    generation: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function plan(items: PlanItem[], over: Partial<Plan> = {}): Plan {
  return {
    id: "pl1",
    brandId: "b1",
    conversationId: null,
    runId: null,
    title: "",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    status: "accepted",
    summary: "",
    revision: 1,
    decidedAt: null,
    rejectionReason: null,
    items,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

describe("failed generation on the board (A3)", () => {
  it("shows Üretilemedi when the post has no design and its last generation failed", () => {
    const failed = job({
      id: "g1",
      type: "content.generate",
      status: "failed",
      error: "render failed",
      finishedAt: "2026-11-17T11:00:00.000Z",
    });
    const c = card({ job: failed });
    expect(cardState(c)).toBe("generationFailed");
    expect(generationFailure(c)).toEqual({ jobId: "g1", error: "render failed" });
    expect(filterMatches("failed", "generationFailed")).toBe(true);
    // Stopped is not failed; a newer running job settles it.
    expect(cardState(card({ job: { ...failed, status: "cancelled" } }))).toBe("draft");
    expect(cardState(card({ job: { ...failed, status: "running" } }))).toBe("generating");
  });

  it("reads a plan item's failed generation when the job is not in the live list", () => {
    const c = card({
      planItem: item({ generation: { jobId: "g9", status: "failed", error: "Zaman aşımı" } }),
    });
    expect(cardState(c)).toBe("generationFailed");
    expect(generationFailure(c)?.jobId).toBe("g9");
  });

  it("only counts a failure on a post with a design when it came after that design", () => {
    const v = version("p1", 2, [slide()], { createdAt: "2026-11-17T12:00:00.000Z" });
    const failedEarlier = job({
      type: "content.generate",
      status: "failed",
      finishedAt: "2026-11-17T11:00:00.000Z",
    });
    const c = card({ content: contentFor(v), version: v, job: failedEarlier });
    expect(generationFailure(c)).toBeNull();
    const failedLater = { ...failedEarlier, finishedAt: "2026-11-17T13:00:00.000Z" };
    expect(generationFailure({ ...c, job: failedLater })).not.toBeNull();
    expect(cardState({ ...c, job: failedLater })).toBe("ready");
  });

  it("says why in Turkish and keeps the original", () => {
    expect(
      failureText("worker w1 lost the job (its lease expired); gave up after 3 attempt(s)"),
    ).toEqual({
      text: "Mac'teki işçi işi yarıda bıraktı.",
      detail: "worker w1 lost the job (its lease expired); gave up after 3 attempt(s)",
    });
    expect(failureText("Post silinmiş; önce geri al.")).toEqual({
      text: "Post silinmiş; önce geri al.",
      detail: null,
    });
    expect(failureText("boom").text).toBe("İş başarısız oldu.");
    expect(failureText(null).text).toBe("Neden bildirilmedi.");
  });
});

describe("board loading (A4)", () => {
  it("polls a version without renders with a growing pause and stops", () => {
    const waiting = version("p1", 1, [slide({ renderedAssetId: null })]);
    expect(renderPollInterval(waiting, 1)).toBe(RENDER_POLL_FIRST_MS);
    expect(renderPollInterval(waiting, 2)).toBe(RENDER_POLL_FIRST_MS * 2);
    expect(renderPollInterval(waiting, 6)).toBe(120_000);
    expect(renderPollInterval(waiting, 10)).toBe(false);
    // A failed render, or a version with every render: no polling.
    expect(renderPollInterval(waiting, 1, true)).toBe(false);
    expect(renderPollInterval(version("p1", 1), 1)).toBe(false);
    expect(renderPollInterval(undefined, 0)).toBe(false);
  });

  it("loads the shown month's versions and prefetches the ones beside it", () => {
    expect(versionMonths("2026-01")).toEqual(["2026-01", "2025-12", "2026-02"]);
  });

  it("keeps cards that did not change (memoized cards do not draw again)", () => {
    const a = content({ id: "a" });
    const b = content({ id: "b" });
    const first = buildBoard({ contents: [a, b] });
    const same = reuseCards(first, buildBoard({ contents: [a, b] }));
    expect(same).toBe(first);
    const b2 = { ...b, title: "Yeni" };
    const next = reuseCards(first, buildBoard({ contents: [a, b2] }));
    expect(next).not.toBe(first);
    expect(next.find((c) => c.id === "a")).toBe(first.find((c) => c.id === "a"));
    expect(next.find((c) => c.id === "b")?.content.title).toBe("Yeni");
  });

  it("changes the job signature only when a board job changes status", () => {
    const j = job({ type: "content.generate", status: "running", progress: 0.2 });
    const a = boardJobSignature([j, job({ id: "x", type: "chat.turn", contentId: undefined })]);
    expect(boardJobSignature([{ ...j, progress: 0.8, progressMessage: "Render" }])).toBe(a);
    expect(boardJobSignature([{ ...j, status: "succeeded" }])).not.toBe(a);
  });

  it("draws only the rows near the viewport", () => {
    const base = {
      count: 1000,
      width: 650,
      minColumn: 150,
      columnGap: 12,
      rowGap: 16,
      aspect: 1,
      extra: 40,
      viewport: 600,
    };
    const top = gridWindow({ ...base, scrollTop: 0 });
    expect(top.columns).toBe(4);
    expect(top.start).toBe(0);
    expect(top.end).toBeLessThan(40);
    expect(top.padTop).toBe(0);
    const middle = gridWindow({ ...base, scrollTop: 5_000 });
    expect(middle.start).toBeGreaterThan(0);
    expect(middle.start % 4).toBe(0);
    expect(middle.padTop).toBeGreaterThan(4_000);
    const rows = Math.ceil(1000 / 4);
    const stride = middle.rowHeight + 16;
    expect(
      middle.padTop + middle.padBottom + ((middle.end - middle.start) / 4) * stride,
    ).toBeCloseTo(rows * stride);
    // Not laid out yet: everything.
    expect(gridWindow({ ...base, width: 0, scrollTop: 0 })).toMatchObject({ start: 0, end: 1000 });
  });
});

describe("multi-select (N1)", () => {
  const ids = ["a", "b", "c", "d", "e"];
  it("toggles with ⌘ and picks ranges with ⇧", () => {
    expect(toggleSelection([], "b")).toEqual(["b"]);
    expect(toggleSelection(["b", "c"], "b")).toEqual(["c"]);
    expect(rangeSelection(ids, ["a"], "b", "d")).toEqual(["a", "b", "c", "d"]);
    expect(rangeSelection(ids, [], "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeSelection(ids, ["e"], null, "c")).toEqual(["e", "c"]);
    expect(visibleSelection(ids, ["e", "zz", "a"])).toEqual(["a", "e"]);
  });
});

describe("bulk actions (N1, N3)", () => {
  const v = version("p1", 1);
  const draft = card({ content: contentFor(v), version: v });
  const empty = card({ content: content({ id: "p2" }) });
  const approved = card({ content: contentFor(v, { id: "p3", status: "approved" }) });
  const scheduled = card({ content: contentFor(v, { id: "p4", status: "scheduled" }) });
  const busy = card({
    content: contentFor(v, { id: "p5" }),
    job: job({ contentId: "p5", status: "running" }),
  });

  it("takes the posts each action can work on and says why for the rest", () => {
    const a = approvable([draft, empty, approved, busy]);
    expect(a.take.map((c) => c.id)).toEqual(["p1"]);
    expect(a.skip.map((s) => s.reason)).toEqual([
      "Henüz tasarımı yok.",
      "Zaten onaylı.",
      "Üretimi ya da render'ı sürüyor.",
    ]);
    expect(schedulable([draft, approved, scheduled]).take.map((c) => c.id)).toEqual(["p3", "p4"]);
    expect(deletable([draft, scheduled]).skip[0]?.reason).toMatch(/Zamanlanmış post silinemez/);
    const r = revisable([draft, empty, approved, busy]);
    expect(r.take.map((c) => c.id)).toEqual(["p1", "p3"]);
    expect(approvalLosses(r.take).map((c) => c.id)).toEqual(["p3"]);
  });

  it("spreads posts over the days, one a day while there are enough", () => {
    const cards = ["a", "b", "c"].map((id) => card({ content: content({ id }) }));
    const times = spreadTimes(cards, {
      mode: "spread",
      from: "2026-12-01",
      to: "2026-12-06",
      time: "10:30",
    });
    expect(times.map((t) => t.at?.toString().slice(0, 21))).toEqual([
      "Tue Dec 01 2026 10:30",
      "Thu Dec 03 2026 10:30",
      "Sat Dec 05 2026 10:30",
    ]);
    // More posts than days: the ones sharing a day go out 30 minutes apart.
    const crowded = spreadTimes(cards, {
      mode: "spread",
      from: "2026-12-01",
      to: "2026-12-02",
      time: "10:00",
    });
    expect(crowded.map((t) => [t.at?.getDate(), t.at?.getHours(), t.at?.getMinutes()])).toEqual([
      [1, 10, 0],
      [1, 10, 30],
      [2, 10, 0],
    ]);
    expect(daysBetween("2026-12-05", "2026-12-01")).toEqual([]);
  });

  it("keeps each post's planned day, and says when there is none", () => {
    const planned = card({
      content: content({ id: "a" }),
      planItem: item({ date: "2026-12-10", contentId: "a" }),
    });
    const scheduledCard = card({
      content: content({ id: "b" }),
      schedule: schedule({ contentId: "b", scheduledAt: "2026-12-10T12:00:00.000Z" }),
    });
    const undated = card({ content: content({ id: "c" }) });
    const times = spreadTimes([planned, scheduledCard, undated], {
      mode: "planned",
      from: "",
      to: "",
      time: "09:00",
    });
    expect(times[0]?.at?.getDate()).toBe(10);
    expect(times[0]?.at?.getHours()).toBe(9);
    expect(times[1]?.at?.getMinutes()).toBe(30);
    expect(times[2]).toMatchObject({ at: null, reason: "Plan tarihi yok." });
  });

  it("runs at most `limit` at a time and keeps the order and the failures", async () => {
    let running = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      if (n === 3) throw new Error("üç");
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : "x"))).toEqual([
      10,
      20,
      "x",
      40,
      50,
    ]);
  });
});

describe("plan page (N2)", () => {
  const withVersion = contentFor(version("p1", 1));
  const contentOf = (map: Record<string, Content | null>) => (id: string | null) =>
    id ? (map[id] ?? null) : null;

  it("says where each item stands", () => {
    expect(itemState(item({ status: "planned" }), undefined)).toBe("planned");
    expect(itemState(item(), null)).toBe("deleted");
    expect(itemState(item(), content())).toBe("pending");
    expect(
      itemState(item({ generation: { jobId: "g", status: "running", error: null } }), content()),
    ).toBe("generating");
    const failed = item({ generation: { jobId: "g", status: "failed", error: "render failed" } });
    expect(itemState(failed, content())).toBe("failed");
    expect(itemFailure(failed, "failed")).toBe("Görsel oluşturulamadı.");
    expect(itemState(item(), withVersion)).toBe("generated");
    expect(itemState(item(), { ...withVersion, status: "approved" })).toBe("approved");
    expect(itemState(item(), { ...withVersion, status: "scheduled" })).toBe("scheduled");
    expect(itemAction("pending")).toBe("generate");
    expect(itemAction("failed")).toBe("retry");
    expect(itemAction("generated")).toBe("regenerate");
    expect(itemAction("generating")).toBeNull();
  });

  it("counts the plan and finds the failed items", () => {
    const p = plan([
      item({ id: "a", contentId: "c1" }),
      item({
        id: "b",
        contentId: "c2",
        generation: { jobId: "g", status: "failed", error: null },
      }),
      item({ id: "c", contentId: "c3" }),
      item({ id: "d", status: "skipped", contentId: null }),
    ]);
    const of = contentOf({
      c1: content({ id: "c1" }),
      c2: content({ id: "c2" }),
      c3: { ...withVersion, id: "c3" },
    });
    expect(planCounts(p, of)).toEqual({ total: 3, pending: 1, generating: 0, failed: 1, done: 1 });
    expect(failedItemIds(p, of)).toEqual(["b"]);
  });

  it("groups plans by month, newest first, without superseded ones", () => {
    const nov = plan([], { id: "n" });
    const dec = plan([], { id: "d", periodStart: "2026-12-01", periodEnd: "2026-12-31" });
    const old = plan([], { id: "o", status: "superseded" });
    expect(planGroups([nov, old, dec]).map((g) => [g.title, g.plans.map((p) => p.id)])).toEqual([
      ["Aralık 2026", ["d"]],
      ["Kasım 2026", ["n"]],
    ]);
    expect(planTitle(nov)).toBe("Kasım 2026 planı");
  });

  it("sums up a generation round in words", () => {
    expect(generateSummary(3, [])).toBe("3 post üretime alındı.");
    expect(
      generateSummary(0, [{ reason: "generated" }, { reason: "edited" }, { reason: "generated" }]),
    ).toBe("Üretilecek post yok; 3 post atlandı (zaten üretilmiş, elle düzenlenmiş).");
  });

  it("checks and diffs the item form", () => {
    const p = plan([]);
    const original = item();
    const draft = draftOf(original);
    expect(draftPatch(original, draft)).toEqual({});
    expect(
      draftPatch(original, { ...draft, title: " Yeni ", date: "", platforms: ["linkedin"] }),
    ).toEqual({ title: "Yeni", date: null, platforms: ["linkedin"] });
    expect(draftError({ ...draft, title: "  " }, p)).toBe("Konu boş olamaz.");
    expect(draftError({ ...draft, date: "2026-12-02" }, p)).toBe("Tarih planın ayı içinde olmalı.");
    expect(draftError({ ...draft, platforms: [] }, p)).toBe("En az bir platform seç.");
    expect(newItemDraft(p)).toMatchObject({ date: "2026-11-01", contentType: "post" });
  });
});

describe("estimate (N4)", () => {
  const e: GenerationEstimate = {
    count: 30,
    perItemSeconds: 150,
    totalSeconds: 4_500,
    basis: "history",
    sampleSize: 24,
    defaultsAsOf: "2026-11-18",
    perItemUsd: 0,
    textUsd: 0,
    imageSlots: 4,
    perImageUsd: 0.04,
    imagesIncluded: false,
    imageUsd: 0.16,
    totalUsd: 0,
    budgetRemainingUsd: 12,
  };
  it("asks only above the threshold", () => {
    expect(needsEstimate(5)).toBe(false);
    expect(needsEstimate(6)).toBe(true);
  });
  it("writes the time and the cost in one line", () => {
    expect(durationText(30)).toBe("1 dakikadan kısa");
    expect(durationText(36 * 60)).toBe("≈ 36 dakika");
    expect(durationText(100 * 60)).toBe("≈ 1 saat 40 dakika");
    expect(estimateLine(e)).toBe(
      "≈ 75 dakika, ≈ $0 (Claude aboneliği: ücretsiz; Gemini görselleri: bu üretimde yapılmaz (4 görsel ayrıca üretilirse ≈ $0.160))",
    );
    expect(basisLine(e)).toBe("Bu Mac'teki son 24 üretimden ölçüldü; post başına 3 dakika.");
    expect(basisLine({ ...e, basis: "default", sampleSize: 0 })).toMatch(
      /varsayılan değerler \(2026-11-18\)/,
    );
    expect(budgetLine(e)).toBe("Bu ayın kalan yapay zekâ bütçesi: $12.00.");
    expect(budgetLine({ ...e, budgetRemainingUsd: null })).toBeNull();
  });
});

describe("media delete (7)", () => {
  it("lists the blocking usages first, grouped", () => {
    const usage = (kind: AssetUsage["kind"], label: string, blocking = true): AssetUsage => ({
      kind,
      blocking,
      label,
      contentId: null,
      version: null,
      productId: null,
      conversationId: null,
    });
    expect(
      usageGroups([
        usage("conversation", "Sohbet", false),
        usage("version", "“Kış” v2, 1. kare"),
        usage("product", "Gübre 25 kg"),
      ]).map((g) => [g.title, g.items.map((i) => i.label)]),
    ).toEqual([
      ["Postlarda", ["“Kış” v2, 1. kare"]],
      ["Ürünlerde", ["Gübre 25 kg"]],
      ["Sohbetlerde", ["Sohbet"]],
    ]);
  });
});
