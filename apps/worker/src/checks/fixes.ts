/**
 * Automatic fixes of the generation checks: a fixable layout finding becomes one design-kit
 * patch op on its slide, computed from what the renderer measured.
 *
 * - text that overflows its box / is clipped → `setTypography` with a smaller font size
 *   (never below the contract minimum, 24 px; legal text 20 px),
 * - a text or logo outside the safe area (or cut by the artboard edge) → `transform` that moves
 *   it inside (shrinks the text instead when it is wider / taller than the safe area),
 * - text with too little contrast → `setColor` to the brand colour token with the best contrast
 *   against the measured background (only when that one is enough).
 */
import { parseSlide } from "@studio/design-kit/document";
import { contrastRatio, type LintReport, parseComputedColor } from "@studio/design-kit/lint";
import type { PatchOpInput } from "@studio/design-kit/patch";

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FixContext {
  html: string;
  report: LintReport;
  width: number;
  height: number;
  safe: SafeArea;
  /** Brand colour tokens: name → `#RRGGBB`. */
  colors: Readonly<Record<string, string>>;
}

export interface FixTarget {
  checkId: string;
  refs: readonly { slide: number | null; layer: string | null }[];
  evidence: Record<string, unknown> | null;
}

export interface SlideFix {
  /** `setTypography` / `transform` / `setColor`. */
  kind: "shrink" | "move" | "recolor";
  layer: string;
  op: PatchOpInput;
  /** Turkish, for the version note and the "fixed" result. */
  description: string;
}

const MIN_FONT = 24;
const LEGAL_MIN_FONT = 20;

const ruleOf = (t: FixTarget) =>
  typeof t.evidence?.rule === "string" ? (t.evidence.rule as string) : "";

function metricsOf(report: LintReport, layer: string) {
  return report.layers.find((l) => l.id === layer);
}

function shrink(ctx: FixContext, layer: string, factor: number): SlideFix | null {
  const m = metricsOf(ctx.report, layer);
  const size = m?.text?.fontSize;
  if (!m || !size || !Number.isFinite(size)) return null;
  const floor = m.role === "legal" ? LEGAL_MIN_FONT : MIN_FONT;
  const next = Math.max(floor, Math.floor(size * Math.min(0.95, Math.max(0.6, factor))));
  if (next >= size) return null;
  return {
    kind: "shrink",
    layer,
    op: { op: "setTypography", layer, fontSize: next },
    description: `"${layer}" yazısı ${round(size)} → ${next} px küçültüldü`,
  };
}

/** How much smaller the font must get for the text to fit its own box (area ∝ size²). */
function fitFactor(ctx: FixContext, layer: string): number {
  const m = metricsOf(ctx.report, layer);
  const box = m?.rect;
  const text = m?.text?.textRect;
  if (!box || !text || text.h <= 0 || text.w <= 0) return 0.88;
  const byHeight = text.h > box.h ? Math.sqrt(box.h / text.h) : 1;
  const byWidth = text.w > box.w ? box.w / text.w : 1;
  const f = Math.min(byHeight, byWidth) * 0.96;
  return f >= 0.97 ? 0.92 : f;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function move(ctx: FixContext, layer: string): SlideFix | null {
  const m = metricsOf(ctx.report, layer);
  if (!m) return null;
  const isText = m.type === "text";
  const box = (isText ? m.text?.textRect : null) ?? m.rect;
  if (!box) return null;
  const { safe } = ctx;
  const left = safe.left;
  const right = ctx.width - safe.right;
  const top = safe.top;
  const bottom = ctx.height - safe.bottom;
  if (box.w > right - left || box.h > bottom - top) {
    if (!isText) return null;
    const factor = Math.min((right - left) / box.w, (bottom - top) / box.h) * 0.95;
    return shrink(ctx, layer, factor);
  }
  const margin = 2;
  let dx = 0;
  let dy = 0;
  if (box.x < left) dx = left - box.x + margin;
  else if (box.x + box.w > right) dx = right - (box.x + box.w) - margin;
  if (box.y < top) dy = top - box.y + margin;
  else if (box.y + box.h > bottom) dy = bottom - (box.y + box.h) - margin;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return null;
  const current = parseSlide(ctx.html).model.layers.find((l) => l.id === layer);
  if (!current) return null;
  const t = current.transform.translate ?? { x: 0, y: 0 };
  const x = Math.round(t.x + dx);
  const y = Math.round(t.y + dy);
  return {
    kind: "move",
    layer,
    op: { op: "transform", layer, translate: { x, y } },
    description: `"${layer}" güvenli alana taşındı (${dx ? `${dx > 0 ? "+" : ""}${Math.round(dx)} px yatay` : ""}${dx && dy ? ", " : ""}${dy ? `${dy > 0 ? "+" : ""}${Math.round(dy)} px dikey` : ""})`,
  };
}

function recolor(
  ctx: FixContext,
  layer: string,
  evidence: Record<string, unknown>,
): SlideFix | null {
  const bg =
    typeof evidence.background === "string" ? parseComputedColor(evidence.background) : null;
  const required = typeof evidence.required === "number" ? evidence.required : 4.5;
  if (!bg) return null;
  let best: { name: string; ratio: number } | null = null;
  for (const [name, hex] of Object.entries(ctx.colors)) {
    const rgb = hexRgb(hex);
    if (!rgb) continue;
    const ratio = contrastRatio(rgb, bg.rgb);
    if (!best || ratio > best.ratio) best = { name, ratio };
  }
  if (!best || best.ratio < required) return null;
  return {
    kind: "recolor",
    layer,
    op: { op: "setColor", layer, property: "color", value: { token: best.name } },
    description: `"${layer}" rengi "${best.name}" yapıldı (kontrast ${best.ratio.toFixed(1)}:1)`,
  };
}

export function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m?.[1]) return null;
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The fix of one finding on its slide, or `null` when it cannot be fixed automatically. */
export function slideFixFor(target: FixTarget, ctx: FixContext): SlideFix | null {
  const layer = target.refs.find((r) => r.layer)?.layer;
  if (!layer) return null;
  const rule = ruleOf(target);
  switch (target.checkId) {
    case "layout.overflow":
      if (rule === "text-overflow-box" || rule === "text-clipped")
        return shrink(ctx, layer, fitFactor(ctx, layer));
      if (rule === "text-outside-artboard") return move(ctx, layer);
      return null;
    case "layout.safe-area":
      return move(ctx, layer);
    case "layout.contrast":
      return rule === "contrast" && target.evidence ? recolor(ctx, layer, target.evidence) : null;
    default:
      return null;
  }
}

/**
 * One op per layer and kind: two shrinks of the same layer keep the smaller size; moves and
 * colours keep the first.
 */
export function mergeSlideFixes(fixes: readonly SlideFix[]): SlideFix[] {
  const out = new Map<string, SlideFix>();
  for (const f of fixes) {
    const key = `${f.layer}|${f.kind}`;
    const prev = out.get(key);
    if (!prev) {
      out.set(key, f);
      continue;
    }
    if (f.kind === "shrink" && prev.kind === "shrink") {
      const a = (prev.op as { fontSize: number }).fontSize;
      const b = (f.op as { fontSize: number }).fontSize;
      if (b < a) out.set(key, f);
    }
  }
  return [...out.values()];
}
