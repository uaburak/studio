import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createSlideHtml, parseSlide, serializeSlide, subtreeIds } from "../src/document/index.ts";
import { lintSlideStatic } from "../src/lint/index.ts";
import { doc, SLIDE_NAMES, slide } from "./helpers.ts";

describe("parseSlide on the spike outputs", () => {
  it("builds the layer tree of the product post", () => {
    const d = parseSlide(slide("product-intro"));
    const m = d.model;
    expect(m.contract).toBe("v0");
    expect(m.lang).toBe("tr");
    expect(m.format).toEqual({ width: 1080, height: 1350 });
    expect(m.artboard).toEqual({ width: 1080, height: 1350 });
    expect(m.roots).toEqual(["product-photo", "label-band", "intro", "element-key", "sign-off"]);
    expect(m.issues).toEqual([]);
    const intro = d.layer("intro");
    expect(intro?.type).toBe("group");
    expect(intro?.children).toEqual(["eyebrow-stack", "headline"]);
    const headline = d.layer("headline");
    expect(headline).toMatchObject({
      type: "text",
      role: "headline",
      parent: "intro",
      tag: "h1",
      text: "Bor ve çinko\nbir arada",
    });
    if (headline?.type === "text") expect(headline.html).toBe("Bor ve çinko<br>bir arada");
    const photo = d.layer("product-photo");
    expect(photo).toMatchObject({
      type: "image",
      src: "/brand/assets/product-venta-borinc.png",
      alt: "Venta Borinc ambalajı",
    });
    expect(photo?.style).toMatchObject({ left: "147px", width: "1200px" });
    expect(d.layer("logo-venta")).toMatchObject({ type: "logo", parent: "sign-off" });
    expect(subtreeIds(m, "element-key")).toEqual([
      "element-key",
      "badge-pair",
      "badge-b",
      "badge-b-hex",
      "badge-b-letter",
      "badge-zn",
      "badge-zn-hex",
      "badge-zn-letter",
      "subhead",
    ]);
  });

  it("reads slots, empty and filled", () => {
    const empty = parseSlide(slide("image-slot")).layer("field-photo");
    expect(empty).toMatchObject({
      type: "slot",
      state: "empty",
      ratio: { w: 4, h: 3 },
      label: "Saha fotoğrafı",
      fit: "cover",
      image: null,
    });
    const filled = parseSlide(slide("image-slot.filled")).layer("field-photo");
    expect(filled).toMatchObject({
      type: "slot",
      state: "filled",
      image: { src: "/media/busy-test-photo.jpg", alt: "" },
    });
  });

  it("reads an inline SVG shape and nested text runs", () => {
    const d = parseSlide(slide("carousel-2"));
    expect(d.layer("label-band")).toMatchObject({ type: "shape", svg: true, tag: "svg" });
    expect(d.layer("counter")).toMatchObject({ type: "text", text: "2 / 3", role: "counter" });
    expect(d.layer("value-temperature")).toMatchObject({ text: "5°C – 45°C arası" });
  });

  it.each(SLIDE_NAMES)("%s: serialising returns the exact source", (name) => {
    const html = slide(name);
    const d = parseSlide(html);
    expect(serializeSlide(d)).toBe(html);
    for (const l of d.model.layers) expect(html).toContain(d.layerHtml(l.id) as string);
  });
});

describe("editor transform and hidden state", () => {
  it("reads translate/rotate/scale and data-hidden", () => {
    const d = parseSlide(
      doc(
        `<p data-layer="a" data-type="text" data-hidden style="position:absolute; left:72px; translate: 10px -4.5px; rotate: 0.25turn; scale: 1.5 2">x</p>`,
      ),
    );
    expect(d.layer("a")).toMatchObject({
      hidden: true,
      transform: { translate: { x: 10, y: -4.5 }, rotate: 90, scale: { x: 1.5, y: 2 } },
    });
  });
});

describe("structural issues", () => {
  it("reports duplicate ids, bad types, bad roles, bad nesting and a missing artboard", () => {
    const d = parseSlide(
      doc(`
<p data-layer="x" data-type="text">a</p>
<p data-layer="x" data-type="text">b</p>
<div data-layer="Bad_Id" data-type="text">c</div>
<div data-layer="t" data-type="title">d</div>
<p data-layer="r" data-type="text" data-role="hero">e</p>
<div data-layer="s" data-type="shape"><p data-layer="inner" data-type="text">f</p></div>`),
    );
    const rules = d.model.issues.map((i) => `${i.rule}:${i.layer}`);
    expect(rules).toEqual(
      expect.arrayContaining([
        "layer-id-duplicate:x",
        "layer-id-format:Bad_Id",
        "layer-type:t",
        "layer-role:r",
        "layer-nesting:inner",
      ]),
    );
    expect(d.layer("x")).toBeUndefined();
    expect(d.duplicateIds.has("x")).toBe(true);
    expect(parseSlide("<p>no artboard</p>").model.issues.map((i) => i.rule)).toContain(
      "artboard-count",
    );
  });
});

describe("createSlideHtml", () => {
  it("produces a contract v1 skeleton that lints clean statically", () => {
    const html = createSlideHtml({
      width: 1080,
      height: 1080,
      body: '<p data-layer="t" data-type="text">Merhaba</p>',
    });
    const m = parseSlide(html).model;
    expect(m).toMatchObject({
      contract: "v1",
      lang: "tr",
      format: { width: 1080, height: 1080 },
      artboard: { width: 1080, height: 1080 },
      roots: ["t"],
    });
    const r = lintSlideStatic(html, { width: 1080, height: 1080 });
    expect(r.issues).toEqual([]);
  });
});

describe("parser robustness (property-based)", () => {
  const tag = fc.constantFrom(
    "div",
    "p",
    "span",
    "main",
    "img",
    "svg",
    "style",
    "script",
    "b",
    "br",
    "figure",
    "table",
    "td",
  );
  const attr = fc.tuple(
    fc.constantFrom(
      "data-layer",
      "data-type",
      "data-role",
      "style",
      "class",
      "src",
      "onclick",
      "data-artboard",
    ),
    fc.string({ maxLength: 12 }),
  );
  const node: fc.Arbitrary<string> = fc.letrec<{ node: string }>((tie) => ({
    node: fc.oneof(
      { depthSize: "small" },
      fc.string({ maxLength: 20 }),
      fc
        .tuple(
          tag,
          fc.array(attr, { maxLength: 3 }),
          fc.array(tie("node"), { maxLength: 3 }),
          fc.boolean(),
        )
        .map(
          ([t, attrs, kids, close]) =>
            `<${t}${attrs.map(([k, v]) => ` ${k}="${v.replace(/"/g, "")}"`).join("")}>${kids.join("")}${close ? `</${t}>` : ""}`,
        ),
    ),
  })).node;

  it("never throws and serialises to the exact input", () => {
    fc.assert(
      fc.property(fc.array(node, { maxLength: 6 }), (parts) => {
        const html = `<!doctype html><html lang="tr"><body><main data-artboard style="width:1080px;height:1350px">${parts.join("")}</main></body></html>`;
        const d = parseSlide(html);
        expect(serializeSlide(d)).toBe(html);
        expect(Array.isArray(d.model.layers)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("survives arbitrary strings", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), (s) => {
        expect(parseSlide(s).html).toBe(s);
      }),
      { numRuns: 300 },
    );
  });
});
