import { z } from "zod";
import { EntityId } from "./common.ts";
import { ARTBOARDS, type ContentType } from "./content.ts";

/*
 * Post production choices shared by every engine (docs/URETIM-RESIM.md, Faz 0).
 *
 * The owner picks the engine that designs a post: `wecra` (Wecra's canvas tools), `html` (the
 * HTML/CSS pipeline), `svg` (vector, written by the agent) or `code` (Python in a closed
 * sandbox). Every engine delivers the same thing (1080×1350 pictures, caption + hashtags, the
 * engine's source). `html` and `wecra` are ready; the others fail clearly instead of falling back.
 */

export const GenerationEngine = z
  .enum(["wecra", "html", "svg", "code"])
  .meta({ id: "GenerationEngine" });
export type GenerationEngine = z.infer<typeof GenerationEngine>;

/** Used when neither the request nor the brand names an engine. */
export const DEFAULT_GENERATION_ENGINE: GenerationEngine = "html";

/** Engines that run today. */
export const READY_GENERATION_ENGINES: readonly GenerationEngine[] = ["wecra", "html"];

/** What the owner sees when a not-yet-ready engine is asked for. */
export const ENGINE_NOT_READY_MESSAGE = "Bu motor henüz hazır değil";

export const GENERATION_ENGINE_LABELS: Record<GenerationEngine, string> = {
  wecra: "Wecra",
  html: "HTML",
  svg: "SVG",
  code: "Kod",
};

export function isEngineReady(engine: GenerationEngine): boolean {
  return READY_GENERATION_ENGINES.includes(engine);
}

/** `Bu motor henüz hazır değil (SVG)` for a not-ready engine, null for a ready one. */
export function engineNotReadyError(engine: GenerationEngine): string | null {
  return isEngineReady(engine)
    ? null
    : `${ENGINE_NOT_READY_MESSAGE} (${GENERATION_ENGINE_LABELS[engine]})`;
}

/** "Kare format" / "1:1" / "1080x1080" / "square" in a brief: the owner asked for a square post. */
const SQUARE_ASKED =
  /(?<![\p{L}\p{N}])(?:kare\s+(?:format|boyut|ölçü|post|görsel|tasarım)\p{L}*|1\s*:\s*1|1080\s*[x×]\s*1080|square)(?![\p{L}\p{N}])/iu;

/**
 * The slide size of a post designed on a blank canvas (the Wecra engine, "Boş tuvalden yeni
 * post"): a story is 1080×1920, a feed post 1080×1350 — or 1080×1080 when the brief asks for a
 * square one.
 */
export function canvasFormatFor(type: ContentType, text = ""): { width: number; height: number } {
  if (type === "story" || type === "reel") return { ...ARTBOARDS.vertical };
  return SQUARE_ASKED.test(text) ? { ...ARTBOARDS.square } : { ...ARTBOARDS.portrait };
}

/** At most this many variants of one post / picture per request (each picture is paid). */
export const MAX_GENERATION_VARIANTS = 4;

export const GenerationVariants = z.number().int().min(1).max(MAX_GENERATION_VARIANTS);

// --- approval requests (approval.ts has the records and the API) ----------------------------

export const ApprovalKind = z
  .enum(["product_image", "variant", "product_photo_upgrade"])
  .meta({ id: "ApprovalKind" });
export type ApprovalKind = z.infer<typeof ApprovalKind>;

/**
 * Attached to a generation job's payload so its result becomes an approval request (the worker
 * reads it when the job finishes and calls `POST /api/worker/approvals`).
 */
export const ApprovalTarget = z
  .object({
    kind: ApprovalKind,
    conversationId: EntityId.optional(),
    messageId: EntityId.optional(),
    contentId: EntityId.optional(),
    productId: EntityId.optional(),
    slotId: z.string().max(128).optional(),
    replacesAssetId: EntityId.optional(),
    /** The request "Yeniden üret" replaced. */
    supersedesId: EntityId.optional(),
  })
  .meta({ id: "ApprovalTarget" });
export type ApprovalTarget = z.infer<typeof ApprovalTarget>;
