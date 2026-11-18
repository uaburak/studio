/**
 * Canvas facts: what a slide edited on the canvas (Wecra's editor) contains, read from the
 * Wecra document when the slide is saved. A canvas slide is published as the PNG Wecra's
 * engine exported; the facts describe that picture machine-readably (every layer in z-order
 * with its place, text, fonts, colours, pictures and image slots) so the checks, the AI, alt
 * text and the iPhone can reason about it. Stored in the slide HTML (`<meta name="studio:canvas">`,
 * see `html.ts`); the Wecra document stays the source of truth.
 *
 * Coordinates are CSS px of the slide (the frame's top-left is 0,0; the PNG is 1x). Colours are
 * `#RRGGBB` (sRGB), opacities 0–1. Bounds are the axis-aligned box of the (possibly rotated)
 * layer.
 */
import { z } from "zod";

export const CANVAS_FACTS_VERSION = 1;

const Num = z.number().finite();
const Hex = z.string().regex(/^#[0-9A-F]{6}$/);

export const CanvasRect = z.object({ x: Num, y: Num, w: Num, h: Num });
export type CanvasRect = z.infer<typeof CanvasRect>;

export const CanvasPaint = z.discriminatedUnion("type", [
  z.object({ type: z.literal("solid"), color: Hex, opacity: Num }),
  z.object({
    type: z.literal("gradient"),
    kind: z.string().max(32),
    stops: z.array(z.object({ color: Hex, opacity: Num, position: Num })).max(32),
    opacity: Num,
  }),
  z.object({
    type: z.literal("image"),
    /** Wecra's image key (SHA-1 of the file in the document bundle), when known. */
    image: z.string().max(64).nullable(),
    fit: z.enum(["fill", "fit", "crop", "tile"]),
    /** The image file's pixel size, when the document knows it. */
    size: z.object({ w: Num, h: Num }).nullable(),
    opacity: Num,
  }),
  z.object({ type: z.literal("other"), kind: z.string().max(32), opacity: Num }),
]);
export type CanvasPaint = z.infer<typeof CanvasPaint>;

/** A run of a text with its own style (only for texts that mix styles). `start`/`end`: UTF-16. */
export const CanvasTextRun = z.object({
  start: z.number().int().min(0),
  end: z.number().int().min(0),
  family: z.string().max(200),
  style: z.string().max(100),
  weight: z.number().int(),
  italic: z.boolean(),
  size: Num,
  color: Hex.nullable(),
  opacity: Num,
});
export type CanvasTextRun = z.infer<typeof CanvasTextRun>;

/** One laid-out line: its box in slide px and its characters (`from`–`to`, UTF-16). */
export const CanvasLine = CanvasRect.extend({
  from: z.number().int().min(0),
  to: z.number().int().min(0),
});
export type CanvasLine = z.infer<typeof CanvasLine>;

export const CanvasText = z.object({
  characters: z.string().max(10_000),
  family: z.string().max(200),
  style: z.string().max(100),
  weight: z.number().int(),
  italic: z.boolean(),
  /** px */
  size: Num,
  /** px; `null`: the font's own (auto). */
  lineHeight: Num.nullable(),
  /** px */
  letterSpacing: Num,
  align: z.enum(["left", "center", "right", "justified"]),
  verticalAlign: z.enum(["top", "center", "bottom"]),
  /** How the box follows the text: fixed (`none`), grows down, or hugs the text. */
  autoResize: z.enum(["none", "height", "width-and-height"]),
  /** The main solid colour (the first run's), or `null` (gradient / picture fill). */
  color: Hex.nullable(),
  /** Every solid colour the text uses (runs included). */
  colors: z.array(Hex).max(64),
  fills: z.array(CanvasPaint).max(16),
  /** Runs with their own style (empty when the whole text has one style). */
  runs: z.array(CanvasTextRun).max(400),
  /** The laid-out lines, as Wecra's text engine set them. */
  lines: z.array(CanvasLine).max(400),
  /** The text does not fit its box (Wecra's layout is larger than the fixed box). */
  overflow: z.boolean(),
  /** Wecra cut the text with an ellipsis (truncation / max lines). */
  truncated: z.boolean(),
  /** A font of the text was not available: Wecra drew it with its fallback (Inter). */
  missingFont: z.boolean(),
});
export type CanvasText = z.infer<typeof CanvasText>;

/** Design-contract meaning a layer had in the HTML it was imported from (set by the import). */
export const CanvasMark = z.object({
  /** The contract layer id (`data-layer`). */
  layer: z.string().max(64),
  /** `data-type`: text, image, shape, logo, slot, group. */
  type: z.string().max(16),
  role: z.string().max(32).nullable(),
  /** The picture's file (`/media/…`, `/brand/logos/…`) of an image, logo or filled slot. */
  src: z.string().max(500).nullable(),
  /** Wecra's image key of that file right after the import (unchanged = still that file). */
  image: z.string().max(64).nullable(),
  allowOverlap: z.boolean(),
  slot: z
    .object({
      ratio: z.string().max(16).nullable(),
      label: z.string().max(200).nullable(),
      fit: z.string().max(16).nullable(),
    })
    .nullable(),
});
export type CanvasMark = z.infer<typeof CanvasMark>;

export const CANVAS_NODE_TYPES = ["text", "image", "shape", "group", "frame"] as const;

export const CanvasNode = z.object({
  /** Wecra's layer id (GUID, `s:l`). */
  id: z.string().max(64),
  name: z.string().max(500),
  type: z.enum(CANVAS_NODE_TYPES),
  /** Wecra's node type (TEXT, FRAME, ROUNDED_RECTANGLE …). */
  wecraType: z.string().max(40),
  /** Enclosing layer (`null`: the slide's frame). */
  parent: z.string().max(64).nullable(),
  bounds: CanvasRect,
  /** Degrees, clockwise. */
  rotation: Num,
  opacity: Num,
  /** Opacity with the enclosing layers' (what is painted). */
  effectiveOpacity: Num,
  /** Shown (the layer and every enclosing layer visible). */
  visible: z.boolean(),
  /** Clips its content (a frame with "clip content"). */
  clips: z.boolean(),
  /** Where enclosing clipping layers cut it (`null`: only the slide's edge). */
  clip: CanvasRect.nullable(),
  fills: z.array(CanvasPaint).max(16),
  strokes: z.array(CanvasPaint).max(16),
  strokeWeight: Num,
  text: CanvasText.optional(),
  /** The contract meaning from the import (`null`: a layer made on the canvas). */
  mark: CanvasMark.nullable(),
});
export type CanvasNode = z.infer<typeof CanvasNode>;

export const CanvasFacts = z.object({
  v: z.literal(CANVAS_FACTS_VERSION),
  editor: z.literal("wecra"),
  frame: z.object({
    id: z.string().max(64),
    name: z.string().max(500),
    width: Num,
    height: Num,
    /** The frame's first visible solid fill. */
    background: Hex.nullable(),
    fills: z.array(CanvasPaint).max(16),
  }),
  /** Every layer in the slide, in paint order (bottom first; a layer before its children). */
  nodes: z.array(CanvasNode).max(2_000),
  /** Fonts the slide's texts name, with the number of texts and whether Wecra had them. */
  fonts: z
    .array(
      z.object({
        family: z.string().max(200),
        style: z.string().max(100),
        uses: z.number().int(),
        missing: z.boolean(),
      }),
    )
    .max(200),
});
export type CanvasFacts = z.infer<typeof CanvasFacts>;

/** Parsed facts, or `null` when the value is not facts of a known version. */
export function parseCanvasFacts(value: unknown): CanvasFacts | null {
  const r = CanvasFacts.safeParse(value);
  return r.success ? r.data : null;
}

/** The facts' size in the slide HTML (JSON, escaped for an attribute), in characters. */
export function canvasFactsSize(facts: CanvasFacts): number {
  const json = JSON.stringify(facts);
  let quotes = 0;
  for (let i = 0; i < json.length; i++) if (json.charCodeAt(i) === 34) quotes++;
  // `"` → `&quot;` (+5); `&` `<` `>` are rare in facts and counted as they are.
  return json.length + quotes * 5;
}

/**
 * Facts that fit in a slide HTML (`max` characters; the API takes 1 MB per slide): a very busy
 * slide loses first its lines and runs beyond the first 40 per text, then its hidden layers,
 * then plain shapes nothing refers to; `null` when even that does not fit.
 */
export function fitCanvasFacts(facts: CanvasFacts, max = 600_000): CanvasFacts | null {
  if (canvasFactsSize(facts) <= max) return facts;
  let out: CanvasFacts = {
    ...facts,
    nodes: facts.nodes.map((n) =>
      n.text
        ? {
            ...n,
            text: { ...n.text, lines: n.text.lines.slice(0, 40), runs: n.text.runs.slice(0, 40) },
          }
        : n,
    ),
  };
  if (canvasFactsSize(out) <= max) return out;
  out = { ...out, nodes: out.nodes.filter((n) => n.visible) };
  if (canvasFactsSize(out) <= max) return out;
  const parents = new Set(out.nodes.map((n) => n.parent).filter((p): p is string => !!p));
  out = {
    ...out,
    nodes: out.nodes.filter(
      (n) =>
        n.type === "text" ||
        n.type === "image" ||
        n.mark !== null ||
        parents.has(n.id) ||
        n.fills.some((p) => p.type === "image"),
    ),
  };
  return canvasFactsSize(out) <= max ? out : null;
}
