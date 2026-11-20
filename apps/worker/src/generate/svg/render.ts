/**
 * Rendering and linting an SVG slide (docs/URETIM-RESIM.md, Faz 3).
 *
 * Chromium renders the slide document (the same renderer as the HTML engine: the brand's WOFF2
 * fonts through brand.css' @font-face, the virtual `/brand/` and `/media/` origins, no network,
 * no JavaScript of the design). In the same page load an inspection measures what the HTML
 * linter cannot see in an SVG — every `<text>` box, its font, size and colour, the pictures and
 * the slot markers — and a second capture with the text made transparent gives the background
 * for the contrast measure. The findings use design-kit's lint rule ids and report shape, so the
 * critique prompt, the version's layouts and the generation checks read them like any report.
 */
import {
  buildReport,
  findUnverifiedNumbers,
  type InPageText,
  issue,
  type LayerMetrics,
  type LintConfig,
  type LintIssue,
  type LintReport,
  measureContrast,
  type NetworkLog,
  type Raster,
  resolveSafeArea,
} from "@studio/design-kit/lint";
import type {
  AssetResolver,
  RenderAndInspectRequest,
  RenderAndInspectResult,
} from "@studio/design-kit/render";

/** A renderer that can render and inspect one page load (design-kit's `Renderer`). */
export interface SvgRenderer {
  renderAndInspect<T>(req: RenderAndInspectRequest): Promise<RenderAndInspectResult<T>>;
}

/** The renderer when it can inspect a page (fakes in tests may not). */
export function svgRendererOf(renderer: unknown): SvgRenderer | null {
  return renderer && typeof (renderer as Partial<SvgRenderer>).renderAndInspect === "function"
    ? (renderer as SvgRenderer)
    : null;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SvgInspectedText {
  id: string;
  text: string;
  rect: Box;
  fontSize: number;
  minFontSize: number;
  weight: string;
  family: string;
  color: string;
  lines: number;
  legal: boolean;
  allowOverlap: boolean;
  runs: { color: string; fontSize: number; weight: string; rects: Box[] }[];
}

export interface SvgInspection {
  root: { width: number; height: number } | null;
  texts: SvgInspectedText[];
  images: { href: string; rect: Box; preserve: string; slot: string | null }[];
  slots: { id: string; state: string; ratio: string | null; label: string | null; rect: Box }[];
  fonts: { family: string; status: string }[];
}

/** Runs in the page (no closures: it is serialised with `toString`). */
export function studioSvgInspect(): SvgInspection {
  const svg = (document.querySelector("body > svg") ??
    document.querySelector("svg")) as SVGSVGElement | null;
  const box = (el: Element): Box => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  };
  const shown = (el: Element): boolean => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0)
        return false;
    }
    return true;
  };
  const scaleOf = (el: Element): number => {
    const m = (el as SVGGraphicsElement).getScreenCTM?.();
    return m ? Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || 1 : 1;
  };
  const texts: SvgInspectedText[] = [];
  const all = svg ? Array.from(svg.querySelectorAll("text")) : [];
  all.forEach((el, i) => {
    if (!shown(el)) return;
    // A <tspan> on its own line (x, y or dy) is a word break, like in the stored copy.
    let joined = "";
    const read = (node: Node): void => {
      for (const c of Array.from(node.childNodes)) {
        if (c.nodeType === 3) joined += c.textContent ?? "";
        else if (c.nodeType === 1) {
          const e = c as Element;
          const dy = e.getAttribute("dy");
          const newLine =
            e.tagName.toLowerCase() === "tspan" &&
            (e.hasAttribute("x") ||
              e.hasAttribute("y") ||
              (dy !== null && Number.parseFloat(dy) !== 0));
          if (newLine && joined && !/\s$/.test(joined)) joined += " ";
          read(e);
        }
      }
    };
    read(el);
    const text = joined.replace(/\s+/g, " ").trim();
    if (!text) return;
    const cs = getComputedStyle(el);
    const scale = scaleOf(el);
    const spans = Array.from(el.querySelectorAll("tspan")).filter(
      (t) => (t.textContent ?? "").trim() !== "" && t.querySelector("tspan") === null,
    );
    const runs = (spans.length ? spans : [el])
      .map((p) => {
        const pcs = getComputedStyle(p);
        return {
          color: pcs.fill,
          fontSize: Number.parseFloat(pcs.fontSize) * scale,
          weight: pcs.fontWeight,
          rects: [box(p)],
        };
      })
      .filter((r) => (r.rects[0]?.w ?? 0) > 0 && (r.rects[0]?.h ?? 0) > 0);
    const lineYs = new Set(runs.map((r) => Math.round(r.rects[0]?.y ?? 0)));
    const sizes = runs.map((r) => r.fontSize);
    const fontSize = Number.parseFloat(cs.fontSize) * scale;
    texts.push({
      id: el.id || `text-${i + 1}`,
      text,
      rect: box(el),
      fontSize,
      minFontSize: sizes.length ? Math.min(...sizes) : fontSize,
      weight: cs.fontWeight,
      family: cs.fontFamily,
      color: cs.fill,
      lines: Math.max(1, lineYs.size),
      legal: el.getAttribute("data-role") === "legal",
      allowOverlap: el.hasAttribute("data-allow-overlap"),
      runs,
    });
  });
  const images = svg
    ? Array.from(svg.querySelectorAll("image"))
        .filter(shown)
        .map((el) => ({
          href: el.getAttribute("href") ?? el.getAttribute("xlink:href") ?? "",
          rect: box(el),
          preserve: el.getAttribute("preserveAspectRatio") ?? "",
          slot: el.getAttribute("data-slot"),
        }))
    : [];
  const slots = svg
    ? Array.from(svg.querySelectorAll("[data-slot]")).map((el) => ({
        id: el.getAttribute("data-slot") ?? "",
        state:
          el.getAttribute("data-slot-state") ??
          (el.tagName.toLowerCase() === "image" ? "filled" : "empty"),
        ratio: el.getAttribute("data-slot-ratio"),
        label: el.getAttribute("data-slot-label"),
        rect: box(el),
      }))
    : [];
  const fonts: { family: string; status: string }[] = [];
  // Iterated, not forEach: with the page's JavaScript off, a callback from the platform is refused.
  for (const f of Array.from(document.fonts as unknown as Iterable<FontFace>)) {
    fonts.push({ family: f.family.replace(/^["']|["']$/g, ""), status: f.status });
  }
  const root = svg ? box(svg) : null;
  return {
    root: root ? { width: root.w, height: root.h } : null,
    texts,
    images,
    slots,
    fonts,
  };
}

/** The inspection as an expression for `page.evaluate` (`__name`: see design-kit's in-page lint). */
export const SVG_INSPECT_SCRIPT = `(() => { const __name = (f) => f; return (${studioSvgInspect.toString()})(); })()`;

/** Every glyph transparent: the background behind the text, for contrast. */
export const HIDE_SVG_TEXT_CSS =
  "text, tspan, textPath { fill: transparent !important; stroke: transparent !important; }";

const GENERIC = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui"]);

function primaryFamily(stack: string): string {
  return (stack.split(",")[0] ?? "").trim().replace(/^["']|["']$/g, "");
}

function intersect(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

const round = (b: Box): Box => ({
  x: Math.round(b.x),
  y: Math.round(b.y),
  w: Math.round(b.w),
  h: Math.round(b.h),
});

/** The inspection (+ the text-free raster, the network log) → a design-kit lint report. */
export function lintSvgInspection(
  found: SvgInspection,
  config: LintConfig,
  extra: { raster?: Raster | undefined; network?: NetworkLog | undefined } = {},
): LintReport {
  const { width: W, height: H } = config;
  const safe = resolveSafeArea(config.safeArea);
  const issues: LintIssue[] = [];
  const layers: LayerMetrics[] = [];
  if (!found.root) issues.push(issue("artboard-size", null, "The slide has no <svg> to render."));
  else if (Math.abs(found.root.width - W) > 1 || Math.abs(found.root.height - H) > 1)
    issues.push(
      issue(
        "artboard-size",
        null,
        `The <svg> renders at ${Math.round(found.root.width)}x${Math.round(found.root.height)}, not ${W}x${H}.`,
      ),
    );

  const brandFonts = (config.brandFonts ?? []).map((f) => f.toLowerCase());
  const systemFonts = new Set((config.systemFonts ?? []).map((f) => f.toLowerCase()));
  const loaded = new Set(
    found.fonts.filter((f) => f.status === "loaded").map((f) => f.family.toLowerCase()),
  );
  const failed = new Set(
    found.fonts.filter((f) => f.status === "error").map((f) => f.family.toLowerCase()),
  );
  const minFont = config.minFontSize ?? 24;
  const legalMin = config.legalMinFontSize ?? 20;
  const bodyFont = config.bodyFontSize ?? 28;

  for (const t of found.texts) {
    const r = t.rect;
    const family = primaryFamily(t.family);
    const fam = family.toLowerCase();
    if (r.x < -1 || r.y < -1 || r.x + r.w > W + 1 || r.y + r.h > H + 1)
      issues.push(
        issue(
          "text-outside-artboard",
          t.id,
          `“${t.text.slice(0, 60)}” runs outside the ${W}x${H} artboard (box ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}): shorten it, break it into more <tspan> lines or make it smaller.`,
        ),
      );
    else if (
      r.x < safe.left - 1 ||
      r.y < safe.top - 1 ||
      r.x + r.w > W - safe.right + 1 ||
      r.y + r.h > H - safe.bottom + 1
    )
      issues.push(
        issue(
          "safe-area",
          t.id,
          `“${t.text.slice(0, 60)}” leaves the safe area (${safe.top}/${safe.right}/${safe.bottom}/${safe.left} px).`,
        ),
      );
    const min = t.legal ? legalMin : minFont;
    if (t.minFontSize < min - 0.5)
      issues.push(
        issue(
          "min-font-size",
          t.id,
          `“${t.text.slice(0, 60)}” is ${Math.round(t.minFontSize)}px; at least ${min}px.`,
        ),
      );
    else if (t.minFontSize < bodyFont - 0.5 && t.text.length > 40)
      issues.push(
        issue(
          "small-font-size",
          t.id,
          `Running text “${t.text.slice(0, 40)}…” is ${Math.round(t.minFontSize)}px; at least ${bodyFont}px reads on a phone.`,
        ),
      );
    if (brandFonts.length > 0 && fam && !GENERIC.has(fam) && !brandFonts.includes(fam))
      issues.push(
        issue(
          "font-family",
          t.id,
          `“${t.text.slice(0, 40)}” uses "${family}", not a brand font (${config.brandFonts?.join(", ")}).`,
        ),
      );
    else if (
      brandFonts.includes(fam) &&
      !systemFonts.has(fam) &&
      (failed.has(fam) || !loaded.has(fam))
    )
      issues.push(
        issue(
          "font-load",
          t.id,
          `The brand font "${family}" did not load for “${t.text.slice(0, 40)}”.`,
        ),
      );
    if (config.allowedNumbers)
      for (const n of findUnverifiedNumbers(t.text, config.allowedNumbers))
        issues.push(
          issue(
            "unverified-number",
            t.id,
            `The number "${n.text}" is not in FACTS.allowedNumbers; remove it or rephrase without it.`,
            { number: n.text },
          ),
        );
    layers.push({
      id: t.id,
      type: "text",
      role: t.legal ? "legal" : null,
      parent: null,
      rect: round(r),
      visible: true,
      content: t.text.slice(0, 200),
      text: {
        lines: t.lines,
        fontSize: Math.round(t.fontSize * 10) / 10,
        minFontSize: Math.round(t.minFontSize * 10) / 10,
        weight: t.weight,
        family,
        color: t.color,
        textRect: round(r),
        chars: t.text.length,
      },
    });
  }

  // Text on text (unless one is marked to overlap), text on a logo.
  for (let i = 0; i < found.texts.length; i++) {
    const a = found.texts[i] as SvgInspectedText;
    for (let j = i + 1; j < found.texts.length; j++) {
      const b = found.texts[j] as SvgInspectedText;
      if (a.allowOverlap || b.allowOverlap) continue;
      const area = intersect(a.rect, b.rect);
      const smaller = Math.min(a.rect.w * a.rect.h, b.rect.w * b.rect.h);
      if (smaller > 0 && area / smaller > 0.2)
        issues.push(
          issue(
            "text-overlap",
            a.id,
            `“${a.text.slice(0, 30)}” overlaps “${b.text.slice(0, 30)}”.`,
            {
              other: b.id,
            },
          ),
        );
    }
  }

  for (const [n, img] of found.images.entries()) {
    const logo = img.href.startsWith("/brand/logos/");
    const id = img.slot ?? `${logo ? "logo" : "image"}-${n + 1}`;
    if (/^none$/i.test(img.preserve.trim()))
      issues.push(
        issue(
          "image-distorted",
          id,
          `${img.href} is stretched (preserveAspectRatio="none"); use xMidYMid slice or meet.`,
        ),
      );
    if (logo)
      for (const t of found.texts)
        if (intersect(t.rect, img.rect) > 4)
          issues.push(
            issue("text-logo-overlap", t.id, `“${t.text.slice(0, 30)}” overlaps the logo.`),
          );
    layers.push({
      id,
      type: img.slot ? "slot" : logo ? "logo" : "image",
      role: null,
      parent: null,
      rect: round(img.rect),
      visible: true,
    });
  }

  for (const s of found.slots) {
    if (s.state === "filled") continue;
    issues.push(
      issue("slot-empty", s.id, `Image slot "${s.label ?? s.id}" is empty (filled later).`),
    );
    const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(s.ratio ?? "");
    if (m && s.rect.h > 0) {
      const declared = Number(m[1]) / Number(m[2]);
      const actual = s.rect.w / s.rect.h;
      if (Math.abs(actual / declared - 1) > 0.02)
        issues.push(
          issue(
            "slot-ratio-mismatch",
            s.id,
            `Slot "${s.id}" is ${Math.round(s.rect.w)}x${Math.round(s.rect.h)} but declares ${s.ratio}.`,
          ),
        );
    }
    layers.push({
      id: s.id,
      type: "slot",
      role: null,
      parent: null,
      rect: round(s.rect),
      visible: true,
    });
  }

  let pixel = false;
  if (extra.raster && found.texts.length > 0) {
    const text: InPageText[] = found.texts.map((t) => ({
      id: t.id,
      role: null,
      lines: t.lines,
      lineRects: t.runs.flatMap((r) => r.rects),
      fontSize: t.fontSize,
      minFontSize: t.minFontSize,
      weight: t.weight,
      family: t.family,
      color: t.color,
      clipText: !/^rgba?\(/.test(t.color.trim()),
      textRect: t.rect,
      chars: t.text.length,
      runs: t.runs,
    }));
    const contrast = measureContrast(text, extra.raster, extra.raster.width / W);
    issues.push(...contrast.issues);
    for (const l of layers) {
      const c = contrast.byLayer.get(l.id);
      if (c && l.text) l.text = { ...l.text, contrast: c };
    }
    pixel = true;
  }
  if (extra.network) {
    for (const b of extra.network.blocked)
      issues.push(issue("network-request", null, `Blocked request: ${b}`, { url: b }));
    for (const m of extra.network.missing)
      issues.push(issue("network-request", null, `Missing file: ${m}`, { url: m }));
  }
  return buildReport({
    config,
    issues,
    layers,
    stages: { static: true, layout: true, pixel, render: Boolean(extra.network) },
    fontsLoaded: [...loaded],
  });
}

export interface SvgRenderOutput {
  jpeg: Uint8Array | null;
  png: Uint8Array | null;
  report: LintReport;
}

/** Render one SVG slide document to JPEG (and PNG when asked) and lint it. */
export async function renderSvgSlide(
  renderer: SvgRenderer,
  req: {
    html: string;
    width: number;
    height: number;
    resolver: AssetResolver;
    signal?: AbortSignal | undefined;
    lint: Omit<LintConfig, "width" | "height">;
    formats?: ("png" | "jpeg")[];
  },
): Promise<SvgRenderOutput> {
  const res = await renderer.renderAndInspect<SvgInspection>({
    html: req.html,
    width: req.width,
    height: req.height,
    formats: req.formats ?? ["jpeg"],
    jpegQuality: 92,
    resolver: req.resolver,
    ...(req.signal ? { signal: req.signal } : {}),
    inspect: SVG_INSPECT_SCRIPT,
    rasterCss: HIDE_SVG_TEXT_CSS,
  });
  const report = lintSvgInspection(
    res.inspected,
    { ...req.lint, width: req.width, height: req.height },
    { raster: res.raster, network: res.network },
  );
  return { jpeg: res.jpeg ?? null, png: res.png ?? null, report };
}
