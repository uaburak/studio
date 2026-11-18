// Reading the engine's document back for the adapter (model/scene.ts classifyChanges): a node's
// box in its slide's artboard px, the slide it is on, its children.
import type { StudioEngine } from "../engine/studio-engine.ts";
import {
  IDENTITY_MATRIX,
  type Matrix,
  multiply,
  type Rect,
  translation,
} from "../model/geometry.ts";
import { type Guid, nodeBox, PAGE_GUID, type SceneMap, type SceneReader } from "../model/scene.ts";

export function engineReader(
  engine: Pick<StudioEngine, "readNode">,
  map: SceneMap,
  rects: () => readonly Rect[],
): SceneReader {
  const worldOf = (guid: Guid, depth = 0): Matrix => {
    if (guid === PAGE_GUID || depth > 32) return IDENTITY_MATRIX;
    const node = engine.readNode(guid, { fields: ["transform", "parentIndex"] });
    const local = (node?.transform ?? IDENTITY_MATRIX) as Matrix;
    const parent = node?.parentIndex?.guid;
    return multiply(parent ? worldOf(parent, depth + 1) : IDENTITY_MATRIX, local);
  };
  return {
    boxInSlide: (guid, slide) => {
      const node = engine.readNode(guid, { fields: ["transform", "size", "parentIndex"] });
      const rect = rects()[slide];
      if (!node || !rect) return null;
      return nodeBox(
        node,
        worldOf(node.parentIndex?.guid ?? PAGE_GUID),
        translation(rect.x, rect.y),
      );
    },
    slideOf: (guid) => {
      let at: string | undefined = guid;
      for (let i = 0; at && at !== PAGE_GUID && i < 32; i++) {
        const slide = map.slideOfFrame(at);
        if (slide !== null) return slide;
        at = engine.readNode(at, { fields: ["parentIndex"] })?.parentIndex?.guid;
      }
      // On the page (artboards are locked, so a drawn shape may land there): by its centre.
      const node = engine.readNode(guid, { fields: ["transform", "size", "parentIndex"] });
      if (!node) return null;
      const box = nodeBox(node, worldOf(node.parentIndex?.guid ?? PAGE_GUID), IDENTITY_MATRIX);
      const index = rects().findIndex(
        (r) => box.cx >= r.x && box.cx <= r.x + r.w && box.cy >= r.y && box.cy <= r.y + r.h,
      );
      return index >= 0 ? index : null;
    },
    childrenOf: (guid) =>
      engine.readNode(guid, { childIds: true, fields: ["name"] })?.childIds ?? [],
  };
}
