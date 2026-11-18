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
//                     its layer's only text: "headline", "cta" — the names the AI uses), its
//                     type, role, slot and picture file kept on it as plugin data (markLayers)
//   <img>, url()    → an image paint placed as the browser drew it (object-fit and
//                     object-position, background-size and -position: Fill, Fit or a Crop
//                     window); an SVG <img> → vector layers (a logo's marked `vector`: the
//                     checks still know it as the brand's logo by its file)
//   inline <svg>    → vector layers (Wecra's SVG import)
//
// Between Wecra's converter and create_nodes, `fidelity.ts` puts back what the converter leaves
// out (gradients at any angle, radial and conic; transforms; z-index; text shadows; filters,
// blend modes, clip paths; balanced lines) from what `capture.ts` read next to the walker, and
// lists what Wecra's document can't hold — the import report (`CapturedSlide.report`), which the
// canvas shows when the post is first opened.

import {
  foldText,
  prep,
  type Spec,
  stripNotes,
  toSpec,
  type WNode,
} from "@shared/agents/web/convert";
import type { CanvasMark } from "@studio/design-kit/canvas";
import { runTool, type ToolEnv } from "@/editor/agents/mcpTools";
import type { EditorController } from "@/editor/controller";
import { pageFrames } from "@/editor/exporting";
import { svgToMessage } from "@/editor/model/svgImport";
import { fontOf } from "../../../vendor/wecra-editor/src/main/agents/reach/webSpec";
import { installWalker } from "../../../vendor/wecra-editor/studio/walker.mjs";
import { slideDocument } from "../html/slide-document.ts";
import type { RenderKit } from "../model/brand-kit.ts";
import {
  type CaptureResult,
  captureInWindow,
  type ElementExtras,
  type InstallWalker,
} from "./capture.ts";
import { LAYER_KEY, STUDIO_PLUGIN } from "./facts.ts";
import { enrichSlide, type ImportChange, PICTURE_KEY, type PicturePlan } from "./fidelity.ts";

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
  /** The slide's contract layers (kept on their Wecra layers: slots, logos, roles survive). */
  marks?: LayerMark[];
  /** Its pictures (`{ type: "IMAGE", __picture: k }` in the spec's fills), with their bytes. */
  pictures?: PicturePlan[];
  /** What the import changed or could not carry over (fidelity.ts). */
  report?: ImportChange[];
}

/**
 * A contract layer of a slide (`data-layer` with its type, role, picture file and slot
 * attributes), kept on its Wecra layer as plugin data (`studio` / `layer`), so a canvas save
 * still knows it (`facts.ts`): Wecra's layers have no image slots, logos or roles of their own.
 * The picture's Wecra image key is added when it is kept (`image`: still that file?).
 */
export type LayerMark = Omit<CanvasMark, "image">;

/** The contract layers of a slide's HTML, in document order. */
export function layerMarks(html: string): LayerMark[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("[data-layer]")).flatMap((el): LayerMark[] => {
    const layer = el.getAttribute("data-layer") ?? "";
    if (!layer) return [];
    const type = el.getAttribute("data-type") ?? "";
    const img = el.tagName === "IMG" ? el : el.querySelector("img[data-slot-image]");
    const attr = (name: string, max: number) => el.getAttribute(name)?.slice(0, max) ?? null;
    return [
      {
        layer: layer.slice(0, 64),
        type: type.slice(0, 16),
        role: attr("data-role", 32),
        src: img?.getAttribute("src")?.slice(0, 500) ?? null,
        allowOverlap: el.hasAttribute("data-allow-overlap"),
        slot:
          type === "slot"
            ? {
                ratio: attr("data-slot-ratio", 16),
                label: attr("data-slot-label", 200),
                fit: attr("data-slot-fit", 16),
              }
            : null,
      },
    ];
  });
}

type MarkedNode = {
  guid: string;
  name?: string;
  type?: string;
  fillPaints?: { type?: string; visible?: boolean; image?: { hash?: ArrayLike<number> } }[];
  pluginData?: { pluginID?: string; key?: string; value?: string }[];
  childIds?: string[];
};

const imageKeyOf = (n: MarkedNode | undefined): string | null => {
  const p = [...(n?.fillPaints ?? [])]
    .reverse()
    .find((x) => x.type === "IMAGE" && x.visible !== false);
  const h = p?.image?.hash;
  return h && h.length === 20
    ? Array.from(h, (b) => (b & 0xff).toString(16).padStart(2, "0")).join("")
    : null;
};

/**
 * Keeps each mark on the Wecra layer the import named after it (a text mark on the text, any
 * other on the box), with the picture's image key as imported. Outside the undo history.
 */
export function markLayers(ed: EditorController, frame: string, marks: readonly LayerMark[]): void {
  if (!marks.length) return;
  const nodes = ed.engine.readNodes([frame], {
    subtree: true,
    childIds: true,
    fields: ["name", "type", "fillPaints", "pluginData"],
  }) as unknown as MarkedNode[];
  const byId = new Map(nodes.map((n) => [n.guid, n]));
  const firstImage = (id: string): string | null => {
    const n = byId.get(id);
    const own = imageKeyOf(n);
    if (own) return own;
    for (const c of n?.childIds ?? []) {
      const k = firstImage(c);
      if (k) return k;
    }
    return null;
  };
  const taken = new Set<string>();
  ed.engine.ignoringUndo(() => {
    for (const mark of marks) {
      const named = nodes.filter(
        (n) => n.guid !== frame && n.name === mark.layer && !taken.has(n.guid),
      );
      const node =
        mark.type === "text"
          ? (named.find((n) => n.type === "TEXT") ?? named[0])
          : (named.find((n) => n.type !== "TEXT") ?? named[0]);
      if (!node) continue;
      taken.add(node.guid);
      const value: CanvasMark = { ...mark, image: firstImage(node.guid) };
      const others = (node.pluginData ?? []).filter(
        (e) => !(e.pluginID === STUDIO_PLUGIN && e.key === LAYER_KEY),
      );
      ed.engine.setProps([node.guid], {
        pluginData: [
          ...others,
          { pluginID: STUDIO_PLUGIN, key: LAYER_KEY, value: JSON.stringify(value) },
        ],
      } as never);
    }
  });
}

/** An SVG file's text when `bytes` are one (by type or by its first bytes), else null. */
function svgText(bytes: Uint8Array, type: string): string | null {
  const start = new TextDecoder().decode(bytes.subarray(0, 256));
  if (!type.includes("svg") && !/^\s*(<\?xml|<!--|<svg)/.test(start)) return null;
  const text = new TextDecoder().decode(bytes);
  return /<svg[\s>]/.test(text) ? text : null;
}

/** preserveAspectRatio for an SVG picture's object-fit. */
const ASPECT: Record<string, string> = {
  cover: "xMidYMid slice",
  contain: "xMidYMid meet",
  "scale-down": "xMidYMid meet",
  fill: "none",
  none: "xMidYMid meet",
};

/**
 * An SVG picture as vector markup the size of its box (its viewBox kept, fitted as object-fit
 * says), or null when Wecra's SVG import draws nothing from it.
 */
export function sizedSvg(text: string, box: { w: number; h: number }, fit?: string): string | null {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const svg = doc.documentElement;
  if (svg?.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
  const w = Number.parseFloat(svg.getAttribute("width") ?? "");
  const h = Number.parseFloat(svg.getAttribute("height") ?? "");
  if (!svg.getAttribute("viewBox") && w > 0 && h > 0) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", String(Math.round(box.w * 100) / 100));
  svg.setAttribute("height", String(Math.round(box.h * 100) / 100));
  svg.setAttribute("preserveAspectRatio", ASPECT[fit ?? "contain"] ?? "xMidYMid meet");
  const markup = new XMLSerializer().serializeToString(svg);
  try {
    return svgToMessage(markup).message?.nodeChanges.length ? markup : null;
  } catch {
    return null;
  }
}

/** An SVG drawn into a PNG at `scale` × its shown size (a logo: the checks know it as a picture). */
async function rasterizeSvg(
  bytes: Uint8Array,
  width: number,
  height: number,
  scale: number,
): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
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

/** An SVG drawn as a bitmap (a logo's that Wecra's SVG import can't take: this many times its
 * shown size, crisp when the canvas zooms in; an SVG background twice). */
const LOGO_SVG_SCALE = 4;

/** Reads one picture's bytes into it (an SVG: vectors, or a logo's 4× bitmap); false: unreadable. */
async function readPicture(
  p: PicturePlan,
  onPicture: PictureListener | undefined,
  fetchFile: (url: string) => Promise<Response>,
): Promise<boolean> {
  try {
    const res = await fetchFile(p.url);
    if (!res.ok) return false;
    let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
    const svg = svgText(bytes, res.headers.get("content-type") ?? "");
    if (svg) {
      // An SVG picture (a logo too) becomes its vectors; a background, or an SVG Wecra's SVG
      // import draws nothing from, a bitmap.
      if (p.kind === "img") {
        const markup = sizedSvg(svg, p.box, p.fit);
        if (markup) {
          p.svg = markup;
          return true;
        }
      }
      bytes = await rasterizeSvg(bytes, p.box.w, p.box.h, p.type === "logo" ? LOGO_SVG_SCALE : 2);
    } else onPicture?.(p.url, bytes);
    // A file the browser can't decode would stop Wecra's create_nodes: left out here instead.
    if (typeof createImageBitmap === "function")
      (await createImageBitmap(new Blob([bytes as BlobPart]))).close();
    p.bytes = bytes;
    return true;
  } catch {
    return false;
  }
}

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

/** A picture of a slide: its URL, where it goes and how it fills its layer (fidelity.ts). */
export type SlidePicture = PicturePlan;

/**
 * A captured slide (Wecra's walker tree) as one create_nodes spec, by Wecra's converter: the
 * frame of the slide with its layers, named after the design's layer ids (`layerOf`: a captured
 * element's `data-layer`), with what the converter leaves out put back from `extras`
 * (capture.ts; none: what the walker's tree alone says) — `report` lists what couldn't be; its
 * pictures still to be read (`pictures`).
 */
export function slideSpec(
  tree: WNode,
  layerOf: (elementIndex: number) => string | null,
  index: number,
  extras: readonly ElementExtras[] = [],
): { spec: Spec; fonts: string[]; pictures: PicturePlan[]; report: ImportChange[] } {
  const fonts = new Set<string>();
  const font = (css: string | undefined) => {
    const family = fontOf(css);
    fonts.add(family);
    return family;
  };
  const node = foldText(prep(tree));
  const spec = toSpec(node, { parentAL: "NONE", px: node.x, py: node.y, depth: 0 }, { font });
  if (!spec) throw new Error(`${slideName(index)} boş.`);
  const pictures: PicturePlan[] = [];
  const report: ImportChange[] = [];
  enrichSlide(spec, { slide: index, extras, pictures, report, layerOf }, (css) => font(css));
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
      // Inline SVG: vector layers (create_nodes' `svg`), at the same place and size.
      if (src.kind === "svg" && typeof src.svg === "string") s.svg = src.svg;
    }
    for (const c of s.children ?? []) visit(c);
  };
  visit(spec);
  return { spec, fonts: [...fonts], pictures, report };
}

/** A picture's bytes as read for the import (its URL, the file's bytes). */
export type PictureListener = (url: string, bytes: Uint8Array) => void;

/** Reads the pictures' bytes into them; returns the ones that could not be read. */
export async function loadPictures(
  pictures: readonly PicturePlan[],
  onPicture?: PictureListener,
  fetchFile: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<string[]> {
  const missing: string[] = [];
  await Promise.all(
    pictures.map(async (p) => {
      if (!(await readPicture(p, onPicture, fetchFile))) missing.push(p.url);
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

/** A slide as `captureInWindow` read it → its spec, fonts, pictures and import report. */
export function slideFromCapture(
  captured: CaptureResult,
  index: number,
): { spec: Spec; fonts: string[]; pictures: PicturePlan[]; report: ImportChange[] } {
  const { tree, extras, bodyBackground } = captured;
  if (!tree) throw new Error(`${slideName(index)} boş.`);
  // The artboard draws the slide's background even when the design leaves it to brand.css.
  if (tree.c && !tree.c.bg) {
    const bg = bodyBackground;
    tree.c.bg = /^rgba?\(/.test(bg) && !/,\s*0\)$/.test(bg) ? bg : "#ffffff";
  }
  return slideSpec(tree, (i) => extras[i]?.own ?? null, index, extras);
}

/**
 * Reads a slide in a window (the hidden frame here; the fidelity test's Chromium page runs the
 * same `captureInWindow`) with Wecra's walker and Studio's extras (capture.ts): its spec.
 */
export async function readSlide(
  win: Window,
  root: Element,
  index: number,
  install: InstallWalker = installWalker,
): Promise<{ spec: Spec; fonts: string[]; pictures: PicturePlan[]; report: ImportChange[] }> {
  return slideFromCapture(await captureInWindow(win, install, root), index);
}

/** Renders one slide in a hidden frame and reads it with Wecra's walker. */
export async function captureSlide(
  slide: SlideSource,
  index: number,
  kit: Pick<RenderKit, "css" | "files">,
  onPicture?: PictureListener,
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
    const root = doc.querySelector("[data-artboard]") ?? doc.body;
    const size = { width: slide.width, height: slide.height };
    const { spec, fonts, pictures, report } = await readSlide(win, root, index);
    for (const p of pictures) p.url = new URL(p.url, doc.baseURI).href;
    const missing = await loadPictures(pictures, onPicture);
    return {
      index,
      ...size,
      spec: finishSlide(spec, index, size),
      fonts,
      missing,
      marks: vectorLogos(layerMarks(slide.html), pictures),
      pictures,
      report,
    };
  } finally {
    frame.remove();
  }
}

/** Logos whose SVG became vectors, marked so (the checks still know them as the brand's logo). */
export function vectorLogos(marks: LayerMark[], pictures: readonly PicturePlan[]): LayerMark[] {
  const vectors = new Set(pictures.filter((p) => p.svg && p.type === "logo").map((p) => p.layer));
  return marks.map((m) => (m.type === "logo" && vectors.has(m.layer) ? { ...m, vector: true } : m));
}

/** Every slide, in order (`onPicture`: each picture file read, for the save's dedupe). */
export async function captureSlides(
  slides: readonly SlideSource[],
  kit: Pick<RenderKit, "css" | "files">,
  options: { onPicture?: PictureListener } = {},
): Promise<CapturedSlide[]> {
  const out: CapturedSlide[] = [];
  for (const [i, s] of slides.entries()) out.push(await captureSlide(s, i, kit, options.onPicture));
  return out;
}

/** A picture's bytes in the document's images (Wecra's ImageManager by default). */
export type ImportImage = (
  bytes: Uint8Array,
  name: string,
) => Promise<{ hash: string; width: number; height: number } | null>;

const sniffMime = (b: Uint8Array): string =>
  b[0] === 0x89 && b[1] === 0x50
    ? "image/png"
    : b[0] === 0xff && b[1] === 0xd8
      ? "image/jpeg"
      : b[0] === 0x47 && b[1] === 0x49
        ? "image/gif"
        : b[0] === 0x52 && b[1] === 0x49
          ? "image/webp"
          : "application/octet-stream";

function defaultImport(ed: EditorController): ImportImage {
  return async (bytes, name) => {
    const mime = sniffMime(bytes);
    const file = new File([bytes as BlobPart], `${name}.${mime.split("/")[1] ?? "bin"}`, {
      type: mime,
    });
    const [img] = await ed.images.import([file]);
    return img ? { hash: img.hash, width: img.width, height: img.height } : null;
  };
}

/**
 * The slide's picture placeholders resolved: an image paint on the document's image (Fill / Fit /
 * Crop with its window), a vector SVG in place of its layer, or left out (unreadable).
 */
async function resolvePictures(
  spec: Spec,
  pictures: readonly PicturePlan[],
  importImage: ImportImage,
  missing: string[],
): Promise<void> {
  const hashes = await Promise.all(
    pictures.map(async (p) => {
      if (!p.bytes) return null;
      try {
        return await importImage(
          p.bytes,
          (p.url.split("/").pop() ?? "görsel").replace(/\.[^.]+$/, ""),
        );
      } catch {
        return null;
      }
    }),
  );
  const visit = (s: Spec) => {
    if (Array.isArray(s.fills)) {
      const fills: unknown[] = [];
      for (const f of s.fills as unknown[]) {
        const k =
          f && typeof f === "object" ? (f as Record<string, unknown>)[PICTURE_KEY] : undefined;
        if (typeof k !== "number") {
          fills.push(f);
          continue;
        }
        const p = pictures[k];
        const img = hashes[k];
        if (p?.svg && !(s.children ?? []).length && (s.fills as unknown[]).length === 1) {
          // The layer becomes the SVG's vectors (a frame its size), where it was.
          s.svg = p.svg;
          for (const key of ["fills", "cornerRadius", "type"]) delete s[key];
          return;
        }
        if (!p || !img) {
          if (p && !p.svg && !missing.includes(p.url)) missing.push(p.url);
          continue;
        }
        fills.push({
          type: "IMAGE",
          imageRef: img.hash,
          scaleMode: p.scaleMode,
          ...(p.transform && p.scaleMode === "CROP" ? { transform: p.transform } : {}),
          ...(p.blendMode ? { blendMode: p.blendMode } : {}),
        });
      }
      s.fills = fills;
    }
    for (const c of s.children ?? []) visit(c);
  };
  visit(spec);
}

const hasImage = (s: Spec): boolean =>
  (Array.isArray(s.fills) &&
    (s.fills as unknown[]).some(
      (f) => !!f && typeof f === "object" && (f as { type?: string }).type === "IMAGE",
    )) ||
  (s.children ?? []).some(hasImage);
const withoutImages = (s: Spec): Spec => {
  const { children, ...rest } = s;
  const fills = Array.isArray(rest.fills)
    ? (rest.fills as unknown[]).filter(
        (f) => !(f && typeof f === "object" && (f as { type?: string }).type === "IMAGE"),
      )
    : rest.fills;
  return {
    ...rest,
    ...(fills !== undefined ? { fills } : {}),
    ...(children ? { children: children.map(withoutImages) } : {}),
  } as Spec;
};

/**
 * Makes the captured slides' layers on the editor's page with Wecra's create_nodes — outside the
 * undo history (the import is where the document starts, not an edit). Their pictures go into
 * the document's images first (`importImage`: Wecra's own import by default). Returns the slide
 * frames in reading order.
 */
export async function importSlides(
  ed: EditorController,
  captured: readonly CapturedSlide[],
  options: { importImage?: ImportImage } = {},
): Promise<{ ref: string; name: string }[]> {
  const importImage = options.importImage ?? defaultImport(ed);
  for (const c of captured) await resolvePictures(c.spec, c.pictures ?? [], importImage, c.missing);
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
  const frames = pageFrames(ed);
  // The contract's meaning of each layer (slots, logos, roles) stays on its Wecra layer.
  for (const c of captured) {
    const frame = frames[c.index];
    if (frame && c.marks?.length) markLayers(ed, frame.ref, c.marks);
  }
  return frames;
}
