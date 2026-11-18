/**
 * Lint orchestration. Independent of Playwright: anything that can run the in-page script
 * against a laid-out document implements `LintPage` (the renderer with Chromium, the web
 * editor with its preview iframe). Without a page only the static stage runs.
 */
import { CONTRACT_LIMITS } from "../contract/constants.ts";
import { type ParsedSlide, parseSlide } from "../document/model.ts";
import { measureContrast, type Raster } from "./contrast.ts";
import { clearSpaceIssues, voidIssues } from "./geometry.ts";
import type { InPageInput, InPageResult } from "./inpage.ts";
import {
  buildReport,
  issue,
  type LayerMetrics,
  type LintConfig,
  type LintIssue,
  type LintReport,
  resolveSafeArea,
} from "./report.ts";
import { isRuleId, LINT_RULES } from "./rules.ts";
import { staticLint } from "./static.ts";

export interface LintPage {
  /** Run `studioInPageLint(input)` in the page and return its result. */
  runInPage(input: InPageInput): Promise<InPageResult>;
  /** Capture the artboard at CSS-pixel scale with all layer text transparent (pixel stage). */
  captureTextFreeRaster?(): Promise<Raster>;
}

export interface NetworkLog {
  /** Requests to anything but the virtual origins (aborted). */
  blocked: readonly string[];
  /** Virtual-origin requests the resolver could not serve (404). */
  missing: readonly string[];
}

export interface LintOptions extends LintConfig {
  page?: LintPage;
  network?: NetworkLog;
}

export function inPageInput(config: LintConfig): InPageInput {
  return {
    width: config.width,
    height: config.height,
    safe: resolveSafeArea(config.safeArea),
    minFont: config.minFontSize ?? CONTRACT_LIMITS.minFontSize,
    warnFont: config.bodyFontSize ?? CONTRACT_LIMITS.bodyFontSize,
    legalMinFont: config.legalMinFontSize ?? CONTRACT_LIMITS.legalMinFontSize,
    brandFonts: config.brandFonts ? [...config.brandFonts] : null,
    systemFonts: config.systemFonts ? [...config.systemFonts] : [],
  };
}

/** Static stage only (synchronous, no browser). */
export function lintSlideStatic(input: string | ParsedSlide, config: LintConfig): LintReport {
  const doc = typeof input === "string" ? parseSlide(input) : input;
  const st = staticLint(doc, config);
  return buildReport({
    config,
    issues: st.issues,
    layers: st.layers,
    stages: { static: true, layout: false, pixel: false, render: false },
  });
}

/** Full lint: static + layout (with `page`) + pixel (with `page.captureTextFreeRaster`) + network log. */
export async function lintSlide(
  input: string | ParsedSlide,
  options: LintOptions,
): Promise<LintReport> {
  const t0 = Date.now();
  const doc = typeof input === "string" ? parseSlide(input) : input;
  const st = staticLint(doc, options);
  const issues: LintIssue[] = [...st.issues];
  let layers: LayerMetrics[] = st.layers;
  let fontsLoaded: string[] | undefined;
  const stages = { static: true, layout: false, pixel: false, render: false };
  const timing: Record<string, number> = { staticMs: Date.now() - t0 };

  if (options.page) {
    const t1 = Date.now();
    const res = await options.page.runInPage(inPageInput(options));
    stages.layout = true;
    fontsLoaded = res.fontsLoaded;
    for (const f of res.findings) {
      if (!isRuleId(f.rule)) continue;
      issues.push({
        rule: f.rule,
        severity: LINT_RULES[f.rule].severity,
        layer: f.layer,
        message: f.message,
        ...(f.data ? { data: f.data } : {}),
      });
    }
    issues.push(...voidIssues(res.boxes, options, resolveSafeArea(options.safeArea), options.void));
    issues.push(
      ...clearSpaceIssues(res.logos, res.boxes, {
        defaultRatio: options.logoClearSpace,
        byPath: options.logoClearSpaceByPath,
      }),
    );
    const geo = new Map(res.layers.map((l) => [l.id, l]));
    const txt = new Map(res.text.map((t) => [t.id, t]));
    layers = layers.map((l) => {
      const g = geo.get(l.id);
      const t = txt.get(l.id);
      return {
        ...l,
        rect: g ? g.rect : null,
        visible: g ? g.visible : l.visible,
        ...(t
          ? {
              text: {
                lines: t.lines,
                fontSize: t.fontSize,
                minFontSize: t.minFontSize,
                weight: t.weight,
                family: t.family,
                color: t.color,
                textRect: t.textRect,
                chars: t.chars,
              },
            }
          : {}),
      };
    });
    timing.layoutMs = Date.now() - t1;

    if (options.page.captureTextFreeRaster) {
      const t2 = Date.now();
      const raster = await options.page.captureTextFreeRaster();
      const scale = raster.width / options.width;
      const contrast = measureContrast(res.text, raster, scale);
      issues.push(...contrast.issues);
      layers = layers.map((l) => {
        const c = contrast.byLayer.get(l.id);
        return c && l.text ? { ...l, text: { ...l.text, contrast: c } } : l;
      });
      stages.pixel = true;
      timing.pixelMs = Date.now() - t2;
    }
  }
  if (options.network) {
    stages.render = true;
    for (const b of options.network.blocked)
      issues.push(issue("network-request", null, `Blocked request: ${b}`, { url: b }));
    for (const m of options.network.missing)
      issues.push(issue("network-request", null, `Missing file: ${m}`, { url: m }));
  }
  timing.totalMs = Date.now() - t0;
  return buildReport({
    config: options,
    issues,
    layers,
    stages,
    ...(fontsLoaded ? { fontsLoaded } : {}),
    timing,
  });
}
