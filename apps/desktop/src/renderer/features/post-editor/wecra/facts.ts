// A slide frame of the open Wecra document as canvas facts (`@studio/design-kit/canvas`): every
// layer in paint order with its place in the slide (the frame's top-left is 0,0), rotation,
// opacity and visibility; texts with their characters, fonts, sizes, colours, alignment and the
// lines Wecra's text engine laid out (overflow, truncation, missing fonts as the engine reports
// them); fills and strokes (pictures by Wecra's image key, with their fit); the contract meaning
// the import gave a layer (`studio` / `layer` plugin data: image slots, logos, roles); the
// fonts the slide uses. Read straight from Wecra's engine (`readNodes`, `textLayout`,
// `documentFonts`), synchronously: a save that runs as the post closes reads it before the
// editor goes. The slide HTML of a canvas save carries it (`canvasSlideHtml`).
import {
  CANVAS_FACTS_VERSION,
  CanvasFacts,
  CanvasMark,
  type CanvasNode,
  type CanvasPaint,
  type CanvasRect,
  type CanvasText,
  type CanvasTextRun,
  fitCanvasFacts,
} from "@studio/design-kit/canvas";
import type { EditorController } from "@/editor/controller";

/** Where the import keeps a layer's contract meaning (Wecra plugin data, kept by copy / paste). */
export const STUDIO_PLUGIN = "studio";
export const LAYER_KEY = "layer";

type Matrix = { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
type Color = { r?: number; g?: number; b?: number; a?: number };
type RawPaint = {
  type?: string;
  color?: Color;
  opacity?: number;
  visible?: boolean;
  stops?: { color?: Color; position?: number }[];
  image?: { hash?: ArrayLike<number> | string };
  imageScaleMode?: string;
  originalImageWidth?: number;
  originalImageHeight?: number;
};
type RawStyle = {
  styleID?: number;
  fontName?: { family?: string; style?: string };
  fontSize?: number;
  fillPaints?: RawPaint[];
};
type RawNode = RawStyle & {
  guid: string;
  name?: string;
  type?: string;
  visible?: boolean;
  opacity?: number;
  transform?: Matrix;
  size?: { x: number; y: number };
  strokePaints?: RawPaint[];
  strokeWeight?: number;
  textData?: { characters?: string; characterStyleIDs?: number[]; styleOverrideTable?: RawStyle[] };
  lineHeight?: { value?: number; units?: string };
  letterSpacing?: { value?: number; units?: string };
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textAutoResize?: string;
  frameMaskDisabled?: boolean;
  pluginData?: { pluginID?: string; key?: string; value?: string }[];
  childIds?: string[];
};

const FIELDS = [
  "name",
  "type",
  "visible",
  "opacity",
  "transform",
  "size",
  "fillPaints",
  "strokePaints",
  "strokeWeight",
  "textData",
  "fontName",
  "fontSize",
  "lineHeight",
  "letterSpacing",
  "textAlignHorizontal",
  "textAlignVertical",
  "textAutoResize",
  "frameMaskDisabled",
  "pluginData",
];

const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
const MAX_NODES = 2_000;
const FRAMEISH = new Set(["FRAME", "SYMBOL", "INSTANCE", "SECTION"]);
const GROUPS = new Set(["GROUP", "BOOLEAN_OPERATION", "TRANSFORM_GROUP"]);

const r2 = (v: number) => Math.round(v * 100) / 100;
const fin = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);

const mul = (a: Matrix, b: Matrix): Matrix => ({
  m00: a.m00 * b.m00 + a.m01 * b.m10,
  m01: a.m00 * b.m01 + a.m01 * b.m11,
  m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
  m10: a.m10 * b.m00 + a.m11 * b.m10,
  m11: a.m10 * b.m01 + a.m11 * b.m11,
  m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
});

/** The axis-aligned box of a rectangle of node space, in slide space. */
function boxOf(m: Matrix, x: number, y: number, w: number, h: number): CanvasRect {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h],
  ] as const) {
    xs.push(m.m00 * px + m.m01 * py + m.m02);
    ys.push(m.m10 * px + m.m11 * py + m.m12);
  }
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: r2(x0), y: r2(y0), w: r2(Math.max(...xs) - x0), h: r2(Math.max(...ys) - y0) };
}

function intersect(a: CanvasRect, b: CanvasRect): CanvasRect {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: r2(x0), y: r2(y0), w: r2(Math.max(0, x1 - x0)), h: r2(Math.max(0, y1 - y0)) };
}

const channel = (v: number | undefined) =>
  Math.max(0, Math.min(255, Math.round(fin(v) * 255)))
    .toString(16)
    .padStart(2, "0");
const hex = (c: Color | undefined) =>
  `#${channel(c?.r)}${channel(c?.g)}${channel(c?.b)}`.toUpperCase();

function hashHex(h: ArrayLike<number> | string | undefined): string | null {
  if (typeof h === "string") return /^[0-9a-f]{40}$/i.test(h) ? h.toLowerCase() : null;
  if (h?.length !== 20) return null;
  return Array.from(h, (b) => (b & 0xff).toString(16).padStart(2, "0")).join("");
}

const FIT: Record<string, "fill" | "fit" | "crop" | "tile"> = {
  FILL: "fill",
  FIT: "fit",
  STRETCH: "crop",
  CROP: "crop",
  TILE: "tile",
};

function paint(p: RawPaint): CanvasPaint | null {
  if (p.visible === false) return null;
  const opacity = r2(fin(p.opacity, 1));
  const type = p.type ?? "";
  if (type === "SOLID")
    return { type: "solid", color: hex(p.color), opacity: r2(opacity * fin(p.color?.a, 1)) };
  if (type.startsWith("GRADIENT_"))
    return {
      type: "gradient",
      kind: type.slice("GRADIENT_".length).toLowerCase().slice(0, 32),
      stops: (p.stops ?? []).slice(0, 32).map((s) => ({
        color: hex(s.color),
        opacity: r2(fin(s.color?.a, 1)),
        position: r2(fin(s.position)),
      })),
      opacity,
    };
  if (type === "IMAGE") {
    const w = fin(p.originalImageWidth);
    const h = fin(p.originalImageHeight);
    return {
      type: "image",
      image: hashHex(p.image?.hash),
      fit: FIT[p.imageScaleMode ?? "FILL"] ?? "fill",
      size: w > 0 && h > 0 ? { w, h } : null,
      opacity,
    };
  }
  return { type: "other", kind: type.toLowerCase().slice(0, 32) || "unknown", opacity };
}

const paints = (list: RawPaint[] | undefined): CanvasPaint[] =>
  (list ?? [])
    .map(paint)
    .filter((p): p is CanvasPaint => p !== null)
    .slice(0, 16);

const STYLE_WEIGHTS: [string, number][] = [
  ["extralight", 200],
  ["ultralight", 200],
  ["semibold", 600],
  ["demibold", 600],
  ["extrabold", 800],
  ["ultrabold", 800],
  ["hairline", 100],
  ["thin", 100],
  ["light", 300],
  ["medium", 500],
  ["bold", 700],
  ["heavy", 900],
  ["black", 900],
];

/** A font style's weight and slant ("Semi Bold Italic" → 600, italic), as Wecra matches faces. */
export function styleWeight(style: string): { weight: number; italic: boolean } {
  const s = style.toLowerCase().replace(/[\s_-]+/g, "");
  const italic = s.includes("italic") || s.includes("oblique");
  for (const [name, weight] of STYLE_WEIGHTS) if (s.includes(name)) return { weight, italic };
  return { weight: 400, italic };
}

function lineHeightPx(n: RawNode, size: number): number | null {
  const lh = n.lineHeight;
  if (!lh || typeof lh.value !== "number") return null;
  if (lh.units === "PIXELS") return r2(lh.value);
  if (lh.units === "PERCENT") return r2((size * lh.value) / 100);
  if (lh.units === "RAW") return r2(size * lh.value);
  return null;
}

function letterSpacingPx(n: RawNode, size: number): number {
  const ls = n.letterSpacing;
  if (!ls || typeof ls.value !== "number") return 0;
  return r2(ls.units === "PERCENT" ? (size * ls.value) / 100 : ls.value);
}

const ALIGN: Record<string, CanvasText["align"]> = {
  LEFT: "left",
  CENTER: "center",
  RIGHT: "right",
  JUSTIFIED: "justified",
};
const VALIGN: Record<string, CanvasText["verticalAlign"]> = {
  TOP: "top",
  CENTER: "center",
  BOTTOM: "bottom",
};
const RESIZE: Record<string, CanvasText["autoResize"]> = {
  NONE: "none",
  HEIGHT: "height",
  WIDTH_AND_HEIGHT: "width-and-height",
  TRUNCATE: "none",
};

function textOf(ed: EditorController, n: RawNode, m: Matrix): CanvasText {
  const characters = (n.textData?.characters ?? "").slice(0, 10_000);
  const family = n.fontName?.family ?? "";
  const style = n.fontName?.style ?? "Regular";
  const size = fin(n.fontSize, 12);
  const base = { family, style, size, fills: n.fillPaints ?? [] };
  // Runs: characters that use a style override (Wecra's / Figma's characterStyleIDs).
  const ids = n.textData?.characterStyleIDs ?? [];
  const table = new Map((n.textData?.styleOverrideTable ?? []).map((s) => [s.styleID ?? 0, s]));
  const styleOf = (id: number) => {
    const o = table.get(id);
    return {
      family: o?.fontName?.family ?? base.family,
      style: o?.fontName?.style ?? base.style,
      size: fin(o?.fontSize, base.size),
      fills: o?.fillPaints ?? base.fills,
    };
  };
  const solid = (fills: RawPaint[]) => {
    const p = paints(fills).filter((x) => x.type === "solid");
    const top = p[p.length - 1];
    return top?.type === "solid" ? top : null;
  };
  const runs: CanvasTextRun[] = [];
  if (ids.some((id) => id !== 0 && table.has(id))) {
    let start = 0;
    for (let i = 1; i <= characters.length; i++) {
      const id = ids[start] ?? 0;
      if (i < characters.length && (ids[i] ?? 0) === id) continue;
      const s = styleOf(id);
      const w = styleWeight(s.style);
      const c = solid(s.fills);
      runs.push({
        start,
        end: i,
        family: s.family,
        style: s.style,
        weight: w.weight,
        italic: w.italic,
        size: r2(s.size),
        color: c?.color ?? null,
        opacity: c?.opacity ?? 1,
      });
      start = i;
      if (runs.length >= 400) break;
    }
  }
  const fills = paints(base.fills);
  const main = solid(base.fills);
  const colors = [
    ...new Set(
      [main?.color, ...runs.map((r) => r.color)].filter((c): c is string => typeof c === "string"),
    ),
  ].slice(0, 64);
  const layout = ed.engine.textLayout(n.guid);
  const w = fin(n.size?.x);
  const h = fin(n.size?.y);
  const lines = (layout?.baselines ?? []).slice(0, 400).map((b) => ({
    ...boxOf(m, fin(b.position?.x), fin(b.lineY), fin(b.width), fin(b.lineHeight)),
    from: Math.max(0, Math.trunc(fin(b.firstCharacter))),
    to: Math.max(0, Math.trunc(fin(b.endCharacter))),
  }));
  const autoResize = RESIZE[n.textAutoResize ?? "NONE"] ?? "none";
  const tall = layout ? fin(layout.layoutSize?.y) > h + Math.max(2, 0.3 * size) : false;
  const wide = (layout?.baselines ?? []).some(
    (b) => fin(b.position?.x) + fin(b.width) > w + Math.max(2, 0.12 * size),
  );
  const weight = styleWeight(style);
  return {
    characters,
    family,
    style,
    weight: weight.weight,
    italic: weight.italic,
    size: r2(size),
    lineHeight: lineHeightPx(n, size),
    letterSpacing: letterSpacingPx(n, size),
    align: ALIGN[n.textAlignHorizontal ?? "LEFT"] ?? "left",
    verticalAlign: VALIGN[n.textAlignVertical ?? "TOP"] ?? "top",
    autoResize,
    color: runs[0]?.color ?? main?.color ?? null,
    colors,
    fills,
    runs,
    lines,
    overflow: (autoResize === "none" && tall) || (autoResize !== "width-and-height" && wide),
    truncated: fin(layout?.truncationStartIndex, -1) >= 0,
    missingFont: !!layout?.missingFont,
  };
}

function markOf(n: RawNode): CanvasNode["mark"] {
  const entry = n.pluginData?.find((e) => e.pluginID === STUDIO_PLUGIN && e.key === LAYER_KEY);
  if (!entry?.value) return null;
  try {
    const r = CanvasMark.safeParse(JSON.parse(entry.value));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function kindOf(n: RawNode, fills: CanvasPaint[]): CanvasNode["type"] {
  const type = n.type ?? "";
  if (type === "TEXT") return "text";
  if (GROUPS.has(type)) return "group";
  const image = fills.some((p) => p.type === "image");
  if (FRAMEISH.has(type)) return image && !(n.childIds?.length ?? 0) ? "image" : "frame";
  return image ? "image" : "shape";
}

/** The canvas facts of one slide frame (`frameId`: a top-level frame of the page). */
export function canvasFacts(ed: EditorController, frameId: string): CanvasFacts {
  const raw = ed.engine
    .readNodes([frameId], { subtree: true, childIds: true, fields: FIELDS })
    .map((n) => ed.withRealType(n)) as unknown as RawNode[];
  const byId = new Map(raw.map((n) => [n.guid, n]));
  const frame = byId.get(frameId);
  if (!frame) throw new Error("Kare bulunamadı.");
  const nodes: CanvasNode[] = [];
  const missing = new Set<string>();
  const walk = (
    id: string,
    parentM: Matrix,
    parentVisible: boolean,
    parentOpacity: number,
    clip: CanvasRect | null,
    parent: string | null,
  ) => {
    const n = byId.get(id);
    if (!n || nodes.length >= MAX_NODES) return;
    const m = mul(parentM, n.transform ?? IDENTITY);
    const bounds = boxOf(m, 0, 0, fin(n.size?.x), fin(n.size?.y));
    const visible = parentVisible && n.visible !== false;
    const opacity = r2(fin(n.opacity, 1));
    const effective = r2(parentOpacity * opacity);
    const fills = paints(n.fillPaints);
    const type = kindOf(n, fills);
    const clips = FRAMEISH.has(n.type ?? "") && n.frameMaskDisabled === false;
    const node: CanvasNode = {
      id: n.guid,
      name: (n.name ?? "").slice(0, 500),
      type,
      wecraType: (n.type ?? "").slice(0, 40),
      parent,
      bounds,
      rotation: r2((Math.atan2(m.m10, m.m00) * 180) / Math.PI),
      opacity,
      effectiveOpacity: effective,
      visible,
      clips,
      clip,
      fills: type === "text" ? [] : fills,
      strokes: paints(n.strokePaints),
      strokeWeight: r2(fin(n.strokeWeight)),
      mark: markOf(n),
    };
    if (type === "text") {
      node.text = textOf(ed, n, m);
      if (node.text.missingFont) missing.add(n.guid);
    }
    nodes.push(node);
    const inner = clips ? (clip ? intersect(clip, bounds) : bounds) : clip;
    for (const c of n.childIds ?? []) walk(c, m, visible, effective, inner, n.guid);
  };
  for (const c of frame.childIds ?? []) walk(c, IDENTITY, frame.visible !== false, 1, null, null);
  const frameFills = paints(frame.fillPaints);
  const background = [...frameFills].reverse().find((p) => p.type === "solid");
  const fonts = ed.engine
    .documentFonts([frameId])
    .slice(0, 200)
    .map((f) => ({
      family: f.family.slice(0, 200),
      style: f.style.slice(0, 100),
      uses: f.uses,
      missing: (f.nodes ?? []).some((id) => missing.has(id)),
    }));
  return {
    v: CANVAS_FACTS_VERSION,
    editor: "wecra",
    frame: {
      id: frame.guid,
      name: (frame.name ?? "").slice(0, 500),
      width: r2(fin(frame.size?.x)),
      height: r2(fin(frame.size?.y)),
      background: background?.type === "solid" ? background.color : null,
      fills: frameFills,
    },
    nodes,
    fonts,
  };
}

/**
 * The facts of a slide frame for a save, or `null` when they cannot be read (the save goes on:
 * the version's slide is then the render alone, and its checks say it must be saved again).
 */
export function slideFacts(ed: EditorController, frameId: string): CanvasFacts | null {
  try {
    const r = CanvasFacts.safeParse(canvasFacts(ed, frameId));
    if (r.success) {
      // A very busy slide: trimmed to fit the slide HTML (or none, beyond that).
      const fitted = fitCanvasFacts(r.data);
      if (!fitted) console.warn("canvas facts too large for the slide HTML");
      return fitted;
    }
    console.warn("canvas facts rejected", r.error.issues.slice(0, 3));
  } catch (e) {
    console.warn("canvas facts unreadable", e);
  }
  return null;
}
