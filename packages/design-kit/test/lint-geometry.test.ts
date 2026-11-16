import { describe, expect, it } from "vitest";
import {
  clearSpaceIssues,
  contrastRatio,
  type InPageBox,
  type InPageText,
  type LayerMetrics,
  type LintReport,
  largestEmptyRect,
  lintCarousel,
  measureContrast,
  parseComputedColor,
  type Raster,
  voidIssues,
} from "../src/lint/index.ts";
import {
  getPreset,
  maxDeviceScale,
  PLATFORM_PRESETS,
  PRESET_IDS,
  presetsForSize,
  validateExport,
} from "../src/presets/index.ts";

const SIZE = { width: 1080, height: 1350 };
const SAFE = { top: 64, right: 64, bottom: 64, left: 64 };
const box = (
  layer: string,
  kind: InPageBox["kind"],
  x: number,
  y: number,
  w: number,
  h: number,
): InPageBox => ({ layer, kind, rect: { x, y, w, h } });

describe("large-void", () => {
  it("finds the largest empty rectangle", () => {
    const r = largestEmptyRect([{ x: 0, y: 0, w: 50, h: 100 }], { x: 0, y: 0, w: 100, h: 100 }, 10);
    expect(r).toEqual({ x: 50, y: 0, w: 50, h: 100 });
    expect(
      largestEmptyRect([{ x: 0, y: 0, w: 100, h: 100 }], { x: 0, y: 0, w: 100, h: 100 }, 10),
    ).toBeNull();
  });

  it("warns on a big empty area and ignores background fields", () => {
    const top = [
      box("headline", "text", 72, 100, 900, 200),
      box("bg", "background", 0, 0, 1080, 1350),
    ];
    const issues = voidIssues(top, SIZE, SAFE);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ rule: "large-void", severity: "warning" });
    expect((issues[0]?.data?.share as number) > 0.5).toBe(true);
  });

  it("is quiet when content is spread over the post", () => {
    const filled = [
      box("headline", "text", 72, 100, 900, 200),
      box("photo", "image", 200, 350, 800, 600),
      box("body", "text", 72, 980, 600, 120),
      box("logo", "logo", 72, 1240, 200, 40),
    ];
    expect(voidIssues(filled, SIZE, SAFE)).toEqual([]);
  });
});

describe("logo-clear-space", () => {
  const logo = { id: "logo", src: "/brand/logos/a.png", rect: { x: 72, y: 1240, w: 250, h: 40 } };
  it("flags text and shapes that come too close", () => {
    const issues = clearSpaceIssues(
      [logo],
      [box("web", "text", 330, 1245, 300, 30), box("band", "shape", 0, 1290, 1080, 20)],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.data?.intruders).toEqual({ web: 8, band: 10 });
  });

  it("ignores backgrounds the logo sits on, photos, and far elements; honours per-logo ratios", () => {
    const boxes = [
      box("band-bg", "shape", 0, 1200, 1080, 150),
      box("photo", "image", 0, 0, 1080, 1300),
      box("web", "text", 700, 1245, 300, 30),
    ];
    expect(clearSpaceIssues([logo], boxes)).toEqual([]);
    expect(
      clearSpaceIssues([logo], [box("web", "text", 360, 1245, 300, 30)], {
        byPath: { "logos/a.png": 1 },
      }),
    ).toHaveLength(1);
    expect(clearSpaceIssues([logo], [box("web", "text", 360, 1245, 300, 30)])).toEqual([]);
  });
});

describe("pixel contrast", () => {
  const raster = (
    w: number,
    h: number,
    fill: (x: number, y: number) => [number, number, number],
  ): Raster => {
    const data = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const [r, g, b] = fill(x, y);
        data.set([r, g, b], (y * w + x) * 3);
      }
    return { width: w, height: h, channels: 3, data };
  };
  const text = (color: string, fontSize = 30, weight = "500"): InPageText => ({
    id: "t",
    role: null,
    lines: 1,
    lineRects: [{ x: 10, y: 10, w: 80, h: 20 }],
    fontSize,
    minFontSize: fontSize,
    weight,
    family: "X",
    color,
    clipText: false,
    textRect: { x: 10, y: 10, w: 80, h: 20 },
    chars: 4,
    runs: [{ color, fontSize, weight, rects: [{ x: 10, y: 10, w: 80, h: 20 }] }],
  });

  it("computes WCAG ratios", () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5);
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBe(1);
    expect(parseComputedColor("rgba(10, 20, 30, 0.5)")).toEqual({ rgb: [10, 20, 30], a: 0.5 });
    expect(parseComputedColor("color(srgb 1 0 0 / 0.25)")).toEqual({ rgb: [255, 0, 0], a: 0.25 });
    expect(parseComputedColor("oklch(0.5 0.1 20)")).toBeNull();
  });

  it("passes dark text on white, fails grey on white, applies the large-text threshold", () => {
    const white = raster(100, 40, () => [255, 255, 255]);
    expect(measureContrast([text("rgb(17, 17, 17)")], white).issues).toEqual([]);
    expect(measureContrast([text("rgb(204, 204, 204)")], white).issues.map((i) => i.rule)).toEqual([
      "contrast",
    ]);
    // #888 on white is 3.5:1: fails at 30px, passes at 48px
    expect(measureContrast([text("rgb(136, 136, 136)")], white).issues.map((i) => i.rule)).toEqual([
      "contrast",
    ]);
    expect(measureContrast([text("rgb(136, 136, 136)", 48)], white).issues).toEqual([]);
    expect(measureContrast([text("rgb(136, 136, 136)", 36, "700")], white).issues).toEqual([]);
  });

  it("warns on a busy background and reports clip text as unknown", () => {
    const stripes = raster(100, 40, (x) => (x % 20 < 10 ? [0, 0, 0] : [255, 255, 255]));
    const r = measureContrast(
      [text("rgb(255, 255, 255)", 60)],
      raster(100, 40, (x) => (x < 70 ? [0, 0, 0] : [250, 250, 250])),
    );
    expect(r.issues.map((i) => i.rule)).toEqual(["contrast-busy-background"]);
    expect(
      measureContrast([{ ...text("rgb(0,0,0)"), clipText: true }], stripes).issues.map(
        (i) => i.rule,
      ),
    ).toEqual(["contrast-unknown"]);
  });

  it("measures each colour run separately (an accent word counts)", () => {
    const white = raster(200, 40, () => [255, 255, 255]);
    const t = text("rgb(17, 17, 17)");
    t.runs = [
      {
        color: "rgb(17, 17, 17)",
        fontSize: 30,
        weight: "500",
        rects: [{ x: 10, y: 10, w: 80, h: 20 }],
      },
      {
        color: "rgb(230, 230, 230)",
        fontSize: 30,
        weight: "500",
        rects: [{ x: 100, y: 10, w: 80, h: 20 }],
      },
    ];
    expect(measureContrast([t], white).issues.map((i) => i.rule)).toEqual(["contrast"]);
  });
});

describe("carousel", () => {
  const layer = (
    id: string,
    type: string,
    role: string | null,
    x: number,
    y: number,
    extra: Partial<LayerMetrics> = {},
  ): LayerMetrics => ({
    id,
    type,
    role,
    parent: null,
    rect: { x, y, w: 200, h: 40 },
    visible: true,
    ...extra,
  });
  const report = (layers: LayerMetrics[], size = { width: 1080, height: 1350 }): LintReport => ({
    schema: "studio.lint/1",
    kit: "0.1.0",
    contract: "v1",
    artboard: size,
    ok: true,
    summary: { errors: 0, warnings: 0, info: 0 },
    stages: { static: true, layout: true, pixel: false, render: false },
    issues: [],
    layers,
  });
  const slideN = (n: number, total: number, logoY = 1240) =>
    report([
      layer("counter", "text", "counter", 72, 72, {
        content: `${n} / ${total}`,
        text: {
          lines: 1,
          fontSize: 26,
          minFontSize: 26,
          weight: "700",
          family: "Montserrat",
          color: "",
          textRect: { x: 0, y: 0, w: 0, h: 0 },
          chars: 5,
        },
      }),
      layer("logo", "logo", null, 72, logoY),
      layer("headline", "text", "headline", 72, 300 + n * 50),
    ]);

  it("is clean for a consistent carousel", () => {
    const r = lintCarousel([slideN(1, 3), slideN(2, 3), slideN(3, 3)]);
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("flags drifting anchors, wrong counters, mixed sizes and font drift", () => {
    const s3 = slideN(3, 3, 1200);
    const wrong = slideN(2, 4);
    const square = report(slideN(1, 3).layers, { width: 1080, height: 1080 });
    const other = slideN(1, 3);
    const counter = other.layers[0] as LayerMetrics;
    counter.text = { ...(counter.text as NonNullable<LayerMetrics["text"]>), family: "Archivo" };
    const r = lintCarousel([slideN(1, 3), wrong, s3]);
    expect(r.issues.map((i) => `${i.rule}@${i.layer}`)).toEqual([
      "carousel-counter@2:counter",
      "carousel-anchor-drift@3:logo",
    ]);
    expect(lintCarousel([slideN(1, 2), square]).issues.map((i) => i.rule)).toContain(
      "carousel-artboard-mismatch",
    );
    expect(lintCarousel([other, slideN(2, 2)]).issues.map((i) => i.rule)).toContain(
      "carousel-font-drift",
    );
  });
});

describe("platform presets", () => {
  it("cover Instagram, Facebook and LinkedIn placements with sane safe areas", () => {
    expect(PRESET_IDS).toEqual(
      expect.arrayContaining([
        "instagram-feed-portrait",
        "instagram-feed-square",
        "instagram-story",
        "facebook-feed-portrait",
        "facebook-story",
        "linkedin-feed-portrait",
        "linkedin-document-portrait",
      ]),
    );
    for (const p of Object.values(PLATFORM_PRESETS)) {
      const [w, h] = p.ratio.split(":").map(Number) as [number, number];
      expect(p.width / p.height).toBeCloseTo(w / h, 3);
      expect(p.safeArea.left + p.safeArea.right).toBeLessThan(p.width / 2);
    }
    expect(getPreset("instagram-story")?.safeArea.top).toBeGreaterThan(200);
    expect(presetsForSize(1080, 1920).map((p) => p.id)).toContain("facebook-story");
    expect(maxDeviceScale(PLATFORM_PRESETS["instagram-feed-portrait"])).toBe(1.33);
  });

  it("validates exports", () => {
    expect(
      validateExport("instagram-feed-portrait", {
        format: "jpeg",
        width: 1080,
        height: 1350,
        bytes: 150_000,
      }),
    ).toEqual({ ok: true, issues: [] });
    const png = validateExport("instagram-feed-portrait", {
      format: "png",
      width: 2160,
      height: 2700,
      bytes: 9 * 1024 * 1024,
    });
    expect(png.ok).toBe(false);
    expect(png.issues.map((i) => i.code)).toEqual(["format-not-allowed", "too-large", "too-wide"]);
    expect(
      validateExport("instagram-feed-square", {
        format: "jpeg",
        width: 1080,
        height: 1920,
        bytes: 1,
      }).issues.map((i) => i.code),
    ).toEqual(["aspect-out-of-range", "aspect-mismatch"]);
    expect(
      validateExport("facebook-feed-portrait", {
        format: "png",
        width: 1080,
        height: 1350,
        bytes: 2 * 1024 * 1024,
      }).issues.map((i) => i.code),
    ).toEqual(["large-file"]);
    expect(
      validateExport("linkedin-document-portrait", {
        format: "pdf",
        width: 2160,
        height: 2700,
        bytes: 5_000_000,
        pages: 301,
      }).issues.map((i) => i.code),
    ).toEqual(["too-many-pages"]);
    expect(validateExport("nope", { format: "jpeg", width: 1, height: 1, bytes: 1 }).ok).toBe(
      false,
    );
  });
});
