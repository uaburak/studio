import { describe, expect, it } from "vitest";
import {
  ContentGeneratePayload,
  ContentRenderPayload,
  clampReelDurationMs,
  decodeReelSpec,
  encodeReelSpec,
  maxReelDurationMs,
  ReelSpec,
  readReelVersionInfo,
  reelDurationIssues,
} from "../src/index.ts";

describe("reels", () => {
  it("round-trips a spec with Turkish text through the version slide attribute", () => {
    const spec = ReelSpec.parse({
      recipe: "narration",
      hook: "Çiçeklenmede bor neden önemli? “ğüşiöç” <b>",
      narrationScript: "Bor eksikliği verimi düşürür.",
      words: [{ word: "Bor", startMs: 0, endMs: 300 }],
      durationMs: 9000,
    });
    const b64 = encodeReelSpec(spec);
    expect(b64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(decodeReelSpec(b64)).toEqual(spec);
    expect(decodeReelSpec("bm90IGpzb24=")).toBeNull();
    const html = `<main data-artboard data-video-asset-id="v1" data-cover-asset-id="c1" data-reel-recipe="narration" data-duration-ms="9000" data-reel-spec-b64="${b64}">`;
    expect(readReelVersionInfo(html)).toMatchObject({
      videoAssetId: "v1",
      coverAssetId: "c1",
      durationMs: 9000,
      recipe: "narration",
    });
  });

  it("knows the platform limits: Instagram 3 s–15 min, Facebook Reels ≤ 90 s", () => {
    expect(reelDurationIssues(2000, ["instagram"])[0]?.code).toBe("reel_too_short");
    expect(reelDurationIssues(120_000, ["instagram", "facebook"])).toEqual([
      expect.objectContaining({ platform: "facebook", code: "reel_too_long" }),
    ]);
    expect(reelDurationIssues(120_000, ["facebook"])[0]?.message).toContain("90 sn");
    expect(maxReelDurationMs(["instagram"])).toBe(90_000);
    expect(clampReelDurationMs(1000, ["facebook"])).toBe(3000);
    expect(clampReelDurationMs(200_000, ["facebook"])).toBe(90_000);
  });

  it("payloads accept reel options and editor patches; bad timings are refused", () => {
    const gen = ContentGeneratePayload.parse({
      brief: "x",
      type: "reel",
      reel: { recipe: "footage_edit", clipAssetId: "a1", durationSec: 20 },
    });
    expect(gen.reel?.recipe).toBe("footage_edit");
    const render = ContentRenderPayload.parse({
      format: "mp4",
      reel: { hook: "Yeni", overlays: [{ text: "t", startMs: 0, endMs: 1000 }] },
    });
    expect(render.reel?.overlays).toHaveLength(1);
    expect(
      ContentRenderPayload.safeParse({
        reel: { overlays: [{ text: "t", startMs: 900, endMs: 100 }] },
      }).success,
    ).toBe(false);
    expect(ContentRenderPayload.safeParse({ reel: { durationMs: 1000 } }).success).toBe(false);
  });
});
