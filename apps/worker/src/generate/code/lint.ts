/**
 * Linting a code engine slide (docs/URETIM-RESIM.md, Faz 4) from what `studio_brand` recorded:
 * every `text` box with its font, size, colour and the background under it, the pictures and the
 * image slots. The same measures and rule ids as the SVG engine (`lintSvgInspection`: outside the
 * artboard, safe area, minimum size, brand font, overlaps, allowed numbers, slot ratio) plus
 * contrast from the recorded background (WCAG, design-kit's thresholds) and text wider than the
 * width it was wrapped to. Output checks (the PNG exists, has the artboard size, is not blank)
 * are failures of the slide, not lint findings.
 */
import { CONTRACT_LIMITS } from "@studio/design-kit/contract";
import {
  buildReport,
  contrastRatio,
  issue,
  type LintConfig,
  type LintIssue,
  type LintReport,
} from "@studio/design-kit/lint";
import sharp from "sharp";
import { lintSvgInspection, type SvgInspection } from "../svg/render.ts";
import type { CodeSlideRecord } from "./document.ts";

function parseRgb(css: string): { rgb: number[]; a: number } | null {
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(css.trim());
  if (!m) return null;
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] ? Number(m[4]) : 1 };
}

/** A slide's record → the inspection shape the SVG lint reads. */
export function inspectionOf(
  record: CodeSlideRecord | null,
  size: { width: number; height: number } | null,
): SvgInspection {
  const r = record ?? { texts: [], images: [], slots: [], fonts: [] };
  return {
    root: size,
    texts: r.texts.map((t) => ({
      id: t.id,
      text: t.text,
      rect: t.rect,
      fontSize: t.fontSize,
      minFontSize: t.fontSize,
      weight: t.weight,
      family: t.family,
      color: t.color,
      lines: t.lines,
      legal: t.legal,
      allowOverlap: false,
      runs: [{ color: t.color, fontSize: t.fontSize, weight: t.weight, rects: [t.rect] }],
    })),
    images: r.images.map((m) => ({
      href: m.kind === "logo" ? `/brand/logos/${m.name}` : `/media/${m.name}`,
      rect: m.rect,
      preserve: m.fit === "stretch" ? "none" : "xMidYMid",
      slot: null,
    })),
    slots: r.slots.map((s) => ({
      id: s.id,
      state: s.state,
      ratio: s.ratio,
      label: s.label,
      rect: s.rect,
    })),
    fonts: r.fonts,
  };
}

/** The lint report of one code slide. */
export function lintCodeSlide(
  record: CodeSlideRecord | null,
  config: LintConfig,
  size: { width: number; height: number } | null = { width: config.width, height: config.height },
): LintReport {
  const base = lintSvgInspection(inspectionOf(record, size), config);
  const issues: LintIssue[] = [...base.issues];
  const layers = base.layers.map((l) => ({ ...l }));
  for (const t of record?.texts ?? []) {
    if (t.maxWidth && t.rect.w > t.maxWidth + 2)
      issues.push(
        issue(
          "text-overflow-box",
          t.id,
          `“${t.text.slice(0, 40)}” is ${Math.round(t.rect.w)}px wide but was wrapped to ${Math.round(t.maxWidth)}px (a word longer than the line): make it smaller or break it.`,
        ),
      );
    const color = parseRgb(t.color);
    if (!t.background || !color) continue;
    const blend = (bg: readonly number[]) =>
      color.rgb.map((c, k) => c * color.a + (bg[k] as number) * (1 - color.a));
    const median = contrastRatio(blend(t.background.median), t.background.median);
    const worst = Math.min(
      contrastRatio(blend(t.background.dark), t.background.dark),
      contrastRatio(blend(t.background.light), t.background.light),
    );
    const bold = Number(t.weight) >= 700;
    const large =
      t.fontSize >= CONTRACT_LIMITS.largeFontSize ||
      (t.fontSize >= CONTRACT_LIMITS.largeBoldFontSize && bold);
    const required = large ? CONTRACT_LIMITS.contrastLarge : CONTRACT_LIMITS.contrastNormal;
    const result = {
      median: Number(median.toFixed(2)),
      worst: Number(worst.toFixed(2)),
      required,
      background: `rgb(${t.background.median.join(",")})`,
    };
    const layer = layers.find((l) => l.id === t.id && l.text);
    if (layer?.text) layer.text = { ...layer.text, contrast: result };
    if (result.median < required)
      issues.push(
        issue(
          "contrast",
          t.id,
          `Contrast ${result.median.toFixed(2)}:1 against its background (needs ${required}:1 for ${large ? "large" : "normal"} text).`,
          { ...result },
        ),
      );
    else if (result.worst < required)
      issues.push(
        issue(
          "contrast-busy-background",
          t.id,
          `Contrast drops to ${result.worst.toFixed(2)}:1 on parts of the background (median ${result.median.toFixed(2)}:1).`,
          { ...result },
        ),
      );
  }
  return buildReport({
    config,
    issues,
    layers,
    stages: { static: true, layout: true, pixel: true, render: true },
    ...(base.fontsLoaded ? { fontsLoaded: base.fontsLoaded } : {}),
  });
}

export interface PngCheck {
  width: number;
  height: number;
  /** The slide is one flat colour (nothing drawn). */
  blank: boolean;
}

/** Size and blankness of a slide PNG. */
export async function inspectPng(png: Uint8Array): Promise<PngCheck> {
  const image = sharp(png);
  const meta = await image.metadata();
  const stats = await image.stats();
  const spread = Math.max(...stats.channels.slice(0, 3).map((c) => c.stdev));
  return { width: meta.width ?? 0, height: meta.height ?? 0, blank: spread < 0.5 };
}
