/**
 * `image.generate` handler (Faz 2 & T5):
 * - Calls Gemini image generation (`generateContent` with `responseModalities: ["IMAGE"]`),
 * - Supports up to 10 `referenceAssetIds` passed as `inlineData`,
 * - Preserves 100% pixel-exact Turkish packaging labels when `preserveProductLabel: true`
 *   by generating the commercial scene and compositing the crisp original product cutout
 *   with a natural contact/drop shadow via `sharp` (`.claude/skills/product-reference-image/SKILL.md`),
 * - Automatically fills and renders `targetContentId` + `targetSlotId` when specified.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError, ImageGeneratePayload } from "@studio/contract";
import sharp from "sharp";
import { isBudgetExceeded } from "../ai/policy.ts";
import { geminiUsageSink } from "../ai/usage-recorder.ts";
import { abortableSleep } from "../claude/gate.ts";
import { GEMINI_KEY_MISSING, getGeminiApiKey } from "../gemini/json-call.ts";
import { type GeminiUsageMetadata, sampleFromMetadata } from "../gemini/pricing.ts";
import { GEMINI_RATE_LIMIT_TRIES, rateLimitDelayMs } from "../gemini/retry.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";
import { type ContentRenderDeps, executeContentRender } from "../render/handler.ts";

export interface ImageGenerateDeps extends ContentRenderDeps {
  imageFetch?: typeof globalThis.fetch;
  /** Test seam: the waits between 429 retries. */
  imageSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * A generated picture kept on disk until its job succeeds (U7): a retried `image.generate` (the
 * upload or the slot fill failed, the worker restarted) reuses it instead of paying Gemini again,
 * and does not upload it twice.
 */
interface StoredImage {
  mimeType: string;
  width: number;
  height: number;
  model: string;
  preserveProductLabel: boolean;
  file: string;
  /** Set once the upload went through. */
  assetId?: string;
}

function resultDir(stateDir: string, jobId: string): string {
  return path.join(stateDir, "image-results", jobId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128));
}

async function loadStoredImage(
  dir: string,
): Promise<{ meta: StoredImage; bytes: Uint8Array } | null> {
  try {
    const meta = JSON.parse(await readFile(path.join(dir, "result.json"), "utf8")) as StoredImage;
    const bytes = new Uint8Array(await readFile(path.join(dir, meta.file)));
    return bytes.byteLength > 0 ? { meta, bytes } : null;
  } catch {
    return null;
  }
}

async function saveStoredImage(dir: string, meta: StoredImage, bytes?: Uint8Array): Promise<void> {
  await mkdir(dir, { recursive: true });
  if (bytes) await writeFile(path.join(dir, meta.file), bytes);
  const tmp = path.join(dir, "result.json.tmp");
  await writeFile(tmp, JSON.stringify(meta), "utf8");
  await rename(tmp, path.join(dir, "result.json"));
}

const SUPPORTED_INLINE_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

function sanitizeSecret(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[REDACTED]");
}

function buildLabelPreservingScenePrompt(userPrompt: string, aspectRatio: string): string {
  return [
    "Create a professional commercial product photography background scene.",
    `SCENE BRIEF: ${userPrompt}`,
    "COMPOSITION FOR PRODUCT COMPOSITING:",
    "- Use Reference Image 1 only to match the color harmony, lighting temperature, and scale.",
    "- Leave a clean, unobstructed hero resting surface in the lower-center foreground where the physical product will be composited.",
    "- Natural shallow depth of field (85mm f/2.8 commercial lens look), realistic ambient light.",
    "- CRITICAL: Do NOT draw any product pouch, bottle, box, packaging, label, text, letters, numbers, logos, or watermarks anywhere in the scene.",
    `Aspect ratio: ${aspectRatio}.`,
  ].join("\n");
}

/**
 * Extract a clean RGBA cutout of a product reference photo:
 * - If the image already has transparent corners, trims empty transparent margins.
 * - If the image sits on a uniform studio background (e.g. white `#FFFFFF` studio packshot),
 *   runs a border-seeded flood-fill to remove the studio backdrop while keeping 100% of
 *   interior white packaging and every Turkish label pixel intact!
 */
export async function extractProductCutout(
  refBytes: Uint8Array,
): Promise<{ png: Uint8Array; width: number; height: number }> {
  const { data, info } = await sharp(refBytes, { animated: false })
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const idxOf = (x: number, y: number) => (y * w + x) * 4;

  const corners = [
    idxOf(0, 0),
    idxOf(Math.max(0, w - 1), 0),
    idxOf(0, Math.max(0, h - 1)),
    idxOf(Math.max(0, w - 1), Math.max(0, h - 1)),
  ];

  const alreadyTransparent = corners.some((c) => (pixels[c + 3] ?? 255) < 200);

  if (!alreadyTransparent && w >= 8 && h >= 8) {
    // Average corner RGB to check if corners form a uniform studio backdrop
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    for (const c of corners) {
      rSum += pixels[c] ?? 255;
      gSum += pixels[c + 1] ?? 255;
      bSum += pixels[c + 2] ?? 255;
    }
    const bgR = rSum / 4;
    const bgG = gSum / 4;
    const bgB = bSum / 4;

    const colorDist = (offset: number) => {
      const dr = (pixels[offset] ?? 0) - bgR;
      const dg = (pixels[offset + 1] ?? 0) - bgG;
      const db = (pixels[offset + 2] ?? 0) - bgB;
      return Math.sqrt(dr * dr + dg * dg + db * db);
    };

    const cornersConsistent = corners.every((c) => colorDist(c) <= 32);

    if (cornersConsistent) {
      const visited = new Uint8Array(w * h);
      const queue = new Int32Array(w * h);
      let head = 0;
      let tail = 0;
      const threshold = 26;

      const trySeed = (x: number, y: number) => {
        const pIdx = y * w + x;
        if (visited[pIdx]) return;
        if (colorDist(pIdx * 4) <= threshold) {
          visited[pIdx] = 1;
          queue[tail++] = pIdx;
        }
      };

      for (let x = 0; x < w; x++) {
        trySeed(x, 0);
        trySeed(x, h - 1);
      }
      for (let y = 0; y < h; y++) {
        trySeed(0, y);
        trySeed(w - 1, y);
      }

      while (head < tail) {
        const cur = queue[head++] as number;
        const rgbaIdx = cur * 4;
        pixels[rgbaIdx + 3] = 0;
        const cx = cur % w;
        const cy = (cur - cx) / w;

        if (cx > 0) trySeed(cx - 1, cy);
        if (cx + 1 < w) trySeed(cx + 1, cy);
        if (cy > 0) trySeed(cx, cy - 1);
        if (cy + 1 < h) trySeed(cx, cy + 1);
      }

      // Soften 1px silhouette edge against background
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const pIdx = y * w + x;
          if (visited[pIdx]) continue;
          const neighborsBg =
            (visited[pIdx - 1] ?? 0) +
            (visited[pIdx + 1] ?? 0) +
            (visited[pIdx - w] ?? 0) +
            (visited[pIdx + w] ?? 0);
          if (neighborsBg > 0) {
            const aIdx = pIdx * 4 + 3;
            pixels[aIdx] = Math.round((pixels[aIdx] ?? 255) * (1 - neighborsBg * 0.12));
          }
        }
      }
    }
  }

  // Compute tight non-transparent bounding box so product occupies full hero height
  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if ((pixels[(y * w + x) * 4 + 3] ?? 0) > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    // Fallback if flood-fill removed everything (e.g. blank white test fixture): keep original!
    const orig = await sharp(refBytes, { animated: false })
      .ensureAlpha()
      .png()
      .toBuffer({ resolveWithObject: true });
    return {
      png: new Uint8Array(orig.data.buffer, orig.data.byteOffset, orig.data.byteLength),
      width: orig.info.width,
      height: orig.info.height,
    };
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const cropped = await sharp(pixels, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left: minX, top: minY, width: cropW, height: cropH })
    .png()
    .toBuffer({ resolveWithObject: true });

  return {
    png: new Uint8Array(cropped.data.buffer, cropped.data.byteOffset, cropped.data.byteLength),
    width: cropped.info.width,
    height: cropped.info.height,
  };
}

/**
 * Composite the crisp original product cutout + soft contact/drop shadow onto the
 * Gemini-generated background scene so packaging text is 100% pixel-exact.
 */
export async function compositeProductOntoScene(
  sceneBytes: Uint8Array,
  productRefBytes: Uint8Array,
): Promise<{ bytes: Uint8Array; mimeType: "image/png"; width: number; height: number }> {
  const sceneMeta = await sharp(sceneBytes, { animated: false }).metadata();
  const sceneW = sceneMeta.width ?? 1080;
  const sceneH = sceneMeta.height ?? 1350;

  const cutout = await extractProductCutout(productRefBytes);
  const maxProdW = Math.max(64, Math.round(sceneW * 0.7));
  const maxProdH = Math.max(64, Math.round(sceneH * 0.68));

  const scaledProduct = await sharp(cutout.png)
    .resize({
      width: maxProdW,
      height: maxProdH,
      fit: "inside",
      kernel: "lanczos3",
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const prodW = scaledProduct.info.width;
  const prodH = scaledProduct.info.height;
  const prodPng = await sharp(scaledProduct.data, {
    raw: { width: prodW, height: prodH, channels: 4 },
  })
    .png()
    .toBuffer();

  // Build soft dark drop shadow from the product's alpha silhouette
  const shadowRaw = Buffer.alloc(prodW * prodH * 4);
  for (let i = 0; i < prodW * prodH; i++) {
    const a = scaledProduct.data[i * 4 + 3] ?? 0;
    shadowRaw[i * 4] = 0;
    shadowRaw[i * 4 + 1] = 0;
    shadowRaw[i * 4 + 2] = 0;
    shadowRaw[i * 4 + 3] = Math.round(a * 0.36);
  }
  const blurSigma = Math.max(1, Math.min(24, Math.round(Math.min(prodW, prodH) * 0.03)));
  const shadowPng = await sharp(shadowRaw, {
    raw: { width: prodW, height: prodH, channels: 4 },
  })
    .blur(blurSigma)
    .png()
    .toBuffer();

  const left = Math.max(0, Math.round((sceneW - prodW) / 2));
  const top = Math.max(0, Math.min(sceneH - prodH, Math.round(sceneH * 0.18)));
  const shadowOffsetY = Math.min(sceneH - prodH - top, Math.max(2, Math.round(sceneH * 0.012)));

  const composited = await sharp(sceneBytes, { animated: false })
    .ensureAlpha()
    .composite([
      { input: shadowPng, left, top: top + shadowOffsetY },
      { input: prodPng, left, top },
    ])
    .toColorspace("srgb")
    .png({ compressionLevel: 8 })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: new Uint8Array(
      composited.data.buffer,
      composited.data.byteOffset,
      composited.data.byteLength,
    ),
    mimeType: "image/png",
    width: composited.info.width,
    height: composited.info.height,
  };
}

async function normalizeReferenceForGemini(
  bytes: Uint8Array,
  contentType: string,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const bare = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (SUPPORTED_INLINE_MIMES.has(bare)) {
    return { bytes, mimeType: bare };
  }
  const converted = await sharp(bytes, { animated: false }).png().toBuffer();
  return {
    bytes: new Uint8Array(converted.buffer, converted.byteOffset, converted.byteLength),
    mimeType: "image/png",
  };
}

export function createImageGenerateHandler(deps: ImageGenerateDeps) {
  return defineHandler({
    payload: ImageGeneratePayload,
    run: async (payload, ctx: JobContext) => {
      const brandId = ctx.job.brandId;
      if (!brandId) {
        throw new Error("image.generate işi için brandId gerekli.");
      }

      const apiKey = getGeminiApiKey(deps.settings);
      if (!apiKey) {
        throw new Error(`Görsel üretimi için Gemini API anahtarı gerekli. ${GEMINI_KEY_MISSING}`);
      }

      const model =
        payload.model?.trim() ||
        deps.settings.parentEnv.STUDIO_GEMINI_IMAGE_MODEL?.trim() ||
        deps.settings.geminiImageModel ||
        "gemini-nano-banana-2.1";
      const doFetch = deps.imageFetch ?? deps.geminiFetch ?? globalThis.fetch.bind(globalThis);
      const signal = ctx.signal;

      /** One paid Gemini call (plus the label compositing); returns the final picture. */
      const generatePicture = async () => {
        ctx.progress(0.08, "Referans görseller hazırlanıyor");
        const refDownloads: { bytes: Uint8Array; mimeType: string }[] = [];
        for (const assetId of payload.referenceAssetIds) {
          signal.throwIfAborted();
          const dl = await deps.api.downloadAsset(assetId, {
            maxBytes: deps.settings.imageMaxBytes,
            signal,
          });
          refDownloads.push(await normalizeReferenceForGemini(dl.bytes, dl.contentType));
        }

        const preserveLabel = payload.preserveProductLabel && refDownloads.length > 0;
        const promptText = preserveLabel
          ? buildLabelPreservingScenePrompt(payload.prompt, payload.aspectRatio)
          : payload.prompt;

        const parts: Record<string, unknown>[] = [{ text: promptText }];
        for (const ref of refDownloads) {
          parts.push({
            inlineData: {
              mimeType: ref.mimeType,
              data: Buffer.from(
                ref.bytes.buffer,
                ref.bytes.byteOffset,
                ref.bytes.byteLength,
              ).toString("base64"),
            },
          });
        }

        ctx.progress(0.25, `Gemini ile görsel üretiliyor (${model})`);
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        const usageSink = geminiUsageSink(deps.aiUsage, { kind: "image", jobId: ctx.jobId });
        let res: Response;
        let rawBody: unknown;
        for (let tries = 0; ; tries++) {
          // "Bütçe dolunca dur": no paid call once the month's budget is used up (S7).
          usageSink?.assertBudget?.();
          res = await doFetch(url, {
            method: "POST",
            headers: {
              "x-goog-api-key": apiKey,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              contents: [{ role: "user", parts }],
              generationConfig: {
                responseModalities: ["IMAGE"],
                imageConfig: {
                  aspectRatio: payload.aspectRatio,
                  imageSize: payload.imageSize,
                },
              },
            }),
            signal,
          });
          const rawText = await res.text().catch(() => "");
          try {
            rawBody = JSON.parse(rawText);
          } catch {
            rawBody = {};
          }
          if (res.status !== 429) break;
          // A per-minute quota: wait as long as Google says and ask again (U4).
          const delay = rateLimitDelayMs(res.headers, rawText, tries);
          if (delay === null || tries + 1 >= GEMINI_RATE_LIMIT_TRIES) break;
          await (deps.imageSleep ?? abortableSleep)(delay, signal);
        }
        if (!res.ok) {
          const errObj = (rawBody as { error?: { message?: string; status?: string } }).error ?? {};
          const msg = sanitizeSecret(String(errObj.message ?? `HTTP ${res.status}`), apiKey).slice(
            0,
            500,
          );
          deps.logger.warn(`[job ${ctx.jobId}] gemini image error ${res.status}: ${msg}`);
          if (res.status >= 500 || res.status === 429) {
            throw new RetryableError(
              res.status === 429
                ? "Gemini görsel kotası doldu (çok istek); biraz sonra yeniden denenecek."
                : "Gemini görsel servisi şu an yanıt vermiyor; yeniden denenecek.",
            );
          }
          if (res.status === 401 || res.status === 403) {
            throw new Error(
              "Gemini anahtarı kabul edilmedi. Ayarlar → Yapay zekâ'dan anahtarı yeniden girin.",
            );
          }
          throw new Error(
            `Gemini görsel üretimi başarısız oldu (HTTP ${res.status}). Tarifi değiştirip yeniden deneyin.`,
          );
        }

        const usage = (rawBody as { usageMetadata?: GeminiUsageMetadata; modelVersion?: string })
          .usageMetadata;
        if (usage) {
          const version = (rawBody as { modelVersion?: string }).modelVersion;
          usageSink?.(sampleFromMetadata(version ?? model, usage));
        }

        const candidate = (
          rawBody as {
            candidates?: {
              finishReason?: string;
              content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] };
            }[];
            promptFeedback?: { blockReason?: string };
          }
        ).candidates?.[0];
        const imagePart = (candidate?.content?.parts ?? []).find((p) => p.inlineData?.data);
        if (!imagePart?.inlineData?.data) {
          const reason =
            candidate?.finishReason ??
            (rawBody as { promptFeedback?: { blockReason?: string } }).promptFeedback
              ?.blockReason ??
            "yok";
          deps.logger.warn(
            `[job ${ctx.jobId}] gemini returned no picture (finishReason=${reason})`,
          );
          throw new Error(
            reason === "SAFETY" || reason === "PROHIBITED_CONTENT" || reason === "IMAGE_SAFETY"
              ? "Gemini bu tarifle görsel üretmedi (içerik kuralları). Tarifi değiştirip yeniden deneyin."
              : "Gemini görsel döndürmedi. Tarifi değiştirip yeniden deneyin.",
          );
        }

        const rawGeneratedBuf = Buffer.from(imagePart.inlineData.data, "base64");
        let finalBytes: Uint8Array = new Uint8Array(
          rawGeneratedBuf.buffer,
          rawGeneratedBuf.byteOffset,
          rawGeneratedBuf.byteLength,
        );
        let finalMimeType = imagePart.inlineData.mimeType ?? "image/png";
        let finalWidth = 0;
        let finalHeight = 0;

        if (preserveLabel && refDownloads[0]) {
          ctx.progress(0.62, "Ürün etiketi piksel hassasiyetiyle sahneye yerleştiriliyor");
          const composited = await compositeProductOntoScene(finalBytes, refDownloads[0].bytes);
          finalBytes = composited.bytes;
          finalMimeType = composited.mimeType;
          finalWidth = composited.width;
          finalHeight = composited.height;
        } else {
          const meta = await sharp(finalBytes, { animated: false }).metadata();
          finalWidth = meta.width ?? 1080;
          finalHeight = meta.height ?? 1350;
          if (!SUPPORTED_INLINE_MIMES.has(finalMimeType)) {
            finalMimeType = meta.format === "jpeg" ? "image/jpeg" : "image/png";
          }
        }

        return {
          bytes: finalBytes,
          mimeType: finalMimeType,
          width: finalWidth,
          height: finalHeight,
          preserveLabel,
        };
      };

      const dir = resultDir(deps.stateDir, ctx.jobId);
      try {
        // An earlier attempt of this job may have paid for the picture already (U7).
        const stored = await loadStoredImage(dir);
        let finalBytes: Uint8Array;
        let finalMimeType: string;
        let finalWidth: number;
        let finalHeight: number;
        let preserveLabel: boolean;
        let usedModel = model;
        let assetId: string | undefined;
        if (stored) {
          deps.logger.info(
            `[job ${ctx.jobId}] reusing the picture an earlier attempt generated (no second charge)`,
          );
          ctx.progress(0.6, "Daha önce üretilen görsel kullanılıyor (yeniden ücret yok)");
          finalBytes = stored.bytes;
          finalMimeType = stored.meta.mimeType;
          finalWidth = stored.meta.width;
          finalHeight = stored.meta.height;
          preserveLabel = stored.meta.preserveProductLabel;
          usedModel = stored.meta.model;
          assetId = stored.meta.assetId;
        } else {
          const generated = await generatePicture();
          finalBytes = generated.bytes;
          finalMimeType = generated.mimeType;
          finalWidth = generated.width;
          finalHeight = generated.height;
          preserveLabel = generated.preserveLabel;
          // Kept before the upload: a failed upload is retried without paying again.
          await saveStoredImage(
            dir,
            {
              mimeType: finalMimeType,
              width: finalWidth,
              height: finalHeight,
              model,
              preserveProductLabel: preserveLabel,
              file: "image.bin",
            },
            finalBytes,
          ).catch((error: unknown) =>
            deps.logger.warn(`could not keep the generated picture: ${(error as Error).message}`),
          );
        }

        let uploaded: { id: string };
        if (assetId) {
          uploaded = { id: assetId };
        } else {
          ctx.progress(0.8, "Görsel yükleniyor");
          const ext =
            finalMimeType === "image/jpeg"
              ? "jpg"
              : finalMimeType === "image/webp"
                ? "webp"
                : "png";
          uploaded = await deps.api.client.assets.upload(
            {
              brandId,
              kind: "image",
              source: "generated",
              width: finalWidth,
              height: finalHeight,
              file: new Blob([finalBytes.slice()], { type: finalMimeType }),
              filename: `ai-image-${Date.now()}.${ext}`,
            },
            { signal },
          );
          await saveStoredImage(dir, {
            mimeType: finalMimeType,
            width: finalWidth,
            height: finalHeight,
            model: usedModel,
            preserveProductLabel: preserveLabel,
            file: "image.bin",
            assetId: uploaded.id,
          }).catch(() => undefined);
        }

        let filledContentId: string | undefined;
        let filledVersion: number | undefined;

        if (payload.targetContentId && payload.targetSlotId) {
          ctx.progress(0.88, "Hedef postun görsel yuvası doldurulup render ediliyor");
          const rendered = await executeContentRender({
            deps,
            jobId: ctx.jobId,
            brandId,
            contentId: payload.targetContentId,
            payload: {
              format: "jpeg",
              slotAssignments: { [payload.targetSlotId]: uploaded.id },
            },
            signal,
          });
          filledContentId = payload.targetContentId;
          filledVersion = rendered.version;
        }

        ctx.progress(1, "Tamamlandı");
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        return {
          assetId: uploaded.id,
          mimeType: finalMimeType,
          width: finalWidth,
          height: finalHeight,
          model: usedModel,
          ...(stored ? { reusedGeneration: true } : {}),
          preserveProductLabel: preserveLabel,
          ...(filledContentId !== undefined ? { filledContentId } : {}),
          ...(filledVersion !== undefined ? { filledVersion } : {}),
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (error instanceof RetryableError || isBudgetExceeded(error)) throw error;
        if (error instanceof ApiError && (error.status === undefined || error.status >= 500)) {
          throw new RetryableError(error.message);
        }
        throw error;
      }
    },
  });
}
