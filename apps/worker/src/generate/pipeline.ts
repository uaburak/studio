/**
 * Design pipeline of one content item (the F0-2 spike's loop on design-kit v1):
 *
 *   brief -> Claude (slides HTML, caption) -> sanitize -> render + lint (+ carousel, caption numbers)
 *         -> Claude critique-and-revise with the renders and the lint report -> render + lint
 *         -> [fix pass while errors remain] -> upload JPEGs -> content version (origin "generated").
 */
import type { Content, ContentVersion } from "@studio/contract";
import {
  type CarouselLintReport,
  findUnverifiedNumbers,
  type LintReport,
  lintCarousel,
  lintForPrompt,
} from "@studio/design-kit/lint";
import { getPreset, type PlatformPreset, validateExport } from "@studio/design-kit/presets";
import type {
  AssetResolver,
  RenderAndLintRequest,
  RenderAndLintResult,
} from "@studio/design-kit/render";
import { combineResolvers, createMemoryResolver } from "@studio/design-kit/render";
import { SanitizeError, sanitizeSlideHtml } from "@studio/design-kit/sanitize";
import { ClaudeError } from "../claude/errors.ts";
import type { ClaudeGate, GateHooks } from "../claude/gate.ts";
import { addUsage, type ClaudeContentBlock, type ClaudeUsage } from "../claude/runner.ts";
import type { Logger } from "../log.ts";
import { prepareModelImage } from "../media.ts";
import type { BrandContext } from "./brand.ts";
import {
  buildDesignSystemPrompt,
  buildFixPrompt,
  buildGeneratePrompt,
  buildRevisePrompt,
  type DesignBrief,
  type MediaImage,
} from "./prompt.ts";
import { DesignOutput, designJsonSchema } from "./schema.ts";

/** What the pipeline needs from the renderer (the design-kit Renderer satisfies it). */
export interface SlideRenderer {
  renderAndLint(request: RenderAndLintRequest): Promise<RenderAndLintResult>;
}

export interface CheckedSlide {
  id: string;
  /** Sanitized HTML (what is stored and rendered). */
  html: string;
  jpeg: Uint8Array | null;
  report: LintReport | null;
  /** Render or sanitize failure. */
  failure: string | null;
  sanitizeFindings: number;
  renderMs: number;
}

export interface CheckedVersion {
  label: string;
  output: DesignOutput;
  slides: CheckedSlide[];
  carousel: CarouselLintReport | null;
  captionNumbers: string[];
  errors: number;
  warnings: number;
}

export interface MediaFile extends MediaImage {
  bytes: Uint8Array;
}

export interface ModelCallerInput {
  label: string;
  system: string;
  content: ClaudeContentBlock[];
  schema: object;
  signal: AbortSignal;
}

export interface ModelCallerResult {
  output: unknown;
  model?: string | undefined;
  provider?: "claude" | "gemini";
  usage: ClaudeUsage;
}

export type DesignModelCaller = (input: ModelCallerInput) => Promise<ModelCallerResult>;

export interface PipelineInput {
  brand: BrandContext;
  brief: DesignBrief;
  media: MediaFile[];
  gate: ClaudeGate;
  /** Optional provider-agnostic caller (used for Gemini or Claude->Gemini fallback). */
  modelCaller?: DesignModelCaller;
  renderer: SlideRenderer;
  model: string;
  effort?: string | undefined;
  timeoutMs: number;
  fixPasses: number;
  imageMaxEdge: number;
  signal: AbortSignal;
  logger: Logger;
  progress: (value: number, message: string) => void;
  hooks?: GateHooks;
  /** Label prefix for Claude logs. */
  label: string;
}

export interface PipelineResult {
  final: CheckedVersion;
  versions: CheckedVersion[];
  calls: number;
  usage: ClaudeUsage | undefined;
  timings: { claudeMs: number; renderMs: number; totalMs: number };
  model: string | undefined;
  provider?: "claude" | "gemini";
}

/** Preset for a content type and platform list (Instagram 4:5 feed by default). */
export function presetFor(contentType: string, platforms: readonly string[]): PlatformPreset {
  const platform = platforms.includes("instagram")
    ? "instagram"
    : (platforms.find((p) => p === "facebook" || p === "linkedin") ?? "instagram");
  const id =
    contentType === "story"
      ? platform === "facebook"
        ? "facebook-story"
        : "instagram-story"
      : `${platform}-feed-portrait`;
  return getPreset(id) ?? (getPreset("instagram-feed-portrait") as PlatformPreset);
}

/** Slide count bounds: posts and stories 1; carousels what the brief says, else 3–6. */
export function slideBounds(contentType: string, brief: string): { min: number; max: number } {
  if (contentType !== "carousel") return { min: 1, max: 1 };
  const asked = /(\d{1,2})\s*(?:slayt|slide|sayfa|kart|görsel)/i.exec(brief);
  if (asked?.[1]) {
    const n = Math.min(10, Math.max(2, Number(asked[1])));
    return { min: n, max: n };
  }
  return { min: 3, max: 6 };
}

export async function runDesignPipeline(input: PipelineInput): Promise<PipelineResult> {
  const t0 = Date.now();
  const { brand, brief, gate, signal, logger } = input;
  const system = buildDesignSystemPrompt(brand);
  const resolver: AssetResolver = combineResolvers(
    brand.resolver,
    createMemoryResolver(Object.fromEntries(input.media.map((m) => [m.path, m.bytes]))),
  );
  let usage: ClaudeUsage | undefined;
  let calls = 0;
  let claudeMs = 0;
  let renderMs = 0;
  let model: string | undefined;
  let provider: "claude" | "gemini" | undefined;

  const call = async (
    step: string,
    text: string,
    images: ClaudeContentBlock[],
  ): Promise<DesignOutput> => {
    const started = Date.now();
    const schema = designJsonSchema({
      minSlides: brief.slides.min,
      maxSlides: brief.slides.max,
      critique: true,
    });
    const label = `${input.label}-${step}`;
    const content: ClaudeContentBlock[] = [{ type: "text", text }, ...images];
    const result: ModelCallerResult = input.modelCaller
      ? await input.modelCaller({ label, system, content, schema, signal })
      : await gate.call(
          {
            label,
            system,
            content,
            // One schema for every pass of a post: the StructuredOutput tool definition is part of
            // the prompt-cache prefix, so an identical schema lets later passes read the ~20K-token
            // system prompt from the cache instead of writing it again.
            schema,
            model: input.model,
            ...(input.effort ? { effort: input.effort } : {}),
            timeoutMs: input.timeoutMs,
            signal,
          },
          input.hooks ?? {},
        );
    claudeMs += Date.now() - started;
    calls++;
    usage = addUsage(usage, result.usage);
    model ??= result.model;
    provider ??= result.provider ?? "claude";
    const parsed = DesignOutput.safeParse(result.output);
    if (!parsed.success) {
      throw new ClaudeError(
        "output",
        `${step}: design output does not match: ${parsed.error.message.slice(0, 300)}`,
      );
    }
    logger.info(
      `[${input.label}] ${step}: ${parsed.data.slides.length} slide(s), ${result.usage.outputTokens} output tokens, ${Math.round(result.usage.wallMs / 1000)} s`,
    );
    return normalizeSlides(parsed.data, brief.slides.max);
  };

  const allowedNumbers = (count: number) => [
    ...new Set([
      ...brand.allowedNumbers,
      ...(brief.contentType === "carousel"
        ? Array.from({ length: count }, (_, i) => String(i + 1))
        : []),
    ]),
  ];

  const check = async (label: string, output: DesignOutput): Promise<CheckedVersion> => {
    const allowed = allowedNumbers(output.slides.length);
    const slides: CheckedSlide[] = [];
    for (const s of output.slides) {
      signal.throwIfAborted();
      const slide: CheckedSlide = {
        id: s.id,
        html: s.html,
        jpeg: null,
        report: null,
        failure: null,
        sanitizeFindings: 0,
        renderMs: 0,
      };
      try {
        const clean = sanitizeSlideHtml(s.html);
        slide.html = clean.html;
        slide.sanitizeFindings = clean.findings.length;
      } catch (error) {
        slide.failure =
          error instanceof SanitizeError
            ? `the HTML could not be sanitised: ${error.message}`
            : `sanitiser failed: ${(error as Error).message}`;
        slides.push(slide);
        continue;
      }
      const started = Date.now();
      try {
        const res = await input.renderer.renderAndLint({
          html: slide.html,
          width: brief.preset.width,
          height: brief.preset.height,
          formats: ["jpeg"],
          jpegQuality: 92,
          resolver,
          signal,
          lint: {
            safeArea: brief.preset.safeArea,
            brandFonts: brand.fontFamilies,
            allowedNumbers: allowed,
            lang: brief.language,
            logoClearSpaceByPath: brand.logoClearSpaceByPath,
          },
        });
        slide.jpeg = res.jpeg ?? null;
        slide.report = res.report;
      } catch (error) {
        signal.throwIfAborted();
        slide.failure = `render failed: ${(error as Error).message.slice(0, 300)}`;
      }
      slide.renderMs = Date.now() - started;
      renderMs += slide.renderMs;
      slides.push(slide);
    }
    const reports = slides.map((s) => s.report).filter((r): r is LintReport => r !== null);
    const carousel =
      brief.contentType === "carousel" && reports.length === slides.length && reports.length > 1
        ? lintCarousel(reports)
        : null;
    const captionNumbers = findUnverifiedNumbers(output.caption, allowed).map((n) => n.text);
    const errors =
      slides.reduce((n, s) => n + (s.failure ? 1 : (s.report?.summary.errors ?? 0)), 0) +
      (carousel?.issues.filter((i) => i.severity === "error").length ?? 0) +
      captionNumbers.length;
    const warnings =
      slides.reduce((n, s) => n + (s.report?.summary.warnings ?? 0), 0) +
      (carousel?.issues.filter((i) => i.severity === "warning").length ?? 0);
    logger.info(
      `[${input.label}] ${label}: ${errors} error(s), ${warnings} warning(s)${slides.map((s) => ` | ${s.id}: ${s.failure ?? `${s.report?.summary.errors ?? "?"}e/${s.report?.summary.warnings ?? "?"}w`}`).join("")}`,
    );
    return {
      label,
      output: {
        ...output,
        slides: output.slides.map((s, i) => ({ ...s, html: slides[i]?.html ?? s.html })),
      },
      slides,
      carousel,
      captionNumbers,
      errors,
      warnings,
    };
  };

  const lintPayload = (v: CheckedVersion) => ({
    slides: v.slides.map((s) =>
      s.report
        ? { slide: s.id, ...lintForPrompt(s.report) }
        : { slide: s.id, ok: false, failure: s.failure },
    ),
    ...(v.carousel
      ? {
          carousel: v.carousel.issues.map(({ rule, severity, layer, message }) => ({
            rule,
            severity,
            layer,
            message,
          })),
        }
      : {}),
  });
  const extraIssues = (v: CheckedVersion) => [
    ...v.captionNumbers.map(
      (n) =>
        `caption: the number "${n}" is not in FACTS.allowedNumbers; remove it or rephrase without it`,
    ),
    ...v.slides.filter((s) => s.failure).map((s) => `${s.id}: ${s.failure}`),
  ];
  const renders = async (
    v: CheckedVersion,
  ): Promise<{ blocks: ClaudeContentBlock[]; names: string[] }> => {
    const blocks: ClaudeContentBlock[] = [];
    const names: string[] = [];
    for (const s of v.slides) {
      if (!s.jpeg) continue;
      const img = await prepareModelImage(s.jpeg, { maxEdge: input.imageMaxEdge, quality: 85 });
      if (!img) continue;
      blocks.push({ type: "text", text: `${s.id}.jpg (${v.label} render):` });
      blocks.push({ type: "image", mediaType: img.mediaType, data: img.data });
      names.push(`${s.id}.jpg`);
    }
    return { blocks, names };
  };
  const htmlOf = (v: CheckedVersion) =>
    v.output.slides.map((s) => `<!-- ${s.id} -->\n${s.html}`).join("\n\n");

  // 1. First pass, with the user's images attached so the model sees what they show.
  input.progress(0.2, "Tasarım yazılıyor (1/2)");
  const mediaBlocks: ClaudeContentBlock[] = [];
  for (const m of input.media.filter((x) => x.attached)) {
    const img = await prepareModelImage(m.bytes, { maxEdge: input.imageMaxEdge });
    if (!img) continue;
    mediaBlocks.push({
      type: "text",
      text: `User image @${m.alias} = ${m.path} (${m.width}x${m.height}):`,
    });
    mediaBlocks.push({ type: "image", mediaType: img.mediaType, data: img.data });
  }
  const ids =
    brief.slides.max === 1
      ? " (slide-1)"
      : ` (slide-1 … slide-N, N between ${brief.slides.min} and ${brief.slides.max})`;
  const v1 = await check(
    "v1",
    await call("generate", buildGeneratePrompt(brief, ids), mediaBlocks),
  );
  const versions = [v1];

  // 2. Critique and revise (one pass) with the renders and the lint report.
  input.progress(0.5, "Eleştiri ve düzeltme (2/2)");
  const r1 = await renders(v1);
  const v2 = await check(
    "v2",
    await call(
      "revise",
      buildRevisePrompt({
        brief,
        imageNames: r1.names,
        lint: lintPayload(v1),
        extraIssues: extraIssues(v1),
        html: htmlOf(v1),
      }),
      r1.blocks,
    ),
  );
  versions.push(v2);
  let final = v2.errors <= v1.errors ? v2 : v1;

  // 3. Targeted fix passes while errors remain.
  for (let pass = 1; pass <= input.fixPasses && final.errors > 0; pass++) {
    input.progress(0.75, `Denetim hataları düzeltiliyor (${final.errors})`);
    const r = await renders(final);
    const fixed = await check(
      `fix${pass}`,
      await call(
        `fix${pass}`,
        buildFixPrompt({
          brief,
          lint: lintPayload(final),
          extraIssues: extraIssues(final),
          html: htmlOf(final),
        }),
        r.blocks,
      ),
    );
    versions.push(fixed);
    if (fixed.errors <= final.errors) final = fixed;
  }

  return {
    final,
    versions,
    calls,
    usage,
    timings: { claudeMs, renderMs, totalMs: Date.now() - t0 },
    model,
    ...(provider ? { provider } : {}),
  };
}

/** Ids `slide-1..N` in order, at most `max` slides. */
function normalizeSlides(output: DesignOutput, max: number): DesignOutput {
  const slides = output.slides
    .slice(0, max)
    .map((s, i) => ({ id: `slide-${i + 1}`, html: s.html }));
  return { ...output, slides };
}

/** Export check of the final JPEGs against the preset (size, format, aspect). */
export function exportIssues(preset: PlatformPreset, slides: readonly CheckedSlide[]): string[] {
  const out: string[] = [];
  for (const s of slides) {
    if (!s.jpeg) continue;
    const res = validateExport(preset, {
      format: "jpeg",
      width: preset.width,
      height: preset.height,
      bytes: s.jpeg.byteLength,
    });
    for (const issue of res.issues) out.push(`${s.id}: ${issue.message}`);
  }
  return out;
}

export interface StoredVersion {
  version: ContentVersion;
  renderedAssetIds: string[];
  reused: boolean;
}

export type { Content };
