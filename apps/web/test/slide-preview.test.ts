import { describe, expect, it } from "vitest";
import {
  buildSlideSrcdoc,
  describeArtboard,
  fitScale,
  SLIDE_CSP,
  SLIDE_SANDBOX,
  stepIndex,
} from "../src/lib/slide-preview.ts";

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SLIDE_CSP}">`;

describe("SLIDE_SANDBOX / SLIDE_CSP", () => {
  it("grants no sandbox capabilities", () => {
    expect(SLIDE_SANDBOX).toBe("");
  });

  it("blocks every network fetch: only inline styles and data: URIs", () => {
    expect(SLIDE_CSP).toContain("default-src 'none'");
    expect(SLIDE_CSP).not.toMatch(/https?:|'self'|\*/);
    expect(SLIDE_CSP).not.toContain("script-src");
    expect(SLIDE_CSP).toContain("base-uri 'none'");
    expect(SLIDE_CSP).toContain("form-action 'none'");
  });
});

describe("buildSlideSrcdoc", () => {
  it("puts the CSP first inside an existing <head>", () => {
    const out = buildSlideSrcdoc(
      '<!doctype html><html lang="tr"><head><link rel="stylesheet" href="https://x.test/a.css"></head><body>Hi</body></html>',
    );
    const head = out.indexOf("<head>");
    expect(out.indexOf(CSP_META)).toBe(head + "<head>".length);
    expect(out.indexOf(CSP_META)).toBeLessThan(out.indexOf("<link"));
  });

  it("handles <head> with attributes and any case", () => {
    const out = buildSlideSrcdoc(
      '<HTML><HEAD data-x="1"><title>t</title></HEAD><BODY></BODY></HTML>',
    );
    expect(out).toContain(`<HEAD data-x="1">${CSP_META}`);
  });

  it("creates a <head> when the document has none", () => {
    expect(buildSlideSrcdoc("<html><body>x</body></html>")).toMatch(
      /^<html><head><meta http-equiv="Content-Security-Policy"[^>]+><style>[^<]+<\/style><\/head><body>x<\/body><\/html>$/,
    );
    expect(
      buildSlideSrcdoc("<!DOCTYPE html><body>x</body>").startsWith("<!DOCTYPE html><head>"),
    ).toBe(true);
  });

  it("wraps bare fragments", () => {
    const out = buildSlideSrcdoc('<div style="width:1080px">x</div>');
    expect(out.startsWith(`<!doctype html><head>${CSP_META}`)).toBe(true);
    expect(out.endsWith('<div style="width:1080px">x</div>')).toBe(true);
  });

  it("strips meta refresh and <base>, which could navigate or redirect loads", () => {
    const out = buildSlideSrcdoc(
      '<html><head><meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/"></head><body></body></html>',
    );
    expect(out).not.toMatch(/refresh/i);
    expect(out).not.toMatch(/<base/i);
  });

  it("keeps the slide markup intact otherwise", () => {
    const html = '<html><head></head><body><h1 data-layer="title">Merhaba</h1></body></html>';
    expect(buildSlideSrcdoc(html).replace(/<meta[^>]+><style>[^<]+<\/style>/, "")).toBe(html);
  });
});

describe("fitScale", () => {
  const portrait = { width: 1080, height: 1350 };

  it("fits by width", () => {
    expect(fitScale(portrait, { width: 540 })).toBe(0.5);
  });

  it("fits by height when that is tighter", () => {
    expect(fitScale(portrait, { width: 1000, height: 675 })).toBe(0.5);
  });

  it("never upscales past maxScale", () => {
    expect(fitScale(portrait, { width: 4000, height: 4000 })).toBe(1);
    expect(fitScale(portrait, { width: 4000 }, 2)).toBe(2);
  });

  it("returns 0 for unmeasured or degenerate boxes", () => {
    expect(fitScale(portrait, { width: 0 })).toBe(0);
    expect(fitScale({ width: 0, height: 100 }, { width: 100 })).toBe(0);
  });
});

describe("carousel helpers", () => {
  it("clamps the index", () => {
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(2, 1, 5)).toBe(3);
    expect(stepIndex(3, 0, 0)).toBe(0);
  });

  it("describes artboards", () => {
    expect(describeArtboard({ width: 1080, height: 1350 })).toBe("1080 × 1350 · 4:5");
    expect(describeArtboard({ width: 1080, height: 1920 })).toBe("1080 × 1920 · 9:16");
    expect(describeArtboard({ width: 1200, height: 627 })).toBe("1200 × 627");
  });
});
