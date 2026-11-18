/**
 * Layer geometry of a rendered slide: the renderer's lint report measures every
 * `[data-layer]` element (border box in artboard px, transforms included); the
 * apps draw editor selection boxes from it. Stored per slide with the render.
 */
import { MAX_SLIDE_LAYOUT_LAYERS, type SlideLayout } from "@studio/contract";
import type { LintReport } from "@studio/design-kit/lint";

const round = (n: number) => Math.round(n * 100) / 100;

/** `null` when the report has no layout stage (nothing was measured). */
export function layoutFromReport(report: LintReport | null | undefined): SlideLayout | null {
  if (!report?.stages.layout) return null;
  const out: SlideLayout = [];
  for (const layer of report.layers) {
    if (!layer.id || !layer.rect) continue;
    const { x, y, w, h } = layer.rect;
    if (![x, y, w, h].every(Number.isFinite)) continue;
    out.push({
      id: layer.id.slice(0, 64),
      type: (layer.type ?? "").slice(0, 16),
      role: layer.role ? layer.role.slice(0, 32) : null,
      parent: layer.parent ? layer.parent.slice(0, 64) : null,
      x: round(x),
      y: round(y),
      w: round(Math.max(0, w)),
      h: round(Math.max(0, h)),
      visible: layer.visible,
    });
    if (out.length >= MAX_SLIDE_LAYOUT_LAYERS) break;
  }
  return out;
}

/** System font families the linter found not installed on this Mac (`font-missing`), once each. */
export function missingSystemFonts(reports: readonly (LintReport | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const report of reports) {
    for (const issue of report?.issues ?? []) {
      const family = issue.data?.family;
      if (issue.rule === "font-missing" && typeof family === "string") out.add(family);
    }
  }
  return [...out];
}
