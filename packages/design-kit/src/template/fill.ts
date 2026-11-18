/**
 * Filling a template (N9): its layout stays exactly, only the fields' texts, pictures and (with
 * auto-fit) font sizes change.
 *
 * - HTML templates: design-kit patch operations per slide (`setText`, `setTypography`,
 *   `fillSlot` / `replaceImage`), applied to the template's slide HTML.
 * - Canvas templates: Wecra's own write tools (`update_nodes` with `characters` / `fontSize`,
 *   `place_image` with the brand picture's `assetId`), run as a `canvas.apply` job on a copy of
 *   the template's document.
 *
 * Auto-fit on the canvas is planned from the source layout (`fit.ts`) and corrected once from
 * what Wecra actually laid out (`canvasFitCorrections`, over the new version's facts).
 */
import type { CanvasFacts } from "../canvas/facts.ts";
import type { PatchOpInput } from "../patch/ops.ts";
import { autoFitFloor, fitTextSize, type TextMetrics } from "./fit.ts";

export interface FillField {
  key: string;
  kind: "text" | "image";
  role: string | null;
  slide: number;
  layer: string;
  nodeId: string | null;
  layerType: "text" | "slot" | "image";
  metrics: TextMetrics | null;
  minFontSize: number | null;
  autoFit: boolean;
  locked: boolean;
}

export interface FillValues {
  /** Text by field key (a missing key keeps the template's text). */
  values: Readonly<Record<string, string>>;
  /**
   * Picture by field key: HTML — the file (`/media/<asset>.<ext>`); canvas — the asset id.
   * A missing key keeps the template's picture.
   */
  images: Readonly<Record<string, string>>;
  /** Font size by field key (auto-fit), px. */
  sizes?: Readonly<Record<string, number>>;
}

/** One patch operation of an HTML template's slide. */
export interface SlidePatch {
  slide: number;
  op: PatchOpInput;
}

/** A Wecra write tool and its arguments (`CanvasOperation` of @studio/contract). */
export interface CanvasFillOperation {
  tool: "update_nodes" | "place_image";
  args: Record<string, unknown>;
}

const round = (n: number) => Math.round(n * 2) / 2;

/** The floor auto-fit keeps a field above. */
export function fieldFloor(field: Pick<FillField, "role" | "minFontSize" | "metrics">): number {
  return field.minFontSize ?? autoFitFloor(field.role, field.metrics?.fontSize ?? null);
}

/** HTML: the patches that fill the template's layers (in slide order). */
export function htmlFillPatches(fields: readonly FillField[], fill: FillValues): SlidePatch[] {
  const out: SlidePatch[] = [];
  for (const f of fields) {
    if (f.locked) continue;
    if (f.kind === "text") {
      const value = fill.values[f.key];
      if (value !== undefined)
        out.push({ slide: f.slide, op: { op: "setText", layer: f.layer, text: value } });
      const size = fill.sizes?.[f.key];
      if (size !== undefined && Number.isFinite(size) && size > 0)
        out.push({
          slide: f.slide,
          op: { op: "setTypography", layer: f.layer, fontSize: round(size) },
        });
      continue;
    }
    const src = fill.images[f.key];
    if (!src) continue;
    out.push({
      slide: f.slide,
      op:
        f.layerType === "slot"
          ? { op: "fillSlot", layer: f.layer, src, alt: "" }
          : { op: "replaceImage", layer: f.layer, src },
    });
  }
  return out.sort((a, b) => a.slide - b.slide);
}

/** Canvas: Wecra's write tools that fill the template's document. */
export function canvasFillOperations(
  fields: readonly FillField[],
  fill: FillValues,
): CanvasFillOperation[] {
  const updates: Record<string, unknown>[] = [];
  const images: CanvasFillOperation[] = [];
  for (const f of fields) {
    if (f.locked || !f.nodeId) continue;
    if (f.kind === "text") {
      const value = fill.values[f.key];
      const size = fill.sizes?.[f.key];
      const update: Record<string, unknown> = { nodeId: f.nodeId };
      if (value !== undefined) update.characters = value;
      if (size !== undefined && Number.isFinite(size) && size > 0) update.fontSize = round(size);
      if (Object.keys(update).length > 1) updates.push(update);
      continue;
    }
    const assetId = fill.images[f.key];
    if (assetId)
      images.push({ tool: "place_image", args: { nodeId: f.nodeId, assetId, scaleMode: "FILL" } });
  }
  return [
    ...(updates.length ? [{ tool: "update_nodes" as const, args: { updates } }] : []),
    ...images,
  ];
}

/**
 * Auto-fit before filling (canvas): the size each new text needs to stay in its source box,
 * for the unlocked text fields with auto-fit, a value and the source layout. Only shrinks.
 */
export function planFitSizes(
  fields: readonly FillField[],
  values: Readonly<Record<string, string>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of fields) {
    if (f.locked || f.kind !== "text" || !f.autoFit || !f.metrics) continue;
    const value = values[f.key];
    if (value === undefined) continue;
    const fit = fitTextSize(f.metrics, value, fieldFloor(f));
    if (fit?.shrunk) out[f.key] = fit.size;
  }
  return out;
}

/**
 * Auto-fit after filling (canvas, once): texts Wecra laid out larger than their source box (or
 * flagged as overflowing) get a smaller size, from how much they grew. `facts[i]` are the new
 * version's facts of slide i.
 */
export function canvasFitCorrections(
  fields: readonly FillField[],
  facts: ReadonlyArray<CanvasFacts | null>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of fields) {
    if (f.locked || f.kind !== "text" || !f.autoFit || !f.metrics || !f.nodeId) continue;
    const node = facts[f.slide]?.nodes.find((n) => n.id === f.nodeId);
    const t = node?.text;
    if (!node || !t) continue;
    const box = f.metrics.box;
    const lineHeight = t.lineHeight ?? t.size * 1.2;
    const needed = Math.max(node.bounds.h, t.lines.length * lineHeight);
    const tall = needed > box.h + 2 || t.overflow;
    const wide = f.metrics.autoResize === "width-and-height" && node.bounds.w > box.w + 2;
    if (!tall && !wide) continue;
    const ratio = Math.min(
      tall ? box.h / Math.max(1, needed) : 1,
      wide ? box.w / Math.max(1, node.bounds.w) : 1,
    );
    const floor = fieldFloor(f);
    const next = Math.max(
      floor,
      Math.floor(t.size * Math.sqrt(Math.max(0.05, ratio)) * 0.97 * 2) / 2,
    );
    if (next < t.size - 0.4) out[f.key] = next;
  }
  return out;
}
