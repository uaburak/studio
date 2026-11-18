// The post as the editor holds it: its slides (the design-contract HTML documents, parsed with
// design-kit's isomorphic parser) and every slide's layer tree. No DOM: tests and the adapter
// use it the same way.
import type { LayerType, SlideModel } from "@studio/design-kit/contract";
import { parseSlide } from "@studio/design-kit/document";

export interface SlideSource {
  html: string;
  width: number;
  height: number;
}

export interface LayerTransformCss {
  translate: { x: number; y: number };
  rotate: number;
  scale: { x: number; y: number };
}

export interface EditorLayer {
  /** `"<slide>:<layer id>"`, unique across the post. */
  key: string;
  slide: number;
  id: string;
  type: LayerType;
  role: string | null;
  tag: string;
  /** Enclosing layer id (a group), null on the artboard. */
  parent: string | null;
  children: string[];
  /** Depth in the layer tree (0: on the artboard). */
  depth: number;
  hidden: boolean;
  style: Record<string, string>;
  transform: LayerTransformCss;
  /** Text layers: plain text (`<br>` as `\n`). */
  text: string | null;
  /** Images and logos: src; slots: the filled image's src. */
  src: string | null;
  slotState: "empty" | "filled" | null;
  slotLabel: string | null;
}

export interface EditorSlide {
  index: number;
  html: string;
  width: number;
  height: number;
  model: SlideModel;
  /** Document order (paint order: later is on top). */
  layers: EditorLayer[];
  roots: string[];
}

export const layerKey = (slide: number, id: string) => `${slide}:${id}`;

export function parseLayerKey(key: string): { slide: number; id: string } | null {
  const at = key.indexOf(":");
  if (at <= 0) return null;
  const slide = Number(key.slice(0, at));
  return Number.isInteger(slide) ? { slide, id: key.slice(at + 1) } : null;
}

function toCss(t: SlideModel["layers"][number]["transform"]): LayerTransformCss {
  return {
    translate: t.translate ?? { x: 0, y: 0 },
    rotate: t.rotate ?? 0,
    scale: t.scale ?? { x: 1, y: 1 },
  };
}

export function editorSlide(source: SlideSource, index: number): EditorSlide {
  const model = parseSlide(source.html).model;
  const byId = new Map(model.layers.map((l) => [l.id, l]));
  const depthOf = (id: string): number => {
    let depth = 0;
    let parent = byId.get(id)?.parent ?? null;
    while (parent && depth < 64) {
      depth++;
      parent = byId.get(parent)?.parent ?? null;
    }
    return depth;
  };
  const layers = model.layers.map((l): EditorLayer => {
    const base: EditorLayer = {
      key: layerKey(index, l.id),
      slide: index,
      id: l.id,
      type: l.type,
      role: l.rawRole,
      tag: l.tag,
      parent: l.parent,
      children: l.children,
      depth: depthOf(l.id),
      hidden: l.hidden,
      style: l.style,
      transform: toCss(l.transform),
      text: null,
      src: null,
      slotState: null,
      slotLabel: null,
    };
    switch (l.type) {
      case "text":
        return { ...base, text: l.text };
      case "image":
      case "logo":
        return { ...base, src: l.src };
      case "slot":
        return {
          ...base,
          src: l.image?.src ?? null,
          slotState: l.state,
          slotLabel: l.label,
        };
      default:
        return base;
    }
  });
  return {
    index,
    html: source.html,
    width: source.width,
    height: source.height,
    model,
    layers,
    roots: model.roots,
  };
}

export function editorSlides(sources: readonly SlideSource[]): EditorSlide[] {
  return sources.map((s, i) => editorSlide(s, i));
}

export function findLayer(slides: readonly EditorSlide[], key: string): EditorLayer | null {
  const parsed = parseLayerKey(key);
  if (!parsed) return null;
  return slides[parsed.slide]?.layers.find((l) => l.id === parsed.id) ?? null;
}

// --- labels ---------------------------------------------------------------------------------------

export const TYPE_LABEL: Record<LayerType, string> = {
  text: "Metin",
  image: "Görsel",
  slot: "Görsel yuvası",
  logo: "Logo",
  shape: "Şekil",
  group: "Grup",
};

const ROLE_LABEL: Record<string, string> = {
  eyebrow: "Üst başlık",
  headline: "Başlık",
  subhead: "Alt başlık",
  body: "Gövde metni",
  cta: "Eylem çağrısı",
  caption: "Açıklama",
  legal: "Yasal not",
  badge: "Rozet",
  decoration: "Süs",
  counter: "Sayaç",
  background: "Arka plan",
  "sign-off": "İmza",
};

/** "headline" → "Headline"; "product-photo" → "Product photo". */
function humanize(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toLocaleUpperCase("tr-TR") + words.slice(1) : id;
}

/** What the layers panel and the inspector call a layer. */
export function layerLabel(layer: Pick<EditorLayer, "id" | "role" | "type" | "text">): string {
  const role = layer.role ? ROLE_LABEL[layer.role] : undefined;
  if (role && layer.id.replace(/-/g, "") === (layer.role ?? "").replace(/-/g, "")) return role;
  if (layer.type === "text" && layer.text && layer.text.length <= 24 && !role)
    return layer.text.replace(/\s+/g, " ");
  return role && !/\d/.test(layer.id) ? `${role} · ${humanize(layer.id)}` : humanize(layer.id);
}

/** Slide name from its counter/headline: "Kapak" for the first, else the headline's text. */
export function slideLabel(slide: EditorSlide): string {
  const headline =
    slide.layers.find((l) => l.role === "headline" && l.text) ??
    slide.layers.find((l) => l.type === "text" && l.text && l.role !== "counter");
  const text = headline?.text?.replace(/\s+/g, " ").trim() ?? "";
  if (slide.index === 0 && slide.layers.length > 0)
    return text ? `Kapak · ${clip(text, 22)}` : "Kapak";
  return text ? clip(text, 28) : `Kare ${slide.index + 1}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** Layers in the order the layers panel lists them: top of the stack first, groups expanded. */
export function layerTree(slide: EditorSlide): EditorLayer[] {
  const byId = new Map(slide.layers.map((l) => [l.id, l]));
  const out: EditorLayer[] = [];
  const visit = (ids: readonly string[]) => {
    for (const id of [...ids].reverse()) {
      const layer = byId.get(id);
      if (!layer) continue;
      out.push(layer);
      visit(layer.children);
    }
  };
  visit(slide.roots);
  return out;
}

/** Index of a layer among its container's direct layer children (0: bottom of the stack). */
export function stackIndex(slide: EditorSlide, id: string): { index: number; count: number } {
  const layer = slide.layers.find((l) => l.id === id);
  const siblings = layer?.parent
    ? (slide.layers.find((l) => l.id === layer.parent)?.children ?? [])
    : slide.roots;
  return { index: siblings.indexOf(id), count: siblings.length };
}
