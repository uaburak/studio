/**
 * The checks of a canvas slide (saved from Wecra's editor), from its facts and its render:
 * the same rules and report as `lintSlide` gives a rendered HTML slide, so the generation checks
 * treat both alike. What Chromium measures in an HTML slide comes here from Wecra's own layout
 * (the text engine's lines, overflow and truncation, missing fonts, boxes in paint order), and
 * contrast from the PNG's pixels under each text (the text's own ink is told apart by its
 * colour and left out, so what is measured is the background it sits on).
 *
 * The slide HTML's static rules run too (numbers against the facts, slots, structure): its
 * layers are the facts' layers (`layers.ts`), so a finding names the HTML's layer.
 */
import { CONTRACT_LIMITS } from "../contract/constants.ts";
import { parseSlide } from "../document/model.ts";
import { contrastRatio, type Raster, relativeLuminance } from "../lint/contrast.ts";
import { clearSpaceIssues } from "../lint/geometry.ts";
import type { InPageBox, InPageRect } from "../lint/inpage.ts";
import {
  buildReport,
  issue,
  type LayerMetrics,
  type LintConfig,
  type LintIssue,
  type LintReport,
  resolveSafeArea,
} from "../lint/report.ts";
import { staticLint } from "../lint/static.ts";
import type { CanvasFacts, CanvasLine, CanvasNode, CanvasText } from "./facts.ts";
import { CANVAS_RENDER_LAYER, type CanvasLayer, canvasLayers, isPainted } from "./layers.ts";

export interface CanvasLintInput {
  /** The slide HTML (`canvasSlideHtml`). */
  html: string;
  facts: CanvasFacts;
  /** The slide's render (the PNG, decoded); `null`: the pixel rules are not measured. */
  raster: Raster | null;
}

type Rect = InPageRect;

const union = (rects: readonly Rect[]): Rect => {
  const x0 = Math.min(...rects.map((r) => r.x));
  const y0 = Math.min(...rects.map((r) => r.y));
  const x1 = Math.max(...rects.map((r) => r.x + r.w));
  const y1 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const inter = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
const within = (outer: Rect, inner: Rect, tol = 1) =>
  inner.x >= outer.x - tol &&
  inner.y >= outer.y - tol &&
  inner.x + inner.w <= outer.x + outer.w + tol &&
  inner.y + inner.h <= outer.y + outer.h + tol;
const roundRect = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  w: Math.round(r.w),
  h: Math.round(r.h),
});
const hexRgb = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];
const rgbCss = (hex: string) => `rgb(${hexRgb(hex).join(", ")})`;

/** A text's lines with glyphs (its box when Wecra gave none). */
function linesOf(n: CanvasNode, t: CanvasText): CanvasLine[] {
  // Empty lines (a blank paragraph, a trailing line break) have no glyphs to check.
  const inked = t.lines.filter((l) => l.w > 0.5 && t.characters.slice(l.from, l.to).trim());
  return inked.length ? inked : [{ ...n.bounds, from: 0, to: t.characters.length }];
}

/** The middle band of a line box (where the glyphs are), as the HTML linter measures text. */
const core = (l: Rect): Rect => ({ x: l.x, y: l.y + 0.14 * l.h, w: l.w, h: 0.72 * l.h });

function sizes(t: CanvasText): { min: number; max: number; bold: boolean } {
  const all = [t, ...t.runs];
  return {
    min: Math.min(...all.map((r) => r.size)),
    max: Math.max(...all.map((r) => r.size)),
    bold: all.some((r) => r.weight >= 700),
  };
}

/** Does a layer paint its whole box opaquely (a fill that hides what is under it)? */
function coversOpaquely(n: CanvasNode): boolean {
  if (n.type === "text" || n.type === "group" || !isPainted(n) || n.effectiveOpacity <= 0.5)
    return false;
  return n.fills.some(
    (p) =>
      (p.type === "solid" && p.opacity * n.effectiveOpacity > 0.5) ||
      (p.type === "image" && p.opacity * n.effectiveOpacity > 0.5),
  );
}

// ---------- contrast from the render ----------

interface ContrastOut {
  median: number;
  worst: number;
  required: number;
  background: string;
  large: boolean;
}

const dist = (a: readonly number[], b: readonly number[]) =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
const blend = (c: readonly number[], bg: readonly number[], a: number) =>
  c.map((v, k) => v * a + (bg[k] ?? 0) * (1 - a));

/** Pixels closer than this (RGB distance) to the text's own colour are its ink. */
const INK_DISTANCE = 56;

/**
 * The contrast of one text against what is under it in the render: the pixels of its line
 * boxes, without its ink (pixels of its colour, grown by a couple of pixels for the
 * anti-aliased edges). When nearly everything is "ink", the background is the text's colour.
 */
export function canvasTextContrast(
  layer: CanvasLayer,
  raster: Raster,
): ContrastOut | "unknown" | null {
  const n = layer.node;
  const t = n.text;
  if (!t) return null;
  const runs: { color: string | null; opacity: number; size: number; weight: number }[] = t.runs
    .length
    ? t.runs
    : [{ color: t.color, opacity: t.fills[0]?.opacity ?? 1, size: t.size, weight: t.weight }];
  const colours: { rgb: [number, number, number]; alpha: number; size: number; weight: number }[] =
    [];
  for (const r of runs) {
    if (!r.color) continue;
    const alpha = Math.max(0, Math.min(1, r.opacity * n.effectiveOpacity));
    if (alpha > 0.05) colours.push({ rgb: hexRgb(r.color), alpha, size: r.size, weight: r.weight });
  }
  if (!colours.length) return t.fills.length ? "unknown" : null;
  const clip = { x: 0, y: 0, w: raster.width, h: raster.height };
  const rects = linesOf(n, t)
    .map((l) => {
      const c = n.clip ? intersect(l, n.clip) : l;
      return c ? intersect(c, clip) : null;
    })
    .filter((r): r is Rect => !!r && r.w >= 1 && r.h >= 1)
    .map((r) => ({
      x0: Math.max(0, Math.floor(r.x)),
      y0: Math.max(0, Math.floor(r.y)),
      x1: Math.min(raster.width, Math.ceil(r.x + r.w)),
      y1: Math.min(raster.height, Math.ceil(r.y + r.h)),
    }))
    .filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  if (!rects.length) return null;
  const { data, channels, width } = raster;
  const at = (x: number, y: number): [number, number, number] => {
    const i = (y * width + x) * channels;
    return [data[i] as number, data[i + 1] as number, data[i + 2] as number];
  };
  // The most common colour of the boxes (what the ink is blended with when it is translucent).
  const hist = new Map<number, { n: number; sum: [number, number, number] }>();
  for (const r of rects)
    for (let y = r.y0; y < r.y1; y += 2)
      for (let x = r.x0; x < r.x1; x += 2) {
        const p = at(x, y);
        const key = ((p[0] >> 4) << 8) | ((p[1] >> 4) << 4) | (p[2] >> 4);
        const e = hist.get(key) ?? { n: 0, sum: [0, 0, 0] };
        e.n++;
        e.sum[0] += p[0];
        e.sum[1] += p[1];
        e.sum[2] += p[2];
        hist.set(key, e);
      }
  let mode: [number, number, number] = [255, 255, 255];
  let best = 0;
  for (const e of hist.values())
    if (e.n > best) {
      best = e.n;
      mode = [e.sum[0] / e.n, e.sum[1] / e.n, e.sum[2] / e.n];
    }
  const inks = colours.map((c) => (c.alpha >= 0.95 ? c.rgb : blend(c.rgb, mode, c.alpha)));
  const grow = Math.max(...colours.map((c) => c.size)) >= 80 ? 3 : 2;
  const bg: [number, number, number][] = [];
  let total = 0;
  for (const r of rects) {
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    const ink = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = at(r.x0 + x, r.y0 + y);
        if (inks.some((k) => dist(p, k) < INK_DISTANCE)) ink[y * w + x] = 1;
      }
    // Grow the ink (anti-aliased edges are a mix of ink and background).
    const near = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!ink[y * w + x]) continue;
        for (let dy = -grow; dy <= grow; dy++)
          for (let dx = -grow; dx <= grow; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1;
          }
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        total++;
        if (!near[y * w + x]) bg.push(at(r.x0 + x, r.y0 + y));
      }
  }
  let sample = bg;
  if (sample.length < Math.max(8, total * 0.08)) {
    // Almost all of it looks like the text's colour: that is the background.
    sample = [];
    for (const r of rects)
      for (let y = r.y0; y < r.y1; y += 2)
        for (let x = r.x0; x < r.x1; x += 2) sample.push(at(x, y));
  }
  if (!sample.length) return null;
  const order = sample.map((c) => relativeLuminance(c)).map((l, i) => [l, i] as const);
  order.sort((a, b) => a[0] - b[0]);
  const pick = (q: number) =>
    sample[(order[Math.floor(q * (order.length - 1))] as readonly [number, number])[1]] as [
      number,
      number,
      number,
    ];
  const med = pick(0.5).map(Math.round) as [number, number, number];
  const dark = pick(0.05);
  const light = pick(0.95);
  let worstRun: ContrastOut | null = null;
  for (const c of colours) {
    const median = contrastRatio(blend(c.rgb, med, c.alpha), med);
    const worst = Math.min(
      contrastRatio(blend(c.rgb, dark, c.alpha), dark),
      contrastRatio(blend(c.rgb, light, c.alpha), light),
    );
    const large =
      c.size >= CONTRACT_LIMITS.largeFontSize ||
      (c.size >= CONTRACT_LIMITS.largeBoldFontSize && c.weight >= 700);
    const required = large ? CONTRACT_LIMITS.contrastLarge : CONTRACT_LIMITS.contrastNormal;
    const res = {
      median: Number(median.toFixed(2)),
      worst: Number(worst.toFixed(2)),
      required,
      background: `rgb(${med.join(",")})`,
      large,
    };
    if (!worstRun || res.median / res.required < worstRun.median / worstRun.required)
      worstRun = res;
  }
  return worstRun;
}

function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

// ---------- the report ----------

/** The lint report of a canvas slide (see the top). `config` as for `lintSlide`. */
export function lintCanvasSlide(input: CanvasLintInput, config: LintConfig): LintReport {
  const { facts, raster } = input;
  const doc = parseSlide(input.html);
  const st = staticLint(doc, config);
  const issues: LintIssue[] = [...st.issues];
  const add = (i: LintIssue) => issues.push(i);
  const W = facts.frame.width;
  const H = facts.frame.height;
  const frame: Rect = { x: 0, y: 0, w: W, h: H };
  const safe = resolveSafeArea(config.safeArea);
  const layers = canvasLayers(facts);
  const texts = layers.filter((l) => l.type === "text" && l.node.text);
  const order = new Map(facts.nodes.map((n, i) => [n.id, i]));

  if (raster && (raster.width !== Math.round(W) || raster.height !== Math.round(H)))
    add(
      issue(
        "artboard-size",
        null,
        `The render is ${raster.width}x${raster.height}, the slide ${Math.round(W)}x${Math.round(H)}.`,
      ),
    );

  const safeOverflow = (u: Rect) =>
    -Math.min(
      u.x - safe.left,
      u.y - safe.top,
      W - safe.right - (u.x + u.w),
      H - safe.bottom - (u.y + u.h),
    );

  const brandFonts = config.brandFonts?.map((f) => f.toLocaleLowerCase("en"));
  const missingReported = new Set<string>();
  const textMetrics = new Map<string, NonNullable<LayerMetrics["text"]>>();
  const lineCores = new Map<string, Rect[]>();

  for (const l of texts) {
    const n = l.node;
    const t = n.text as CanvasText;
    const lines = linesOf(n, t);
    // Where the glyphs are (the line boxes' middle band), as the HTML linter measures text.
    const u = union(lines.map(core));
    const { min, max } = sizes(t);
    lineCores.set(l.id, lines.map(core));

    if (t.truncated)
      add(issue("text-truncated", l.id, "Wecra cuts the text with an ellipsis (truncation)."));
    if (t.overflow)
      add(
        issue(
          "text-overflow-box",
          l.id,
          `Text extends beyond its own box (${Math.round(n.bounds.w)}x${Math.round(n.bounds.h)}).`,
        ),
      );
    if (n.clip && !within(n.clip, u))
      add(issue("text-clipped", l.id, "Text is cut off by the layer that contains it."));
    else if (!within(frame, u))
      add(issue("text-outside-artboard", l.id, "Text is cut off by the slide's edge."));

    const over = safeOverflow(u);
    if (over > 0.5)
      add(
        issue("safe-area", l.id, `Text is ${Math.round(over)}px outside the safe area.`, {
          overflow: Math.round(over),
        }),
      );

    const floor =
      l.role === "legal"
        ? (config.legalMinFontSize ?? CONTRACT_LIMITS.legalMinFontSize)
        : (config.minFontSize ?? CONTRACT_LIMITS.minFontSize);
    const warn = config.bodyFontSize ?? CONTRACT_LIMITS.bodyFontSize;
    if (min < floor)
      add(
        issue("min-font-size", l.id, `Smallest text is ${min}px; minimum is ${floor}px.`, {
          fontSize: min,
        }),
      );
    else if (
      min < warn &&
      !["legal", "eyebrow", "counter", "badge", "caption"].includes(l.role ?? "")
    )
      add(
        issue(
          "small-font-size",
          l.id,
          `Smallest text is ${min}px; running text reads better at ≥ ${warn}px.`,
          { fontSize: min },
        ),
      );

    const families = [...new Set([t.family, ...t.runs.map((r) => r.family)])];
    if (brandFonts)
      for (const f of families)
        if (!brandFonts.includes(f.toLocaleLowerCase("en")))
          add(issue("font-family", l.id, `Font "${f}" is not a brand font.`, { family: f }));
    if (t.missingFont && !missingReported.has(t.family)) {
      missingReported.add(t.family);
      add(
        issue(
          "font-missing",
          null,
          `Font "${t.family}" was not available on the canvas; the text was drawn with the fallback.`,
          { family: t.family },
        ),
      );
    }

    // A lone short word on the last line of large text.
    if (lines.length >= 2 && max >= 44) {
      const maxW = Math.max(...lines.map((x) => x.w));
      const last = lines[lines.length - 1] as CanvasLine;
      const lastText = t.characters.slice(last.from, last.to).trim();
      if (last.w < maxW * 0.22 || (lastText && !/\s/.test(lastText) && last.w < maxW * 0.4))
        add(issue("widow", l.id, `Last line is a lone short word ("${lastText.slice(0, 24)}").`));
    }

    // Painted underneath something opaque later in the paint order?
    {
      let pts = 0;
      let hidden = 0;
      const by = new Set<string>();
      const above = facts.nodes.slice((order.get(n.id) ?? 0) + 1).filter(coversOpaquely);
      for (const c of lines.map(core))
        for (const fx of [0.15, 0.5, 0.85]) {
          const x = c.x + c.w * fx;
          const y = c.y + c.h * 0.5;
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          pts++;
          const hit = above.find(
            (o) =>
              x >= o.bounds.x &&
              x <= o.bounds.x + o.bounds.w &&
              y >= o.bounds.y &&
              y <= o.bounds.y + o.bounds.h &&
              (!o.clip ||
                (x >= o.clip.x &&
                  x <= o.clip.x + o.clip.w &&
                  y >= o.clip.y &&
                  y <= o.clip.y + o.clip.h)),
          );
          if (hit) {
            hidden++;
            by.add(layers.find((x) => x.node.id === hit.id)?.id ?? hit.name);
          }
        }
      if (pts && hidden / pts > 0.34)
        add(
          issue(
            "text-occluded",
            l.id,
            `Text is painted underneath "${[...by].join('", "')}" (${hidden}/${pts} sample points covered).`,
            { by: [...by] },
          ),
        );
    }

    textMetrics.set(l.id, {
      lines: lines.length,
      fontSize: t.size,
      minFontSize: min,
      weight: String(t.weight),
      family: families.join(","),
      color: t.color ? rgbCss(t.color) : "",
      textRect: roundRect(u),
      chars: t.characters.trim().length,
    });
  }

  // Overlapping texts.
  for (let i = 0; i < texts.length; i++)
    for (let j = i + 1; j < texts.length; j++) {
      const a = texts[i] as CanvasLayer;
      const b = texts[j] as CanvasLayer;
      if (a.node.mark?.allowOverlap || b.node.mark?.allowOverlap) continue;
      let area = 0;
      for (const x of lineCores.get(a.id) ?? [])
        for (const y of lineCores.get(b.id) ?? []) area += inter(x, y);
      if (area > 40)
        add(
          issue(
            "text-overlap",
            a.id,
            `Text of "${a.id}" overlaps text of "${b.id}" (${Math.round(area)}px²).`,
            { other: b.id, area: Math.round(area) },
          ),
        );
    }

  // Logos: safe area, text over a logo, clear space.
  const logos = layers.filter((l) => l.type === "logo");
  const boxes: InPageBox[] = [];
  for (const l of texts)
    for (const c of lineCores.get(l.id) ?? [])
      boxes.push({ layer: l.id, kind: "text", rect: roundRect(c) });
  for (const l of layers)
    if (l.type !== "text")
      boxes.push({ layer: l.id, kind: l.type === "slot" ? "slot" : l.type, rect: l.rect });
  for (const n of facts.nodes) {
    if (
      n.type !== "shape" ||
      !isPainted(n) ||
      !n.fills.some((p) => p.type === "solid" && p.opacity > 0)
    )
      continue;
    const big = (n.bounds.w * n.bounds.h) / (W * H) >= 0.25;
    boxes.push({
      layer: n.name || n.id,
      kind: n.mark?.role === "background" || big ? "background" : "shape",
      rect: roundRect(n.bounds),
    });
  }
  for (const lg of logos) {
    const over = safeOverflow(lg.rect);
    if (over > 0.5)
      add(
        issue("safe-area", lg.id, `Logo is ${Math.round(over)}px outside the safe area.`, {
          overflow: Math.round(over),
        }),
      );
    for (const l of texts) {
      let area = 0;
      for (const c of lineCores.get(l.id) ?? []) area += inter(c, lg.rect);
      if (area > 40)
        add(issue("text-logo-overlap", l.id, `Text overlaps logo "${lg.id}".`, { logo: lg.id }));
    }
  }
  issues.push(
    ...clearSpaceIssues(
      logos.map((l) => ({ id: l.id, src: l.src ?? "", rect: l.rect })),
      boxes,
      { defaultRatio: config.logoClearSpace, byPath: config.logoClearSpaceByPath },
    ),
  );

  // Pictures shown larger than their pixels.
  for (const l of layers) {
    const img = l.image;
    if (!img?.size || img.fit === "crop" || img.fit === "tile") continue;
    const sx = l.rect.w / img.size.w;
    const sy = l.rect.h / img.size.h;
    const scale = img.fit === "fit" ? Math.min(sx, sy) : Math.max(sx, sy);
    if (scale > 1.05)
      add(
        issue(
          "image-upscaled",
          l.id,
          `Image is shown at ${(scale * 100).toFixed(0)}% of its pixel size (${img.size.w}x${img.size.h}).`,
          { scale: Number(scale.toFixed(2)) },
        ),
      );
  }

  // Contrast against the render's pixels.
  const contrast = new Map<string, Omit<ContrastOut, "large">>();
  if (raster)
    for (const l of texts) {
      const r = canvasTextContrast(l, raster);
      if (r === null) continue;
      if (r === "unknown") {
        add(
          issue(
            "contrast-unknown",
            l.id,
            "Text colour could not be measured (gradient or picture fill).",
          ),
        );
        continue;
      }
      const { large, ...result } = r;
      contrast.set(l.id, result);
      if (result.median < result.required)
        add(
          issue(
            "contrast",
            l.id,
            `Contrast ${result.median.toFixed(2)}:1 against its background (needs ${result.required}:1 for ${large ? "large" : "normal"} text).`,
            { ...result },
          ),
        );
      else if (result.worst < result.required)
        add(
          issue(
            "contrast-busy-background",
            l.id,
            `Contrast drops to ${result.worst.toFixed(2)}:1 on parts of the background (median ${result.median.toFixed(2)}:1).`,
            { ...result },
          ),
        );
    }

  // Layer metrics: the HTML's layers with the facts' boxes and text.
  const byId = new Map(layers.map((l) => [l.id, l]));
  const metrics: LayerMetrics[] = st.layers.map((m) => {
    if (m.id === CANVAS_RENDER_LAYER)
      return { ...m, rect: { x: 0, y: 0, w: Math.round(W), h: Math.round(H) }, visible: true };
    const l = byId.get(m.id);
    if (!l) return m;
    const text = textMetrics.get(m.id);
    const c = contrast.get(m.id);
    return {
      ...m,
      rect: l.rect,
      visible: true,
      ...(text ? { text: c ? { ...text, contrast: c } : text } : {}),
    };
  });

  return buildReport({
    config,
    issues,
    layers: metrics,
    stages: { static: true, layout: true, pixel: raster !== null, render: raster !== null },
  });
}
