/**
 * The HTML design's "AI görsel" slot filled through the product-image line (docs/URETIM-RESIM.md,
 * Faz 1). A post made with an `ai_generate` image slot leaves that slot empty in its design;
 * when the owner consented to the paid picture (the chat's consent card → `slotImage` in the
 * `content.generate` payload), the worker queues one `image.generate` job per empty slot once the
 * design version is stored: the products' photos for the asked side (or a scene without a
 * product), the style (the brand's `imageStylePreset` unless asked otherwise) and an approval
 * target (`product_image`, the post, the slot, the chat). The picture then goes through the exact
 * description → generation → AI check → approval card in the chat, and fills the slot only when
 * the owner approves (`POST /api/approvals/{id}/approve` renders the slot). Never without
 * `slotImage.consented`; a retried generation job never queues (pays) a slot twice.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ApiError,
  type ApprovalTarget,
  type ContentGenerateJobInput,
  type ImageGeneratePayloadInput,
  productPhotoAngle,
  type SlotImageRequest,
} from "@studio/contract";
import { parseSlide } from "@studio/design-kit/document";
import type { StudioApi } from "../api.ts";
import { type ProductPhotoRef, selectProductReferences } from "../image/references.ts";
import type { Logger } from "../log.ts";

/** Most slots of one post filled this way (the design asks for exactly one AI slot). */
export const MAX_SLOT_IMAGES = 3;
/** Most reference photos one picture takes (Gemini's limit is 10). */
const MAX_REFERENCES = 10;

export interface EmptyImageSlot {
  /** 0-based slide the slot is on. */
  slide: number;
  /** The slot's layer id (`data-layer`): the approval's `slotId`. */
  slotId: string;
  /** `data-slot-ratio` (w:h), null when missing. */
  ratio: { w: number; h: number } | null;
  label: string | null;
}

/** The empty image slots of a design, in slide order (at most MAX_SLOT_IMAGES). */
export function emptyImageSlots(slides: ReadonlyArray<{ html: string }>): EmptyImageSlot[] {
  const out: EmptyImageSlot[] = [];
  const seen = new Set<string>();
  for (const [slide, s] of slides.entries()) {
    let layers: ReturnType<typeof parseSlide>["model"]["layers"];
    try {
      layers = parseSlide(s.html).model.layers;
    } catch {
      continue;
    }
    for (const layer of layers) {
      if (layer.type !== "slot" || layer.image || layer.state === "filled") continue;
      // A slot id is per slide; the same id on two slides is one assignment (filled on both).
      if (seen.has(layer.id)) continue;
      seen.add(layer.id);
      out.push({ slide, slotId: layer.id, ratio: layer.ratio, label: layer.label ?? null });
      if (out.length >= MAX_SLOT_IMAGES) return out;
    }
  }
  return out;
}

/** The picture's aspect ratio for a slot: the closest one the image model makes. */
export function aspectRatioForSlot(
  ratio: { w: number; h: number } | null,
): ImageGeneratePayloadInput["aspectRatio"] {
  if (!ratio || ratio.w <= 0 || ratio.h <= 0) return "4:5";
  const r = ratio.w / ratio.h;
  const options: Array<[NonNullable<ImageGeneratePayloadInput["aspectRatio"]>, number]> = [
    ["4:5", 4 / 5],
    ["9:16", 9 / 16],
    ["1:1", 1],
  ];
  let best = options[0] as (typeof options)[number];
  for (const o of options) {
    if (Math.abs(Math.log(r / o[1])) < Math.abs(Math.log(r / best[1]))) best = o;
  }
  return best[0];
}

/** What the picture shows: the asked scene, else the post's image brief, else its topic. */
export function slotImagePrompt(input: {
  request: SlotImageRequest;
  imageBrief?: string | null | undefined;
  title?: string | null | undefined;
  brief?: string | null | undefined;
  productNames: readonly string[];
}): string {
  const scene =
    input.request.prompt?.trim() ||
    input.imageBrief?.trim() ||
    [input.title?.trim(), input.brief?.trim()].filter(Boolean).join(": ") ||
    "Markanın postu için bir sahne";
  const subject =
    input.productNames.length > 0
      ? `Ürün: ${input.productNames.join(", ")} (referans fotoğraflardaki gibi, birebir).`
      : "Ürün yok: briefin anlattığı sahne ya da illüstrasyon.";
  const usage =
    "Bu görsel bir sosyal medya postunun görsel alanına yerleşecek; postun yazıları tasarımda ayrı duruyor: " +
    (input.productNames.length > 0
      ? "görsele ürünün kendi etiketi dışında yazı, logo ya da metin ekleme."
      : "görsele yazı, logo ya da metin ekleme.");
  return [scene.slice(0, 3_000), subject, usage].join("\n").slice(0, 4_000);
}

export interface SlotImageJob {
  slotId: string;
  jobId: string;
}

export interface SlotImageOutcome {
  /** One job per filled slot (an earlier attempt's jobs included). */
  jobs: SlotImageJob[];
  /** Why nothing (more) was queued; Turkish, for the chat agent. */
  note: string;
}

export interface SlotImageDeps {
  api: StudioApi;
  logger: Logger;
  stateDir: string;
}

/**
 * Queue the slot pictures of a stored design version (see the module comment). Never throws for
 * a picture that cannot be queued (the post itself is done): the outcome's note says why.
 */
export async function queueSlotImageJobs(
  deps: SlotImageDeps,
  input: {
    /** The `content.generate` job (the idempotency key). */
    jobId: string;
    payload: ContentGenerateJobInput;
    slides: ReadonlyArray<{ html: string }>;
    /** The image slot the design was made with (the payload's, else what the media decided). */
    imageSlot: string;
    signal: AbortSignal;
  },
): Promise<SlotImageOutcome | null> {
  const { payload, signal } = input;
  const request = payload.slotImage;
  // Consent is the gate: no field (or no `consented: true`), no paid picture.
  if (request?.consented !== true) return null;
  if (input.imageSlot !== "ai_generate") {
    return { jobs: [], note: "Bu tasarımda AI görsel yuvası istenmedi; görsel üretilmedi." };
  }
  const conversationId = request.conversationId ?? payload.conversationId;
  const jobs: SlotImageJob[] = [];
  try {
    const slots = emptyImageSlots(input.slides);
    if (slots.length === 0) {
      return {
        jobs: [],
        note: "Tasarımda boş görsel yuvası bulunamadı; görsel üretilmedi (ücret yok).",
      };
    }

    // The products and the photos that show the asked side.
    const productIds = [...new Set(request.productIds ?? [])].slice(0, 4);
    const names: string[] = [];
    const referenceAssetIds: string[] = [];
    const firstPrompt = slotImagePrompt({
      request,
      imageBrief: payload.imageBrief,
      title: payload.title,
      brief: payload.brief,
      productNames: [],
    });
    for (const id of productIds) {
      let product: Awaited<ReturnType<StudioApi["client"]["brandProducts"]["get"]>>;
      try {
        product = await deps.api.client.brandProducts.get(payload.brandId, id, { signal });
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ApiError && error.status === 404) {
          return { jobs: [], note: "Görseli istenen ürün bulunamadı; görsel üretilmedi." };
        }
        throw error;
      }
      const photos = await productPhotos(deps.api, product.imageAssetIds, signal);
      if (photos.length === 0) {
        return {
          jobs: [],
          note: `"${product.name}" ürününün fotoğrafı yok; görsel üretilmedi. Ürüne fotoğraf ekleyip generate_ai_image ile yuvayı doldurabilirsin.`,
        };
      }
      names.push(product.name);
      const choice = selectProductReferences(photos, {
        prompt: firstPrompt,
        view: request.view ?? null,
      });
      for (const assetId of choice.assetIds) {
        if (referenceAssetIds.length < MAX_REFERENCES && !referenceAssetIds.includes(assetId)) {
          referenceAssetIds.push(assetId);
        }
      }
    }

    const ledger = await readLedger(deps.stateDir, input.jobId);
    const variants = payload.variants ?? 1;
    for (const slot of slots) {
      const earlier = ledger[slot.slotId];
      if (earlier) {
        jobs.push({ slotId: slot.slotId, jobId: earlier });
        continue;
      }
      const approval: ApprovalTarget = {
        kind: "product_image",
        contentId: payload.contentId,
        slotId: slot.slotId,
        ...(conversationId ? { conversationId } : {}),
        ...(productIds[0] ? { productId: productIds[0] } : {}),
      };
      const imagePayload: ImageGeneratePayloadInput = {
        prompt: slotImagePrompt({
          request,
          imageBrief: payload.imageBrief,
          title: payload.title,
          brief: payload.brief,
          productNames: names,
        }),
        aspectRatio: aspectRatioForSlot(slot.ratio),
        imageSize: "2K",
        referenceAssetIds,
        preserveProductLabel: false,
        ...(productIds.length > 0 ? { productIds } : {}),
        ...(request.style !== undefined ? { style: request.style } : {}),
        approval,
        // The post is one of N variants: its card says which ("Görsel geldi (2/3)").
        ...(variants > 1 && payload.variantIndex
          ? { variant: { index: payload.variantIndex, count: variants } }
          : {}),
      };
      const job = await deps.api.client.jobs.create(
        { type: "image.generate", brandId: payload.brandId, payload: imagePayload },
        { signal },
      );
      ledger[slot.slotId] = job.id;
      await writeLedger(deps.stateDir, input.jobId, ledger);
      jobs.push({ slotId: slot.slotId, jobId: job.id });
    }
    return {
      jobs,
      note:
        "AI görsel yuvası ürün görseli hattıyla üretiliyor (birebir tarif → üretim → yapay zekâ kontrolü). " +
        "Görsel hazır olunca kontrol raporuyla sohbete onay kartı düşer; yuva ancak onaylanınca dolar.",
    };
  } catch (error) {
    signal.throwIfAborted();
    deps.logger.warn(
      `[job ${input.jobId}] slot picture not queued: ${(error as Error).message ?? error}`,
    );
    return {
      jobs,
      note: "AI görsel işi kuyruğa alınamadı; yuva boş kaldı. generate_ai_image ile (targetContentId + targetSlotId) yeniden denenebilir.",
    };
  }
}

async function productPhotos(
  api: StudioApi,
  assetIds: readonly string[],
  signal: AbortSignal,
): Promise<ProductPhotoRef[]> {
  const out: ProductPhotoRef[] = [];
  for (const [position, assetId] of assetIds.entries()) {
    let asset: Awaited<ReturnType<StudioApi["client"]["assets"]["get"]>> | null;
    try {
      asset = await api.client.assets.get(assetId, { signal });
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ApiError && error.status === 404)) throw error;
      asset = null;
    }
    if (!asset || asset.deletedAt) continue;
    out.push({
      assetId,
      position,
      angleHint: productPhotoAngle(asset.originalFilename ?? null),
    });
  }
  return out;
}

// --- idempotency: the slots a generation job already queued -------------------------------------

function ledgerPath(stateDir: string, jobId: string): string {
  return path.join(stateDir, "slot-images", `${jobId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
}

async function readLedger(stateDir: string, jobId: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(ledgerPath(stateDir, jobId), "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (e): e is [string, string] => typeof e[1] === "string",
        ),
      );
    }
  } catch {
    // No ledger yet.
  }
  return {};
}

async function writeLedger(
  stateDir: string,
  jobId: string,
  ledger: Record<string, string>,
): Promise<void> {
  const file = ledgerPath(stateDir, jobId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(ledger), "utf8");
  await rename(tmp, file);
}
