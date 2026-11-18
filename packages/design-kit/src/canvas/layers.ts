/**
 * The design-contract layers of a canvas slide: which of its Wecra layers the slide HTML
 * describes as `data-layer` elements (texts, image slots, logos, pictures), with stable ids.
 * The HTML builder (`html.ts`) and the canvas checks (`lint.ts`) both name layers through here,
 * so a check's layer is the HTML's layer.
 */
import {
  LAYER_ID_MAX_LENGTH,
  LAYER_ID_PATTERN,
  LAYER_ROLES,
  type LayerRole,
  LOGO_PREFIX,
} from "../contract/constants.ts";
import { isVirtualAssetUrl } from "../sanitize/url.ts";
import type { CanvasFacts, CanvasNode, CanvasPaint, CanvasRect } from "./facts.ts";

export type CanvasImagePaint = Extract<CanvasPaint, { type: "image" }>;

export interface CanvasSlot {
  state: "empty" | "filled";
  /** `W:H` of the slot's box. */
  ratio: string;
  label: string;
  fit: "cover" | "contain";
  /** The picture in the slot (its own fill or a layer inside it). */
  image: CanvasImagePaint | null;
  /** The file of that picture when it is still the imported one. */
  src: string | null;
}

export interface CanvasLayer {
  /** The contract layer id (`data-layer`): unique, kebab-case. */
  id: string;
  node: CanvasNode;
  type: "text" | "image" | "logo" | "slot";
  role: LayerRole | null;
  rect: CanvasRect;
  /** The picture's file (`/media/…`, `/brand/…`) when known; `null`: only in the slide's render. */
  src: string | null;
  image: CanvasImagePaint | null;
  slot: CanvasSlot | null;
}

/** The layer id the slide's render takes (the artboard's bottom image layer). */
export const CANVAS_RENDER_LAYER = "canvas";

const ROLES = new Set<string>(LAYER_ROLES);

const TR: Record<string, string> = { ı: "i", İ: "i", ş: "s", ğ: "g", ü: "u", ö: "o", ç: "c" };

/** A name as a contract layer id (`Başlık 2` → `baslik-2`), or "" when nothing is left. */
export function layerSlug(name: string): string {
  return name
    .replace(/[ıİşğüöç]/g, (c) => TR[c] ?? c)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, LAYER_ID_MAX_LENGTH - 4)
    .replace(/-+$/g, "");
}

/** The visible image paint on top of a layer's fills, if any. */
export function topImage(paints: readonly CanvasPaint[]): CanvasImagePaint | null {
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i] as CanvasPaint;
    if (p.type === "image" && p.opacity > 0) return p;
  }
  return null;
}

/** Shown in the slide's render (visible, not fully transparent, has a size). */
export function isPainted(n: CanvasNode): boolean {
  return n.visible && n.effectiveOpacity > 0.01 && n.bounds.w > 0 && n.bounds.h > 0;
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

/** `W:H` of a box, reduced (`560×700` → `4:5`). */
export function boxRatio(w: number, h: number): string {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const g = gcd(W, H);
  return `${W / g}:${H / g}`;
}

const sameImage = (mark: CanvasNode["mark"], paint: CanvasImagePaint | null) =>
  !!mark?.image && !!paint?.image && mark.image === paint.image;

/** A layer box as versions store them (`SlideLayerBox` of @studio/contract). */
export interface CanvasLayoutBox {
  id: string;
  type: string;
  role: string | null;
  parent: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}

/** The slide HTML's layer boxes (the render, then the described layers): measured, no render needed. */
export function canvasLayout(facts: CanvasFacts): CanvasLayoutBox[] {
  const w = Math.round(facts.frame.width);
  const h = Math.round(facts.frame.height);
  return [
    {
      id: CANVAS_RENDER_LAYER,
      type: "image",
      role: "background",
      parent: null,
      x: 0,
      y: 0,
      w,
      h,
      visible: true,
    },
    ...canvasLayers(facts).map((l) => ({
      id: l.id,
      type: l.type,
      role: l.role,
      parent: null,
      x: l.rect.x,
      y: l.rect.y,
      w: Math.max(0, l.rect.w),
      h: Math.max(0, l.rect.h),
      visible: true,
    })),
  ].slice(0, 200);
}

/** The texts, image slots, logos and pictures of a canvas slide, in paint order. */
export function canvasLayers(facts: CanvasFacts): CanvasLayer[] {
  const byId = new Map(facts.nodes.map((n) => [n.id, n]));
  const inside = (n: CanvasNode, ancestor: string): boolean => {
    for (let p = n.parent; p; p = byId.get(p)?.parent ?? null) if (p === ancestor) return true;
    return false;
  };
  const slots = facts.nodes.filter((n) => n.mark?.type === "slot" && isPainted(n));
  const inSlot = (n: CanvasNode) => slots.some((s) => s !== n && inside(n, s.id));

  const used = new Set<string>([CANVAS_RENDER_LAYER]);
  const counters = new Map<string, number>();
  const idFor = (n: CanvasNode, type: string): string => {
    const wanted = [n.mark?.layer ?? "", layerSlug(n.name)];
    for (const w of wanted) {
      if (!w || !LAYER_ID_PATTERN.test(w) || used.has(w)) continue;
      used.add(w);
      return w;
    }
    const base = layerSlug(n.mark?.layer ?? n.name);
    const stem = base && /^[a-z]/.test(base) ? base : `${type}${base ? `-${base}` : ""}`;
    for (let k = counters.get(stem) ?? 2; ; k++) {
      const id = `${stem.slice(0, LAYER_ID_MAX_LENGTH - String(k).length - 1)}-${k}`;
      if (!used.has(id) && LAYER_ID_PATTERN.test(id)) {
        counters.set(stem, k + 1);
        used.add(id);
        return id;
      }
    }
  };
  const roleOf = (n: CanvasNode): LayerRole | null =>
    n.mark?.role && ROLES.has(n.mark.role) ? (n.mark.role as LayerRole) : null;
  const round = (r: CanvasRect): CanvasRect => ({
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.round(r.w),
    h: Math.round(r.h),
  });

  const out: CanvasLayer[] = [];
  for (const n of facts.nodes) {
    if (!isPainted(n)) continue;
    if (n.type === "text") {
      if (!n.text?.characters.trim()) continue;
      out.push({
        id: idFor(n, "text"),
        node: n,
        type: "text",
        role: roleOf(n),
        rect: round(n.bounds),
        src: null,
        image: null,
        slot: null,
      });
      continue;
    }
    if (n.mark?.type === "slot") {
      // The slot's picture: its own fill or a layer inside it.
      let image = topImage(n.fills);
      let holder: CanvasNode = n;
      if (!image)
        for (const d of facts.nodes) {
          if (!isPainted(d) || !inside(d, n.id)) continue;
          const p = topImage(d.fills);
          if (p) {
            image = p;
            holder = d;
          }
        }
      const fit = n.mark.slot?.fit === "contain" ? "contain" : "cover";
      const src =
        image && (sameImage(n.mark, image) || sameImage(holder.mark, image))
          ? (n.mark.src ?? holder.mark?.src ?? null)
          : null;
      out.push({
        id: idFor(n, "slot"),
        node: n,
        type: "slot",
        role: roleOf(n),
        rect: round(n.bounds),
        src: src && isVirtualAssetUrl(src) ? src : null,
        image,
        slot: {
          state: image ? "filled" : "empty",
          ratio: boxRatio(n.bounds.w, n.bounds.h),
          label: (n.mark.slot?.label ?? "").trim() || n.name || "Görsel",
          fit,
          image,
          src: src && isVirtualAssetUrl(src) ? src : null,
        },
      });
      continue;
    }
    if (inSlot(n)) continue;
    const image = topImage(n.fills);
    if (!image || n.type === "group") continue;
    const unchanged = sameImage(n.mark, image);
    const src = unchanged && n.mark?.src && isVirtualAssetUrl(n.mark.src) ? n.mark.src : null;
    const logo = n.mark?.type === "logo" && unchanged && !!src?.startsWith(LOGO_PREFIX);
    out.push({
      id: idFor(n, logo ? "logo" : "image"),
      node: n,
      type: logo ? "logo" : "image",
      role: roleOf(n),
      rect: round(n.bounds),
      src,
      image,
      slot: null,
    });
  }
  return out;
}
