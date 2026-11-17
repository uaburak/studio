// Slide HTML, read without rendering or executing it (an inert DOMParser document): the image
// slots and the editable `[data-layer]` elements of the design contract, the editor transform
// a layer carries, design-kit patch ops for `content.render`, and the canvas geometry.
// Port of StudioKit's Slots.swift, SlideLayers.swift and DesignPatch.swift.
import type { Slide, SlideLayerBox } from "@studio/contract";

// --- parsing ---------------------------------------------------------------------------------

function parse(html: string): Document | null {
  if (typeof DOMParser === "undefined") return null;
  return new DOMParser().parseFromString(html, "text/html");
}

// --- image slots ------------------------------------------------------------------------------

export type SlotState = "empty" | "filled" | "unknown";

export interface ImageSlot {
  slideIndex: number;
  layerId: string | null;
  state: SlotState;
  /** "4:5" as declared. */
  ratio: string | null;
  label: string | null;
}

function slotState(value: string | null): SlotState {
  const v = value?.toLowerCase();
  return v === "empty" || v === "filled" ? v : "unknown";
}

export function slotsInHtml(html: string, slideIndex = 0): ImageSlot[] {
  const doc = parse(html);
  if (!doc) return [];
  return Array.from(doc.querySelectorAll("[data-type]"))
    .filter((el) => el.getAttribute("data-type")?.toLowerCase() === "slot")
    .map((el) => ({
      slideIndex,
      layerId: el.getAttribute("data-layer"),
      state: slotState(el.getAttribute("data-slot-state")),
      ratio: el.getAttribute("data-slot-ratio"),
      label: el.getAttribute("data-slot-label"),
    }));
}

export function slotsIn(slides: readonly Pick<Slide, "html">[]): ImageSlot[] {
  return slides.flatMap((slide, index) => slotsInHtml(slide.html, index));
}

// --- layers -----------------------------------------------------------------------------------

export type LayerKind = "text" | "image" | "slot" | "logo" | "shape" | "group" | "other";

export const LAYER_KIND_LABEL: Record<LayerKind, string> = {
  text: "Metin",
  image: "Görsel",
  slot: "Görsel yuvası",
  logo: "Logo",
  shape: "Şekil",
  group: "Grup",
  other: "Katman",
};

export interface LayerTransform {
  /** Artboard px. */
  translate: { x: number; y: number };
  scale: number;
}

export const IDENTITY: LayerTransform = { translate: { x: 0, y: 0 }, scale: 1 };

export function isIdentity(t: LayerTransform): boolean {
  return t.translate.x === 0 && t.translate.y === 0 && t.scale === 1;
}

export interface SlideLayer {
  /** `"<slide>:<layer>"`, unique across slides. */
  key: string;
  slideIndex: number;
  layerId: string;
  kind: LayerKind;
  tagName: string;
  role: string | null;
  /** Plain text of a text layer (`<br>` → `\n`). */
  text: string;
  src: string | null;
  slotLabel: string | null;
  slotState: SlotState | null;
  hidden: boolean;
  style: string | null;
  /** The inline `color` (text layers), as written. */
  color: string | null;
  transform: LayerTransform;
}

function inferKind(declared: string | null, tagName: string): LayerKind {
  const d = declared?.toLowerCase();
  switch (d) {
    case "text":
    case "image":
    case "slot":
    case "logo":
    case "shape":
    case "group":
      return d;
  }
  switch (tagName) {
    case "img":
      return "image";
    case "svg":
      return "shape";
    case "figure":
      return "slot";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
    case "p":
    case "span":
    case "blockquote":
    case "li":
      return "text";
    default:
      return "other";
  }
}

function isHidden(el: Element): boolean {
  for (const name of ["data-hidden", "hidden"]) {
    if (el.hasAttribute(name) && el.getAttribute(name)?.toLowerCase() !== "false") return true;
  }
  const style = (el.getAttribute("style") ?? "").toLowerCase().replace(/\s/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/** Text as the editor shows it: text nodes and `<br>` line breaks. */
function plainText(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) out += child.textContent ?? "";
    else if (child.nodeType === 1) {
      out += (child as Element).tagName.toLowerCase() === "br" ? "\n" : plainText(child);
    }
  }
  return out;
}

/** `translate: 12px -8px; scale: 1.1` → the transform (missing parts are the identity). */
export function parseLayerTransform(style: string | null | undefined): LayerTransform {
  const result: LayerTransform = { translate: { x: 0, y: 0 }, scale: 1 };
  if (!style) return result;
  for (const declaration of style.split(";")) {
    const at = declaration.indexOf(":");
    if (at < 0) continue;
    const name = declaration.slice(0, at).trim().toLowerCase();
    const values = declaration
      .slice(at + 1)
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    const px = (token: string | undefined) => {
      const n = Number.parseFloat((token ?? "").replace(/px$/, ""));
      return Number.isFinite(n) ? n : 0;
    };
    if (name === "translate") result.translate = { x: px(values[0]), y: px(values[1]) };
    if (name === "scale") {
      const s = Number.parseFloat(values[0] ?? "");
      if (Number.isFinite(s)) result.scale = s;
    }
  }
  return result;
}

/** The value of one declaration in an inline style (`color`). */
export function styleValue(style: string | null | undefined, property: string): string | null {
  if (!style) return null;
  for (const declaration of style.split(";")) {
    const at = declaration.indexOf(":");
    if (at < 0) continue;
    if (declaration.slice(0, at).trim().toLowerCase() === property) {
      return declaration.slice(at + 1).trim() || null;
    }
  }
  return null;
}

export function layersInHtml(html: string, slideIndex = 0): SlideLayer[] {
  const doc = parse(html);
  if (!doc) return [];
  return Array.from(doc.querySelectorAll("[data-layer]")).flatMap((el) => {
    const layerId = el.getAttribute("data-layer");
    if (!layerId) return [];
    const tagName = el.tagName.toLowerCase();
    const kind = inferKind(
      el.getAttribute("data-type") ?? el.getAttribute("data-layer-type"),
      tagName,
    );
    const style = el.getAttribute("style");
    let src = el.getAttribute("src");
    if (!src && kind === "slot") src = el.querySelector("img[src]")?.getAttribute("src") ?? null;
    return [
      {
        key: `${slideIndex}:${layerId}`,
        slideIndex,
        layerId,
        kind,
        tagName,
        role: el.getAttribute("data-role"),
        text: kind === "text" ? plainText(el) : "",
        src: src || null,
        slotLabel: el.getAttribute("data-slot-label"),
        slotState: kind === "slot" ? slotState(el.getAttribute("data-slot-state")) : null,
        hidden: isHidden(el),
        style,
        color: styleValue(style, "color"),
        transform: parseLayerTransform(style),
      },
    ];
  });
}

/** Layers worth listing in the editor: text, pictures, slots, logos and shapes. */
export function editableLayers(layers: SlideLayer[]): SlideLayer[] {
  return layers.filter((l) => l.kind !== "group" && l.kind !== "other");
}

// --- design-kit patches (content.render `patches`) ----------------------------------------------

export type ColorProperty = "color" | "background-color";

export type DesignPatch =
  | { slide: number; op: "setText"; layer: string; text: string }
  | { slide: number; op: "setVisibility"; layer: string; hidden: boolean }
  | {
      slide: number;
      op: "transform";
      layer: string;
      translate: { x: number; y: number } | null;
      scale: number | null;
    }
  | {
      slide: number;
      op: "setColor";
      layer: string;
      property: ColorProperty;
      value: { literal: string } | null;
    }
  | { slide: number; op: "replaceImage"; layer: string; src: string }
  | { slide: number; op: "fillSlot"; layer: string; src: string }
  | { slide: number; op: "clearSlot"; layer: string };

/** Artboard px with one decimal, clamped to what design-kit accepts. */
export function roundPx(value: number): number {
  const clamped = Math.min(10_000, Math.max(-10_000, value));
  return Math.round(clamped * 10) / 10;
}

/** The absolute transform as a patch (zero translate / scale 1 remove them). */
export function transformPatch(slide: number, layer: string, t: LayerTransform): DesignPatch {
  const x = roundPx(t.translate.x);
  const y = roundPx(t.translate.y);
  const s = Math.round(t.scale * 1000) / 1000;
  return {
    slide,
    op: "transform",
    layer,
    translate: x === 0 && y === 0 ? null : { x, y },
    scale: s === 1 ? null : s,
  };
}

export function patchLabel(patch: DesignPatch): string {
  switch (patch.op) {
    case "setText":
      return "Metni değiştir";
    case "setVisibility":
      return patch.hidden ? "Katmanı gizle" : "Katmanı göster";
    case "transform":
      return "Taşı ve boyutlandır";
    case "setColor":
      return "Rengi değiştir";
    case "replaceImage":
      return "Görseli değiştir";
    case "fillSlot":
      return "Yuvayı doldur";
    case "clearSlot":
      return "Yuvayı boşalt";
  }
}

/** `/media/<assetId><ext>`: the contract's path of an uploaded picture. */
export function mediaSource(assetId: string, mimeType: string | null | undefined): string {
  const ext =
    {
      "image/png": ".png",
      "image/webp": ".webp",
      "image/gif": ".gif",
      "image/avif": ".avif",
    }[mimeType?.toLowerCase() ?? ""] ?? ".jpg";
  return `/media/${encodeURIComponent(assetId)}${ext}`;
}

/** `#RRGGBB` for a colour input from a CSS colour (hex only; others fall back). */
export function hexColor(value: string | null | undefined, fallback = "#ffffff"): string {
  const v = value?.trim() ?? "";
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    return `#${v
      .slice(1)
      .split("")
      .map((c) => c + c)
      .join("")}`.toLowerCase();
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(v);
  if (rgb) {
    return `#${[rgb[1], rgb[2], rgb[3]]
      .map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return fallback;
}

// --- geometry ---------------------------------------------------------------------------------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function boxOf(layer: SlideLayerBox): Box {
  return { x: layer.x, y: layer.y, w: layer.w, h: layer.h };
}

function contains(box: Box, x: number, y: number): boolean {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

/**
 * The topmost selectable layer under an artboard point: the smallest visible box that holds
 * it (backgrounds and the groups around a layer lose to the layer).
 */
export function hitTest(
  x: number,
  y: number,
  boxes: readonly SlideLayerBox[],
  skip: ReadonlySet<string> = new Set(),
): SlideLayerBox | null {
  let best: SlideLayerBox | null = null;
  for (const b of boxes) {
    if (!b.visible || b.w <= 0 || b.h <= 0 || skip.has(b.id) || !contains(b, x, y)) continue;
    if (!best) {
      best = b;
      continue;
    }
    const a = b.w * b.h;
    const c = best.w * best.h;
    if (a < c || (a === c && b.role !== "background" && best.role === "background")) best = b;
  }
  return best;
}

export function moved(current: LayerTransform, dx: number, dy: number): LayerTransform {
  return {
    translate: { x: current.translate.x + dx, y: current.translate.y + dy },
    scale: current.scale,
  };
}

/**
 * Resizing a box (measured, transforms included) by `factor` with its top-left corner fixed.
 * CSS `scale` grows around the centre, so the translate compensates.
 */
export function resized(current: LayerTransform, box: Box, factor: number): LayerTransform {
  const k = Math.max(0.05, factor);
  const scale = Math.min(20, Math.max(0.05, current.scale * k));
  const applied = current.scale === 0 ? k : scale / current.scale;
  return {
    translate: {
      x: current.translate.x + (box.w * (applied - 1)) / 2,
      y: current.translate.y + (box.h * (applied - 1)) / 2,
    },
    scale,
  };
}

/** Where a box ends up after a transform change (the live outline while it renders). */
export function previewBox(box: Box, from: LayerTransform, to: LayerTransform): Box {
  const k = from.scale === 0 ? 1 : to.scale / from.scale;
  const cx = box.x + box.w / 2 + (to.translate.x - from.translate.x);
  const cy = box.y + box.h / 2 + (to.translate.y - from.translate.y);
  const w = box.w * k;
  const h = box.h * k;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** "4:5", "1:1", "9:16" for an artboard. */
export function aspectLabel(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "";
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(Math.round(width), Math.round(height));
  return `${Math.round(width) / g}:${Math.round(height) / g}`;
}
