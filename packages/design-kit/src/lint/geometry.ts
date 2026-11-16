/**
 * Geometry checks computed from the boxes the in-page script measured. Pure functions,
 * so they are unit-tested without a browser.
 */
import type { InPageBox, InPageRect } from "./inpage.ts";
import { DEFAULT_VOID, issue, type LintIssue, type SafeArea, type VoidOptions } from "./report.ts";

const intersects = (a: InPageRect, b: InPageRect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const containsRect = (outer: InPageRect, inner: InPageRect) =>
  outer.x <= inner.x &&
  outer.y <= inner.y &&
  outer.x + outer.w >= inner.x + inner.w &&
  outer.y + outer.h >= inner.y + inner.h;

/**
 * Largest axis-aligned rectangle inside `area` that no box touches, on a `cell`-px grid
 * (maximal rectangle in a binary matrix, histogram method, O(rows × cols)).
 */
export function largestEmptyRect(
  boxes: readonly InPageRect[],
  area: InPageRect,
  cell: number,
): InPageRect | null {
  const cols = Math.max(1, Math.floor(area.w / cell));
  const rows = Math.max(1, Math.floor(area.h / cell));
  const occupied = new Uint8Array(rows * cols);
  for (const b of boxes) {
    const c0 = Math.max(0, Math.floor((b.x - area.x) / cell));
    const c1 = Math.min(cols - 1, Math.ceil((b.x + b.w - area.x) / cell) - 1);
    const r0 = Math.max(0, Math.floor((b.y - area.y) / cell));
    const r1 = Math.min(rows - 1, Math.ceil((b.y + b.h - area.y) / cell) - 1);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) occupied[r * cols + c] = 1;
  }
  const heights = new Int32Array(cols);
  let best: { area: number; r: number; c: number; w: number; h: number } | null = null;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++)
      heights[c] = occupied[r * cols + c] ? 0 : (heights[c] as number) + 1;
    const stack: number[] = [];
    for (let c = 0; c <= cols; c++) {
      const h = c === cols ? 0 : (heights[c] as number);
      while (stack.length && (heights[stack[stack.length - 1] as number] as number) >= h) {
        const top = stack.pop() as number;
        const height = heights[top] as number;
        const left = stack.length ? (stack[stack.length - 1] as number) + 1 : 0;
        const width = c - left;
        const a = width * height;
        if (height > 0 && (!best || a > best.area))
          best = { area: a, r: r - height + 1, c: left, w: width, h: height };
      }
      stack.push(c);
    }
  }
  if (!best) return null;
  return {
    x: area.x + best.c * cell,
    y: area.y + best.r * cell,
    w: best.w * cell,
    h: best.h * cell,
  };
}

/** `large-void`: a big empty area inside the safe area (the spike's critique pass often only moved it). */
export function voidIssues(
  boxes: readonly InPageBox[],
  size: { width: number; height: number },
  safe: SafeArea,
  options: Partial<VoidOptions> = {},
): LintIssue[] {
  const o = { ...DEFAULT_VOID, ...options };
  const area = {
    x: safe.left,
    y: safe.top,
    w: size.width - safe.left - safe.right,
    h: size.height - safe.top - safe.bottom,
  };
  if (area.w <= 0 || area.h <= 0) return [];
  const content = boxes.filter((b) => b.kind !== "background").map((b) => b.rect);
  const empty = largestEmptyRect(content, area, o.cell);
  if (!empty) return [];
  const share = (empty.w * empty.h) / (area.w * area.h);
  if (
    share < o.minAreaRatio ||
    empty.w < o.minSideRatio * area.w ||
    empty.h < o.minSideRatio * area.h
  )
    return [];
  return [
    issue(
      "large-void",
      null,
      `Empty area of ${empty.w}x${empty.h}px at (${empty.x}, ${empty.y}) covers ${Math.round(share * 100)}% of the safe area. Use it deliberately (scale up the focal element, move the copy) or tighten the layout.`,
      { rect: empty, share: Number(share.toFixed(3)) },
    ),
  ];
}

export interface LogoBox {
  id: string;
  src: string;
  rect: InPageRect;
}

/**
 * `logo-clear-space`: no text, logo, slot or shape within `k × logo height` of a logo,
 * except backgrounds the logo sits on (boxes that contain it). `k` defaults to 0.5.
 */
export function clearSpaceIssues(
  logos: readonly LogoBox[],
  boxes: readonly InPageBox[],
  options: { defaultRatio?: number; byPath?: Readonly<Record<string, number>> } = {},
): LintIssue[] {
  const out: LintIssue[] = [];
  for (const logo of logos) {
    const path = logo.src.startsWith("/brand/") ? logo.src.slice("/brand/".length) : logo.src;
    const k = options.byPath?.[path] ?? options.defaultRatio ?? 0.5;
    const space = k * logo.rect.h;
    if (space <= 0) continue;
    const zone = {
      x: logo.rect.x - space,
      y: logo.rect.y - space,
      w: logo.rect.w + 2 * space,
      h: logo.rect.h + 2 * space,
    };
    const intruders = new Map<string, number>();
    for (const b of boxes) {
      // Photos are not intruders: their box says nothing about where the subject is
      // (a logo over a photo, or a cut-out product on white, is fine).
      if (b.layer === logo.id || b.kind === "background" || b.kind === "image") continue;
      if (containsRect(b.rect, logo.rect)) continue;
      if (!intersects(b.rect, zone)) continue;
      const dx = Math.max(
        0,
        b.rect.x - (logo.rect.x + logo.rect.w),
        logo.rect.x - (b.rect.x + b.rect.w),
      );
      const dy = Math.max(
        0,
        b.rect.y - (logo.rect.y + logo.rect.h),
        logo.rect.y - (b.rect.y + b.rect.h),
      );
      const d = Math.round(Math.max(dx, dy));
      intruders.set(b.layer, Math.min(intruders.get(b.layer) ?? Number.POSITIVE_INFINITY, d));
    }
    if (intruders.size) {
      const list = [...intruders.entries()].sort((a, b) => a[1] - b[1]);
      out.push(
        issue(
          "logo-clear-space",
          logo.id,
          `Logo needs ${Math.round(space)}px clear space; ${list.map(([id, d]) => `"${id}" is ${d}px away`).join(", ")}.`,
          { required: Math.round(space), intruders: Object.fromEntries(list) },
        ),
      );
    }
  }
  return out;
}
