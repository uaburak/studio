import { z } from "zod";
import { EntityId } from "./common.ts";
import { ARTBOARDS, type ContentType } from "./content.ts";

/*
 * Post production choices shared by every engine (docs/URETIM-RESIM.md, Faz 0).
 *
 * The owner picks the engine that designs a post: `wecra` (Wecra's canvas tools), `html` (the
 * HTML/CSS pipeline), `svg` (vector, written by the agent) or `code` (Python in a closed
 * sandbox). Every engine delivers the same thing (1080×1350 pictures, caption + hashtags, the
 * engine's source). All four run.
 */

export const GenerationEngine = z
  .enum(["wecra", "html", "svg", "code"])
  .meta({ id: "GenerationEngine" });
export type GenerationEngine = z.infer<typeof GenerationEngine>;

/** Used when neither the request nor the brand names an engine. */
export const DEFAULT_GENERATION_ENGINE: GenerationEngine = "html";

/** Engines that run today. */
export const READY_GENERATION_ENGINES: readonly GenerationEngine[] = [
  "wecra",
  "html",
  "svg",
  "code",
];

/**
 * The SVG engine stores each slide as an HTML document around one inline `<svg>` (the engine's
 * source), marked `<html data-studio-engine="svg">`. Such a version is edited only from the chat
 * (`revise_post` revises the SVG), never on the canvas.
 */
export const SVG_SLIDE_ATTR = "data-studio-engine";

/** A slide made by the SVG engine (its HTML carries the engine mark on `<html>`). */
export function isSvgSlideHtml(html: string | null | undefined): boolean {
  return typeof html === "string" && /<html\b[^>]*\sdata-studio-engine=["']?svg\b/i.test(html);
}

/**
 * The code engine (Faz 4) stores each slide as a small HTML document that shows the slide's
 * render (`<img src="/media/<assetId>.jpg">`), marked `<html data-studio-engine="code">`. Its
 * `<meta name="studio:code-*">` tags carry the engine's source: the Python program (base64, on
 * the first slide), the run's inputs (pictures, filled slots) and what the program drew on the
 * slide (text boxes, pictures, image slots) for the checks. Edited only from the chat.
 */
export function isCodeSlideHtml(html: string | null | undefined): boolean {
  return typeof html === "string" && /<html\b[^>]*\sdata-studio-engine=["']?code\b/i.test(html);
}

/** The chat-only engine that made these slides (`svg` / `code`), null for any other version. */
export function chatOnlyEngineOf(
  slides: ReadonlyArray<{ html: string }> | null | undefined,
): "svg" | "code" | null {
  if (!slides?.length) return null;
  if (slides.every((s) => isSvgSlideHtml(s.html))) return "svg";
  if (slides.every((s) => isCodeSlideHtml(s.html))) return "code";
  return null;
}

/** `name="studio:code-record"` — what a code slide's program drew (JSON). */
export const CODE_RECORD_META = "studio:code-record";

function unescapeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The content of `<meta name="<name>" content="…">` in a slide document (null: none). */
export function slideMetaContent(html: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`<meta\\s+name="${escaped}"\\s+content="([^"]*)"`, "i").exec(html);
  return m?.[1] !== undefined ? unescapeAttr(m[1]) : null;
}

export interface CodeSlotInfo {
  id: string;
  state: "empty" | "filled";
  ratio: string | null;
  label: string | null;
}

/** The image slots (`studio_brand.slot`) a code slide's program drew; [] for any other slide. */
export function codeSlideSlots(html: string | null | undefined): CodeSlotInfo[] {
  if (!isCodeSlideHtml(html)) return [];
  const raw = slideMetaContent(html as string, CODE_RECORD_META);
  if (!raw) return [];
  try {
    const record = JSON.parse(raw) as { slots?: unknown };
    if (!Array.isArray(record.slots)) return [];
    return record.slots.flatMap((s) => {
      if (!s || typeof s !== "object") return [];
      const o = s as Record<string, unknown>;
      if (typeof o.id !== "string" || !o.id) return [];
      return [
        {
          id: o.id,
          state: o.state === "filled" ? ("filled" as const) : ("empty" as const),
          ratio: typeof o.ratio === "string" ? o.ratio : null,
          label: typeof o.label === "string" ? o.label : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

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

/**
 * A design's AI image slot filled through the product-image line (docs/URETIM-RESIM.md Faz 1):
 * once the HTML design version is stored, the worker queues one `image.generate` job per empty
 * slot with these products (exact description → generation → AI check) and an approval target
 * (`product_image`, the post, the slot, the chat); the picture fills the slot only when the owner
 * approves. Sent only after the owner said yes to the paid generation (the chat's consent card):
 * `consented: true` is required, and without this field no picture is generated.
 */
export const SlotImageRequest = z
  .object({
    /** The owner allowed the paid generation for this post's slot(s). */
    consented: z.literal(true),
    /** Products the picture shows (exact description + check); none = a scene without one. */
    productIds: z.array(EntityId).max(4).optional(),
    /** The product's side to show ("sol", "arka", "önden"…); picks the reference photos. */
    view: z.string().trim().max(80).optional(),
    /** Picture style; absent = the brand's `imageStylePreset`, "" = no style. */
    style: z.string().trim().max(500).optional(),
    /** What the picture shows; absent = the post's `imageBrief` (else its title and brief). */
    prompt: z.string().trim().max(4_000).optional(),
    /** The chat the approval card goes to (default: the generation's `conversationId`). */
    conversationId: EntityId.optional(),
  })
  .meta({ id: "SlotImageRequest" });
export type SlotImageRequest = z.infer<typeof SlotImageRequest>;
