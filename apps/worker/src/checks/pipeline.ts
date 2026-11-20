/**
 * Generation check pipeline (roadmap 13). Runs over one content version:
 *
 *   settings + brand → lint reports of the slides (given by the caller, carried over from the
 *   previous version's run for unchanged slides, or measured by rendering) → deterministic checks
 *   → one cheap model pass (language, voice, products, claims) → automatic fixes (at most two
 *   rounds, kept only when they do not add failures; a new version and / or a shorter caption)
 *   → check run(s) stored on the API → a compact brief for job outputs and the chat agent.
 *
 * Called after `content.generate` (with the pipeline's reports and the brand's autoFix), after an
 * edit render (`content.render`, deterministic only, model results carried over while the text
 * is unchanged) and by `content.check` (on demand, optionally fixing).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  type BrandCheckSettings,
  type BrandProduct,
  CAPTION_LIMITS,
  CHECK_CATALOG,
  CHECK_IDS,
  type CheckId,
  type CheckTrigger,
  type Content,
  type ContentCheckBrief,
  type ContentCheckResult,
  type ContentCheckRun,
  type ContentVersion,
  defaultCheckSettings,
  isCheckEnabled,
  isSvgSlideHtml,
  MAX_CHECK_RESULTS,
  type Platform,
  type SlideLayout,
  sortCheckResults,
  summarizeCheckResults,
} from "@studio/contract";
import { brandPatchContext, colorValue } from "@studio/design-kit/brand";
import { type CanvasSlideKind, lintCanvasSlide, readCanvas } from "@studio/design-kit/canvas";
import { parseSlide } from "@studio/design-kit/document";
import {
  findUnverifiedNumbers,
  type LintReport,
  lintCarousel,
  type Raster,
} from "@studio/design-kit/lint";
import { applyPatch, type PatchContext, PatchOp } from "@studio/design-kit/patch";
import { type PlatformPreset, presetsForSize } from "@studio/design-kit/presets";
import type {
  AssetResolver,
  RenderAndLintRequest,
  RenderAndLintResult,
} from "@studio/design-kit/render";
import { combineResolvers } from "@studio/design-kit/render";
import { sanitizeSlideHtml } from "@studio/design-kit/sanitize";
import sharp from "sharp";
import type { AgentDeps } from "../agent.ts";
import { designSkillsBlock, loadEnabledBrandSkills, selectBrandSkills } from "../brand/skills.ts";
import { type BrandContext, loadBrandContext } from "../generate/brand.ts";
import { presetFor } from "../generate/pipeline.ts";
import { svgTexts } from "../generate/svg/document.ts";
import { renderSvgSlide, svgRendererOf } from "../generate/svg/render.ts";
import { layoutFromReport } from "../render/layout.ts";
import { createApiAssetPathResolver } from "../video/render-reel.ts";
import {
  type CheckedSlide,
  deterministicFindings,
  findingKey,
  MODEL_CHECKS,
  SLIDE_CHECKS,
  type SlideText,
  skipped,
  skipReasons,
  withPasses,
} from "./deterministic.ts";
import { type FixContext, mergeSlideFixes, type SlideFix, slideFixFor } from "./fixes.ts";
import { checkModelCaller, type ModelCaller, runModelChecks } from "./model.ts";
import { characterCount, limitHashtags, trimCaption } from "./text.ts";

/** Same prefixes the render handler keeps (`RENDER_ASSET_PREFIXES`). */
const ASSET_PREFIXES = ["/brand/", "/media/", "/api/assets/"] as const;
/** Fix rounds after a generation / on "Düzelt". */
const MAX_FIX_ROUNDS = 2;

export interface CheckRenderer {
  renderAndLint(request: RenderAndLintRequest): Promise<RenderAndLintResult>;
}

export interface ChecksDeps extends AgentDeps {
  renderer: () => CheckRenderer;
  /** Test seam: the model pass caller (default: Gemini Flash-Lite, else Claude Haiku). */
  checkModelCaller?: ModelCaller | null;
}

export interface SlideReport {
  report: LintReport | null;
  failure?: string | null;
  jpegBytes?: number | null;
}

export interface RunChecksOptions {
  deps: ChecksDeps;
  jobId: string | null;
  trigger: CheckTrigger;
  contentId: string;
  /** Version to check (default: the current one). */
  version?: number;
  /** Brand context the caller already loaded. */
  brand?: BrandContext;
  /** Fresh lint reports by slide index (0-based). */
  reports?: ReadonlyMap<number, SlideReport>;
  /** An earlier version's run whose slide findings still hold for these unchanged slides. */
  carryOver?: { run: ContentCheckRun; unchangedSlides: ReadonlySet<number> } | null;
  /** Measure slides that have no report by rendering them (default true). */
  lintMissing?: boolean;
  /** Run the model pass (default true); false carries earlier model results over while the text is unchanged. */
  model?: boolean;
  /** Fix the fixable findings: all, or those of these checks; `auto` follows the brand's autoFix. */
  fix?: boolean | readonly CheckId[] | "auto";
  unresolvedAliases?: readonly string[];
  signal: AbortSignal;
  progress?: (value: number, message: string) => void;
}

export interface RunChecksResult {
  brief: ContentCheckBrief;
  /** The stored run of the checked (or the fixed) version. */
  run: ContentCheckRun | null;
  /** The version an automatic fix stored. */
  fixedVersion: ContentVersion | null;
  captionFixed: boolean;
}

interface SlideState extends CheckedSlide {
  html: string;
  renderedAssetId: string | null;
  layout: SlideLayout | null;
  jpeg: Uint8Array | null;
  /**
   * `fresh`: measured now; `carried`: findings come from the earlier run (unchanged slide);
   * `unmeasured`: not judged (a Reel cover, or no report and nothing to carry over).
   */
  mode: "fresh" | "carried" | "unmeasured";
  /** Saved from the canvas: with its facts, or an older save (one picture, nothing to read). */
  canvas: CanvasSlideKind["kind"];
}

/**
 * A canvas slide's render (the version's rendered PNG, else the canvas layer's file) as RGB
 * pixels, transparent parts on white; `null` when it cannot be read.
 */
async function canvasRaster(
  resolver: AssetResolver,
  html: string,
  renderedAssetId: string | null,
): Promise<Raster | null> {
  const path = renderedAssetId
    ? `/media/${encodeURIComponent(renderedAssetId)}.png`
    : (/<img[^>]*data-layer="canvas"[^>]*\ssrc="([^"]+)"/.exec(html)?.[1] ?? null);
  if (!path) return null;
  try {
    const file = await resolver.resolve(path);
    if (!file) return null;
    const { data, info } = await sharp(file.body)
      .flatten({ background: "#ffffff" })
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });
    return {
      width: info.width,
      height: info.height,
      channels: info.channels,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
  } catch {
    return null;
  }
}

/** The brand's settings (defaults when they cannot be read). */
export async function loadCheckSettings(
  deps: Pick<AgentDeps, "api" | "logger">,
  brandId: string,
  signal: AbortSignal,
): Promise<BrandCheckSettings> {
  try {
    return await deps.api.client.brandCheckSettings.get(brandId, { signal });
  } catch (error) {
    signal.throwIfAborted();
    deps.logger.warn(`checks: settings of ${brandId} unreadable: ${(error as Error).message}`);
    return defaultCheckSettings(brandId);
  }
}

/** Platform preset of a version: the content type's preset, or one of the slide's size. */
export function presetForVersion(
  content: Pick<Content, "type" | "targetPlatforms">,
  slide: { width: number; height: number } | undefined,
): PlatformPreset {
  const platforms: Platform[] = content.targetPlatforms.length
    ? content.targetPlatforms
    : ["instagram"];
  const base = presetFor(content.type, platforms);
  if (!slide || (slide.width === base.width && slide.height === base.height)) return base;
  const bySize = presetsForSize(slide.width, slide.height);
  return (
    bySize.find((p) => platforms.includes(p.platform)) ??
    bySize[0] ?? { ...base, width: slide.width, height: slide.height }
  );
}

/** Visible text layers of a slide with their full text. */
export function slideTexts(html: string): SlideText[] {
  if (isSvgSlideHtml(html))
    return svgTexts(html).map((t) => ({ layer: t.id, role: null, text: t.text.slice(0, 2_000) }));
  try {
    return parseSlide(html)
      .model.layers.filter((l) => l.type === "text" && !l.hidden && l.text.trim())
      .map((l) => ({
        layer: l.id,
        role: l.rawRole,
        text: (l as { text: string }).text.slice(0, 2_000),
      }));
  } catch {
    return [];
  }
}

/** Short hash of what the model pass reads (caption + slide texts). */
export function textHash(
  caption: string,
  slides: readonly { texts: readonly SlideText[] }[],
): string {
  const h = createHash("sha256");
  h.update(caption);
  for (const s of slides) for (const t of s.texts) h.update(`\u0000${t.layer}\u0001${t.text}`);
  return h.digest("hex").slice(0, 16);
}

function brandColors(brand: BrandContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, token] of Object.entries(brand.tokens.color ?? {})) {
    const v = colorValue(token);
    if (/^#[0-9a-f]{6}$/i.test(v)) out[name] = v.toUpperCase();
  }
  return out;
}

async function brandProducts(deps: ChecksDeps, brandId: string, signal: AbortSignal) {
  try {
    return (await deps.api.client.brandProducts.list(brandId, { limit: 100 }, { signal })).items;
  } catch (error) {
    signal.throwIfAborted();
    deps.logger.debug(`checks: products unreadable: ${(error as Error).message}`);
    return [] as BrandProduct[];
  }
}

async function kitPalette(deps: ChecksDeps, brandId: string, signal: AbortSignal) {
  try {
    const kit = await deps.api.client.brandKits.get(brandId, { signal });
    return kit.palette.map((p) => p.hex.toUpperCase());
  } catch {
    signal.throwIfAborted();
    return [] as string[];
  }
}

const failures = (results: readonly ContentCheckResult[]) =>
  results.filter((r) => r.status === "fail").length;

function briefOf(
  run: ContentCheckRun | null,
  results: readonly ContentCheckResult[],
  version: number,
  strictness: BrandCheckSettings["strictness"],
  fixedVersion: number | null,
): ContentCheckBrief {
  const counted = run
    ? { summary: run.summary, blocking: run.blocking }
    : summarizeCheckResults(results, strictness);
  return {
    runId: run?.id ?? null,
    version,
    summary: counted.summary,
    blocking: counted.blocking,
    fixedVersion,
    highlights: sortCheckResults(results)
      .filter((r) => r.status === "fail" || r.status === "warn" || r.status === "fixed")
      .slice(0, 8)
      .map((r) => ({ checkId: r.checkId, status: r.status, message: r.message.slice(0, 300) })),
  };
}

/** An error brief for job outputs (the job itself does not fail because of the checks). */
export function failedBrief(version: number, error: unknown): ContentCheckBrief {
  return {
    runId: null,
    version,
    summary: { pass: 0, warn: 0, fail: 0, fixed: 0, skipped: 0 },
    blocking: 0,
    fixedVersion: null,
    highlights: [],
    error: (error as Error)?.message?.slice(0, 300) ?? String(error),
  };
}

/** Lint configuration the checks need (safe area of the preset, brand fonts, facts). */
export function checkLintConfig(
  brand: BrandContext,
  preset: PlatformPreset,
  contentType: Content["type"],
  slideCount: number,
): NonNullable<RenderAndLintRequest["lint"]> {
  const allowed = [
    ...new Set([
      ...brand.allowedNumbers,
      ...(contentType === "carousel"
        ? Array.from({ length: slideCount }, (_, i) => String(i + 1))
        : []),
    ]),
  ];
  return {
    safeArea: preset.safeArea,
    brandFonts: brand.fontFamilies,
    systemFonts: brand.manifest.systemFontFamilies,
    ...(brand.allowedNumbers.length > 0 ? { allowedNumbers: allowed } : {}),
    lang: brand.brand.defaultLanguage.split("-")[0] ?? "tr",
    logoClearSpaceByPath: brand.logoClearSpaceByPath,
  };
}

export async function runContentChecks(o: RunChecksOptions): Promise<RunChecksResult> {
  const { deps, signal } = o;
  const api = deps.api.client;
  const init = { signal };
  const progress = o.progress ?? (() => {});

  let content = await api.contents.get(o.contentId, init);
  const versionNumber = o.version ?? content.currentVersion?.version;
  if (!versionNumber) throw new Error("Bu içeriğin denetlenecek bir sürümü yok.");
  const version = await api.contents.versions.get(content.id, versionNumber, init);
  const settings = await loadCheckSettings(deps, content.brandId, signal);
  const enabled = CHECK_IDS.filter((id) => isCheckEnabled(settings, id));
  const fixRequest = o.fix === "auto" ? settings.autoFix : (o.fix ?? false);
  const isReel = content.type === "reel";
  const brand =
    o.brand ??
    (await loadBrandContext({
      api: deps.api,
      brandId: content.brandId,
      cacheDir: path.join(deps.stateDir, "cache", "assets"),
      signal,
    }));
  const preset = presetForVersion(content, version.slides[0]);
  const colors = brandColors(brand);
  const palette = [
    ...new Set([...Object.values(colors), ...(await kitPalette(deps, content.brandId, signal))]),
  ];
  const hasFacts = brand.allowedNumbers.length > 0;
  const allowed = (count: number) => [
    ...new Set([
      ...brand.allowedNumbers,
      ...(content.type === "carousel"
        ? Array.from({ length: count }, (_, i) => String(i + 1))
        : []),
    ]),
  ];
  const resolver = combineResolvers(brand.resolver, createApiAssetPathResolver(deps.api, signal));

  const lintRender = async (html: string, width: number, height: number, count: number) => {
    try {
      // An SVG engine slide has its own lint (the HTML contract linter cannot read it).
      const svgRenderer = isSvgSlideHtml(html) ? svgRendererOf(deps.renderer()) : null;
      if (svgRenderer) {
        const res = await renderSvgSlide(svgRenderer, {
          html,
          width,
          height,
          resolver,
          signal,
          lint: checkLintConfig(brand, preset, content.type, count),
        });
        return { report: res.report, jpeg: res.jpeg, failure: null };
      }
      const res = await deps.renderer().renderAndLint({
        html,
        width,
        height,
        formats: ["jpeg"],
        jpegQuality: 92,
        resolver,
        signal,
        lint: checkLintConfig(brand, preset, content.type, count),
      });
      return { report: res.report, jpeg: res.jpeg ?? null, failure: null };
    } catch (error) {
      signal.throwIfAborted();
      return {
        report: null,
        jpeg: null,
        failure: `render failed: ${(error as Error).message.slice(0, 200)}`,
      };
    }
  };

  // --- 1. lint reports per slide ---
  progress(0.1, "Slaytlar ölçülüyor");
  const count = version.slides.length;
  const slides: SlideState[] = [];
  for (const [index, s] of version.slides.entries()) {
    const canvas = readCanvas(s.html);
    const state: SlideState = {
      index,
      width: s.width,
      height: s.height,
      html: s.html,
      renderedAssetId: s.renderedAssetId,
      layout: s.layers ?? null,
      report: null,
      failure: null,
      jpegBytes: null,
      jpeg: null,
      texts: slideTexts(s.html),
      // Reels: the cover is not judged as a slide.
      mode: "unmeasured",
      canvas: canvas.kind,
    };
    if (!isReel && canvas.kind === "legacy") {
      // An older canvas save: one picture, nothing to read (its checks are skipped).
    } else if (!isReel && canvas.kind === "facts") {
      // Saved from the canvas: the facts and the render's pixels (no Chromium layout to measure).
      signal.throwIfAborted();
      const raster = await canvasRaster(resolver, s.html, s.renderedAssetId);
      const report = lintCanvasSlide(
        { html: s.html, facts: canvas.facts, raster },
        {
          ...checkLintConfig(brand, preset, content.type, count),
          width: s.width,
          height: s.height,
        },
      );
      if (!raster)
        report.issues.push({
          rule: "image-broken",
          severity: "error",
          layer: "canvas",
          message: "The canvas render could not be read.",
        });
      state.mode = "fresh";
      state.report = report;
    } else if (!isReel) {
      const given = o.reports?.get(index);
      if (given) {
        state.mode = "fresh";
        state.report = given.report;
        state.failure = given.failure ?? (given.report ? null : "render failed");
        state.jpegBytes = given.jpegBytes ?? null;
      } else if (o.carryOver?.unchangedSlides.has(index)) {
        state.mode = "carried";
      } else if (o.lintMissing !== false) {
        signal.throwIfAborted();
        const res = await lintRender(s.html, s.width, s.height, count);
        state.mode = "fresh";
        state.report = res.report;
        state.failure = res.failure;
        state.jpegBytes = res.jpeg?.byteLength ?? null;
      }
    }
    slides.push(state);
  }

  // --- logo presence (canvas): the design the canvas started from showed the brand's logo ---
  const logoRows: ContentCheckResult[] = [];
  if (
    !isReel &&
    slides.length > 0 &&
    slides.every((s) => s.canvas === "facts") &&
    isCheckEnabled(settings, "brand.logo") &&
    !slides.some((s) => s.report?.layers.some((l) => l.type === "logo" && l.visible))
  ) {
    const first = readCanvas(version.slides[0]?.html);
    const source = first.kind === "facts" ? first.sourceVersion : null;
    let expected = brand.logos.length > 0;
    if (source)
      try {
        const from = await api.contents.versions.get(content.id, source, init);
        expected = from.slides.some((sl) => {
          try {
            return parseSlide(sl.html).model.layers.some((l) => l.type === "logo" && !l.hidden);
          } catch {
            return false;
          }
        });
      } catch (error) {
        signal.throwIfAborted();
        deps.logger.debug(`checks: source v${source} unreadable: ${(error as Error).message}`);
      }
    if (expected)
      logoRows.push({
        checkId: "brand.logo",
        category: CHECK_CATALOG["brand.logo"].category,
        status: "warn",
        message: source
          ? `Postta marka logosu görünmüyor; v${source} tasarımında vardı (tuvalde kaldırılmış ya da başka bir görselle değiştirilmiş).`
          : "Postta marka logosu görünmüyor.",
        refs: [],
        evidence: { rule: "logo-missing", ...(source ? { sourceVersion: source } : {}) },
        source: "deterministic",
        fixable: false,
      });
  }

  // --- 2. deterministic ---
  const determine = (caption: string, states: readonly SlideState[]) => {
    const fresh = states.filter((s) => s.mode === "fresh");
    const reports = states.map((s) => s.report);
    const carousel =
      content.type === "carousel" && reports.length > 1 && reports.every((r) => r !== null)
        ? lintCarousel(reports as LintReport[])
        : null;
    const found = deterministicFindings({
      contentType: content.type,
      platforms: content.targetPlatforms,
      title: content.title,
      brief: content.brief,
      caption,
      slides: fresh,
      carousel,
      captionNumbers: hasFacts
        ? findUnverifiedNumbers(caption, allowed(states.length)).map((n) => n.text)
        : [],
      palette,
      preset,
      settings,
      unresolvedAliases: o.unresolvedAliases ?? [],
      canFix: (r) => canFix(r, states),
    }).filter((r) => hasFacts || !isUnverifiedNumber(r));
    // Findings of slides that were not measured now come from the earlier run.
    const carried = (o.carryOver?.run.results ?? []).filter(
      (r) =>
        r.source === "deterministic" &&
        (r.status === "fail" || r.status === "warn") &&
        isCheckEnabled(settings, r.checkId as CheckId) &&
        r.refs.length > 0 &&
        r.refs.every((ref) => ref.slide !== null && states[ref.slide]?.mode === "carried"),
    );
    return [...found, ...carried, ...logoRows];
  };
  const canFix = (r: ContentCheckResult, states: readonly SlideState[]): boolean => {
    if (r.checkId === "text.caption-length") return r.evidence?.rule === "caption-length";
    if (r.checkId === "text.hashtags") return true;
    const slide = r.refs[0]?.slide;
    const state = slide !== null && slide !== undefined ? states[slide] : undefined;
    // A canvas slide is the canvas's render: it is fixed on the canvas, not by patching HTML.
    if (!state?.report || state.canvas !== "none") return false;
    // An SVG slide is changed from the chat (revise_post), not by patching HTML layers.
    if (isSvgSlideHtml(state.html)) return false;
    return slideFixFor(r, fixContext(state)) !== null;
  };
  const fixContext = (s: SlideState): FixContext => ({
    html: s.html,
    report: s.report as LintReport,
    width: s.width,
    height: s.height,
    safe: preset.safeArea,
    colors,
  });

  const original = determine(content.caption, slides);
  const ranDeterministic = enabled.filter(
    (id) => CHECK_CATALOG[id].source !== "model" && !(isReel && SLIDE_CHECKS.has(id)),
  );

  // --- 3. model pass ---
  const modelChecks = MODEL_CHECKS.filter((id) => enabled.includes(id));
  const hash = textHash(content.caption, slides);
  let modelRows: ContentCheckResult[] = [];
  let modelName: string | null = null;
  let modelRan = false;
  if (modelChecks.length > 0) {
    const previous = (o.carryOver?.run.results ?? []).filter((r) => r.source === "model");
    const previousHash = previous.find((r) => typeof r.evidence?.textHash === "string")?.evidence
      ?.textHash;
    if (o.model === false && previous.length > 0 && previousHash === hash) {
      modelRows = previous.filter((r) => modelChecks.includes(r.checkId as CheckId));
      modelName = o.carryOver?.run.model ?? null;
      modelRan = true;
    } else if (o.model === false) {
      const neverRan = previous.length > 0 && previous.every((r) => r.status === "skipped");
      modelRows = neverRan
        ? previous.filter((r) => modelChecks.includes(r.checkId as CheckId))
        : modelChecks
            .filter((id) => CHECK_CATALOG[id].source === "model")
            .map((id) =>
              skipped(
                id,
                previous.length > 0
                  ? "Metin değişti; dil ve marka denetimi için “Yeniden çalıştır”a basın."
                  : "Dil ve marka denetimi bu sürümde çalışmadı; “Yeniden çalıştır”a basın.",
              ),
            );
    } else {
      const caller =
        deps.checkModelCaller !== undefined
          ? deps.checkModelCaller
          : checkModelCaller(deps, o.jobId);
      if (!caller) {
        modelRows = modelChecks
          .filter((id) => CHECK_CATALOG[id].source === "model")
          .map((id) =>
            skipped(
              id,
              "Dil ve marka denetimi için Claude girişi ya da Gemini API anahtarı gerekli.",
            ),
          );
      } else {
        progress(0.45, "Dil, marka ve ürün denetimi");
        try {
          const skills = brand.skillsBlock
            ? brand.skillsBlock
            : designSkillsBlock(
                selectBrandSkills(await loadEnabledBrandSkills(deps.api, content.brandId, signal), {
                  budget: 5_000,
                  task: `${content.title}\n${content.brief}`,
                }),
              );
          const res = await runModelChecks(
            {
              brandName: brand.brand.name,
              language: brand.brand.defaultLanguage,
              voice: brand.voice,
              skills,
              facts: brand.facts,
              products: await brandProducts(deps, content.brandId, signal),
              content: {
                type: content.type,
                platforms: content.targetPlatforms,
                title: content.title,
                brief: content.brief,
                caption: content.caption,
              },
              slides: slides.map((s) => ({ index: s.index, texts: s.texts })),
              checks: modelChecks,
              strictness: settings.strictness,
            },
            caller,
            { label: `checks-${content.id.slice(-8)}`, signal },
          );
          modelName = res.model;
          modelRan = true;
          modelRows = res.results;
        } catch (error) {
          signal.throwIfAborted();
          deps.logger.warn(`checks: model pass failed: ${(error as Error).message}`);
          modelRows = modelChecks
            .filter((id) => CHECK_CATALOG[id].source === "model")
            .map((id) => skipped(id, "Dil ve marka denetimi bu kez çalışmadı; yeniden deneyin."));
        }
      }
    }
  }
  // Model rows remember the text they judged (carry-over after edit renders).
  const stamp = (rows: ContentCheckResult[]) =>
    rows.map((r) =>
      r.source === "model" ? { ...r, evidence: { ...(r.evidence ?? {}), textHash: hash } } : r,
    );
  const ranModel = modelRan ? modelChecks : [];
  const reelRows = isReel
    ? enabled
        .filter((id) => SLIDE_CHECKS.has(id))
        .map((id) =>
          skipped(id, "Reels'te slayt yerleşimi denetlenmez; videoyu önizlemede kontrol edin."),
        )
    : [];
  const assemble = (
    det: readonly ContentCheckResult[],
    extra: readonly ContentCheckResult[],
    states: readonly SlideState[],
  ) =>
    sortCheckResults(
      withPasses(
        [...det, ...extra, ...stamp(modelRows), ...reelRows],
        [...ranDeterministic, ...ranModel],
        skipReasons(states, isReel),
      ).map((r) =>
        r.status === "pass" && r.source === "model"
          ? { ...r, evidence: { ...(r.evidence ?? {}), textHash: hash } }
          : r,
      ),
    ).slice(0, MAX_CHECK_RESULTS);

  // --- 4. automatic fixes ---
  const wanted = (r: ContentCheckResult) =>
    r.fixable &&
    (fixRequest === true ||
      (Array.isArray(fixRequest) && fixRequest.includes(r.checkId as CheckId)));
  let current = original;
  let states = slides;
  const applied: { slide: number | null; layer: string | null; description: string }[] = [];
  const targeted = new Set<string>();
  if (fixRequest && !isReel) {
    const patchCtx: PatchContext = {
      ...brandPatchContext(brand.tokens),
      assetPrefixes: ASSET_PREFIXES,
    };
    for (let round = 0; round < MAX_FIX_ROUNDS; round++) {
      const targets = current.filter(
        (r) => wanted(r) && r.refs[0]?.slide !== null && r.refs[0]?.slide !== undefined,
      );
      const bySlide = new Map<number, SlideFix[]>();
      for (const t of targets) {
        const slide = t.refs[0]?.slide as number;
        const state = states[slide];
        if (!state?.report) continue;
        const fix = slideFixFor(t, fixContext(state));
        if (!fix) continue;
        targeted.add(findingKey(t));
        bySlide.set(slide, [...(bySlide.get(slide) ?? []), fix]);
      }
      if (bySlide.size === 0) break;
      progress(0.6 + round * 0.1, "Otomatik düzeltmeler uygulanıyor");
      const next = states.map((s) => ({ ...s }));
      const roundApplied: typeof applied = [];
      for (const [slide, fixes] of bySlide) {
        const state = next[slide] as SlideState;
        let html = state.html;
        for (const fix of mergeSlideFixes(fixes)) {
          try {
            html = applyPatch(html, PatchOp.parse(fix.op), patchCtx).html;
            roundApplied.push({ slide, layer: fix.layer, description: fix.description });
          } catch (error) {
            deps.logger.debug(
              `checks: fix skipped (${fix.description}): ${(error as Error).message}`,
            );
          }
        }
        try {
          html = sanitizeSlideHtml(html, { assetPrefixes: ASSET_PREFIXES }).html;
        } catch {
          continue;
        }
        if (html === state.html) continue;
        const res = await lintRender(html, state.width, state.height, next.length);
        Object.assign(state, {
          html,
          report: res.report,
          failure: res.failure,
          jpeg: res.jpeg,
          jpegBytes: res.jpeg?.byteLength ?? null,
          texts: slideTexts(html),
          layout: layoutFromReport(res.report),
          renderedAssetId: null,
          mode: "fresh",
        });
      }
      if (roundApplied.length === 0) break;
      const candidate = determine(content.caption, next);
      if (failures(candidate) > failures(current) || next.some((s) => s.failure)) {
        deps.logger.info("checks: automatic fix round discarded (it added failures)");
        break;
      }
      states = next;
      current = candidate;
      applied.push(...roundApplied);
    }
  }

  // Caption fixes (no new version: the caption lives on the content).
  let captionFixed = false;
  const captionTargets = current.filter(
    (r) => wanted(r) && (r.checkId === "text.caption-length" || r.checkId === "text.hashtags"),
  );
  if (captionTargets.length > 0) {
    const platforms: Platform[] = content.targetPlatforms.length
      ? content.targetPlatforms
      : ["instagram"];
    const tagLimit = Math.min(
      ...platforms.map((p) => CAPTION_LIMITS[p].hashtags ?? Number.POSITIVE_INFINITY),
    );
    const charLimit = Math.min(...platforms.map((p) => CAPTION_LIMITS[p].characters));
    const before = content.caption;
    const after = trimCaption(
      limitHashtags(before, Number.isFinite(tagLimit) ? tagLimit : null),
      charLimit,
    );
    if (after !== before) {
      try {
        content = await api.contents.update(content.id, { caption: after }, init);
        captionFixed = true;
        for (const t of captionTargets) targeted.add(findingKey(t));
        applied.push({
          slide: null,
          layer: null,
          description: `Açıklama düzeltildi (${characterCount(before)} → ${characterCount(after)} karakter)`,
        });
        current = determine(content.caption, states);
      } catch (error) {
        signal.throwIfAborted();
        deps.logger.warn(`checks: caption fix not stored: ${(error as Error).message}`);
      }
    }
  }

  // "fixed" rows: targeted findings that are gone.
  const remaining = new Set(current.map(findingKey));
  const fixedRows: ContentCheckResult[] = original
    .filter((r) => targeted.has(findingKey(r)) && !remaining.has(findingKey(r)))
    .map((r) => {
      const ref = r.refs[0];
      const how = applied
        .filter((a) =>
          ref ? a.slide === ref.slide && (a.layer === ref.layer || !ref.layer) : a.slide === null,
        )
        .map((a) => a.description);
      return {
        ...r,
        status: "fixed" as const,
        message: `Düzeltildi: ${how.length ? how.join("; ") : r.message}`.slice(0, 600),
        evidence: { ...(r.evidence ?? {}), before: r.message },
        fixable: false,
      };
    });

  // --- 5. new version and runs ---
  const changed = states.filter((s, i) => s.html !== version.slides[i]?.html);
  let fixedVersion: ContentVersion | null = null;
  if (changed.length > 0) {
    progress(0.85, "Düzeltilmiş sürüm kaydediliyor");
    try {
      const renderedAssetIds: (string | null)[] = [];
      for (const s of states) {
        if (s.html === version.slides[s.index]?.html || !s.jpeg) {
          renderedAssetIds.push(
            s.html === version.slides[s.index]?.html ? s.renderedAssetId : null,
          );
          continue;
        }
        const asset = await api.assets.upload(
          {
            brandId: content.brandId,
            kind: "image",
            source: "generated",
            width: s.width,
            height: s.height,
            file: new Blob([s.jpeg.slice()], { type: "image/jpeg" }),
            filename: `kontrol-v${version.version}-${s.index + 1}.jpg`,
          },
          init,
        );
        renderedAssetIds.push(asset.id);
      }
      const descriptions = applied.filter((a) => a.slide !== null).map((a) => a.description);
      fixedVersion = await api.contents.versions.create(
        content.id,
        {
          origin: "manual_edit",
          slides: states.map((s) => ({ html: s.html, width: s.width, height: s.height })),
          note: `Kontroller: otomatik düzeltme (v${version.version} üzerine) — ${descriptions.join("; ")}.`.slice(
            0,
            2_000,
          ),
          ...(o.jobId ? { jobId: o.jobId } : {}),
          renderedAssetIds,
          layouts: states.map((s) => s.layout),
        },
        init,
      );
    } catch (error) {
      signal.throwIfAborted();
      deps.logger.warn(`checks: fixed version not stored: ${(error as Error).message}`);
      fixedVersion = null;
      current = original;
    }
  }

  progress(0.95, "Kontrol sonuçları kaydediliyor");
  const baseResults = assemble(
    fixedVersion ? original : current,
    fixedVersion ? [] : fixedRows,
    fixedVersion ? slides : states,
  );
  const baseRun = await api.contents.checks.create(
    content.id,
    {
      version: version.version,
      trigger: o.trigger,
      ...(o.jobId ? { jobId: o.jobId } : {}),
      strictness: settings.strictness,
      results: baseResults,
      model: modelName,
      ...(fixedVersion ? { fixedVersion: fixedVersion.version } : {}),
      note: noteFor(o.trigger, applied.length, fixedVersion),
    },
    init,
  );
  if (!fixedVersion) {
    return {
      brief: briefOf(baseRun, baseResults, version.version, settings.strictness, null),
      run: baseRun,
      fixedVersion: null,
      captionFixed,
    };
  }
  const fixedResults = assemble(current, fixedRows, states);
  const fixedRun = await api.contents.checks.create(
    content.id,
    {
      version: fixedVersion.version,
      trigger: "fix",
      ...(o.jobId ? { jobId: o.jobId } : {}),
      strictness: settings.strictness,
      results: fixedResults,
      model: modelName,
      fromVersion: version.version,
      note: `v${version.version} otomatik düzeltildi.`,
    },
    init,
  );
  return {
    brief: briefOf(
      fixedRun,
      fixedResults,
      fixedVersion.version,
      settings.strictness,
      fixedVersion.version,
    ),
    run: fixedRun,
    fixedVersion,
    captionFixed,
  };
}

function isUnverifiedNumber(r: ContentCheckResult): boolean {
  return r.evidence?.rule === "unverified-number" || r.evidence?.rule === "percentage";
}

function noteFor(trigger: CheckTrigger, fixes: number, fixed: ContentVersion | null): string {
  const base =
    trigger === "generate"
      ? "Üretimden sonra."
      : trigger === "render"
        ? "Düzenlemeden sonra."
        : trigger === "fix"
          ? "Düzeltme istendi."
          : "Elle çalıştırıldı.";
  if (fixed) return `${base} ${fixes} düzeltme v${fixed.version} olarak kaydedildi.`;
  return fixes > 0 ? `${base} ${fixes} düzeltme uygulandı.` : base;
}
