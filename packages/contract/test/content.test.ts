import { describe, expect, it } from "vitest";
import {
  APPROVABLE_STATUSES,
  CONTENT_TRANSITIONS,
  ContentCreate,
  ContentStatus,
  ContentTransition,
  ContentUpdate,
  ContentVersionCreate,
  canTransitionContent,
  computeContentHash,
  isManualContentTransition,
  MANUAL_CONTENT_TRANSITIONS,
  MAX_SLIDE_HTML_BYTES,
  SCHEDULABLE_STATUSES,
  UNDELETABLE_STATUSES,
  VERSIONABLE_STATUSES,
} from "../src/index.ts";

const statuses = ContentStatus.options;

describe("content state machine", () => {
  it("follows the PLAN.md §8 happy path", () => {
    const path = [
      "draft",
      "in_review",
      "approved",
      "scheduled",
      "publishing",
      "published",
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i];
      const to = path[i + 1];
      if (!from || !to) throw new Error("bad path");
      expect(canTransitionContent(from, to), `${from} -> ${to}`).toBe(true);
    }
    expect(canTransitionContent("publishing", "failed")).toBe(true);
  });

  it("treats published as terminal", () => {
    for (const to of statuses) expect(canTransitionContent("published", to)).toBe(false);
  });

  it("never skips approval on the way to scheduling or publishing", () => {
    for (const from of ["draft", "in_review"] as const) {
      expect(canTransitionContent(from, "scheduled")).toBe(false);
      expect(canTransitionContent(from, "publishing")).toBe(false);
      expect(canTransitionContent(from, "published")).toBe(false);
    }
    expect(canTransitionContent("approved", "publishing")).toBe(false);
  });

  it("only allows manual transitions that are also legal transitions", () => {
    for (const from of statuses) {
      for (const to of MANUAL_CONTENT_TRANSITIONS[from]) {
        expect(canTransitionContent(from, to), `${from} -> ${to}`).toBe(true);
      }
    }
    expect(isManualContentTransition("draft", "approved")).toBe(false);
    expect(isManualContentTransition("approved", "scheduled")).toBe(false);
    expect(isManualContentTransition("scheduled", "publishing")).toBe(false);
    expect(isManualContentTransition("approved", "draft")).toBe(true);
  });

  it("lets every versionable status fall back to draft", () => {
    for (const from of VERSIONABLE_STATUSES) {
      if (from !== "draft") expect(canTransitionContent(from, "draft"), from).toBe(true);
    }
    expect(VERSIONABLE_STATUSES).not.toContain("publishing");
    expect(VERSIONABLE_STATUSES).not.toContain("published");
  });

  it("keeps the helper lists consistent with the transition table", () => {
    for (const from of APPROVABLE_STATUSES)
      expect(canTransitionContent(from, "approved")).toBe(true);
    for (const from of SCHEDULABLE_STATUSES) {
      if (from !== "scheduled") expect(canTransitionContent(from, "scheduled")).toBe(true);
    }
    expect(UNDELETABLE_STATUSES).toEqual(["scheduled", "publishing", "published"]);
    expect(Object.keys(CONTENT_TRANSITIONS).sort()).toEqual([...statuses].sort());
  });
});

describe("computeContentHash", () => {
  const slides = [
    { html: "<p>1</p>", width: 1080, height: 1350 },
    { html: "<p>2</p>", width: 1080, height: 1350 },
  ];

  it("is a stable hex SHA-256 of the ordered slides", async () => {
    const a = await computeContentHash(slides);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await computeContentHash(structuredClone(slides))).toBe(a);
  });

  it("changes with order, size and HTML, ignores extra fields", async () => {
    const base = await computeContentHash(slides);
    expect(await computeContentHash([...slides].reverse())).not.toBe(base);
    const [first, second] = slides as [(typeof slides)[0], (typeof slides)[0]];
    expect(await computeContentHash([{ ...first, width: 1081 }, second])).not.toBe(base);
    expect(await computeContentHash([{ ...first, html: "<p>1 </p>" }, second])).not.toBe(base);
    const withRender = slides.map((s) => ({ ...s, renderedAssetId: "x" }));
    expect(await computeContentHash(withRender)).toBe(base);
  });

  it("hashes the documented canonical form (fixed key order: width, height, html)", async () => {
    expect(await computeContentHash([{ html: "a", width: 1, height: 1 }])).toBe(
      await sha256('[{"width":1,"height":1,"html":"a"}]'),
    );
  });
});

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("content schemas", () => {
  it("applies defaults on create", () => {
    expect(ContentCreate.parse({ brandId: "b", type: "post", title: " Başlık " })).toEqual({
      brandId: "b",
      type: "post",
      title: "Başlık",
      brief: "",
      targetPlatforms: [],
      caption: "",
    });
  });

  it("rejects duplicate platforms, unknown types and empty updates", () => {
    expect(
      ContentCreate.safeParse({
        brandId: "b",
        type: "post",
        title: "x",
        targetPlatforms: ["instagram", "instagram"],
      }).success,
    ).toBe(false);
    expect(ContentCreate.safeParse({ brandId: "b", type: "tweet", title: "x" }).success).toBe(
      false,
    );
    expect(ContentUpdate.safeParse({}).success).toBe(false);
    expect(ContentUpdate.safeParse({ caption: "ok" }).success).toBe(true);
  });

  it("only exposes manual targets in ContentTransition", () => {
    expect(ContentTransition.safeParse({ to: "in_review" }).success).toBe(true);
    expect(ContentTransition.safeParse({ to: "published" }).success).toBe(false);
    expect(ContentTransition.safeParse({ to: "scheduled" }).success).toBe(false);
  });

  it("validates versions: slide sizes, HTML byte limit, origin", () => {
    const ok = { origin: "generated", slides: [{ html: "<p/>", width: 1080, height: 1920 }] };
    expect(ContentVersionCreate.safeParse(ok).success).toBe(true);
    expect(ContentVersionCreate.safeParse({ ...ok, slides: [] }).success).toBe(false);
    expect(ContentVersionCreate.safeParse({ ...ok, origin: "magic" }).success).toBe(false);
    expect(
      ContentVersionCreate.safeParse({ ...ok, slides: [{ html: "<p/>", width: 0, height: 10 }] })
        .success,
    ).toBe(false);
    // "ş" is 2 bytes in UTF-8: half the char limit already exceeds the byte limit.
    const heavy = "ş".repeat(MAX_SLIDE_HTML_BYTES / 2 + 1);
    expect(
      ContentVersionCreate.safeParse({ ...ok, slides: [{ html: heavy, width: 10, height: 10 }] })
        .success,
    ).toBe(false);
  });
});
