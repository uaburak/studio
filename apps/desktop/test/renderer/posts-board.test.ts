import { describe, expect, it } from "vitest";
import {
  captionUsage,
  composeCaption,
  parseHashtags,
  splitCaption,
} from "../../src/renderer/features/post-detail/caption.ts";
import {
  approvableHash,
  boardMonths,
  buildBoard,
  cardMetaText,
  cardMonth,
  cardState,
  deletionBlocker,
  filterCounts,
  filterMatches,
  formatText,
  groupByBrand,
  matchesSearch,
  monthWithPosts,
  moveSelection,
  nearestMonth,
  pickSchedule,
  platformText,
  visibleCards,
} from "../../src/renderer/features/posts/board.ts";
import { addMonths, fromInputs, monthTitle } from "../../src/renderer/features/posts/dates.ts";
import {
  aspectLabel,
  editableLayers,
  hexColor,
  hitTest,
  layersInHtml,
  mediaSource,
  parseLayerTransform,
  previewBox,
  resized,
  slotsIn,
  transformPatch,
} from "../../src/renderer/features/posts/slides.ts";
import {
  content,
  contentFor,
  FILLED_HTML,
  hashedVersion,
  job,
  plan,
  SLIDE_HTML,
  schedule,
  slide,
  version,
} from "./post-fixtures.ts";

describe("post states and filters", () => {
  it("derives where a post stands", async () => {
    const v = version("p1", 1);
    const base = { id: "p1", planItem: null, schedule: null, job: null };
    // No version: draft, or generating while a job runs.
    expect(cardState({ ...base, content: content(), version: null })).toBe("draft");
    expect(
      cardState({ ...base, content: content(), version: null, job: job({ status: "running" }) }),
    ).toBe("generating");
    // A version with a filled slot waits for approval; an empty slot waits for a picture.
    expect(cardState({ ...base, content: contentFor(v), version: v })).toBe("ready");
    const empty = version("p1", 1, [slide({ html: SLIDE_HTML })]);
    expect(cardState({ ...base, content: contentFor(empty), version: empty })).toBe("imageNeeded");
    for (const status of ["approved", "scheduled", "publishing", "published", "failed"] as const) {
      expect(cardState({ ...base, content: contentFor(v, { status }), version: v })).toBe(status);
    }
    // in_review with a version is "Onay bekliyor".
    expect(
      cardState({ ...base, content: contentFor(v, { status: "in_review" }), version: v }),
    ).toBe("ready");
    await expect(hashedVersion("p1", 1)).resolves.toHaveProperty("contentHash");
  });

  it("maps states to the Taslak / Onay bekliyor / Zamanlandı / Yayınlandı / Hata filters", () => {
    expect(filterMatches("draft", "draft")).toBe(true);
    expect(filterMatches("draft", "generating")).toBe(true);
    expect(filterMatches("draft", "imageNeeded")).toBe(true);
    expect(filterMatches("review", "ready")).toBe(true);
    expect(filterMatches("review", "approved")).toBe(false);
    expect(filterMatches("scheduled", "publishing")).toBe(true);
    expect(filterMatches("published", "published")).toBe(true);
    expect(filterMatches("failed", "failed")).toBe(true);
    expect(filterMatches("all", "failed")).toBe(true);
  });
});

describe("board", () => {
  const v1 = version("p1", 1);
  const v2 = version("p2", 1);
  const contents = [
    contentFor(v1, { title: "Hasat sonrası", createdAt: "2026-11-02T09:00:00.000Z" }),
    contentFor(v2, {
      id: "p2",
      title: "Bayi ağı",
      brandId: "b2",
      status: "scheduled",
      caption: "Partner Agro bayi ağı büyüyor",
      createdAt: "2026-10-20T09:00:00.000Z",
    }),
    content({
      id: "p3",
      title: "Damla sulama",
      type: "reel",
      createdAt: "2026-11-05T09:00:00.000Z",
    }),
    content({
      id: "p4",
      title: "Eski post",
      status: "published",
      createdAt: "2026-09-01T09:00:00.000Z",
    }),
  ];
  const cards = buildBoard({
    contents,
    versions: new Map([
      ["p1", v1],
      ["p2", v2],
    ]),
    plans: [plan([{ contentId: "p1", date: "2026-11-24", pillar: "Sezon" }])],
    schedules: [
      schedule({ id: "s2", contentId: "p2", scheduledAt: "2026-11-20T10:30:00.000Z" }),
      schedule({
        id: "s3",
        contentId: "p2",
        status: "cancelled",
        scheduledAt: "2026-11-01T10:00:00.000Z",
      }),
    ],
    jobs: [job({ id: "j3", contentId: "p3", type: "content.generate", status: "running" })],
  });

  it("joins versions, plan items, schedules and jobs and sorts by day", () => {
    expect(cards.map((c) => c.id)).toEqual(["p2", "p1", "p4", "p3"]);
    const p1 = cards.find((c) => c.id === "p1");
    expect(p1?.planItem?.pillar).toBe("Sezon");
    expect(p1?.version?.id).toBe("p1-v1");
    // The cancelled schedule is not the card's.
    expect(cards.find((c) => c.id === "p2")?.schedule?.id).toBe("s2");
    expect(cards.find((c) => c.id === "p3")?.job?.id).toBe("j3");
    expect(cardState(cards.find((c) => c.id === "p3") as never)).toBe("generating");
  });

  it("drops a loaded version that is not the current one", () => {
    const stale = buildBoard({
      contents: [contentFor(version("p1", 2))],
      versions: new Map([["p1", v1]]),
    });
    expect(stale[0]?.version).toBeNull();
  });

  it("puts cards in months by schedule, plan day or creation", () => {
    expect(cards.map(cardMonth)).toEqual(["2026-11", "2026-11", "2026-09", "2026-11"]);
    expect(boardMonths(cards)).toEqual(["2026-09", "2026-11"]);
    expect(nearestMonth(["2026-09", "2026-11"], "2026-12")).toBe("2026-11");
    expect(nearestMonth(["2026-09"], "2026-11")).toBe("2026-09");
    expect(nearestMonth([], "2026-11")).toBe("2026-11");
    expect(monthWithPosts(["2026-09", "2026-11"], "2026-11", -1)).toBe("2026-09");
    expect(monthWithPosts(["2026-09", "2026-11"], "2026-11", 1)).toBeNull();
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(monthTitle("2026-11")).toBe("Kasım 2026");
  });

  it("filters the month, counts per status and searches Turkish-insensitively", () => {
    const view = visibleCards(cards, { month: "2026-11", filter: "all", query: "" });
    expect(view.monthTotal).toBe(3);
    expect(view.counts).toMatchObject({
      all: 3,
      draft: 1,
      review: 1,
      scheduled: 1,
      published: 0,
      failed: 0,
    });
    expect(
      visibleCards(cards, { month: "2026-11", filter: "scheduled", query: "" }).cards.map(
        (c) => c.id,
      ),
    ).toEqual(["p2"]);
    // "bayi agi" matches "Bayi ağı"; the counts follow the search.
    const searched = visibleCards(cards, { month: "2026-11", filter: "all", query: "bayi agi" });
    expect(searched.cards.map((c) => c.id)).toEqual(["p2"]);
    expect(searched.counts.all).toBe(1);
    expect(matchesSearch(cards[0] as never, "PARTNER", "x")).toBe(true);
    expect(matchesSearch(cards[1] as never, "mtm", "MTM Agro")).toBe(true);
    expect(filterCounts([]).all).toBe(0);
  });

  it("groups by brand in the brands' order", () => {
    const groups = groupByBrand(cards, ["b2", "b1"]);
    expect(groups.map((g) => g.brandId)).toEqual(["b2", "b1"]);
    expect(groups[1]?.cards.map((c) => c.id)).toEqual(["p1", "p4", "p3"]);
  });

  it("moves the keyboard selection by cards and rows", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(moveSelection(ids, null, 1)).toBe("a");
    expect(moveSelection(ids, null, -1)).toBe("e");
    expect(moveSelection(ids, "b", 1)).toBe("c");
    expect(moveSelection(ids, "b", 4)).toBe("e");
    expect(moveSelection(ids, "b", -4)).toBe("a");
    expect(moveSelection(ids, "gone", 1)).toBe("a");
    expect(moveSelection([], "a", 1)).toBeNull();
  });

  it("writes the card meta line and the format", () => {
    const p2 = cards.find((c) => c.id === "p2") as never;
    expect(cardMetaText(p2)).toBe("Instagram · 20 Kas 13:30");
    expect(cardMetaText(cards.find((c) => c.id === "p1") as never)).toBe("Instagram · 24 Kas");
    expect(platformText({ type: "reel", targetPlatforms: ["instagram"] })).toBe("Reels");
    expect(platformText({ type: "post", targetPlatforms: ["instagram", "facebook"] })).toBe(
      "Instagram +1",
    );
    expect(formatText("carousel", [slide(), slide(), slide()])).toBe("Kaydırmalı · 3 kare · 4:5");
    expect(formatText("post", [slide({ width: 1080, height: 1080 })])).toBe("Tek görsel · 1:1");
  });

  it("knows which posts cannot be deleted", () => {
    expect(deletionBlocker({ status: "draft" })).toBeNull();
    expect(deletionBlocker({ status: "scheduled" })).toMatch(/Zamanlanmış/);
    expect(deletionBlocker({ status: "published" })).toMatch(/Yayınlanmış/);
  });

  it("picks the active schedule, else the latest finished one", () => {
    expect(
      pickSchedule([
        schedule({ id: "late", scheduledAt: "2026-11-30T10:00:00.000Z" }),
        schedule({ id: "early", scheduledAt: "2026-11-19T10:00:00.000Z" }),
        schedule({ id: "done", status: "published", scheduledAt: "2026-11-10T10:00:00.000Z" }),
      ])?.id,
    ).toBe("early");
    expect(
      pickSchedule([
        schedule({ id: "old", status: "published", scheduledAt: "2026-11-01T10:00:00.000Z" }),
        schedule({ id: "new", status: "published", scheduledAt: "2026-11-10T10:00:00.000Z" }),
      ])?.id,
    ).toBe("new");
    expect(pickSchedule([schedule({ status: "cancelled" })])).toBeNull();
  });
});

describe("approval hash", () => {
  it("recomputes the hash and only gives it when it matches the server's", async () => {
    const v = await hashedVersion("p1", 1);
    const c = contentFor(v);
    expect(await approvableHash(c, v)).toBe(v.contentHash);
    // Tampered slides (the shown design is not what the server holds).
    const tampered = { ...v, slides: [{ ...slide(), html: `${FILLED_HTML}x` }] };
    expect(await approvableHash(c, { ...tampered, id: "other" })).toBeNull();
    // Another version than the current one, or a status that cannot be approved.
    expect(await approvableHash(c, { ...v, version: 2 })).toBeNull();
    expect(await approvableHash({ ...c, status: "approved" }, v)).toBeNull();
    expect(await approvableHash(c, null)).toBeNull();
  });
});

describe("slide layers and patches", () => {
  it("reads layers, text with line breaks, slots, hidden layers and transforms", () => {
    const layers = layersInHtml(SLIDE_HTML, 2);
    expect(layers.map((l) => [l.layerId, l.kind])).toEqual([
      ["bg", "shape"],
      ["headline", "text"],
      ["sub", "text"],
      ["photo", "slot"],
      ["logo", "logo"],
      ["old", "text"],
    ]);
    const headline = layers[1];
    expect(headline?.text).toBe("Hasat bitti,\ntoprak hazır mı?");
    expect(headline?.color).toBe("#ffffff");
    expect(headline?.key).toBe("2:headline");
    expect(layers[2]?.text).toBe("Organik madde & kış");
    expect(layers[2]?.transform).toEqual({ translate: { x: 12, y: -8 }, scale: 1.1 });
    expect(layers[3]?.slotState).toBe("empty");
    expect(layers[5]?.hidden).toBe(true);
    expect(editableLayers(layers).map((l) => l.layerId)).toEqual([
      "bg",
      "headline",
      "sub",
      "photo",
      "logo",
      "old",
    ]);
    expect(
      slotsIn([{ html: SLIDE_HTML }, { html: FILLED_HTML }]).map((s) => [s.slideIndex, s.state]),
    ).toEqual([
      [0, "empty"],
      [1, "filled"],
    ]);
    expect(parseLayerTransform(null)).toEqual({ translate: { x: 0, y: 0 }, scale: 1 });
  });

  it("writes design-kit patches (identity parts removed)", () => {
    expect(transformPatch(0, "sub", { translate: { x: 0, y: 0 }, scale: 1 })).toEqual({
      slide: 0,
      op: "transform",
      layer: "sub",
      translate: null,
      scale: null,
    });
    expect(
      transformPatch(1, "sub", { translate: { x: 12.345, y: -20000 }, scale: 1.23456 }),
    ).toEqual({
      slide: 1,
      op: "transform",
      layer: "sub",
      translate: { x: 12.3, y: -10000 },
      scale: 1.235,
    });
    expect(mediaSource("a/1", "image/png")).toBe("/media/a%2F1.png");
    expect(mediaSource("a1", null)).toBe("/media/a1.jpg");
    expect(hexColor("#FFF")).toBe("#ffffff");
    expect(hexColor("rgb(255, 106, 0)")).toBe("#ff6a00");
    expect(hexColor("var(--x)", "#000000")).toBe("#000000");
    expect(aspectLabel(1080, 1920)).toBe("9:16");
  });

  it("hit-tests the smallest box and keeps resizes anchored top-left", () => {
    const boxes = slide().layers ?? [];
    expect(hitTest(100, 950, boxes)?.id).toBe("headline");
    expect(hitTest(1000, 1300, boxes)?.id).toBe("bg");
    expect(hitTest(5000, 5000, boxes)).toBeNull();
    const box = { x: 100, y: 100, w: 200, h: 100 };
    const next = resized({ translate: { x: 0, y: 0 }, scale: 1 }, box, 2);
    expect(next).toEqual({ translate: { x: 100, y: 50 }, scale: 2 });
    // The preview keeps the top-left corner where it was.
    const preview = previewBox(box, { translate: { x: 0, y: 0 }, scale: 1 }, next);
    expect(preview).toEqual({ x: 100, y: 100, w: 400, h: 200 });
  });
});

describe("caption", () => {
  it("splits the hashtag block and composes it back", () => {
    expect(splitCaption("Merhaba\nikinci satır\n\n#a #b\n#c\n")).toEqual({
      body: "Merhaba\nikinci satır",
      hashtags: ["#a", "#b", "#c"],
    });
    expect(splitCaption("#sadece #etiket")).toEqual({ body: "", hashtags: ["#sadece", "#etiket"] });
    expect(parseHashtags("venta, #bor  çinko")).toEqual(["#venta", "#bor", "#çinko"]);
    expect(composeCaption(" Gövde ", "a #b")).toBe("Gövde\n\n#a #b");
    expect(composeCaption("", "#a")).toBe("#a");
  });

  it("counts characters and hashtags against each platform's limit", () => {
    const usage = captionUsage(`${"x".repeat(2201)} #a`, ["instagram", "linkedin"]);
    expect(usage[0]).toMatchObject({ platform: "instagram", over: true, limit: 2200, hashtags: 1 });
    expect(usage[1]).toMatchObject({ platform: "linkedin", over: false, hashtagLimit: null });
    expect(captionUsage("🌾 merhaba", [])[0]).toMatchObject({
      platform: "instagram",
      characters: 9,
    });
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    expect(captionUsage(tags, ["instagram"])[0]?.over).toBe(true);
  });

  it("parses date and time fields as local time", () => {
    const d = fromInputs("2026-11-18", "10:30");
    expect(d?.getHours()).toBe(10);
    expect(d?.getDate()).toBe(18);
    expect(fromInputs("2026-11-18", "25:00")).toBeNull();
    expect(fromInputs("bad", "10:00")).toBeNull();
  });
});
