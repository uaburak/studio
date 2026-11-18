/**
 * `media.analyze` (N12): read uploaded pictures on this Mac and store what is in them, so the
 * library, the picker and the chat agent (`search_media`) can find them by Turkish words.
 *
 * Per picture: Vision (studio-vision) classifies it (tags, mapped to Turkish), reads its text
 * (tr-TR + en-US) and makes a feature print ("Benzerleri"); sharp adds the main colours, the
 * shape, and whether it is a cutout or logo-like. An AI caption (Gemini, paid) only when the
 * owner turned it on, never past the monthly budget. Without the helper the picture still gets
 * colours and shape (`partial`); a worker that has the helper redoes those later.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ApiError,
  ASSET_ANALYSIS_VERSION,
  type Asset,
  type AssetAnalysisPut,
  type AssetColor,
  type AssetTag,
  MediaAnalyzePayload,
} from "@studio/contract";
import sharp from "sharp";
import type { AgentSettings } from "../agent.ts";
import type { AiPolicy } from "../ai/policy.ts";
import { type AiUsageRecorder, geminiUsageSink } from "../ai/usage-recorder.ts";
import type { StudioApi } from "../api.ts";
import { callGeminiJson, getGeminiApiKey } from "../gemini/json-call.ts";
import type { Logger } from "../log.ts";
import { defineHandler, type JobContext } from "../registry.ts";
import { VISION_HELPER_MISSING, type VisionHelper, VisionHelperError } from "./helper.ts";
import { colorName, turkishLabel } from "./labels-tr.ts";

export interface MediaAnalyzeDeps {
  api: StudioApi;
  logger: Logger;
  settings: AgentSettings;
  stateDir: string;
  vision: VisionHelper;
  aiUsage?: AiUsageRecorder | undefined;
  aiPolicy?: AiPolicy | undefined;
  geminiFetch?: typeof globalThis.fetch;
}

/** Tags below this confidence are noise (Vision returns hundreds of weak guesses). */
const MIN_TAG_CONFIDENCE = 0.12;
const MAX_TAGS = 10;
/** OCR lines below this confidence are dropped from the stored text. */
const MIN_TEXT_CONFIDENCE = 0.3;
/** Long edge of the copy Vision reads (enough for labels; keeps big photos fast). */
const ANALYSIS_EDGE = 2048;

// --- what sharp sees ---------------------------------------------------------------------------

export interface PictureFacts {
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
  aspectRatio: number;
  isCutout: boolean;
  colors: AssetColor[];
  /** Colour buckets needed to cover 90 % of the picture (few = flat, logo-like). */
  bucketsFor90: number;
  /** Share of the largest colour bucket. */
  topShare: number;
}

export async function pictureFacts(bytes: Uint8Array): Promise<PictureFacts> {
  const image = sharp(bytes, { animated: false }).rotate();
  const meta = await image.metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = (rotated ? meta.height : meta.width) ?? 0;
  const height = (rotated ? meta.width : meta.height) ?? 0;
  const aspectRatio = height > 0 ? Math.round((width / height) * 1000) / 1000 : 1;
  const orientation = aspectRatio > 1.05 ? "landscape" : aspectRatio < 0.95 ? "portrait" : "square";

  const { data, info } = await sharp(bytes, { animated: false })
    .rotate()
    .resize(64, 64, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  let transparent = 0;
  let borderTransparent = 0;
  let border = 0;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let opaque = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = data[i + 3] ?? 255;
      const onBorder = x === 0 || y === 0 || x === w - 1 || y === h - 1;
      if (onBorder) border++;
      if (a < 16) {
        transparent++;
        if (onBorder) borderTransparent++;
        continue;
      }
      if (a < 128) continue;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const bucket = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      bucket.n++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      buckets.set(key, bucket);
      opaque++;
    }
  }
  const total = w * h;
  const isCutout =
    Boolean(meta.hasAlpha) &&
    transparent / Math.max(1, total) >= 0.05 &&
    borderTransparent / Math.max(1, border) >= 0.5;

  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  let covered = 0;
  let bucketsFor90 = 0;
  for (const bucket of sorted) {
    if (covered >= 0.9 * opaque) break;
    covered += bucket.n;
    bucketsFor90++;
  }
  // One entry per Turkish colour name (what is searched and shown), weighted average hex.
  const byName = new Map<string, { n: number; r: number; g: number; b: number }>();
  for (const bucket of sorted) {
    const name = colorName(bucket.r / bucket.n, bucket.g / bucket.n, bucket.b / bucket.n);
    const entry = byName.get(name) ?? { n: 0, r: 0, g: 0, b: 0 };
    entry.n += bucket.n;
    entry.r += bucket.r;
    entry.g += bucket.g;
    entry.b += bucket.b;
    byName.set(name, entry);
  }
  const hex = (v: number) =>
    Math.round(Math.max(0, Math.min(255, v)))
      .toString(16)
      .padStart(2, "0");
  const colors: AssetColor[] = [...byName.entries()]
    .map(([name, e]) => ({
      name,
      hex: `#${hex(e.r / e.n)}${hex(e.g / e.n)}${hex(e.b / e.n)}`,
      share: Math.round((e.n / Math.max(1, opaque)) * 1000) / 1000,
    }))
    .filter((c) => c.share >= 0.05)
    .sort((a, b) => b.share - a.share)
    .slice(0, 5);
  return {
    width,
    height,
    orientation,
    aspectRatio,
    isCutout,
    colors,
    bucketsFor90,
    topShare: (sorted[0]?.n ?? 0) / Math.max(1, opaque),
  };
}

/**
 * Logo-like: a few flat colours (a plain background plus one to three ink colours), or a cutout
 * that is mostly flat, with little text. Photos, even packshots, need many colour buckets.
 */
export function looksLikeLogo(facts: PictureFacts, text: string): boolean {
  if (text.length > 60) return false;
  if (facts.bucketsFor90 <= 4) return true;
  return facts.bucketsFor90 <= 6 && (facts.isCutout || facts.topShare >= 0.45);
}

/** Vision's labels → Turkish tags (best first, one per Turkish word). */
export function toTags(labels: readonly { identifier: string; confidence: number }[]): AssetTag[] {
  const out: AssetTag[] = [];
  const seen = new Set<string>();
  for (const label of [...labels].sort((a, b) => b.confidence - a.confidence)) {
    if (label.confidence < MIN_TAG_CONFIDENCE) continue;
    const tr = turkishLabel(label.identifier).slice(0, 100);
    if (seen.has(tr)) continue;
    seen.add(tr);
    out.push({
      id: label.identifier.slice(0, 100),
      label: tr,
      confidence: Math.round(label.confidence * 1000) / 1000,
    });
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// --- one picture ------------------------------------------------------------------------------

export interface AnalyzeOptions {
  signal?: AbortSignal;
  jobId?: string;
}

/** Write a Vision-friendly copy (upright PNG, long edge ≤ 2048) and return its path. */
async function visionCopy(stateDir: string, bytes: Uint8Array): Promise<string> {
  const dir = path.join(stateDir, "vision-tmp");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.png`);
  const png = await sharp(bytes, { animated: false })
    .rotate()
    .resize(ANALYSIS_EDGE, ANALYSIS_EDGE, { fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 3 })
    .toBuffer();
  await writeFile(file, png);
  return file;
}

async function aiCaption(
  deps: MediaAnalyzeDeps,
  bytes: Uint8Array,
  hints: { tags: AssetTag[]; text: string },
  options: AnalyzeOptions,
): Promise<string | null> {
  if (!deps.aiPolicy?.mediaCaptionsAllowed()) return null;
  const apiKey = getGeminiApiKey(deps.settings);
  if (!apiKey) return null;
  const small = await sharp(bytes, { animated: false })
    .rotate()
    .resize(768, 768, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  const res = await callGeminiJson({
    apiKey,
    modelId: deps.settings.geminiModels["gemini-flash-lite"],
    system:
      "Bir sosyal medya stüdyosunun görsel kütüphanesi için görseli Türkçe, tek cümleyle betimle (en çok 25 kelime): ne var, ortam, ışık. Görünen ürün ve marka yazılarını aynen yaz; emin olmadığın şeyi yazma. Yalnızca JSON döndür.",
    content: [
      {
        type: "text",
        text: `Vision etiketleri: ${hints.tags.map((t) => t.label).join(", ") || "yok"}. Okunan yazı: ${hints.text.slice(0, 300) || "yok"}.`,
      },
      { type: "inline", mimeType: "image/jpeg", data: new Uint8Array(small) },
    ],
    schema: {
      type: "object",
      properties: { caption: { type: "string" } },
      required: ["caption"],
    },
    effort: "low",
    ...(options.signal ? { signal: options.signal } : {}),
    ...(deps.geminiFetch ? { fetch: deps.geminiFetch } : {}),
    onUsage: geminiUsageSink(deps.aiUsage, { kind: "media", jobId: options.jobId }),
  });
  const caption = (res.output as { caption?: unknown } | null)?.caption;
  return typeof caption === "string" && caption.trim() ? caption.trim().slice(0, 500) : null;
}

/** What to store for one picture (never throws for a picture Vision cannot read: `failed`). */
export async function analyzePicture(
  deps: MediaAnalyzeDeps,
  bytes: Uint8Array,
  options: AnalyzeOptions = {},
): Promise<AssetAnalysisPut> {
  let facts: PictureFacts;
  try {
    facts = await pictureFacts(bytes);
  } catch {
    return {
      status: "failed",
      version: ASSET_ANALYSIS_VERSION,
      note: "Görsel çözülemedi (bozuk ya da desteklenmeyen dosya).",
    };
  }
  const base: AssetAnalysisPut = {
    status: "partial",
    version: ASSET_ANALYSIS_VERSION,
    colors: facts.colors,
    orientation: facts.orientation,
    aspectRatio: facts.aspectRatio,
    isCutout: facts.isCutout,
    isLogoLike: looksLikeLogo(facts, ""),
  };
  if (!(await deps.vision.available())) {
    return { ...base, note: `Etiket ve yazı okunamadı: ${VISION_HELPER_MISSING}` };
  }

  const file = await visionCopy(deps.stateDir, bytes);
  try {
    const { result, helperVersion } = await deps.vision.analyze(
      file,
      ["classify", "ocr", "feature-print"],
      options.signal ? { signal: options.signal } : {},
    );
    const tags = toTags(result.classify?.labels ?? []);
    const text = (result.ocr?.lines ?? [])
      .filter((l) => l.confidence >= MIN_TEXT_CONFIDENCE)
      .map((l) => l.text)
      .join("\n")
      .slice(0, 4000);
    const failedParts = Object.keys(result.errors ?? {});
    let caption: string | null = null;
    let captionNote: string | null = null;
    try {
      caption = await aiCaption(deps, bytes, { tags, text }, options);
    } catch (error) {
      captionNote = `Yapay zekâ açıklaması yazılamadı: ${(error as Error).message}`.slice(0, 300);
      deps.logger.warn(`media caption failed: ${(error as Error).message}`);
    }
    const notes = [
      failedParts.length > 0 ? `Okunamayan kısım: ${failedParts.join(", ")}.` : null,
      captionNote,
    ].filter(Boolean);
    return {
      ...base,
      status: failedParts.length === 0 ? "complete" : "partial",
      tags,
      text,
      isLogoLike: looksLikeLogo(facts, text),
      caption,
      featurePrint: result.featurePrint
        ? {
            revision: result.featurePrint.revision,
            count: result.featurePrint.count,
            data: result.featurePrint.data,
          }
        : null,
      note: notes.length > 0 ? notes.join(" ").slice(0, 500) : null,
      helperVersion: helperVersion.slice(0, 40),
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof VisionHelperError && error.code === "unreadable_image") {
      return { ...base, status: "failed", note: "Vision görseli okuyamadı." };
    }
    // The helper itself failed (timeout, crash): keep what sharp saw, try again later.
    deps.logger.warn(`studio-vision analyze failed: ${(error as Error).message}`);
    return {
      ...base,
      note: `Etiket ve yazı okunamadı: ${(error as Error).message}`.slice(0, 500),
    };
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

/** Read and store one asset; returns the stored status. */
export async function analyzeAsset(
  deps: MediaAnalyzeDeps,
  asset: Pick<Asset, "id">,
  options: AnalyzeOptions = {},
): Promise<AssetAnalysisPut["status"]> {
  let bytes: Uint8Array;
  try {
    bytes = (
      await deps.api.downloadAsset(asset.id, {
        maxBytes: deps.settings.imageMaxBytes,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    ).bytes;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Gone or too large: record it so it is not picked again.
    if (error instanceof ApiError && (error.status === 404 || error.status === 413)) {
      const analysis: AssetAnalysisPut = {
        status: "failed",
        version: ASSET_ANALYSIS_VERSION,
        note:
          error.status === 413 ? "Dosya okunamayacak kadar büyük." : "Dosyanın içeriği bulunamadı.",
      };
      await deps.api.client.workerAssets.putAnalysis(asset.id, analysis, {
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return "failed";
    }
    throw error;
  }
  const analysis = await analyzePicture(deps, bytes, options);
  await deps.api.client.workerAssets.putAnalysis(asset.id, analysis, {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return analysis.status;
}

// --- the job ----------------------------------------------------------------------------------

const BATCH = 10;
/**
 * Pictures per job: a long backfill hands its worker slot back between jobs (the next one is
 * queued at low priority, behind the owner's work).
 */
const MAX_PER_JOB = 150;

export function createMediaAnalyzeHandler(deps: MediaAnalyzeDeps) {
  return defineHandler({
    payload: MediaAnalyzePayload,
    run: async (payload, ctx: JobContext) => {
      const brandId = ctx.job.brandId;
      const withHelper = await deps.vision.available();
      // Partial analyses are redone only by a worker that can do better.
      const includePartial = payload.includePartial && withHelper;
      const attempted = new Set<string>();
      const counts = { complete: 0, partial: 0, failed: 0, errors: 0 };
      let more = false;
      ctx.progress(0.02, "Görseller okunuyor");
      for (;;) {
        ctx.signal.throwIfAborted();
        const { items } = await deps.api.client.workerAssets.pending(
          {
            ...(brandId ? { brandId } : {}),
            limit: BATCH,
            ...(includePartial ? { includePartial: "true" } : {}),
          },
          { signal: ctx.signal },
        );
        const fresh = items.filter((a) => !attempted.has(a.id));
        if (fresh.length === 0) break;
        if (attempted.size >= MAX_PER_JOB) {
          more = true;
          break;
        }
        for (const asset of fresh) {
          ctx.signal.throwIfAborted();
          attempted.add(asset.id);
          try {
            const status = await analyzeAsset(deps, asset, {
              signal: ctx.signal,
              jobId: ctx.jobId,
            });
            counts[status]++;
          } catch (error) {
            if (ctx.signal.aborted) throw error;
            counts.errors++;
            deps.logger.warn(
              `[job ${ctx.jobId}] media analysis of ${asset.id} failed: ${(error as Error).message}`,
            );
          }
          const done = attempted.size;
          ctx.progress(Math.min(0.95, 0.05 + done / (done + BATCH)), `${done} görsel okundu`);
        }
      }
      const total = counts.complete + counts.partial + counts.failed;
      let continuedIn: string | null = null;
      if (more) {
        const next = await deps.api.client.assets
          .backfillAnalysis(
            { ...(brandId ? { brandId } : {}), includePartial },
            { signal: ctx.signal },
          )
          .catch(() => null);
        continuedIn = next?.jobId ?? null;
      }
      ctx.progress(1, total === 0 ? "Okunacak görsel yok" : `${total} görsel etiketlendi`);
      return {
        ...(continuedIn ? { continuedIn } : {}),
        analyzed: total,
        complete: counts.complete,
        partial: counts.partial,
        failed: counts.failed,
        errors: counts.errors,
        visionHelper: withHelper,
        ...(withHelper ? {} : { note: `Etiket ve yazı okunamadı: ${VISION_HELPER_MISSING}` }),
      };
    },
  });
}
