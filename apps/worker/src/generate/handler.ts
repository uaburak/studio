/**
 * `content.generate`: design one content item (from an accepted plan or created
 * directly), render it, upload the JPEGs and store a content version
 * (origin "generated") whose slides carry the HTML and the rendered asset ids.
 */

import path from "node:path";
import {
  ApiError,
  ContentGeneratePayload,
  type ConversationAlias,
  parseContentGenerateJob,
  resolveAliasMentions,
} from "@studio/contract";
import type { AgentDeps } from "../agent.ts";
import { describeClaudeError, formatClock, isClaudeError } from "../claude/errors.ts";
import type { ParkInfo } from "../claude/gate.ts";
import { chooseModel, readChoice } from "../claude/models.ts";
import { extensionForMime, imageInfo } from "../media.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";
import { loadBrandContext } from "./brand.ts";
import {
  exportIssues,
  type MediaFile,
  presetFor,
  runDesignPipeline,
  type SlideRenderer,
  slideBounds,
} from "./pipeline.ts";
import type { DesignBrief } from "./prompt.ts";

export interface ContentGenerateDeps extends AgentDeps {
  /** Shared Chromium renderer (lazily launched). */
  renderer: () => SlideRenderer;
}

/** Most user images a single design takes. */
const MAX_MEDIA = 3;

export function createContentGenerateHandler(deps: ContentGenerateDeps) {
  return defineHandler({
    payload: ContentGeneratePayload,
    run: (_payload, ctx) => runContentGenerate(ctx, deps),
  });
}

async function runContentGenerate(
  ctx: JobContext,
  deps: ContentGenerateDeps,
): Promise<Record<string, unknown>> {
  const { api, settings, logger } = deps;
  const signal = ctx.signal;
  const init = { signal };
  const parsed = parseContentGenerateJob(ctx.job);
  if (!parsed.ok) throw new Error(`invalid content.generate payload: ${parsed.error}`);
  const payload = parsed.payload;
  const { brandId, contentId } = payload;

  // Model and effort picked for this generation (payload.model / payload.effort), else env, else opus/medium.
  const choice = chooseModel(readChoice(ctx.job.payload), {
    model: settings.model,
    effort: settings.effortDesign,
  });
  const health = deps.health();
  if (health.state === "unauthenticated" || health.state === "error") {
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
      return {
        contentId,
        version: full.version,
        versionId: full.id,
        contentHash: full.contentHash,
        renderedAssetIds: full.slides.map((s) => s.renderedAssetId),
        reused: true,
      };
    }

    const content = await api.client.contents.get(contentId, init);
    if (content.brandId !== brandId)
      throw new Error(`content ${contentId} belongs to another brand`);
    const contentType = payload.type ?? content.type;
    if (contentType === "reel") {
      throw new Error(
        "Reels (video) üretimi henüz desteklenmiyor; bu içerik için post ya da carousel seçin.",
      );
    }

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

    const platforms = payload.targetPlatforms?.length
      ? payload.targetPlatforms
      : content.targetPlatforms.length
        ? content.targetPlatforms
        : ["instagram" as const];
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
      preset: presetFor(contentType, platforms),
      slides: slideBounds(contentType, `${payload.brief}\n${payload.instructions ?? ""}`),
      media: media.files.map(({ bytes: _bytes, ...m }) => m),
      language: brand.brand.defaultLanguage.split("-")[0] ?? "tr",
    };

    const onPark = (info: ParkInfo) => {
      ctx.progress(
        0.2,
        `Claude kullanım sınırı doldu: ${formatClock(info.until)} civarında devam edecek`,
      );
    };
    const result = await runDesignPipeline({
      brand,
      brief,
      media: media.files,
      gate: deps.gate,
      renderer: deps.renderer(),
      model: choice.model,
      effort: choice.effort,
      timeoutMs: settings.claudeTimeoutMs,
      fixPasses: settings.designFixPasses,
      imageMaxEdge: settings.imageMaxEdge,
      signal,
      logger,
      progress: (v, m) => ctx.progress(v, m),
      hooks: { onPark, onResume: () => ctx.progress(0.2, "Claude'a yeniden bağlanılıyor") },
      label: `content-${contentId.slice(-8)}`,
    });
    const final = result.final;
    const missing = final.slides.filter((s) => !s.jpeg);
    if (missing.length > 0) {
      throw new Error(
        `Tasarım render edilemedi (${missing.map((s) => `${s.id}: ${s.failure ?? "?"}`).join("; ")})`,
      );
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
    const note = [
      `Üretildi (${brand.label}).`,
      final.errors === 0
        ? `Denetim temiz (${final.warnings} uyarı).`
        : `Denetimde ${final.errors} hata kaldı; düzenleyicide düzeltilmeli.`,
      emptySlots ? `${emptySlots} boş görsel yuvası.` : "",
      `${result.calls} Claude çağrısı.`,
    ]
      .filter(Boolean)
      .join(" ");

    ctx.progress(0.95, "Sürüm kaydediliyor");
    const version = await api.client.contents.versions.create(
      contentId,
      {
        origin: "generated",
        slides: final.slides.map((s) => ({
          html: s.html,
          width: brief.preset.width,
          height: brief.preset.height,
        })),
        note: note.slice(0, 2000),
        jobId: ctx.jobId,
        renderedAssetIds,
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

    ctx.progress(1, "Tamamlandı");
    const u = result.usage;
    return {
      contentId,
      version: version.version,
      versionId: version.id,
      contentHash: version.contentHash,
      renderedAssetIds,
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
      model: result.model ?? null,
      requestedModel: choice.model,
      effort: choice.effort,
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
    if (isClaudeError(error)) {
      const message = describeClaudeError(error);
      if (error.code === "transient" || error.code === "timeout") throw new RetryableError(message);
      throw new Error(`${message} (${error.message.slice(0, 300)})`);
    }
    if (error instanceof ApiError && (error.status === undefined || error.status >= 500)) {
      throw new RetryableError(error.message);
    }
    throw error;
  }
}

interface ResolvedMedia {
  files: MediaFile[];
  /** `@names` in the brief that did not resolve to an image. */
  unresolved: string[];
}

/** Images the brief names with `@alias` (resolved against the conversation's aliases). */
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
  const unresolved: string[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    if (seen.has(m.aliasId)) continue;
    seen.add(m.aliasId);
    const alias = aliases.find((a) => a.id === m.aliasId);
    if (!alias || !/^image\//.test(alias.mimeType) || /svg/.test(alias.mimeType)) {
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
  return { files, unresolved };
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
