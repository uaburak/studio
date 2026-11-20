// The post editor's pieces without Wecra's engine: the slide documents the import reads
// (brand.css inlined, /media and /brand mapped), the slide HTML a canvas save stores (the render
// as the one image layer, its hash in the HTML), the brand kit, the AI scope line, and which keys
// and clipboard events are Wecra's (its places) and which are Studio's.
import { computeContentHash } from "@studio/contract";
import type { CanvasFacts } from "@studio/design-kit/canvas";
import { parseSlide } from "@studio/design-kit/document";
import { describe, expect, it } from "vitest";
import {
  canvasNote,
  codeNote,
  postReference,
  scopedInstruction,
  svgNote,
} from "../../src/renderer/features/post-editor/chat.ts";
import { DEMO_PROFILE } from "../../src/renderer/features/post-editor/demo/fixtures.ts";
import { slideDocument } from "../../src/renderer/features/post-editor/html/slide-document.ts";
import {
  buildRenderKit,
  resolveVirtualUrl,
} from "../../src/renderer/features/post-editor/model/brand-kit.ts";
import { ownsEvent, WECRA_REGION } from "../../src/renderer/features/post-editor/wecra/embed.ts";
import {
  canvasOrigin,
  canvasSlideHtml,
  canvasSlideLayout,
  sha256Hex,
} from "../../src/renderer/features/post-editor/wecra/slide-html.ts";

const HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="studio:contract" content="v1"><meta name="studio:format" content="1080x1350"><link rel="stylesheet" href="/brand/brand.css"></head><body><main data-artboard style="width:1080px;height:1350px">
<h1 data-layer="headline" data-type="text" data-role="headline" style="position:absolute;left:80px;top:200px;width:600px">Hasat bitti</h1>
<img data-layer="photo" data-type="image" src="/media/a1b2.jpg" alt="" style="position:absolute;left:600px;top:500px;width:400px;height:300px">
</main></body></html>`;

describe("slide documents (what the import renders)", () => {
  const kit = { css: ":root{--color-ink:#111}", files: { "logos/mark.svg": "asset-9" } };

  it("inlines brand.css where its link was and maps /media and /brand", () => {
    const html = HTML.replace(
      "</main>",
      '<img data-layer="logo" data-type="logo" src="/brand/logos/mark.svg" alt=""></main>',
    );
    const doc = slideDocument(html, kit);
    expect(doc).not.toContain("/brand/brand.css");
    expect(doc).toContain(":root{--color-ink:#111}");
    expect(doc).toContain('src="/api/assets/a1b2/content"');
    expect(doc).toContain('src="/api/assets/asset-9/content"');
    expect(doc).toContain("Content-Security-Policy");
    expect(resolveVirtualUrl("/media/x%20y.png", {})).toBe("/api/assets/x%20y/content");
    expect(resolveVirtualUrl("/brand/fonts/missing.woff2", {})).toBeNull();
  });
});

/** A slide's canvas facts as the extractor writes them: a headline and an empty image slot. */
const FACTS: CanvasFacts = {
  v: 1,
  editor: "wecra",
  frame: {
    id: "7:1",
    name: "Kare 1",
    width: 1080,
    height: 1350,
    background: "#F4EFE4",
    fills: [{ type: "solid", color: "#F4EFE4", opacity: 1 }],
  },
  nodes: [
    {
      id: "7:2",
      name: "headline",
      type: "text",
      wecraType: "TEXT",
      parent: null,
      bounds: { x: 80, y: 200, w: 600, h: 96 },
      rotation: 0,
      opacity: 1,
      effectiveOpacity: 1,
      visible: true,
      clips: false,
      clip: null,
      fills: [],
      strokes: [],
      strokeWeight: 0,
      mark: {
        layer: "headline",
        type: "text",
        role: "headline",
        src: null,
        image: null,
        allowOverlap: false,
        slot: null,
      },
      text: {
        characters: 'Hasat "bitti" <hemen>',
        family: "Archivo",
        style: "Bold",
        weight: 700,
        italic: false,
        size: 80,
        lineHeight: 96,
        letterSpacing: 0,
        align: "left",
        verticalAlign: "top",
        autoResize: "height",
        color: "#1D2A1B",
        colors: ["#1D2A1B"],
        fills: [{ type: "solid", color: "#1D2A1B", opacity: 1 }],
        runs: [],
        lines: [{ x: 80, y: 200, w: 520, h: 96, from: 0, to: 21 }],
        overflow: false,
        truncated: false,
        missingFont: false,
      },
    },
    {
      id: "7:3",
      name: "field-photo",
      type: "frame",
      wecraType: "FRAME",
      parent: null,
      bounds: { x: 560, y: 400, w: 400, h: 500 },
      rotation: 0,
      opacity: 1,
      effectiveOpacity: 1,
      visible: true,
      clips: true,
      clip: null,
      fills: [{ type: "solid", color: "#E0D9C8", opacity: 1 }],
      strokes: [],
      strokeWeight: 0,
      mark: {
        layer: "field-photo",
        type: "slot",
        role: null,
        src: null,
        image: null,
        allowOverlap: false,
        slot: { ratio: "4:5", label: "Saha fotoğrafı", fit: "cover" },
      },
    },
  ],
  fonts: [{ family: "Archivo", style: "Bold", uses: 1, missing: false }],
};

describe("a slide saved from the canvas", () => {
  it("is the engine's render under its described layers, with the facts and a short alt", async () => {
    const sha256 = await sha256Hex(new Uint8Array([1, 2, 3]));
    const html = canvasSlideHtml({
      src: "/media/r1.png",
      sha256,
      width: 1080,
      height: 1350,
      facts: FACTS,
    });
    expect(html).toContain('<meta name="studio:format" content="1080x1350">');
    expect(html).toContain(`<meta name="studio:render" content="sha256:${sha256}">`);
    expect(html).toContain('<meta name="studio:canvas" content="');
    expect(html).toContain('<link rel="stylesheet" href="/brand/brand.css">');
    expect(html).toContain('alt="Hasat &quot;bitti&quot; &lt;hemen&gt;."');
    const slide = parseSlide(html);
    expect([...slide.entries.values()].map((l) => [l.id, l.type])).toEqual([
      ["canvas", "image"],
      ["headline", "text"],
      ["field-photo", "slot"],
    ]);
    expect(slide.layer("headline")).toMatchObject({ text: 'Hasat "bitti" <hemen>' });
    expect(canvasSlideLayout(FACTS, 1080, 1350).map((b) => b.id)).toEqual([
      "canvas",
      "headline",
      "field-photo",
    ]);
    // Facts that could not be read: the render alone (its checks ask for a new save).
    const bare = canvasSlideHtml({
      src: "/media/r1.png",
      sha256,
      width: 1080,
      height: 1350,
      facts: null,
    });
    expect([...parseSlide(bare).entries.keys()]).toEqual(["canvas"]);
    expect(canvasSlideLayout(null, 1080, 1350)).toHaveLength(1);
  });

  it("changes the content hash with every pixel (the render's SHA-256 is in the HTML)", async () => {
    const make = async (bytes: number[]) => ({
      html: canvasSlideHtml({
        src: "/media/same.png",
        sha256: await sha256Hex(new Uint8Array(bytes)),
        width: 1080,
        height: 1350,
        facts: FACTS,
      }),
      width: 1080,
      height: 1350,
    });
    const a = await computeContentHash([await make([1, 2, 3])]);
    const b = await computeContentHash([await make([1, 2, 4])]);
    expect(a).not.toBe(b);
    expect(await computeContentHash([await make([1, 2, 3])])).toBe(a);
  });
});

describe("the AI on a version saved from the canvas", () => {
  it("is pointed at the HTML version the canvas started from", () => {
    const html = canvasSlideHtml({
      src: "/media/r.png",
      sha256: "a".repeat(64),
      width: 1080,
      height: 1350,
      facts: FACTS,
      sourceVersion: 3,
    });
    expect(canvasOrigin(html)).toEqual({ canvas: true, sourceVersion: 3 });
    expect(canvasOrigin("<html></html>")).toEqual({ canvas: false, sourceVersion: null });
    const ref = postReference(
      { id: "p1", title: "Post" },
      { version: 5, slides: [{ html, width: 1080, height: 1350, renderedAssetId: null }] },
    );
    // The design is the version's Wecra document, edited with the canvas tools (S1): never the
    // HTML the canvas started from. The iPhone sends the same note (CanvasOrigin.referenceNote).
    expect(ref).toBe(
      "“Post” postu (id: p1, güncel sürüm v5) için:\n(v5 Mac'teki tasarım tuvalinde kaydedildi: tasarım bu sürümün Wecra belgesidir, tuvalde elle yapılan değişiklikler onda. Değişikliği canvas_outline ile okuyup canvas_edit ile yap; HTML'den yeniden üretme.)",
    );
    expect(ref).toContain(canvasNote(5));
    expect(ref).not.toContain("HTML'si üzerinden");
    expect(postReference({ id: "p1", title: "Post" }, { version: 2 })).toBe(
      "“Post” postu (id: p1, güncel sürüm v2) için:",
    );
    // An SVG engine version is revised from its SVG, from the chat (Faz 3).
    const svg = postReference(
      { id: "p1", title: "Post" },
      {
        version: 4,
        slides: [
          {
            html: '<!doctype html>\n<html lang="tr" data-studio-engine="svg"><body><svg></svg></body></html>',
            width: 1080,
            height: 1350,
            renderedAssetId: null,
          },
        ],
      },
    );
    expect(svg).toContain(svgNote(4));
    expect(svg).toContain("revise_post");
    // A code engine version is revised from its Python program, from the chat (Faz 4).
    const code = postReference(
      { id: "p1", title: "Post" },
      {
        version: 5,
        slides: [
          {
            html: '<!doctype html>\n<html lang="tr" data-studio-engine="code"><body><img src="/media/a.jpg"></body></html>',
            width: 1080,
            height: 1350,
            renderedAssetId: "a",
          },
        ],
      },
    );
    expect(code).toContain(codeNote(5));
    expect(code).toContain("Python programı");
    expect(code).not.toContain(svgNote(5));
  });
});

describe("Wecra's keys and clipboard (its places only)", () => {
  const key = (target: Element | null) => {
    const e = new KeyboardEvent("keydown", { key: "v", bubbles: true });
    Object.defineProperty(e, "target", { value: target });
    return e;
  };

  it("takes keys from its regions and from nowhere; Studio's own elements keep theirs", () => {
    const region = document.createElement("div");
    region.setAttribute(WECRA_REGION, "canvas");
    const inside = document.createElement("button");
    region.append(inside);
    const studio = document.createElement("textarea");
    const overlays = document.createElement("div");
    overlays.id = "ds-overlays";
    const menu = document.createElement("div");
    overlays.append(menu);
    document.body.append(region, studio, overlays);
    expect(ownsEvent(key(inside))).toBe(true);
    expect(ownsEvent(key(menu))).toBe(true);
    expect(ownsEvent(key(document.body))).toBe(true);
    expect(ownsEvent(key(studio))).toBe(false);
  });

  it("leaves a copy of text selected in Studio's page to the browser", () => {
    const p = document.createElement("p");
    p.textContent = "Sohbetteki metin";
    document.body.append(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const copy = new Event("copy");
    Object.defineProperty(copy, "target", { value: document.body });
    expect(ownsEvent(copy)).toBe(false);
    window.getSelection()?.removeAllRanges();
    expect(ownsEvent(copy)).toBe(true);
  });
});

describe("the AI's scope and the brand kit", () => {
  it("scopes an AI request to the picked layers", () => {
    const describe = (key: string) => ({ slide: 0, id: key, label: "Başlık", kind: "metin" });
    // Wecra's layer ids (what canvas_edit takes), with the layers' names and kinds.
    expect(scopedInstruction("Kısalt", ["1:7"], describe)).toBe(
      "Kapsam: Kare 1 › “Başlık” (metin, id 1:7). Yalnızca bu katmanları değiştir; diğerlerini olduğu gibi bırak.\nKısalt",
    );
    expect(scopedInstruction("Kısalt", [], describe)).toBe("Kısalt");
  });

  it("builds the worker's brand.css from the approved profile, else the neutral default", () => {
    const kit = buildRenderKit(DEMO_PROFILE);
    expect(kit.mode).toBe("approved");
    expect(kit.css).toContain("--color-forest: #2F5D2B");
    expect(kit.fonts).toEqual([
      { role: "display", family: "Avenir Next" },
      { role: "text", family: "Helvetica Neue" },
    ]);
    expect(buildRenderKit({ ...DEMO_PROFILE, status: "draft" }).mode).toBe("neutral");
  });
});
