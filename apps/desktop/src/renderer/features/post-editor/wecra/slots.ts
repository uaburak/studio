// Image slots and the brand's logo on the canvas. A slot is the contract's `data-type="slot"`
// layer the import marked (plugin data `studio` / `layer`: its label, ratio, fit); it is filled
// when it (or a layer inside it) has a picture. Filling puts the picture on it as an image paint
// in the slot's fit (cover → Fill, contain → Fit), hides its empty-state placeholder (the label
// pill and frame the import drew from ::before / ::after) and keeps the mark — with the file
// (`/media/<asset>.<ext>`) and Wecra's image key, so the checks and the slide HTML see a filled
// slot of that asset (design-kit `canvasLayers`). "Kaldır" empties it: the brand's slot colour
// back, the placeholder shown again, the file forgotten. One undo step each.
//
// "Logo ekle" puts the brand's logo (a file of the kit) on a slide as a picture marked
// `type: logo` with its `/brand/logos/…` file, so the checks know it as the brand's logo (clear
// space, safe area, overlaps). Of the kit's logos it picks the one made for the background under
// where it goes (`on: light / dark`), by that background's luminance.

import { keyAfter, keyBetween } from "@shared/schema/fractionalIndex";
import type { CanvasMark } from "@studio/design-kit/canvas";
import { defaults, IDENTITY } from "@/editor/agents/nodeSpec";
import type { EditorController } from "@/editor/controller";
import { pageFrames } from "@/editor/exporting";
import { mediaPaint } from "@/editor/model/paints";
import { newNodeGuid } from "@/editor/variables";
import { LAYER_KEY, STUDIO_PLUGIN } from "./facts.ts";

type PluginEntry = { pluginID?: string; key?: string; value?: string };
type Paint = {
  type?: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a?: number };
  image?: { hash?: ArrayLike<number> | string };
};
type SlotNode = {
  guid: string;
  name?: string;
  type?: string;
  visible?: boolean;
  fillPaints?: Paint[];
  pluginData?: PluginEntry[];
  childIds?: string[];
  parentIndex?: { guid?: string };
  transform?: { m02?: number; m12?: number };
  size?: { x?: number; y?: number };
};

const FIELDS = [
  "name",
  "type",
  "visible",
  "fillPaints",
  "pluginData",
  "parentIndex",
  "transform",
  "size",
];

const read = (ed: EditorController, id: string): SlotNode | null =>
  (ed.engine.readNode(id, {
    fields: FIELDS,
    childIds: true,
  } as never) as unknown as SlotNode | null) ?? null;

/** A layer's contract mark (the import's plugin data), or null. */
export function markOf(n: Pick<SlotNode, "pluginData"> | null): CanvasMark | null {
  const entry = n?.pluginData?.find((e) => e.pluginID === STUDIO_PLUGIN && e.key === LAYER_KEY);
  if (!entry?.value) return null;
  try {
    return JSON.parse(entry.value) as CanvasMark;
  } catch {
    return null;
  }
}

function withMark(n: SlotNode, mark: CanvasMark): PluginEntry[] {
  const others = (n.pluginData ?? []).filter(
    (e) => !(e.pluginID === STUDIO_PLUGIN && e.key === LAYER_KEY),
  );
  return [...others, { pluginID: STUDIO_PLUGIN, key: LAYER_KEY, value: JSON.stringify(mark) }];
}

const topImage = (paints: Paint[] | undefined): Paint | null =>
  [...(paints ?? [])].reverse().find((p) => p.type === "IMAGE" && p.visible !== false) ?? null;

/** The slot a layer is (or is inside), with its mark. */
export function slotAt(ed: EditorController, id: string): { id: string; mark: CanvasMark } | null {
  for (let cur: string | undefined = id, guard = 0; cur && guard < 64; guard++) {
    const n = read(ed, cur);
    if (!n || n.type === "CANVAS") return null;
    const mark = markOf(n);
    if (mark?.type === "slot") return { id: cur, mark };
    cur = n.parentIndex?.guid;
  }
  return null;
}

/** What the slot panel shows of a slot. */
export interface SlotInfo {
  id: string;
  label: string;
  ratio: string | null;
  fit: "cover" | "contain";
  filled: boolean;
  /** The layer holding its picture (itself or a layer inside it). */
  holder: string | null;
  src: string | null;
}

/** The layer holding the slot's picture: itself, or the first layer inside it with one. */
function pictureHolder(ed: EditorController, id: string): string | null {
  const n = read(ed, id);
  if (!n) return null;
  if (topImage(n.fillPaints)) return id;
  for (const c of n.childIds ?? []) {
    const child = read(ed, c);
    if (child?.visible === false) continue;
    const found = pictureHolder(ed, c);
    if (found) return found;
  }
  return null;
}

export function slotInfo(ed: EditorController, id: string): SlotInfo | null {
  const slot = slotAt(ed, id);
  if (!slot) return null;
  const holder = pictureHolder(ed, slot.id);
  return {
    id: slot.id,
    label: slot.mark.slot?.label?.trim() || slot.mark.layer || "Görsel",
    ratio: slot.mark.slot?.ratio ?? null,
    fit: slot.mark.slot?.fit === "contain" ? "contain" : "cover",
    filled: !!holder,
    holder,
    src: holder ? slot.mark.src : null,
  };
}

/** The slot under a point of the page (a drop), or null. */
export function slotUnder(ed: EditorController, screen: { x: number; y: number }): string | null {
  for (const id of ed.engine.hitTest(screen.x, screen.y)) {
    const slot = slotAt(ed, id);
    if (slot) return slot.id;
  }
  return null;
}

/** A picture ready for the canvas (in the document's images). */
export interface CanvasPicture {
  hash: string;
  width: number;
  height: number;
  /** Its file as the contract names it (`/media/<asset>.<ext>`, `/brand/logos/…`). */
  src: string;
}

/** Bytes → the document's images (Wecra's import), or null when they can't be decoded. */
export async function importPicture(
  ed: EditorController,
  bytes: Uint8Array,
  name: string,
  mime: string,
): Promise<{ hash: string; width: number; height: number } | null> {
  const file = new File([bytes as BlobPart], name, { type: mime });
  const [img] = await ed.images.import([file]);
  return img ? { hash: img.hash, width: img.width, height: img.height } : null;
}

const PLACEHOLDER = new Set(["before", "after"]);

/** The slot's empty-state placeholder layers (the ::before frame and ::after label the import drew). */
function placeholders(ed: EditorController, slot: string): string[] {
  return (read(ed, slot)?.childIds ?? []).filter((c) => PLACEHOLDER.has(read(ed, c)?.name ?? ""));
}

/** Fills a slot with a picture (one undo step); its mark keeps the file and image key. */
export function fillSlot(ed: EditorController, slotId: string, picture: CanvasPicture): boolean {
  const info = slotInfo(ed, slotId);
  const node = info ? read(ed, info.id) : null;
  if (!info || !node) return false;
  const mark = markOf(node);
  if (!mark) return false;
  const paint = {
    ...mediaPaint({ hash: picture.hash, width: picture.width, height: picture.height }),
    imageScaleMode: info.fit === "contain" ? "FIT" : "FILL",
  };
  ed.batch("Yuvayı doldur", () => {
    // A picture inside the slot (an imported filled slot): that layer's picture changes.
    const target = info.holder && info.holder !== info.id ? info.holder : info.id;
    const keep =
      target === info.id ? (node.fillPaints ?? []).filter((p) => p.type !== "IMAGE") : [];
    ed.engine.setProps([target], { fillPaints: [...keep, paint] } as never);
    const hidden = placeholders(ed, info.id);
    if (hidden.length) ed.engine.setProps(hidden, { visible: false } as never);
    ed.engine.setProps([info.id], {
      pluginData: withMark(node, { ...mark, src: picture.src, image: picture.hash }),
    } as never);
  });
  return true;
}

/** Empties a slot (one undo step): the slot colour back, its placeholder shown, the file forgotten. */
export function emptySlot(ed: EditorController, slotId: string, slotColor: string | null): boolean {
  const info = slotInfo(ed, slotId);
  const node = info ? read(ed, info.id) : null;
  if (!info || !node) return false;
  const mark = markOf(node);
  if (!mark) return false;
  const color = /^#[0-9a-f]{6}$/i.test(slotColor ?? "") ? (slotColor as string) : "#F1F1EE";
  const solid = {
    type: "SOLID",
    color: {
      r: Number.parseInt(color.slice(1, 3), 16) / 255,
      g: Number.parseInt(color.slice(3, 5), 16) / 255,
      b: Number.parseInt(color.slice(5, 7), 16) / 255,
      a: 1,
    },
    opacity: 1,
    visible: true,
    blendMode: "NORMAL",
  };
  ed.batch("Yuvayı boşalt", () => {
    if (info.holder && info.holder !== info.id) {
      const holder = read(ed, info.holder);
      ed.engine.setProps([info.holder], {
        fillPaints: (holder?.fillPaints ?? []).filter((p) => p.type !== "IMAGE"),
      } as never);
    }
    const own = (node.fillPaints ?? []).filter((p) => p.type !== "IMAGE");
    ed.engine.setProps([info.id], {
      fillPaints: own.length ? own : [solid],
    } as never);
    const shown = placeholders(ed, info.id);
    if (shown.length) ed.engine.setProps(shown, { visible: true } as never);
    ed.engine.setProps([info.id], {
      pluginData: withMark(node, { ...mark, src: null, image: null }),
    } as never);
  });
  return true;
}

// ---- the brand's logo ----------------------------------------------------------------------------

/** A logo of the kit: its file, size ratio and the background it is made for. */
export interface KitLogo {
  token: string;
  path: string;
  aspect: number;
  on: "light" | "dark" | "any";
}

/** The slide frame a layer is in (or the first slide). */
export function frameOf(ed: EditorController, id: string | null): string | null {
  const frames = pageFrames(ed).map((f) => f.ref);
  for (let cur = id ?? undefined, guard = 0; cur && guard < 64; guard++) {
    if (frames.includes(cur)) return cur;
    cur = read(ed, cur)?.parentIndex?.guid;
  }
  return frames[0] ?? null;
}

const luminance = (c: { r: number; g: number; b: number }) => {
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
};

/**
 * The background under a point of a slide (frame px): the topmost layer there with an opaque
 * solid fill (pictures count as unknown: mid grey), else the frame's own; its luminance (0–1).
 */
export function backgroundLuminance(
  ed: EditorController,
  frame: string,
  at: { x: number; y: number },
): number {
  const nodes = ed.engine.readNodes([frame], {
    subtree: true,
    childIds: true,
    fields: ["fillPaints", "visible", "transform", "size", "parentIndex", "type"],
  }) as unknown as SlotNode[];
  const byId = new Map(nodes.map((n) => [n.guid, n]));
  const origin = (n: SlotNode): { x: number; y: number } => {
    let x = 0;
    let y = 0;
    for (
      let cur: SlotNode | undefined = n, guard = 0;
      cur && cur.guid !== frame && guard < 64;
      guard++
    ) {
      x += cur.transform?.m02 ?? 0;
      y += cur.transform?.m12 ?? 0;
      cur = cur.parentIndex?.guid ? byId.get(cur.parentIndex.guid) : undefined;
    }
    return { x, y };
  };
  // Paint order: depth first, children after their parent, later siblings on top.
  const order: SlotNode[] = [];
  const walk = (id: string) => {
    const n = byId.get(id);
    if (!n || n.visible === false) return;
    order.push(n);
    for (const c of n.childIds ?? []) walk(c);
  };
  walk(frame);
  for (const n of [...order].reverse()) {
    const o = n.guid === frame ? { x: 0, y: 0 } : origin(n);
    const w = n.size?.x ?? 0;
    const h = n.size?.y ?? 0;
    if (at.x < o.x || at.y < o.y || at.x > o.x + w || at.y > o.y + h) continue;
    const shown = (n.fillPaints ?? []).filter((p) => p.visible !== false);
    const top = shown[shown.length - 1];
    if (!top) continue;
    if (top.type === "IMAGE") return 0.5;
    if (top.type === "SOLID" && top.color && (top.opacity ?? 1) > 0.9) return luminance(top.color);
  }
  return 1;
}

/** The kit's logo for a background: made for it (light / dark), else any, else the first. */
export function pickLogo(logos: readonly KitLogo[], backgroundLuminance: number): KitLogo | null {
  const want = backgroundLuminance > 0.4 ? "light" : "dark";
  return logos.find((l) => l.on === want) ?? logos.find((l) => l.on === "any") ?? logos[0] ?? null;
}

/** A free contract layer id on a slide ("logo", "logo-2" …). */
function freeLayerId(ed: EditorController, frame: string, base: string): string {
  const taken = new Set(
    (
      ed.engine.readNodes([frame], {
        subtree: true,
        fields: ["pluginData", "name"],
      }) as unknown as SlotNode[]
    )
      .flatMap((n) => [markOf(n)?.layer, n.name])
      .filter(Boolean),
  );
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * Places a picture on a slide as a layer of its own marked with the contract's `type` (`logo`:
 * the brand's logo; `image`: a picture from the media) and its file — one undo step, selected, on
 * top of the slide's layers. `box`: where (frame px). Returns the new layer.
 */
export function insertPicture(
  ed: EditorController,
  frame: string,
  picture: CanvasPicture,
  box: { x: number; y: number; w: number; h: number },
  type: "logo" | "image",
): string | null {
  const layer = freeLayerId(ed, frame, type === "logo" ? "logo" : "gorsel");
  const mark: CanvasMark = {
    layer,
    type,
    role: null,
    src: picture.src,
    image: picture.hash,
    allowOverlap: false,
    slot: null,
  };
  const children = read(ed, frame)?.childIds ?? [];
  const last = children[children.length - 1];
  const lastPos = last
    ? (
        ed.engine.readNode(last, { fields: ["parentIndex"] }) as {
          parentIndex?: { position?: string };
        } | null
      )?.parentIndex?.position
    : undefined;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const guid = newNodeGuid(ed);
  const node = {
    ...defaults("RECTANGLE" as never),
    guid,
    type: "RECTANGLE",
    phase: "CREATED",
    name: layer,
    visible: true,
    opacity: 1,
    transform: { ...IDENTITY, m02: r2(box.x), m12: r2(box.y) },
    size: { x: r2(box.w), y: r2(box.h) },
    parentIndex: { guid: frame, position: lastPos ? keyAfter(lastPos) : keyBetween("", null) },
    fillPaints: [
      {
        ...mediaPaint({ hash: picture.hash, width: picture.width, height: picture.height }),
        imageScaleMode: type === "logo" ? "FIT" : "FILL",
      },
    ],
    strokePaints: [],
    pluginData: [{ pluginID: STUDIO_PLUGIN, key: LAYER_KEY, value: JSON.stringify(mark) }],
  };
  let status = -1;
  ed.batch(type === "logo" ? "Logo ekle" : "Görsel ekle", () => {
    status = ed.engine.applyChanges(
      { type: "NODE_CHANGES", sessionID: ed.source.sessionID ?? 1, nodeChanges: [node] } as never,
      "user",
    );
  });
  if (status !== 0) return null;
  ed.engine.setSelection([guid]);
  return guid;
}

/** Where a logo goes on a slide by default: bottom left inside the margin, `height` px tall. */
export function logoBox(
  frame: { width: number; height: number },
  aspect: number,
  margin: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  const h = Math.min(height, frame.height / 4);
  const w = Math.min(h * (aspect > 0 ? aspect : 1), frame.width - 2 * margin);
  return { x: margin, y: frame.height - margin - h, w, h: w / (aspect > 0 ? aspect : 1) };
}

/** The brand's logo on a slide (`insertPicture` as a logo). */
export const insertLogo = (
  ed: EditorController,
  frame: string,
  picture: CanvasPicture,
  box: { x: number; y: number; w: number; h: number },
): string | null => insertPicture(ed, frame, picture, box, "logo");

/** Every image slot of the post's slides, in reading order (the panel's list of empty ones). */
export function postSlots(
  ed: EditorController,
): (SlotInfo & { frame: string; frameName: string })[] {
  const out: (SlotInfo & { frame: string; frameName: string })[] = [];
  for (const f of pageFrames(ed)) {
    const nodes = ed.engine.readNodes([f.ref], {
      subtree: true,
      fields: ["pluginData"],
    }) as unknown as SlotNode[];
    for (const n of nodes) {
      if (markOf(n)?.type !== "slot") continue;
      const info = slotInfo(ed, n.guid);
      if (info) out.push({ ...info, frame: f.ref, frameName: f.name });
    }
  }
  return out;
}

/** A frame's position on the page and size (its slides are the page's top-level frames). */
export function frameBox(
  ed: EditorController,
  frame: string,
): { x: number; y: number; width: number; height: number } | null {
  const n = read(ed, frame);
  if (!n) return null;
  return {
    x: n.transform?.m02 ?? 0,
    y: n.transform?.m12 ?? 0,
    width: n.size?.x ?? 0,
    height: n.size?.y ?? 0,
  };
}
