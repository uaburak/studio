// A post version (design-contract HTML slides) → Wecra layers, once, when a post that has no
// Wecra document yet is opened. Wecra's own importer does the work — the one its agents use to
// turn a web page into layers (capture_web_design): its DOM walker reads each slide as the
// browser laid it out (boxes, fills, borders, radii, shadows, gradients, flex → auto layout,
// text runs with their fonts), its converter makes create_nodes specs, and its create_nodes
// makes the layers in the engine. Studio only renders each slide (as the canvas did: brand.css
// inlined, /brand/ and /media/ mapped) in a hidden frame, and gives the pictures their real
// bytes (Wecra's agents crop them from a screenshot):
//
//   slide i         → a top-level frame "Kare i" (the slide's size, clipped), 120 px apart
//   [data-layer]    → its layer, named after the design's layer id (a text too, when it is
//                     its layer's only text: "headline", "cta" — the names the AI uses)
//   <img>, url()    → an image fill (object-fit cover → FILL, contain → FIT, fill → CROP)
//   inline <svg>    → vector layers (Wecra's SVG import)
//
// Not carried over (CSS the engine has no model for): text-wrap: balance (lines may break
// elsewhere), object-position (pictures are centred), filters on pictures, blend modes.

import {
  foldText,
  prep,
  type Spec,
  stripNotes,
  toSpec,
  type WNode,
} from "@shared/agents/web/convert";
import { runTool, type ToolEnv } from "@/editor/agents/mcpTools";
import type { EditorController } from "@/editor/controller";
import { pageFrames } from "@/editor/exporting";
import { fontOf } from "../../../vendor/wecra-editor/src/main/agents/reach/webSpec";
import { installWalker } from "../../../vendor/wecra-editor/studio/walker.mjs";
import { slideDocument } from "../html/slide-document.ts";
import type { RenderKit } from "../model/brand-kit.ts";

export interface SlideSource {
  html: string;
  width: number;
  height: number;
}

/** Space between slides on the canvas (as before: side by side, 120 apart). */
export const SLIDE_GAP = 120;

export const slideName = (index: number) => `Kare ${index + 1}`;

/** One slide read for import: its create_nodes spec and the font families it uses. */
export interface CapturedSlide {
  index: number;
  width: number;
  height: number;
  spec: Spec;
  fonts: string[];
  /** Pictures that could not be read (left as plain rectangles). */
  missing: string[];
}

const SCALE: Record<string, "FILL" | "FIT" | "CROP"> = {
  cover: "FILL",
  contain: "FIT",
  "scale-down": "FIT",
  fill: "CROP",
  none: "FILL",
};

function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

/** An SVG file drawn into a PNG at twice its shown size (the engine's images are bitmaps). */
async function rasterizeSvg(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = Math.max(1, Math.round(width * 2));
    const h = Math.max(1, Math.round(height * 2));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
    if (!blob) throw new Error("svg");
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** A picture's bytes for create_nodes (`image: { data, scaleMode }`), or null. */
async function pictureArg(
  url: string,
  box: { w: number; h: number },
  fit: string | undefined,
): Promise<{ data: string; scaleMode: string } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "";
    if (
      type.includes("svg") ||
      /^\s*(<\?xml|<svg)/.test(new TextDecoder().decode(bytes.subarray(0, 64)))
    )
      bytes = await rasterizeSvg(bytes, box.w, box.h);
    // A file the browser can't decode would stop Wecra's create_nodes: left out here instead.
    if (typeof createImageBitmap === "function")
      (await createImageBitmap(new Blob([bytes as BlobPart]))).close();
    return { data: base64(bytes), scaleMode: SCALE[fit ?? "cover"] ?? "FILL" };
  } catch {
    return null;
  }
}

const cssUrl = (bgi: string | null | undefined): string | null =>
  /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(bgi ?? "")?.[1] ?? null;

const hasText = (n: WNode): boolean => n.kind === "text" || n.children.some(hasText);

function load(frame: HTMLIFrameElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Kare yüklenemedi (zaman aşımı).")), 15_000);
    frame.addEventListener(
      "load",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** A picture of a slide: the spec that gets it, where its bytes are, how it fits its box. */
export interface SlidePicture {
  spec: Spec;
  url: string;
  box: { w: number; h: number };
  fit: string | undefined;
}

/**
 * A captured slide (Wecra's walker tree) as one create_nodes spec, by Wecra's converter: the
 * frame of the slide with its layers, named after the design's layer ids (`layerOf`: a captured
 * element's `data-layer`); its pictures still to be read (`pictures`).
 */
export function slideSpec(
  tree: WNode,
  layerOf: (elementIndex: number) => string | null,
  index: number,
): { spec: Spec; fonts: string[]; pictures: SlidePicture[] } {
  const fonts = new Set<string>();
  const node = foldText(prep(tree));
  const spec = toSpec(
    node,
    { parentAL: "NONE", px: node.x, py: node.y, depth: 0 },
    {
      font: (css) => {
        const family = fontOf(css);
        fonts.add(family);
        return family;
      },
    },
  );
  if (!spec) throw new Error(`${slideName(index)} boş.`);
  const pictures: SlidePicture[] = [];
  // A text named after its layer when it is that layer's only text (else after its text, as Wecra does).
  const textsOf = new Map<number, number>();
  const count = (s: Spec) => {
    const src = s._?.src;
    if (src?.kind === "text")
      textsOf.set(src.ci as number, (textsOf.get(src.ci as number) ?? 0) + 1);
    for (const c of s.children ?? []) count(c);
  };
  count(spec);
  const visit = (s: Spec) => {
    const src = s._?.src;
    if (src) {
      const layer = layerOf((src.i ?? src.ci ?? -1) as number);
      if (layer && (src.kind !== "text" || textsOf.get(src.ci as number) === 1)) s.name = layer;
      if (src.kind === "svg" && typeof src.svg === "string") {
        // Inline SVG: vector layers (create_nodes' `svg`), at the same place and size.
        s.svg = src.svg;
      } else if (src.kind === "img" && typeof src.src === "string") {
        pictures.push({ spec: s, url: src.src, box: src, fit: src.fit as string | undefined });
      } else if (src.kind === "box" && !hasText(src)) {
        const url = cssUrl(src.bgi);
        if (url) pictures.push({ spec: s, url, box: src, fit: "cover" });
      }
    }
    for (const c of s.children ?? []) visit(c);
  };
  visit(spec);
  return { spec, fonts: [...fonts], pictures };
}

/** Reads the pictures' bytes into their specs; returns the ones that could not be read. */
export async function loadPictures(pictures: readonly SlidePicture[]): Promise<string[]> {
  const missing: string[] = [];
  await Promise.all(
    pictures.map(async (p) => {
      const image = await pictureArg(p.url, p.box, p.fit);
      if (image) p.spec.image = image;
      else missing.push(p.url);
    }),
  );
  return missing;
}

/** The spec create_nodes takes: notes removed, the slide's frame named, placed and clipped. */
export function finishSlide(
  spec: Spec,
  index: number,
  size: { width: number; height: number },
): Spec {
  const clean = stripNotes(spec);
  Object.assign(clean, {
    name: slideName(index),
    x: index * (size.width + SLIDE_GAP),
    y: 0,
    width: size.width,
    height: size.height,
    clipsContent: true,
  });
  return clean;
}

/** Renders one slide in a hidden frame and reads it with Wecra's walker. */
export async function captureSlide(
  slide: SlideSource,
  index: number,
  kit: Pick<RenderKit, "css" | "files">,
): Promise<CapturedSlide> {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${slide.width}px;height:${slide.height}px;border:0;opacity:0;pointer-events:none`;
  const loaded = load(frame);
  frame.srcdoc = slideDocument(slide.html, kit);
  document.body.appendChild(frame);
  try {
    await loaded;
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (!win || !doc) throw new Error("Kare okunamadı.");
    await doc.fonts.ready;
    await Promise.all(Array.from(doc.images, (img) => img.decode().catch(() => {})));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const uikit = installWalker(win) as {
      capture(el: Element, viewportClip: boolean): WNode | null;
      els: Element[];
    };
    const root = doc.querySelector("[data-artboard]") ?? doc.body;
    const tree = uikit.capture(root, false);
    if (!tree) throw new Error(`${slideName(index)} boş.`);
    const els = uikit.els;
    // The artboard draws the slide's background even when the design leaves it to brand.css.
    if (tree.c && !tree.c.bg) {
      const bg = win.getComputedStyle(doc.body).backgroundColor;
      tree.c.bg = /^rgba?\(/.test(bg) && !/,\s*0\)$/.test(bg) ? bg : "#ffffff";
    }
    const size = { width: slide.width, height: slide.height };
    const { spec, fonts, pictures } = slideSpec(
      tree,
      (i) => els[i]?.getAttribute?.("data-layer") ?? null,
      index,
    );
    for (const p of pictures) p.url = new URL(p.url, doc.baseURI).href;
    const missing = await loadPictures(pictures);
    return { index, ...size, spec: finishSlide(spec, index, size), fonts, missing };
  } finally {
    frame.remove();
  }
}

const hasImage = (s: Spec): boolean => !!s.image || (s.children ?? []).some(hasImage);
const withoutImages = (s: Spec): Spec => {
  const { image: _image, children, ...rest } = s;
  return { ...rest, ...(children ? { children: children.map(withoutImages) } : {}) } as Spec;
};

/** Every slide, in order. */
export async function captureSlides(
  slides: readonly SlideSource[],
  kit: Pick<RenderKit, "css" | "files">,
): Promise<CapturedSlide[]> {
  const out: CapturedSlide[] = [];
  for (const [i, s] of slides.entries()) out.push(await captureSlide(s, i, kit));
  return out;
}

/**
 * Makes the captured slides' layers on the editor's page with Wecra's create_nodes — outside the
 * undo history (the import is where the document starts, not an edit). Returns the slide frames
 * in reading order.
 */
export async function importSlides(
  ed: EditorController,
  captured: readonly CapturedSlide[],
): Promise<{ ref: string; name: string }[]> {
  const env: ToolEnv = { ed, write: (_label, fn) => ed.engine.ignoringUndo(fn) };
  const create = (nodes: Spec[]) =>
    runTool(env, "create_nodes", { parentId: ed.store.page, nodes });
  // The last slide first: the first is on top in Layers ("Kare 1" first, as the post reads).
  const specs = [...captured].reverse().map((c) => c.spec);
  let result = await create(specs);
  // A picture Wecra could not take fails the whole call: the slides again, without pictures.
  if (result.isError && captured.some((c) => hasImage(c.spec))) {
    result = await create(specs.map(withoutImages));
    for (const c of captured) c.missing.push("(görseller)");
  }
  if (result.isError) {
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    throw new Error(`Wecra katmanları oluşturamadı: ${text.slice(0, 300)}`);
  }
  return pageFrames(ed);
}
