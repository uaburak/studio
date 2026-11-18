/**
 * Templates (N9) and repurposing (N10): a post's slides as fillable fields (HTML and canvas),
 * filling them without touching the layout, auto-fit, and reading what a post says.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CanvasFacts, canvasSlideHtml } from "../src/canvas/index.ts";
import { parseSlide } from "../src/document/index.ts";
import { applyPatch } from "../src/patch/index.ts";
import {
  autoFitFloor,
  canvasFillOperations,
  canvasFitCorrections,
  fitTextSize,
  htmlFillPatches,
  looksLikeAddress,
  planFitSizes,
  readPostSource,
  sourceImages,
  type TemplateFieldDraft,
  templateFields,
  textCapacity,
  wrapLines,
} from "../src/template/index.ts";
import { canvasFacts, textOf } from "./canvas-fixture.ts";
import { fixturePath } from "./helpers.ts";

const filled = readFileSync(fixturePath("slides/image-slot.filled.html"), "utf8");
const carousel = [1, 2, 3].map((i) =>
  readFileSync(fixturePath(`slides/carousel-${i}.html`), "utf8"),
);
const slide = (html: string) => ({ html, width: 1080, height: 1350 });
const canvasHtml = (facts: CanvasFacts) =>
  canvasSlideHtml({ facts, src: "/media/render-1.png", sha256: "c".repeat(64) });

function field(fields: TemplateFieldDraft[], key: string): TemplateFieldDraft {
  const f = fields.find((x) => x.key === key);
  if (!f) throw new Error(`no field ${key}: ${fields.map((x) => x.key).join(", ")}`);
  return f;
}

describe("template fields from HTML slides", () => {
  it("names text layers and image slots from their roles; the brand's fixed parts stay", () => {
    const res = templateFields([slide(filled)]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.kind).toBe("html");
    const keys = res.fields.map((f) => f.key);
    expect(keys).toEqual(["slot", "badge", "badge-2", "headline", "subhead", "body", "caption"]);
    const headline = field(res.fields, "headline");
    expect(headline).toMatchObject({
      kind: "text",
      layerType: "text",
      role: "headline",
      layer: "headline",
      label: "Başlık",
      example: "Bor ve çinko",
      locked: false,
      autoFit: true,
    });
    expect(headline.maxChars).toBeGreaterThanOrEqual("Bor ve çinko".length);
    expect(field(res.fields, "slot")).toMatchObject({
      kind: "image",
      layerType: "slot",
      layer: "field-photo",
      ratio: "4:3",
      example: "/media/busy-test-photo.jpg",
      label: "Görsel · Saha fotoğrafı",
    });
    // The logo is not a field; the web address is one, locked (the brand's own).
    expect(res.fields.some((f) => f.layer === "logo-venta")).toBe(false);
    expect(field(res.fields, "caption")).toMatchObject({ layer: "web-address", locked: true });
  });

  it("numbers repeated roles over a carousel, labels the slide and skips the counter", () => {
    const res = templateFields(carousel.map(slide));
    if (!res.ok) throw new Error(res.reason);
    expect(res.fields.every((f) => f.role !== "counter")).toBe(true);
    const headlines = res.fields.filter((f) => f.role === "headline");
    expect(headlines.map((f) => f.key)).toEqual(["headline", "headline-2", "headline-3"]);
    expect(headlines.map((f) => f.slide)).toEqual([0, 1, 2]);
    expect(headlines[1]?.label).toBe("Başlık · Kare 2");
    // A web address outside a sign-off group is a field, but locked.
    const web = res.fields.find((f) => f.example === "www.mtmagro.com");
    expect(web?.locked).toBe(true);
  });

  it("uses the measured boxes for the capacity hint", () => {
    const res = templateFields([
      {
        ...slide(filled),
        layers: [{ id: "headline", x: 72, y: 922, w: 936, h: 92 }],
      },
    ]);
    if (!res.ok) throw new Error(res.reason);
    expect(field(res.fields, "headline").metrics?.box).toEqual({ x: 72, y: 922, w: 936, h: 92 });
  });
});

describe("template fields from canvas slides", () => {
  it("names Wecra layers by the role the import kept, the largest text otherwise", () => {
    const res = templateFields([slide(canvasHtml(canvasFacts()))]);
    if (!res.ok) throw new Error(res.reason);
    expect(res.kind).toBe("canvas");
    expect(res.fields.map((f) => `${f.key}:${f.nodeId}`)).toEqual([
      "headline:7:2",
      "text:7:3",
      "slot:7:4",
      "image:7:6",
    ]);
    const headline = field(res.fields, "headline");
    expect(headline.metrics).toMatchObject({
      box: { x: 80, y: 200, w: 600, h: 96 },
      fontSize: 80,
      lineHeight: 96,
      lines: 1,
      autoResize: "height",
    });
    // 420 px over 11 characters.
    expect(headline.metrics?.charWidth).toBeCloseTo(420 / 11, 3);
    expect(headline.minFontSize).toBe(48);
    expect(field(res.fields, "text")).toMatchObject({ multiline: true, label: "Metin" });
    expect(field(res.fields, "slot")).toMatchObject({ ratio: "4:5", layerType: "slot" });
  });

  it("finds a slot's picture on a layer inside it", () => {
    const facts = canvasFacts((nodes) => [
      ...nodes,
      {
        ...(nodes[4] as CanvasFacts["nodes"][number]),
        id: "7:9",
        name: "slot picture",
        parent: "7:4",
        bounds: { x: 560, y: 320, w: 400, h: 500 },
      },
    ]);
    const res = templateFields([slide(canvasHtml(facts))]);
    if (!res.ok) throw new Error(res.reason);
    expect(field(res.fields, "slot").nodeId).toBe("7:9");
  });

  it("refuses an older canvas save without facts", () => {
    const legacy = `<!doctype html><html lang="tr"><head><meta name="studio:editor" content="wecra"></head><body><main data-artboard style="width:1080px;height:1350px"></main></body></html>`;
    const res = templateFields([slide(legacy)]);
    expect(res.ok).toBe(false);
  });
});

describe("filling", () => {
  it("patches only the fields' layers of an HTML template", () => {
    const res = templateFields([slide(filled)]);
    if (!res.ok) throw new Error(res.reason);
    const patches = htmlFillPatches(res.fields, {
      values: { headline: "Yeni hasat", body: "Kısa not." },
      images: { slot: "/media/asset-1.jpg" },
      sizes: { headline: 72 },
    });
    expect(patches.map((p) => p.op.op)).toEqual([
      "fillSlot",
      "setText",
      "setTypography",
      "setText",
    ]);
    let html = filled;
    for (const p of patches) html = applyPatch(html, p.op).html;
    const before = parseSlide(filled).model;
    const after = parseSlide(html).model;
    // Same layers in the same places; only the filled ones changed.
    expect(after.layers.map((l) => l.id)).toEqual(before.layers.map((l) => l.id));
    const text = (m: typeof after, id: string) => {
      const l = m.layers.find((x) => x.id === id);
      return l?.type === "text" ? l.text : null;
    };
    expect(text(after, "headline")).toBe("Yeni hasat");
    expect(text(after, "label-note")).toBe("Kısa not.");
    expect(text(after, "subhead")).toBe(text(before, "subhead"));
    const slot = after.layers.find((l) => l.id === "field-photo");
    expect(slot?.type === "slot" && slot.image?.src).toBe("/media/asset-1.jpg");
    expect(after.layers.find((l) => l.id === "headline")?.style["font-size"]).toBe("72px");
    for (const l of before.layers) {
      if (["headline", "label-note", "field-photo"].includes(l.id)) continue;
      expect(after.layers.find((x) => x.id === l.id)?.style).toEqual(l.style);
    }
  });

  it("leaves locked fields alone", () => {
    const res = templateFields([slide(filled)]);
    if (!res.ok) throw new Error(res.reason);
    const locked = res.fields.map((f) => (f.key === "headline" ? { ...f, locked: true } : f));
    expect(htmlFillPatches(locked, { values: { headline: "x" }, images: {} })).toEqual([]);
  });

  it("writes Wecra operations for a canvas template", () => {
    const res = templateFields([slide(canvasHtml(canvasFacts()))]);
    if (!res.ok) throw new Error(res.reason);
    const ops = canvasFillOperations(res.fields, {
      values: { headline: "Ekim zamanı", text: "Yeni metin" },
      images: { slot: "asset_9" },
      sizes: { text: 30 },
    });
    expect(ops).toEqual([
      {
        tool: "update_nodes",
        args: {
          updates: [
            { nodeId: "7:2", characters: "Ekim zamanı" },
            { nodeId: "7:3", characters: "Yeni metin", fontSize: 30 },
          ],
        },
      },
      { tool: "place_image", args: { nodeId: "7:4", assetId: "asset_9", scaleMode: "FILL" } },
    ]);
  });
});

describe("auto-fit", () => {
  const metrics = {
    box: { x: 0, y: 0, w: 600, h: 96 },
    fontSize: 80,
    lineHeight: 96,
    charWidth: 38,
    lines: 1,
    autoResize: "height" as const,
  };

  it("keeps the size when the text fits and shrinks a longer one into the box", () => {
    expect(fitTextSize(metrics, "Hasat bitti", 48)).toEqual({
      size: 80,
      fits: true,
      shrunk: false,
    });
    const long = fitTextSize(metrics, "Hasat bitti, şimdi ekim zamanı", 40);
    expect(long?.shrunk).toBe(true);
    expect(long?.fits).toBe(true);
    expect(long?.size).toBeLessThan(80);
    expect(long?.size).toBeGreaterThanOrEqual(40);
  });

  it("stops at the floor and says it still overflows", () => {
    const res = fitTextSize(metrics, "çok ".repeat(80), 48);
    expect(res).toEqual({ size: 48, fits: false, shrunk: true });
  });

  it("floors at the contract minimum or 60 % of the source size", () => {
    expect(autoFitFloor("headline", 80)).toBe(48);
    expect(autoFitFloor("body", 36)).toBe(28);
    expect(autoFitFloor("legal", 22)).toBe(20);
    expect(autoFitFloor(null, null)).toBe(24);
  });

  it("wraps whole words and breaks long ones", () => {
    expect(wrapLines("bir iki üç dört", 7)).toEqual(["bir iki", "üç dört"]);
    expect(wrapLines("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(textCapacity(metrics)).toBe(15);
  });

  it("plans canvas sizes before filling and corrects them from Wecra's layout", () => {
    const res = templateFields([slide(canvasHtml(canvasFacts()))]);
    if (!res.ok) throw new Error(res.reason);
    const values = { headline: "Hasat bitti, toprağı hazırlama zamanı geldi" };
    const sizes = planFitSizes(res.fields, values);
    expect(sizes.headline).toBeLessThan(80);
    expect(sizes.headline).toBeGreaterThanOrEqual(48);

    // Wecra laid the headline out on two lines anyway: one correction makes it smaller.
    const after = canvasFacts((nodes) =>
      nodes.map((n) =>
        n.id === "7:2"
          ? {
              ...n,
              bounds: { ...n.bounds, h: 140 },
              text: textOf({
                characters: values.headline,
                size: 60,
                lineHeight: 72,
                lines: [
                  { x: 80, y: 200, w: 590, h: 72, from: 0, to: 26 },
                  { x: 80, y: 272, w: 400, h: 72, from: 26, to: 43 },
                ],
              }),
            }
          : n,
      ),
    );
    const fix = canvasFitCorrections(res.fields, [after]);
    expect(fix.headline).toBeLessThan(60);
    expect(fix.headline).toBeGreaterThanOrEqual(48);
    // What fits stays.
    expect(canvasFitCorrections(res.fields, [canvasFacts()])).toEqual({});
  });
});

describe("post source (repurposing)", () => {
  it("reads texts in reading order and media pictures of an HTML post", () => {
    const source = readPostSource([slide(filled)]);
    expect(source.kind).toBe("html");
    const s0 = source.slides[0];
    expect(s0?.texts.map((t) => t.role)).toEqual(["headline", "subhead", "body", "badge", "badge"]);
    expect(s0?.texts[1]?.text).toBe("Venta Borinc ile bir arada.");
    expect(s0?.images).toEqual([
      { src: "/media/busy-test-photo.jpg", assetId: "busy-test-photo", slot: true },
    ]);
    expect(sourceImages(source).map((i) => i.assetId)).toEqual(["busy-test-photo"]);
  });

  it("reads a canvas post from its facts", () => {
    const facts = canvasFacts((nodes) =>
      nodes.map((n) =>
        n.id === "7:6"
          ? {
              ...n,
              mark: {
                layer: "photo",
                type: "image",
                role: null,
                src: "/media/asset_7.jpg",
                image: "b".repeat(40),
                allowOverlap: false,
                slot: null,
              },
            }
          : n,
      ),
    );
    const source = readPostSource([slide(canvasHtml(facts))]);
    expect(source.kind).toBe("canvas");
    expect(source.slides[0]?.texts.map((t) => [t.role, t.text])).toEqual([
      ["headline", "Hasat bitti"],
      [null, "Toprağınız için bor ve çinko."],
    ]);
    expect(source.slides[0]?.images.map((i) => i.assetId)).toEqual(["asset_7"]);
  });

  it("knows addresses", () => {
    expect(looksLikeAddress("www.mtmagro.com")).toBe(true);
    expect(looksLikeAddress("mtmagro.com.tr")).toBe(true);
    expect(looksLikeAddress("@mtmagro")).toBe(true);
    expect(looksLikeAddress("Bor ve çinko")).toBe(false);
  });
});
