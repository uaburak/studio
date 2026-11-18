// Canvas facts from a real Wecra document (Wecra's engine headless, its Inter loaded so the text
// engine really lays text out): a design-kit slide imported with its contract layers kept on the
// Wecra layers (slot, logo, roles), edited as a user would (longer text in a fixed box, a hidden
// layer, a rotated one, a font that isn't there), then read back as facts — the lines and
// overflow Wecra's text engine reports, boxes in paint order, the marks through a bundle round
// trip — and turned into the slide HTML and its checks.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WNode } from "@shared/agents/web/convert";
import {
  type CanvasFacts,
  canvasLayers,
  canvasSlideHtml,
  lintCanvasSlide,
  readCanvas,
} from "@studio/design-kit/canvas";
import { lintSlideStatic, type Raster } from "@studio/design-kit/lint";
import { beforeAll, describe, expect, it } from "vitest";
import { EditorController } from "@/editor/controller";
import { memoryDocumentSource } from "@/editor/documentSource";
import { EMPTY_DOCUMENT } from "@/editor/fixtures";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { BUNDLED_FACES, fonts } from "@/engine/fonts";
import {
  BundleImages,
  decodeBundle,
  encodeBundle,
} from "../../src/renderer/features/post-editor/wecra/bundle.ts";
import { canvasFacts, slideFacts } from "../../src/renderer/features/post-editor/wecra/facts.ts";
import {
  finishSlide,
  importSlides,
  layerMarks,
  markLayers,
  slideSpec,
} from "../../src/renderer/features/post-editor/wecra/import.ts";

const INTER = resolve(
  import.meta.dirname,
  "../../src/renderer/vendor/wecra-editor/src/renderer/src/engine/fonts/InterVariable.ttf",
);

const SIZE = { width: 1080, height: 1350 };

const SLIDE_HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"></head><body>
<main data-artboard style="width:1080px;height:1350px">
<h1 data-layer="headline" data-type="text" data-role="headline">Hasat bitti</h1>
<p data-layer="body" data-type="text" data-role="body">Toprak</p>
<figure data-layer="field-photo" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty" data-slot-label="Saha fotoğrafı" data-slot-fit="cover"></figure>
<img data-layer="logo" data-type="logo" src="/brand/logos/mark.png" alt="">
<div data-layer="band" data-type="shape" data-role="decoration"></div>
</main></body></html>`;

const text = (i: number, chars: string, x: number, y: number, w: number): WNode => ({
  kind: "text",
  chars,
  x,
  y,
  w,
  h: 48,
  lines: 1,
  ci: i,
  c: { fg: "#1d2a1b" },
  ts: { font: "Inter, sans-serif", size: 40, weight: 700, lh: 48, ls: 0, align: "left" },
  children: [],
});

const box = (i: number, tag: string, rest: Partial<WNode>): WNode => ({
  kind: "box",
  i,
  tag,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  d: "block",
  pos: "absolute",
  pad: [0, 0, 0, 0],
  bw: [0, 0, 0, 0],
  mar: [0, 0, 0, 0],
  rad: [0, 0, 0, 0],
  gap: [0, 0],
  sh: [],
  c: {},
  children: [],
  ...rest,
});

/** The slide as Wecra's walker captures it (element i ↔ data-layer `LAYERS[i]`). */
const LAYERS = ["", "headline", "body", "field-photo", "logo", "band"];
const tree = (): WNode =>
  box(0, "main", {
    w: 1080,
    h: 1350,
    pos: "relative",
    c: { bg: "#f4efe4" },
    children: [
      box(1, "h1", {
        x: 80,
        y: 200,
        w: 600,
        h: 48,
        children: [text(1, "Hasat bitti", 80, 200, 600)],
      }),
      box(2, "p", { x: 80, y: 1000, w: 300, h: 48, children: [text(2, "Toprak", 80, 1000, 300)] }),
      box(3, "figure", { x: 560, y: 320, w: 400, h: 500, c: { bg: "#e0d9c8" } }),
      box(4, "div", { x: 80, y: 1180, w: 240, h: 80, c: { bg: "#ffffff" } }),
      box(5, "div", { x: 0, y: 1300, w: 1080, h: 50, c: { bg: "#2f5d2b" } }),
    ],
  });

type Node = { guid: string; name?: string; type?: string };

async function importedPost() {
  const source = memoryDocumentSource(structuredClone(EMPTY_DOCUMENT), {
    sessionID: 7,
    images: new BundleImages(),
  });
  const engine = await Engine.create(null, { sessionID: 7 });
  expect(engine.load(await source.load())).toBe(0);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const { spec, fonts: families } = slideSpec(tree(), (i) => LAYERS[i] || null, 0);
  const marks = layerMarks(SLIDE_HTML);
  const frames = await importSlides(ed, [
    { index: 0, ...SIZE, spec: finishSlide(spec, 0, SIZE), fonts: families, missing: [], marks },
  ]);
  await fonts.settled();
  engine.pump();
  const frame = frames[0]?.ref as string;
  const byName = (name: string) =>
    (engine.readNodes([frame], { subtree: true, fields: ["name", "type"] }) as Node[]).find(
      (n) => n.name === name,
    ) as Node;
  return { ed, engine, frame, byName, marks, source };
}

const hashBytes = (hex: string) =>
  Array.from({ length: 20 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16));

/**
 * The slide's pixels as Wecra's export would give them (the headless engine has no GPU and
 * exports blank pixels): the frame's colour, the boxes' fills, each text's ink as glyph-like bars
 * on the lines Wecra's text engine laid out.
 */
function painted(facts: CanvasFacts): Raster {
  const { width, height } = facts.frame;
  const data = new Uint8Array(width * height * 3);
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const fill = (r: { x: number; y: number; w: number; h: number }, c: number[], step = 0) => {
    for (let y = Math.max(0, Math.round(r.y)); y < Math.min(height, Math.round(r.y + r.h)); y++)
      for (let x = Math.max(0, Math.round(r.x)); x < Math.min(width, Math.round(r.x + r.w)); x++)
        if (!step || (x - Math.round(r.x)) % step < step / 2) data.set(c, (y * width + x) * 3);
  };
  fill({ x: 0, y: 0, w: width, h: height }, rgb(facts.frame.background ?? "#FFFFFF"));
  for (const n of facts.nodes) {
    if (!n.visible) continue;
    for (const p of n.fills) if (p.type === "solid") fill(n.bounds, rgb(p.color));
    if (n.text?.color)
      for (const l of n.text.lines)
        fill({ x: l.x, y: l.y + l.h * 0.2, w: l.w, h: l.h * 0.6 }, rgb(n.text.color), 12);
  }
  return { width, height, channels: 3, data };
}

beforeAll(() => {
  const ttf = new Uint8Array(readFileSync(INTER));
  fonts.setSource({ list: async () => BUNDLED_FACES, read: async () => ttf });
});

describe("canvas facts from a Wecra document (real engine)", () => {
  it("keeps the contract's layers on the Wecra layers the import made", async () => {
    const { ed, frame, marks } = await importedPost();
    expect(marks.map((m) => [m.layer, m.type])).toEqual([
      ["headline", "text"],
      ["body", "text"],
      ["field-photo", "slot"],
      ["logo", "logo"],
      ["band", "shape"],
    ]);
    const facts = canvasFacts(ed, frame);
    const marked = facts.nodes
      .filter((n) => n.mark)
      .map((n) => [n.name, n.wecraType, n.mark?.type]);
    expect(marked).toEqual([
      ["headline", "TEXT", "text"],
      ["body", "TEXT", "text"],
      ["field-photo", "FRAME", "slot"],
      ["logo", "FRAME", "logo"],
      ["band", "FRAME", "shape"],
    ]);
    expect(facts.nodes.find((n) => n.name === "field-photo")?.mark?.slot).toEqual({
      ratio: "4:5",
      label: "Saha fotoğrafı",
      fit: "cover",
    });
  });

  it("reads layers in paint order with Wecra's text layout, overflow, fonts, rotation, visibility", async () => {
    const { ed, engine, frame, byName } = await importedPost();
    // A user's edits: a long text in the fixed box, a hidden layer, a rotated one.
    const body = byName("body");
    engine.setProps([body.guid], { textAutoResize: "NONE", size: { x: 300, y: 48 } } as never);
    engine.setProps([body.guid], {
      textData: { characters: "Toprağınız için bor ve çinko, hasattan önce ve sonra." },
    } as never);
    engine.setProps([byName("band").guid], { visible: false } as never);
    const c = Math.cos(Math.PI / 6);
    const s = Math.sin(Math.PI / 6);
    engine.setProps([byName("field-photo").guid], {
      transform: { m00: c, m01: -s, m02: 560, m10: s, m11: c, m12: 320 },
    } as never);
    const facts = slideFacts(ed, frame) as CanvasFacts;
    expect(facts).not.toBeNull();
    expect(facts.frame).toMatchObject({
      name: "Kare 1",
      width: 1080,
      height: 1350,
      background: "#F4EFE4",
    });
    expect(facts.nodes.map((n) => n.name)).toEqual([
      "headline",
      "body",
      "field-photo",
      "logo",
      "band",
    ]);

    const head = facts.nodes[0] as CanvasFacts["nodes"][number];
    expect(head).toMatchObject({ type: "text", rotation: 0, visible: true });
    // The headline hugs its text (Wecra resized it to Inter's real width).
    expect(head.bounds).toMatchObject({ x: 80, y: 200, h: 48 });
    expect(head.bounds.w).toBeCloseTo(head.text?.lines[0]?.w ?? 0, 0);
    expect(head.text).toMatchObject({
      characters: "Hasat bitti",
      family: "Inter",
      style: "Bold",
      weight: 700,
      size: 40,
      lineHeight: 48,
      color: "#1D2A1B",
      overflow: false,
      truncated: false,
      missingFont: false,
    });
    // Wecra's text engine laid the line out (Inter's real advances).
    expect(head.text?.lines).toHaveLength(1);
    expect(head.text?.lines[0]?.w).toBeGreaterThan(150);
    expect(head.text?.lines[0]?.w).toBeLessThan(260);

    const bodyFacts = facts.nodes[1] as CanvasFacts["nodes"][number];
    expect(bodyFacts.text?.autoResize).toBe("none");
    expect(bodyFacts.text?.overflow).toBe(true);
    expect(bodyFacts.text?.lines.length).toBeGreaterThan(2);
    expect(bodyFacts.text?.lines.at(-1)?.to).toBe(bodyFacts.text?.characters.length);

    const slot = facts.nodes[2] as CanvasFacts["nodes"][number];
    expect(slot.rotation).toBeCloseTo(30, 1);
    // The rotated box's axis-aligned bounds.
    expect(slot.bounds.w).toBeCloseTo(400 * c + 500 * s, 0);
    expect(slot.bounds.x).toBeCloseTo(560 - 500 * s, 0);
    expect(facts.nodes[4]?.visible).toBe(false);
    expect(facts.fonts).toEqual([{ family: "Inter", style: "Bold", uses: 2, missing: false }]);

    // The HTML describes what is painted; the hidden band is left out.
    const layers = canvasLayers(facts);
    expect(layers.map((l) => [l.id, l.type])).toEqual([
      ["headline", "text"],
      ["body", "text"],
      ["field-photo", "slot"],
    ]);
    // The same document reads the same (the save's content hash is stable).
    expect(slideFacts(ed, frame)).toEqual(facts);
  });

  it("knows a missing font, a picture's file, and keeps the marks through the bundle", async () => {
    const { ed, engine, frame, byName, marks } = await importedPost();
    engine.setProps([byName("headline").guid], {
      fontName: { family: "Yok Sans", style: "Bold", postscript: "" },
    } as never);
    await fonts.settled();
    engine.pump();
    // The logo's picture as the import gives it (its bytes in Wecra's images), marked as imported.
    const key = "ab".repeat(20);
    engine.setProps([byName("logo").guid], {
      fillPaints: [
        {
          type: "IMAGE",
          image: { hash: hashBytes(key) },
          imageScaleMode: "FIT",
          opacity: 1,
          visible: true,
          originalImageWidth: 480,
          originalImageHeight: 160,
        },
      ],
    } as never);
    markLayers(
      ed,
      frame,
      marks.filter((m) => m.layer === "logo"),
    );
    const facts = slideFacts(ed, frame) as CanvasFacts;
    expect(facts.nodes[0]?.text?.missingFont).toBe(true);
    expect(facts.fonts.find((f) => f.family === "Yok Sans")?.missing).toBe(true);
    const logo = canvasLayers(facts).find((l) => l.id === "logo");
    expect(logo).toMatchObject({ type: "logo", src: "/brand/logos/mark.png" });
    expect(logo?.image).toMatchObject({ image: key, fit: "fit", size: { w: 480, h: 160 } });

    // A picture replaced on the canvas is no longer the brand's logo file.
    engine.setProps([byName("logo").guid], {
      fillPaints: [
        {
          type: "IMAGE",
          image: { hash: hashBytes("cd".repeat(20)) },
          imageScaleMode: "FILL",
          opacity: 1,
          visible: true,
        },
      ],
    } as never);
    expect(canvasLayers(canvasFacts(ed, frame)).find((l) => l.node.name === "logo")).toMatchObject({
      type: "image",
      src: null,
    });

    // The marks are in the document: a bundle opened again reads the same facts.
    const bundle = encodeBundle(engine.encodeDocumentKiwi(), new BundleImages(), []);
    const back = decodeBundle(bundle);
    const again = await Engine.create(null, { sessionID: 8 });
    const source = memoryDocumentSource(back.message, { sessionID: 8, images: back.images });
    expect(again.load(await source.load())).toBe(0);
    const ed2 = new EditorController(again, new EngineStore(again), source);
    const reread = canvasFacts(ed2, frame);
    expect(reread.nodes.map((n) => n.mark)).toEqual(
      canvasFacts(ed, frame).nodes.map((n) => n.mark),
    );
  });

  it("makes contract-valid slide HTML whose checks see the overflow, the empty slot and contrast", async () => {
    const { ed, engine, frame, byName } = await importedPost();
    const body = byName("body");
    engine.setProps([body.guid], { textAutoResize: "NONE", size: { x: 300, y: 48 } } as never);
    engine.setProps([body.guid], {
      textData: { characters: "Toprağınız için bor ve çinko, hasattan önce ve sonra." },
    } as never);
    const facts = slideFacts(ed, frame) as CanvasFacts;
    const html = canvasSlideHtml({ facts, src: "/media/r1.png", sha256: "a".repeat(64) });
    const config = { width: 1080, height: 1350, brandFonts: ["Inter"] };
    expect(lintSlideStatic(html, config).issues.filter((i) => i.severity !== "info")).toEqual([]);
    expect(readCanvas(html)).toEqual({ kind: "facts", facts, sourceVersion: null });

    const raster = painted(facts);
    const report = lintCanvasSlide({ html, facts, raster }, config);
    const rules = report.issues.map((i) => `${i.rule}:${i.layer ?? ""}`);
    expect(rules).toEqual(
      expect.arrayContaining(["text-overflow-box:body", "slot-empty:field-photo"]),
    );
    expect(rules.some((r) => r.startsWith("contrast"))).toBe(false);
    expect(report.layers.find((l) => l.id === "headline")?.text?.contrast?.median).toBeGreaterThan(
      4.5,
    );

    // A pale headline on the pale background: measured on the pixels, not the declared colours.
    engine.setProps([byName("headline").guid], {
      fillPaints: [
        { type: "SOLID", color: { r: 0.9, g: 0.88, b: 0.84, a: 1 }, opacity: 1, visible: true },
      ],
    } as never);
    const pale = slideFacts(ed, frame) as CanvasFacts;
    const paleReport = lintCanvasSlide(
      {
        html: canvasSlideHtml({ facts: pale, src: "/media/r1.png", sha256: "a".repeat(64) }),
        facts: pale,
        raster: painted(pale),
      },
      config,
    );
    expect(paleReport.issues.find((i) => i.rule === "contrast")?.layer).toBe("headline");
  });
});
