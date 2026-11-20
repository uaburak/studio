/**
 * The Wecra engine (docs/URETIM-RESIM.md §14, Faz 2): `content.generate` with `engine: "wecra"`.
 *
 * Who does what:
 * - the worker (here) reads the brand (profile, rules, voice, facts, skills), the pictures it may
 *   place (logos and brand images by asset id, the chat's `@görsel`s, the named products' photos)
 *   and asks the design model for the slides as Wecra's own write operations on blank frames
 *   (`"frame:N"`) plus the caption and hashtags;
 * - the Mac app's canvas runner (Wecra's engine in a hidden page) runs them: `canvas.create` opens
 *   a blank Wecra document (one frame per slide: 1080×1350, a story 1080×1920, 1080×1080 when a
 *   square post is asked for), applies the operations, exports the slides and stores the version
 *   with its `editorDocument` — the post opens on the canvas, editable there;
 * - critique → fix, bounded (1 + `designFixPasses`, at most 3): the worker shows the model the
 *   rendered slides and their outline (Wecra layer ids, boxes, texts, overflow); its fixes are a
 *   `canvas.apply` (a new `ai_edit` version) — a fix pass that fails leaves the design as it was;
 * - the caption + hashtags go on the post; the generation checks run on the final version (as
 *   for HTML, no automatic HTML fix on a canvas version); a consented "AI görsel" area is filled
 *   through the product-image line (`queueSlotImageJobs`; approving places it on the canvas).
 */
import path from "node:path";
import {
  ApiError,
  type CanvasOperation,
  type ContentCheckBrief,
  type ContentGenerateJobInput,
  canvasFormatFor,
} from "@studio/contract";
import { type CanvasOutlineSlide, canvasOutline, readCanvas } from "@studio/design-kit/canvas";
import { isBudgetExceeded } from "../../ai/policy.ts";
import { geminiUsageSink } from "../../ai/usage-recorder.ts";
import {
  brandSkillsUsed,
  DESIGN_SKILLS_BUDGET,
  designSkillsBlock,
  loadEnabledBrandSkills,
  selectBrandSkills,
} from "../../brand/skills.ts";
import { describeClaudeError, isClaudeError } from "../../claude/errors.ts";
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
import { type BrandContext, fileAssetMap, loadBrandContext } from "../brand.ts";
import type { ContentGenerateDeps } from "../handler.ts";
import { slideBounds } from "../pipeline.ts";
import { type EmptyImageSlot, queueSlotImageJobs } from "../slot-images.ts";
import {
  captionWithHashtags,
  critiqueSchema,
  type DesignPlan,
  designSchema,
  readCritique,
  readDesign,
} from "./plan.ts";
import {
  AI_PICTURE_LAYER,
  type WecraBrief,
  type WecraPicture,
  wecraCritiquePrompt,
  wecraDesignPrompt,
  wecraSystemPrompt,
} from "./prompt.ts";
import {
  CanvasRunnerJobError,
  type CanvasRunnerOptions,
  canvasApply,
  canvasCreate,
  requireCanvasRunner,
} from "./runner.ts";

/** What the generation handler lends the engine (kept there: media aliases, the checks). */
export interface WecraHelpers {
  requestedModel?: string | undefined;
  requestedEffort?: string | undefined;
  resolveMedia(payload: {
    brief: string;
    imageBrief?: string | null | undefined;
    conversationId?: string | undefined;
  }): Promise<{
    files: { alias: string; path: string; width: number; height: number; bytes: Uint8Array }[];
    unresolved: string[];
  }>;
  check(input: {
    contentId: string;
    version: number | undefined;
    fix: boolean | "auto";
    brand?: BrandContext;
    unresolvedAliases?: readonly string[];
  }): Promise<{ brief: ContentCheckBrief } | null>;
}

const MAX_PASSES = 3;
const MAX_PICTURES_SHOWN = 4;
const MAX_PRODUCT_PHOTOS = 3;

export async function runWecraGenerate(
  ctx: JobContext,
  deps: ContentGenerateDeps,
  payload: ContentGenerateJobInput,
  helpers: WecraHelpers,
): Promise<Record<string, unknown>> {
  try {
    return await designOnCanvas(ctx, deps, payload, helpers);
  } catch (error) {
    throw describeWecraError(error, ctx, deps);
  }
}

async function designOnCanvas(
  ctx: JobContext,
  deps: ContentGenerateDeps,
  payload: ContentGenerateJobInput,
  helpers: WecraHelpers,
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
    throw new Error("Wecra motoru Reels üretmez; Reels için HTML motorunu seçin. Post üretilmedi.");
  if (content.status === "published" || content.status === "publishing")
    throw new Error(`“${content.title}” yayında ya da yayınlanıyor; yeniden tasarlanamaz.`);

  const health = deps.health();
  if (
    (health.state === "unauthenticated" || health.state === "error") &&
    !hasGeminiApiKey(settings)
  )
    throw new Error(health.message);
  const runner: CanvasRunnerOptions = {
    api,
    signal,
    pollMs: deps.canvasPollMs ?? 1_500,
    timeoutMs: deps.canvasTimeoutMs ?? 10 * 60_000,
  };
  ctx.progress(0.02, "Tuval çalıştırıcısı aranıyor");
  await requireCanvasRunner(runner);

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

  ctx.progress(0.1, "Görseller hazırlanıyor");
  const media = await helpers.resolveMedia(payload);
  const shown: { label: string; bytes: Uint8Array }[] = [];
  const pictures: WecraPicture[] = [...brandPictures(brand)];
  for (const f of media.files) {
    const assetId = assetIdOfMediaPath(f.path);
    if (!assetId) continue;
    pictures.push({
      assetId,
      kind: `@${f.alias}`,
      label: f.alias,
      width: f.width,
      height: f.height,
    });
    shown.push({ label: `@${f.alias} (assetId ${assetId})`, bytes: f.bytes });
  }
  const productIds = payload.productIds?.length
    ? payload.productIds
    : (payload.slotImage?.productIds ?? []);
  for (const p of await productPictures(deps, brandId, productIds, signal)) {
    pictures.push(p.picture);
    if (p.bytes)
      shown.push({ label: `${p.picture.label} (assetId ${p.picture.assetId})`, bytes: p.bytes });
  }

  const size = canvasFormatFor(contentType, `${briefText}\n${payload.instructions ?? ""}`);
  const brief: WecraBrief = {
    title,
    brief: briefText,
    contentType,
    platforms,
    size,
    slides: slideBounds(contentType, `${briefText}\n${payload.instructions ?? ""}`),
    imageSlot: payload.imageSlot ?? (media.files.length ? "user_upload" : "none"),
    imageBrief: payload.imageBrief ?? null,
    instructions: payload.instructions ?? null,
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
  let fallback: StructuredFallback | undefined;
  let provider: string | null = null;
  let model: string | null = null;
  const system = wecraSystemPrompt(brand, brief);
  const ask = async (label: string, blocks: ClaudeContentBlock[], schema: object) => {
    calls += 1;
    const res = await callStructuredAi({
      label: `wecra-${label}-${contentId.slice(-8)}`,
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

  // 1. The design on blank frames.
  ctx.progress(0.15, "Wecra'da tasarlanıyor");
  const pictureBlocks = await imageBlocks(
    shown.slice(0, MAX_PICTURES_SHOWN),
    settings.imageMaxEdge,
  );
  let plan: DesignPlan = readDesign(
    await ask(
      "design",
      [{ type: "text", text: wecraDesignPrompt(brief) }, ...pictureBlocks],
      designSchema,
    ),
    brief.slides,
  );
  if (plan.operations.length === 0) {
    // Once more, told why (a design that names no valid operation draws nothing).
    plan = readDesign(
      await ask(
        "design-retry",
        [
          {
            type: "text",
            text: `${wecraDesignPrompt(brief)}\n\nYour previous answer had no usable operation (${plan.problems.slice(0, 5).join(" ") || "empty"}). Return the design again with valid operations.`,
          },
          ...pictureBlocks,
        ],
        designSchema,
      ),
      brief.slides,
    );
    if (plan.operations.length === 0)
      throw new Error(
        "Tasarım modeli uygulanabilir bir Wecra işlemi döndürmedi; post üretilmedi. Yeniden deneyin.",
      );
  }

  ctx.progress(0.35, "Tuvalde kuruluyor");
  const created = await canvasCreate(runner, content, {
    baseVersion: content.currentVersion?.version ?? null,
    slides: plan.slides,
    width: size.width,
    height: size.height,
    operations: plan.operations,
    origin: "generated",
    note: `Wecra ile üretildi (${brand.label}).`.slice(0, 500),
    generateJobId: ctx.jobId,
    ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
  });
  const canvasJobIds = [created.jobId];
  let version = created.output.version;
  let problems = [
    ...plan.problems,
    ...created.output.results.filter((r) => !r.ok).map((r) => `${r.tool}: ${r.summary}`),
  ];

  // 2. Critique → fix, bounded.
  const passes = Math.min(MAX_PASSES, 1 + settings.designFixPasses);
  const critiques: string[] = [];
  let passesRun = 0;
  for (let pass = 1; pass <= passes; pass++) {
    ctx.progress(0.4 + (pass / passes) * 0.4, `Tasarım değerlendiriliyor (${pass}/${passes})`);
    const seen = await readVersion(deps, contentId, version, signal);
    const critique = readCritique(
      await ask(
        `critique-${pass}`,
        [
          ...seen.images,
          {
            type: "text",
            text: wecraCritiquePrompt({ brief, outline: seen.outline, pass, passes, problems }),
          },
        ],
        critiqueSchema,
      ),
    );
    passesRun = pass;
    critiques.push(...critique.issues);
    if (critique.ok) break;
    try {
      const fixed = await canvasApply(runner, content, {
        version,
        operations: critique.operations as CanvasOperation[],
        note: `AI düzeltmesi (${pass}/${passes}): ${critique.issues.slice(0, 3).join("; ")}`.slice(
          0,
          500,
        ),
        ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
      });
      canvasJobIds.push(fixed.jobId);
      version = fixed.output.version;
      problems = [
        ...critique.problems,
        ...fixed.output.results.filter((r) => !r.ok).map((r) => `${r.tool}: ${r.summary}`),
      ];
    } catch (error) {
      // A fix that could not be made leaves the design as it was (it is still a design).
      if (!(error instanceof CanvasRunnerJobError)) throw error;
      logger.warn(`[job ${ctx.jobId}] wecra fix pass ${pass} not applied: ${error.message}`);
      problems = [...critique.problems, error.message.slice(0, 600)];
      canvasJobIds.push(error.jobId);
    }
  }

  // 3. The caption, the checks, the consented AI picture.
  ctx.progress(0.9, "Açıklama yazılıyor");
  const caption = captionWithHashtags(plan.caption, plan.hashtags);
  if (caption && caption !== content.caption) {
    await api.client.contents
      .update(contentId, { caption }, init)
      .catch((error: unknown) =>
        logger.warn(`could not store the caption: ${(error as Error).message}`),
      );
  }
  const final = await readVersion(deps, contentId, version, signal, false);
  const checks = await helpers.check({
    contentId,
    version,
    fix: false,
    brand,
    unresolvedAliases: media.unresolved,
  });
  const slots = aiPictureSlots(final.outline);
  const slotImages = await queueSlotImageJobs(deps, {
    jobId: ctx.jobId,
    payload,
    slides: [],
    slots,
    imageSlot: brief.imageSlot,
    signal,
  });

  ctx.progress(1, "Tamamlandı");
  return {
    contentId,
    engine: "wecra",
    version,
    generatedVersion: created.output.version,
    versionId: final.versionId,
    contentHash: final.contentHash,
    renderedAssetIds: final.renderedAssetIds,
    checks: checks?.brief ?? null,
    slides: plan.slides,
    size,
    canvasJobIds,
    passes: passesRun,
    operations: plan.operations.length,
    notApplied: problems.slice(0, 12),
    critique: critiques.slice(0, 12),
    rationale: plan.rationale,
    caption: caption || null,
    media: media.files.map((m) => `@${m.alias}`),
    unresolvedAliases: media.unresolved,
    brandSkills: skillsUsed,
    brandProfile: {
      mode: brand.mode,
      version: brand.profile?.version ?? null,
      ...(brand.fallbackReason ? { note: brand.fallbackReason } : {}),
    },
    ...(slotImages ? { slotImages } : {}),
    calls,
    provider,
    model,
    ...(fallback
      ? { fallback: { reason: fallback.reason, note: fallbackNote(fallback, fallbackAlias) } }
      : {}),
  };
}

/** The brand's logos and pictures with their asset ids (Wecra places them by id). */
export function brandPictures(brand: BrandContext): WecraPicture[] {
  const files = brand.profile ? fileAssetMap(brand.profile.tokens) : {};
  const idOf = (p: string) => files[p.replace(/^\/brand\//, "")];
  const out: WecraPicture[] = [];
  for (const l of brand.logos) {
    const assetId = idOf(l.path);
    if (!assetId) continue;
    out.push({
      assetId,
      kind: "logo",
      label: l.name,
      ...(/\.svg$/i.test(l.path) ? { svg: true } : {}),
      width: l.width,
      height: l.height,
      ...(l.on ? { note: `${l.on} zeminler için` } : {}),
    });
  }
  for (const a of brand.images) {
    const assetId = idOf(a.path);
    if (!assetId) continue;
    out.push({
      assetId,
      kind: "marka görseli",
      label: a.name,
      ...(/\.svg$/i.test(a.path) ? { svg: true } : {}),
      ...(a.note ? { note: a.note } : {}),
    });
  }
  return out;
}

/** The named products' photos (the first few each; the cover is shown to the model). */
async function productPictures(
  deps: ContentGenerateDeps,
  brandId: string,
  productIds: readonly string[],
  signal: AbortSignal,
): Promise<{ picture: WecraPicture; bytes: Uint8Array | null }[]> {
  const out: { picture: WecraPicture; bytes: Uint8Array | null }[] = [];
  for (const id of productIds.slice(0, 4)) {
    let product: Awaited<ReturnType<ContentGenerateDeps["api"]["client"]["brandProducts"]["get"]>>;
    try {
      product = await deps.api.client.brandProducts.get(brandId, id, { signal });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApiError && error.status === 404) continue;
      throw error;
    }
    for (const [i, assetId] of product.imageAssetIds.slice(0, MAX_PRODUCT_PHOTOS).entries()) {
      let bytes: Uint8Array | null = null;
      if (i === 0) {
        bytes = await deps.api
          .downloadAsset(assetId, { maxBytes: deps.settings.imageMaxBytes, signal })
          .then((r) => r.bytes)
          .catch(() => null);
      }
      out.push({
        picture: {
          assetId,
          kind: `ürün: ${product.name}`,
          label: `${product.name}${i === 0 ? " (kapak)" : ` (${i + 1}. fotoğraf)`}`,
        },
        bytes,
      });
    }
  }
  return out;
}

async function imageBlocks(
  pictures: readonly { label: string; bytes: Uint8Array }[],
  maxEdge: number,
): Promise<ClaudeContentBlock[]> {
  const blocks: ClaudeContentBlock[] = [];
  for (const p of pictures) {
    const img = await prepareModelImage(p.bytes, { maxEdge, quality: 85 });
    if (!img) continue;
    blocks.push({ type: "text", text: `${p.label}:` });
    blocks.push({ type: "image", mediaType: img.mediaType, data: img.data });
  }
  return blocks;
}

/** A canvas version as the model sees it: its renders and its outline (from the slide facts). */
async function readVersion(
  deps: ContentGenerateDeps,
  contentId: string,
  number: number,
  signal: AbortSignal,
  withImages = true,
): Promise<{
  outline: CanvasOutlineSlide[];
  images: ClaudeContentBlock[];
  versionId: string;
  contentHash: string;
  renderedAssetIds: (string | null)[];
}> {
  const v = await deps.api.client.contents.versions.get(contentId, number, { signal });
  const outline: CanvasOutlineSlide[] = [];
  const images: ClaudeContentBlock[] = [];
  for (const [i, s] of v.slides.entries()) {
    const c = readCanvas(s.html);
    if (c.kind === "facts") outline.push(canvasOutline(c.facts, i + 1));
    if (!withImages || !s.renderedAssetId) continue;
    try {
      const { bytes } = await deps.api.downloadAsset(s.renderedAssetId, {
        maxBytes: deps.settings.imageMaxBytes,
        signal,
      });
      const img = await prepareModelImage(bytes, {
        maxEdge: deps.settings.imageMaxEdge,
        quality: 85,
      });
      if (!img) continue;
      images.push({ type: "text", text: `Slide ${i + 1} (v${v.version} render):` });
      images.push({ type: "image", mediaType: img.mediaType, data: img.data });
    } catch (error) {
      signal.throwIfAborted();
      deps.logger.warn(`could not load the render of v${v.version}: ${(error as Error).message}`);
    }
  }
  return {
    outline,
    images,
    versionId: v.id,
    contentHash: v.contentHash,
    renderedAssetIds: v.slides.map((s) => s.renderedAssetId),
  };
}

/** The design's "AI görsel" areas still without a picture (the slot-image line fills them). */
export function aiPictureSlots(outline: readonly CanvasOutlineSlide[]): EmptyImageSlot[] {
  const out: EmptyImageSlot[] = [];
  for (const s of outline) {
    for (const l of s.layers) {
      if (l.name.trim().toLocaleLowerCase("tr") !== AI_PICTURE_LAYER.toLocaleLowerCase("tr"))
        continue;
      if (l.fills?.some((f) => f.startsWith("image"))) continue;
      const [, , w, h] = l.box;
      out.push({
        slide: s.slide - 1,
        slotId: l.id,
        ratio: w > 0 && h > 0 ? { w: Math.round(w), h: Math.round(h) } : null,
        label: AI_PICTURE_LAYER,
      });
    }
  }
  return out;
}

/** `/media/<assetId>.<ext>` → the asset id. */
function assetIdOfMediaPath(mediaPath: string): string | undefined {
  const name = mediaPath.split("/").pop() ?? "";
  return decodeURIComponent(name.replace(/\.[a-z0-9]+$/i, "")) || undefined;
}

/** A failure as the owner reads it (Turkish, what to do); transient ones are retried (U12). */
function describeWecraError(error: unknown, ctx: JobContext, deps: ContentGenerateDeps): unknown {
  if (ctx.signal.aborted) return ctx.signal.reason ?? error;
  deps.logger.warn(`[job ${ctx.jobId}] wecra engine failed: ${(error as Error).message}`);
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
  if (error instanceof CanvasRunnerJobError)
    return new Error(`Wecra tuvali kurulamadı: ${error.message}`.slice(0, 1_000));
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    /[çğıİöşüÇĞÖŞÜ]/.test(message)
      ? message.slice(0, 1_000)
      : "Post Wecra ile üretilemedi. Yeniden deneyin; sürerse günlüklere bakın.",
  );
}
