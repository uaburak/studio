// The adapter between the post and Wecra's engine document.
//
//   Studio post (slides × layers, design-contract HTML)  ⇄  engine document (artboards × nodes)
//
// Every slide is a top-level FRAME (an artboard) side by side on the page — selectable, which
// shows its size; moving or resizing one is undone (a locked frame would lock its layers too,
// as in Figma) —; every layer is a node inside it at the box the live slide document
// measured — a ROUNDED_RECTANGLE, or a FRAME for a group (its children inside it). The nodes
// paint nothing (no fills, no strokes): the slides themselves are Chromium's rendering of the
// HTML under the canvas; the engine gives the interaction (picking, handles, snapping, smart
// guides, spacing, zoom and pan) and draws its overlays.
//
// The engine's edits come back as DOCUMENT_CHANGED messages and are read here as editor edits
// (move / resize / rotate / scale, duplicate, delete, reorder, visibility, lock, a drawn shape);
// the controller turns those into design-kit patches. The HTML stays the only truth: after an
// edit the slide is re-measured and the scene is rebuilt from it (`diffScene`).
import type { NodeChange } from "../../../vendor/wecra-engine/codec.ts";
import { type EditorSlide, layerKey, parseLayerKey } from "./document.ts";
import {
  boxMatrix,
  invert,
  type Matrix,
  type MeasuredLayer,
  matrixBox,
  multiply,
  type OBox,
  type Rect,
  rectBox,
  translation,
} from "./geometry.ts";

export type Guid = string;

export const PAGE_GUID = "0:1";
/** Our nodes' session: the engine makes its own (duplicates, drawn shapes) in session 1. */
export const SCENE_SESSION = 7;
/** World px between two artboards. */
export const SLIDE_GAP = 120;

/** Where each artboard sits on the page (side by side, top-aligned). */
export function slideRects(
  sizes: readonly { width: number; height: number }[],
  gap = SLIDE_GAP,
): Rect[] {
  let x = 0;
  return sizes.map((s) => {
    const r = { x, y: 0, w: s.width, h: s.height };
    x += s.width + gap;
    return r;
  });
}

/** Sibling position keys (fractional index digits ' '…'~', never ending in ' '): two digits each. */
export function position(index: number): string {
  const hi = Math.floor(index / 94);
  return String.fromCharCode(34 + Math.min(hi, 92)) + String.fromCharCode(33 + (index % 94));
}

/** Stable GUIDs for slides and layers (a layer keeps its node while its key lives). */
export class SceneMap {
  private readonly byKey = new Map<string, Guid>();
  private readonly byGuid = new Map<Guid, string>();
  private next = 100;

  frameGuid(slide: number): Guid {
    return `${SCENE_SESSION}:${slide + 1}`;
  }

  slideOfFrame(guid: Guid): number | null {
    const [s, l] = guid.split(":").map(Number);
    return s === SCENE_SESSION && l !== undefined && l >= 1 && l < 100 ? l - 1 : null;
  }

  guidOf(key: string): Guid {
    let guid = this.byKey.get(key);
    if (!guid) {
      guid = `${SCENE_SESSION}:${this.next++}`;
      this.byKey.set(key, guid);
      this.byGuid.set(guid, key);
    }
    return guid;
  }

  /** The layer key of a node of ours (null: a frame, the engine's own node, or unknown). */
  keyOf(guid: Guid): string | null {
    return this.byGuid.get(guid) ?? null;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }
}

export interface SceneInput {
  slides: readonly EditorSlide[];
  /** The live measure per slide (null until its document is ready). */
  measures: readonly (Record<string, MeasuredLayer> | null)[];
  /** Boxes the last render measured (the version's layouts): used until the live measure is in. */
  fallback?: readonly (
    | { id: string; x: number; y: number; w: number; h: number; visible: boolean }[]
    | null
    | undefined
  )[];
  /** Layer keys locked in the editor. */
  locked: ReadonlySet<string>;
  rects: readonly Rect[];
}

const PROXY_TYPE = "ROUNDED_RECTANGLE";

/**
 * The engine document the post should be (DOCUMENT and the page are the blank document's):
 * parents before children, in paint order.
 */
export function sceneNodes(input: SceneInput, map: SceneMap): Map<Guid, NodeChange> {
  const nodes = new Map<Guid, NodeChange>();
  input.slides.forEach((slide, s) => {
    const rect = input.rects[s];
    if (!rect) return;
    const frame = map.frameGuid(s);
    const frameWorld = translation(rect.x, rect.y);
    nodes.set(frame, {
      guid: frame,
      phase: "CREATED",
      type: "FRAME",
      // Unnamed: the engine draws no title (the editor draws its own, theme-aware).
      name: "",
      parentIndex: { guid: PAGE_GUID, position: position(s) },
      size: { x: slide.width, y: slide.height },
      transform: frameWorld,
      fillPaints: [],
      strokePaints: [],
      strokeWeight: 0,
      visible: true,
      locked: false,
    } as NodeChange);

    const measure = input.measures[s] ?? null;
    const fallback = new Map((input.fallback?.[s] ?? []).map((b) => [b.id, b]));
    const boxOf = (id: string): { box: OBox; visible: boolean } | null => {
      const m = measure?.[id];
      if (m) return { box: m.box, visible: m.visible };
      const f = fallback.get(id);
      return f ? { box: rectBox(f), visible: f.visible } : null;
    };
    const byId = new Map(slide.layers.map((l) => [l.id, l]));
    const visit = (ids: readonly string[], parent: Guid, parentWorld: Matrix) => {
      ids.forEach((id, index) => {
        const layer = byId.get(id);
        if (!layer) return;
        const at = boxOf(id);
        if (!at) return;
        const key = layerKey(s, id);
        const guid = map.guidOf(key);
        const world = multiply(frameWorld, boxMatrix(at.box));
        const group = layer.type === "group";
        nodes.set(guid, {
          guid,
          phase: "CREATED",
          type: group ? "FRAME" : PROXY_TYPE,
          name: key,
          parentIndex: { guid: parent, position: position(index) },
          size: { x: Math.max(0.01, at.box.w), y: Math.max(0.01, at.box.h) },
          transform: multiply(invert(parentWorld), world),
          fillPaints: [],
          strokePaints: [],
          strokeWeight: 0,
          visible: !layer.hidden && at.visible,
          locked: input.locked.has(key),
          // Logos are sized by their height and never stretched.
          proportionsConstrained: layer.type === "logo",
          ...(group ? { frameMaskDisabled: true } : {}),
        } as NodeChange);
        if (layer.children.length > 0) visit(layer.children, guid, world);
      });
    };
    visit(slide.roots, frame, frameWorld);
  });
  return nodes;
}

const COMPARED = [
  "type",
  "name",
  "parentIndex",
  "size",
  "transform",
  "visible",
  "locked",
  "proportionsConstrained",
] as const;

function near(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-3;
  if (a && b && typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      near((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return a === b;
}

/**
 * The changes taking the engine from `applied` (what it holds, mirrored) to `next`: CREATED for
 * new nodes (and a changed type), only the differing fields otherwise, REMOVED for nodes gone.
 */
export function diffScene(
  applied: ReadonlyMap<Guid, NodeChange>,
  next: ReadonlyMap<Guid, NodeChange>,
): NodeChange[] {
  const out: NodeChange[] = [];
  for (const [guid, node] of next) {
    const was = applied.get(guid);
    if (!was || was.type !== node.type) {
      out.push(node);
      continue;
    }
    const change: Record<string, unknown> = { guid };
    let changed = false;
    for (const field of COMPARED) {
      const a = (was as unknown as Record<string, unknown>)[field];
      const b = (node as unknown as Record<string, unknown>)[field];
      if (b !== undefined && !near(a, b)) {
        change[field] = b;
        changed = true;
      }
    }
    if (changed) out.push(change as unknown as NodeChange);
  }
  // Removed nodes: children first is not needed (a parent's removal takes its subtree), but
  // nodes moved out of a removed parent must not be removed with it: they were re-parented above.
  for (const guid of applied.keys()) {
    if (guid.startsWith("0:")) continue;
    if (!next.has(guid)) out.push({ guid, phase: "REMOVED" } as NodeChange);
  }
  return out;
}

/** Keeps `applied` in step with what the engine holds after `changes` (ours or the user's). */
export function mergeApplied(applied: Map<Guid, NodeChange>, changes: readonly NodeChange[]): void {
  for (const change of changes) {
    const guid = change.guid as Guid;
    if (!guid) continue;
    if ((change as { phase?: string }).phase === "REMOVED") {
      applied.delete(guid);
      continue;
    }
    if ((change as { phase?: string }).phase === "CREATED") {
      applied.set(guid, { ...change } as NodeChange);
      continue;
    }
    const was = applied.get(guid);
    if (was) applied.set(guid, { ...was, ...change } as NodeChange);
  }
}

// --- the engine's edits ----------------------------------------------------------------------------

export type SceneEdit =
  /** A layer's box changed (moved, resized, turned, scaled). */
  | { kind: "geometry"; key: string; box: OBox }
  /** ⌥-drag made a copy of a layer, now at `box`. */
  | { kind: "duplicate"; sourceKey: string; box: OBox; guid: Guid }
  /** A shape drawn with the rectangle tool on an artboard. */
  | { kind: "shape"; slide: number; box: OBox; guid: Guid }
  | { kind: "delete"; key: string }
  /** New place among the same parent's layers (0: bottom). */
  | { kind: "reorder"; key: string; index: number }
  | { kind: "visibility"; key: string; hidden: boolean }
  | { kind: "lock"; key: string; locked: boolean }
  /** An artboard was moved or resized (slides keep their place and size: undone). */
  | { kind: "frame"; slide: number };

/** What the controller reads from the engine to understand a change. */
export interface SceneReader {
  /** A node's box in its slide's artboard px, and the slide it is drawn in (null: off every artboard). */
  boxInSlide(guid: Guid, slide: number): OBox | null;
  /** The slide whose artboard a node is under (null: on the page). */
  slideOf(guid: Guid): number | null;
  /** Child GUIDs of a node, paint order (bottom first). */
  childrenOf(guid: Guid): Guid[];
}

export function classifyChanges(
  changes: readonly NodeChange[],
  map: SceneMap,
  applied: ReadonlyMap<Guid, NodeChange>,
  reader: SceneReader,
): SceneEdit[] {
  const edits: SceneEdit[] = [];
  const geometry = new Set<string>();
  for (const change of changes) {
    const guid = change.guid as Guid;
    const phase = (change as { phase?: string }).phase;
    const key = map.keyOf(guid);
    if (phase === "CREATED" && !key) {
      if (map.slideOfFrame(guid) !== null) continue;
      const sourceKey =
        typeof change.name === "string" && parseLayerKey(change.name) ? change.name : null;
      if (sourceKey && map.has(sourceKey)) {
        const slide = parseLayerKey(sourceKey)?.slide ?? 0;
        const box = reader.boxInSlide(guid, slide);
        if (box) edits.push({ kind: "duplicate", sourceKey, box, guid });
        continue;
      }
      const slide = reader.slideOf(guid);
      if (slide !== null) {
        const box = reader.boxInSlide(guid, slide);
        if (box) edits.push({ kind: "shape", slide, box, guid });
      }
      continue;
    }
    if (!key) {
      const slide = map.slideOfFrame(guid);
      if (slide !== null && (change.transform || change.size || change.parentIndex))
        edits.push({ kind: "frame", slide });
      continue;
    }
    if (phase === "REMOVED") {
      edits.push({ kind: "delete", key });
      continue;
    }
    const was = applied.get(guid);
    if (change.visible !== undefined && change.visible !== was?.visible)
      edits.push({ kind: "visibility", key, hidden: !change.visible });
    if (change.locked !== undefined && change.locked !== was?.locked)
      edits.push({ kind: "lock", key, locked: change.locked });
    const parent = change.parentIndex?.guid;
    if (
      parent &&
      was?.parentIndex &&
      parent === was.parentIndex.guid &&
      change.parentIndex?.position !== was.parentIndex.position
    ) {
      const siblings = reader.childrenOf(parent);
      const index = siblings.indexOf(guid);
      if (index >= 0) edits.push({ kind: "reorder", key, index });
    }
    if (
      (change.transform || change.size || (parent && parent !== was?.parentIndex?.guid)) &&
      !geometry.has(key)
    ) {
      geometry.add(key);
      const slide = parseLayerKey(key)?.slide ?? 0;
      const box = reader.boxInSlide(guid, slide);
      if (box) edits.push({ kind: "geometry", key, box });
    }
  }
  return edits;
}

/** A node's box from its engine fields under a parent drawn with `parentWorld`. */
export function nodeBox(
  node: Pick<NodeChange, "transform" | "size">,
  parentWorld: Matrix,
  frameWorld: Matrix,
): OBox {
  const local = (node.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 }) as Matrix;
  const world = multiply(parentWorld, local);
  return matrixBox(multiply(invert(frameWorld), world), node.size ?? { x: 0, y: 0 });
}
