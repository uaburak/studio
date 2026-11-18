import { describe, expect, it } from "vitest";
import {
  altTextFromSlideText,
  BEST_TIME_MIN_POSTS,
  CloudOrderCreate,
  Content,
  computeBestTimes,
  detailFieldsSet,
  engagementRate,
  JOB_PAYLOAD_SCHEMAS,
  JOB_TYPE_REQUIREMENTS,
  JobType,
  localSlot,
  newCommentsNotice,
  nextInsightsSyncAt,
  nextSlotTime,
  PublishDetails,
  publishDetailIssues,
  relativeScores,
  resolvePublishDetails,
  Schedule,
  slotLabel,
  WorkerScheduleOutcome,
} from "../src/index.ts";

const H = 3_600_000;
const D = 24 * H;

describe("publish details (N13)", () => {
  const details: PublishDetails = {
    firstComment: "  #tarım #hasat  ",
    altTexts: ["Buğday tarlası", null, "  "],
    location: { id: "110011", name: "Konya" },
    collaborators: ["ortak.marka", "ortak.marka"],
    userTags: [
      { slide: 0, username: "ali", x: 0.2, y: 0.3 },
      { slide: 0, username: "ali", x: 0.5, y: 0.5 },
      { slide: 2, username: "veli", x: 0.1, y: 0.1 },
    ],
    reelCover: { kind: "frame", offsetMs: 1500 },
    shareToFeed: false,
  };

  it("validates usernames, location ids and limits", () => {
    expect(PublishDetails.safeParse(details).success).toBe(true);
    expect(PublishDetails.safeParse({ collaborators: ["@ali"] }).success).toBe(false);
    expect(PublishDetails.safeParse({ collaborators: ["a", "b", "c", "d"] }).success).toBe(false);
    expect(PublishDetails.safeParse({ location: { id: "konya", name: "Konya" } }).success).toBe(
      false,
    );
    expect(
      PublishDetails.safeParse({ userTags: [{ slide: 0, username: "ali", x: 1.2, y: 0 }] }).success,
    ).toBe(false);
    expect(PublishDetails.safeParse({ altTexts: ["x".repeat(1001)] }).success).toBe(false);
  });

  it("resolves only what each platform supports", () => {
    const ig = resolvePublishDetails(details, "instagram.carousel", 3);
    expect(ig).toEqual({
      firstComment: "#tarım #hasat",
      altTexts: ["Buğday tarlası", undefined, undefined],
      locationId: "110011",
      collaborators: ["ortak.marka"],
      userTags: [[{ username: "ali", x: 0.2, y: 0.3 }], [], [{ username: "veli", x: 0.1, y: 0.1 }]],
    });
    const reel = resolvePublishDetails(details, "instagram.reel", 1);
    expect(reel.altTexts).toEqual([]);
    expect(reel.shareToFeed).toBe(false);
    expect(reel.reelCover).toEqual({ kind: "frame", offsetMs: 1500 });
    expect(reel.userTags).toEqual([
      [
        { username: "ali", x: 0.2, y: 0.3 },
        { username: "veli", x: 0.1, y: 0.1 },
      ],
    ]);
    const fb = resolvePublishDetails(details, "facebook.photo", 1);
    expect(fb).toEqual({
      firstComment: "#tarım #hasat",
      altTexts: ["Buğday tarlası"],
      userTags: [],
    });
    const li = resolvePublishDetails(details, "linkedin.image", 1);
    expect(li.firstComment).toBeUndefined();
    expect(li.altTexts).toEqual(["Buğday tarlası"]);
    expect(resolvePublishDetails(null, "instagram.reel", 1).shareToFeed).toBe(true);
    expect(resolvePublishDetails(details, "instagram.story", 1)).toEqual({
      altTexts: [],
      userTags: [],
    });
  });

  it("says what is left out and what breaks a limit", () => {
    const fb = publishDetailIssues(details, "facebook.photo", 1);
    expect(fb.errors).toEqual([]);
    expect(fb.warnings[0]?.message).toMatch(
      /^Konum, Ortak paylaşım, Kişi etiketleri, Reels kapağı, Akışta da göster bu Facebook paylaşımında desteklenmiyor/,
    );
    const long = publishDetailIssues({ firstComment: "a".repeat(2201) }, "instagram.image", 1);
    expect(long.errors.map((e) => e.code)).toEqual(["FIRST_COMMENT_TOO_LONG"]);
    expect(
      publishDetailIssues({ firstComment: "a".repeat(2201) }, "facebook.photo", 1).errors,
    ).toEqual([]);
    const hashtags = Array.from({ length: 31 }, (_, i) => `#h${i}`).join(" ");
    expect(
      publishDetailIssues({ firstComment: hashtags }, "instagram.image", 1).errors[0]?.code,
    ).toBe("TOO_MANY_HASHTAGS");
    const missingSlide = publishDetailIssues(details, "instagram.carousel", 2);
    expect(missingSlide.warnings.map((w) => w.code)).toContain("USER_TAG_SLIDE_MISSING");
    const many = {
      userTags: Array.from({ length: 21 }, (_, i) => ({ slide: 0, username: `u${i}`, x: 0, y: 0 })),
    };
    expect(publishDetailIssues(many, "instagram.image", 1).errors[0]?.code).toBe(
      "TOO_MANY_USER_TAGS",
    );
    expect(
      publishDetailIssues({ reelCover: { kind: "frame", offsetMs: 9000 } }, "instagram.reel", 1, {
        videoDurationMs: 8000,
      }).errors[0]?.code,
    ).toBe("THUMB_OFFSET_OUT_OF_RANGE");
    expect(detailFieldsSet({ shareToFeed: true })).toEqual([]);
  });

  it("builds an alt text from slide text", () => {
    expect(altTextFromSlideText("<h1>Yeni&nbsp;sezon</h1> <p>Tohumlar   hazır</p>")).toBe(
      "Görselde yazan: Yeni sezon Tohumlar hazır",
    );
    expect(altTextFromSlideText("   ")).toBeNull();
    expect(altTextFromSlideText("x ".repeat(400))?.length).toBeLessThanOrEqual(1000);
  });

  it("is additive on Content, Schedule, outcomes and cloud orders", () => {
    const content = {
      id: "c1",
      brandId: "b1",
      type: "post",
      title: "T",
      brief: "",
      status: "draft",
      targetPlatforms: [],
      caption: "",
      currentVersion: null,
      approval: null,
      createdAt: "2026-11-19T10:00:00.000Z",
      updatedAt: "2026-11-19T10:00:00.000Z",
    };
    expect(Content.safeParse(content).success).toBe(true);
    expect(Content.safeParse({ ...content, publishDetails: details }).success).toBe(true);
    const schedule = {
      id: "s1",
      contentId: "c1",
      brandId: "b1",
      platform: "instagram",
      socialAccountId: "a1",
      versionId: "v1",
      contentHash: "a".repeat(64),
      scheduledAt: "2026-11-19T10:00:00.000Z",
      status: "published",
      cancelledAt: null,
      createdAt: "2026-11-19T10:00:00.000Z",
      updatedAt: "2026-11-19T10:00:00.000Z",
    };
    expect(Schedule.safeParse(schedule).success).toBe(true);
    expect(
      Schedule.safeParse({
        ...schedule,
        externalPostId: "1789",
        publishedAt: "2026-11-19T10:00:00.000Z",
        warnings: [{ code: "FIRST_COMMENT_FAILED", message: "x" }],
        detailsRevision: 2,
      }).success,
    ).toBe(true);
    expect(
      WorkerScheduleOutcome.parse({
        status: "published",
        warnings: [{ code: "FIRST_COMMENT_FAILED", message: "x" }],
      }).warnings,
    ).toHaveLength(1);
    const media = (id: string, extra = {}) => ({
      id,
      kind: "image",
      mimeType: "image/jpeg",
      bytes: 10,
      sha256: "b".repeat(64),
      ...extra,
    });
    const order = {
      contentId: "c1",
      versionId: "v1",
      contentHash: "a".repeat(64),
      scheduledAt: "2027-01-01T10:00:00.000Z",
      media: [media("slide-1.jpg", { userTags: [{ username: "ali", x: 0.5, y: 0.5 }] })],
      targets: [
        { id: "t1", kind: "instagram.image", accountExternalId: "1", accessToken: "x".repeat(20) },
      ],
      details: { firstComment: "ilk", locationId: "123", collaborators: ["ortak"] },
    };
    expect(CloudOrderCreate.safeParse(order).success).toBe(true);
    const twoCovers = {
      ...order,
      media: [
        ...order.media,
        media("c1.jpg", { role: "cover" }),
        media("c2.jpg", { role: "cover" }),
      ],
    };
    expect(CloudOrderCreate.safeParse(twoCovers).success).toBe(false);
  });
});

describe("insights (N15)", () => {
  it("engagement rate and relative scores", () => {
    expect(engagementRate({ reach: 200, interactions: 10 })).toBe(0.05);
    expect(engagementRate({ reach: 100, likes: 5, comments: 1, saves: 2, shares: 2 })).toBe(0.1);
    expect(engagementRate({ likes: 5 })).toBeNull();
    const scores = relativeScores([
      { metrics: { reach: 100, interactions: 10 } },
      { metrics: { reach: 100, interactions: 5 } },
      { metrics: { reach: 100, interactions: 20 } },
      { metrics: { likes: 4 } },
    ]);
    expect(scores.slice(0, 3)).toEqual([1, 0.5, 2]);
    expect(scores[3]).toBe(1);
  });

  it("weekday and hour in Türkiye time", () => {
    // 2026-11-16 is a Monday; 21:30 UTC is Tuesday 00:30 in Türkiye.
    expect(localSlot("2026-11-16T21:30:00Z")).toEqual({ weekday: 1, hour: 0 });
    expect(localSlot("2026-11-22T09:00:00Z")).toEqual({ weekday: 6, hour: 12 });
    expect(slotLabel({ weekday: 1, hour: 9 })).toBe("Salı 09:00");
  });

  it("falls back to general slots with too few posts", () => {
    const few = computeBestTimes([{ publishedAt: "2026-11-16T16:00:00Z", score: 2 }]);
    expect(few.basis).toBe("general");
    expect(few.sampleSize).toBe(1);
    expect(few.suggestions.length).toBeGreaterThan(0);
    expect(few.suggestions.every((s) => s.score === null)).toBe(true);
    expect(few.note).toMatch(/Yalnızca 1 postun/);
  });

  it("suggests the brand's strongest slots, two hours apart, with smoothing", () => {
    const posts: { publishedAt: string; score: number }[] = [];
    // Tuesdays 19:00 (16:00 UTC) do great, Mondays 09:00 (06:00 UTC) are weak.
    for (let w = 0; w < 5; w++) {
      const tue = Date.UTC(2026, 9, 6 + w * 7, 16);
      const mon = Date.UTC(2026, 9, 5 + w * 7, 6);
      posts.push({ publishedAt: new Date(tue).toISOString(), score: 2 });
      posts.push({ publishedAt: new Date(tue + H).toISOString(), score: 1.8 });
      posts.push({ publishedAt: new Date(mon).toISOString(), score: 0.4 });
    }
    expect(posts.length).toBeGreaterThanOrEqual(BEST_TIME_MIN_POSTS);
    const best = computeBestTimes(posts, { days: 90 });
    expect(best.basis).toBe("own");
    expect(best.sampleSize).toBe(15);
    expect(best.grid[1]?.[19]).not.toBeNull();
    expect(best.counts[1]?.[19]).toBeGreaterThan(5);
    const first = best.suggestions[0];
    expect(first?.weekday).toBe(1);
    expect([19, 20]).toContain(first?.hour);
    // No two suggestions within two hours on the same day.
    for (const a of best.suggestions)
      for (const b of best.suggestions)
        if (a !== b && a.weekday === b.weekday)
          expect(Math.abs(a.hour - b.hour)).toBeGreaterThan(1);
    // The weak Monday morning is ranked below every Tuesday evening slot.
    const monday = best.suggestions.find((s) => s.weekday === 0 && s.hour === 9);
    if (monday) expect(monday.score ?? 0).toBeLessThan(first?.score ?? 0);
    expect(best.note).toBe("Son 90 günün 15 postuna göre (Türkiye saati).");
  });

  it("next occurrence of a slot", () => {
    // Monday 2026-11-16 10:00 Türkiye (07:00 UTC) → Tuesday 19:00 Türkiye = 16:00 UTC.
    const from = new Date("2026-11-16T07:00:00Z");
    expect(nextSlotTime({ weekday: 1, hour: 19 }, from)).toBe("2026-11-17T16:00:00.000Z");
    // Same day, later hour.
    expect(nextSlotTime({ weekday: 0, hour: 12 }, from)).toBe("2026-11-16T09:00:00.000Z");
    // Same day, already past: next week.
    expect(nextSlotTime({ weekday: 0, hour: 9 }, from)).toBe("2026-11-23T06:00:00.000Z");
  });

  it("insights read schedule: 1 h, 24 h, 72 h, then daily for 90 days", () => {
    const p = 1_000_000_000_000;
    expect(nextInsightsSyncAt(p, null)).toBe(p + H);
    expect(nextInsightsSyncAt(p, p + H)).toBe(p + 24 * H);
    expect(nextInsightsSyncAt(p, p + 30 * H)).toBe(p + 72 * H);
    expect(nextInsightsSyncAt(p, p + 72 * H)).toBe(p + 96 * H);
    // The Mac was off: a late read counts for every checkpoint before it.
    expect(nextInsightsSyncAt(p, p + 10 * D)).toBe(p + 11 * D);
    expect(nextInsightsSyncAt(p, p + 89.5 * D)).toBeNull();
  });
});

describe("jobs and comments (N15, N16)", () => {
  it("registers the new job types with payload schemas", () => {
    for (const t of ["insights.sync", "comments.sync", "comments.suggest"] as const) {
      expect(JobType.options).toContain(t);
      expect(JOB_PAYLOAD_SCHEMAS[t]).toBeDefined();
    }
    expect(JOB_TYPE_REQUIREMENTS["comments.suggest"].brand).toBe(true);
    expect(JOB_PAYLOAD_SCHEMAS["comments.suggest"]?.safeParse({}).success).toBe(false);
    expect(JOB_PAYLOAD_SCHEMAS["insights.sync"]?.safeParse({ force: true }).success).toBe(true);
  });

  it("notice text for new comments", () => {
    expect(newCommentsNotice(1, { author: "ayse", text: "Fiyat?" })).toEqual({
      title: "Yeni yorum",
      body: "ayse: Fiyat?",
    });
    expect(newCommentsNotice(4).title).toBe("4 yeni yorum");
  });
});
