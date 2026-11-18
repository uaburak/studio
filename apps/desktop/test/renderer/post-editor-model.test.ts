// The post editor's pieces without Wecra's engine: the slide documents the import reads
// (brand.css inlined, /media and /brand mapped), the slide HTML a canvas save stores (the render
// as the one image layer, its hash in the HTML), the brand kit, the AI scope line, and which keys
// and clipboard events are Wecra's (its places) and which are Studio's.
import { computeContentHash } from "@studio/contract";
import { parseSlide } from "@studio/design-kit/document";
import { describe, expect, it } from "vitest";
import { postReference, scopedInstruction } from "../../src/renderer/features/post-editor/chat.ts";
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

describe("a slide saved from the canvas", () => {
  it("is the engine's render as the artboard's one image layer, with its texts as alt", async () => {
    const sha256 = await sha256Hex(new Uint8Array([1, 2, 3]));
    const html = canvasSlideHtml({
      src: "/media/r1.png",
      sha256,
      width: 1080,
      height: 1350,
      text: 'Hasat "bitti" <hemen>',
    });
    expect(html).toContain('<meta name="studio:format" content="1080x1350">');
    expect(html).toContain(`<meta name="studio:render" content="sha256:${sha256}">`);
    expect(html).toContain('alt="Hasat &quot;bitti&quot; &lt;hemen&gt;"');
    const slide = parseSlide(html);
    expect([...slide.entries.values()].map((l) => [l.id, l.type])).toEqual([["canvas", "image"]]);
  });

  it("changes the content hash with every pixel (the render's SHA-256 is in the HTML)", async () => {
    const make = async (bytes: number[]) => ({
      html: canvasSlideHtml({
        src: "/media/same.png",
        sha256: await sha256Hex(new Uint8Array(bytes)),
        width: 1080,
        height: 1350,
        text: "",
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
      text: "",
      sourceVersion: 3,
    });
    expect(canvasOrigin(html)).toEqual({ canvas: true, sourceVersion: 3 });
    expect(canvasOrigin("<html></html>")).toEqual({ canvas: false, sourceVersion: null });
    const ref = postReference(
      { id: "p1", title: "Post" },
      { version: 5, slides: [{ html, width: 1080, height: 1350, renderedAssetId: null }] },
    );
    expect(ref).toContain("“Post” postu (id: p1, v5) için:");
    expect(ref).toContain("v3 HTML'si üzerinden yap");
    expect(postReference({ id: "p1", title: "Post" }, { version: 2 })).toBe(
      "“Post” postu (id: p1, v2) için:",
    );
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
    const describe = (key: string) => ({ slide: 0, id: key, label: "Başlık" });
    expect(scopedInstruction("Kısalt", ["1:7"], describe)).toBe(
      "Kapsam: Kare 1 › 1:7 (Başlık). Yalnızca bu katmanları değiştir; diğerlerini olduğu gibi bırak.\nKısalt",
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
