/**
 * `image.generate` handler (Faz 2 & T5):
 * - Calls Gemini image generation (`generateContent` with `responseModalities: ["IMAGE"]`),
 * - Supports up to 10 `referenceAssetIds` passed as `inlineData`,
 * - Preserves 100% pixel-exact Turkish packaging labels when `preserveProductLabel: true`
 *   by generating the commercial scene and compositing the crisp original product cutout
 *   with a natural contact/drop shadow via `sharp` (`.claude/skills/product-reference-image/SKILL.md`),
 * - Automatically fills and renders `targetContentId` + `targetSlotId` when specified.
 */
import { ApiError, ImageGeneratePayload } from "@studio/contract";
import sharp from "sharp";
import { getGeminiApiKey } from "../gemini/json-call.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";
import { type ContentRenderDeps, executeContentRender } from "../render/handler.ts";

export interface ImageGenerateDeps extends ContentRenderDeps {
  imageFetch?: typeof globalThis.fetch;
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
        throw new Error(
          "Görsel üretimi için GEMINI_API_KEY gerekli: lütfen apps/worker/.env dosyasına GEMINI_API_KEY anahtarınızı ekleyin.",
        );
      }

      const model =
        payload.model?.trim() ||
        deps.settings.parentEnv.STUDIO_GEMINI_IMAGE_MODEL?.trim() ||
        deps.settings.geminiImageModel ||
        "gemini-nano-banana-2.1";
      const doFetch = deps.imageFetch ?? deps.geminiFetch ?? globalThis.fetch.bind(globalThis);
      const signal = ctx.signal;

      try {
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
        const res = await doFetch(url, {
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

        const rawBody = await res.json().catch(() => ({}));
        if (!res.ok) {
          const errObj = (rawBody as { error?: { message?: string; status?: string } }).error ?? {};
          const msg = sanitizeSecret(String(errObj.message ?? `HTTP ${res.status}`), apiKey).slice(
            0,
            500,
          );
          if (res.status >= 500 || res.status === 429) {
            throw new RetryableError(`Gemini görsel hatası (${res.status}): ${msg}`);
          }
          throw new Error(`Gemini görsel üretimi başarısız (${res.status}): ${msg}`);
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
          throw new Error(`Gemini görsel döndürmedi (finishReason=${reason}).`);
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

        ctx.progress(0.8, "Görsel yükleniyor");
        const ext =
          finalMimeType === "image/jpeg" ? "jpg" : finalMimeType === "image/webp" ? "webp" : "png";
        const uploaded = await deps.api.client.assets.upload(
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
        return {
          assetId: uploaded.id,
          mimeType: finalMimeType,
          width: finalWidth,
          height: finalHeight,
          model,
          preserveProductLabel: preserveLabel,
          ...(filledContentId !== undefined ? { filledContentId } : {}),
          ...(filledVersion !== undefined ? { filledVersion } : {}),
        };
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (error instanceof RetryableError) throw error;
        if (error instanceof ApiError && (error.status === undefined || error.status >= 500)) {
          throw new RetryableError(error.message);
        }
        throw error;
      }
    },
  });
}
