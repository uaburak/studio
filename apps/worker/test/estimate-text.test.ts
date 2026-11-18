import type { GenerationEstimate } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { estimateLine } from "../src/chat/estimate-text.ts";

const base: GenerationEstimate = {
  count: 30,
  perItemSeconds: 60,
  totalSeconds: 1800,
  basis: "history",
  sampleSize: 12,
  defaultsAsOf: "2026-11-18",
  perItemUsd: 0,
  textUsd: 0,
  imageSlots: 0,
  perImageUsd: 0.08,
  imagesIncluded: false,
  imageUsd: 0,
  totalUsd: 0,
  budgetRemainingUsd: null,
};

describe("consent card estimate (N4)", () => {
  it("states minutes, cost and that Claude is on the subscription", () => {
    expect(estimateLine(base)).toBe(
      "≈ 30 dakika, ≈ $0 (Claude aboneliği: ücretsiz; Gemini görselleri: yok).",
    );
  });

  it("names picture slots the run leaves empty, the budget and default figures", () => {
    expect(
      estimateLine({
        ...base,
        totalSeconds: 5400 + 600,
        basis: "default",
        imageSlots: 3,
        imageUsd: 0.24,
        totalUsd: 0.05,
        budgetRemainingUsd: 12.5,
      }),
    ).toBe(
      "≈ 1 saat 40 dakika, ≈ $0.050 (Claude aboneliği: ücretsiz; Gemini görselleri: 3 yuva, bu üretimde yapılmaz (ayrıca üretilirse ≈ $0.24); aylık bütçeden kalan $12.50). Geçmiş üretim yok; 2026-11-18 varsayımı kullanıldı.",
    );
  });
});
