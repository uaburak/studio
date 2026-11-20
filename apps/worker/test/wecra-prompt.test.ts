import type { CanvasOutlineSlide } from "@studio/design-kit/canvas";
import { describe, expect, it } from "vitest";
import { wecraCritiquePrompt } from "../src/generate/wecra/prompt.ts";

describe("Wecra critique", () => {
  it("names the texts under the minimum size", () => {
    const outline = [
      {
        slide: 1,
        frameId: "1:1",
        name: "Slayt 1",
        layers: [
          {
            id: "2:1",
            name: "Etiket",
            type: "text",
            wecraType: "TEXT",
            parent: null,
            box: [64, 64, 200, 20],
            text: { characters: "İÇERİK", font: "Inter Bold", size: 15 },
          },
          {
            id: "2:2",
            name: "Başlık",
            type: "text",
            wecraType: "TEXT",
            parent: null,
            box: [64, 120, 900, 200],
            text: { characters: "Bor", font: "Inter Bold", size: 72 },
          },
        ],
      },
    ] as unknown as CanvasOutlineSlide[];
    const prompt = wecraCritiquePrompt({
      brief: { title: "t", brief: "b" } as never,
      outline,
      pass: 1,
      passes: 2,
      problems: [],
    });
    expect(prompt).toContain("Texts under 24 px");
    expect(prompt).toContain("2:1");
    expect(prompt).not.toContain("- slide 1, 2:2");
  });
});
