// Import fidelity (E11): what Wecra's converter leaves out of a slide, put back on the Wecra layers
// where Wecra's document can hold it, and listed where it can't (the import report the canvas shows
// when the post is first opened: "Tuvale aktarırken değişenler: …").
//
// Put back (CSS → Wecra, Figma's model):
//   - backgrounds: every linear gradient (any angle, "to right bottom", stops in % or px, beyond
//     0–100 %), radial (circle / ellipse, extent keywords or sizes, any centre), conic (→ angular),
//     with their layer order and background-blend-mode; url() layers as image paints placed by
//     background-size / -position (cover, contain, auto, lengths);
//   - pictures: object-fit (cover, contain, fill, none, scale-down) and object-position — an
//     off-centre crop is an image paint in Crop mode with its window (`transform`);
//   - transforms (transform, rotate, scale, translate, with transform-origin): rotation on the
//     layer, scale into its size (and its layers'), translation into its place;
//   - stacking: siblings ordered by z-index as the browser paints them;
//   - text-shadow → drop shadows; filter blur() / drop-shadow() → layer blur / drop shadow;
//     backdrop-filter blur() → background blur; mix-blend-mode → the layer's blend mode;
//   - clip-path polygon() on a plain shape → a vector; circle() → an ellipse;
//   - text-wrap: balance / pretty → the browser's lines kept as line breaks; text-transform
//     uppercase in Turkish (i → İ); transparent text stays transparent; background-clip: text;
//   - ::before / ::after text (an empty image slot's label).
// Reported (no model in Wecra's document): repeating gradients, CSS filters other than blur /
// drop-shadow, masks, other clip paths, skew, mirrored transforms, non-uniform scale of a group,
// an off-centre contain, tiled backgrounds, z-index inside auto layout, inline runs of mixed style
// that wrap.
//
// Pure: specs in, specs out (no engine). `import.ts` runs it between Wecra's converter and
// create_nodes; the pictures are resolved there (their bytes become the document's images).
import type { Spec, WNode } from "@shared/agents/web/convert";
import type { ElementExtras, PseudoText } from "./capture.ts";

/** One thing the import changed or could not carry over, by layer. */
export interface ImportChange {
  /** 0-based slide. */
  slide: number;
  /** The contract layer (data-layer) or the Wecra layer's name. */
  layer: string;
  what: string;
}

export interface Matrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}

export const IDENTITY: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

/** A paint as create_nodes takes it (fills / strokes entries). */
export type PaintSpec = Record<string, unknown>;

/** A picture waiting for its bytes: `{ type: "IMAGE", __picture: k }` in a spec's fills. */
export interface PicturePlan {
  url: string;
  /** An <img> (its layer can become the SVG's vectors) or a background layer (a paint). */
  kind: "img" | "background";
  /** How the picture fills its layer. */
  scaleMode: "FILL" | "FIT" | "CROP" | "TILE";
  transform?: Matrix;
  blendMode?: string;
  /** The layer's box (px): an SVG drawn to a bitmap is drawn at this size (× its scale). */
  box: { w: number; h: number };
  /** The contract's type of the layer (a logo's SVG becomes vectors marked as the logo). */
  type: string | null;
  /** The contract layer it belongs to (`data-layer`). */
  layer?: string | null;
  /** The element's object-fit (an SVG's preserveAspectRatio). */
  fit?: string;
  /** Read by `loadPictures`. */
  bytes?: Uint8Array;
  svg?: string;
}

export const PICTURE_KEY = "__picture";

const r4 = (v: number) => Math.round(v * 10000) / 10000;
const r2 = (v: number) => Math.round(v * 100) / 100;
const num = (v: string | undefined | null): number => {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : 0;
};

// ---- colours -----------------------------------------------------------------------------------

/** A CSS colour as "#RRGGBBAA" (rgb(), rgba(), color(srgb …), #hex, transparent); null: unreadable. */
export function cssColor(input: string): string | null {
  const c = input.trim().toLowerCase();
  if (c === "transparent") return "#00000000";
  const h = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  let m = /^rgba?\(([^)]+)\)$/.exec(c);
  if (m) {
    const p = (m[1] ?? "").split(/[\s,/]+/).filter(Boolean);
    const ch = (s: string | undefined) => (s?.endsWith("%") ? (num(s) / 100) * 255 : num(s));
    const a = p[3] === undefined ? 1 : p[3].endsWith("%") ? num(p[3]) / 100 : num(p[3]);
    return `#${h(ch(p[0]))}${h(ch(p[1]))}${h(ch(p[2]))}${h(a * 255)}`.toUpperCase();
  }
  m = /^color\(srgb\s+([^)]+)\)$/.exec(c);
  if (m) {
    const p = (m[1] ?? "")
      .split(/[\s/]+/)
      .filter(Boolean)
      .map(num);
    const a = p.length > 3 ? (p[3] ?? 1) : 1;
    return `#${h((p[0] ?? 0) * 255)}${h((p[1] ?? 0) * 255)}${h((p[2] ?? 0) * 255)}${h(a * 255)}`.toUpperCase();
  }
  m = /^#([0-9a-f]{3,8})$/.exec(c);
  if (m) {
    let x = m[1] ?? "";
    if (x.length === 3 || x.length === 4) x = [...x].map((d) => d + d).join("");
    if (x.length === 6) x += "ff";
    return x.length === 8 ? `#${x.toUpperCase()}` : null;
  }
  if (c === "black") return "#000000FF";
  if (c === "white") return "#FFFFFFFF";
  return null;
}

/** "#RRGGBBAA" → its alpha (0–1). */
const alphaOf = (hex8: string) => Number.parseInt(hex8.slice(7, 9), 16) / 255;

// ---- CSS lists ---------------------------------------------------------------------------------

/** Splits at `sep` outside parentheses and quotes. */
export function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote && s[i - 1] !== "\\") quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && ch === sep) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out.filter((x) => x.length > 0);
}

/** Splits at whitespace outside parentheses. */
const words = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (depth === 0 && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
};

// ---- gradients ---------------------------------------------------------------------------------

interface Stop {
  color: string;
  position: number | null;
}

/** "<color> [pos [pos]]" stops → positions in [0, 1] units of `unit` px / degrees. */
function parseStops(parts: readonly string[], unit: number, angular: boolean): Stop[] | null {
  const stops: Stop[] = [];
  for (const part of parts) {
    const w = words(part);
    const first = w[0] ?? "";
    const color = cssColor(first);
    if (!color) {
      // A colour hint (a bare position between two stops): the transition's midpoint, dropped.
      if (w.length === 1 && /^-?[\d.]/.test(first)) continue;
      return null;
    }
    const pos = (v: string): number => {
      if (v.endsWith("%")) return num(v) / 100;
      if (angular) {
        if (v.endsWith("turn")) return num(v);
        if (v.endsWith("rad")) return num(v) / (2 * Math.PI);
        if (v.endsWith("grad")) return num(v) / 400;
        return num(v) / 360;
      }
      return unit > 0 ? num(v) / unit : 0;
    };
    if (w.length === 1) stops.push({ color, position: null });
    for (const p of w.slice(1, 3)) stops.push({ color, position: pos(p) });
  }
  if (stops.length < 2) return null;
  // Unpositioned stops: the first at 0, the last at 1, the others spread between known ones.
  const first = stops[0] as Stop;
  const last = stops[stops.length - 1] as Stop;
  if (first.position === null) first.position = 0;
  if (last.position === null) last.position = Math.max(1, first.position);
  let prev = 0;
  for (let i = 1; i < stops.length; i++) {
    const s = stops[i] as Stop;
    if (s.position === null) continue;
    const from = (stops[prev] as Stop).position as number;
    // A stop before an earlier one is moved up to it (CSS).
    s.position = Math.max(s.position, from);
    for (let k = prev + 1; k < i; k++)
      (stops[k] as Stop).position = from + ((s.position - from) * (k - prev)) / (i - prev);
    prev = i;
  }
  return stops;
}

const CORNERS: Record<string, [number, number]> = {
  "to top": [0, -1],
  "to bottom": [0, 1],
  "to left": [-1, 0],
  "to right": [1, 0],
};

/** A linear gradient's direction (a unit vector, y down) in a W × H box. */
function linearDirection(prelude: string | null, w: number, h: number): [number, number] | null {
  if (!prelude) return [0, 1];
  const p = prelude.trim().toLowerCase();
  const side = CORNERS[p];
  if (side) return side;
  const corner = /^to\s+(left|right|top|bottom)\s+(left|right|top|bottom)$/.exec(p);
  if (corner) {
    const tx = corner[1] === "left" || corner[2] === "left" ? -1 : 1;
    const ty = corner[1] === "top" || corner[2] === "top" ? -1 : 1;
    // Perpendicular to the diagonal between the other two corners (CSS): (tx·H, ty·W).
    const x = tx * h;
    const y = ty * w;
    const n = Math.hypot(x, y) || 1;
    return [x / n, y / n];
  }
  const a = /^(-?[\d.]+)(deg|turn|rad|grad)$/.exec(p);
  if (!a) return null;
  const v = num(a[1]);
  const deg =
    a[2] === "turn"
      ? v * 360
      : a[2] === "rad"
        ? (v * 180) / Math.PI
        : a[2] === "grad"
          ? v * 0.9
          : v;
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

/** A box position ("50% 30%", "left top", "left 10px top 20px") in px. */
export function boxPosition(value: string, w: number, h: number): [number, number] {
  const t = words(value.toLowerCase());
  const along = (v: string, size: number) => (v.endsWith("%") ? (num(v) / 100) * size : num(v));
  const KEY: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  if (t.length === 4) {
    // Edge offsets: "right 10px bottom 20px".
    const [e1 = "left", o1 = "0", e2 = "top", o2 = "0"] = t;
    const hx = e1 === "left" || e1 === "right" ? e1 : e2;
    const hv = hx === e1 ? o1 : o2;
    const vy = hx === e1 ? e2 : e1;
    const vv = hx === e1 ? o2 : o1;
    const x = hx === "right" ? w - along(hv, w) : along(hv, w);
    const y = vy === "bottom" ? h - along(vv, h) : along(vv, h);
    return [x, y];
  }
  if (t.length === 1) t.push("center");
  let [a = "center", b = "center"] = t;
  if (a === "top" || a === "bottom" || b === "left" || b === "right") [a, b] = [b, a];
  const x = a in KEY ? (KEY[a] as number) * w : along(a, w);
  const y = b in KEY ? (KEY[b] as number) * h : along(b, h);
  return [x, y];
}

/** A gradient that runs beyond 0–1: its line stretched so the stops fit (row 0 of `t` rescaled). */
function fitStops(stops: Stop[], t: Matrix, radial: boolean): { stops: Stop[]; transform: Matrix } {
  const ps = stops.map((s) => s.position as number);
  const lo = radial ? 0 : Math.min(0, ...ps);
  const hi = Math.max(1, ...ps);
  if (lo === 0 && hi === 1) return { stops, transform: t };
  const k = 1 / (hi - lo);
  const out = stops.map((s) => ({ ...s, position: ((s.position as number) - lo) * k }));
  if (radial)
    // t = 2·|g − ½|: the radii grow by `hi` (g − ½ shrinks by k).
    return {
      stops: out,
      transform: {
        m00: t.m00 * k,
        m01: t.m01 * k,
        m02: 0.5 + (t.m02 - 0.5) * k,
        m10: t.m10 * k,
        m11: t.m11 * k,
        m12: 0.5 + (t.m12 - 0.5) * k,
      },
    };
  return {
    stops: out,
    transform: { ...t, m00: t.m00 * k, m01: t.m01 * k, m02: (t.m02 - lo) * k },
  };
}

const paintStops = (stops: Stop[]) =>
  stops.map((s) => ({ color: s.color, position: r4(Math.max(0, Math.min(1, s.position ?? 0))) }));

const roundMatrix = (m: Matrix): Matrix => ({
  m00: r4(m.m00),
  m01: r4(m.m01),
  m02: r4(m.m02),
  m10: r4(m.m10),
  m11: r4(m.m11),
  m12: r4(m.m12),
});

/** Prelude of a gradient's arguments (direction, shape, position) or null when it starts with a stop. */
function preludeOf(args: string[]): string | null {
  const first = args[0] ?? "";
  if (cssColor(words(first)[0] ?? "")) return null;
  return args.shift() ?? null;
}

/**
 * One CSS gradient (`linear-gradient(…)`, `radial-gradient(…)`, `conic-gradient(…)`) as a Wecra
 * paint over a W × H box; `problem` says why not (repeating gradients, unreadable colours).
 */
export function gradientPaint(
  css: string,
  w: number,
  h: number,
): { paint: PaintSpec | null; problem?: string } {
  const m = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s.exec(css.trim());
  if (!m) return { paint: null, problem: "geçiş okunamadı" };
  if (m[1]) return { paint: null, problem: "tekrarlayan renk geçişi aktarılamadı" };
  if (w <= 0 || h <= 0) return { paint: null };
  const kind = m[2];
  const args = splitTop(m[3] ?? "");
  const prelude = preludeOf(args);
  if (kind === "linear") {
    const d = linearDirection(prelude, w, h);
    if (!d) return { paint: null, problem: "renk geçişinin yönü okunamadı" };
    const [dx, dy] = d;
    const len = Math.abs(w * dx) + Math.abs(h * dy);
    const stops = parseStops(args, len, false);
    if (!stops) return { paint: null, problem: "renk geçişinin renkleri okunamadı" };
    const t: Matrix = {
      m00: (w * dx) / len,
      m01: (h * dy) / len,
      m02: 0.5 - (w * dx + h * dy) / (2 * len),
      m10: (-w * dy) / len,
      m11: (h * dx) / len,
      m12: 0.5 + (w * dy - h * dx) / (2 * len),
    };
    const fit = fitStops(stops, t, false);
    return {
      paint: {
        type: "GRADIENT_LINEAR",
        stops: paintStops(fit.stops),
        transform: roundMatrix(fit.transform),
      },
    };
  }
  if (kind === "radial") {
    const [sizePart = "", posPart = "center"] = (prelude ?? "").split(/\s*\bat\b\s*/);
    const [cx, cy] = boxPosition(posPart || "center", w, h);
    const tokens = words(sizePart.toLowerCase());
    const circle =
      tokens.includes("circle") ||
      (!tokens.includes("ellipse") && tokens.filter((x) => /^[\d.]/.test(x)).length === 1);
    const extent =
      tokens.find((x) => /^(closest|farthest)-(side|corner)$/.test(x)) ?? "farthest-corner";
    const lens = tokens.filter((x) => /^-?[\d.]/.test(x));
    const dl = cx;
    const dr = w - cx;
    const dt = cy;
    const db = h - cy;
    let rx: number;
    let ry: number;
    if (lens.length) {
      rx = lens[0]?.endsWith("%") ? (num(lens[0]) / 100) * w : num(lens[0]);
      ry = circle
        ? rx
        : lens[1]?.endsWith("%")
          ? (num(lens[1]) / 100) * h
          : num(lens[1] ?? lens[0]);
    } else {
      const near = extent.startsWith("closest");
      const sx = near ? Math.min(Math.abs(dl), Math.abs(dr)) : Math.max(Math.abs(dl), Math.abs(dr));
      const sy = near ? Math.min(Math.abs(dt), Math.abs(db)) : Math.max(Math.abs(dt), Math.abs(db));
      if (extent.endsWith("side")) {
        rx = circle ? (near ? Math.min(sx, sy) : Math.max(sx, sy)) : sx;
        ry = circle ? rx : sy;
      } else if (circle) {
        rx = ry = Math.hypot(sx, sy);
      } else {
        rx = sx * Math.SQRT2;
        ry = sy * Math.SQRT2;
      }
    }
    if (!(rx > 0) || !(ry > 0)) return { paint: null };
    const stops = parseStops(args, rx, false);
    if (!stops) return { paint: null, problem: "renk geçişinin renkleri okunamadı" };
    const t: Matrix = {
      m00: w / (2 * rx),
      m01: 0,
      m02: 0.5 - cx / (2 * rx),
      m10: 0,
      m11: h / (2 * ry),
      m12: 0.5 - cy / (2 * ry),
    };
    const fit = fitStops(stops, t, true);
    return {
      paint: {
        type: "GRADIENT_RADIAL",
        stops: paintStops(fit.stops),
        transform: roundMatrix(fit.transform),
      },
    };
  }
  // conic: Wecra's angular gradient starts at 3 o'clock, clockwise (its CSS is `from 90deg`).
  const from = /from\s+(-?[\d.]+)(deg|turn|rad|grad)?/.exec(prelude ?? "");
  const unitDeg = (v: number, u: string | undefined) =>
    u === "turn" ? v * 360 : u === "rad" ? (v * 180) / Math.PI : u === "grad" ? v * 0.9 : v;
  const alpha = from ? unitDeg(num(from[1]), from[2]) : 0;
  const at = /\bat\s+(.+)$/.exec(prelude ?? "");
  const [cx, cy] = boxPosition(at?.[1] ?? "center", w, h);
  const stops = parseStops(args, 0, true);
  if (!stops) return { paint: null, problem: "renk geçişinin renkleri okunamadı" };
  const beta = ((alpha - 90) * Math.PI) / 180;
  const k = Math.max(w, h);
  const c = Math.cos(beta);
  const s = Math.sin(beta);
  return {
    paint: {
      type: "GRADIENT_ANGULAR",
      stops: paintStops(stops),
      transform: roundMatrix({
        m00: (c * w) / k,
        m01: (s * h) / k,
        m02: 0.5 - (c * cx + s * cy) / k,
        m10: (-s * w) / k,
        m11: (c * h) / k,
        m12: 0.5 - (-s * cx + c * cy) / k,
      }),
    },
  };
}

/** A paint's transform seen from a sub-box (`ox, oy, cw, ch` inside the W × H box it was made for). */
export function reframe(
  t: Matrix,
  w: number,
  h: number,
  sub: { x: number; y: number; w: number; h: number },
): Matrix {
  const a = { m00: sub.w / w, m02: sub.x / w, m11: sub.h / h, m12: sub.y / h };
  return roundMatrix({
    m00: t.m00 * a.m00,
    m01: t.m01 * a.m11,
    m02: t.m00 * a.m02 + t.m01 * a.m12 + t.m02,
    m10: t.m10 * a.m00,
    m11: t.m11 * a.m11,
    m12: t.m10 * a.m02 + t.m11 * a.m12 + t.m12,
  });
}

// ---- pictures ----------------------------------------------------------------------------------

/**
 * A picture of natural size `nat` drawn `dw × dh` at `ox, oy` in a W × H box → Wecra's image
 * paint: Fill / Fit when it is what Wecra's modes draw (centred cover / contain), else Crop with
 * its window (Figma's imageTransform: the layer's unit box → the image's).
 */
function placed(
  w: number,
  h: number,
  dw: number,
  dh: number,
  ox: number,
  oy: number,
  cover: boolean,
): { scaleMode: PicturePlan["scaleMode"]; transform?: Matrix; problem?: string } {
  const centred = Math.abs(ox - (w - dw) / 2) < 0.75 && Math.abs(oy - (h - dh) / 2) < 0.75;
  const covers = ox <= 0.5 && oy <= 0.5 && ox + dw >= w - 0.5 && oy + dh >= h - 0.5;
  if (covers && centred && cover) return { scaleMode: "FILL" };
  if (covers)
    return {
      scaleMode: "CROP",
      transform: roundMatrix({
        m00: w / dw,
        m01: 0,
        m02: -ox / dw,
        m10: 0,
        m11: h / dh,
        m12: -oy / dh,
      }),
    };
  if (centred) return { scaleMode: "FIT" };
  return { scaleMode: "FIT", problem: "görselin konumu ortalandı" };
}

/** An <img>'s object-fit / object-position as Wecra's image paint. */
export function objectFitPlacement(
  fit: string | undefined,
  position: string | undefined,
  natural: [number, number] | undefined,
  box: { w: number; h: number },
): { scaleMode: PicturePlan["scaleMode"]; transform?: Matrix; problem?: string } {
  const f = fit ?? "fill";
  if (f === "fill") return { scaleMode: "CROP", transform: IDENTITY };
  const [iw, ih] = natural ?? [0, 0];
  if (!(iw > 0 && ih > 0)) return { scaleMode: f === "cover" ? "FILL" : "FIT" };
  const { w, h } = box;
  const cover = Math.max(w / iw, h / ih);
  const contain = Math.min(w / iw, h / ih);
  const s =
    f === "cover" ? cover : f === "contain" ? contain : f === "none" ? 1 : Math.min(1, contain);
  const dw = iw * s;
  const dh = ih * s;
  const [px, py] = positionFractions(position ?? "50% 50%", w - dw, h - dh);
  const out = placed(w, h, dw, dh, px, py, f === "cover");
  if (out.scaleMode === "FIT" && (f === "none" || f === "scale-down") && s !== contain)
    return { scaleMode: "FIT", problem: "görsel kutuya sığdırıldı (gerçek boyutu daha küçük)" };
  return out;
}

/** Offsets of a picture in its box from a CSS position: percentages of the free space, or px. */
function positionFractions(value: string, freeX: number, freeY: number): [number, number] {
  const t = words(value.toLowerCase());
  const KEY: Record<string, number> = { left: 0, top: 0, center: 0.5, right: 1, bottom: 1 };
  const one = (v: string, free: number) =>
    v in KEY ? (KEY[v] as number) * free : v.endsWith("%") ? (num(v) / 100) * free : num(v);
  if (t.length === 4) {
    const [e1 = "left", o1 = "0", e2 = "top", o2 = "0"] = t;
    const horizontal = e1 === "left" || e1 === "right";
    const [hx, hv, vy, vv] = horizontal ? [e1, o1, e2, o2] : [e2, o2, e1, o1];
    const x = hx === "right" ? freeX - one(hv, freeX) : one(hv, freeX);
    const y = vy === "bottom" ? freeY - one(vv, freeY) : one(vv, freeY);
    return [x, y];
  }
  if (t.length === 1) t.push("center");
  let [a = "center", b = "center"] = t;
  if (a === "top" || a === "bottom" || b === "left" || b === "right") [a, b] = [b, a];
  return [one(a, freeX), one(b, freeY)];
}

/** A url() background layer's size / position / repeat as Wecra's image paint. */
export function backgroundPlacement(
  size: string | undefined,
  position: string | undefined,
  repeat: string | undefined,
  natural: [number, number] | null | undefined,
  box: { w: number; h: number },
): { scaleMode: PicturePlan["scaleMode"]; transform?: Matrix; problem?: string } {
  const sz = (size ?? "auto").trim().toLowerCase();
  const [iw, ih] = natural ?? [0, 0];
  if (!(iw > 0 && ih > 0)) return { scaleMode: sz === "contain" ? "FIT" : "FILL" };
  const { w, h } = box;
  let dw: number;
  let dh: number;
  if (sz === "cover" || sz === "contain") {
    const s = sz === "cover" ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
    dw = iw * s;
    dh = ih * s;
  } else {
    const [a = "auto", b = "auto"] = words(sz);
    const len = (v: string, base: number) => (v.endsWith("%") ? (num(v) / 100) * base : num(v));
    if (a === "auto" && b === "auto") [dw, dh] = [iw, ih];
    else if (b === "auto") {
      dw = len(a, w);
      dh = (dw * ih) / iw;
    } else if (a === "auto") {
      dh = len(b, h);
      dw = (dh * iw) / ih;
    } else [dw, dh] = [len(a, w), len(b, h)];
  }
  if (!(dw > 0 && dh > 0)) return { scaleMode: "FILL" };
  const [ox, oy] = positionFractions(position ?? "0% 0%", w - dw, h - dh);
  const out = placed(w, h, dw, dh, ox, oy, sz === "cover");
  const tiles = !/no-repeat/.test(repeat ?? "repeat") && (dw < w - 0.5 || dh < h - 0.5);
  if (tiles) return { ...out, problem: "döşenen arka plan görseli tek görsel olarak aktarıldı" };
  return out;
}

// ---- effects, blend modes, shapes --------------------------------------------------------------

/** text-shadow / drop-shadow lists ("<color> x y blur") as Wecra drop shadows. */
export function shadowEffects(value: string): PaintSpec[] {
  return splitTop(value).flatMap((s) => {
    const w = words(s);
    const colorWord = w.find((x) => cssColor(x));
    const color = colorWord ? cssColor(colorWord) : "#000000FF";
    const lens = w.filter((x) => x !== colorWord).map(num);
    if (!color || alphaOf(color) === 0) return [];
    return [
      {
        type: "DROP_SHADOW",
        color,
        offset: { x: lens[0] ?? 0, y: lens[1] ?? 0 },
        radius: lens[2] ?? 0,
        spread: 0,
        visible: true,
        blendMode: "NORMAL",
      },
    ];
  });
}

/** CSS `filter` → Wecra effects (blur, drop-shadow) and what has no model there. */
export function filterEffects(value: string): { effects: PaintSpec[]; unsupported: string[] } {
  const effects: PaintSpec[] = [];
  const unsupported: string[] = [];
  for (const m of value.matchAll(/([a-z-]+)\(((?:[^()]|\([^()]*\))*)\)/g)) {
    const [, fn = "", arg = ""] = m;
    if (fn === "blur") {
      // CSS blur(r) is a Gaussian of σ = r; Wecra's (Figma's) radius is 2σ.
      if (num(arg) > 0)
        effects.push({ type: "LAYER_BLUR", radius: r2(num(arg) * 2), visible: true });
    } else if (fn === "drop-shadow") effects.push(...shadowEffects(arg));
    else if (
      !(
        (fn === "opacity" || fn === "brightness" || fn === "contrast" || fn === "saturate") &&
        num(arg) === 1
      )
    )
      unsupported.push(fn);
  }
  return { effects, unsupported };
}

/** backdrop-filter blur() → Wecra's background blur. */
export function backdropEffects(value: string): { effects: PaintSpec[]; unsupported: string[] } {
  const out = filterEffects(value);
  return {
    effects: out.effects
      .filter((e) => e.type === "LAYER_BLUR")
      .map((e) => ({ ...e, type: "BACKGROUND_BLUR" })),
    unsupported: [
      ...out.unsupported,
      ...(out.effects.some((e) => e.type !== "LAYER_BLUR") ? ["drop-shadow"] : []),
    ],
  };
}

const BLEND: Record<string, string> = {
  multiply: "MULTIPLY",
  screen: "SCREEN",
  overlay: "OVERLAY",
  darken: "DARKEN",
  lighten: "LIGHTEN",
  "color-dodge": "COLOR_DODGE",
  "color-burn": "COLOR_BURN",
  "hard-light": "HARD_LIGHT",
  "soft-light": "SOFT_LIGHT",
  difference: "DIFFERENCE",
  exclusion: "EXCLUSION",
  hue: "HUE",
  saturation: "SATURATION",
  color: "COLOR",
  luminosity: "LUMINOSITY",
};

/** A CSS blend mode as Wecra's (null: normal or none Wecra has). */
export const blendModeOf = (css: string | undefined): string | null =>
  css ? (BLEND[css.trim().toLowerCase()] ?? null) : null;

/** clip-path polygon(…) in a W × H box → an SVG polygon's points (null: another shape). */
export function polygonPoints(clip: string, w: number, h: number): string | null {
  const m = /^polygon\((?:\s*(?:nonzero|evenodd)\s*,)?(.*)\)$/s.exec(clip.trim());
  if (!m) return null;
  const pts = splitTop(m[1] ?? "").map((p) => {
    const [x = "0", y = "0"] = words(p);
    const along = (v: string, size: number) => (v.endsWith("%") ? (num(v) / 100) * size : num(v));
    return `${r2(along(x, w))},${r2(along(y, h))}`;
  });
  return pts.length >= 3 ? pts.join(" ") : null;
}

/** clip-path circle(50%) / ellipse(50% 50%) centred: the box drawn as an ellipse. */
export const isFullEllipse = (clip: string): boolean =>
  /^(circle\(50%( at (50% 50%|center))?\)|ellipse\(50% 50%( at (50% 50%|center))?\))$/.test(
    clip.trim().toLowerCase(),
  );

// ---- transforms --------------------------------------------------------------------------------

/** A 2D matrix [a, b, c, d, e, f] as rotation, scale and skew (null: mirrored). */
export function decompose(m: readonly number[]): {
  rotation: number;
  sx: number;
  sy: number;
  skew: boolean;
  mirrored: boolean;
} {
  const [a = 1, b = 0, c = 0, d = 1] = m;
  const sx = Math.hypot(a, b);
  const det = a * d - b * c;
  const sy = sx ? det / sx : 0;
  const skew = sx && sy ? Math.abs((a * c + b * d) / (sx * sy)) > 0.01 : false;
  return {
    rotation: (Math.atan2(b, a) * 180) / Math.PI,
    sx,
    sy: Math.abs(sy),
    skew,
    mirrored: det < 0,
  };
}

/** Scales a spec's own geometry and type (and its layers') by kx, ky (a CSS scale on a group). */
export function scaleSpec(s: Spec, kx: number, ky: number, self = true): void {
  const k = Math.sqrt(Math.abs(kx * ky));
  const mul = (key: string, f: number) => {
    if (typeof s[key] === "number") s[key] = r2((s[key] as number) * f);
  };
  if (self) {
    mul("width", kx);
    mul("height", ky);
  }
  mul("fontSize", k);
  mul("lineHeight", k);
  mul("letterSpacing", k);
  mul("strokeWeight", k);
  mul("itemSpacing", k);
  if (typeof s.cornerRadius === "number") mul("cornerRadius", k);
  else if (Array.isArray(s.cornerRadius))
    s.cornerRadius = (s.cornerRadius as number[]).map((v) => r2(v * k));
  if (Array.isArray(s.padding))
    s.padding = (s.padding as number[]).map((v, i) => r2(v * (i % 2 ? kx : ky)));
  if (Array.isArray(s.effects))
    s.effects = (s.effects as PaintSpec[]).map((e) => ({
      ...e,
      ...(typeof e.radius === "number" ? { radius: r2((e.radius as number) * k) } : {}),
      ...(e.offset
        ? {
            offset: {
              x: r2(((e.offset as { x: number }).x ?? 0) * kx),
              y: r2(((e.offset as { y: number }).y ?? 0) * ky),
            },
          }
        : {}),
    }));
  for (const c of s.children ?? []) {
    if (typeof c.x === "number") c.x = r2(c.x * kx);
    if (typeof c.y === "number") c.y = r2(c.y * ky);
    scaleSpec(c, kx, ky, true);
  }
}

// ---- the slide ---------------------------------------------------------------------------------

const AL_KEYS = [
  "layoutMode",
  "itemSpacing",
  "padding",
  "primaryAxisAlignItems",
  "counterAxisAlignItems",
  "primaryAxisSizingMode",
  "counterAxisSizingMode",
];

const srcOf = (s: Spec): WNode | null => (s._?.src as WNode | undefined) ?? null;

/** The captured element a spec comes from (a text: its element; a pseudo box: its owner). */
const elementOf = (n: WNode): number | null => {
  const i = n.kind === "text" ? n.ci : (n.i ?? n.pseudoOf);
  return typeof i === "number" ? i : null;
};

/** A frame laid out by hand: its auto layout off, every layer at its captured place. */
function dropAutoLayout(s: Spec): void {
  const src = srcOf(s);
  if (!src || !s.layoutMode) return;
  for (const k of AL_KEYS) delete s[k];
  if (typeof s.width !== "number") s.width = r2(src.w);
  if (typeof s.height !== "number") s.height = r2(src.h);
  for (const c of s.children ?? []) {
    const cs = srcOf(c);
    if (!cs) continue;
    delete c.layoutPositioning;
    const sizedW = c.layoutSizingHorizontal === "FILL" || c.layoutSizingHorizontal === "FIXED";
    const sizedH = c.layoutSizingVertical === "FILL" || c.layoutSizingVertical === "FIXED";
    delete c.layoutSizingHorizontal;
    delete c.layoutSizingVertical;
    c.x = r2(cs.x - src.x);
    c.y = r2(cs.y - src.y);
    if (c.type === "TEXT") {
      if (c.textAutoResize !== "WIDTH_AND_HEIGHT" && (sizedW || typeof c.width !== "number"))
        c.width = r2(cs.w);
      if (c.textAutoResize === "NONE" && (sizedH || typeof c.height !== "number"))
        c.height = r2(cs.h);
    } else {
      if (typeof c.width !== "number" || sizedW) c.width = r2(cs.w);
      if (typeof c.height !== "number" || sizedH) c.height = r2(cs.h);
    }
  }
}

/** CSS paint order among siblings: negative z, in flow, positioned (auto / 0), positive z. */
function stackRank(x: ElementExtras | undefined): [number, number] {
  if (!x || x.position === "static") return [1, 0];
  const z = x.zIndex === "auto" ? null : num(x.zIndex);
  if (z === null || z === 0) return [2, 0];
  return z < 0 ? [0, z] : [3, z];
}

export interface EnrichContext {
  slide: number;
  extras: readonly ElementExtras[];
  /** Pictures found (their fills hold `{ __picture: k }`). */
  pictures: PicturePlan[];
  report: ImportChange[];
  /** The contract layer of a captured element (else the spec's name). */
  layerOf?: (element: number) => string | null;
}

/** The fills of a box with its background layers (gradients, pictures) rebuilt. */
function backgroundFills(
  n: WNode,
  x: ElementExtras | undefined,
  ctx: EnrichContext,
  note: (what: string) => void,
): (PaintSpec | string)[] | null {
  if (!n.bgi) return null;
  const bg = (n.c?.bg as string | null | undefined) ?? null;
  const layers = splitTop(n.bgi);
  const blends = splitTop(x?.bgBlend ?? "");
  const sizes = splitTop(x?.bgSize ?? "");
  const positions = splitTop(x?.bgPosition ?? "");
  const repeats = splitTop(x?.bgRepeat ?? "");
  const out: PaintSpec[] = [];
  let url = 0;
  // CSS: the first layer is on top; Wecra's fills are bottom first.
  layers.forEach((layer, i) => {
    // A layer of the shorthand that only sets the colour.
    if (layer === "none") return;
    const blend = blendModeOf(blends[i % Math.max(1, blends.length)]);
    const u = /^url\(\s*["']?([^"')]+)["']?\s*\)$/.exec(layer);
    if (u) {
      const at = url++;
      const place = backgroundPlacement(
        sizes[i % Math.max(1, sizes.length)],
        positions[i % Math.max(1, positions.length)],
        repeats[i % Math.max(1, repeats.length)],
        x?.bgNatural?.[at],
        { w: n.w, h: n.h },
      );
      if (place.problem) note(place.problem);
      const k =
        ctx.pictures.push({
          url: u[1] ?? "",
          kind: "background",
          scaleMode: place.scaleMode,
          ...(place.transform ? { transform: place.transform } : {}),
          ...(blend ? { blendMode: blend } : {}),
          box: { w: n.w, h: n.h },
          type: null,
          fit: "cover",
        }) - 1;
      out.unshift({ type: "IMAGE", [PICTURE_KEY]: k });
      return;
    }
    const g = gradientPaint(layer, n.w, n.h);
    // An empty image slot's hatching is the placeholder's (its look, not the design's).
    if (g.problem && !x?.slotEmpty) note(g.problem);
    if (g.paint) out.unshift(blend ? { ...g.paint, blendMode: blend } : g.paint);
  });
  return bg ? [bg, ...out] : out;
}

/** A ::before / ::after's text as a text layer filling its box. */
function pseudoTextSpec(p: PseudoText, w: number, h: number, font: (css: string) => string): Spec {
  const color = cssColor(p.color);
  return {
    type: "TEXT",
    name: p.text.slice(0, 40),
    characters: p.text,
    fontFamily: font(p.font),
    fontStyle:
      p.weight >= 700
        ? p.italic
          ? "Bold Italic"
          : "Bold"
        : p.weight >= 600
          ? "Semi Bold"
          : p.weight >= 500
            ? "Medium"
            : p.italic
              ? "Italic"
              : "Regular",
    fontSize: p.size,
    ...(p.lh ? { lineHeight: r2(p.lh) } : {}),
    letterSpacing: r2(p.ls),
    ...(color ? { fills: [color] } : {}),
    textAutoResize: "NONE",
    textAlignHorizontal: "CENTER",
    textAlignVertical: "CENTER",
    x: 0,
    y: 0,
    width: r2(w),
    height: r2(h),
  };
}

/**
 * Puts back on a slide's specs (Wecra's converter output, notes still on: `_.src`) what the
 * converter leaves out, and lists what can't be (see the top). `font`: the family a CSS font list
 * becomes (as the import's).
 */
export function enrichSlide(root: Spec, ctx: EnrichContext, font: (css: string) => string): void {
  const noted = new Set<string>();
  const visit = (s: Spec, parent: Spec | null) => {
    const n = srcOf(s);
    if (!n) {
      for (const c of s.children ?? []) visit(c, s);
      return;
    }
    const idx = elementOf(n);
    const x = idx !== null ? ctx.extras[idx] : undefined;
    const layer =
      (idx !== null ? (ctx.layerOf?.(idx) ?? x?.layer) : null) ?? String(s.name ?? "katman");
    const note = (what: string) => {
      const key = `${layer}\u0000${what}`;
      if (noted.has(key)) return;
      noted.add(key);
      ctx.report.push({ slide: ctx.slide, layer, what });
    };
    const pseudo = n.tag === "::before" || n.tag === "::after";

    // Backgrounds (frames: gradients at any angle, radial, conic; url() pictures placed).
    if (n.kind === "box" && !pseudo) {
      const fills = backgroundFills(n, x, ctx, note);
      if (fills) s.fills = fills;
    }
    // An <img>: object-fit / object-position.
    if (n.kind === "img" && typeof n.src === "string") {
      const place = objectFitPlacement(
        x?.objectFit ?? (n.fit as string | undefined),
        x?.objectPosition,
        x?.natural,
        { w: n.w, h: n.h },
      );
      if (place.problem) note(place.problem);
      const k =
        ctx.pictures.push({
          url: n.src,
          kind: "img",
          scaleMode: place.scaleMode,
          ...(place.transform ? { transform: place.transform } : {}),
          box: { w: n.w, h: n.h },
          type: x?.layerType ?? null,
          layer: x?.layer ?? null,
          fit: x?.objectFit ?? (n.fit as string | undefined),
        }) - 1;
      s.fills = [{ type: "IMAGE", [PICTURE_KEY]: k }];
    }
    // The ::after label of an empty image slot (the walker reads pseudo boxes, not their text).
    if (pseudo && typeof n.pseudoOf === "number") {
      const owner = ctx.extras[n.pseudoOf];
      const p = n.tag === "::before" ? owner?.before : owner?.after;
      if (p && !(s.children ?? []).length) s.children = [pseudoTextSpec(p, n.w, n.h, font)];
    }

    if (x && n.kind === "text") {
      const chars = String(s.characters ?? "");
      // Balanced lines: the browser's breaks, kept as line breaks.
      const run = x.balanced?.find((b) => b.text === chars && b.lines.length > 1);
      if (run) {
        s.characters = run.lines.join("\n");
        note("dengeli satır kırılımı satır sonlarıyla korundu");
      }
      // Turkish capitals: i → İ (Wecra's text case is not language-aware).
      if (
        x.textTransform === "uppercase" &&
        /^tr/i.test(x.lang ?? "") &&
        /[iı]/.test(String(s.characters))
      )
        s.characters = String(s.characters).toLocaleUpperCase("tr-TR");
      if (x.textShadow) {
        const fx = shadowEffects(x.textShadow);
        if (fx.length) s.effects = [...((s.effects as PaintSpec[] | undefined) ?? []), ...fx];
      }
      // Transparent text: no fill (not Wecra's default black).
      const ink = cssColor(x.color ?? "");
      if (!s.fills && ink && alphaOf(ink) === 0) s.fills = [];
      if (x.mixedWrap)
        note("farklı stilli satır içi metin ayrı katmanlara bölündü; satırlar kayabilir");
    }

    if (x && n.kind !== "text" && !pseudo) {
      // Blend mode, filters, backdrop blur, masks, clip paths.
      const blend = blendModeOf(x.blend);
      if (blend) s.blendMode = blend;
      else if (x.blend && x.blend !== "normal") note(`karışım modu (${x.blend}) aktarılamadı`);
      const fx: PaintSpec[] = [];
      if (x.filter) {
        const f = filterEffects(x.filter);
        fx.push(...f.effects);
        if (f.unsupported.length)
          note(`filtre aktarılamadı (${[...new Set(f.unsupported)].join(", ")})`);
      }
      if (x.backdrop) {
        const f = backdropEffects(x.backdrop);
        fx.push(...f.effects);
        if (f.unsupported.length)
          note(`arka plan filtresi aktarılamadı (${[...new Set(f.unsupported)].join(", ")})`);
      }
      if (fx.length) s.effects = [...((s.effects as PaintSpec[] | undefined) ?? []), ...fx];
      if (x.mask) note("maske aktarılamadı");
      if (x.clipPath) {
        const points = polygonPoints(x.clipPath, n.w, n.h);
        const plain =
          !(s.children ?? []).length &&
          Array.isArray(s.fills) &&
          (s.fills as unknown[]).length === 1 &&
          typeof (s.fills as unknown[])[0] === "string";
        if (points && plain) {
          // A plain shape cut to a polygon: that polygon, as a vector.
          const fill = String((s.fills as string[])[0]);
          const rgb = fill.slice(0, 7);
          const a = fill.length === 9 ? alphaOf(fill) : 1;
          s.svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${r2(n.w)}" height="${r2(n.h)}" viewBox="0 0 ${r2(n.w)} ${r2(n.h)}"><polygon points="${points}" fill="${rgb}"${a < 1 ? ` fill-opacity="${r4(a)}"` : ""}/></svg>`;
          for (const k of [
            "fills",
            "strokes",
            "strokeWeight",
            "strokeAlign",
            "cornerRadius",
            "clipsContent",
            "layoutMode",
          ])
            delete s[k];
        } else if (isFullEllipse(x.clipPath) && !(s.children ?? []).length) {
          s.type = "ELLIPSE";
          delete s.cornerRadius;
          delete s.clipsContent;
        } else note("kırpma şekli (clip-path) aktarılamadı");
      }
      // background-clip: text — the box's paints are its text's.
      if (/text/.test(x.bgClip ?? "") && Array.isArray(s.fills)) {
        const paints = (s.fills as unknown[]).filter((p) => typeof p === "object");
        const texts = (s.children ?? []).filter((c) => c.type === "TEXT");
        if (paints.length && texts.length) {
          for (const t of texts) {
            const ts = srcOf(t);
            t.fills = paints.map((p) => {
              const paint = p as PaintSpec;
              if (!ts || !paint.transform) return paint;
              return {
                ...paint,
                transform: reframe(paint.transform as Matrix, n.w, n.h, {
                  x: ts.x - n.x,
                  y: ts.y - n.y,
                  w: ts.w,
                  h: ts.h,
                }),
              };
            });
          }
          s.fills = (s.fills as unknown[]).filter((p) => typeof p === "string");
        } else note("metne kırpılan arka plan aktarılamadı");
      }
    }

    // Children first (a transform on this layer moves them with it), then the stacking order.
    for (const c of s.children ?? []) visit(c, s);
    if (s.children && s.children.length > 1) {
      const ranked = s.children.map((c, i) => {
        const cn = srcOf(c);
        const ci = cn ? elementOf(cn) : null;
        const pseudoChild = cn?.tag === "::before" || cn?.tag === "::after";
        const own = cn && (cn.kind !== "text" || "boxW" in cn) && !pseudoChild;
        const cx = own && ci !== null ? ctx.extras[ci] : undefined;
        return { c, i, rank: pseudoChild ? ([2, 0] as [number, number]) : stackRank(cx) };
      });
      const sorted = [...ranked].sort(
        (a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.i - b.i,
      );
      if (sorted.some((r, i) => r !== ranked[i])) {
        if (s.layoutMode) {
          // Auto layout keeps the flow order: only absolutely placed layers move.
          const flowOk = sorted
            .filter((r) => !r.c.layoutPositioning)
            .every((r, i, arr) => i === 0 || (arr[i - 1] as { i: number }).i < r.i);
          if (flowOk) s.children = sorted.map((r) => r.c);
          else note("katman sırası (z-index) otomatik yerleşimde korunamadı");
        } else s.children = sorted.map((r) => r.c);
      }
    }

    // The transform: rotation on the layer, scale into its size, translation into its place —
    // on the layer that is the element (a box, or a text that took its box's place), not on the
    // text runs inside a transformed box (they move with it).
    if (x?.tf && (n.kind !== "text" || "boxW" in n) && !pseudo)
      applyTransform(s, n, x.tf, parent, note);
  };
  visit(root, null);
}

function applyTransform(
  s: Spec,
  n: WNode,
  tf: { m: number[]; o: [number, number] },
  parent: Spec | null,
  note: (what: string) => void,
): void {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = tf.m;
  const [ox, oy] = tf.o;
  const dec = decompose(tf.m);
  if (dec.mirrored) {
    note("ayna çevirme aktarılamadı");
    return;
  }
  if (dec.skew) note("eğme (skew) aktarılamadı");
  const ps = parent ? srcOf(parent) : null;
  // A flow child's place can't move in auto layout: its parent is laid out by hand instead.
  if (parent?.layoutMode && !s.layoutPositioning) dropAutoLayout(parent);
  const x0 = ps ? n.x - ps.x : typeof s.x === "number" ? s.x : 0;
  const y0 = ps ? n.y - ps.y : typeof s.y === "number" ? s.y : 0;
  if (Math.abs(dec.sx - 1) > 0.001 || Math.abs(dec.sy - 1) > 0.001) {
    if ((s.children ?? []).length && Math.abs(dec.sx - dec.sy) > 0.001)
      note("orantısız ölçek yaklaşık aktarıldı");
    if (s.type === "TEXT" && s.textAutoResize === "WIDTH_AND_HEIGHT")
      scaleSpec(s, dec.sx, dec.sy, false);
    else {
      if (typeof s.width !== "number") s.width = r2(n.w);
      if (typeof s.height !== "number" && s.textAutoResize !== "HEIGHT") s.height = r2(n.h);
      scaleSpec(s, dec.sx, dec.sy, true);
    }
  }
  // CSS: P(q) = topLeft + O + t + L·(q − O); the layer's origin (q = 0) goes to topLeft + O + t − L·O.
  s.x = r2(x0 + ox + e - (a * ox + c * oy));
  s.y = r2(y0 + oy + f - (b * ox + d * oy));
  if (Math.abs(dec.rotation) > 0.01) s.rotation = r2(-dec.rotation);
  if (parent?.layoutMode) s.layoutPositioning = "ABSOLUTE";
}
