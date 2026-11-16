import { describe, expect, it } from "vitest";
import {
  countHashtags,
  countMentions,
  type PublishRequest,
  validateRequest,
} from "../src/index.ts";
import { IG, PAGE, requests } from "./helpers.ts";

const codes = (r: unknown) => validateRequest(r).errors.map((e) => e.code);
const warnings = (r: unknown) => validateRequest(r).warnings.map((e) => e.code);

describe("text counting", () => {
  it("counts hashtags and mentions, not emails or anchors", () => {
    expect(countHashtags("#a #b_c #ğüş x#no #1 ##")).toBe(4);
    expect(countMentions("@one @two.x mail@example.com @three_")).toBe(3);
  });
});

describe("valid fixtures", () => {
  it.each(Object.keys(requests) as (keyof typeof requests)[])("%s has no errors", (name) => {
    const report = validateRequest(requests[name]());
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe("instagram rules", () => {
  const img = (over: Record<string, unknown> = {}) => ({
    kind: "image",
    url: "https://m.example.com/a.jpg",
    mimeType: "image/jpeg",
    width: 1080,
    height: 1080,
    bytes: 1000,
    ...over,
  });

  it("JPEG only", () => {
    const r = { kind: "instagram.image", igUserId: IG, image: img({ mimeType: "image/png" }) };
    const report = validateRequest(r);
    expect(report.errors[0]).toMatchObject({
      code: "IMAGE_FORMAT_UNSUPPORTED",
      path: "image.mimeType",
      message: "Instagram yalnızca JPEG görsel kabul ediyor.",
    });
    // Format is inferred from the URL when mimeType is absent.
    expect(
      codes({
        kind: "instagram.image",
        igUserId: IG,
        image: img({ mimeType: undefined, url: "https://m.example.com/a.webp" }),
      }),
    ).toEqual(["IMAGE_FORMAT_UNSUPPORTED"]);
  });

  it("size, aspect ratio and rescale warning", () => {
    expect(
      codes({ kind: "instagram.image", igUserId: IG, image: img({ bytes: 9 * 1024 * 1024 }) }),
    ).toEqual(["IMAGE_TOO_LARGE"]);
    expect(
      codes({ kind: "instagram.image", igUserId: IG, image: img({ width: 1080, height: 1920 }) }),
    ).toEqual(["ASPECT_RATIO_OUT_OF_RANGE"]);
    expect(
      codes({ kind: "instagram.image", igUserId: IG, image: img({ width: 1080, height: 1350 }) }),
    ).toEqual([]);
    expect(
      codes({ kind: "instagram.image", igUserId: IG, image: img({ width: 1910, height: 1000 }) }),
    ).toEqual([]);
    expect(
      warnings({
        kind: "instagram.image",
        igUserId: IG,
        image: img({ width: 2000, height: 2000 }),
      }),
    ).toEqual(["IMAGE_WILL_BE_RESCALED"]);
  });

  it("caption length, hashtags, mentions with Turkish messages", () => {
    const base = { kind: "instagram.image", igUserId: IG, image: img() };
    const long = validateRequest({ ...base, caption: "ş".repeat(2201) });
    expect(long.errors[0]).toMatchObject({
      code: "CAPTION_TOO_LONG",
      message: "Açıklama en fazla 2.200 karakter olabilir (şu an 2.201).",
    });
    expect(codes({ ...base, caption: "ş".repeat(2200) })).toEqual([]);
    expect(
      codes({ ...base, caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ") }),
    ).toEqual(["TOO_MANY_HASHTAGS"]);
    expect(
      codes({ ...base, caption: Array.from({ length: 21 }, (_, i) => `@u${i}`).join(" ") }),
    ).toEqual(["TOO_MANY_MENTIONS"]);
    // Emoji count as one character.
    expect(codes({ ...base, caption: "🌾".repeat(2200) })).toEqual([]);
  });

  it("alt text, collaborators, user tag positions", () => {
    expect(
      codes({ kind: "instagram.image", igUserId: IG, image: img({ altText: "a".repeat(1001) }) }),
    ).toEqual(["ALT_TEXT_TOO_LONG"]);
    expect(
      codes({
        kind: "instagram.image",
        igUserId: IG,
        image: img(),
        collaborators: ["a", "b", "c", "d"],
      }),
    ).toEqual(["TOO_MANY_COLLABORATORS"]);
    expect(
      codes({ kind: "instagram.image", igUserId: IG, image: img(), userTags: [{ username: "x" }] }),
    ).toEqual(["USER_TAG_POSITION_REQUIRED"]);
  });

  it("carousel item count and aspect mismatch", () => {
    expect(codes({ kind: "instagram.carousel", igUserId: IG, items: [img()] })).toEqual([
      "CAROUSEL_TOO_FEW_ITEMS",
    ]);
    expect(
      codes({
        kind: "instagram.carousel",
        igUserId: IG,
        items: Array.from({ length: 21 }, () => img()),
      }),
    ).toEqual(["CAROUSEL_TOO_MANY_ITEMS"]);
    expect(
      codes({
        kind: "instagram.carousel",
        igUserId: IG,
        items: Array.from({ length: 20 }, () => img()),
      }),
    ).toEqual([]);
    expect(
      warnings({
        kind: "instagram.carousel",
        igUserId: IG,
        items: [img(), img({ width: 1080, height: 1350 })],
      }),
    ).toEqual(["CAROUSEL_ASPECT_MISMATCH"]);
  });

  const video = (over: Record<string, unknown> = {}) => ({
    kind: "video",
    source: { type: "url", url: "https://m.example.com/v.mp4" },
    mimeType: "video/mp4",
    width: 1080,
    height: 1920,
    bytes: 1000,
    durationMs: 30_000,
    frameRate: 30,
    ...over,
  });

  it("reel duration, size, frame rate, width, format", () => {
    const reel = (v: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      codes({ kind: "instagram.reel", igUserId: IG, video: video(v), ...extra });
    expect(reel({ durationMs: 2_000 })).toEqual(["VIDEO_TOO_SHORT"]);
    expect(reel({ durationMs: 15 * 60_000 + 1 })).toEqual(["VIDEO_TOO_LONG"]);
    expect(reel({ durationMs: 15 * 60_000 })).toEqual([]);
    expect(reel({ bytes: 301 * 1024 * 1024 })).toEqual(["VIDEO_TOO_LARGE"]);
    expect(reel({ frameRate: 20 })).toEqual(["FRAME_RATE_OUT_OF_RANGE"]);
    expect(reel({ width: 2160, height: 3840 })).toEqual(["VIDEO_TOO_WIDE"]);
    expect(reel({ mimeType: "video/webm" })).toEqual(["VIDEO_FORMAT_UNSUPPORTED"]);
    expect(reel({}, { thumbOffsetMs: 40_000 })).toEqual(["THUMB_OFFSET_OUT_OF_RANGE"]);
    expect(reel({}, { coverUrl: "https://m.example.com/c.png" })).toEqual([
      "COVER_FORMAT_UNSUPPORTED",
    ]);
    expect(
      warnings({
        kind: "instagram.reel",
        igUserId: IG,
        video: video(),
        coverUrl: "https://m.example.com/c.jpg",
        thumbOffsetMs: 1,
      }),
    ).toContain("COVER_OVERRIDES_THUMB_OFFSET");
  });

  it("story constraints", () => {
    expect(
      codes({ kind: "instagram.story", igUserId: IG, media: video({ durationMs: 61_000 }) }),
    ).toEqual(["VIDEO_TOO_LONG"]);
    expect(
      codes({ kind: "instagram.story", igUserId: IG, media: video({ bytes: 101 * 1024 * 1024 }) }),
    ).toEqual(["VIDEO_TOO_LARGE"]);
    expect(codes({ kind: "instagram.story", igUserId: IG, media: img({ altText: "x" }) })).toEqual([
      "ALT_TEXT_NOT_SUPPORTED",
    ]);
    expect(warnings({ kind: "instagram.story", igUserId: IG, media: img() })).toEqual([
      "ASPECT_RATIO_NOT_RECOMMENDED",
    ]);
  });

  it("missing metadata is a warning, not an error", () => {
    const report = validateRequest({
      kind: "instagram.image",
      igUserId: IG,
      image: { kind: "image", url: "https://m.example.com/a" },
    });
    expect(report.ok).toBe(true);
    expect(report.warnings[0]?.code).toBe("METADATA_MISSING");
  });
});

describe("facebook rules", () => {
  it("photo formats and size, PNG soft limit", () => {
    const photo = (o: Record<string, unknown>) => ({
      kind: "facebook.photo",
      pageId: PAGE,
      image: {
        kind: "image",
        url: "https://m.example.com/a.png",
        mimeType: "image/png",
        bytes: 500_000,
        ...o,
      },
    });
    expect(codes(photo({}))).toEqual([]);
    expect(codes(photo({ mimeType: "image/webp" }))).toEqual(["IMAGE_FORMAT_UNSUPPORTED"]);
    expect(codes(photo({ bytes: 11 * 1024 * 1024 }))).toEqual(["IMAGE_TOO_LARGE"]);
    expect(warnings(photo({ bytes: 2 * 1024 * 1024 }))).toEqual(["IMAGE_PNG_LARGE"]);
  });

  it("multi-photo needs at least two", () => {
    const one = requests.fbMultiPhoto() as Extract<
      PublishRequest,
      { kind: "facebook.multi_photo" }
    >;
    one.images = one.images.slice(0, 1);
    expect(codes(one)).toEqual(["MULTI_PHOTO_TOO_FEW"]);
  });

  it("reel 3–90 s, minimum resolution, fps; story video max 60 s", () => {
    const reel = requests.fbReelUrl() as Extract<PublishRequest, { kind: "facebook.reel" }>;
    reel.video.durationMs = 91_000;
    expect(codes(reel)).toEqual(["VIDEO_TOO_LONG"]);
    reel.video.durationMs = 90_000;
    reel.video.width = 360;
    reel.video.height = 640;
    expect(codes(reel)).toEqual(["RESOLUTION_TOO_LOW"]);
    const story = requests.fbStoryVideo() as Extract<PublishRequest, { kind: "facebook.story" }>;
    if (story.media.kind === "video") story.media.durationMs = 61_000;
    expect(codes(story)).toEqual(["VIDEO_TOO_LONG"]);
  });
});

describe("schema", () => {
  it("reports schema problems instead of throwing", () => {
    const r = validateRequest({
      kind: "instagram.image",
      igUserId: "",
      image: { kind: "image", url: "ftp://x" },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.every((e) => e.code === "SCHEMA_INVALID")).toBe(true);
    expect(r.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["igUserId", "image.url"]));
  });

  it("upload sources require a byte size", () => {
    const r = validateRequest({
      kind: "facebook.reel",
      pageId: PAGE,
      video: { kind: "video", source: { type: "upload", key: "k" } },
    });
    expect(r.errors.map((e) => e.path)).toContain("video.bytes");
  });
});
