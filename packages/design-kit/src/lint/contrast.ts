/**
 * Pixel-measured contrast (contract §7): text often sits on photos, gradients and tints,
 * so the background is measured from a render with all text made transparent. Each text
 * run (text node with its own colour) is measured on its own, so an accent-coloured word
 * inside a headline is checked too (the spike only measured the layer's main colour).
 */
import { CONTRACT_LIMITS } from "../contract/constants.ts";
import type { InPageText } from "./inpage.ts";
import type { Raster } from "./raster.ts";
import { issue, type LintIssue } from "./report.ts";

export type { Raster } from "./raster.ts";

export interface ContrastResult {
  median: number;
  worst: number;
  required: number;
  background: string;
}

export function relativeLuminance([r, g, b]: readonly number[]): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r ?? 0) + 0.7152 * f(g ?? 0) + 0.0722 * f(b ?? 0);
}

export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Parse a computed colour: `rgb()`, `rgba()` or `color(srgb r g b / a)`. */
export function parseComputedColor(s: string): { rgb: [number, number, number]; a: number } | null {
  const m = /^rgba?\(([^)]+)\)$/.exec(s.trim());
  if (m) {
    const p = (m[1] ?? "")
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
    return {
      rgb: [p[0] as number, p[1] as number, p[2] as number],
      a: p.length > 3 ? (p[3] as number) : 1,
    };
  }
  const c = /^color\(srgb\s+([^)]+)\)$/.exec(s.trim());
  if (c) {
    const [rgbPart, alphaPart] = (c[1] ?? "").split("/");
    const p = (rgbPart ?? "").trim().split(/\s+/).map(Number);
    if (p.length !== 3 || p.some((n) => Number.isNaN(n))) return null;
    const a = alphaPart === undefined ? 1 : Number(alphaPart.trim());
    return {
      rgb: [
        Math.round((p[0] as number) * 255),
        Math.round((p[1] as number) * 255),
        Math.round((p[2] as number) * 255),
      ],
      a: Number.isNaN(a) ? 1 : a,
    };
  }
  return null;
}

/**
 * Measure every text layer against the text-free raster. `scale` maps CSS px to raster px
 * (the raster is captured at CSS scale by the renderer, so normally 1).
 */
export function measureContrast(
  text: readonly InPageText[],
  raster: Raster,
  scale = 1,
): { issues: LintIssue[]; byLayer: Map<string, ContrastResult> } {
  const issues: LintIssue[] = [];
  const byLayer = new Map<string, ContrastResult>();
  for (const t of text) {
    if (t.clipText) {
      issues.push(
        issue("contrast-unknown", t.id, "Text colour could not be measured (gradient/clip text)."),
      );
      continue;
    }
    let worstRun: (ContrastResult & { large: boolean }) | null = null;
    let unknown = false;
    for (const run of t.runs.length
      ? t.runs
      : [{ color: t.color, fontSize: t.fontSize, weight: t.weight, rects: t.lineRects }]) {
      const tc = parseComputedColor(run.color);
      if (!tc) {
        unknown = true;
        continue;
      }
      const px: [number, number, number][] = [];
      for (const r of run.rects) {
        const y0 = Math.max(0, Math.round((r.y + 1) * scale));
        const y1 = Math.min(raster.height, Math.round((r.y + r.h - 1) * scale));
        const x0 = Math.max(0, Math.round((r.x + 1) * scale));
        const x1 = Math.min(raster.width, Math.round((r.x + r.w - 1) * scale));
        for (let y = y0; y < y1; y += 2)
          for (let x = x0; x < x1; x += 2) {
            const i = (y * raster.width + x) * raster.channels;
            px.push([
              raster.data[i] as number,
              raster.data[i + 1] as number,
              raster.data[i + 2] as number,
            ]);
          }
      }
      if (!px.length) continue;
      const order = px
        .map((c, i) => [relativeLuminance(c), i] as const)
        .sort((a, b) => a[0] - b[0]);
      const pick = (q: number) =>
        px[(order[Math.floor(q * (order.length - 1))] as readonly [number, number])[1]] as [
          number,
          number,
          number,
        ];
      const bgMed = pick(0.5);
      const bgDark = pick(0.05);
      const bgLight = pick(0.95);
      const blend = (bg: readonly number[]) =>
        tc.rgb.map((c, k) => c * tc.a + (bg[k] as number) * (1 - tc.a));
      const median = contrastRatio(blend(bgMed), bgMed);
      const worst = Math.min(
        contrastRatio(blend(bgDark), bgDark),
        contrastRatio(blend(bgLight), bgLight),
      );
      const bold = Number(run.weight) >= 700;
      const large =
        run.fontSize >= CONTRACT_LIMITS.largeFontSize ||
        (run.fontSize >= CONTRACT_LIMITS.largeBoldFontSize && bold);
      const required = large ? CONTRACT_LIMITS.contrastLarge : CONTRACT_LIMITS.contrastNormal;
      const res = {
        median: Number(median.toFixed(2)),
        worst: Number(worst.toFixed(2)),
        required,
        background: `rgb(${bgMed.join(",")})`,
        large,
      };
      if (!worstRun || res.median / res.required < worstRun.median / worstRun.required)
        worstRun = res;
    }
    if (!worstRun) {
      if (unknown)
        issues.push(
          issue("contrast-unknown", t.id, `Text colour "${t.color}" could not be measured.`),
        );
      continue;
    }
    const { large, ...result } = worstRun;
    byLayer.set(t.id, result);
    if (result.median < result.required)
      issues.push(
        issue(
          "contrast",
          t.id,
          `Contrast ${result.median.toFixed(2)}:1 against its background (needs ${result.required}:1 for ${large ? "large" : "normal"} text).`,
          { ...result },
        ),
      );
    else if (result.worst < result.required)
      issues.push(
        issue(
          "contrast-busy-background",
          t.id,
          `Contrast drops to ${result.worst.toFixed(2)}:1 on parts of the background (median ${result.median.toFixed(2)}:1).`,
          { ...result },
        ),
      );
  }
  return { issues, byLayer };
}
