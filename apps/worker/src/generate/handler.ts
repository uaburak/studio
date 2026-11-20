/**
 * `content.generate`: design one content item (static post/carousel/story or 9:16 Reel),
 * render it, upload the JPEGs / MP4 and store a content version (origin "generated")
 * whose slides carry the HTML and the rendered asset ids.
 *
 * Supports both Claude Code (`gate.call`) and automatic Gemini fallback (`GEMINI_API_KEY`)
 * when a `gemini-*` model is requested or when Claude is signed out / usage-limited.
 */

import path from "node:path";
import {
  ApiError,
  type ContentCheckBrief,
  type ContentGenerateJobInput,
  ContentGeneratePayload,
  type ConversationAlias,
  DEFAULT_GENERATION_ENGINE,
  engineNotReadyError,
  parseContentGenerateJob,
  resolveAliasMentions,
  type TemplateFill,
} from "@studio/contract";
import type { AgentDeps } from "../agent.ts";
import { isBudgetExceeded } from "../ai/policy.ts";
import { geminiUsageSink } from "../ai/usage-recorder.ts";
import type { StudioApi } from "../api.ts";
import {
  brandSkillsUsed,
  DESIGN_SKILLS_BUDGET,
  designSkillsBlock,
  loadEnabledBrandSkills,
  selectBrandSkills,
} from "../brand/skills.ts";
import type { ModelCaller } from "../checks/model.ts";
import { failedBrief, runContentChecks, type SlideReport } from "../checks/pipeline.ts";
import { describeClaudeError, isClaudeError } from "../claude/errors.ts";
import { limitParkMessage } from "../claude/limit-text.ts";
import { describeGeminiError, isGeminiError } from "../gemini/errors.ts";
import {
  callStructuredAi,
  fallbackNote,
  geminiAliasLabel,
  hasGeminiApiKey,
  resolveStructuredRoute,
} from "../gemini/json-call.ts";
import { extensionForMime, imageInfo } from "../media.ts";
import { asData } from "../prompt-data.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";
import { RENDER_ASSET_PREFIXES } from "../render/handler.ts";
import { layoutFromReport, missingSystemFonts } from "../render/layout.ts";
import {
  createApiAssetPathResolver,
  generateAndRenderReel,
  type ReelEngineTestSeams,
} from "../video/render-reel.ts";
import { type BrandContext, loadBrandContext } from "./brand.ts";
import {
  type DesignRevision,
  exportIssues,
  type MediaFile,
  presetFor,
  runDesignPipeline,
  type SlideRenderer,
  slideBounds,
  slideFailureMessage,
} from "./pipeline.ts";
import type { DesignBrief } from "./prompt.ts";
import { loadRepurpose, reelSpecFromPost, repurposeMedia, storyBrief } from "./repurpose.ts";
import { queueSlotImageJobs } from "./slot-images.ts";
import { runTemplateGenerate, type TemplateAiCaller } from "./template.ts";

export interface ContentGenerateDeps extends AgentDeps {
  /** Shared Chromium renderer (lazily launched). */
  renderer: () => SlideRenderer;
  reelSeams?: ReelEngineTestSeams;
  /** Test seam: the checks' model pass (default: Gemini Flash-Lite, else Claude Haiku). */
  checkModelCaller?: ModelCaller | null;
  /** Template fills on the canvas: poll interval and wait for the canvas runner (N9). */
  canvasPollMs?: number;
  canvasTimeoutMs?: number;
}

/** Most user images a single design takes. */
const MAX_MEDIA = 3;

export function createContentGenerateHandler(deps: ContentGenerateDeps) {
  return defineHandler({
    payload: ContentGeneratePayload,
    run: (_payload, ctx) => runContentGenerate(ctx, deps),
  });
}

/**
 * The named products as a data block for the designer ("Ürün: Boro — açıklama; notlar"); null
 * when none could be read. A product that is gone is skipped.
 */
export async function productFacts(
  api: StudioApi,
  brandId: string,
  productIds: readonly string[],
  signal: AbortSignal,
): Promise<string | null> {
  const lines: string[] = [];
  for (const id of productIds.slice(0, 8)) {
    try {
      const p = await api.client.brandProducts.get(brandId, id, { signal });
      const bits = [
        p.description,
        p.category ? `kategori: ${p.category}` : "",
        p.tags.length ? `etiketler: ${p.tags.join(", ")}` : "",
        p.notes ? `notlar: ${p.notes}` : "",
      ].filter(Boolean);
      lines.push(`- ${p.name}${bits.length ? `: ${bits.join("; ")}` : ""}`.slice(0, 1_200));
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
  }
  if (lines.length === 0) return null;
  return `Postun konusu olan ürünler (marka verisi; yalnızca burada yazanı söyle, uydurma):\n${asData(lines.join("\n"))}`;
}

async function runContentGenerate(
  ctx: JobContext,
  deps: ContentGenerateDeps,
): Promise<Record<string, unknown>> {
  const { api, settings, logger } = deps;
  const signal = ctx.signal;
  const init = { signal };
  const parsed = parseContentGenerateJob(ctx.job);
  if (!parsed.ok) {
    logger.warn(`[job ${ctx.jobId}] invalid content.generate payload: ${parsed.error}`);
    throw new Error(
      "Üretim isteği eksik ya da bozuk geldi; post üretilemedi. Postu yeniden üretmeyi deneyin.",
    );
  }
  const payload = parsed.payload;
  const { brandId, contentId } = payload;

  // The design engine the owner picked: only HTML runs today; the others fail clearly and never
  // fall back to HTML (docs/URETIM-RESIM.md).
  const engineError = engineNotReadyError(payload.engine ?? DEFAULT_GENERATION_ENGINE);
  if (engineError) throw new Error(`${engineError}; post üretilmedi.`);

  // `@ürün` mentions: the products' own facts go to the designer with the instructions.
  // A plan item's consented slot picture names its products too.
  const factIds = payload.productIds?.length ? payload.productIds : payload.slotImage?.productIds;
  if (factIds?.length) {
    const facts = await productFacts(api, brandId, factIds, signal);
    if (facts) {
      payload.instructions = [payload.instructions ?? "", facts].filter(Boolean).join("\n\n");
    }
  }

  const requestedModel =
    typeof ctx.job.payload.model === "string" ? ctx.job.payload.model : payload.model;
  const requestedEffort =
    typeof ctx.job.payload.effort === "string" ? ctx.job.payload.effort : payload.effort;

  // A brand template (N9): its layout exactly, only its fields change (template.ts).
  if (payload.template) {
    try {
      return await runTemplateJob(
        ctx,
        deps,
        { ...payload, template: payload.template },
        {
          requestedModel,
          requestedEffort,
        },
      );
    } catch (error) {
      throw describeGenerateError(error, ctx, deps);
    }
  }

  const health = deps.health();
  const geminiReady = hasGeminiApiKey(settings);
  // Reels plan with AI when they can and fall back to a template (or render a given spec).
  if (
    payload.type !== "reel" &&
    (health.state === "unauthenticated" || health.state === "error") &&
    !geminiReady
  ) {
    throw new Error(health.message);
  }

  try {
    ctx.progress(0.02, "Hazırlanıyor");
    // A previous attempt may have stored the version already (crash before the result).
    const existing = (
      await api.client.contents.versions.list(contentId, { limit: 20 }, init)
    ).items.find((v) => v.jobId === ctx.jobId);
    if (existing) {
      const full = await api.client.contents.versions.get(contentId, existing.version, init);
      logger.info(
        `[job ${ctx.jobId}] version ${existing.version} already stored by an earlier attempt`,
      );
      // The slot picture the earlier attempt may not have queued yet (never twice).
      const slotImages = await queueSlotImageJobs(deps, {
        jobId: ctx.jobId,
        payload,
        slides: full.slides,
        imageSlot: payload.imageSlot ?? "none",
        signal,
      });
      return {
        contentId,
        version: full.version,
        versionId: full.id,
        contentHash: full.contentHash,
        renderedAssetIds: full.slides.map((s) => s.renderedAssetId),
        reused: true,
        ...(slotImages ? { slotImages } : {}),
      };
    }

    const content = await api.client.contents.get(contentId, init);
    if (content.brandId !== brandId)
      throw new Error("Bu post başka bir markaya ait; üretim yapılmadı.");
    const contentType = payload.type ?? content.type;

    if (contentType === "reel") {
      const media = await resolveMedia(deps, payload, signal);
      const legacy = ctx.job.payload;
      const reel = payload.reel ?? {};
      const options = {
        ...reel,
        ...(reel.recipe === undefined && typeof legacy.recipe === "string"
          ? { recipe: legacy.recipe as NonNullable<typeof reel.recipe> }
          : {}),
        clipAssetId:
          reel.clipAssetId ??
          (typeof legacy.videoClipAssetId === "string" ? legacy.videoClipAssetId : undefined) ??
          media.videoAssetId,
        audioAssetId:
          reel.audioAssetId ??
          (typeof legacy.audioAssetId === "string" ? legacy.audioAssetId : undefined) ??
          media.audioAssetId,
      };
      const heroFile = media.files[0];
      // A post converted into a Reels (N10): its slides as motion-graphics scenes, no AI.
      if (payload.repurpose) {
        ctx.progress(0.05, "Kaynak post okunuyor");
        const repurposed = await loadRepurpose(deps, payload.repurpose, signal);
        const brandName = (await api.client.brands.get(brandId, init)).name;
        options.spec = reelSpecFromPost(repurposed.post, {
          brandName,
          title: payload.title ?? content.title,
        }) as NonNullable<typeof options.spec>;
      }
      const reelOut = await generateAndRenderReel({
        deps,
        renderer: deps.renderer(),
        ...(deps.reelSeams ? { seams: deps.reelSeams } : {}),
        jobId: ctx.jobId,
        brandId,
        content,
        title: payload.title ?? content.title,
        brief: payload.brief || content.brief,
        instructions: payload.instructions ?? null,
        ...(payload.targetPlatforms?.length ? { platforms: payload.targetPlatforms } : {}),
        requestedModel,
        requestedEffort,
        options: Object.fromEntries(
          Object.entries(options).filter(([, v]) => v !== undefined),
        ) as typeof options,
        baseVersion: payload.baseVersion,
        heroAssetId: heroFile ? assetIdFromMediaPath(heroFile.path) : undefined,
        brandProfileVersion: payload.brandProfileVersion,
        signal,
        progress: (v, m) => ctx.progress(v, m),
      });
      const reelVersion = typeof reelOut.version === "number" ? reelOut.version : undefined;
      const checks = await checkGenerated(deps, ctx, {
        contentId,
        version: reelVersion,
        fix: false,
        unresolvedAliases: media.unresolved,
      });
      return { ...reelOut, ...(checks ? { checks: checks.brief } : {}) };
    }

    if ((health.state === "unauthenticated" || health.state === "error") && !geminiReady) {
      throw new Error(health.message);
    }
    const route = resolveStructuredRoute({
      requestedModel,
      requestedEffort,
      defaultEffort: settings.effortDesign,
      defaultGeminiAlias: "gemini-flash",
      settings,
      claudeHealth: health,
      limitChoice: deps.aiPolicy?.limitChoice(),
    });

    ctx.progress(0.05, "Marka profili okunuyor");
    const brand = await loadBrandContext({
      api,
      brandId,
      profileVersion: payload.brandProfileVersion,
      cacheDir: path.join(deps.stateDir, "cache", "assets"),
      signal,
    });
    if (brand.mode === "neutral") {
      logger.warn(
        `[job ${ctx.jobId}] ${brand.fallbackReason ?? "no profile"}: using the neutral default`,
      );
    }

    ctx.progress(0.1, "Görseller hazırlanıyor");
    const media = await resolveMedia(deps, payload, signal);
    // A post converted into a story (N10): its texts and pictures are the brief.
    let repurposeNote = "";
    if (payload.repurpose) {
      const repurposed = await loadRepurpose(deps, payload.repurpose, signal);
      const extra = await repurposeMedia(deps, repurposed.images, signal);
      media.files.push(...extra.files.slice(0, Math.max(0, MAX_MEDIA - media.files.length)));
      const story = storyBrief({
        source: repurposed.source,
        post: repurposed.post,
        media: media.files,
        platforms: payload.targetPlatforms?.length
          ? payload.targetPlatforms
          : content.targetPlatforms,
        instructions: payload.instructions ?? null,
      });
      payload.brief = story.brief;
      payload.instructions = story.instructions;
      repurposeNote = `“${repurposed.source.title}” v${repurposed.version.version} postundan dönüştürüldü.`;
    }

    const platforms = payload.targetPlatforms?.length
      ? payload.targetPlatforms
      : content.targetPlatforms.length
        ? content.targetPlatforms
        : ["instagram" as const];

    // "Neyi değiştireyim?": a base version plus an instruction revises that design.
    const instruction = payload.instructions?.trim() ?? "";
    const revision =
      payload.baseVersion !== undefined && instruction
        ? await loadRevision(
            deps,
            contentId,
            payload.baseVersion,
            instruction,
            content.caption,
            signal,
          )
        : undefined;
    const basePreset = presetFor(contentType, platforms);
    const baseSlide = revision?.slides[0];
    const preset =
      baseSlide && (baseSlide.width !== basePreset.width || baseSlide.height !== basePreset.height)
        ? { ...basePreset, width: baseSlide.width, height: baseSlide.height }
        : basePreset;
    // The brand's enabled skills, the ones that fit this brief first.
    const skills = selectBrandSkills(await loadEnabledBrandSkills(api, brandId, signal), {
      budget: DESIGN_SKILLS_BUDGET,
      task: [
        payload.title ?? content.title,
        payload.brief || content.brief,
        payload.instructions ?? "",
        contentType,
        platforms.join(" "),
      ].join("\n"),
    });
    brand.skillsBlock = designSkillsBlock(skills);
    const skillsUsed = brandSkillsUsed(skills);

    const brief: DesignBrief = {
      title: payload.title ?? content.title,
      brief: payload.brief || content.brief,
      contentType: contentType as DesignBrief["contentType"],
      platforms,
      date: payload.planItem?.date ?? null,
      pillar: payload.planItem?.pillar ?? null,
      imageSlot: payload.imageSlot ?? (media.files.length ? "user_upload" : "none"),
      imageBrief: payload.imageBrief ?? null,
      instructions: payload.instructions ?? null,
      preset,
      slides: revision
        ? revisionBounds(contentType, revision.slides.length)
        : slideBounds(contentType, `${payload.brief}\n${payload.instructions ?? ""}`),
      media: media.files.map(({ bytes: _bytes, ...m }) => m),
      language: brand.brand.defaultLanguage.split("-")[0] ?? "tr",
    };

    // At Claude's limit the job shows what it waits for (S7, U3).
    const hooks = {
      onPark: (info: Parameters<typeof limitParkMessage>[0]) =>
        ctx.progress(0.2, limitParkMessage(info)),
      onResume: () => ctx.progress(0.2, "Claude'a yeniden bağlanılıyor"),
    };
    const fallbackAlias = route.provider === "claude" ? route.fallbackAlias : route.alias;
    if (route.provider === "gemini" && route.fallback?.reason === "claude_limit") {
      ctx.progress(0.04, `Claude sınırı doldu; ${geminiAliasLabel(route.alias)} ile üretiliyor`);
    }
    const requestedLabelModel = route.provider === "gemini" ? route.alias : route.model;
    const useCustomCaller = route.provider === "gemini" || route.canFallbackToGemini;

    const result = await runDesignPipeline({
      brand,
      brief,
      media: media.files,
      gate: deps.gate,
      ...(useCustomCaller
        ? {
            modelCaller: (callInput) =>
              callStructuredAi({
                label: callInput.label,
                system: callInput.system,
                content: callInput.content,
                schema: callInput.schema,
                route,
                gate: deps.gate,
                settings,
                timeoutMs: settings.claudeTimeoutMs,
                signal: callInput.signal,
                hooks,
                // Current design trends and references (docs/URETIM-RESIM.md §4); read-only.
                webAccess: true,
                ...(deps.geminiFetch ? { geminiFetch: deps.geminiFetch } : {}),
                onGeminiUsage: geminiUsageSink(deps.aiUsage, {
                  kind: "generate",
                  jobId: ctx.jobId,
                }),
                onFallback: (f) =>
                  ctx.progress(
                    0.22,
                    f.reason === "claude_limit"
                      ? `Claude sınırı doldu; ${geminiAliasLabel(fallbackAlias)} ile sürüyor`
                      : `Claude kullanılamıyor; ${geminiAliasLabel(fallbackAlias)} ile sürüyor`,
                  ),
              }),
          }
        : {}),
      renderer: deps.renderer(),
      model: requestedLabelModel,
      effort: route.effort,
      timeoutMs: settings.claudeTimeoutMs,
      fixPasses: settings.designFixPasses,
      imageMaxEdge: settings.imageMaxEdge,
      signal,
      logger,
      progress: (v, m) => ctx.progress(v, m),
      hooks,
      webAccess: true,
      label: `content-${contentId.slice(-8)}`,
      ...(revision
        ? {
            revision: revision.input,
            extraResolver: createApiAssetPathResolver(api, signal),
            assetPrefixes: RENDER_ASSET_PREFIXES,
          }
        : {}),
    });
    const final = result.final;
    const missing = final.slides.filter((s) => !s.jpeg);
    if (missing.length > 0) {
      logger.warn(
        `[job ${ctx.jobId}] design not rendered: ${missing.map((s) => `${s.id}: ${s.failure ?? "?"}`).join("; ")}`,
      );
      throw new Error(slideFailureMessage(final.slides));
    }

    ctx.progress(0.9, "Görseller yükleniyor");
    const renderedAssetIds: string[] = [];
    for (const [i, slide] of final.slides.entries()) {
      const jpeg = slide.jpeg as Uint8Array;
      const asset = await api.client.assets.upload(
        {
          brandId,
          kind: "image",
          source: "generated",
          width: brief.preset.width,
          height: brief.preset.height,
          file: new Blob([jpeg.slice()], { type: "image/jpeg" }),
          filename: `${slug(brief.title)}-${i + 1}.jpg`,
        },
        init,
      );
      renderedAssetIds.push(asset.id);
    }

    const lintSummary = final.slides.map((s) => ({
      slide: s.id,
      errors: s.report?.summary.errors ?? null,
      warnings: s.report?.summary.warnings ?? null,
      info: s.report?.summary.info ?? null,
      rules: [
        ...new Set(
          (s.report?.issues ?? [])
            .filter((x) => x.severity !== "info")
            .map((x) => `${x.severity}:${x.rule}`),
        ),
      ],
    }));
    const emptySlots = final.slides.reduce(
      (n, s) => n + (s.report?.issues.filter((x) => x.rule === "slot-empty").length ?? 0),
      0,
    );
    const providerLabel = result.provider === "gemini" ? "Gemini" : "Claude";
    const missingFonts = missingSystemFonts(final.slides.map((s) => s.report));
    const note = [
      // Gemini instead of Claude is said on the version (S7).
      result.fallback ? fallbackNote(result.fallback, fallbackAlias) : "",
      revision
        ? `AI düzenleme (v${revision.input.baseVersion} üzerine): ${instruction.slice(0, 400)}`
        : `Üretildi (${brand.label}).`,
      repurposeNote,
      final.errors === 0
        ? `Denetim temiz (${final.warnings} uyarı).`
        : `Denetimde ${final.errors} hata kaldı; düzenleyicide düzeltilmeli.`,
      emptySlots ? `${emptySlots} boş görsel yuvası.` : "",
      skillsUsed.length > 0 ? `Skill'ler: ${skillsUsed.join(", ")}.` : "",
      missingFonts.length > 0
        ? `Bu Mac'te yüklü olmayan font: ${missingFonts.join(", ")} (yedek kullanıldı).`
        : "",
      `${result.calls} ${providerLabel} çağrısı.`,
    ]
      .filter(Boolean)
      .join(" ");

    ctx.progress(0.95, "Sürüm kaydediliyor");
    const version = await api.client.contents.versions.create(
      contentId,
      {
        origin: revision ? "ai_edit" : "generated",
        slides: final.slides.map((s) => ({
          html: s.html,
          width: brief.preset.width,
          height: brief.preset.height,
        })),
        note: note.slice(0, 2000),
        jobId: ctx.jobId,
        renderedAssetIds,
        layouts: final.slides.map((s) => layoutFromReport(s.report)),
      },
      init,
    );
    if (final.output.caption && final.output.caption !== content.caption) {
      await api.client.contents
        .update(contentId, { caption: final.output.caption.slice(0, 10_000) }, init)
        .catch((error: unknown) =>
          logger.warn(`could not store the caption: ${(error as Error).message}`),
        );
    }

    // Generation checks (roadmap 13): the pipeline's reports, the brand's automatic fixes.
    const reports = new Map<number, SlideReport>(
      final.slides.map((s, i) => [
        i,
        { report: s.report, failure: s.failure, jpegBytes: s.jpeg?.byteLength ?? null },
      ]),
    );
    const checked = await checkGenerated(deps, ctx, {
      contentId,
      version: version.version,
      fix: "auto",
      brand,
      reports,
      unresolvedAliases: media.unresolved,
    });
    const fixed = checked?.fixedVersion ?? null;

    // The consented "AI görsel": the product-image line fills the slot after approval.
    const slotImages = await queueSlotImageJobs(deps, {
      jobId: ctx.jobId,
      payload,
      slides: final.slides,
      imageSlot: brief.imageSlot,
      signal,
    });

    ctx.progress(1, "Tamamlandı");
    const u = result.usage;
    return {
      contentId,
      ...(revision ? { baseVersion: revision.input.baseVersion, revised: true } : {}),
      // An automatic fix stored a newer version: that one is the result.
      version: fixed?.version ?? version.version,
      versionId: fixed?.id ?? version.id,
      contentHash: fixed?.contentHash ?? version.contentHash,
      ...(fixed ? { generatedVersion: version.version } : {}),
      renderedAssetIds: fixed ? fixed.slides.map((s) => s.renderedAssetId) : renderedAssetIds,
      checks: checked?.brief ?? null,
      ...(slotImages ? { slotImages } : {}),
      slides: final.slides.length,
      preset: brief.preset.id,
      lintClean: final.errors === 0,
      errors: final.errors,
      warnings: final.warnings,
      lint: lintSummary,
      carouselIssues: final.carousel?.issues.map((i) => `${i.severity}:${i.rule}`) ?? [],
      captionUnverifiedNumbers: final.captionNumbers,
      exportIssues: exportIssues(brief.preset, final.slides),
      emptySlots,
      media: media.files.map((m) => `@${m.alias}`),
      unresolvedAliases: media.unresolved,
      brandSkills: skillsUsed,
      ...(missingFonts.length > 0 ? { missingFonts } : {}),
      brandProfile: {
        mode: brand.mode,
        version: brand.profile?.version ?? null,
        ...(brand.fallbackReason ? { note: brand.fallbackReason } : {}),
      },
      passes: result.versions.map((v) => ({
        pass: v.label,
        errors: v.errors,
        warnings: v.warnings,
      })),
      finalPass: final.label,
      calls: result.calls,
      ...(result.reasked ? { reasked: result.reasked } : {}),
      ...(result.fallback
        ? {
            fallback: {
              reason: result.fallback.reason,
              note: fallbackNote(result.fallback, fallbackAlias),
              ...(result.fallback.resetsAt
                ? { claudeResetsAt: result.fallback.resetsAt.toISOString() }
                : {}),
            },
          }
        : {}),
      provider: result.provider ?? "claude",
      model: result.model ?? null,
      requestedModel: requestedLabelModel,
      effort: route.effort,
      usage: u
        ? {
            inputTokens: u.inputTokens,
            outputTokens: u.outputTokens,
            cacheReadTokens: u.cacheReadTokens,
            cacheWriteTokens: u.cacheWriteTokens,
            costUsd: u.costUsd,
          }
        : null,
      timings: result.timings,
      rationale: final.output.rationale.slice(0, 2000),
      critique: result.versions
        .flatMap((v) => v.output.critique)
        .slice(0, 12)
        .map((c) => `${c.severity}: ${c.issue}`.slice(0, 300)),
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    // The owner sees Turkish and what to do; the technical detail stays in the log (U12).
    logger.warn(`[job ${ctx.jobId}] content.generate failed: ${(error as Error).message}`);
    if (isBudgetExceeded(error)) throw error;
    if (isClaudeError(error)) {
      const message = describeClaudeError(error);
      if (error.code === "transient" || error.code === "timeout") throw new RetryableError(message);
      throw new Error(message);
    }
    if (isGeminiError(error)) {
      const message = describeGeminiError(error);
      if (error.code === "transient" || error.code === "timeout") throw new RetryableError(message);
      throw new Error(message);
    }
    if (error instanceof ApiError) {
      if (error.status === undefined || error.status >= 500) {
        throw new RetryableError(
          "Studio sunucusuna ulaşılamadı ya da sunucu hata verdi; üretim yeniden denenecek.",
        );
      }
      if (error.status === 404) {
        throw new Error("Post ya da markası bulunamadı (silinmiş olabilir); üretim yapılmadı.");
      }
      throw new Error(
        "Studio sunucusu üretim sonucunu kabul etmedi. Postu yeniden üretmeyi deneyin.",
      );
    }
    throw new Error(
      turkishOr(error, "Post üretilemedi. Yeniden deneyin; sürerse günlüklere bakın."),
    );
  }
}

/** The error's own message when it is already Turkish (ours), else `fallback` (U12). */
function turkishOr(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return /[çğıİöşüÇĞÖŞÜ]/.test(message) ? message.slice(0, 1_000) : fallback;
}

interface LoadedRevision {
  input: DesignRevision;
  slides: { width: number; height: number }[];
}

/** The base version's HTML and renders for an AI revision. */
async function loadRevision(
  deps: ContentGenerateDeps,
  contentId: string,
  baseVersion: number,
  instruction: string,
  caption: string,
  signal: AbortSignal,
): Promise<LoadedRevision> {
  const base = await deps.api.client.contents.versions.get(contentId, baseVersion, { signal });
  const images: Uint8Array[] = [];
  for (const slide of base.slides) {
    if (!slide.renderedAssetId) continue;
    try {
      const { bytes } = await deps.api.downloadAsset(slide.renderedAssetId, {
        maxBytes: deps.settings.imageMaxBytes,
        signal,
      });
      images.push(bytes);
    } catch (error) {
      signal.throwIfAborted();
      deps.logger.warn(`could not load the render of v${baseVersion}: ${(error as Error).message}`);
    }
  }
  return {
    input: {
      baseVersion: base.version,
      instruction,
      caption,
      html: base.slides.map((s) => s.html),
      images,
    },
    slides: base.slides.map((s) => ({ width: s.width, height: s.height })),
  };
}

/** Slide count of a revision: the base count; a carousel may grow or shrink a little. */
function revisionBounds(contentType: string, count: number): { min: number; max: number } {
  if (contentType !== "carousel") return { min: 1, max: 1 };
  return { min: Math.max(2, count - 3), max: Math.min(10, Math.max(count, 2) + 3) };
}

interface ResolvedMedia {
  files: MediaFile[];
  videoAssetId?: string | undefined;
  audioAssetId?: string | undefined;
  /** `@names` in the brief that did not resolve to a usable asset. */
  unresolved: string[];
}

/** Media the brief names with `@alias` (resolved against the conversation's aliases). */
async function resolveMedia(
  deps: ContentGenerateDeps,
  payload: {
    brief: string;
    imageBrief?: string | null | undefined;
    conversationId?: string | undefined;
  },
  signal: AbortSignal,
): Promise<ResolvedMedia> {
  const text = `${payload.imageBrief ?? ""}\n${payload.brief}`;
  if (!payload.conversationId || !text.includes("@")) return { files: [], unresolved: [] };
  let aliases: ConversationAlias[];
  try {
    aliases = (await deps.api.client.conversations.aliases.list(payload.conversationId, { signal }))
      .items;
  } catch (error) {
    deps.logger.warn(
      `could not read aliases of ${payload.conversationId}: ${(error as Error).message}`,
    );
    return { files: [], unresolved: [] };
  }
  const mentions = resolveAliasMentions(text, aliases);
  const files: MediaFile[] = [];
  let videoAssetId: string | undefined;
  let audioAssetId: string | undefined;
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    if (seen.has(m.aliasId)) continue;
    seen.add(m.aliasId);
    const alias = aliases.find((a) => a.id === m.aliasId);
    if (!alias) {
      unresolved.push(m.alias);
      continue;
    }
    if (/^video\//.test(alias.mimeType)) {
      videoAssetId ??= alias.assetId;
      continue;
    }
    if (/^audio\//.test(alias.mimeType)) {
      audioAssetId ??= alias.assetId;
      continue;
    }
    if (!/^image\//.test(alias.mimeType) || /svg/.test(alias.mimeType)) {
      unresolved.push(m.alias);
      continue;
    }
    if (files.length >= MAX_MEDIA) break;
    try {
      const { bytes } = await deps.api.downloadAsset(alias.assetId, {
        maxBytes: deps.settings.imageMaxBytes,
        signal,
      });
      const info = await imageInfo(bytes);
      const ext =
        extensionForMime(alias.mimeType) || `.${info.format === "jpeg" ? "jpg" : info.format}`;
      files.push({
        alias: alias.alias,
        path: `/media/${alias.assetId}${ext}`,
        width: info.width,
        height: info.height,
        mimeType: alias.mimeType,
        attached: true,
        bytes,
      });
    } catch (error) {
      signal.throwIfAborted();
      deps.logger.warn(`could not load @${alias.alias}: ${(error as Error).message}`);
      unresolved.push(alias.alias);
    }
  }
  return { files, videoAssetId, audioAssetId, unresolved };
}

/** `/media/<assetId>.<ext>` → asset id. */
function assetIdFromMediaPath(mediaPath: string): string | undefined {
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

/**
 * Runs the generation checks after a generation. Never fails the job: a check error becomes a
 * brief with `error` (the design is stored either way).
 */
async function checkGenerated(
  deps: ContentGenerateDeps,
  ctx: JobContext,
  input: {
    contentId: string;
    version: number | undefined;
    fix: boolean | "auto";
    brand?: Parameters<typeof runContentChecks>[0]["brand"];
    reports?: ReadonlyMap<number, SlideReport>;
    unresolvedAliases?: readonly string[];
  },
): Promise<{
  brief: ContentCheckBrief;
  fixedVersion: Awaited<ReturnType<typeof runContentChecks>>["fixedVersion"];
} | null> {
  if (input.version === undefined) return null;
  ctx.progress(0.96, "Kontroller çalışıyor");
  try {
    const res = await runContentChecks({
      deps,
      jobId: ctx.jobId,
      trigger: "generate",
      contentId: input.contentId,
      version: input.version,
      fix: input.fix,
      ...(input.brand ? { brand: input.brand } : {}),
      ...(input.reports ? { reports: input.reports } : {}),
      ...(input.unresolvedAliases ? { unresolvedAliases: input.unresolvedAliases } : {}),
      signal: ctx.signal,
      progress: (v, m) => ctx.progress(0.96 + v * 0.035, m),
    });
    return { brief: res.brief, fixedVersion: res.fixedVersion };
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
    deps.logger.warn(`[job ${ctx.jobId}] checks failed: ${(error as Error).message}`);
    return { brief: failedBrief(input.version, error), fixedVersion: null };
  }
}

/** The template branch (N9): the post, its brand, the model that may write the fields. */
async function runTemplateJob(
  ctx: JobContext,
  deps: ContentGenerateDeps,
  payload: ContentGenerateJobInput & { template: TemplateFill },
  choice: { requestedModel: string | undefined; requestedEffort: string | undefined },
): Promise<Record<string, unknown>> {
  const { api, settings } = deps;
  const signal = ctx.signal;
  const content = await api.client.contents.get(payload.contentId, { signal });
  if (content.brandId !== payload.brandId)
    throw new Error("Bu post başka bir markaya ait; üretim yapılmadı.");
  let brandContext: Promise<BrandContext> | null = null;
  const brand = () => {
    brandContext ??= loadBrandContext({
      api,
      brandId: payload.brandId,
      profileVersion: payload.brandProfileVersion,
      cacheDir: path.join(deps.stateDir, "cache", "assets"),
      signal,
    });
    return brandContext;
  };
  const health = deps.health();
  const aiReady =
    !(health.state === "unauthenticated" || health.state === "error") || hasGeminiApiKey(settings);
  const ai: TemplateAiCaller | null = aiReady
    ? async (call) => {
        const route = resolveStructuredRoute({
          requestedModel: choice.requestedModel,
          requestedEffort: choice.requestedEffort,
          defaultEffort: settings.effortDesign,
          defaultGeminiAlias: "gemini-flash",
          settings,
          claudeHealth: health,
          limitChoice: deps.aiPolicy?.limitChoice(),
        });
        const res = await callStructuredAi({
          label: call.label,
          system: call.system,
          content: [{ type: "text", text: call.prompt }],
          schema: call.schema,
          route,
          gate: deps.gate,
          settings,
          timeoutMs: settings.claudeTimeoutMs,
          signal: call.signal,
          ...(deps.geminiFetch ? { geminiFetch: deps.geminiFetch } : {}),
          onGeminiUsage: geminiUsageSink(deps.aiUsage, { kind: "generate", jobId: ctx.jobId }),
        });
        return { output: res.output, provider: res.provider, model: res.model ?? null };
      }
    : null;
  return runTemplateGenerate({
    deps,
    ctx,
    payload,
    content,
    brand,
    ai,
    check: async (version, reports) =>
      (
        await checkGenerated(deps, ctx, {
          contentId: content.id,
          version,
          fix: false,
          brand: await brand(),
          reports,
        })
      )?.brief ?? null,
  });
}

/** A failure as the owner reads it (Turkish, what to do); transient ones are retried (U12). */
function describeGenerateError(
  error: unknown,
  ctx: JobContext,
  deps: ContentGenerateDeps,
): unknown {
  if (ctx.signal.aborted) return ctx.signal.reason ?? error;
  deps.logger.warn(`[job ${ctx.jobId}] template fill failed: ${(error as Error).message}`);
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
      return new Error("Post, şablon ya da markası bulunamadı (silinmiş olabilir).");
    return new Error("Studio sunucusu şablon sonucunu kabul etmedi. Yeniden deneyin.");
  }
  return new Error(turkishOr(error, "Şablondan post üretilemedi. Yeniden deneyin."));
}
