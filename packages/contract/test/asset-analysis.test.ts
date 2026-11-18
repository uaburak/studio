import { describe, expect, it } from "vitest";
import {
  type AssetAnalysis,
  assetMatchesQuery,
  assetSearchText,
  decodeFeaturePrint,
  featureDistance,
  featureSimilarity,
  foldSearchText,
  ImageGeneratePayload,
  JOB_PAYLOAD_SCHEMAS,
  JOB_TYPE_REQUIREMENTS,
  JobType,
  searchQueryTokens,
} from "../src/index.ts";

const analysis: AssetAnalysis = {
  status: "complete",
  tags: [{ id: "sunflower", label: "ayçiçeği", confidence: 0.9 }],
  text: "GÜNEŞ TARIM",
  colors: [{ hex: "#f2c200", share: 0.6, name: "sarı" }],
  orientation: "landscape",
  aspectRatio: 1.5,
  isCutout: true,
  isLogoLike: false,
  caption: null,
  hasFeaturePrint: true,
  note: null,
  analyzedAt: "2026-11-19T10:00:00.000Z",
};

const asset = {
  kind: "image",
  mimeType: "image/png",
  source: "upload",
  originalFilename: "IMG_42.png",
  analysis,
};

describe("media search (N12)", () => {
  it("folds Turkish letters both ways", () => {
    expect(foldSearchText("İĞNE ışık ÇİÇEK Şule Öykü")).toBe("igne isik cicek sule oyku");
    expect(searchQueryTokens("  “Ayçiçeği”,  tarla! ")).toEqual(["aycicegi", "tarla"]);
  });

  it("matches every word over name, tags, identifiers, text, colours and flags", () => {
    expect(assetMatchesQuery(asset, "ayçiçeği")).toBe(true);
    expect(assetMatchesQuery(asset, "AYCICEGI sarı")).toBe(true);
    expect(assetMatchesQuery(asset, "sunflower")).toBe(true);
    expect(assetMatchesQuery(asset, "güneş tarım")).toBe(true);
    expect(assetMatchesQuery(asset, "yatay dekupe")).toBe(true);
    expect(assetMatchesQuery(asset, "img_42")).toBe(true);
    expect(assetMatchesQuery(asset, "logo")).toBe(false);
    expect(assetMatchesQuery(asset, "ayçiçeği mavi")).toBe(false);
    expect(assetMatchesQuery(asset, "   ")).toBe(true);
    // Without an analysis only the name and kind are searched.
    expect(assetSearchText({ ...asset, analysis: null })).not.toContain("aycicegi");
  });

  it("measures feature prints like Vision (Euclidean)", () => {
    const values = new Float32Array([0.6, 0.8, 0, -0.25]);
    let binary = "";
    for (const b of new Uint8Array(values.buffer)) binary += String.fromCharCode(b);
    const decoded = decodeFeaturePrint(btoa(binary));
    expect([...decoded]).toEqual([...values]);
    expect(featureDistance([1, 0], [0, 1])).toBeCloseTo(Math.SQRT2);
    expect(featureDistance([1, 0], [1, 0, 0])).toBe(Number.POSITIVE_INFINITY);
    expect(featureSimilarity(0)).toBe(1);
    expect(featureSimilarity(2)).toBe(0);
    expect(featureSimilarity(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("knows the media.analyze job and the label-preserving image fields", () => {
    expect(JobType.options).toContain("media.analyze");
    expect(JOB_TYPE_REQUIREMENTS["media.analyze"]).toEqual({ brand: false, content: false });
    expect(JOB_PAYLOAD_SCHEMAS["media.analyze"]?.parse({})).toEqual({
      reason: "upload",
      includePartial: false,
    });
    const payload = ImageGeneratePayload.parse({
      prompt: "tarla",
      preserveProductLabel: true,
      productPosition: "bottom-left",
      productScale: 0.5,
      labelText: "VENTA BORİNÇ",
    });
    expect(payload).toMatchObject({ productPosition: "bottom-left", productScale: 0.5 });
    expect(() => ImageGeneratePayload.parse({ prompt: "x", productScale: 1.2 })).toThrow();
  });
});
