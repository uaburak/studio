/**
 * A canvas slide as the chat agent reads it (S1: the Wecra document is the design): every layer
 * of the slide frame with the id Wecra's design operations take (`canvas_edit`), its name, kind,
 * box, visibility and paint; texts with their characters, font, size and colour; the contract
 * meaning the import kept (an image slot, the logo, a headline). Built from the canvas facts
 * (`facts.ts`) — the slide HTML of a canvas version carries them, so the worker reads an outline
 * without the canvas runner; the runner builds the same outline from a live document.
 *
 * Compact on purpose (it goes into the model's context): boxes as `[x, y, w, h]` in slide px
 * (rounded), defaults left out, texts and names clipped. Names and texts are the user's content:
 * whoever puts an outline into a prompt frames it as data.
 */
import type { CanvasFacts, CanvasNode, CanvasPaint } from "./facts.ts";

export interface CanvasOutlineText {
  characters: string;
  /** "Family Style" (e.g. "Archivo Bold"). */
  font: string;
  size: number;
  weight: number;
  color: string | null;
  align: string;
  lineHeight?: number;
  /** The text does not fit its box (Wecra's own layout). */
  overflow?: true;
  truncated?: true;
  missingFont?: true;
  /** Runs with their own font or colour. */
  mixed?: true;
}

export interface CanvasOutlineLayer {
  /** Wecra's layer id (`12:345`): what `canvas_edit` operations name. */
  id: string;
  name: string;
  type: CanvasNode["type"];
  /** Wecra's node type (TEXT, FRAME, RECTANGLE …). */
  wecraType: string;
  /** The enclosing layer's id; `null`: directly on the slide frame. */
  parent: string | null;
  /** Axis-aligned box in slide px (the frame's top-left is 0,0). */
  box: [number, number, number, number];
  rotation?: number;
  hidden?: true;
  opacity?: number;
  /** Fills, top last: "#RRGGBB" (with "@0.5" below full opacity), "gradient", "image". */
  fills?: string[];
  strokes?: string[];
  text?: CanvasOutlineText;
  /** The design-contract meaning the import kept (an image slot, the logo, a headline …). */
  contract?: { layer: string; type: string; role?: string; slot?: string };
}

export interface CanvasOutlineSlide {
  /** 1-based, in reading order. */
  slide: number;
  /** The slide frame's Wecra id (a `parentId` for new layers). */
  frameId: string;
  name: string;
  width: number;
  height: number;
  background: string | null;
  layers: CanvasOutlineLayer[];
  /** Layers left out (a very busy slide). */
  more?: number;
  fonts: string[];
}

const MAX_TEXT = 400;
const MAX_NAME = 120;

const round = (v: number) => Math.round(v);
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

function paintText(p: CanvasPaint): string {
  if (p.type === "solid")
    return p.opacity < 0.995 ? `${p.color}@${round(p.opacity * 100) / 100}` : p.color;
  if (p.type === "gradient") return "gradient";
  if (p.type === "image") return p.fit === "fill" ? "image" : `image(${p.fit})`;
  return p.kind;
}

function layerOf(n: CanvasNode): CanvasOutlineLayer {
  const out: CanvasOutlineLayer = {
    id: n.id,
    name: clip(n.name, MAX_NAME),
    type: n.type,
    wecraType: n.wecraType,
    parent: n.parent,
    box: [round(n.bounds.x), round(n.bounds.y), round(n.bounds.w), round(n.bounds.h)],
  };
  if (Math.abs(n.rotation) >= 0.5) out.rotation = round(n.rotation);
  if (!n.visible) out.hidden = true;
  if (n.opacity < 0.995) out.opacity = round(n.opacity * 100) / 100;
  if (n.fills.length) out.fills = n.fills.map(paintText);
  if (n.strokes.length && n.strokeWeight > 0) out.strokes = n.strokes.map(paintText);
  const t = n.text;
  if (t) {
    out.text = {
      characters: clip(t.characters, MAX_TEXT),
      font: `${t.family} ${t.style}`.trim(),
      size: round(t.size * 10) / 10,
      weight: t.weight,
      color: t.color,
      align: t.align,
      ...(t.lineHeight !== null ? { lineHeight: round(t.lineHeight * 10) / 10 } : {}),
      ...(t.overflow ? { overflow: true as const } : {}),
      ...(t.truncated ? { truncated: true as const } : {}),
      ...(t.missingFont ? { missingFont: true as const } : {}),
      ...(t.runs.length > 1 ? { mixed: true as const } : {}),
    };
  }
  if (n.mark) {
    out.contract = {
      layer: n.mark.layer,
      type: n.mark.type,
      ...(n.mark.role ? { role: n.mark.role } : {}),
      ...(n.mark.slot?.label ? { slot: n.mark.slot.label } : {}),
    };
  }
  return out;
}

/** The outline of one slide (`slide`: 1-based), at most `maxLayers` layers in paint order. */
export function canvasOutline(
  facts: CanvasFacts,
  slide: number,
  maxLayers = 150,
): CanvasOutlineSlide {
  const layers = facts.nodes.slice(0, maxLayers).map(layerOf);
  const fonts = [...new Set(facts.fonts.map((f) => `${f.family} ${f.style}`.trim()))];
  return {
    slide,
    frameId: facts.frame.id,
    name: clip(facts.frame.name, MAX_NAME),
    width: round(facts.frame.width),
    height: round(facts.frame.height),
    background: facts.frame.background,
    layers,
    ...(facts.nodes.length > maxLayers ? { more: facts.nodes.length - maxLayers } : {}),
    fonts,
  };
}
