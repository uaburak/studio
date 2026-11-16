/**
 * End-to-end Reels Video Engine (`PLAN.md` §7):
 * - Plans & builds 1080x1920 animated HTML compositions (`motion_graphics`, `footage_edit`, `narration`),
 * - Steps frames at 30 fps in Playwright Chromium (`window.__seek(t)`),
 * - Captures sRGB JPEG cover at `t = 0.5s`,
 * - Pipes frames + audio into `ffmpeg` with verified Reels normalization flags,
 * - Uploads both `.mp4` (`kind: "video"`) and cover `.jpg` (`kind: "image"`) and stores the `ContentVersion`.
 */
import path from "node:path";
import type { Content, ContentVersion } from "@studio/contract";
import {
  type AssetResolver,
  CHROMIUM_ARGS,
  combineResolvers,
  createMemoryResolver,
  pngToSrgbJpeg,
  Renderer,
  VIRTUAL_ORIGIN,
} from "@studio/design-kit/render";
import { type Browser, chromium } from "playwright-core";
import type { AgentDeps } from "../agent.ts";
import type { StudioApi } from "../api.ts";
import { callStructuredAi, getGeminiApiKey, resolveStructuredRoute } from "../gemini/json-call.ts";
import { type BrandContext, loadBrandContext } from "../generate/brand.ts";
import {
  createNodeFfmpegRunner,
  type FfmpegRunner,
  muxFramesToReelsMp4,
  resolveFfmpegBin,
} from "./ffmpeg.ts";
import {
  buildFallbackReelPlan,
  buildFootageEditHtml,
  buildMotionGraphicsHtml,
  buildNarrationHtml,
  buildReelVersionSlideHtml,
  extractReelVersionAssets,
  inferReelRecipe,
  REEL_PLAN_JSON_SCHEMA,
  type ReelPlan,
  ReelPlanSchema,
  type ReelRecipe,
} from "./recipes.ts";
import {
  type ClipTranscriber,
  createDefaultClipTranscriber,
  type TranscriptionResult,
} from "./transcribe.ts";
import { type SayCommandRunner, selectTtsProvider, type TtsProvider } from "./tts.ts";

export interface ReelFrameCaptureRequest {
  html: string;
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  transparent: boolean;
  resolver: AssetResolver;
  signal: AbortSignal;
  onFrameProgress?: (frame: number, totalFrames: number) => void;
}

export interface ReelFrameCaptureResult {
  frames: Uint8Array[];
  coverPng: Uint8Array;
}

export type ReelFrameCapturer = (
  request: ReelFrameCaptureRequest,
) => Promise<ReelFrameCaptureResult>;

/**
 * Resolver that serves `/api/assets/<id>/content` and `/media/<id>[.<ext>]` directly
 * from `StudioApi` (cached in memory per render pass).
 */
export function createApiAssetPathResolver(api: StudioApi, signal?: AbortSignal): AssetResolver {
  const cache = new Map<string, Promise<{ body: Uint8Array; contentType: string } | null>>();
  const fetchAsset = (assetId: string) => {
    let p = cache.get(assetId);
    if (!p) {
      p = api
        .downloadAsset(assetId, { maxBytes: 55 * 1024 * 1024, ...(signal ? { signal } : {}) })
        .then(({ bytes, contentType }) => ({ body: bytes, contentType }))
        .catch(() => null);
      cache.set(assetId, p);
    }
    return p;
  };

  return {
    async resolve(urlPath) {
      const apiMatch = /^\/api\/assets\/([^/]+)\/content$/.exec(urlPath);
      if (apiMatch?.[1]) {
        return fetchAsset(decodeURIComponent(apiMatch[1]));
      }
      if (urlPath.startsWith("/media/")) {
        const name = decodeURIComponent(urlPath.slice("/media/".length));
        const bareId = name.replace(/\.[a-z0-9]+$/i, "");
        if (bareId) return fetchAsset(bareId);
      }
      return null;
    },
  };
}

export function createPlaywrightReelFrameCapturer(
  getBrowser?: () => Promise<Browser>,
): ReelFrameCapturer {
  return async (req) => {
    let ownedBrowser: Browser | null = null;
    let browser: Browser;
    if (getBrowser) {
      browser = await getBrowser();
    } else {
      ownedBrowser = await chromium.launch({ headless: true, args: [...CHROMIUM_ARGS] });
      browser = ownedBrowser;
    }

    const context = await browser.newContext({
      viewport: { width: req.width, height: req.height },
      deviceScaleFactor: 1,
      javaScriptEnabled: true,
      colorScheme: "light",
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      serviceWorkers: "block",
      acceptDownloads: false,
    });

    try {
      const docUrl = `${VIRTUAL_ORIGIN}/__studio/reel.html`;
      await context.route("**/*", async (route) => {
        const raw = route.request().url();
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          return route.abort("blockedbyclient");
        }
        if (url.origin !== VIRTUAL_ORIGIN) {
          return route.abort("blockedbyclient");
        }
        if (url.pathname === "/__studio/reel.html") {
          return route.fulfill({
            status: 200,
            body: req.html,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
            },
          });
        }
        const resolved = await req.resolver.resolve(url.pathname);
        if (!resolved) {
          return route.fulfill({ status: 404, body: "not found" });
        }
        return route.fulfill({
          status: 200,
          body: Buffer.from(
            resolved.body.buffer,
            resolved.body.byteOffset,
            resolved.body.byteLength,
          ),
          headers: { "content-type": resolved.contentType, "cache-control": "no-store" },
        });
      });

      const page = await context.newPage();
      await page.goto(docUrl, { waitUntil: "load", timeout: 30_000 });
      await page.evaluate(
        "(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null)))); })()",
      );

      const totalFrames = Math.max(1, Math.round((req.durationMs / 1000) * req.fps));
      const coverFrameIdx = Math.min(totalFrames - 1, Math.round(0.5 * req.fps));
      const frames: Uint8Array[] = [];
      let coverPng: Uint8Array | null = null;

      for (let f = 0; f < totalFrames; f++) {
        req.signal.throwIfAborted();
        const t = f / req.fps;
        await page.evaluate((sec) => {
          const w = window as unknown as { __seek?: (n: number) => void };
          w.__seek?.(sec);
        }, t);

        if (req.transparent) {
          const png = new Uint8Array(
            await page.screenshot({
              type: "png",
              omitBackground: true,
              clip: { x: 0, y: 0, width: req.width, height: req.height },
              scale: "css",
              caret: "hide",
            }),
          );
          frames.push(png);
          if (f === coverFrameIdx) {
            coverPng = new Uint8Array(
              await page.screenshot({
                type: "png",
                omitBackground: false,
                clip: { x: 0, y: 0, width: req.width, height: req.height },
                scale: "css",
                caret: "hide",
              }),
            );
          }
        } else {
          const jpeg = new Uint8Array(
            await page.screenshot({
              type: "jpeg",
              quality: 92,
              clip: { x: 0, y: 0, width: req.width, height: req.height },
              scale: "css",
              caret: "hide",
            }),
          );
          frames.push(jpeg);
          if (f === coverFrameIdx) {
            coverPng = new Uint8Array(
              await page.screenshot({
                type: "png",
                clip: { x: 0, y: 0, width: req.width, height: req.height },
                scale: "css",
                caret: "hide",
              }),
            );
          }
        }

        if (f % 15 === 0 || f === totalFrames - 1) {
          req.onFrameProgress?.(f + 1, totalFrames);
        }
      }

      if (!coverPng) {
        coverPng = new Uint8Array(
          await page.screenshot({
            type: "png",
            clip: { x: 0, y: 0, width: req.width, height: req.height },
            scale: "css",
            caret: "hide",
          }),
        );
      }

      return { frames, coverPng };
    } finally {
      await context.close().catch(() => undefined);
      if (ownedBrowser) await ownedBrowser.close().catch(() => undefined);
    }
  };
}

export interface ReelEngineTestSeams {
  ffmpeg?: FfmpegRunner;
  frameCapturer?: ReelFrameCapturer;
  ttsProvider?: TtsProvider;
  transcriber?: ClipTranscriber;
  sayExec?: SayCommandRunner;
}

function slug(text: string): string {
  return (
    text
      .toLocaleLowerCase("tr")
      .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c] ?? c)
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "reel"
  );
}

function resolveFfmpegOrThrow(deps: AgentDeps, seams?: ReelEngineTestSeams): FfmpegRunner {
  if (seams?.ffmpeg) return seams.ffmpeg;
  const bin = resolveFfmpegBin({
    ...deps.settings.parentEnv,
    ...(deps.settings.ffmpegBin ? { STUDIO_FFMPEG_BIN: deps.settings.ffmpegBin } : {}),
  });
  if (!bin) {
    throw new Error(
      "Reels video üretimi için Mac'te `ffmpeg` bulunamadı: Homebrew ile `brew install ffmpeg` kurun ya da STUDIO_FFMPEG_BIN tanımlayın.",
    );
  }
  return createNodeFfmpegRunner(bin);
}

export interface GenerateReelInput {
  deps: AgentDeps;
  renderer?: unknown;
  seams?: ReelEngineTestSeams;
  jobId: string;
  brandId: string;
  content: Content;
  title: string;
  brief: string;
  instructions?: string | null;
  requestedModel?: string | undefined;
  requestedEffort?: string | undefined;
  explicitRecipe?: unknown;
  videoClipAssetId?: string | undefined;
  audioAssetId?: string | undefined;
  heroImage?: { path: string; bytes: Uint8Array } | null;
  brandProfileVersion?: number | undefined;
  signal: AbortSignal;
  progress: (value: number, message: string) => void;
}

export interface GenerateReelOutput extends Record<string, unknown> {
  contentId: string;
  version: number;
  versionId: string;
  contentHash: string;
  recipe: ReelRecipe;
  durationMs: number;
  videoAssetId: string;
  coverAssetId: string;
  renderedAssetIds: string[];
  provider: "claude" | "gemini" | "template";
  model: string | null;
}

export async function generateAndRenderReel(input: GenerateReelInput): Promise<GenerateReelOutput> {
  const { deps, signal } = input;
  const init = { signal };
  const ffmpeg = resolveFfmpegOrThrow(deps, input.seams);

  input.progress(0.06, "Marka profili okunuyor");
  const brand = await loadBrandContext({
    api: deps.api,
    brandId: input.brandId,
    profileVersion: input.brandProfileVersion,
    cacheDir: path.join(deps.stateDir, "cache", "assets"),
    signal,
  });

  // Check if a video clip asset was supplied or exists on the brand for `footage_edit`
  let clipBytes: { bytes: Uint8Array; mimeType: string } | null = null;
  if (input.videoClipAssetId) {
    const dl = await deps.api.downloadAsset(input.videoClipAssetId, {
      maxBytes: 55 * 1024 * 1024,
      signal,
    });
    clipBytes = { bytes: dl.bytes, mimeType: dl.contentType };
  }

  let customAudio: { bytes: Uint8Array; mimeType: string; durationMs?: number | null } | undefined;
  if (input.audioAssetId) {
    const assetMeta = await deps.api.client.assets.get(input.audioAssetId, init).catch(() => null);
    const dl = await deps.api.downloadAsset(input.audioAssetId, {
      maxBytes: 55 * 1024 * 1024,
      signal,
    });
    customAudio = {
      bytes: dl.bytes,
      mimeType: dl.contentType,
      durationMs: assetMeta?.durationMs ?? null,
    };
  }

  const recipe = inferReelRecipe({
    explicitRecipe: input.explicitRecipe,
    hasVideoClip: Boolean(clipBytes),
    brief: input.brief,
    instructions: input.instructions,
  });

  let transcript: TranscriptionResult | null = null;
  if (recipe === "footage_edit" && clipBytes) {
    input.progress(0.14, "Klip yazıya dökülüyor");
    const transcriber =
      input.seams?.transcriber ??
      createDefaultClipTranscriber({
        whisperBin: deps.settings.whisperBin ?? null,
        geminiApiKey: getGeminiApiKey(deps.settings),
        geminiModelId: deps.settings.geminiModels["gemini-flash"],
        ...(deps.geminiFetch ? { fetch: deps.geminiFetch } : {}),
      });
    transcript = await transcriber({
      bytes: clipBytes.bytes,
      mimeType: clipBytes.mimeType,
      language: brand.brand.defaultLanguage,
      signal,
    });
  }

  input.progress(0.22, `Reels senaryosu hazırlanıyor (${recipe})`);
  let plan: ReelPlan;
  let usedProvider: "claude" | "gemini" | "template" = "template";
  let usedModel: string | null = null;

  try {
    const route = resolveStructuredRoute({
      requestedModel: input.requestedModel,
      requestedEffort: input.requestedEffort,
      defaultEffort: deps.settings.effortDesign,
      defaultGeminiAlias: "gemini-flash",
      settings: deps.settings,
      claudeHealth: deps.health(),
    });
    const system = `Sen Studio'nun Reels video yönetmeni ve Türkçe metin yazarısın.
Marka: ${brand.brand.name} (dil: ${brand.brand.defaultLanguage}).
Ses tonu (VOICE): ${brand.voice.slice(0, 2000)}
Tasarım kuralları: ${brand.designRules.slice(0, 1500)}
İzinli rakamlar (FACTS.allowedNumbers): ${JSON.stringify(brand.allowedNumbers)}
Kurallar:
- Yalnızca izinli rakamları ve marka gerçeklerini kullan; iddia uydurma.
- Reels 1080x1920 dikey formatındadır, ilk 2 saniyede güçlü Türkçe kanca (hook) olmalı.
- İstenen tarif (recipe): ${recipe}.
- Süre (durationSec): 5 ile 8 saniye arası kompakt, yüksek tempolu akış.`;

    const promptText = [
      `Başlık: ${input.title}`,
      `Tarif: ${recipe}`,
      `Brief: ${input.brief || input.title}`,
      input.instructions ? `Ek yönerge: ${input.instructions}` : "",
      transcript?.text ? `Klip dökümü (transkript): ${transcript.text}` : "",
      transcript?.segments.length
        ? `Zaman damgalı kesitler: ${JSON.stringify(transcript.segments)}`
        : "",
      "JSON şemasına tam uyan Reels planını döndür.",
    ]
      .filter(Boolean)
      .join("\n");

    const aiRes = await callStructuredAi({
      label: `reel-${input.content.id.slice(-8)}`,
      system,
      content: [{ type: "text", text: promptText }],
      schema: REEL_PLAN_JSON_SCHEMA,
      route,
      gate: deps.gate,
      settings: deps.settings,
      timeoutMs: deps.settings.claudeTimeoutMs,
      signal,
      ...(deps.geminiFetch ? { geminiFetch: deps.geminiFetch } : {}),
    });
    const parsed = ReelPlanSchema.safeParse(aiRes.output);
    plan = parsed.success
      ? parsed.data
      : buildFallbackReelPlan({
          recipe,
          title: input.title,
          brief: input.brief,
          brandName: brand.brand.name,
          transcript,
        });
    usedProvider = aiRes.provider;
    usedModel = aiRes.model;
  } catch (err) {
    signal.throwIfAborted();
    deps.logger.warn(
      `reel AI planning fell back to deterministic template: ${(err as Error).message}`,
    );
    plan = buildFallbackReelPlan({
      recipe,
      title: input.title,
      brief: input.brief,
      brandName: brand.brand.name,
      transcript,
    });
  }

  // Synthesize voiceover or prepare audio track
  input.progress(
    0.38,
    recipe === "narration" ? "Seslendirme üretiliyor" : "Ses kanalı hazırlanıyor",
  );
  const tts =
    input.seams?.ttsProvider ??
    selectTtsProvider({
      recipe,
      elevenLabsApiKey:
        deps.settings.parentEnv.ELEVENLABS_API_KEY ?? deps.settings.elevenLabsApiKey,
      elevenLabsVoiceId: deps.settings.elevenLabsVoiceId,
      customAudio,
      ffmpeg,
      ...(deps.geminiFetch ? { fetch: deps.geminiFetch } : {}),
      ...(input.seams?.sayExec ? { sayExec: input.seams.sayExec } : {}),
    });

  const scriptText =
    recipe === "narration"
      ? plan.narrationScript.trim() ||
        `${plan.hook}. ${plan.scenes.map((s) => s.headline).join(". ")}`
      : "";
  const ttsResult = await tts.synthesize({
    text: scriptText,
    language: brand.brand.defaultLanguage,
    durationMs: Math.round(plan.durationSec * 1000),
    signal,
  });

  // Build recipe HTML
  const heroPath = input.heroImage?.path ?? brand.images[0]?.path ?? null;
  const built =
    recipe === "narration"
      ? buildNarrationHtml({
          brand,
          plan,
          words: ttsResult.words,
          durationMs: ttsResult.durationMs,
          heroImagePath: heroPath,
        })
      : recipe === "footage_edit"
        ? buildFootageEditHtml({
            brand,
            plan,
            hasBackgroundVideo: Boolean(clipBytes),
            stillImagePath: heroPath,
          })
        : buildMotionGraphicsHtml({
            brand,
            plan,
            heroImagePath: heroPath,
          });

  const resolver = combineResolvers(
    brand.resolver,
    ...(input.heroImage
      ? [createMemoryResolver({ [input.heroImage.path]: input.heroImage.bytes })]
      : []),
    createApiAssetPathResolver(deps.api, signal),
  );

  const rendererInst = input.renderer instanceof Renderer ? input.renderer : undefined;
  const capturer =
    input.seams?.frameCapturer ??
    createPlaywrightReelFrameCapturer(rendererInst ? () => rendererInst.browser() : undefined);

  input.progress(0.5, "Kareler render ediliyor (1080×1920 @ 30fps)");
  const captured = await capturer({
    html: built.html,
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs: built.durationMs,
    transparent: built.transparent,
    resolver,
    signal,
    onFrameProgress: (done, total) => {
      const ratio = 0.5 + (done / total) * 0.28;
      input.progress(ratio, `Kareler render ediliyor (${done}/${total})`);
    },
  });

  input.progress(0.8, "FFmpeg Reels normalleştirmesi çalışıyor");
  const mp4Bytes = await muxFramesToReelsMp4({
    frames: captured.frames,
    frameFormat: built.transparent ? "png" : "jpeg",
    fps: 30,
    durationMs: built.durationMs,
    audio:
      ttsResult.audioBytes.byteLength > 0
        ? { bytes: ttsResult.audioBytes, mimeType: ttsResult.mimeType }
        : null,
    backgroundVideo: clipBytes,
    ffmpeg,
    signal,
  });

  const coverJpeg = await pngToSrgbJpeg(captured.coverPng, 92);

  input.progress(0.9, "Video ve kapak yükleniyor");
  const fileBase = slug(input.title || brand.brand.name);
  const videoAsset = await deps.api.client.assets.upload(
    {
      brandId: input.brandId,
      kind: "video",
      source: "generated",
      width: 1080,
      height: 1920,
      durationMs: built.durationMs,
      file: new Blob([mp4Bytes.slice()], { type: "video/mp4" }),
      filename: `${fileBase}.mp4`,
    },
    init,
  );
  const coverAsset = await deps.api.client.assets.upload(
    {
      brandId: input.brandId,
      kind: "image",
      source: "generated",
      width: 1080,
      height: 1920,
      file: new Blob([coverJpeg.slice()], { type: "image/jpeg" }),
      filename: `${fileBase}-cover.jpg`,
    },
    init,
  );

  const slideHtml = buildReelVersionSlideHtml({
    brand,
    hook: plan.hook,
    cta: plan.cta || brand.brand.name,
    videoAssetId: videoAsset.id,
    coverAssetId: coverAsset.id,
    recipe,
    durationMs: built.durationMs,
    compositionHtml: built.html,
  });

  const note = `Reels üretildi (${recipe}, ${(built.durationMs / 1000).toFixed(1)} sn, ${brand.label}).`;

  input.progress(0.96, "Sürüm kaydediliyor");
  const version = await deps.api.client.contents.versions.create(
    input.content.id,
    {
      origin: "generated",
      slides: [{ html: slideHtml, width: 1080, height: 1920 }],
      note: note.slice(0, 2000),
      jobId: input.jobId,
      renderedAssetIds: [coverAsset.id],
    },
    init,
  );

  if (plan.caption && plan.caption !== input.content.caption) {
    await deps.api.client.contents
      .update(input.content.id, { caption: plan.caption.slice(0, 10_000) }, init)
      .catch(() => undefined);
  }

  if (input.content.status === "draft") {
    await deps.api.client.contents
      .transition(input.content.id, "in_review", init)
      .catch(() => undefined);
  }

  input.progress(1, "Tamamlandı");
  return {
    contentId: input.content.id,
    version: version.version,
    versionId: version.id,
    contentHash: version.contentHash,
    recipe,
    durationMs: built.durationMs,
    videoAssetId: videoAsset.id,
    coverAssetId: coverAsset.id,
    renderedAssetIds: [coverAsset.id],
    provider: usedProvider,
    model: usedModel,
  };
}

/**
 * Re-render an existing Reel `ContentVersion` (used by `content.render` when
 * `content.type === "reel"` or `format === "mp4"`).
 */
export async function renderExistingReelVersion(input: {
  deps: AgentDeps;
  renderer?: unknown;
  seams?: ReelEngineTestSeams;
  jobId: string;
  brandId: string;
  content: Content;
  version: ContentVersion;
  signal: AbortSignal;
  progress: (value: number, message: string) => void;
}): Promise<Record<string, unknown>> {
  const extracted = extractReelVersionAssets(input.version);
  if (!extracted.compositionHtml) {
    // No stored composition yet: generate from the content's brief
    return generateAndRenderReel({
      deps: input.deps,
      renderer: input.renderer,
      seams: input.seams,
      jobId: input.jobId,
      brandId: input.brandId,
      content: input.content,
      title: input.content.title,
      brief: input.content.brief,
      ...(extracted.recipe ? { explicitRecipe: extracted.recipe } : {}),
      signal: input.signal,
      progress: input.progress,
    });
  }

  const ffmpeg = resolveFfmpegOrThrow(input.deps, input.seams);
  const brand: BrandContext = await loadBrandContext({
    api: input.deps.api,
    brandId: input.brandId,
    cacheDir: path.join(input.deps.stateDir, "cache", "assets"),
    signal: input.signal,
  });
  const resolver = combineResolvers(
    brand.resolver,
    createApiAssetPathResolver(input.deps.api, input.signal),
  );
  const rendererInst = input.renderer instanceof Renderer ? input.renderer : undefined;
  const capturer =
    input.seams?.frameCapturer ??
    createPlaywrightReelFrameCapturer(rendererInst ? () => rendererInst.browser() : undefined);

  const durationMs = extracted.durationMs ?? 6000;
  input.progress(0.3, "Reels kareleri yeniden render ediliyor");
  const captured = await capturer({
    html: extracted.compositionHtml,
    width: 1080,
    height: 1920,
    fps: 30,
    durationMs,
    transparent: false,
    resolver,
    signal: input.signal,
  });

  input.progress(0.75, "FFmpeg ile MP4 oluşturuluyor");
  const mp4Bytes = await muxFramesToReelsMp4({
    frames: captured.frames,
    frameFormat: "jpeg",
    fps: 30,
    durationMs,
    ffmpeg,
    signal: input.signal,
  });
  const coverJpeg = await pngToSrgbJpeg(captured.coverPng, 92);

  const init = { signal: input.signal };
  const fileBase = slug(input.content.title);
  const videoAsset = await input.deps.api.client.assets.upload(
    {
      brandId: input.brandId,
      kind: "video",
      source: "generated",
      width: 1080,
      height: 1920,
      durationMs,
      file: new Blob([mp4Bytes.slice()], { type: "video/mp4" }),
      filename: `${fileBase}-v${input.version.version}.mp4`,
    },
    init,
  );
  const coverAsset = await input.deps.api.client.assets.upload(
    {
      brandId: input.brandId,
      kind: "image",
      source: "generated",
      width: 1080,
      height: 1920,
      file: new Blob([coverJpeg.slice()], { type: "image/jpeg" }),
      filename: `${fileBase}-v${input.version.version}-cover.jpg`,
    },
    init,
  );

  const slideHtml = buildReelVersionSlideHtml({
    brand,
    hook: input.content.title,
    cta: brand.brand.name,
    videoAssetId: videoAsset.id,
    coverAssetId: coverAsset.id,
    recipe: extracted.recipe ?? "motion_graphics",
    durationMs,
    compositionHtml: extracted.compositionHtml,
  });

  const newVer = await input.deps.api.client.contents.versions.create(
    input.content.id,
    {
      origin: "manual_edit",
      slides: [{ html: slideHtml, width: 1080, height: 1920 }],
      note: `Reels MP4 yeniden dışa aktarıldı (sürüm ${input.version.version}).`,
      jobId: input.jobId,
      renderedAssetIds: [coverAsset.id],
    },
    init,
  );

  if (input.content.status === "draft") {
    await input.deps.api.client.contents
      .transition(input.content.id, "in_review", init)
      .catch(() => undefined);
  }

  input.progress(1, "Tamamlandı");
  return {
    contentId: input.content.id,
    version: newVer.version,
    versionId: newVer.id,
    renderedAssetIds: [coverAsset.id],
    videoAssetId: videoAsset.id,
    coverAssetId: coverAsset.id,
  };
}
