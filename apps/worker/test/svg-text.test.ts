import { describe, expect, it } from "vitest";
import { svgTexts } from "../src/generate/svg/document.ts";

const slide = (body: string) =>
  `<!doctype html><html data-studio-engine="svg"><head></head><body><svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">${body}</svg></body></html>`;

describe("SVG copy", () => {
  it("a tspan on its own line is a word break; inline tspans join as written", () => {
    const html = slide(
      `<text id="lead" x="72" y="300"><tspan x="72" dy="0">çiçeklenme ve meyve bağlama</tspan><tspan x="72" dy="38">döneminde bitkinin</tspan></text>` +
        `<text id="price"><tspan>%</tspan><tspan fill="#c00">8</tspan> bor</text>`,
    );
    expect(svgTexts(html)).toEqual([
      { id: "lead", text: "çiçeklenme ve meyve bağlama döneminde bitkinin" },
      { id: "price", text: "%8 bor" },
    ]);
  });
});
