// Geometry shared by the adapter and the canvas: oriented boxes (a layer as painted), the
// engine's 2×3 matrices, and the mapping from a box the engine moved / resized / rotated /
// scaled back to the design contract's editor-owned CSS (`translate`, `rotate`, `scale`,
// `width`, `height`) as design-kit patch operations.
//
// Conventions: artboard px, y down; angles in degrees, clockwise positive (CSS `rotate` and the
// engine agree); a layer's CSS transforms turn and scale about its layout box's centre (the
// default transform-origin), so the painted centre is the layout centre plus `translate`.
import type { PatchOpInput } from "@studio/design-kit/patch";
import type { EditorLayer } from "./document.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A layer as painted: centre, size (layout size × scale) and angle. */
export interface OBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Degrees, clockwise. */
  angle: number;
}

/** x' = m00·x + m01·y + m02, y' = m10·x + m11·y + m12 (the engine's Matrix). */
export interface Matrix {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
}

export const IDENTITY_MATRIX: Matrix = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

const RAD = Math.PI / 180;

export function multiply(a: Matrix, b: Matrix): Matrix {
  return {
    m00: a.m00 * b.m00 + a.m01 * b.m10,
    m01: a.m00 * b.m01 + a.m01 * b.m11,
    m02: a.m00 * b.m02 + a.m01 * b.m12 + a.m02,
    m10: a.m10 * b.m00 + a.m11 * b.m10,
    m11: a.m10 * b.m01 + a.m11 * b.m11,
    m12: a.m10 * b.m02 + a.m11 * b.m12 + a.m12,
  };
}

export function invert(m: Matrix): Matrix {
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (Math.abs(det) < 1e-12) return IDENTITY_MATRIX;
  const i00 = m.m11 / det;
  const i01 = -m.m01 / det;
  const i10 = -m.m10 / det;
  const i11 = m.m00 / det;
  return {
    m00: i00,
    m01: i01,
    m02: -(i00 * m.m02 + i01 * m.m12),
    m10: i10,
    m11: i11,
    m12: -(i10 * m.m02 + i11 * m.m12),
  };
}

export function translation(x: number, y: number): Matrix {
  return { m00: 1, m01: 0, m02: x, m10: 0, m11: 1, m12: y };
}

export function apply(m: Matrix, x: number, y: number): { x: number; y: number } {
  return { x: m.m00 * x + m.m01 * y + m.m02, y: m.m10 * x + m.m11 * y + m.m12 };
}

/** The node transform of a box: its top-left corner at the origin, turned by its angle. */
export function boxMatrix(b: OBox): Matrix {
  const c = Math.cos(b.angle * RAD);
  const s = Math.sin(b.angle * RAD);
  // The top-left corner: the centre minus the turned half size.
  const x = b.cx - (c * b.w) / 2 + (s * b.h) / 2;
  const y = b.cy - (s * b.w) / 2 - (c * b.h) / 2;
  return { m00: c, m01: -s, m02: x, m10: s, m11: c, m12: y };
}

/** The box a node of `size` draws with matrix `m` (a reflection is read as a turn). */
export function matrixBox(m: Matrix, size: { x: number; y: number }): OBox {
  const sx = Math.hypot(m.m00, m.m10);
  const sy = Math.hypot(m.m01, m.m11);
  const angle = normalizeAngle(Math.atan2(m.m10, m.m00) / RAD);
  const w = size.x * sx;
  const h = size.y * sy;
  const c = apply(m, size.x / 2, size.y / 2);
  return { cx: c.x, cy: c.y, w, h, angle };
}

/** (−180, 180]. */
export function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return Math.abs(a) < 1e-9 ? 0 : a;
}

export function corners(b: OBox): { x: number; y: number }[] {
  const m = boxMatrix(b);
  return [apply(m, 0, 0), apply(m, b.w, 0), apply(m, b.w, b.h), apply(m, 0, b.h)];
}

export function aabb(b: OBox): Rect {
  if (b.angle === 0) return { x: b.cx - b.w / 2, y: b.cy - b.h / 2, w: b.w, h: b.h };
  const pts = corners(b);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export function rectBox(r: Rect, angle = 0): OBox {
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, angle };
}

/** The top-left corner of a box as drawn (turned with it). */
export function topLeft(b: OBox): { x: number; y: number } {
  const m = boxMatrix(b);
  return { x: m.m02, y: m.m12 };
}

/** The box with a new size, its top-left corner (turned with it) kept: the inspector's W / H. */
export function resizedKeepingCorner(b: OBox, w: number, h: number): OBox {
  const tl = topLeft(b);
  const c = Math.cos(b.angle * RAD);
  const s = Math.sin(b.angle * RAD);
  return {
    cx: tl.x + (c * w) / 2 - (s * h) / 2,
    cy: tl.y + (s * w) / 2 + (c * h) / 2,
    w,
    h,
    angle: b.angle,
  };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// --- measured layers ------------------------------------------------------------------------------

/** One layer measured in the live slide document (html/measure.ts). */
export interface MeasuredLayer {
  /** As painted, artboard px. */
  box: OBox;
  /** The layout box's size before transforms (CSS px). */
  layout: { w: number; h: number };
  /** Turn and scale the layer's ancestors add (groups with editor transforms). */
  inherited: { angle: number; scale: number };
  /** Painted: not `display: none`, not zero-sized. (Hidden layers keep their box.) */
  visible: boolean;
}

export type SlideMeasure = Record<string, MeasuredLayer>;

// --- edits ----------------------------------------------------------------------------------------

/** Artboard px with one decimal, within what design-kit accepts. */
export function roundPx(value: number): number {
  const clamped = Math.min(10_000, Math.max(-10_000, value));
  const r = Math.round(clamped * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
}

const round3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
};

export type GeometryMode = "resize" | "scale";

export interface GeometryEdit {
  ops: PatchOpInput[];
  /** Where the layer's top-left corner must end up (artboard px): checked after the render. */
  target: { x: number; y: number };
}

/** Layers whose height follows their text (a vertical drag alone sets a height). */
function autoHeight(layer: Pick<EditorLayer, "type" | "style">): boolean {
  return layer.type === "text" && !layer.style.height;
}

/**
 * The patch operations that turn `layer` (painted as `before`) into `after`:
 * - a moved centre → `translate` (in the parent's frame: the ancestors' turn and scale undone);
 * - a turn → `rotate`;
 * - "resize": a new size → `width` / `height` (the layout size; a text layer with automatic
 *   height only gets a height from a purely vertical drag), the translate keeping the box's
 *   centre where the engine put it (a left/top-anchored layout box grows right and down);
 * - "scale" (the Scale tool): a uniform factor → `scale`.
 */
export function geometryEdit(
  layer: Pick<EditorLayer, "id" | "type" | "style" | "transform">,
  before: MeasuredLayer,
  after: OBox,
  mode: GeometryMode = "resize",
): GeometryEdit {
  const t0 = layer.transform;
  const k = before.inherited.scale || 1;
  const phi = before.inherited.angle * RAD;
  const ops: PatchOpInput[] = [];

  // The centre's move in the parent's frame.
  const dxw = after.cx - before.box.cx;
  const dyw = after.cy - before.box.cy;
  const dx = (Math.cos(phi) * dxw + Math.sin(phi) * dyw) / k;
  const dy = (-Math.sin(phi) * dxw + Math.cos(phi) * dyw) / k;

  let tx = t0.translate.x + dx;
  let ty = t0.translate.y + dy;
  let scale: { x: number; y: number } | null = null;
  let width: number | null = null;
  let height: number | null = null;

  const dw = after.w - before.box.w;
  const dh = after.h - before.box.h;
  if (mode === "scale") {
    const fw = before.box.w > 0 ? after.w / before.box.w : 1;
    const fh = before.box.h > 0 ? after.h / before.box.h : 1;
    const f = Math.abs(dw) >= Math.abs(dh) ? fw : fh;
    if (Math.abs(f - 1) > 1e-3) scale = { x: round3(t0.scale.x * f), y: round3(t0.scale.y * f) };
  } else if (Math.abs(dw) > 0.25 || Math.abs(dh) > 0.25) {
    const sx = (t0.scale.x || 1) * k;
    const sy = (t0.scale.y || 1) * k;
    const lw = after.w / sx;
    const lh = after.h / sy;
    const vertical = Math.abs(dw) <= 0.25;
    if (Math.abs(dw) > 0.25) width = roundPx(lw);
    if (Math.abs(dh) > 0.25 && (!autoHeight(layer) || vertical)) height = roundPx(lh);
    // The layout box grows from its top-left corner: its centre moved by half the growth.
    if (width !== null) tx -= (width - before.layout.w) / 2;
    if (height !== null) ty -= (height - before.layout.h) / 2;
  }

  const turn = normalizeAngle(after.angle - before.box.angle);
  const rotate =
    Math.abs(turn) > 0.05 ? Math.round(normalizeAngle(t0.rotate + turn) * 10) / 10 : null;

  tx = roundPx(tx);
  ty = roundPx(ty);
  const moved = tx !== roundPx(t0.translate.x) || ty !== roundPx(t0.translate.y);
  if (moved || rotate !== null || scale !== null) {
    ops.push({
      op: "transform",
      layer: layer.id,
      ...(moved ? { translate: tx === 0 && ty === 0 ? null : { x: tx, y: ty } } : {}),
      ...(rotate !== null ? { rotate: rotate === 0 ? null : rotate } : {}),
      ...(scale !== null
        ? { scale: scale.x === 1 && scale.y === 1 ? null : scale.x === scale.y ? scale.x : scale }
        : {}),
    });
  }
  if (width !== null || height !== null) {
    ops.push({
      op: "resize",
      layer: layer.id,
      ...(width !== null ? { width: Math.max(0, width) } : {}),
      ...(height !== null ? { height: Math.max(0, height) } : {}),
    });
  }
  return { ops, target: topLeft(after) };
}

/** A move by (dx, dy) artboard px as a translate (nudges, "move into the safe area"). */
export function moveOps(
  layer: Pick<EditorLayer, "id" | "transform">,
  before: MeasuredLayer,
  dx: number,
  dy: number,
): PatchOpInput[] {
  return geometryEdit({ ...layer, type: "shape", style: {} }, before, {
    ...before.box,
    cx: before.box.cx + dx,
    cy: before.box.cy + dy,
  }).ops;
}

/** Inline CSS for the live preview of an edit (applied to the element while a gesture runs). */
export function previewStyle(ops: readonly PatchOpInput[]): Record<string, string | null> {
  const css: Record<string, string | null> = {};
  for (const op of ops) {
    if (op.op === "transform") {
      if (op.translate !== undefined)
        css.translate = op.translate ? `${op.translate.x}px ${op.translate.y}px` : null;
      if (op.rotate !== undefined) css.rotate = op.rotate ? `${op.rotate}deg` : null;
      if (op.scale !== undefined)
        css.scale =
          op.scale === null
            ? null
            : typeof op.scale === "number"
              ? String(op.scale)
              : `${op.scale.x} ${op.scale.y}`;
    } else if (op.op === "resize") {
      if (op.width !== undefined) css.width = op.width === null ? null : `${op.width}px`;
      if (op.height !== undefined) css.height = op.height === null ? null : `${op.height}px`;
    }
  }
  return css;
}
