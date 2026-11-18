/**
 * Reels engine (P6). One job = one MP4:
 *   media (clip / audio / hero) → transcript (footage) → plan (AI, or a given/edited spec)
 *   → voice-over (narration) → composition HTML → Chromium frames streamed into ffmpeg
 *   (Reels flags, 15/15 checks) → cover JPEG from the encoded video → upload MP4 + cover
 *   (+ voice) → content version with the `ReelSpec`.
 *
 * `content.generate` (type reel) plans with Claude/Gemini; `content.render` with a `reel`
 * patch re-renders an existing spec without any AI call.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Content,
  type ContentVersion,
  clampReelDurationMs,
  maxReelDurationMs,
  type Platform,
  type ReelGenerateOptions,
  type ReelRecipe,
  ReelSpec,
  type ReelSpecPatch,
  reelDurationIssues,
} from "@studio/contract";
import {
  type AssetResolver,
  CHROMIUM_ARGS,
  combineResolvers,
  Renderer,
  VIRTUAL_ORIGIN,
} from "@studio/design-kit/render";
import { type Browser, chromium } from "playwright-core";
import sharp from "sharp";
import type { AgentDeps } from "../agent.ts";
import { geminiUsageSink } from "../ai/usage-recorder.ts";
import type { StudioApi } from "../api.ts";
import {
  callStructuredAi,
  getGeminiApiKey,
  hasGeminiApiKey,
  resolveStructuredRoute,
} from "../gemini/json-call.ts";
import { type BrandContext, loadBrandContext } from "../generate/brand.ts";
import {
  buildToolEnv,
  createNodeFfmpegRunner,
  encodeReel,
  extractFrameJpeg,
  FFMPEG_MISSING_MESSAGE,
  type FfmpegRunner,
  probeMedia,
  resolveFfmpegBin,
} from "./ffmpeg.ts";
import {
  type BuiltComposition,
  buildFallbackPlan,
  buildFootageEditHtml,
  buildMotionGraphicsHtml,
  buildNarrationHtml,
  buildReelVersionSlideHtml,
  extractReelVersionAssets,
  inferReelRecipe,
  normalizeSpec,
  planToSpec,
  REEL_PLAN_JSON_SCHEMA,
  type ReelPlan,
  ReelPlanSchema,
} from "./recipes.ts";
import {
  type ClipTranscriber,
  createDefaultClipTranscriber,
  type TranscriptionResult,
} from "./transcribe.ts";
import { type SayCommandRunner, selectTtsProvider, type TtsProvider } from "./tts.ts";

// --- frame capture ----------------------------------------------------------------------

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

/** Frames (JPEG, or PNG with alpha when `transparent`) in order, produced lazily. */
export type ReelFrameCapturer = (request: ReelFrameCaptureRequest) => AsyncIterable<Uint8Array>;

/** Serves `/api/assets/<id>/content` and `/media/<id>[.<ext>]` from the API (cached per pass). */
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
      if (apiMatch?.[1]) return fetchAsset(decodeURIComponent(apiMatch[1]));
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
  return async function* capture(req) {
    let owned: Browser | null = null;
    let browser: Browser;
    if (getBrowser) {
      browser = await getBrowser();
    } else {
      owned = await chromium.launch({
        headless: true,
        args: [...CHROMIUM_ARGS],
        env: buildToolEnv(),
      });
      browser = owned;
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
      await context.route("**/*", async (route) => {
        let url: URL;
        try {
          url = new URL(route.request().url());
        } catch {
          return route.abort("blockedbyclient");
        }
        if (url.origin !== VIRTUAL_ORIGIN) return route.abort("blockedbyclient");
        if (url.pathname === "/__studio/reel.html") {
          return route.fulfill({
            status: 200,
            body: req.html,
            headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
          });
        }
        const resolved = await req.resolver.resolve(url.pathname);
        if (!resolved) return route.fulfill({ status: 404, body: "not found" });
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
      await page.goto(`${VIRTUAL_ORIGIN}/__studio/reel.html`, {
        waitUntil: "load",
        timeout: 30_000,
      });
      await page.evaluate(
        "(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null)))); })()",
      );
      // Fit text once fonts are in (the composition fitted with fallback metrics at load).
      await page.evaluate("window.__refit && window.__refit()");
      const total = Math.max(1, Math.round((req.durationMs / 1000) * req.fps));
      const clip = { x: 0, y: 0, width: req.width, height: req.height };
      for (let f = 0; f < total; f++) {
        req.signal.throwIfAborted();
        await page.evaluate((s) => {
          (window as unknown as { __seek?: (n: number) => void }).__seek?.(s);
        }, f / req.fps);
        const shot = req.transparent
          ? await page.screenshot({ type: "png", omitBackground: true, clip, caret: "hide" })
          : await page.screenshot({ type: "jpeg", quality: 90, clip, caret: "hide" });
        yield new Uint8Array(shot.buffer, shot.byteOffset, shot.byteLength);
        if (f % 15 === 0 || f === total - 1) req.onFrameProgress?.(f + 1, total);
      }
    } finally {
      await context.close().catch(() => undefined);
      if (owned) await owned.close().catch(() => undefined);
    }
  };
}

// --- engine -----------------------------------------------------------------------------

export interface ReelEngineTestSeams {
  ffmpeg?: FfmpegRunner;
  frameCapturer?: ReelFrameCapturer;
  ttsProvider?: TtsProvider;
  transcriber?: ClipTranscriber;
  sayExec?: SayCommandRunner;
}

type Progress = (value: number, message: string) => void;

export function resolveReelFfmpeg(deps: AgentDeps, seams?: ReelEngineTestSeams): FfmpegRunner {
  if (seams?.ffmpeg) return seams.ffmpeg;
  const bin = resolveFfmpegBin({
    ...deps.settings.parentEnv,
    ...(deps.settings.ffmpegBin ? { STUDIO_FFMPEG_BIN: deps.settings.ffmpegBin } : {}),
  });
  if (!bin) throw new Error(FFMPEG_MISSING_MESSAGE);
  return createNodeFfmpegRunner(bin, buildToolEnv(deps.settings.parentEnv));
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

const MEDIA_MAX_BYTES = 55 * 1024 * 1024;

function extFor(mime: string, fallback: string): string {
  const m = mime.split(";")[0]?.trim().toLowerCase();
  return (
    {
      "video/mp4": ".mp4",
      "video/quicktime": ".mov",
      "audio/mpeg": ".mp3",
      "audio/mp4": ".m4a",
      "audio/x-m4a": ".m4a",
      "audio/aac": ".aac",
      "audio/wav": ".wav",
      "image/jpeg": ".jpg",
      "image/png": ".png",
      "image/webp": ".webp",
    }[m ?? ""] ?? fallback
  );
}

interface EngineContext {
  deps: AgentDeps;
  seams: ReelEngineTestSeams | undefined;
  renderer: unknown;
  ffmpeg: FfmpegRunner;
  brand: BrandContext;
  workDir: string;
  signal: AbortSignal;
  progress: Progress;
  /** Notes for the version note / job output (Turkish). */
  warnings: string[];
}

async function downloadTo(
  ctx: EngineContext,
  assetId: string,
  name: string,
  fallbackExt: string,
): Promise<{ path: string; mimeType: string }> {
  const { bytes, contentType } = await ctx.deps.api.downloadAsset(assetId, {
    maxBytes: MEDIA_MAX_BYTES,
    signal: ctx.signal,
  });
  const file = path.join(ctx.workDir, `${name}${extFor(contentType, fallbackExt)}`);
  await writeFile(file, bytes);
  return { path: file, mimeType: contentType };
}

interface ClipInfo {
  path: string;
  mimeType: string;
  durationMs: number;
  hasAudio: boolean;
}

async function loadClip(ctx: EngineContext, assetId: string): Promise<ClipInfo> {
  const file = await downloadTo(ctx, assetId, "clip", ".mp4");
  const probe = await probeMedia(ctx.ffmpeg, file.path, ctx.signal);
  if (!probe.hasVideo || !probe.durationMs) {
    throw new Error("Seçilen çekim okunamadı: dosyada video akışı yok ya da süresi okunamıyor.");
  }
  return { ...file, durationMs: probe.durationMs, hasAudio: probe.hasAudio };
}

async function transcribeClip(
  ctx: EngineContext,
  clip: ClipInfo,
  startMs: number,
  durationMs: number,
): Promise<TranscriptionResult> {
  if (!clip.hasAudio) {
    return {
      language: "tr",
      text: "",
      segments: [],
      words: [],
      provider: "none",
      note: "Çekimde ses yok; altyazılar senaryodan.",
    };
  }
  ctx.progress(0.12, "Çekimdeki konuşma yazıya dökülüyor");
  const transcriber =
    ctx.seams?.transcriber ??
    createDefaultClipTranscriber({
      ffmpeg: ctx.ffmpeg,
      ...(ctx.deps.settings.whisperBin ? { whisperBin: ctx.deps.settings.whisperBin } : {}),
      geminiApiKey: getGeminiApiKey(ctx.deps.settings),
      geminiModelId: ctx.deps.settings.geminiModels["gemini-flash"],
      ...(ctx.deps.geminiFetch ? { fetch: ctx.deps.geminiFetch } : {}),
      env: ctx.deps.settings.parentEnv,
      onGeminiUsage: geminiUsageSink(ctx.deps.aiUsage, { kind: "transcribe" }),
    });
  const result = await transcriber({
    path: clip.path,
    mimeType: clip.mimeType,
    language: ctx.brand.brand.defaultLanguage,
    startMs,
    durationMs,
    signal: ctx.signal,
  });
  if (result.note) ctx.warnings.push(result.note);
  return result;
}

/** Voice-over file for the spec (reuses `voiceAssetId`, else synthesises and marks it new). */
async function ensureVoice(
  ctx: EngineContext,
  spec: ReelSpec,
): Promise<{ path: string; spec: ReelSpec; newVoice: boolean; provider: string | null }> {
  if (spec.voiceAssetId && spec.words.length > 0) {
    try {
      const file = await downloadTo(ctx, spec.voiceAssetId, "voice", ".m4a");
      return { path: file.path, spec, newVoice: false, provider: null };
    } catch (error) {
      ctx.signal.throwIfAborted();
      ctx.deps.logger.warn(`voice asset unavailable, re-synthesising: ${(error as Error).message}`);
    }
  }
  const script = spec.narrationScript.trim();
  if (!script) throw new Error("Seslendirmeli Reels için seslendirme metni boş.");
  const tts =
    ctx.seams?.ttsProvider ??
    selectTtsProvider({
      elevenLabsApiKey:
        ctx.deps.settings.parentEnv.ELEVENLABS_API_KEY ?? ctx.deps.settings.elevenLabsApiKey,
      elevenLabsVoiceId: ctx.deps.settings.elevenLabsVoiceId,
      ffmpeg: ctx.ffmpeg,
      logger: ctx.deps.logger,
      ...(ctx.deps.geminiFetch ? { fetch: ctx.deps.geminiFetch } : {}),
      ...(ctx.seams?.sayExec ? { sayExec: ctx.seams.sayExec } : {}),
    });
  if (!tts) {
    throw new Error(
      "Seslendirme yapılamıyor: bu Mac'te macOS `say` yok ve ELEVENLABS_API_KEY tanımlı değil.",
    );
  }
  ctx.progress(
    0.34,
    tts.name === "elevenlabs"
      ? "Seslendirme üretiliyor (ElevenLabs)"
      : "Seslendirme üretiliyor (macOS)",
  );
  const voiceDir = await mkdtemp(path.join(ctx.workDir, "voice-"));
  // ElevenLabs is paid: the monthly budget applies ("bütçe dolunca dur", S7).
  if (tts.name === "elevenlabs") ctx.deps.aiUsage?.assertBudget();
  const res = await tts.synthesize({
    text: script,
    voice: spec.voice,
    language: ctx.brand.brand.defaultLanguage,
    workDir: voiceDir,
    signal: ctx.signal,
  });
  // ElevenLabs spend (characters, dated price table) in the same store as Gemini's (U8).
  if (res.billing) {
    ctx.deps.aiUsage?.elevenLabs(res.billing, { kind: "tts" });
  }
  if (res.note) ctx.warnings.push(res.note);
  const words = res.words
    .filter((w) => w.word.trim())
    .map((w) => ({
      word: w.word.slice(0, 60),
      startMs: Math.max(0, w.startMs),
      endMs: Math.max(w.startMs + 40, w.endMs),
    }));
  return {
    path: res.audioPath,
    spec: { ...spec, words, durationMs: res.durationMs + 700, voiceAssetId: null },
    newVoice: true,
    provider: res.provider,
  };
}

function compositionFor(ctx: EngineContext, spec: ReelSpec, overClip: boolean): BuiltComposition {
  const hero = spec.heroAssetId
    ? `/media/${encodeURIComponent(spec.heroAssetId)}.jpg`
    : (ctx.brand.images[0]?.path ?? null);
  if (spec.recipe === "narration")
    return buildNarrationHtml({ brand: ctx.brand, spec, heroImagePath: hero });
  if (spec.recipe === "footage_edit") {
    return buildFootageEditHtml({ brand: ctx.brand, spec, overClip, stillImagePath: hero });
  }
  // A converted post's scenes carry their own pictures (N10).
  const sceneImagePaths = spec.scenes.map((s) =>
    s.imageAssetId ? `/media/${encodeURIComponent(s.imageAssetId)}.jpg` : null,
  );
  return buildMotionGraphicsHtml({
    brand: ctx.brand,
    spec,
    heroImagePath: hero,
    ...(sceneImagePaths.some(Boolean) ? { sceneImagePaths } : {}),
  });
}

function defaultCoverMs(spec: ReelSpec): number {
  if (spec.coverAtMs !== null) return spec.coverAtMs;
  if (spec.recipe === "motion_graphics") {
    const first = spec.scenes[0]?.durationMs ?? 2000;
    return Math.max(300, Math.min(first - 150, 1500));
  }
  return Math.min(spec.durationMs - 100, 1200);
}

interface RenderedReel {
  spec: ReelSpec;
  mp4: Uint8Array;
  cover: Uint8Array;
  /** Newly synthesised voice track to upload (narration). */
  voice: Uint8Array | null;
  voiceProvider: string | null;
  transcriptProvider: string | null;
  frameCount: number;
}

/**
 * Render a spec to MP4 + cover. Footage is downloaded and probed (duration clamped to the
 * clip), narration gets its voice-over, then frames stream from Chromium into ffmpeg.
 */
async function renderSpec(
  ctx: EngineContext,
  input: {
    spec: ReelSpec;
    platforms: readonly Platform[];
    clip?: ClipInfo | null;
    transcript?: TranscriptionResult | null;
  },
): Promise<RenderedReel> {
  const maxMs = maxReelDurationMs(input.platforms);
  let spec = normalizeSpec(input.spec, maxMs);
  let clip = input.clip ?? null;
  let transcriptProvider: string | null = input.transcript?.provider ?? null;

  if (spec.recipe === "footage_edit") {
    if (!spec.clipAssetId && !clip) {
      ctx.warnings.push("Çekim verilmedi: arka planda marka görseli kullanıldı.");
    }
    if (spec.clipAssetId && !clip) {
      ctx.progress(0.08, "Çekim indiriliyor");
      clip = await loadClip(ctx, spec.clipAssetId);
    }
    if (clip) {
      const available = clip.durationMs - spec.clipStartMs;
      if (available < 3000) {
        throw new Error(
          `Çekim çok kısa: ${spec.clipStartMs ? "seçilen başlangıçtan sonra " : ""}${(Math.max(0, available) / 1000).toFixed(1)} sn kalıyor, Reels en az 3 sn olmalı.`,
        );
      }
      spec = normalizeSpec({ ...spec, durationMs: Math.min(spec.durationMs, available) }, maxMs);
      if (spec.captions && spec.words.length === 0 && !input.transcript) {
        const t = await transcribeClip(ctx, clip, spec.clipStartMs, spec.durationMs);
        transcriptProvider = t.provider;
        spec = normalizeSpec({ ...spec, words: t.words }, maxMs);
      }
    }
  }

  let audio: { path: string } | { fromClip: true } | null = null;
  let music: { path: string; volume: number } | null = null;
  let voice: Uint8Array | null = null;
  let voiceProvider: string | null = null;
  if (spec.recipe === "narration") {
    const v = await ensureVoice(ctx, spec);
    if (v.spec.durationMs > maxMs) {
      ctx.warnings.push(
        `Seslendirme ${(v.spec.durationMs / 1000).toFixed(1)} sn sürdü; video ${(maxMs / 1000).toFixed(0)} sn'de kesildi. Metni kısaltın.`,
      );
    }
    spec = normalizeSpec(v.spec, maxMs);
    audio = { path: v.path };
    if (v.newVoice) {
      voice = new Uint8Array(await readFile(v.path));
      voiceProvider = v.provider;
    }
    if (spec.audioAssetId) {
      ctx.progress(0.36, "Müzik indiriliyor");
      music = {
        path: (await downloadTo(ctx, spec.audioAssetId, "music", ".m4a")).path,
        volume: 0.16,
      };
    }
  } else if (spec.audioAssetId) {
    ctx.progress(0.36, "Ses kanalı indiriliyor");
    audio = { path: (await downloadTo(ctx, spec.audioAssetId, "music", ".m4a")).path };
  } else if (clip?.hasAudio) {
    audio = { fromClip: true };
  }

  const built = compositionFor(ctx, spec, Boolean(clip));
  const resolver = combineResolvers(
    ctx.brand.resolver,
    createApiAssetPathResolver(ctx.deps.api, ctx.signal),
  );
  const rendererInst = ctx.renderer instanceof Renderer ? ctx.renderer : undefined;
  const capturer =
    ctx.seams?.frameCapturer ??
    createPlaywrightReelFrameCapturer(rendererInst ? () => rendererInst.browser() : undefined);

  const outPath = path.join(ctx.workDir, "reel.mp4");
  let frameCount = 0;
  ctx.progress(0.4, "Kareler render ediliyor");
  await encodeReel({
    frames: capturer({
      html: built.html,
      width: 1080,
      height: 1920,
      fps: 30,
      durationMs: built.durationMs,
      transparent: built.transparent,
      resolver,
      signal: ctx.signal,
      onFrameProgress: (done, total) => {
        frameCount = done;
        ctx.progress(0.4 + (done / total) * 0.44, `Kareler render ediliyor (${done}/${total})`);
      },
    }),
    frameFormat: built.transparent ? "png" : "jpeg",
    durationMs: built.durationMs,
    outPath,
    clip: clip ? { path: clip.path, startMs: spec.clipStartMs, loop: false } : null,
    audio,
    music,
    ffmpeg: ctx.ffmpeg,
    signal: ctx.signal,
  });

  ctx.progress(0.86, "Kapak karesi alınıyor");
  const coverRaw = path.join(ctx.workDir, "cover-raw.jpg");
  await extractFrameJpeg({
    ffmpeg: ctx.ffmpeg,
    videoPath: outPath,
    atMs: defaultCoverMs(spec),
    outPath: coverRaw,
    signal: ctx.signal,
  });
  let cover: Uint8Array;
  let mp4: Uint8Array;
  try {
    mp4 = new Uint8Array(await readFile(outPath));
    cover = new Uint8Array(
      await sharp(await readFile(coverRaw))
        .toColorspace("srgb")
        .jpeg({ quality: 90, mozjpeg: true })
        .toBuffer(),
    );
  } catch (error) {
    if (ctx.seams?.ffmpeg) {
      // Fake ffmpeg in unit tests writes nothing.
      mp4 = new TextEncoder().encode("FAKE_MP4");
      cover = new TextEncoder().encode("FAKE_JPEG");
    } else {
      throw error;
    }
  }
  return { spec, mp4, cover, voice, voiceProvider, transcriptProvider, frameCount };
}

async function withEngine<T>(
  deps: AgentDeps,
  options: {
    seams: ReelEngineTestSeams | undefined;
    renderer: unknown;
    brandId: string;
    brandProfileVersion?: number | undefined;
    signal: AbortSignal;
    progress: Progress;
  },
  fn: (ctx: EngineContext) => Promise<T>,
): Promise<T> {
  const ffmpeg = resolveReelFfmpeg(deps, options.seams);
  options.progress(0.04, "Marka profili okunuyor");
  const brand = await loadBrandContext({
    api: deps.api,
    brandId: options.brandId,
    profileVersion: options.brandProfileVersion,
    cacheDir: path.join(deps.stateDir, "cache", "assets"),
    signal: options.signal,
  });
  const workDir = await mkdtemp(path.join(tmpdir(), "studio-reel-"));
  try {
    return await fn({
      deps,
      seams: options.seams,
      renderer: options.renderer,
      ffmpeg,
      brand,
      workDir,
      signal: options.signal,
      progress: options.progress,
      warnings: [],
    });
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Upload MP4, cover (and a new voice track); store the reel version. */
async function storeReel(
  ctx: EngineContext,
  input: {
    content: Content;
    jobId: string;
    rendered: RenderedReel;
    origin: "generated" | "manual_edit" | "ai_edit";
    note: string;
  },
) {
  const { deps, signal } = ctx;
  const init = { signal };
  const r = input.rendered;
  ctx.progress(0.9, "Video ve kapak yükleniyor");
  const base = slug(input.content.title || ctx.brand.brand.name);
  let spec = r.spec;
  if (r.voice) {
    const voiceAsset = await deps.api.client.assets.upload(
      {
        brandId: input.content.brandId,
        kind: "audio",
        source: "generated",
        durationMs: spec.durationMs,
        file: new Blob([r.voice.slice()], { type: "audio/mp4" }),
        filename: `${base}-seslendirme.m4a`,
      },
      init,
    );
    spec = { ...spec, voiceAssetId: voiceAsset.id };
  }
  const video = await deps.api.client.assets.upload(
    {
      brandId: input.content.brandId,
      kind: "video",
      source: "generated",
      width: 1080,
      height: 1920,
      durationMs: spec.durationMs,
      file: new Blob([r.mp4.slice()], { type: "video/mp4" }),
      filename: `${base}.mp4`,
    },
    init,
  );
  const cover = await deps.api.client.assets.upload(
    {
      brandId: input.content.brandId,
      kind: "image",
      source: "generated",
      width: 1080,
      height: 1920,
      file: new Blob([r.cover.slice()], { type: "image/jpeg" }),
      filename: `${base}-kapak.jpg`,
    },
    init,
  );
  ctx.progress(0.96, "Sürüm kaydediliyor");
  const html = buildReelVersionSlideHtml({
    spec,
    videoAssetId: video.id,
    coverAssetId: cover.id,
    language: ctx.brand.brand.defaultLanguage,
  });
  const version = await deps.api.client.contents.versions.create(
    input.content.id,
    {
      origin: input.origin,
      slides: [{ html, width: 1080, height: 1920 }],
      note: input.note.slice(0, 2000),
      jobId: input.jobId,
      renderedAssetIds: [cover.id],
    },
    init,
  );
  if (version.version && input.content.status === "draft" && input.origin === "generated") {
    await deps.api.client.contents
      .transition(input.content.id, "in_review", init)
      .catch(() => undefined);
  }
  return { version, videoAssetId: video.id, coverAssetId: cover.id, spec };
}

function reelNote(
  head: string,
  ctx: EngineContext,
  spec: ReelSpec,
  platforms: readonly Platform[],
  extra: string[] = [],
): string {
  const issues = reelDurationIssues(spec.durationMs, platforms).map((i) => i.message);
  return [
    `${head} (${recipeLabel(spec.recipe)}, ${(spec.durationMs / 1000).toFixed(1)} sn, ${ctx.brand.label}).`,
    ...extra,
    ...ctx.warnings,
    ...issues,
  ]
    .filter(Boolean)
    .join(" ");
}

export function recipeLabel(recipe: ReelRecipe): string {
  return recipe === "motion_graphics"
    ? "hareketli grafik"
    : recipe === "footage_edit"
      ? "çekim kurgusu"
      : "seslendirmeli";
}

// --- planning -----------------------------------------------------------------------------

function plannerSystem(brand: BrandContext, recipe: ReelRecipe, targetSec: number): string {
  const guide =
    recipe === "motion_graphics"
      ? `Hareketli grafik: 3-5 sahne, ilk sahnenin headline'ı kanca ile aynı fikri taşır; her sahne 1,8-3,5 sn; toplam ~${targetSec} sn. narrationScript ve overlays boş.`
      : recipe === "narration"
        ? `Seslendirmeli: narrationScript doğal, akıcı Türkçe; ~${Math.round(targetSec * 2.3)} kelime (saniyede ~2,3 kelime, toplam ~${targetSec} sn). 2-4 sahne headline'ı görsel alanda sırayla görünür. overlays boş.`
        : `Çekim kurgusu: kullanıcının çekimi arka planda oynar. overlays: çekimin süresi içinde (0-${targetSec * 1000} ms) 2-5 kısa metin katmanı (en fazla 9 kelime), konuşma dökümü varsa onunla uyumlu; ilk 2,4 sn kanca içindir, overlays 2400 ms'den sonra başlar. scenes boş olabilir.`;
  return `Sen Studio'nun Reels yönetmeni ve Türkçe metin yazarısın.
Marka: ${brand.brand.name} (dil: ${brand.brand.defaultLanguage}).
Ses tonu (VOICE): ${brand.voice.slice(0, 2000)}
Tasarım kuralları: ${brand.designRules.slice(0, 1200)}
İzinli rakamlar (FACTS.allowedNumbers): ${JSON.stringify(brand.allowedNumbers)}
Kurallar:
- Yalnızca izinli rakamları ve marka gerçeklerini kullan; iddia uydurma.
- 1080x1920 dikey video; ekranda kısa, güçlü, okunur cümleler.
- ${guide}
- durationSec alanına toplam süreyi yaz.`;
}

async function callPlanner(
  deps: AgentDeps,
  input: {
    label: string;
    system: string;
    prompt: string;
    requestedModel?: string | undefined;
    requestedEffort?: string | undefined;
    signal: AbortSignal;
  },
): Promise<{ plan: ReelPlan; provider: "claude" | "gemini"; model: string | null }> {
  const route = resolveStructuredRoute({
    requestedModel: input.requestedModel,
    requestedEffort: input.requestedEffort,
    defaultEffort: deps.settings.effortDesign ?? "low",
    defaultGeminiAlias: "gemini-flash",
    settings: deps.settings,
    claudeHealth: deps.health(),
    limitChoice: deps.aiPolicy?.limitChoice(),
  });
  const res = await callStructuredAi({
    label: input.label,
    system: input.system,
    content: [{ type: "text", text: input.prompt }],
    schema: REEL_PLAN_JSON_SCHEMA,
    route,
    gate: deps.gate,
    settings: deps.settings,
    timeoutMs: deps.settings.claudeTimeoutMs,
    signal: input.signal,
    ...(deps.geminiFetch ? { geminiFetch: deps.geminiFetch } : {}),
    onGeminiUsage: geminiUsageSink(deps.aiUsage, { kind: "reel" }),
  });
  const parsed = ReelPlanSchema.safeParse(res.output);
  if (!parsed.success) throw new Error("Model geçerli bir Reels planı döndürmedi.");
  return { plan: parsed.data, provider: res.provider, model: res.model };
}

function aiAvailable(deps: AgentDeps): boolean {
  const h = deps.health().state;
  return h === "ok" || h === "limited" || hasGeminiApiKey(deps.settings);
}

// --- jobs ---------------------------------------------------------------------------------

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
  platforms?: readonly Platform[];
  requestedModel?: string | undefined;
  requestedEffort?: string | undefined;
  options?: ReelGenerateOptions;
  /** "Neyi değiştireyim?": revise this version's spec with `instructions`. */
  baseVersion?: number | undefined;
  /** Image named with @alias in the brief (uploaded asset id). */
  heroAssetId?: string | undefined;
  brandProfileVersion?: number | undefined;
  signal: AbortSignal;
  progress: Progress;
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
  provider: "claude" | "gemini" | "template" | "spec";
  model: string | null;
  warnings: string[];
}

export async function generateAndRenderReel(input: GenerateReelInput): Promise<GenerateReelOutput> {
  const { deps, signal } = input;
  const platforms: readonly Platform[] = input.platforms?.length
    ? input.platforms
    : input.content.targetPlatforms.length
      ? input.content.targetPlatforms
      : ["instagram"];
  const opts = input.options ?? {};

  return withEngine(
    deps,
    {
      seams: input.seams,
      renderer: input.renderer,
      brandId: input.brandId,
      brandProfileVersion: input.brandProfileVersion,
      signal,
      progress: input.progress,
    },
    async (ctx) => {
      const instruction = input.instructions?.trim() ?? "";

      // "Neyi değiştireyim?" on an existing reel.
      if (input.baseVersion !== undefined && instruction) {
        const base = await deps.api.client.contents.versions.get(
          input.content.id,
          input.baseVersion,
          { signal },
        );
        const baseSpec = extractReelVersionAssets(base).spec;
        if (!baseSpec) {
          throw new Error("Bu Reels sürümü düzenlenebilir bilgi taşımıyor; yeniden üretin.");
        }
        if (!aiAvailable(deps)) {
          throw new Error(
            '"Neyi değiştireyim?" için Claude ya da Gemini gerekiyor. Metinleri ve süreleri Reels düzenleyicisinden elle değiştirebilirsiniz.',
          );
        }
        input.progress(0.2, "Değişiklik uygulanıyor");
        const planned = await callPlanner(deps, {
          label: `reel-edit-${input.content.id.slice(-8)}`,
          system: plannerSystem(ctx.brand, baseSpec.recipe, Math.round(baseSpec.durationMs / 1000)),
          prompt: [
            "Mevcut Reels planı (JSON):",
            JSON.stringify(specToPlan(baseSpec)),
            `İstenen değişiklik: ${instruction}`,
            "Yalnızca istenen değişikliği yap; geri kalan her şeyi (sıra, süreler, metinler) koru. Aynı şemada tam planı döndür.",
          ].join("\n"),
          requestedModel: input.requestedModel,
          requestedEffort: input.requestedEffort,
          signal,
        });
        const revised = planToSpec(planned.plan, baseSpec.recipe, {
          clipAssetId: baseSpec.clipAssetId,
          clipStartMs: baseSpec.clipStartMs,
          audioAssetId: baseSpec.audioAssetId,
          heroAssetId: baseSpec.heroAssetId,
          voice: baseSpec.voice,
          captions: baseSpec.captions,
          coverAtMs: baseSpec.coverAtMs,
        });
        const sameScript = revised.narrationScript.trim() === baseSpec.narrationScript.trim();
        const next: ReelSpec = {
          ...revised,
          // Footage keeps its transcript; narration keeps its voice when the script is unchanged.
          words: baseSpec.recipe === "footage_edit" || sameScript ? baseSpec.words : [],
          voiceAssetId: sameScript ? baseSpec.voiceAssetId : null,
          durationMs:
            baseSpec.recipe === "footage_edit"
              ? clampReelDurationMs(revised.durationMs || baseSpec.durationMs, platforms)
              : revised.durationMs,
        };
        const rendered = await renderSpec(ctx, { spec: next, platforms });
        const stored = await storeReel(ctx, {
          content: input.content,
          jobId: input.jobId,
          rendered,
          origin: "ai_edit",
          note: reelNote(
            `AI düzenleme (s${base.version} üzerine): ${instruction.slice(0, 300)}`,
            ctx,
            rendered.spec,
            platforms,
          ),
        });
        if (planned.plan.caption && planned.plan.caption !== input.content.caption) {
          await deps.api.client.contents
            .update(
              input.content.id,
              { caption: planned.plan.caption.slice(0, 10_000) },
              { signal },
            )
            .catch(() => undefined);
        }
        input.progress(1, "Tamamlandı");
        return output(
          input.content.id,
          stored,
          rendered,
          planned.provider,
          planned.model,
          ctx.warnings,
          input.baseVersion,
        );
      }

      // A ready spec (tests, chat tool, duplicates): render as is.
      if (opts.spec) {
        const spec = ReelSpec.parse(opts.spec);
        const rendered = await renderSpec(ctx, { spec, platforms });
        const stored = await storeReel(ctx, {
          content: input.content,
          jobId: input.jobId,
          rendered,
          origin: "generated",
          note: reelNote("Reels üretildi", ctx, rendered.spec, platforms),
        });
        input.progress(1, "Tamamlandı");
        return output(input.content.id, stored, rendered, "spec", null, ctx.warnings);
      }

      const clipAssetId = opts.clipAssetId;
      const recipe = inferReelRecipe({
        explicitRecipe: opts.recipe,
        hasVideoClip: Boolean(clipAssetId),
        brief: input.brief,
        instructions: instruction,
      });
      if (recipe === "footage_edit" && !clipAssetId) {
        ctx.warnings.push(
          "Çekim kurgusu için video verilmedi; arka planda marka görseli kullanıldı.",
        );
      }
      let clip: ClipInfo | null = null;
      let transcript: TranscriptionResult | null = null;
      let targetMs = clampReelDurationMs(
        (opts.durationSec ?? (recipe === "narration" ? 15 : 9)) * 1000,
        platforms,
      );
      if (recipe === "footage_edit" && clipAssetId) {
        input.progress(0.08, "Çekim indiriliyor");
        clip = await loadClip(ctx, clipAssetId);
        targetMs = Math.min(
          clampReelDurationMs(
            (opts.durationSec ?? Math.min(clip.durationMs, 30_000) / 1000) * 1000,
            platforms,
          ),
          clip.durationMs,
        );
        transcript = await transcribeClip(ctx, clip, 0, targetMs);
      }

      input.progress(0.2, "Reels senaryosu yazılıyor");
      let plan: ReelPlan;
      let provider: GenerateReelOutput["provider"] = "template";
      let model: string | null = null;
      const fallback = () =>
        buildFallbackPlan({
          recipe,
          title: input.title,
          brief: input.brief,
          brandName: ctx.brand.brand.name,
          ...(transcript?.text ? { transcriptText: transcript.text } : {}),
          durationSec: targetMs / 1000,
        });
      if (aiAvailable(deps)) {
        try {
          const planned = await callPlanner(deps, {
            label: `reel-${input.content.id.slice(-8)}`,
            system: plannerSystem(ctx.brand, recipe, Math.round(targetMs / 1000)),
            prompt: [
              `Başlık: ${input.title}`,
              `Tarif: ${recipe}`,
              `Brief: ${input.brief || input.title}`,
              instruction ? `Ek yönerge: ${instruction}` : "",
              clip ? `Çekimin kullanılacak süresi: ${(targetMs / 1000).toFixed(1)} sn` : "",
              transcript?.segments.length
                ? `Çekimdeki konuşma (zaman damgalı): ${JSON.stringify(transcript.segments.slice(0, 60))}`
                : "",
              "JSON şemasına tam uyan Reels planını döndür.",
            ]
              .filter(Boolean)
              .join("\n"),
            requestedModel: input.requestedModel,
            requestedEffort: input.requestedEffort,
            signal,
          });
          plan = planned.plan;
          provider = planned.provider;
          model = planned.model;
        } catch (error) {
          signal.throwIfAborted();
          deps.logger.warn(`reel planning failed, using the template: ${(error as Error).message}`);
          ctx.warnings.push(
            `AI senaryosu alınamadı (${(error as Error).message.slice(0, 160)}); basit şablon kullanıldı.`,
          );
          plan = fallback();
        }
      } else {
        ctx.warnings.push("Claude/Gemini kullanılamadığı için basit şablon senaryo kullanıldı.");
        plan = fallback();
      }

      const spec = planToSpec(plan, recipe, {
        clipAssetId: clipAssetId ?? null,
        audioAssetId: opts.audioAssetId ?? null,
        heroAssetId: opts.heroAssetId ?? input.heroAssetId ?? null,
        voice: opts.voice ?? null,
        words: transcript?.words ?? [],
        ...(recipe === "footage_edit" ? { durationMs: targetMs } : {}),
      });
      const rendered = await renderSpec(ctx, { spec, platforms, clip, transcript });
      const stored = await storeReel(ctx, {
        content: input.content,
        jobId: input.jobId,
        rendered,
        origin: "generated",
        note: reelNote(
          "Reels üretildi",
          ctx,
          rendered.spec,
          platforms,
          provider === "template"
            ? []
            : [`Senaryo: ${provider === "gemini" ? "Gemini" : "Claude"}.`],
        ),
      });
      if (plan.caption && !input.content.caption) {
        await deps.api.client.contents
          .update(input.content.id, { caption: plan.caption.slice(0, 10_000) }, { signal })
          .catch(() => undefined);
      }
      input.progress(1, "Tamamlandı");
      return output(input.content.id, stored, rendered, provider, model, ctx.warnings);
    },
  );
}

function specToPlan(spec: ReelSpec): ReelPlan {
  return {
    hook: spec.hook || " ",
    scenes: spec.scenes.map((s) => ({
      eyebrow: s.eyebrow,
      headline: s.headline,
      subhead: s.subhead,
      durationSec: s.durationMs / 1000,
    })),
    narrationScript: spec.narrationScript,
    overlays: spec.overlays.map((o) => ({ startMs: o.startMs, endMs: o.endMs, caption: o.text })),
    cta: spec.cta,
    caption: "",
    durationSec: spec.durationMs / 1000,
  };
}

function output(
  contentId: string,
  stored: Awaited<ReturnType<typeof storeReel>>,
  rendered: RenderedReel,
  provider: GenerateReelOutput["provider"],
  model: string | null,
  warnings: string[],
  baseVersion?: number,
): GenerateReelOutput {
  return {
    contentId,
    ...(baseVersion !== undefined ? { baseVersion, revised: true } : {}),
    version: stored.version.version,
    versionId: stored.version.id,
    contentHash: stored.version.contentHash,
    recipe: stored.spec.recipe,
    durationMs: stored.spec.durationMs,
    videoAssetId: stored.videoAssetId,
    coverAssetId: stored.coverAssetId,
    renderedAssetIds: [stored.coverAssetId],
    frames: rendered.frameCount,
    bytes: rendered.mp4.byteLength,
    voice: rendered.voiceProvider,
    transcript: rendered.transcriptProvider,
    provider,
    model,
    warnings,
  };
}

/** Apply editor changes to a spec (arrays replace; a changed script drops the old voice). */
export function applyReelPatch(spec: ReelSpec, patch: ReelSpecPatch): ReelSpec {
  const next: ReelSpec = {
    ...spec,
    ...(patch.hook !== undefined ? { hook: patch.hook } : {}),
    ...(patch.cta !== undefined ? { cta: patch.cta } : {}),
    ...(patch.scenes !== undefined
      ? {
          // An editor that does not know scene pictures (older apps) keeps them by position.
          scenes: patch.scenes.map((s, i) =>
            s.imageAssetId === undefined && spec.scenes[i]?.imageAssetId
              ? { ...s, imageAssetId: spec.scenes[i]?.imageAssetId ?? null }
              : s,
          ),
        }
      : {}),
    ...(patch.overlays !== undefined ? { overlays: patch.overlays } : {}),
    ...(patch.captions !== undefined ? { captions: patch.captions } : {}),
    ...(patch.durationMs !== undefined ? { durationMs: patch.durationMs } : {}),
    ...(patch.coverAtMs !== undefined ? { coverAtMs: patch.coverAtMs } : {}),
    ...(patch.voice !== undefined ? { voice: patch.voice } : {}),
  };
  const scriptChanged =
    patch.narrationScript !== undefined &&
    patch.narrationScript.trim() !== spec.narrationScript.trim();
  const voiceChanged = patch.voice !== undefined && patch.voice !== spec.voice;
  if (scriptChanged || voiceChanged) {
    next.narrationScript = patch.narrationScript ?? spec.narrationScript;
    if (spec.recipe === "narration") {
      next.words = [];
      next.voiceAssetId = null;
    }
  }
  return next;
}

/**
 * `content.render` on a reel: re-render the version's spec (with `patch` applied) and store it
 * as a new `manual_edit` version. No AI call.
 */
export async function renderExistingReelVersion(input: {
  deps: AgentDeps;
  renderer?: unknown;
  seams?: ReelEngineTestSeams;
  jobId: string;
  brandId: string;
  content: Content;
  version: ContentVersion;
  patch?: ReelSpecPatch | undefined;
  note?: string | undefined;
  signal: AbortSignal;
  progress: Progress;
}): Promise<Record<string, unknown>> {
  const baseSpec = extractReelVersionAssets(input.version).spec;
  if (!baseSpec) {
    throw new Error(
      'Bu Reels sürümü düzenlenebilir bilgi taşımıyor (eski biçim). "Neyi değiştireyim?" ya da yeniden üret ile yeni bir sürüm oluşturun.',
    );
  }
  const platforms: readonly Platform[] = input.content.targetPlatforms.length
    ? input.content.targetPlatforms
    : ["instagram"];
  const spec = input.patch ? applyReelPatch(baseSpec, input.patch) : baseSpec;
  return withEngine(
    input.deps,
    {
      seams: input.seams,
      renderer: input.renderer,
      brandId: input.brandId,
      signal: input.signal,
      progress: input.progress,
    },
    async (ctx) => {
      const rendered = await renderSpec(ctx, { spec, platforms });
      const changes = input.patch ? describePatch(input.patch) : "yeniden render";
      const stored = await storeReel(ctx, {
        content: input.content,
        jobId: input.jobId,
        rendered,
        origin: "manual_edit",
        note:
          input.note ??
          reelNote(
            `Reels düzenlendi (s${input.version.version} üzerine: ${changes})`,
            ctx,
            rendered.spec,
            platforms,
          ),
      });
      input.progress(1, "Tamamlandı");
      return {
        contentId: input.content.id,
        baseVersion: input.version.version,
        version: stored.version.version,
        versionId: stored.version.id,
        contentHash: stored.version.contentHash,
        renderedAssetIds: [stored.coverAssetId],
        videoAssetId: stored.videoAssetId,
        coverAssetId: stored.coverAssetId,
        durationMs: stored.spec.durationMs,
        recipe: stored.spec.recipe,
        frames: rendered.frameCount,
        bytes: rendered.mp4.byteLength,
        voice: rendered.voiceProvider,
        warnings: ctx.warnings,
      };
    },
  );
}

function describePatch(patch: ReelSpecPatch): string {
  const parts: string[] = [];
  if (patch.hook !== undefined) parts.push("kanca");
  if (patch.scenes !== undefined) parts.push("sahneler");
  if (patch.overlays !== undefined) parts.push("metin katmanları");
  if (patch.narrationScript !== undefined) parts.push("seslendirme metni");
  if (patch.cta !== undefined) parts.push("kapanış");
  if (patch.durationMs !== undefined) parts.push("süre");
  if (patch.captions !== undefined) parts.push(patch.captions ? "altyazı açık" : "altyazı kapalı");
  if (patch.coverAtMs !== undefined) parts.push("kapak karesi");
  if (patch.voice !== undefined) parts.push("ses");
  return parts.join(", ") || "yeniden render";
}
