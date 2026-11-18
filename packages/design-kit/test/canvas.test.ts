/**
 * Canvas slides (saved from Wecra's editor): the slide HTML is contract-valid and carries the
 * facts; Chromium renders it to exactly the PNG (the described layers paint nothing); the
 * canvas checks find what is wrong from the facts and the render's pixels.
 */
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandFontFamilies } from "../src/brand/index.ts";
import {
  type CanvasFacts,
  canvasAltText,
  canvasFactsSize,
  canvasLayers,
  canvasLayout,
  canvasSlideHtml,
  fitCanvasFacts,
  layerSlug,
  lintCanvasSlide,
  readCanvas,
} from "../src/canvas/index.ts";
import { parseSlide } from "../src/document/index.ts";
import { type LintConfig, lintSlideStatic } from "../src/lint/index.ts";
import {
  combineResolvers,
  createDirectoryResolver,
  createMemoryResolver,
  createRenderer,
  isChromiumAvailable,
  type Renderer,
} from "../src/render/index.ts";
import { sanitizeFindings, sanitizeSlideHtml } from "../src/sanitize/index.ts";
import { BG, canvasFacts, H, renderFacts, textOf, W } from "./canvas-fixture.ts";
import { fixturePath, ventaCss, ventaFacts, ventaTokens } from "./helpers.ts";

const SHA = "c".repeat(64);
const html = (facts: CanvasFacts) =>
  canvasSlideHtml({ facts, src: "/media/render-1.png", sha256: SHA, sourceVersion: 3 });
const config: LintConfig = {
  width: W,
  height: H,
  brandFonts: brandFontFamilies(ventaTokens()),
  allowedNumbers: ventaFacts().allowedNumbers,
};
const rules = (facts: CanvasFacts, raster = renderFacts(facts)) =>
  lintCanvasSlide({ html: html(facts), facts, raster }, config).issues.map(
    (i) => `${i.rule}:${i.layer ?? ""}`,
  );

describe("a canvas slide's HTML", () => {
  it("is contract-valid: brand.css linked, no structural errors or warnings, sanitiser-clean", () => {
    const facts = canvasFacts();
    const out = html(facts);
    const report = lintSlideStatic(out, config);
    expect(report.issues.filter((i) => i.severity !== "info")).toEqual([]);
    expect(report.issues.map((i) => i.rule)).toEqual(["slot-empty"]);
    expect(out).toContain('<link rel="stylesheet" href="/brand/brand.css">');
    expect(sanitizeFindings(out)).toEqual([]);
    expect(sanitizeSlideHtml(out).html).toBe(out);
  });

  it("keeps the render as the bottom layer and describes texts, slots, logos and pictures", () => {
    const facts = canvasFacts();
    const out = html(facts);
    expect(out).toContain('<meta name="studio:editor" content="wecra">');
    expect(out).toContain('<meta name="studio:source-version" content="3">');
    expect(out).toContain(`<meta name="studio:render" content="sha256:${SHA}">`);
    const slide = parseSlide(out);
    expect(slide.model.layers.map((l) => [l.id, l.type, l.role])).toEqual([
      ["canvas", "image", "background"],
      ["headline", "text", "headline"],
      ["topraginiz-icin-bor-ve-cinko", "text", null],
      ["field-photo", "slot", null],
      ["logo", "logo", null],
      ["fotograf", "image", null],
    ]);
    const texts = slide.model.layers.filter((l) => l.type === "text").map((l) => l.text);
    expect(texts).toEqual(["Hasat bitti", "Toprağınız için bor\nve çinko."]);
    expect(out).toContain('data-color="#1D2A1B"');
    expect(out).toContain('data-font="Archivo"');
    expect(out).toContain('data-slot-ratio="4:5" data-slot-state="empty"');
    expect(out).toContain('src="/brand/logos/venta-wordmark-black.standin.png"');
    // A picture added on the canvas has no file of its own: it points at the render.
    expect(out).toMatch(/data-layer="fotograf"[^>]*src="\/media\/render-1\.png"/);
    expect(canvasLayout(facts).map((b) => [b.id, b.x, b.y, b.w, b.h])).toEqual([
      ["canvas", 0, 0, W, H],
      ["headline", 80, 200, 600, 96],
      ["topraginiz-icin-bor-ve-cinko", 80, 1000, 700, 88],
      ["field-photo", 560, 320, 400, 500],
      ["logo", 80, 1180, 240, 80],
      ["fotograf", 600, 900, 300, 200],
    ]);
  });

  it("carries the facts, and tells canvas, older canvas and HTML slides apart", () => {
    const facts = canvasFacts();
    expect(readCanvas(html(facts))).toEqual({ kind: "facts", facts, sourceVersion: 3 });
    const legacy =
      '<!doctype html><html lang="tr"><head><meta name="studio:editor" content="wecra"><meta name="studio:source-version" content="2"></head><body><main data-artboard><img data-layer="canvas" src="/media/r.png"></main></body></html>';
    expect(readCanvas(legacy)).toEqual({ kind: "legacy", sourceVersion: 2 });
    expect(readCanvas(legacy.replace("studio:source-version", "x"))).toEqual({
      kind: "legacy",
      sourceVersion: null,
    });
    expect(readCanvas("<html><body><h1 data-layer='a'>x</h1></body></html>")).toEqual({
      kind: "none",
    });
    // Broken facts read as an older save (nothing to check), never as a pass.
    expect(readCanvas(html(facts).replace("&quot;v&quot;:1", "&quot;v&quot;:9")).kind).toBe(
      "legacy",
    );
  });

  it("filled slots carry their picture; the imported file when unchanged", () => {
    const facts = canvasFacts((nodes) => [
      ...nodes.map((n) =>
        n.id === "7:4" && n.mark
          ? { ...n, mark: { ...n.mark, src: "/media/field.jpg", image: "d".repeat(40) } }
          : n,
      ),
      {
        ...(nodes[3] as CanvasFacts["nodes"][number]),
        id: "7:9",
        name: "Image",
        parent: "7:4",
        bounds: { x: 560, y: 320, w: 400, h: 500 },
        fills: [{ type: "image", image: "d".repeat(40), fit: "fill", size: null, opacity: 1 }],
        mark: null,
      },
    ]);
    const out = html(facts);
    expect(out).toContain(
      'data-slot-state="filled" data-slot-label="Saha fotoğrafı" data-slot-fit="cover"',
    );
    expect(out).toContain(
      `<img data-slot-image src="/media/field.jpg" alt="" data-wecra-image="${"d".repeat(40)}">`,
    );
    expect(lintSlideStatic(out, config).issues.filter((i) => i.severity !== "info")).toEqual([]);
    // The slot's own picture is not described twice.
    expect(canvasLayers(facts).map((l) => l.id)).not.toContain("image");
  });

  it("alt text: the slide's texts, the most prominent first chosen, in reading order, short", () => {
    expect(canvasAltText(canvasFacts())).toBe("Hasat bitti. Toprağınız için bor ve çinko.");
    const long = canvasFacts((nodes) =>
      nodes.map((n) =>
        n.id === "7:3" ? { ...n, text: textOf({ characters: "uzun metin ".repeat(60) }) } : n,
      ),
    );
    const alt = canvasAltText(long);
    expect(alt.length).toBeLessThanOrEqual(250);
    expect(alt.startsWith("Hasat bitti.")).toBe(true);
    expect(alt.endsWith("…")).toBe(true);
    expect(html(canvasFacts())).toContain('alt="Hasat bitti. Toprağınız için bor ve çinko."');
  });

  it("fits a very busy slide's facts into the slide HTML", () => {
    const busy = canvasFacts((nodes) => [
      ...nodes,
      ...Array.from({ length: 1_500 }, (_, i) => ({
        ...(nodes[2] as CanvasFacts["nodes"][number]),
        id: `9:${i}`,
        name: `Dekor ${i}`,
        type: "shape" as const,
        mark: null,
        visible: i % 2 === 0,
      })),
    ]);
    expect(canvasFactsSize(busy)).toBeGreaterThan(600_000);
    const fitted = fitCanvasFacts(busy) as CanvasFacts;
    expect(canvasFactsSize(fitted)).toBeLessThanOrEqual(600_000);
    expect(fitted.nodes.map((n) => n.id).slice(0, 5)).toEqual(["7:2", "7:3", "7:4", "7:5", "7:6"]);
    expect(fitCanvasFacts(canvasFacts())).toEqual(canvasFacts());
    expect(html(fitted).length).toBeLessThan(1_000_000);
  });

  it("names layers in kebab-case, Turkish letters folded", () => {
    expect(layerSlug("Başlık 2 — İçerik")).toBe("baslik-2-icerik");
    expect(layerSlug("…")).toBe("");
  });
});

describe("canvas checks (facts + render pixels)", () => {
  it("a clean slide only reports what is really there (the empty slot)", () => {
    expect(rules(canvasFacts())).toEqual(["slot-empty:field-photo"]);
    const report = lintCanvasSlide(
      { html: html(canvasFacts()), facts: canvasFacts(), raster: renderFacts(canvasFacts()) },
      config,
    );
    expect(report.stages).toEqual({ static: true, layout: true, pixel: true, render: true });
    const head = report.layers.find((l) => l.id === "headline");
    expect(head?.rect).toEqual({ x: 80, y: 200, w: 600, h: 96 });
    expect(head?.text).toMatchObject({ fontSize: 80, family: "Archivo", color: "rgb(29, 42, 27)" });
    expect(head?.text?.contrast?.median).toBeGreaterThan(10);
  });

  const withText = (id: string, change: Partial<CanvasFacts["nodes"][number]>) =>
    canvasFacts((nodes) => nodes.map((n) => (n.id === id ? { ...n, ...change } : n)));
  const headline = (canvasFacts().nodes[0] as CanvasFacts["nodes"][number]).text as NonNullable<
    CanvasFacts["nodes"][number]["text"]
  >;

  it("overflow: Wecra's overflow flag, truncation, the slide's edge, a clipping layer", () => {
    expect(rules(withText("7:2", { text: { ...headline, overflow: true } }))).toContain(
      "text-overflow-box:headline",
    );
    expect(rules(withText("7:2", { text: { ...headline, truncated: true } }))).toContain(
      "text-truncated:headline",
    );
    const off = withText("7:2", {
      bounds: { x: 900, y: 200, w: 600, h: 96 },
      text: { ...headline, lines: [{ x: 900, y: 200, w: 420, h: 96, from: 0, to: 11 }] },
    });
    expect(rules(off)).toContain("text-outside-artboard:headline");
    const clipped = withText("7:2", { clip: { x: 80, y: 200, w: 200, h: 96 } });
    expect(rules(clipped)).toContain("text-clipped:headline");
  });

  it("safe area: feed 64 px, story presets keep text off the top and bottom", () => {
    const near = withText("7:2", {
      bounds: { x: 30, y: 200, w: 600, h: 96 },
      text: { ...headline, lines: [{ x: 30, y: 200, w: 420, h: 96, from: 0, to: 11 }] },
    });
    const r = lintCanvasSlide({ html: html(near), facts: near, raster: null }, config);
    expect(r.issues.find((i) => i.rule === "safe-area")).toMatchObject({
      layer: "headline",
      data: { overflow: 34 },
    });
    const story = lintCanvasSlide(
      { html: html(canvasFacts()), facts: canvasFacts(), raster: null },
      { ...config, safeArea: { top: 250, right: 64, bottom: 340, left: 64 } },
    );
    expect(story.issues.filter((i) => i.rule === "safe-area").map((i) => i.layer)).toEqual([
      "headline",
      "logo",
      "topraginiz-icin-bor-ve-cinko",
    ]);
  });

  it("contrast is measured on the render's pixels, not on declared colours", () => {
    const pale = "#D8D2C4";
    const facts = withText("7:2", {
      text: {
        ...headline,
        color: pale,
        colors: [pale],
        fills: [{ type: "solid", color: pale, opacity: 1 }],
      },
    });
    const report = lintCanvasSlide(
      { html: html(facts), facts, raster: renderFacts(facts) },
      config,
    );
    const hit = report.issues.find((i) => i.rule === "contrast");
    expect(hit?.layer).toBe("headline");
    expect(hit?.data?.median).toBeLessThan(1.5);
    expect(hit?.data?.background).toBe("rgb(244,239,228)");
    // The same text over a dark band painted in the render (not in the facts) reads fine.
    const dark = renderFacts(facts);
    for (let y = 200; y < 296; y++)
      for (let x = 80; x < 500; x++) {
        const i = (y * W + x) * 3;
        if (dark.data[i] !== 0xd8) dark.data.set([20, 30, 25], i);
      }
    expect(
      lintCanvasSlide({ html: html(facts), facts, raster: dark }, config).issues.some(
        (i) => i.rule === "contrast",
      ),
    ).toBe(false);
    // Text drawn in the background's own colour: nothing to tell it from.
    const invisible = withText("7:2", {
      text: {
        ...headline,
        color: BG,
        colors: [BG],
        fills: [{ type: "solid", color: BG, opacity: 1 }],
      },
    });
    expect(rules(invisible)).toContain("contrast:headline");
    // Without the render, contrast is not measured (the pipeline reports it as skipped).
    const none = lintCanvasSlide({ html: html(facts), facts, raster: null }, config);
    expect(none.stages.pixel).toBe(false);
    expect(none.issues.some((i) => i.rule.startsWith("contrast"))).toBe(false);
  });

  it("fonts: not in the brand kit, missing on the canvas; sizes; widows", () => {
    const facts = withText("7:2", {
      text: { ...headline, family: "Comic Sans", missingFont: true, size: 20 },
    });
    expect(rules(facts)).toEqual(
      expect.arrayContaining(["font-family:headline", "font-missing:", "min-font-size:headline"]),
    );
    const widow = withText("7:2", {
      text: {
        ...headline,
        characters: "Hasat bitti yaz",
        lines: [
          { x: 80, y: 200, w: 420, h: 96, from: 0, to: 12 },
          { x: 80, y: 296, w: 60, h: 96, from: 12, to: 15 },
        ],
      },
    });
    expect(rules(widow)).toContain("widow:headline");
  });

  it("texts over each other, under a picture, over the logo", () => {
    const overlap = withText("7:3", {
      bounds: { x: 80, y: 210, w: 700, h: 88 },
      text: {
        ...((canvasFacts().nodes[1] as CanvasFacts["nodes"][number]).text as typeof headline),
        lines: [{ x: 80, y: 210, w: 380, h: 44, from: 0, to: 20 }],
      },
    });
    expect(rules(overlap)).toContain("text-overlap:headline");
    const under = canvasFacts((nodes) => [
      ...nodes,
      {
        ...(nodes[4] as CanvasFacts["nodes"][number]),
        id: "7:10",
        name: "Kapak",
        bounds: { x: 60, y: 180, w: 700, h: 140 },
      },
    ]);
    expect(rules(under)).toContain("text-occluded:headline");
    const onLogo = withText("7:3", {
      bounds: { x: 80, y: 1190, w: 700, h: 44 },
      text: {
        ...((canvasFacts().nodes[1] as CanvasFacts["nodes"][number]).text as typeof headline),
        lines: [{ x: 80, y: 1190, w: 380, h: 44, from: 0, to: 20 }],
      },
    });
    expect(rules(onLogo)).toEqual(
      expect.arrayContaining(["text-logo-overlap:topraginiz-icin-bor-ve-cinko"]),
    );
  });

  it("numbers in the real text are checked against the brand facts", () => {
    const facts = withText("7:2", {
      text: { ...headline, characters: "%37 daha fazla verim" },
    });
    expect(rules(facts)).toEqual(
      expect.arrayContaining(["unverified-number:headline", "percentage:headline"]),
    );
  });
});

const chromium = process.env.STUDIO_SKIP_RENDER !== "1" && (await isChromiumAvailable());

describe.skipIf(!chromium)("a canvas slide in Chromium", () => {
  let renderer: Renderer;
  let png: Uint8Array;
  const facts = canvasFacts((nodes) => [
    ...nodes,
    // A filled slot whose picture is the imported file: Chromium loads it, the slot paints nothing.
    {
      ...(nodes[4] as CanvasFacts["nodes"][number]),
      id: "7:11",
      name: "photo",
      bounds: { x: 120, y: 400, w: 300, h: 300 },
      fills: [{ type: "image", image: "e".repeat(40), fit: "fill", size: null, opacity: 1 }],
      mark: {
        layer: "photo",
        type: "slot",
        role: null,
        src: "/media/field.png",
        image: "e".repeat(40),
        allowOverlap: false,
        slot: { ratio: "1:1", label: "Ürün", fit: "cover" },
      },
    },
  ]);

  beforeAll(async () => {
    const raster = renderFacts(facts);
    png = new Uint8Array(
      await sharp(raster.data, { raw: { width: W, height: H, channels: 3 } })
        .png()
        .toBuffer(),
    );
    const field = new Uint8Array(
      await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ff0000" } })
        .png()
        .toBuffer(),
    );
    renderer = createRenderer({
      resolver: combineResolvers(
        createMemoryResolver({
          "/brand/brand.css": ventaCss(),
          "/media/render-1.png": png,
          "/media/field.png": field,
        }),
        createDirectoryResolver({ brand: fixturePath("venta") }),
      ),
    });
  });
  afterAll(async () => {
    await renderer?.close();
  });

  it("renders to exactly the PNG: the described layers change no pixel (brand.css loaded)", async () => {
    const out = html(facts);
    expect(out).toContain('src="/media/field.png"');
    const res = await renderer.renderAndLint({
      html: out,
      width: W,
      height: H,
      formats: ["png"],
      lint: { brandFonts: config.brandFonts, allowedNumbers: config.allowedNumbers },
    });
    expect(res.network).toEqual({ blocked: [], missing: [] });
    expect(res.served).toEqual(
      expect.arrayContaining([
        "/brand/brand.css",
        "/media/render-1.png",
        "/media/field.png",
        "/brand/logos/venta-wordmark-black.standin.png",
      ]),
    );
    const a = await sharp(res.png as Uint8Array)
      .removeAlpha()
      .raw()
      .toBuffer();
    const b = await sharp(png).removeAlpha().raw().toBuffer();
    expect(a.length).toBe(b.length);
    let diff = 0;
    for (let i = 0; i < a.length; i++)
      diff = Math.max(diff, Math.abs((a[i] as number) - (b[i] as number)));
    expect(diff).toBe(0);
    // Chromium's own lint of it: no errors (the described layers are invisible to its layout checks).
    expect(res.report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(res.report.layers.find((l) => l.id === "headline")?.visible).toBe(false);
  });
});
