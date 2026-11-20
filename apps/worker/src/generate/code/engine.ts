/**
 * The code engine (docs/URETIM-RESIM.md, decision 4, Faz 4): `content.generate` with
 * `engine: "code"`.
 *
 *   brand (profile, rules, voice, facts, skills) + pictures (logos, @images, product photos)
 *     → design model: ONE Python program for every slide + caption + hashtags
 *     → static pre-check → sandbox run (sandbox.ts: Pillow/skia/numpy/OpenCV, studio_brand.py)
 *     → output checks + lint from what studio_brand recorded (lint.ts)
 *     → critique → rewrite with the renders, the report and any traceback (1 + designFixPasses)
 *     → upload JPEGs → `generated` version whose slides show the renders and carry the program
 *     → caption, generation checks, the consented "AI görsel" slot's picture job.
 *
 * A chat revision (`revise_post`: a base version + an instruction) rewrites the stored program
 * (`ai_edit`). Approving the slot's picture re-runs the stored program with the picture assigned
 * to that slot (`executeCodeSlotFill`, from `content.render`). Code posts are edited only from the
 * chat (decision 3); the Mac's canvas shows them read only.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  ApiError,
  type ContentGenerateJobInput,
  canvasFormatFor,
  chatOnlyEngineOf,
} from "@studio/contract";
import type { LintConfig } from "@studio/design-kit/lint";
import { lintForPrompt } from "@studio/design-kit/lint";
import { isBudgetExceeded } from "../../ai/policy.ts";
import { geminiUsageSink } from "../../ai/usage-recorder.ts";
import {
  brandSkillsUsed,
  DESIGN_SKILLS_BUDGET,
  designSkillsBlock,
  loadEnabledBrandSkills,
  selectBrandSkills,
} from "../../brand/skills.ts";
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
import { loadBrandContext } from "../brand.ts";
import type { ContentGenerateDeps } from "../handler.ts";
import { isMalformedDesignOutput, presetFor, reaskNote, slideBounds } from "../pipeline.ts";
import { queueSlotImageJobs } from "../slot-images.ts";
import type { SvgHelpers } from "../svg/engine.ts";
import { productPictures } from "../wecra/engine.ts";
import { captionWithHashtags } from "../wecra/plan.ts";
import { type CodeInputs, type CodePicture, readCodeSource } from "./document.ts";
import {
  type CodeBrief,
  CodeDesignOutput,
  codeDesignSchema,
  codeEditPrompt,
  codeGeneratePrompt,
  codeRevisePrompt,
  codeSystemPrompt,
} from "./prompt.ts";
import {
  better,
  type CheckedCodeVersion,
  type CodeProgramRunner,
  emptyCodeSlots,
  hardFailures,
  type RunContext,
  runAndCheck,
  slugify,
  storeCodeVersion,
  usable,
} from "./run.ts";
import { CodeRuntimeError, runtimeRoot } from "./runtime.ts";
import { createJobDir, DEFAULT_TIMEOUT_MS } from "./sandbox.ts";

export type { CodeProgramRunner } from "./run.ts";

const MAX_PASSES = 3;
const MAX_PICTURES_SHOWN = 4;

/** Whether a job is a chat revision of a code post (a base version + an instruction). */
export async function isCodeRevision(
  deps: Pick<ContentGenerateDeps, "api">,
  payload: ContentGenerateJobInput,
  signal: AbortSignal,
): Promise<boolean> {
  if (payload.engine !== undefined && payload.engine !== "code") return false;
  if (payload.baseVersion === undefined || !payload.instructions?.trim()) return false;
  try {
    const base = await deps.api.client.contents.versions.get(
      payload.contentId,
      payload.baseVersion,
      { signal },
    );
    return chatOnlyEngineOf(base.slides) === "code";
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
}

// --- content.generate --------------------------------------------------------------------------

export async function runCodeGenerate(
  ctx: JobContext,
  deps: ContentGenerateDeps & { codeRunner?: CodeProgramRunner },
  payload: ContentGenerateJobInput,
  helpers: SvgHelpers,
): Promise<Record<string, unknown>> {
  const jobDir = path.join(runtimeRoot(deps.stateDir), "runs");
  try {
    return await designCode(ctx, deps, payload, helpers, jobDir);
  } catch (error) {
    throw describeCodeError(error, ctx, deps);
  }
}

async function designCode(
  ctx: JobContext,
  deps: ContentGenerateDeps & { codeRunner?: CodeProgramRunner },
  payload: ContentGenerateJobInput,
  helpers: SvgHelpers,
  runsRoot: string,
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
    throw new Error("Kod motoru Reels üretmez; Reels için HTML motorunu seçin. Post üretilmedi.");
  if (content.status === "published" || content.status === "publishing")
    throw new Error(`“${content.title}” yayında ya da yayınlanıyor; yeniden tasarlanamaz.`);

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
      slots: emptyCodeSlots(full.slides),
      imageSlot: payload.imageSlot ?? "none",
      signal,
    });
    return {
      contentId,
      engine: "code",
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

  // revise_post: the stored program of the base version.
  const instruction = payload.instructions?.trim() ?? "";
  const base =
    payload.baseVersion !== undefined && instruction
      ? await api.client.contents.versions.get(contentId, payload.baseVersion, init)
      : null;
  const baseSource =
    base && chatOnlyEngineOf(base.slides) === "code" ? readCodeSource(base.slides) : null;
  const revision = base && baseSource ? base : null;

  ctx.progress(0.1, "Görseller hazırlanıyor");
  const media = await helpers.resolveMedia(payload);
  const shown: { label: string; bytes: Uint8Array }[] = [];
  const pictures: CodePicture[] = [
    ...brand.logos.map((l) => ({
      name: `logo/${l.name}`,
      kind: "logo",
      label: l.name,
      width: l.width,
      height: l.height,
      ...(l.on ? { note: `${l.on} zeminler için` } : {}),
      source: { brandPath: l.path },
    })),
    ...brand.images.map((a) => ({
      name: `brand/${a.name}`,
      kind: "marka görseli",
      label: a.name,
      ...(a.note ? { note: a.note } : {}),
      source: { brandPath: a.path },
    })),
  ];
  for (const f of media.files) {
    const assetId = assetIdOfMediaPath(f.path);
    if (!assetId) continue;
    pictures.push({
      name: `@${f.alias}`,
      kind: `@${f.alias}`,
      label: f.alias,
      width: f.width,
      height: f.height,
      source: { assetId },
    });
    shown.push({ label: `@${f.alias}`, bytes: f.bytes });
  }
  const productIds = payload.productIds?.length
    ? payload.productIds
    : (payload.slotImage?.productIds ?? []);
  const productNames = new Map<string, number>();
  for (const p of await productPictures(deps, brandId, productIds, signal)) {
    const base = slugify(p.picture.kind.replace(/^ürün:\s*/, "")) || "urun";
    const n = (productNames.get(base) ?? 0) + 1;
    productNames.set(base, n);
    const name = `product/${base}-${n}`;
    pictures.push({
      name,
      kind: p.picture.kind,
      label: p.picture.label,
      source: { assetId: p.picture.assetId },
    });
    if (p.bytes) shown.push({ label: `${name} (${p.picture.label})`, bytes: p.bytes });
  }
  // A revision keeps the pictures its program used (and the filled slots).
  for (const p of baseSource?.inputs?.pictures ?? [])
    if (!pictures.some((x) => x.name === p.name)) pictures.push(p);

  const textForSize = `${briefText}\n${payload.instructions ?? ""}`;
  const baseSlide = revision?.slides[0];
  const size = baseSlide
    ? { width: baseSlide.width, height: baseSlide.height }
    : canvasFormatFor(contentType, textForSize);
  const preset = presetFor(contentType, platforms);
  const language = brand.brand.defaultLanguage.split("-")[0] ?? "tr";
  const slidesBounds = revision
    ? revisionBounds(contentType, revision.slides.length)
    : slideBounds(contentType, textForSize);
  const brief: CodeBrief = {
    title,
    brief: briefText,
    contentType: contentType as CodeBrief["contentType"],
    platforms,
    size,
    safeArea: preset.safeArea,
    slides: slidesBounds,
    imageSlot: payload.imageSlot ?? (media.files.length ? "user_upload" : "none"),
    imageBrief: payload.imageBrief ?? null,
    instructions: revision ? null : (payload.instructions ?? null),
    date: payload.planItem?.date ?? null,
    pillar: payload.planItem?.pillar ?? null,
    language,
    pictures,
    timeoutS: Math.round(DEFAULT_TIMEOUT_MS / 1000),
  };
  const inputs: CodeInputs = {
    version: 1,
    size,
    safeArea: preset.safeArea,
    slides: slidesBounds,
    language,
    profileVersion: brand.profile?.version ?? null,
    pictures,
    slots: { ...(baseSource?.inputs?.slots ?? {}) },
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
  const system = codeSystemPrompt(brand, brief);
  const invoke = async (label: string, blocks: ClaudeContentBlock[]) => {
    calls += 1;
    const res = await callStructuredAi({
      label: `code-${label}-${contentId.slice(-8)}`,
      system,
      content: blocks,
      schema: codeDesignSchema,
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
  /** One program; a malformed answer is asked again once with the problem (U5). */
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
    let parsed = CodeDesignOutput.safeParse(raw);
    if (!parsed.success && !retried) {
      reasked += 1;
      raw = await invoke(
        `${label}-reask`,
        blocks(
          `${text}\n${reaskNote(`The answer did not match the output schema: ${parsed.error.message.slice(0, 1_200)}`)}`,
        ),
      );
      parsed = CodeDesignOutput.safeParse(raw);
    }
    if (!parsed.success)
      throw new ClaudeError(
        "output",
        `${label}: code design output does not match: ${parsed.error.message.slice(0, 300)}`,
      );
    return parsed.data;
  };

  const lint: Omit<LintConfig, "width" | "height"> = {
    safeArea: brief.safeArea,
    brandFonts: brand.fontFamilies,
    systemFonts: brand.manifest.systemFontFamilies,
    ...(brand.allowedNumbers.length > 0 ? { allowedNumbers: brand.allowedNumbers } : {}),
    lang: language,
  };
  const jobDir = await createJobDir(runsRoot, ctx.jobId);
  let waited = false;
  const rc: RunContext = {
    deps,
    brand,
    inputs,
    jobDir,
    lint,
    contentType,
    allowedNumbers: (count) => [
      ...new Set([
        ...brand.allowedNumbers,
        ...(contentType === "carousel"
          ? Array.from({ length: count }, (_, i) => String(i + 1))
          : []),
      ]),
    ],
    signal,
    onWait: () => {
      if (waited) return;
      waited = true;
      ctx.progress(
        0.25,
        "Kod motoru için Python ortamı hazırlanıyor (ilk kurulum birkaç dakika sürer)",
      );
    },
  };

  const lintPayload = (v: CheckedCodeVersion) => ({
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
  const extraIssues = (v: CheckedCodeVersion) => [
    ...v.captionNumbers.map(
      (n) => `caption: the number "${n}" is not in FACTS.allowedNumbers; remove it`,
    ),
    ...v.slides.filter((s) => s.failure && !v.runError).map((s) => `${s.id}: ${s.failure}`),
    ...v.warnings.slice(0, 10),
  ];
  const renders = async (v: CheckedCodeVersion) => {
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
  const passes = Math.min(MAX_PASSES, 1 + settings.designFixPasses);
  const versions: CheckedCodeVersion[] = [];
  let final: CheckedCodeVersion;

  try {
    if (revision && baseSource) {
      // A chat revision: one rewrite of the stored program; fix passes only while it fails.
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
          const img = await prepareModelImage(bytes, {
            maxEdge: settings.imageMaxEdge,
            quality: 85,
          });
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
      final = await runAndCheck(
        rc,
        "edit",
        await ask(
          "edit",
          codeEditPrompt({
            brief,
            instruction,
            baseVersion: revision.version,
            caption: content.caption,
            imageNames: names,
            program: baseSource.program,
          }),
          blocks,
        ),
      );
      versions.push(final);
      for (let pass = 1; pass < passes && hardFailures(final) > 0; pass++) {
        ctx.progress(0.7, "Program hataları düzeltiliyor");
        final = await revisePass(final, pass, passes - 1);
      }
    } else {
      ctx.progress(0.15, "Tasarım programı yazılıyor");
      const pictureBlocks: ClaudeContentBlock[] = [];
      for (const p of shown.slice(0, MAX_PICTURES_SHOWN)) {
        const img = await prepareModelImage(p.bytes, {
          maxEdge: settings.imageMaxEdge,
          quality: 85,
        });
        if (!img) continue;
        pictureBlocks.push({ type: "text", text: `${p.label}:` });
        pictureBlocks.push({ type: "image", mediaType: img.mediaType, data: img.data });
      }
      final = await runAndCheck(
        rc,
        "v1",
        await ask("generate", codeGeneratePrompt(brief), pictureBlocks),
      );
      versions.push(final);
      // Critique → rewrite: once always, then while errors remain (1 + designFixPasses). A
      // traceback goes back to the model too (it counts as a pass).
      for (let pass = 1; pass <= passes; pass++) {
        if (pass > 1 && final.errors === 0) break;
        ctx.progress(0.3 + (pass / passes) * 0.5, `Eleştiri ve düzeltme (${pass}/${passes})`);
        final = await revisePass(final, pass, passes);
      }
    }
  } finally {
    // The run folder goes; the stored version keeps the program.
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }

  async function revisePass(current: CheckedCodeVersion, pass: number, of: number) {
    const r = await renders(current);
    const revised = await runAndCheck(
      rc,
      `v${versions.length + 1}`,
      await ask(
        `revise${pass}`,
        codeRevisePrompt({
          brief,
          pass,
          passes: of,
          imageNames: r.names,
          lint: lintPayload(current),
          runError: current.runError,
          extraIssues: extraIssues(current),
          program: current.output.program,
        }),
        r.blocks,
      ),
    );
    versions.push(revised);
    return better(revised, current) ? revised : current;
  }

  if (!usable(final)) {
    logger.warn(
      `[job ${ctx.jobId}] code design not rendered: ${final.runError?.slice(0, 400) ?? final.slides.map((s) => `${s.id}: ${s.failure ?? "?"}`).join("; ")}`,
    );
    throw new Error(
      final.runStatus === "precheck" || final.runStatus === "rejected"
        ? "Kod motorunun programı güvenlik denetiminden geçmedi (izin verilmeyen bir işlem istedi); post üretilmedi. Yeniden üretmeyi deneyin."
        : final.runStatus === "timeout"
          ? "Kod motorunun programı süre sınırını aştı; post üretilmedi. Yeniden üretmeyi deneyin; sürerse talimatı sadeleştirin."
          : `Kod motorunun programı slaytları çizemedi (${final.runError ? "program hata verdi" : final.slides.map((s) => `${s.n}. slayt: ${s.failure ?? "?"}`).join("; ")}); post üretilmedi. Yeniden üretmeyi deneyin.`,
    );
  }

  ctx.progress(0.9, "Görseller yükleniyor");
  const stored = await storeCodeVersion(deps, {
    brandId,
    contentId,
    title,
    size,
    language,
    slides: final.slides,
    program: final.output.program,
    inputs,
    origin: revision ? "ai_edit" : "generated",
    note: [
      fallback ? fallbackNote(fallback, fallbackAlias) : "",
      revision
        ? `Kod düzenleme (v${revision.version} üzerine): ${instruction.slice(0, 400)}`
        : `Kod motoruyla üretildi (${brand.label}).`,
      final.errors === 0
        ? `Denetim temiz (${final.warningCount} uyarı).`
        : `Denetimde ${final.errors} hata kaldı; sohbetten düzeltilebilir.`,
      skillsUsed.length > 0 ? `Skill'ler: ${skillsUsed.join(", ")}.` : "",
      `${calls} model çağrısı.`,
    ]
      .filter(Boolean)
      .join(" "),
    jobId: ctx.jobId,
    signal,
  });
  const version = stored.version;
  const caption = captionWithHashtags(final.output.caption, final.output.hashtags);
  if (caption && caption !== content.caption) {
    await api.client.contents
      .update(contentId, { caption: caption.slice(0, 10_000) }, init)
      .catch((error: unknown) =>
        logger.warn(`could not store the caption: ${(error as Error).message}`),
      );
  }

  // The checks with the engine's own reports (no automatic HTML fix on a code version).
  const checks = await helpers.check({
    contentId,
    version: version.version,
    fix: false,
    brand,
    reports: stored.reports,
    unresolvedAliases: media.unresolved,
  });

  // The consented "AI görsel": the product-image line fills the slot after approval.
  const slotImages = await queueSlotImageJobs(deps, {
    jobId: ctx.jobId,
    payload,
    slides: [],
    slots: emptyCodeSlots(version.slides),
    imageSlot: brief.imageSlot,
    signal,
  });

  ctx.progress(1, "Tamamlandı");
  return {
    contentId,
    engine: "code",
    ...(revision ? { baseVersion: revision.version, revised: true } : {}),
    version: version.version,
    versionId: version.id,
    contentHash: version.contentHash,
    renderedAssetIds: stored.renderedAssetIds,
    checks: checks?.brief ?? null,
    ...(slotImages ? { slotImages } : {}),
    slides: final.slides.length,
    size,
    lintClean: final.errors === 0,
    errors: final.errors,
    warnings: final.warningCount,
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
    passes: versions.map((v) => ({
      pass: v.label,
      errors: v.errors,
      warnings: v.warningCount,
      ...(v.runError ? { run: v.runStatus } : {}),
    })),
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

// --- helpers -------------------------------------------------------------------------------------

/** Slide count of a revision: the base count; a carousel may grow or shrink a little. */
function revisionBounds(contentType: string, count: number): { min: number; max: number } {
  if (contentType !== "carousel") return { min: 1, max: 1 };
  return { min: Math.max(2, count - 3), max: Math.min(10, Math.max(count, 2) + 3) };
}

function assetIdOfMediaPath(mediaPath: string): string | undefined {
  const name = mediaPath.split("/").pop() ?? "";
  return decodeURIComponent(name.replace(/\.[a-z0-9]+$/i, "")) || undefined;
}

/** A failure as the owner reads it (Turkish, what to do); transient ones are retried (U12). */
function describeCodeError(error: unknown, ctx: JobContext, deps: ContentGenerateDeps): unknown {
  if (ctx.signal.aborted) return ctx.signal.reason ?? error;
  deps.logger.warn(`[job ${ctx.jobId}] code engine failed: ${(error as Error).message}`);
  if (isBudgetExceeded(error)) return error;
  if (error instanceof CodeRuntimeError) return new Error(error.message);
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
      : "Post kod motoruyla üretilemedi. Yeniden deneyin; sürerse günlüklere bakın.",
  );
}
