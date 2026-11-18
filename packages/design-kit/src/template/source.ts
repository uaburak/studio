/**
 * What a post says, slide by slide (N10 repurposing): its texts with their roles and its
 * pictures from the brand's media, read from the slide HTML (design contract v1) or, for a
 * version saved on the canvas, from its facts (Wecra's layers). A story or a Reels made from the
 * post starts from this.
 */
import { readCanvas } from "../canvas/html.ts";
import { canvasLayers } from "../canvas/layers.ts";
import { parseSlide } from "../document/model.ts";
import { looksLikeAddress, mediaAssetId } from "./fields.ts";

export interface SourceText {
  role: string | null;
  text: string;
  /** px, when known (canvas). */
  size: number | null;
}

export interface SourceImage {
  /** `/media/<asset>.<ext>` */
  src: string;
  assetId: string;
  /** The picture filled an image slot (else a picture layer). */
  slot: boolean;
}

export interface SourceSlide {
  index: number;
  texts: SourceText[];
  images: SourceImage[];
}

export interface PostSource {
  kind: "html" | "canvas";
  slides: SourceSlide[];
}

/** Reading order of roles (unknown roles after the known ones, in document order). */
const ROLE_ORDER = ["eyebrow", "headline", "subhead", "body", "badge", "caption", "cta", "legal"];
const SKIPPED_ROLES = new Set(["counter", "sign-off", "decoration"]);

function order(texts: SourceText[]): SourceText[] {
  const rank = (t: SourceText) => {
    const i = t.role ? ROLE_ORDER.indexOf(t.role) : -1;
    return i < 0 ? ROLE_ORDER.length : i;
  };
  return texts
    .map((t, i) => ({ t, i }))
    .sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i)
    .map(({ t }) => t);
}

function image(src: string | null | undefined, slot: boolean): SourceImage | null {
  const assetId = mediaAssetId(src);
  return assetId && src ? { src, assetId, slot } : null;
}

/** The texts and pictures of a version's slides (see the top). */
export function readPostSource(slides: ReadonlyArray<{ html: string }>): PostSource {
  const canvas = slides.map((s) => readCanvas(s.html));
  if (canvas.some((c) => c.kind === "facts")) {
    return {
      kind: "canvas",
      slides: canvas.map((c, index) => {
        if (c.kind !== "facts") return { index, texts: [], images: [] };
        const byId = new Map(c.facts.nodes.map((n) => [n.id, n]));
        const fixed = (id: string | null): boolean => {
          for (let p = id; p; p = byId.get(p)?.parent ?? null) {
            const role = byId.get(p)?.mark?.role;
            if (role && SKIPPED_ROLES.has(role)) return true;
          }
          return false;
        };
        const texts: SourceText[] = [];
        const images: SourceImage[] = [];
        const layers = canvasLayers(c.facts);
        const sized = layers
          .filter((l) => l.type === "text")
          .map((l) => l.node.text?.size ?? 0)
          .sort((a, b) => b - a);
        for (const l of layers) {
          if (l.type === "text" && l.node.text) {
            if ((l.role && SKIPPED_ROLES.has(l.role)) || fixed(l.node.parent)) continue;
            const text = l.node.text.characters.replace(/\s+/g, " ").trim();
            if (!text || looksLikeAddress(text)) continue;
            // A text made on the canvas has no role: the largest one reads as the headline.
            const role =
              l.role ??
              (l.node.text.size === sized[0] && !layers.some((x) => x.role === "headline")
                ? "headline"
                : null);
            texts.push({ role, text, size: l.node.text.size });
          } else if (l.type === "slot") {
            const found = image(l.slot?.src, true);
            if (found) images.push(found);
          } else if (l.type === "image") {
            const found = image(l.src, false);
            if (found) images.push(found);
          }
        }
        return { index, texts: order(texts), images };
      }),
    };
  }
  return {
    kind: "html",
    slides: slides.map((s, index) => {
      const doc = parseSlide(s.html);
      const byId = new Map(doc.model.layers.map((l) => [l.id, l]));
      const fixed = (id: string | null): boolean => {
        for (let p = id; p; p = byId.get(p)?.parent ?? null) {
          const layer = byId.get(p);
          if (layer?.hidden || (layer?.role && SKIPPED_ROLES.has(layer.role))) return true;
        }
        return false;
      };
      const texts: SourceText[] = [];
      const images: SourceImage[] = [];
      for (const layer of doc.model.layers) {
        if (layer.hidden || fixed(layer.parent)) continue;
        if (layer.type === "text") {
          if (layer.role && SKIPPED_ROLES.has(layer.role)) continue;
          const text = layer.text.replace(/\s+/g, " ").trim();
          if (text && !looksLikeAddress(text)) texts.push({ role: layer.role, text, size: null });
        } else if (layer.type === "slot") {
          const found = image(layer.image?.src, true);
          if (found) images.push(found);
        } else if (layer.type === "image") {
          const found = image(layer.src, false);
          if (found) images.push(found);
        }
      }
      return { index, texts: order(texts), images };
    }),
  };
}

/** Every distinct picture of the post, slot pictures first. */
export function sourceImages(source: PostSource): SourceImage[] {
  const all = source.slides.flatMap((s) => s.images);
  const seen = new Set<string>();
  const out: SourceImage[] = [];
  for (const img of [...all.filter((i) => i.slot), ...all.filter((i) => !i.slot)]) {
    if (seen.has(img.assetId)) continue;
    seen.add(img.assetId);
    out.push(img);
  }
  return out;
}
