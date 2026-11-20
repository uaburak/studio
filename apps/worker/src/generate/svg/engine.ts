/**
 * The SVG engine (docs/URETIM-RESIM.md §15, Faz 3): `content.generate` with `engine: "svg"`.
 *
 *   brand (profile, rules, voice, facts, skills) + pictures (logos, @images, product photos)
 *     → design model: each slide one SVG + caption + hashtags
 *     → sanitise (document.ts) → Chromium render + SVG lint (render.ts)
 *     → critique → revise with the renders and the report (1 + designFixPasses, at most 4 calls)
 *     → upload JPEGs → `generated` version whose slides are the SVG documents (the source)
 *     → caption, generation checks, the consented "AI görsel" slot's picture job.
 *
 * A chat revision (`revise_post`, a base version + an instruction) starts from the stored SVG of
 * that version: one edit call, then fix passes only for slides that could not be made. SVG posts
 * are edited only from the chat (decision 3); they are never opened on the Wecra canvas.
 */
import path from "node:path";
import {
  ApiError,
  type ContentCheckBrief,
  type ContentGenerateJobInput,
  canvasFormatFor,
  isSvgSlideHtml,
} from "@studio/contract";
import {
  type CarouselLintReport,
  findUnverifiedNumbers,
  type LintReport,
  lintCarousel,
  lintForPrompt,
} from "@studio/design-kit/lint";
import { combineResolvers } from "@studio/design-kit/render";
import { isBudgetExceeded } from "../../ai/policy.ts";
import { geminiUsageSink } from "../../ai/usage-recorder.ts";
import {
  brandSkillsUsed,
  DESIGN_SKILLS_BUDGET,
  designSkillsBlock,
  loadEnabledBrandSkills,
  selectBrandSkills,
} from "../../brand/skills.ts";
import type { SlideReport } from "../../checks/pipeline.ts";
import { ClaudeError, describeClaudeError, isClaudeError } from "../../claude/errors.ts";
import { limitParkMessage } from "../../claude/limit-text.ts";
import type { ClaudeContentBlock } from "../../claude/runner.ts";
import { describeGeminiError, isGeminiError } from "../../gemini/errors.ts";
import {
  callStructuredAi,
  fallbackNote,
  geminiAliasLabel,
  hasGeminiApiKey,
  resolveStructuredRoute,
  type StructuredFallback,
} from "../../gemini/json-call.ts";
import { prepareModelImage } from "../../media.ts";
import { type JobContext, RetryableError } from "../../registry.ts";
import { layoutFromReport } from "../../render/layout.ts";
import { createApiAssetPathResolver } from "../../video/render-reel.ts";
import { type BrandContext, loadBrandContext } from "../brand.ts";
import type { ContentGenerateDeps } from "../handler.ts";
import { isMalformedDesignOutput, presetFor, reaskNote, slideBounds } from "../pipeline.ts";
import { type EmptyImageSlot, queueSlotImageJobs } from "../slot-images.ts";
import { productPictures } from "../wecra/engine.ts";
import { captionWithHashtags } from "../wecra/plan.ts";
import {
  prepareSvgSlide,
  SvgSlideError,
  svgMediaIds,
  svgSlots,
  svgSourceForModel,
} from "./document.ts";
import {
  type SvgBrief,
  SvgDesignOutput,
  type SvgPicture,
  svgDesignSchema,
  svgEditPrompt,
  svgGeneratePrompt,
  svgRevisePrompt,
  svgSystemPrompt,
} from "./prompt.ts";
import { renderSvgSlide, svgRendererOf } from "./render.ts";

/** What the generation handler lends the engine (kept there: media aliases, the checks). */
export interface SvgHelpers {
  requestedModel?: string | undefined;
  requestedEffort?: string | undefined;
  resolveMedia(payload: {
    brief: string;
    imageBrief?: string | null | undefined;
    conversationId?: string | undefined;
  }): Promise<{
    files: {
      alias: string;
      path: string;
      width: number;
      height: number;
      mimeType: string;
      bytes: Uint8Array;
    }[];
    unresolved: string[];
  }>;
  check(input: {
    contentId: string;
    version: number | undefined;
    fix: boolean | "auto";
    brand?: BrandContext;
    reports?: ReadonlyMap<number, SlideReport>;
    unresolvedAliases?: readonly string[];
  }): Promise<{ brief: ContentCheckBrief } | null>;
}

/** Most model calls of one design: generate + up to 3 critique/fix passes. */
const MAX_PASSES = 3;
const MAX_PICTURES_SHOWN = 4;

interface CheckedSvgSlide {
  id: string;
  html: string | null;
  jpeg: Uint8Array | null;
  report: LintReport | null;
  failure: string | null;
  failureKind: "sanitize" | "render" | null;
  findings: string[];
}

interface CheckedSvgVersion {
  label: string;
  output: SvgDesignOutput;
  slides: CheckedSvgSlide[];
  carousel: CarouselLintReport | null;
  captionNumbers: string[];
  errors: number;
  warnings: number;
}

/**
 * Whether a `content.generate` job is a chat revision of an SVG post: no engine named (or `svg`),
 * a base version and an instruction, and that version's slides are SVG documents.
 */
export async function isSvgRevision(
  deps: Pick<ContentGenerateDeps, "api">,
  payload: ContentGenerateJobInput,
  signal: AbortSignal,
): Promise<boolean> {
  if (payload.engine !== undefined && payload.engine !== "svg") return false;
  if (payload.baseVersion === undefined || !payload.instructions?.trim()) return false;
  try {
    const base = await deps.api.client.contents.versions.get(
      payload.contentId,
      payload.baseVersion,
      { signal },
    );
    return base.slides.length > 0 && base.slides.every((s) => isSvgSlideHtml(s.html));
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

export async function runSvgGenerate(
  ctx: JobContext,
  deps: ContentGenerateDeps,
  payload: ContentGenerateJobInput,
  helpers: SvgHelpers,
): Promise<Record<string, unknown>> {
  try {
    return await designSvg(ctx, deps, payload, helpers);
  } catch (error) {
    throw describeSvgError(error, ctx, deps);
  }
}

async function designSvg(
  ctx: JobContext,
  deps: ContentGenerateDeps,
  payload: ContentGenerateJobInput,
  helpers: SvgHelpers,
): Promise<Record<string, unknown>> {
  const { api, settings, logger } = deps;
  const signal = ctx.signal;
  const init = { signal };
  const { brandId, contentId } = payload;

  const content = await api.client.contents.get(contentId, init);
  if (content.brandId !== brandId)
    throw new Error("Bu post başka bir markaya ait; üretim yapılmadı.");
  const contentType = payload.type ?? content.type;
  if (contentType === "reel")
    throw new Error("SVG motoru Reels üretmez; Reels için HTML motorunu seçin. Post üretilmedi.");
  if (content.status === "published" || content.status === "publishing")
    throw new Error(`“${content.title}” yayında ya da yayınlanıyor; yeniden tasarlanamaz.`);
  const renderer = svgRendererOf(deps.renderer());
  if (!renderer)
    throw new Error("SVG motoru bu Mac'in render motorunu kullanamadı; post üretilmedi.");

  // A previous attempt may have stored the version already (crash before the result).
  const existing = (
    await api.client.contents.versions.list(contentId, { limit: 20 }, init)
  ).items.find((v) => v.jobId === ctx.jobId);
  if (existing) {
    const full = await api.client.contents.versions.get(contentId, existing.version, init);
    const slotImages = await queueSlotImageJobs(deps, {
      jobId: ctx.jobId,
      payload,
      slides: [],
      slots: emptySlots(full.slides),
      imageSlot: payload.imageSlot ?? "none",
      signal,
    });
    return {
      contentId,
      engine: "svg",
      version: full.version,
      versionId: full.id,
      contentHash: full.contentHash,
      renderedAssetIds: full.slides.map((s) => s.renderedAssetId),
      reused: true,
      ...(slotImages ? { slotImages } : {}),
    };
  }

  const health = deps.health();
  if (
    (health.state === "unauthenticated" || health.state === "error") &&
    !hasGeminiApiKey(settings)
  )
    throw new Error(health.message);

  ctx.progress(0.05, "Marka profili okunuyor");
  const brand = await loadBrandContext({
    api,
    brandId,
    profileVersion: payload.brandProfileVersion,
    cacheDir: path.join(deps.stateDir, "cache", "assets"),
    signal,
  });
  const platforms = payload.targetPlatforms?.length
    ? payload.targetPlatforms
    : content.targetPlatforms.length
      ? content.targetPlatforms
      : ["instagram" as const];
  const title = payload.title ?? content.title;
  const briefText = payload.brief || content.brief;
  const skills = selectBrandSkills(await loadEnabledBrandSkills(api, brandId, signal), {
    budget: DESIGN_SKILLS_BUDGET,
    task: [title, briefText, payload.instructions ?? "", contentType, platforms.join(" ")].join(
      "\n",
    ),
  });
  brand.skillsBlock = designSkillsBlock(skills);
  const skillsUsed = brandSkillsUsed(skills);

  // "Neyi değiştireyim?" / revise_post: the stored SVG of the base version.
  const instruction = payload.instructions?.trim() ?? "";
  const base =
    payload.baseVersion !== undefined && instruction
      ? await api.client.contents.versions.get(contentId, payload.baseVersion, init)
      : null;
  const revision =
    base && base.slides.length > 0 && base.slides.every((s) => isSvgSlideHtml(s.html))
      ? base
      : null;

  ctx.progress(0.1, "Görseller hazırlanıyor");
  const media = await helpers.resolveMedia(payload);
  const shown: { label: string; bytes: Uint8Array }[] = [];
  const pictures: SvgPicture[] = [
    ...brand.logos.map((l) => ({
      path: l.path,
      kind: "logo",
      label: l.name,
      width: l.width,
      height: l.height,
      ...(l.on ? { note: `${l.on} zeminler için` } : {}),
    })),
    ...brand.images.map((a) => ({
      path: a.path,
      kind: "marka görseli",
      label: a.name,
      ...(a.note ? { note: a.note } : {}),
    })),
  ];
  const mediaIds = new Set<string>();
  for (const f of media.files) {
    const assetId = assetIdOfMediaPath(f.path);
    if (!assetId) continue;
    mediaIds.add(assetId);
    pictures.push({
      path: f.path,
      kind: `@${f.alias}`,
      label: f.alias,
      width: f.width,
      height: f.height,
    });
    shown.push({ label: `@${f.alias} = ${f.path}`, bytes: f.bytes });
  }
  const productIds = payload.productIds?.length
    ? payload.productIds
    : (payload.slotImage?.productIds ?? []);
  for (const p of await productPictures(deps, brandId, productIds, signal)) {
    const picturePath = `/media/${encodeURIComponent(p.picture.assetId)}.jpg`;
    mediaIds.add(p.picture.assetId);
    pictures.push({ path: picturePath, kind: p.picture.kind, label: p.picture.label });
    if (p.bytes) shown.push({ label: `${p.picture.label} = ${picturePath}`, bytes: p.bytes });
  }
  // A revision keeps the pictures its base shows (an approved slot picture among them).
  for (const s of revision?.slides ?? []) for (const id of svgMediaIds(s.html)) mediaIds.add(id);

  const textForSize = `${briefText}\n${payload.instructions ?? ""}`;
  const baseSlide = revision?.slides[0];
  const size = baseSlide
    ? { width: baseSlide.width, height: baseSlide.height }
    : canvasFormatFor(contentType, textForSize);
  const preset = presetFor(contentType, platforms);
  const brief: SvgBrief = {
    title,
    brief: briefText,
    contentType: contentType as SvgBrief["contentType"],
    platforms,
    size,
    safeArea: preset.safeArea,
    slides: revision
      ? revisionBounds(contentType, revision.slides.length)
      : slideBounds(contentType, textForSize),
    imageSlot: payload.imageSlot ?? (media.files.length ? "user_upload" : "none"),
    imageBrief: payload.imageBrief ?? null,
    instructions: revision ? null : (payload.instructions ?? null),
    date: payload.planItem?.date ?? null,
    pillar: payload.planItem?.pillar ?? null,
    language: brand.brand.defaultLanguage.split("-")[0] ?? "tr",
    pictures,
  };

  // The model: Claude (Gemini when Claude is out or a Gemini model was picked), with the web.
  const route = resolveStructuredRoute({
    requestedModel: helpers.requestedModel,
    requestedEffort: helpers.requestedEffort,
    defaultEffort: settings.effortDesign,
    defaultGeminiAlias: "gemini-flash",
    settings,
    claudeHealth: health,
    limitChoice: deps.aiPolicy?.limitChoice(),
  });
  const fallbackAlias = route.provider === "claude" ? route.fallbackAlias : route.alias;
  const hooks = {
    onPark: (info: Parameters<typeof limitParkMessage>[0]) =>
      ctx.progress(0.2, limitParkMessage(info)),
    onResume: () => ctx.progress(0.2, "Claude'a yeniden bağlanılıyor"),
  };
  let calls = 0;
  let reasked = 0;
  let fallback: StructuredFallback | undefined;
  let provider: string | null = null;
  let model: string | null = null;
  const system = svgSystemPrompt(brand, brief);
  const schema = svgDesignSchema(brief.slides);
  const invoke = async (label: string, blocks: ClaudeContentBlock[]) => {
    calls += 1;
    const res = await callStructuredAi({
      label: `svg-${label}-${contentId.slice(-8)}`,
      system,
      content: blocks,
      schema,
      route,
      gate: deps.gate,
      settings,
      timeoutMs: settings.claudeTimeoutMs,
      signal,
      hooks,
      webAccess: true,
      ...(deps.geminiFetch ? { geminiFetch: deps.geminiFetch } : {}),
      onGeminiUsage: geminiUsageSink(deps.aiUsage, { kind: "generate", jobId: ctx.jobId }),
      onFallback: (f) =>
        ctx.progress(
          0.22,
          f.reason === "claude_limit"
            ? `Claude sınırı doldu; ${geminiAliasLabel(fallbackAlias)} ile sürüyor`
            : `Claude kullanılamıyor; ${geminiAliasLabel(fallbackAlias)} ile sürüyor`,
        ),
    });
    fallback ??= res.fallback;
    provider = res.provider;
    model = res.model ?? null;
    return res.output;
  };
  /** One design answer; a malformed one is asked again once with the problem (U5). */
  const ask = async (label: string, text: string, images: ClaudeContentBlock[]) => {
    const blocks = (t: string): ClaudeContentBlock[] => [{ type: "text", text: t }, ...images];
    let raw: unknown;
    let retried = false;
    try {
      raw = await invoke(label, blocks(text));
    } catch (error) {
      if (!isMalformedDesignOutput(error)) throw error;
      retried = true;
      reasked += 1;
      raw = await invoke(
        `${label}-reask`,
        blocks(`${text}\n${reaskNote((error as Error).message)}`),
      );
    }
    let parsed = SvgDesignOutput.safeParse(raw);
    if (!parsed.success && !retried) {
      reasked += 1;
      raw = await invoke(
        `${label}-reask`,
        blocks(
          `${text}\n${reaskNote(`The answer did not match the output schema: ${parsed.error.message.slice(0, 1_200)}`)}`,
        ),
      );
      parsed = SvgDesignOutput.safeParse(raw);
    }
    if (!parsed.success)
      throw new ClaudeError(
        "output",
        `${label}: SVG design output does not match: ${parsed.error.message.slice(0, 300)}`,
      );
    const out = parsed.data;
    return {
      ...out,
      slides: out.slides
        .slice(0, brief.slides.max)
        .map((s, i) => ({ id: `slide-${i + 1}`, svg: s.svg })),
    };
  };

  const resolver = combineResolvers(brand.resolver, createApiAssetPathResolver(api, signal));
  const allowed = (count: number) => [
    ...new Set([
      ...brand.allowedNumbers,
      ...(contentType === "carousel" ? Array.from({ length: count }, (_, i) => String(i + 1)) : []),
    ]),
  ];
  const check = async (label: string, output: SvgDesignOutput): Promise<CheckedSvgVersion> => {
    const numbers = allowed(output.slides.length);
    const slides: CheckedSvgSlide[] = [];
    for (const s of output.slides) {
      signal.throwIfAborted();
      const slide: CheckedSvgSlide = {
        id: s.id,
        html: null,
        jpeg: null,
        report: null,
        failure: null,
        failureKind: null,
        findings: [],
      };
      try {
        const prepared = prepareSvgSlide(s.svg, {
          width: size.width,
          height: size.height,
          lang: brief.language,
          mediaIds,
        });
        slide.html = prepared.html;
        slide.findings = prepared.findings;
      } catch (error) {
        if (!(error instanceof SvgSlideError)) throw error;
        slide.failure = `the SVG could not be used: ${error.message}`;
        slide.failureKind = "sanitize";
        slides.push(slide);
        continue;
      }
      try {
        const res = await renderSvgSlide(renderer, {
          html: slide.html,
          width: size.width,
          height: size.height,
          resolver,
          signal,
          lint: {
            safeArea: brief.safeArea,
            brandFonts: brand.fontFamilies,
            systemFonts: brand.manifest.systemFontFamilies,
            ...(brand.allowedNumbers.length > 0 ? { allowedNumbers: numbers } : {}),
            lang: brief.language,
          },
        });
        slide.jpeg = res.jpeg;
        slide.report = res.report;
        if (!res.jpeg) {
          slide.failure = "render produced no JPEG";
          slide.failureKind = "render";
        }
      } catch (error) {
        signal.throwIfAborted();
        slide.failure = `render failed: ${(error as Error).message.slice(0, 300)}`;
        slide.failureKind = "render";
      }
      slides.push(slide);
    }
    const reports = slides.map((s) => s.report).filter((r): r is LintReport => r !== null);
    const carousel =
      contentType === "carousel" && reports.length === slides.length && reports.length > 1
        ? lintCarousel(reports)
        : null;
    const captionNumbers =
      brand.allowedNumbers.length > 0
        ? findUnverifiedNumbers(output.caption, numbers).map((n) => n.text)
        : [];
    const errors =
      slides.reduce((n, s) => n + (s.failure ? 1 : (s.report?.summary.errors ?? 0)), 0) +
      (carousel?.issues.filter((i) => i.severity === "error").length ?? 0) +
      captionNumbers.length;
    const warnings =
      slides.reduce((n, s) => n + (s.report?.summary.warnings ?? 0), 0) +
      (carousel?.issues.filter((i) => i.severity === "warning").length ?? 0);
    logger.info(
      `[svg ${contentId.slice(-8)}] ${label}: ${errors} error(s), ${warnings} warning(s)${slides.map((s) => ` | ${s.id}: ${s.failure ?? `${s.report?.summary.errors ?? "?"}e/${s.report?.summary.warnings ?? "?"}w`}`).join("")}`,
    );
    return { label, output, slides, carousel, captionNumbers, errors, warnings };
  };

  const lintPayload = (v: CheckedSvgVersion) => ({
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
  const extraIssues = (v: CheckedSvgVersion) => [
    ...v.captionNumbers.map(
      (n) => `caption: the number "${n}" is not in FACTS.allowedNumbers; remove it`,
    ),
    ...v.slides.filter((s) => s.failure).map((s) => `${s.id}: ${s.failure}`),
    ...v.slides.flatMap((s) => s.findings.slice(0, 6).map((f) => `${s.id}: cleaned: ${f}`)),
  ];
  const renders = async (v: CheckedSvgVersion) => {
    const blocks: ClaudeContentBlock[] = [];
    const names: string[] = [];
    for (const s of v.slides) {
      if (!s.jpeg) continue;
      const img = await prepareModelImage(s.jpeg, { maxEdge: settings.imageMaxEdge, quality: 85 });
      if (!img) continue;
      blocks.push({ type: "text", text: `${s.id}.jpg (${v.label} render):` });
      blocks.push({ type: "image", mediaType: img.mediaType, data: img.data });
      names.push(`${s.id}.jpg`);
    }
    return { blocks, names };
  };
  const svgOf = (v: CheckedSvgVersion) =>
    v.output.slides.map((s) => `<!-- ${s.id} -->\n${s.svg}`).join("\n\n");
  const hardFailures = (v: CheckedSvgVersion) => v.slides.filter((s) => s.failure).length;
  /** Fewer slides that could not be made first, then fewer errors (a tie keeps the newer). */
  const better = (next: CheckedSvgVersion, prev: CheckedSvgVersion) =>
    hardFailures(next) < hardFailures(prev) ||
    (hardFailures(next) === hardFailures(prev) && next.errors <= prev.errors);
  const passes = Math.min(MAX_PASSES, 1 + settings.designFixPasses);
  const versions: CheckedSvgVersion[] = [];
  let final: CheckedSvgVersion;

  if (revision) {
    // A chat revision: one edit from the stored SVG, fix passes only for slides not made.
    ctx.progress(0.2, "İstenen değişiklik uygulanıyor");
    const blocks: ClaudeContentBlock[] = [];
    const names: string[] = [];
    for (const [i, s] of revision.slides.entries()) {
      if (!s.renderedAssetId) continue;
      try {
        const { bytes } = await api.downloadAsset(s.renderedAssetId, {
          maxBytes: settings.imageMaxBytes,
          signal,
        });
        const img = await prepareModelImage(bytes, { maxEdge: settings.imageMaxEdge, quality: 85 });
        if (!img) continue;
        blocks.push({ type: "text", text: `slide-${i + 1}.jpg (v${revision.version} render):` });
        blocks.push({ type: "image", mediaType: img.mediaType, data: img.data });
        names.push(`slide-${i + 1}.jpg`);
      } catch (error) {
        signal.throwIfAborted();
        logger.warn(
          `could not load the render of v${revision.version}: ${(error as Error).message}`,
        );
      }
    }
    const current = revision.slides
      .map((s, i) => `<!-- slide-${i + 1} -->\n${svgSourceForModel(s.html) ?? ""}`)
      .join("\n\n");
    final = await check(
      "edit",
      await ask(
        "edit",
        svgEditPrompt({
          brief,
          instruction,
          baseVersion: revision.version,
          caption: content.caption,
          imageNames: names,
          svg: current,
        }),
        blocks,
      ),
    );
    versions.push(final);
    for (let pass = 1; pass < passes && hardFailures(final) > 0; pass++) {
      ctx.progress(0.7, "Tasarım hataları düzeltiliyor");
      const r = await renders(final);
      const fixed = await check(
        `fix${pass}`,
        await ask(
          `fix${pass}`,
          svgRevisePrompt({
            brief,
            pass,
            passes: passes - 1,
            imageNames: r.names,
            lint: lintPayload(final),
            extraIssues: extraIssues(final),
            svg: svgOf(final),
          }),
          r.blocks,
        ),
      );
      versions.push(fixed);
      if (better(fixed, final)) final = fixed;
    }
  } else {
    // 1. The design, with the pictures shown so the model sees what they are.
    ctx.progress(0.15, "SVG tasarım yazılıyor");
    const pictureBlocks: ClaudeContentBlock[] = [];
    for (const p of shown.slice(0, MAX_PICTURES_SHOWN)) {
      const img = await prepareModelImage(p.bytes, { maxEdge: settings.imageMaxEdge, quality: 85 });
      if (!img) continue;
      pictureBlocks.push({ type: "text", text: `${p.label}:` });
      pictureBlocks.push({ type: "image", mediaType: img.mediaType, data: img.data });
    }
    final = await check("v1", await ask("generate", svgGeneratePrompt(brief), pictureBlocks));
    versions.push(final);
    // 2. Critique → revise: once always, then while errors remain (1 + designFixPasses).
    for (let pass = 1; pass <= passes; pass++) {
      if (pass > 1 && final.errors === 0) break;
      ctx.progress(0.3 + (pass / passes) * 0.5, `Eleştiri ve düzeltme (${pass}/${passes})`);
      const r = await renders(final);
      const revised = await check(
        `v${pass + 1}`,
        await ask(
          `revise${pass}`,
          svgRevisePrompt({
            brief,
            pass,
            passes,
            imageNames: r.names,
            lint: lintPayload(final),
            extraIssues: extraIssues(final),
            svg: svgOf(final),
          }),
          r.blocks,
        ),
      );
      versions.push(revised);
      if (better(revised, final)) final = revised;
    }
  }

  const missing = final.slides.filter((s) => !s.jpeg || !s.html);
  if (missing.length > 0) {
    logger.warn(
      `[job ${ctx.jobId}] svg design not rendered: ${missing.map((s) => `${s.id}: ${s.failure ?? "?"}`).join("; ")}`,
    );
    throw new Error(
      `SVG tasarımı tamamlanamadı: ${missing
        .map((s) =>
          s.failureKind === "sanitize"
            ? `${s.id.replace("slide-", "")}. slaytın SVG'si güvenlik denetiminden geçmedi`
            : `${s.id.replace("slide-", "")}. slayt görsele dönüştürülemedi`,
        )
        .join("; ")}. Yeniden üretmeyi deneyin; sürerse talimatı sadeleştirin.`,
    );
  }

  ctx.progress(0.9, "Görseller yükleniyor");
  const renderedAssetIds: string[] = [];
  for (const [i, slide] of final.slides.entries()) {
    const asset = await api.client.assets.upload(
      {
        brandId,
        kind: "image",
        source: "generated",
        width: size.width,
        height: size.height,
        file: new Blob([(slide.jpeg as Uint8Array).slice()], { type: "image/jpeg" }),
        filename: `${slug(title)}-svg-${i + 1}.jpg`,
      },
      init,
    );
    renderedAssetIds.push(asset.id);
  }
  const caption = captionWithHashtags(final.output.caption, final.output.hashtags);
  const note = [
    fallback ? fallbackNote(fallback, fallbackAlias) : "",
    revision
      ? `SVG düzenleme (v${revision.version} üzerine): ${instruction.slice(0, 400)}`
      : `SVG motoruyla üretildi (${brand.label}).`,
    final.errors === 0
      ? `Denetim temiz (${final.warnings} uyarı).`
      : `Denetimde ${final.errors} hata kaldı; sohbetten düzeltilebilir.`,
    skillsUsed.length > 0 ? `Skill'ler: ${skillsUsed.join(", ")}.` : "",
    `${calls} model çağrısı.`,
  ]
    .filter(Boolean)
    .join(" ");

  ctx.progress(0.95, "Sürüm kaydediliyor");
  const version = await api.client.contents.versions.create(
    contentId,
    {
      origin: revision ? "ai_edit" : "generated",
      slides: final.slides.map((s) => ({
        html: s.html as string,
        width: size.width,
        height: size.height,
      })),
      note: note.slice(0, 2000),
      jobId: ctx.jobId,
      renderedAssetIds,
      layouts: final.slides.map((s) => layoutFromReport(s.report)),
    },
    init,
  );
  if (caption && caption !== content.caption) {
    await api.client.contents
      .update(contentId, { caption: caption.slice(0, 10_000) }, init)
      .catch((error: unknown) =>
        logger.warn(`could not store the caption: ${(error as Error).message}`),
      );
  }

  // The checks with the engine's own reports (no automatic HTML fix on an SVG version).
  const reports = new Map<number, SlideReport>(
    final.slides.map((s, i) => [
      i,
      { report: s.report, failure: s.failure, jpegBytes: s.jpeg?.byteLength ?? null },
    ]),
  );
  const checks = await helpers.check({
    contentId,
    version: version.version,
    fix: false,
    brand,
    reports,
    unresolvedAliases: media.unresolved,
  });

  // The consented "AI görsel": the product-image line fills the slot after approval.
  const slotImages = await queueSlotImageJobs(deps, {
    jobId: ctx.jobId,
    payload,
    slides: [],
    slots: emptySlots(version.slides),
    imageSlot: brief.imageSlot,
    signal,
  });

  ctx.progress(1, "Tamamlandı");
  return {
    contentId,
    engine: "svg",
    ...(revision ? { baseVersion: revision.version, revised: true } : {}),
    version: version.version,
    versionId: version.id,
    contentHash: version.contentHash,
    renderedAssetIds,
    checks: checks?.brief ?? null,
    ...(slotImages ? { slotImages } : {}),
    slides: final.slides.length,
    size,
    lintClean: final.errors === 0,
    errors: final.errors,
    warnings: final.warnings,
    lint: final.slides.map((s) => ({
      slide: s.id,
      errors: s.report?.summary.errors ?? null,
      warnings: s.report?.summary.warnings ?? null,
      rules: [
        ...new Set(
          (s.report?.issues ?? [])
            .filter((x) => x.severity !== "info")
            .map((x) => `${x.severity}:${x.rule}`),
        ),
      ],
    })),
    captionUnverifiedNumbers: final.captionNumbers,
    passes: versions.map((v) => ({ pass: v.label, errors: v.errors, warnings: v.warnings })),
    finalPass: final.label,
    critique: versions
      .flatMap((v) => v.output.critique)
      .slice(0, 12)
      .map((c) => `${c.severity}: ${c.issue}`.slice(0, 300)),
    rationale: final.output.rationale.slice(0, 2000),
    caption: caption || null,
    media: media.files.map((m) => `@${m.alias}`),
    unresolvedAliases: media.unresolved,
    brandSkills: skillsUsed,
    brandProfile: {
      mode: brand.mode,
      version: brand.profile?.version ?? null,
      ...(brand.fallbackReason ? { note: brand.fallbackReason } : {}),
    },
    calls,
    ...(reasked ? { reasked } : {}),
    provider,
    model,
    ...(fallback
      ? { fallback: { reason: fallback.reason, note: fallbackNote(fallback, fallbackAlias) } }
      : {}),
  };
}

/** The empty slot markers of SVG slides (what the slot-image line fills). */
export function emptySlots(slides: ReadonlyArray<{ html: string }>): EmptyImageSlot[] {
  return svgSlots(slides)
    .filter((s) => s.state === "empty")
    .map((s) => ({ slide: s.slide, slotId: s.slotId, ratio: s.ratio, label: s.label }));
}

/** Slide count of a revision: the base count; a carousel may grow or shrink a little. */
function revisionBounds(contentType: string, count: number): { min: number; max: number } {
  if (contentType !== "carousel") return { min: 1, max: 1 };
  return { min: Math.max(2, count - 3), max: Math.min(10, Math.max(count, 2) + 3) };
}

/** `/media/<assetId>.<ext>` → the asset id. */
function assetIdOfMediaPath(mediaPath: string): string | undefined {
  const name = mediaPath.split("/").pop() ?? "";
  return decodeURIComponent(name.replace(/\.[a-z0-9]+$/i, "")) || undefined;
}

function slug(text: string): string {
  return (
    text
      .toLocaleLowerCase("tr")
      .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c] ?? c)
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "post"
  );
}

/** A failure as the owner reads it (Turkish, what to do); transient ones are retried (U12). */
function describeSvgError(error: unknown, ctx: JobContext, deps: ContentGenerateDeps): unknown {
  if (ctx.signal.aborted) return ctx.signal.reason ?? error;
  deps.logger.warn(`[job ${ctx.jobId}] svg engine failed: ${(error as Error).message}`);
  if (isBudgetExceeded(error)) return error;
  if (isClaudeError(error)) {
    const message = describeClaudeError(error);
    return error.code === "transient" || error.code === "timeout"
      ? new RetryableError(message)
      : new Error(message);
  }
  if (isGeminiError(error)) {
    const message = describeGeminiError(error);
    return error.code === "transient" || error.code === "timeout"
      ? new RetryableError(message)
      : new Error(message);
  }
  if (error instanceof ApiError) {
    if (error.status === undefined || error.status >= 500)
      return new RetryableError(
        "Studio sunucusuna ulaşılamadı ya da sunucu hata verdi; üretim yeniden denenecek.",
      );
    if (error.status === 404)
      return new Error("Post ya da markası bulunamadı (silinmiş olabilir); üretim yapılmadı.");
    return new Error(
      "Studio sunucusu üretim sonucunu kabul etmedi. Postu yeniden üretmeyi deneyin.",
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    /[çğıİöşüÇĞÖŞÜ]/.test(message)
      ? message.slice(0, 1_000)
      : "Post SVG motoruyla üretilemedi. Yeniden deneyin; sürerse günlüklere bakın.",
  );
}
