/**
 * The fillable fields of a template (N9): a post's slides as a layout whose text layers and
 * image slots take new texts and pictures. Fields are named from their layers' roles
 * (`headline`, `body`, `cta`, `slot` …) so a person, a plan or the AI can fill them by name.
 *
 * - HTML slides (design contract v1): every visible text layer and image slot / media picture
 *   is a field, named by its `data-role` (a text without one: `text`). The brand's fixed parts
 *   stay: logos, the sign-off group (logo + web address), carousel counters, shapes.
 * - Canvas slides (saved from Wecra's editor, with facts): the same over the facts' layers
 *   (`canvasLayers`): the role the import kept on the Wecra layer, else the slide's largest
 *   text is the headline. A field names its Wecra layer (`nodeId`) — for a slot, the layer that
 *   holds its picture — and keeps how the source text was laid out (`metrics`) for auto-fit.
 */

import type { CanvasFacts, CanvasNode } from "../canvas/facts.ts";
import { readCanvas } from "../canvas/html.ts";
import { canvasLayers, isPainted, topImage } from "../canvas/layers.ts";
import type { LayerRole } from "../contract/constants.ts";
import type { Layer } from "../contract/schemas.ts";
import { parseSlide } from "../document/model.ts";
import { autoFitFloor, type TextMetrics, textCapacity } from "./fit.ts";

export interface TemplateFieldDraft {
  key: string;
  label: string;
  kind: "text" | "image";
  role: string | null;
  slide: number;
  layer: string;
  nodeId: string | null;
  /** What the layer is: a text, an image slot or a picture. */
  layerType: "text" | "slot" | "image";
  example: string;
  maxChars: number | null;
  minFontSize: number | null;
  multiline: boolean;
  ratio: string | null;
  metrics: TextMetrics | null;
  autoFit: boolean;
  locked: boolean;
}

export interface TemplateSlideInput {
  html: string;
  width: number;
  height: number;
  /** The measured layer boxes of the version (HTML), when there are. */
  layers?: ReadonlyArray<{ id: string; x: number; y: number; w: number; h: number }> | null;
}

export type TemplateExtraction =
  | { ok: true; kind: "html" | "canvas"; fields: TemplateFieldDraft[] }
  | { ok: false; reason: string };

/** Turkish field names by role. */
const ROLE_LABEL: Record<string, string> = {
  eyebrow: "Üst başlık",
  headline: "Başlık",
  subhead: "Alt başlık",
  body: "Metin",
  cta: "Çağrı",
  caption: "Not",
  legal: "Yasal metin",
  badge: "Rozet",
  decoration: "Süs metni",
  background: "Arka plan görseli",
  text: "Metin",
  slot: "Görsel",
  image: "Görsel",
};

/** Roles whose texts are the brand's fixed parts, not content. */
const FIXED_TEXT_ROLES = new Set<string>(["counter", "sign-off"]);

const MAX_EXAMPLE = 2_000;

/** A web address, e-mail or handle: the brand's own, kept as it is unless unlocked. */
const ADDRESS =
  /^(?:(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+|@[\w.]+|[\w-]+(?:\.[\w-]+)*\.(?:com|net|org|tr|io|co)(?:\.tr)?(?:\/\S*)?)$/i;

export function looksLikeAddress(text: string): boolean {
  return ADDRESS.test(text.trim());
}
const MAX_FIELDS = 80;

function clip(s: string, max = MAX_EXAMPLE): string {
  return s.length <= max ? s : s.slice(0, max);
}

/** Field keys unique over the template: `headline`, then `headline-2` … */
class KeyMaker {
  private readonly used = new Map<string, number>();
  next(base: string): string {
    const stem =
      base
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "field";
    const safe = /^[a-z]/.test(stem) ? stem : `f-${stem}`;
    const n = (this.used.get(safe) ?? 0) + 1;
    this.used.set(safe, n);
    return n === 1 ? safe : `${safe}-${n}`;
  }
}

function labelFor(base: string, slide: number, slides: number, extra?: string | null): string {
  const name = ROLE_LABEL[base] ?? "Metin";
  const withExtra = extra ? `${name} · ${extra}` : name;
  return clip(slides > 1 ? `${withExtra} · Kare ${slide + 1}` : withExtra, 80);
}

/** `/media/<asset>.<ext>` → the asset id (null for other files). */
export function mediaAssetId(src: string | null | undefined): string | null {
  if (!src?.startsWith("/media/")) return null;
  const name = src.slice("/media/".length).split(/[?#]/)[0] ?? "";
  const stem = name.replace(/\.[A-Za-z0-9]+$/, "");
  try {
    return decodeURIComponent(stem) || null;
  } catch {
    return stem || null;
  }
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

function ratioOf(w: number, h: number): string | null {
  const W = Math.round(w);
  const H = Math.round(h);
  if (W <= 0 || H <= 0) return null;
  const g = gcd(W, H);
  return `${W / g}:${H / g}`;
}

// --- HTML ---------------------------------------------------------------------------------

function htmlFields(
  slide: TemplateSlideInput,
  index: number,
  slides: number,
  keys: KeyMaker,
): TemplateFieldDraft[] {
  const doc = parseSlide(slide.html);
  const byId = new Map(doc.model.layers.map((l) => [l.id, l]));
  const boxes = new Map((slide.layers ?? []).map((b) => [b.id, b]));
  const insideFixed = (layer: Layer): boolean => {
    for (let p = layer.parent; p; p = byId.get(p)?.parent ?? null) {
      const parent = byId.get(p);
      if (parent?.hidden) return true;
      if (parent?.role && FIXED_TEXT_ROLES.has(parent.role)) return true;
    }
    return false;
  };
  const out: TemplateFieldDraft[] = [];
  for (const layer of doc.model.layers) {
    if (layer.hidden || insideFixed(layer)) continue;
    const box = boxes.get(layer.id);
    if (layer.type === "text") {
      if (layer.role && FIXED_TEXT_ROLES.has(layer.role)) continue;
      const text = layer.text.trim();
      if (!text) continue;
      const base = layer.role ?? "text";
      const inlineSize = /^\s*(\d+(?:\.\d+)?)px\s*$/i.exec(layer.style["font-size"] ?? "");
      const fontSize = inlineSize ? Number(inlineSize[1]) : null;
      const metrics: TextMetrics | null = box
        ? {
            box: { x: box.x, y: box.y, w: box.w, h: box.h },
            fontSize,
            lineHeight: null,
            charWidth: null,
            lines: text.split("\n").length,
            autoResize: null,
          }
        : null;
      out.push({
        key: keys.next(base),
        label: labelFor(base, index, slides),
        kind: "text",
        role: layer.role,
        slide: index,
        layer: layer.id,
        nodeId: null,
        layerType: "text",
        example: clip(text),
        maxChars:
          (metrics ? textCapacity(metrics) : null) ??
          Math.min(5_000, Math.max(text.length + 8, Math.round(text.length * 1.3))),
        minFontSize: fontSize !== null ? autoFitFloor(layer.role, fontSize) : null,
        multiline: text.includes("\n"),
        ratio: null,
        metrics,
        autoFit: true,
        locked: looksLikeAddress(text),
      });
      continue;
    }
    if (layer.type === "slot") {
      const ratio = layer.ratio
        ? `${layer.ratio.w}:${layer.ratio.h}`
        : box
          ? ratioOf(box.w, box.h)
          : null;
      out.push({
        key: keys.next("slot"),
        label: labelFor("slot", index, slides, layer.label),
        kind: "image",
        role: layer.role,
        slide: index,
        layer: layer.id,
        nodeId: null,
        layerType: "slot",
        example: clip(layer.image?.src ?? ""),
        maxChars: null,
        minFontSize: null,
        multiline: false,
        ratio,
        metrics: null,
        autoFit: false,
        locked: false,
      });
      continue;
    }
    if (layer.type === "image" && mediaAssetId(layer.src)) {
      out.push({
        key: keys.next(layer.role === "background" ? "background" : "image"),
        label: labelFor(layer.role === "background" ? "background" : "image", index, slides),
        kind: "image",
        role: layer.role,
        slide: index,
        layer: layer.id,
        nodeId: null,
        layerType: "image",
        example: clip(layer.src ?? ""),
        maxChars: null,
        minFontSize: null,
        multiline: false,
        ratio: box ? ratioOf(box.w, box.h) : null,
        metrics: null,
        autoFit: false,
        locked: false,
      });
    }
  }
  return out;
}

// --- canvas -------------------------------------------------------------------------------

/** How the source text was laid out (Wecra's lines): box, size, advance per character. */
export function canvasTextMetrics(node: CanvasNode): TextMetrics | null {
  const t = node.text;
  if (!t) return null;
  let width = 0;
  let chars = 0;
  for (const line of t.lines) {
    const slice = t.characters.slice(line.from, line.to).replace(/\s+$/u, "");
    if (!slice) continue;
    width += line.w;
    chars += slice.length;
  }
  const lineHeight =
    t.lineHeight ??
    (t.lines.length > 1
      ? Math.max(1, ((t.lines.at(-1)?.y ?? 0) - (t.lines[0]?.y ?? 0)) / (t.lines.length - 1))
      : null);
  return {
    box: { x: node.bounds.x, y: node.bounds.y, w: node.bounds.w, h: node.bounds.h },
    fontSize: t.size,
    lineHeight: lineHeight && lineHeight > 0 ? lineHeight : null,
    charWidth: chars > 0 && width > 0 ? width / chars : null,
    lines: t.lines.length,
    autoResize: t.autoResize,
  };
}

function canvasFields(
  facts: CanvasFacts,
  index: number,
  slides: number,
  keys: KeyMaker,
): TemplateFieldDraft[] {
  const byId = new Map(facts.nodes.map((n) => [n.id, n]));
  const insideFixed = (n: CanvasNode): boolean => {
    for (let p = n.parent; p; p = byId.get(p)?.parent ?? null) {
      const role = byId.get(p)?.mark?.role;
      if (role && FIXED_TEXT_ROLES.has(role)) return true;
    }
    return false;
  };
  const layers = canvasLayers(facts);
  const texts = layers.filter((l) => l.type === "text" && l.node.text);
  const hasHeadline = texts.some((l) => l.role === "headline");
  const largest = hasHeadline
    ? null
    : texts.reduce<(typeof texts)[number] | null>(
        (best, l) => ((l.node.text?.size ?? 0) > (best?.node.text?.size ?? 0) ? l : best),
        null,
      );
  const out: TemplateFieldDraft[] = [];
  for (const l of layers) {
    if (insideFixed(l.node)) continue;
    if (l.type === "text") {
      const t = l.node.text;
      if (!t) continue;
      if (l.role && FIXED_TEXT_ROLES.has(l.role)) continue;
      const text = t.characters.trim();
      if (!text) continue;
      const role: LayerRole | "text" = l.role ?? (l === largest ? "headline" : "text");
      const metrics = canvasTextMetrics(l.node);
      out.push({
        key: keys.next(role),
        label: labelFor(role, index, slides),
        kind: "text",
        role: l.role ?? (role === "headline" ? "headline" : null),
        slide: index,
        layer: l.id,
        nodeId: l.node.id,
        layerType: "text",
        example: clip(text),
        maxChars: metrics ? textCapacity(metrics) : null,
        minFontSize: autoFitFloor(l.role, t.size),
        multiline: t.lines.length > 1 || text.includes("\n"),
        ratio: null,
        metrics,
        autoFit: true,
        locked: looksLikeAddress(text),
      });
      continue;
    }
    if (l.type === "slot" && l.slot) {
      // The layer whose fill is the slot's picture (the slot or a layer inside it).
      let holder: CanvasNode = l.node;
      if (!topImage(l.node.fills)) {
        for (const d of facts.nodes) {
          if (!isPainted(d) || d === l.node) continue;
          let inside = false;
          for (let p = d.parent; p; p = byId.get(p)?.parent ?? null)
            if (p === l.node.id) inside = true;
          if (inside && topImage(d.fills)) holder = d;
        }
      }
      out.push({
        key: keys.next("slot"),
        label: labelFor("slot", index, slides, l.slot.label),
        kind: "image",
        role: l.role,
        slide: index,
        layer: l.id,
        nodeId: holder.id,
        layerType: "slot",
        example: clip(l.slot.src ?? ""),
        maxChars: null,
        minFontSize: null,
        multiline: false,
        ratio: l.slot.ratio,
        metrics: null,
        autoFit: false,
        locked: false,
      });
      continue;
    }
    if (l.type === "image") {
      const base = l.role === "background" ? "background" : "image";
      out.push({
        key: keys.next(base),
        label: labelFor(base, index, slides),
        kind: "image",
        role: l.role,
        slide: index,
        layer: l.id,
        nodeId: l.node.id,
        layerType: "image",
        example: clip(l.src ?? ""),
        maxChars: null,
        minFontSize: null,
        multiline: false,
        ratio: ratioOf(l.rect.w, l.rect.h),
        metrics: null,
        autoFit: false,
        locked: false,
      });
    }
  }
  return out;
}

/**
 * The fields of a version's slides as a template, and whether it is an HTML or a canvas layout.
 * A canvas version saved before the facts cannot be read (the reason says what to do).
 */
export function templateFields(slides: readonly TemplateSlideInput[]): TemplateExtraction {
  if (slides.length === 0) return { ok: false, reason: "Sürümde kare yok." };
  const canvas = slides.map((s) => readCanvas(s.html));
  const kinds = new Set(canvas.map((c) => c.kind));
  if (kinds.has("legacy"))
    return {
      ok: false,
      reason:
        "Bu tuval sürümü eski bir kayıt (katman bilgisi yok); postu tuvalde açıp yeniden kaydedin.",
    };
  if (kinds.has("facts") && kinds.has("none"))
    return { ok: false, reason: "Sürümün kareleri karışık (tuval ve HTML); şablon olamaz." };
  const keys = new KeyMaker();
  const fields: TemplateFieldDraft[] = [];
  if (kinds.has("facts")) {
    canvas.forEach((c, i) => {
      if (c.kind === "facts") fields.push(...canvasFields(c.facts, i, slides.length, keys));
    });
    return { ok: true, kind: "canvas", fields: fields.slice(0, MAX_FIELDS) };
  }
  slides.forEach((s, i) => {
    fields.push(...htmlFields(s, i, slides.length, keys));
  });
  return { ok: true, kind: "html", fields: fields.slice(0, MAX_FIELDS) };
}
