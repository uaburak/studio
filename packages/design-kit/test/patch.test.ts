import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { brandPatchContext } from "../src/brand/index.ts";
import { parseSlide } from "../src/document/index.ts";
import {
  applyPatch,
  applyPatches,
  PATCH_OP_NAMES,
  PatchError,
  PatchLog,
  type PatchOpInput,
  revertPatches,
} from "../src/patch/index.ts";
import { isSanitized } from "../src/sanitize/index.ts";
import { PATCH_SCHEMA } from "../src/version.ts";
import { doc, FINAL_SLIDES, slide, ventaTokens } from "./helpers.ts";

const product = slide("product-intro");
const carousel = slide("carousel-2");
const slotDoc = slide("image-slot");
const ctx = brandPatchContext(ventaTokens());

/** Apply, check the expectation, then check the inverse restores the exact bytes. */
function roundTrip(html: string, op: PatchOpInput) {
  const res = applyPatch(html, op, ctx);
  expect(res.html).not.toBe(html);
  const back = applyPatch(res.doc, res.inverse, ctx);
  expect(back.html).toBe(html);
  // and the inverse of the inverse re-applies the edit
  expect(applyPatch(back.doc, back.inverse, ctx).html).toBe(res.html);
  return res;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof PatchError) return e.code;
    throw e;
  }
  return "no error";
}

/** Only the changed region differs: same prefix and suffix around one edit. */
function changedSpan(a: string, b: string) {
  let s = 0;
  while (s < a.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  return { removed: a.slice(s, a.length - e), added: b.slice(s, b.length - e) };
}

describe("text", () => {
  it("setText with plain text escapes and turns newlines into <br>", () => {
    const r = roundTrip(product, {
      op: "setText",
      layer: "headline",
      text: "Çinko & bor\n<bir> arada",
    });
    expect(r.doc.layer("headline")).toMatchObject({
      text: "Çinko & bor\n<bir> arada",
      html: "Çinko &amp; bor<br>&lt;bir&gt; arada",
    });
    expect(changedSpan(product, r.html).removed).toBe("Bor ve çinko<br>bir");
  });

  it("setText with inline html keeps markup; rejects layers and block elements", () => {
    const r = roundTrip(product, {
      op: "setText",
      layer: "headline",
      html: 'Bor ve <span style="color: var(--color-green)">çinko</span>',
    });
    expect(r.doc.layer("headline")).toMatchObject({ text: "Bor ve çinko" });
    expect(
      code(() => applyPatch(product, { op: "setText", layer: "headline", html: "<div>x</div>" })),
    ).toBe("invalid_html");
    expect(
      code(() =>
        applyPatch(product, {
          op: "setText",
          layer: "headline",
          html: '<span data-layer="z" data-type="text">x</span>',
        }),
      ),
    ).toBe("invalid_html");
    expect(
      code(() =>
        applyPatch(product, { op: "setText", layer: "headline", html: '<b onclick="x()">x</b>' }),
      ),
    ).toBe("invalid_html");
    expect(
      code(() =>
        applyPatch(product, {
          op: "setText",
          layer: "headline",
          html: '<b style="background:url(https://evil.example/x)">x</b>',
        }),
      ),
    ).toBe("unsafe_html");
  });

  it("refuses non-text layers and unknown or ambiguous ids", () => {
    expect(code(() => applyPatch(product, { op: "setText", layer: "intro", text: "x" }))).toBe(
      "wrong_layer_type",
    );
    expect(code(() => applyPatch(product, { op: "setText", layer: "nope", text: "x" }))).toBe(
      "unknown_layer",
    );
    const dup = doc(
      '<p data-layer="a" data-type="text">1</p><p data-layer="a" data-type="text">2</p>',
    );
    expect(code(() => applyPatch(dup, { op: "setText", layer: "a", text: "x" }))).toBe(
      "ambiguous_layer",
    );
    expect(
      code(() => applyPatch(product, { op: "setText", layer: "headline" } as PatchOpInput)),
    ).toBe("invalid_op");
  });
});

describe("style", () => {
  it("transform writes translate/rotate/scale with a minimal diff and never touches left/top", () => {
    const r = roundTrip(product, {
      op: "transform",
      layer: "intro",
      translate: { x: 12, y: -8 },
      rotate: -3.5,
      scale: 1.25,
    });
    expect(r.doc.layer("intro")?.transform).toEqual({
      translate: { x: 12, y: -8 },
      rotate: -3.5,
      scale: { x: 1.25, y: 1.25 },
    });
    expect(r.doc.layer("intro")?.style).toMatchObject({
      left: "72px",
      top: "72px",
      width: "936px",
    });
    const span = changedSpan(product, r.html);
    expect(span.removed).toBe("");
    // new declarations follow the list's own formatting ("left:72px; ...")
    expect(span.added).toBe("; translate:12px -8px; rotate:-3.5deg; scale:1.25");
    const cleared = applyPatch(r.doc, {
      op: "transform",
      layer: "intro",
      translate: null,
      rotate: null,
      scale: null,
    });
    expect(cleared.html).toBe(product);
  });

  it("adds a style attribute when there is none", () => {
    const r = roundTrip(product, {
      op: "transform",
      layer: "headline",
      translate: { x: 0, y: 24 },
    });
    expect(r.html).toContain('class="ts-display-m headline" style="translate: 0px 24px">');
  });

  it("resize, setColor (token and literal), setTypography", () => {
    roundTrip(product, { op: "resize", layer: "intro", width: 800, height: 400 });
    const c = roundTrip(product, {
      op: "setColor",
      layer: "headline",
      value: { token: "green-deep" },
    });
    expect(c.doc.layer("headline")?.style.color).toBe("var(--color-green-deep)");
    roundTrip(product, {
      op: "setColor",
      layer: "label-band",
      property: "background-color",
      value: { literal: "#3C8529" },
    });
    expect(
      code(() =>
        applyPatch(product, { op: "setColor", layer: "headline", value: { token: "purple" } }, ctx),
      ),
    ).toBe("invalid_value");
    expect(
      code(() =>
        applyPatch(product, {
          op: "setColor",
          layer: "headline",
          value: { literal: "red; background:url(x)" },
        }),
      ),
    ).toBe("invalid_value");
    const t = roundTrip(product, {
      op: "setTypography",
      layer: "headline",
      fontFamily: "text",
      fontSize: 72,
      fontWeight: 800,
      lineHeight: 1.02,
      letterSpacing: -0.02,
      textAlign: "center",
      fontStyle: "normal",
      textTransform: "none",
    });
    expect(t.doc.layer("headline")?.style).toMatchObject({
      "font-family": "var(--font-text)",
      "font-size": "72px",
      "font-weight": "800",
      "line-height": "1.02",
      "letter-spacing": "-0.02em",
      "text-align": "center",
    });
    expect(
      code(() =>
        applyPatch(product, { op: "setTypography", layer: "headline", fontFamily: "comic" }, ctx),
      ),
    ).toBe("invalid_value");
    expect(
      code(() =>
        applyPatch(product, { op: "setTypography", layer: "product-photo", fontSize: 20 }),
      ),
    ).toBe("wrong_layer_type");
  });

  it("setStyle accepts only allow-listed properties and values", () => {
    roundTrip(product, {
      op: "setStyle",
      layer: "intro",
      set: { opacity: "0.8", "z-index": "3", "border-radius": "var(--radius-lg)" },
    });
    const removed = roundTrip(product, { op: "setStyle", layer: "intro", set: { top: null } });
    expect(removed.doc.layer("intro")?.style.top).toBeUndefined();
    for (const [p, v] of [
      ["position", "fixed"],
      ["background-image", "url(/brand/x.png)"],
      ["width", "50vw"],
      ["color", "expression(alert(1))"],
      ["font-family", "Comic Sans MS"],
      ["left", "calc(10px + 1em)"],
    ] as const)
      expect(
        code(() => applyPatch(product, { op: "setStyle", layer: "intro", set: { [p]: v } })),
        `${p}: ${v}`,
      ).toBe("invalid_value");
  });

  it("is deterministic", () => {
    const op: PatchOpInput = {
      op: "transform",
      layer: "sign-off",
      translate: { x: 1.123456, y: 2 },
    };
    expect(applyPatch(product, op).html).toBe(applyPatch(product, op).html);
    expect(applyPatch(product, op).html).toContain("translate:1.1235px 2px");
  });
});

describe("images and slots", () => {
  it("replaceImage swaps src/alt; logos must come from /brand/logos/", () => {
    const r = roundTrip(product, {
      op: "replaceImage",
      layer: "product-photo",
      src: "/media/new-pack.png",
      alt: "Yeni",
    });
    expect(r.doc.layer("product-photo")).toMatchObject({ src: "/media/new-pack.png", alt: "Yeni" });
    roundTrip(product, {
      op: "replaceImage",
      layer: "logo-venta",
      src: "/brand/logos/venta-wordmark-white.standin.png",
    });
    expect(
      code(() =>
        applyPatch(product, { op: "replaceImage", layer: "logo-venta", src: "/media/x.png" }),
      ),
    ).toBe("invalid_value");
    expect(
      code(() =>
        applyPatch(product, {
          op: "replaceImage",
          layer: "product-photo",
          src: "https://evil.example/x.png",
        }),
      ),
    ).toBe("invalid_value");
    expect(
      code(() =>
        applyPatch(product, {
          op: "replaceImage",
          layer: "product-photo",
          src: "/media/../secret.png",
        }),
      ),
    ).toBe("invalid_value");
  });

  it("setImageFit crops images and filled slots; never logos", () => {
    const r = roundTrip(product, {
      op: "setImageFit",
      layer: "product-photo",
      fit: "cover",
      position: { x: "30%", y: "top" },
    });
    expect(r.doc.layer("product-photo")).toMatchObject({ fit: "cover", position: "30% top" });
    expect(
      code(() => applyPatch(product, { op: "setImageFit", layer: "logo-venta", fit: "cover" })),
    ).toBe("wrong_layer_type");
    expect(
      code(() => applyPatch(slotDoc, { op: "setImageFit", layer: "field-photo", fit: "cover" })),
    ).toBe("wrong_layer_type");
  });

  it("fillSlot and clearSlot", () => {
    const filled = roundTrip(slotDoc, {
      op: "fillSlot",
      layer: "field-photo",
      src: "/media/busy-test-photo.jpg",
      alt: "Tarla",
      position: { x: "50%", y: "40%" },
    });
    expect(filled.doc.layer("field-photo")).toMatchObject({
      state: "filled",
      image: { src: "/media/busy-test-photo.jpg", alt: "Tarla", position: "50% 40%" },
    });
    const cropped = roundTrip(filled.html, {
      op: "setImageFit",
      layer: "field-photo",
      position: { x: "50%", y: "10%" },
    });
    expect(cropped.doc.layer("field-photo")).toMatchObject({ image: { position: "50% 10%" } });
    const cleared = roundTrip(filled.html, { op: "clearSlot", layer: "field-photo" });
    expect(cleared.html).toBe(slotDoc);
    // the spike's fill-slot.mjs produced exactly this markup
    const spikeFilled = applyPatch(slotDoc, {
      op: "fillSlot",
      layer: "field-photo",
      src: "/media/busy-test-photo.jpg",
    });
    expect(spikeFilled.html).toBe(slide("image-slot.filled"));
    expect(
      code(() => applyPatch(slotDoc, { op: "fillSlot", layer: "copy", src: "/media/x.jpg" })),
    ).toBe("wrong_layer_type");
  });
});

describe("structure", () => {
  it("setVisibility toggles data-hidden", () => {
    const r = roundTrip(product, { op: "setVisibility", layer: "element-key", hidden: true });
    expect(r.doc.layer("element-key")?.hidden).toBe(true);
    expect(
      applyPatch(r.doc, { op: "setVisibility", layer: "element-key", hidden: false }).html,
    ).toBe(product);
  });

  it("moveLayer reorders siblings (z-order) and back", () => {
    const r = roundTrip(product, { op: "moveLayer", layer: "product-photo", index: 4 });
    expect(r.doc.model.roots).toEqual([
      "label-band",
      "intro",
      "element-key",
      "sign-off",
      "product-photo",
    ]);
    expect(r.inverse).toEqual({ op: "moveLayer", layer: "product-photo", index: 0 });
    const inGroup = roundTrip(carousel, { op: "moveLayer", layer: "row-temperature", index: 0 });
    expect(inGroup.doc.layer("spec")?.children).toEqual([
      "row-temperature",
      "row-air",
      "row-light",
    ]);
    expect(
      code(() => applyPatch(product, { op: "moveLayer", layer: "product-photo", index: 9 })),
    ).toBe("invalid_value");
  });

  it("deleteLayer removes the element and its indentation; the inverse puts it back exactly", () => {
    const r = roundTrip(product, { op: "deleteLayer", layer: "element-key" });
    expect(r.doc.model.roots).toEqual(["product-photo", "label-band", "intro", "sign-off"]);
    expect(r.doc.layer("badge-b")).toBeUndefined();
    expect(r.inverse).toMatchObject({ op: "insertLayer", parent: null, index: 3 });
    const nested = roundTrip(carousel, { op: "deleteLayer", layer: "label-light" });
    expect(nested.doc.layer("row-light")?.children).toEqual(["value-light"]);
  });

  it("delete is exact even with comments and text around the layer", () => {
    const html = doc(`<p data-layer="a" data-type="text">A</p>
    <!-- note --><p data-layer="b" data-type="text">B</p> <!-- after -->
    <p data-layer="c" data-type="text">C</p>`);
    for (const id of ["a", "b", "c"]) roundTrip(html, { op: "deleteLayer", layer: id });
    for (const [id, index] of [
      ["a", 2],
      ["c", 0],
      ["b", 0],
    ] as const)
      roundTrip(html, { op: "moveLayer", layer: id, index });
  });

  it("duplicateLayer copies a subtree with fresh ids, optionally offset", () => {
    const r = roundTrip(product, {
      op: "duplicateLayer",
      layer: "element-key",
      offset: { x: 0, y: 200 },
    });
    expect(r.doc.model.roots).toEqual([
      "product-photo",
      "label-band",
      "intro",
      "element-key",
      "element-key-copy",
      "sign-off",
    ]);
    expect(r.doc.layer("badge-b-copy")).toMatchObject({ type: "group", parent: "badge-pair-copy" });
    expect(r.doc.layer("element-key-copy")?.transform.translate).toEqual({ x: 0, y: 200 });
    expect(r.inverse).toEqual({ op: "deleteLayer", layer: "element-key-copy" });
    const twice = applyPatch(r.doc, { op: "duplicateLayer", layer: "element-key" });
    expect(twice.doc.layer("element-key-copy-2")).toBeDefined();
    const named = roundTrip(product, {
      op: "duplicateLayer",
      layer: "headline",
      newId: "headline-2",
    });
    expect(named.doc.layer("headline-2")?.parent).toBe("intro");
    expect(
      code(() => applyPatch(product, { op: "duplicateLayer", layer: "headline", newId: "intro" })),
    ).toBe("invalid_value");
  });

  it("addLayer creates each layer type with matching indentation", () => {
    const specs: PatchOpInput[] = [
      {
        op: "addLayer",
        parent: "intro",
        layer: {
          id: "note",
          type: "text",
          role: "body",
          text: "Etiketi okuyunuz.",
          className: "ts-body",
          style: { color: "var(--color-graphite)" },
        },
      },
      {
        op: "addLayer",
        parent: null,
        layer: {
          id: "photo-2",
          type: "image",
          src: "/media/a.jpg",
          alt: "A",
          style: { left: "72px", top: "900px", width: "300px" },
        },
      },
      {
        op: "addLayer",
        parent: null,
        index: 0,
        layer: {
          id: "bg",
          type: "shape",
          role: "background",
          style: {
            left: "0",
            top: "0",
            width: "1080px",
            height: "1350px",
            "background-color": "var(--color-mist)",
          },
        },
      },
      {
        op: "addLayer",
        parent: null,
        layer: {
          id: "slot-2",
          type: "slot",
          ratio: "4:5",
          label: "Ürün",
          fit: "contain",
          style: { left: "600px", top: "600px", width: "400px", height: "500px" },
        },
      },
      {
        op: "addLayer",
        parent: "sign-off",
        layer: { id: "logo-2", type: "logo", src: "/brand/logos/mtm-agro-graphite.standin.png" },
      },
      { op: "addLayer", parent: "intro", index: 0, layer: { id: "stack", type: "group" } },
    ];
    for (const op of specs) {
      const r = roundTrip(product, op);
      const id = op.op === "addLayer" ? op.layer.id : "";
      expect(r.doc.layer(id)).toBeDefined();
      expect(isSanitized(r.html)).toBe(true);
    }
    const note = applyPatch(product, specs[0] as PatchOpInput);
    expect(note.html).toContain(
      '\n      <p data-layer="note" data-type="text" data-role="body" class="ts-body" style="color: var(--color-graphite)">Etiketi okuyunuz.</p>\n    </div>',
    );
    expect(
      code(() =>
        applyPatch(product, {
          op: "addLayer",
          parent: "headline",
          layer: { id: "x", type: "group" },
        }),
      ),
    ).toBe("wrong_layer_type");
    expect(
      code(() =>
        applyPatch(product, {
          op: "addLayer",
          parent: null,
          layer: { id: "intro", type: "group" },
        }),
      ),
    ).toBe("invalid_value");
    expect(
      code(() =>
        applyPatch(product, {
          op: "addLayer",
          parent: null,
          layer: { id: "x", type: "image", src: "data:image/png;base64,AA" },
        }),
      ),
    ).toBe("invalid_value");
    expect(
      code(() =>
        applyPatch(product, {
          op: "addLayer",
          parent: null,
          layer: { id: "x", type: "shape", style: { position: "fixed" } },
        }),
      ),
    ).toBe("invalid_value");
  });

  it("insertLayer and replaceLayer take clean single elements only", () => {
    const ok = roundTrip(product, {
      op: "insertLayer",
      parent: "intro",
      index: 1,
      html: '<p data-layer="x" data-type="text">x</p>',
      leading: "\n      ",
    });
    expect(ok.doc.layer("intro")?.children).toEqual(["eyebrow-stack", "x", "headline"]);
    const bad = (html: string) =>
      code(() => applyPatch(product, { op: "insertLayer", parent: null, index: 0, html }));
    expect(bad('<p data-layer="y" data-type="text">a</p><p>b</p>')).toBe("invalid_html");
    expect(bad("text only")).toBe("invalid_html");
    expect(bad('<p data-type="text">no id</p>')).toBe("invalid_html");
    expect(bad('<p data-layer="intro" data-type="text">dup</p>')).toBe("invalid_value");
    expect(bad('<img data-layer="y" data-type="image" src="x" onerror="alert(1)">')).toBe(
      "unsafe_html",
    );
    expect(bad('<div data-layer="y" data-type="group"><script>alert(1)</script></div>')).toBe(
      "unsafe_html",
    );
    expect(
      bad(
        '<div data-layer="y" data-type="group"><p data-layer="headline" data-type="text">dup</p></div>',
      ),
    ).toBe("contract_violation");
    const rep = roundTrip(product, {
      op: "replaceLayer",
      layer: "headline",
      html: '<h2 data-layer="headline" data-type="text" data-role="headline" class="ts-headline">Yeni başlık</h2>',
    });
    expect(rep.doc.layer("headline")).toMatchObject({ tag: "h2", text: "Yeni başlık" });
    expect(
      code(() =>
        applyPatch(product, {
          op: "replaceLayer",
          layer: "headline",
          html: '<h2 data-layer="other" data-type="text">x</h2>',
        }),
      ),
    ).toBe("invalid_html");
    expect(
      code(() =>
        applyPatch(product, {
          op: "replaceLayer",
          layer: "headline",
          html: '<h2 data-layer="headline" data-type="text">x</h2><b>',
        }),
      ),
    ).toBe("invalid_html");
    // markup that would escape its element is caught by the outcome check
    expect(
      code(() =>
        applyPatch(product, {
          op: "replaceLayer",
          layer: "headline",
          html: '<h2 data-layer="headline" data-type="text"><!--',
        }),
      ),
    ).not.toBe("no error");
  });
});

describe("history", () => {
  it("covers every operation", () => {
    expect(PATCH_OP_NAMES).toHaveLength(17);
  });

  it("applyPatches + revertPatches round-trip, and logs are serialisable", () => {
    const ops: PatchOpInput[] = [
      { op: "setText", layer: "headline", text: "Bor + çinko" },
      { op: "transform", layer: "intro", translate: { x: 0, y: 40 } },
      { op: "duplicateLayer", layer: "badge-b", offset: { x: 30, y: 0 } },
      { op: "moveLayer", layer: "product-photo", index: 4 },
      { op: "setVisibility", layer: "subhead", hidden: true },
      { op: "deleteLayer", layer: "label-band" },
    ];
    const res = applyPatches(product, ops, ctx);
    const log = PatchLog.parse(
      JSON.parse(JSON.stringify({ schema: PATCH_SCHEMA, slide: 0, entries: res.entries })),
    );
    expect(revertPatches(res.html, log.entries, ctx).html).toBe(product);
    expect(
      applyPatches(
        product,
        log.entries.map((e) => e.op),
        ctx,
      ).html,
    ).toBe(res.html);
  });
});

describe("property-based: random edit sequences undo to the exact original", () => {
  const texts = fc.string({ maxLength: 30 });
  const num = fc.integer({ min: -300, max: 300 });
  function opArb(ids: string[], textIds: string[], groupIds: string[]): fc.Arbitrary<PatchOpInput> {
    const id = fc.constantFrom(...ids);
    return fc.oneof(
      fc.record({
        op: fc.constant("setText" as const),
        layer: fc.constantFrom(...textIds),
        text: texts,
      }),
      fc.record({
        op: fc.constant("transform" as const),
        layer: id,
        translate: fc.option(fc.record({ x: num, y: num }), { nil: null }),
        rotate: fc.option(fc.integer({ min: -45, max: 45 }), { nil: undefined }),
      }),
      fc.record({
        op: fc.constant("resize" as const),
        layer: id,
        width: fc.integer({ min: 0, max: 1080 }),
      }),
      fc.record({
        op: fc.constant("setColor" as const),
        layer: id,
        value: fc.constantFrom({ token: "ink" }, { token: "green" }, { literal: "#123456" }, null),
      }),
      fc.record({ op: fc.constant("setVisibility" as const), layer: id, hidden: fc.boolean() }),
      fc.record({
        op: fc.constant("moveLayer" as const),
        layer: id,
        index: fc.integer({ min: 0, max: 3 }),
      }),
      fc.record({ op: fc.constant("duplicateLayer" as const), layer: id }),
      fc.record({ op: fc.constant("deleteLayer" as const), layer: id }),
      fc.record({
        op: fc.constant("addLayer" as const),
        parent: fc.constantFrom(null, ...groupIds),
        layer: fc.record({
          id: fc.constantFrom("n1", "n2", "n3"),
          type: fc.constant("text" as const),
          text: texts,
        }),
      }),
    ) as fc.Arbitrary<PatchOpInput>;
  }

  it.each(FINAL_SLIDES)("%s", (name) => {
    const html = slide(name);
    const m = parseSlide(html).model;
    const ids = m.layers.map((l) => l.id);
    const textIds = m.layers.filter((l) => l.type === "text").map((l) => l.id);
    const groupIds = m.layers.filter((l) => l.type === "group").map((l) => l.id);
    fc.assert(
      fc.property(
        fc.array(opArb(ids, textIds, groupIds), { minLength: 1, maxLength: 8 }),
        (ops) => {
          let cur = parseSlide(html);
          const entries = [];
          for (const op of ops) {
            try {
              const r = applyPatch(cur, op, ctx);
              entries.push({ op: r.op, inverse: r.inverse });
              expect(isSanitized(r.html)).toBe(true);
              expect(r.doc.model.issues.filter((i) => i.severity === "error")).toEqual([]);
              cur = r.doc;
            } catch (e) {
              if (!(e instanceof PatchError)) throw e;
            }
          }
          expect(revertPatches(cur, entries, ctx).html).toBe(html);
          // replaying the log reproduces the same document
          expect(
            applyPatches(
              html,
              entries.map((e) => e.op),
              ctx,
            ).html,
          ).toBe(cur.html);
        },
      ),
      { numRuns: 60 },
    );
  });
});
