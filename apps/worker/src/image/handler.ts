/**
 * `image.generate` handler (Faz 2 & T5, U9):
 * - Calls Gemini image generation (`generateContent` with `responseModalities: ["IMAGE"]`),
 * - Supports up to 10 `referenceAssetIds` passed as `inlineData`,
 * - `preserveProductLabel: true` (U9): the label is read first, the model draws only the scene,
 *   the real product is cut out (Apple Vision on this Mac), placed and composited pixel for pixel,
 *   then the label is read again on the final picture and compared (`label-pipeline.ts`). A label
 *   that reads differently or not at all is reported and the picture is not put into a post,
 * - Fills and renders `targetContentId` + `targetSlotId` when specified,
 * - Tags the new picture for the library (N12) right away.
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
import { analyzePicture } from "../vision/analyze.ts";
import { missingVisionHelper } from "../vision/helper.ts";
import {
  buildLabelPreservingScenePrompt,
  DEFAULT_PRODUCT_SCALE,
  type PlacedPosition,
  removeDir,
} from "./compose.ts";
import {
  labelBlocksDelivery,
  type PreparedProduct,
  placeAndVerify,
  placementSummary,
  prepareProduct,
} from "./label-pipeline.ts";

export { buildLabelPreservingScenePrompt, extractProductCutout } from "./compose.ts";

export interface ImageGenerateDeps extends ContentRenderDeps {
  imageFetch?: typeof globalThis.fetch;
  /** Test seam: the waits between 429 retries. */
  imageSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What the label-preserving steps reported (kept with the stored picture, U7). */
interface LabelReport {
  labelCheck: {
    status: string;
    message: string;
    source: string;
    expected: string[];
    missing: string[];
    found: string[];
    score: number;
  };
  placement: Record<string, unknown>;
  cutout: string;
  notes: string[];
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
  label?: LabelReport;
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
  const vision = deps.vision ?? missingVisionHelper();
  const pipelineDeps = { vision, stateDir: deps.stateDir, logger: deps.logger };

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
        const requestedPosition: PlacedPosition | undefined =
          payload.productPosition && payload.productPosition !== "auto"
            ? payload.productPosition
            : undefined;
        let product: PreparedProduct | null = null;
        try {
          if (preserveLabel && refDownloads[0]) {
            // U9 steps 1–2 before paying: read the label, cut the product out.
            ctx.progress(0.14, "Ürün etiketi okunuyor ve ürün arka plandan ayrılıyor");
            product = await prepareProduct(
              pipelineDeps,
              refDownloads[0].bytes,
              payload.labelText,
              signal,
            );
          }
          const promptText =
            preserveLabel && product
              ? buildLabelPreservingScenePrompt(payload.prompt, payload.aspectRatio, {
                  position: requestedPosition ?? "bottom-center",
                  scale: payload.productScale ?? DEFAULT_PRODUCT_SCALE,
                  labelLines: product.expected,
                })
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
            const errObj =
              (rawBody as { error?: { message?: string; status?: string } }).error ?? {};
            const msg = sanitizeSecret(
              String(errObj.message ?? `HTTP ${res.status}`),
              apiKey,
            ).slice(0, 500);
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
          const generated = new Uint8Array(
            rawGeneratedBuf.buffer,
            rawGeneratedBuf.byteOffset,
            rawGeneratedBuf.byteLength,
          );

          if (preserveLabel && product) {
            // U9 steps 4–6: place the real product, composite, read the label back.
            ctx.progress(0.62, "Gerçek ürün sahneye yerleştiriliyor ve etiket kontrol ediliyor");
            const placed = await placeAndVerify(
              pipelineDeps,
              generated,
              product,
              { position: payload.productPosition, scale: payload.productScale },
              signal,
            );
            const label: LabelReport = {
              labelCheck: {
                status: placed.labelCheck.status,
                message: placed.labelCheck.message,
                source: placed.labelCheck.source,
                expected: placed.labelCheck.expected.slice(0, 40),
                missing: placed.labelCheck.missing.slice(0, 40),
                found: placed.labelCheck.found.slice(0, 60),
                score: placed.labelCheck.score,
              },
              placement: {
                ...placed.placement,
                summary: placementSummary(placed.placement),
                light: placed.light,
              },
              cutout: product.cutout.method,
              notes: [...product.notes, ...placed.notes],
            };
            return {
              bytes: placed.bytes,
              mimeType: placed.mimeType as string,
              width: placed.width,
              height: placed.height,
              preserveLabel,
              label,
            };
          }
          const meta = await sharp(generated, { animated: false }).metadata();
          let mimeType = imagePart.inlineData.mimeType ?? "image/png";
          if (!SUPPORTED_INLINE_MIMES.has(mimeType)) {
            mimeType = meta.format === "jpeg" ? "image/jpeg" : "image/png";
          }
          return {
            bytes: generated,
            mimeType,
            width: meta.width ?? 1080,
            height: meta.height ?? 1350,
            preserveLabel,
            label: undefined,
          };
        } finally {
          if (product) await removeDir(product.workDir);
        }
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
        let label: LabelReport | undefined;
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
          label = stored.meta.label;
          usedModel = stored.meta.model;
          assetId = stored.meta.assetId;
        } else {
          const generated = await generatePicture();
          finalBytes = generated.bytes;
          finalMimeType = generated.mimeType;
          finalWidth = generated.width;
          finalHeight = generated.height;
          preserveLabel = generated.preserveLabel;
          label = generated.label;
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
              ...(label ? { label } : {}),
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
            ...(label ? { label } : {}),
          }).catch(() => undefined);
          // N12: tag the new picture for the library now (best effort; a backfill retries).
          try {
            const analysis = await analyzePicture({ ...deps, vision }, finalBytes, {
              signal,
              jobId: ctx.jobId,
            });
            await deps.api.client.workerAssets.putAnalysis(uploaded.id, analysis, { signal });
          } catch (error) {
            if (signal.aborted) throw error;
            deps.logger.warn(
              `[job ${ctx.jobId}] tagging the new picture failed: ${(error as Error).message}`,
            );
          }
        }

        let filledContentId: string | undefined;
        let filledVersion: number | undefined;
        const blocked = label ? labelBlocksDelivery(label.labelCheck) : false;
        const notes = [...(label?.notes ?? [])];

        if (payload.targetContentId && payload.targetSlotId) {
          if (blocked) {
            // Never put a picture whose label reads differently into a post without the owner.
            notes.push(
              "Etiket doğrulanamadığı için görsel posta yerleştirilmedi; Medya'da duruyor. Kontrol edip uygunsa yuvaya elle yerleştirin.",
            );
          } else {
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
        }

        ctx.progress(
          1,
          label && label.labelCheck.status !== "ok"
            ? `Tamamlandı · ${label.labelCheck.status === "skipped" || label.labelCheck.status === "no_label" ? "etiket doğrulanamadı" : "etiket uyuşmuyor, kontrol edin"}`
            : "Tamamlandı",
        );
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        return {
          assetId: uploaded.id,
          mimeType: finalMimeType,
          width: finalWidth,
          height: finalHeight,
          model: usedModel,
          ...(stored ? { reusedGeneration: true } : {}),
          preserveProductLabel: preserveLabel,
          ...(label
            ? {
                labelCheck: label.labelCheck,
                placement: label.placement,
                cutout: label.cutout,
              }
            : {}),
          ...(notes.length > 0 ? { notes } : {}),
          ...(blocked && payload.targetContentId ? { slotSkipped: true } : {}),
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
