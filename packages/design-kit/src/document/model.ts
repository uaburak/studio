import {
  LAYER_ATTRIBUTES as A,
  IMAGE_FITS,
  type ImageFit,
  LAYER_ID_PATTERN,
  LAYER_ROLES,
  LAYER_TYPES,
  type LayerRole,
  type LayerType,
  MAX_ARTBOARD_PX,
  SLOT_RATIO_PATTERN,
  SLOT_STATES,
  type SlotState,
} from "../contract/constants.ts";
import type {
  ArtboardSize,
  Layer,
  LayerTransform,
  SlideModel,
  StructureIssue,
} from "../contract/schemas.ts";
import { parseDeclarationList } from "../html/css.ts";
import {
  closest,
  contains,
  elementRanges,
  getAttr,
  hasAttr,
  isElement,
  type P5Document,
  type P5Element,
  parseDocument,
  plainText,
  walkElements,
} from "../html/dom.ts";

/** Internal per-layer bookkeeping used by the patch engine. */
export interface LayerEntry {
  id: string;
  el: P5Element;
  type: LayerType;
}

/**
 * A parsed slide: the original source, the typed layer model and the parse5 tree.
 * Serialising never rebuilds markup: `html` is always the exact source text.
 */
export interface SlideDocument {
  /** Exact source text. Patch operations return a new document with spliced source. */
  readonly html: string;
  readonly model: SlideModel;
  /** Layer by id (`undefined` for unknown or duplicate ids). */
  layer(id: string): Layer | undefined;
  /** Exact outer HTML of a layer as written in the source. */
  layerHtml(id: string): string | undefined;
}

/** Internal view, shared with the patch engine and the static linter. */
export interface ParsedSlide extends SlideDocument {
  readonly tree: P5Document;
  readonly artboard: P5Element | null;
  readonly entries: ReadonlyMap<string, LayerEntry>;
  /** Ids that occur more than once (ambiguous; operations refuse them). */
  readonly duplicateIds: ReadonlySet<string>;
}

const TYPE_SET = new Set<string>(LAYER_TYPES);
const ROLE_SET = new Set<string>(LAYER_ROLES);
const FIT_SET = new Set<string>(IMAGE_FITS);

export function isLayerElement(el: P5Element): boolean {
  return hasAttr(el, A.id);
}

function parsePx(v: string | undefined): number | null {
  if (!v) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)px\s*$/i.exec(v);
  return m ? Number(m[1]) : null;
}

function parseLength(v: string): number | null {
  const m = /^(-?\d*\.?\d+)(px)?$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] || n === 0 ? n : null;
}

function parseAngleDeg(v: string): number | null {
  const m = /^(-?\d*\.?\d+)(deg|rad|turn|grad)?$/i.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  switch ((m[2] ?? "").toLowerCase()) {
    case "deg":
      return n;
    case "rad":
      return (n * 180) / Math.PI;
    case "turn":
      return n * 360;
    case "grad":
      return n * 0.9;
    default:
      return n === 0 ? 0 : null;
  }
}

/** Read the editor transform (`translate`, `rotate`, `scale` properties) from inline style. */
export function readTransform(style: Record<string, string>): LayerTransform {
  let translate: LayerTransform["translate"] = null;
  if (style.translate && style.translate.trim() !== "none") {
    const parts = style.translate.trim().split(/\s+/);
    const x = parseLength(parts[0] ?? "");
    const y = parts[1] !== undefined ? parseLength(parts[1]) : 0;
    if (x !== null && y !== null) translate = { x, y };
  }
  let rotate: number | null = null;
  if (style.rotate && style.rotate.trim() !== "none") rotate = parseAngleDeg(style.rotate);
  let scale: LayerTransform["scale"] = null;
  if (style.scale && style.scale.trim() !== "none") {
    const parts = style.scale
      .trim()
      .split(/\s+/)
      .map((p) => (p.endsWith("%") ? Number(p.slice(0, -1)) / 100 : Number(p)));
    const sx = parts[0];
    const sy = parts[1] ?? sx;
    if (sx !== undefined && sy !== undefined && Number.isFinite(sx) && Number.isFinite(sy))
      scale = { x: sx, y: sy };
  }
  return { translate, rotate, scale };
}

export function inlineStyle(el: P5Element): Record<string, string> {
  const raw = getAttr(el, "style");
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const d of parseDeclarationList(raw)) out[d.name] = d.value;
  return out;
}

function parseFormat(content: string | null): ArtboardSize | null {
  if (!content) return null;
  const m = /^\s*(\d{1,5})\s*[x×]\s*(\d{1,5})\s*$/i.exec(content);
  if (!m) return null;
  const width = Number(m[1]);
  const height = Number(m[2]);
  if (width < 1 || height < 1 || width > MAX_ARTBOARD_PX || height > MAX_ARTBOARD_PX) return null;
  return { width, height };
}

function metaContent(doc: P5Document, name: string): string | null {
  for (const el of walkElements(doc)) {
    if (el.tagName === "meta" && (getAttr(el, "name") ?? "").toLowerCase() === name)
      return getAttr(el, "content");
  }
  return null;
}

function slotImage(el: P5Element): P5Element | null {
  for (const child of walkElements(el))
    if (child.tagName === "img" && hasAttr(child, A.slotImage)) return child;
  return null;
}

function fitOf(v: string | null | undefined): ImageFit | null {
  return v && FIT_SET.has(v.trim()) ? (v.trim() as ImageFit) : null;
}

/** Parse a slide document into its typed layer model. Never throws on bad markup. */
export function parseSlide(html: string): ParsedSlide {
  const tree = parseDocument(html);
  const issues: StructureIssue[] = [];
  const issue = (
    rule: string,
    severity: StructureIssue["severity"],
    layer: string | null,
    message: string,
  ) => issues.push({ rule, severity, layer, message });

  const artboards: P5Element[] = [];
  for (const el of walkElements(tree)) if (hasAttr(el, A.artboard)) artboards.push(el);
  if (artboards.length !== 1)
    issue(
      "artboard-count",
      "error",
      null,
      `Expected exactly one [data-artboard], found ${artboards.length}.`,
    );
  const artboard = artboards[0] ?? null;

  // First pass: collect layer elements, validate ids and types.
  const entries = new Map<string, LayerEntry>();
  const duplicateIds = new Set<string>();
  const valid = new Set<P5Element>();
  for (const el of walkElements(tree)) {
    if (!isLayerElement(el)) continue;
    const id = getAttr(el, A.id) ?? "";
    const type = (getAttr(el, A.type) ?? "").trim();
    if (!LAYER_ID_PATTERN.test(id))
      issue(
        "layer-id-format",
        "error",
        id || null,
        "data-layer must be kebab-case: [a-z][a-z0-9-]*, at most 48 characters.",
      );
    if (entries.has(id) || duplicateIds.has(id)) {
      if (!duplicateIds.has(id))
        issue("layer-id-duplicate", "error", id, `Duplicate data-layer id "${id}".`);
      duplicateIds.add(id);
      continue;
    }
    if (!TYPE_SET.has(type)) {
      issue(
        "layer-type",
        "error",
        id || null,
        `data-type="${type}" is not one of ${LAYER_TYPES.join(", ")}.`,
      );
      continue;
    }
    if (el === artboard) {
      issue("layer-outside-artboard", "error", id, "The artboard itself must not be a layer.");
      continue;
    }
    entries.set(id, { id, el, type: type as LayerType });
    valid.add(el);
  }
  for (const id of duplicateIds) entries.delete(id);

  // Second pass: build typed layers.
  const layers: Layer[] = [];
  const byEl = new Map<P5Element, Layer>();
  for (const entry of entries.values()) {
    const { el, id, type } = entry;
    const parentEl = closest(
      el,
      (e) => valid.has(e) && entries.get(getAttr(e, A.id) ?? "")?.el === e,
    );
    const anyParentLayer = closest(el, isLayerElement);
    if (anyParentLayer) {
      const ptype = getAttr(anyParentLayer, A.type);
      if (ptype !== "group")
        issue(
          "layer-nesting",
          "error",
          id,
          `Layers may only be nested inside a group; parent "${getAttr(anyParentLayer, A.id)}" is ${ptype ?? "untyped"}.`,
        );
    }
    if (!artboard || !contains(artboard, el))
      issue("layer-outside-artboard", "error", id, "Layer must be inside the artboard.");
    const rawRole = getAttr(el, A.role);
    const role =
      rawRole !== null && ROLE_SET.has(rawRole.trim()) ? (rawRole.trim() as LayerRole) : null;
    if (rawRole !== null && role === null)
      issue(
        "layer-role",
        "warning",
        id,
        `data-role="${rawRole}" is not one of ${LAYER_ROLES.join(", ")}.`,
      );
    const style = inlineStyle(el);
    const base = {
      id,
      role,
      rawRole,
      tag: el.tagName,
      parent: parentEl ? (getAttr(parentEl, A.id) as string) : null,
      children: [] as string[],
      hidden: hasAttr(el, A.hidden),
      allowOverlap: hasAttr(el, A.allowOverlap),
      classes: (getAttr(el, "class") ?? "").split(/\s+/).filter(Boolean),
      style,
      transform: readTransform(style),
    };
    let layer: Layer;
    switch (type) {
      case "text": {
        const r = elementRanges(el);
        layer = {
          ...base,
          type,
          text: plainText(el),
          html: r ? html.slice(r.inner.start, r.inner.end) : "",
        };
        break;
      }
      case "image":
        layer = {
          ...base,
          type,
          src: getAttr(el, "src"),
          alt: getAttr(el, "alt"),
          fit: fitOf(style["object-fit"]),
          position: style["object-position"] ?? null,
        };
        break;
      case "logo":
        layer = { ...base, type, src: getAttr(el, "src"), alt: getAttr(el, "alt") };
        break;
      case "shape":
        layer = { ...base, type, svg: el.tagName === "svg" };
        break;
      case "slot": {
        const m = SLOT_RATIO_PATTERN.exec(getAttr(el, A.slotRatio) ?? "");
        const stateRaw = (getAttr(el, A.slotState) ?? "").trim();
        const img = slotImage(el);
        const imgStyle = img ? inlineStyle(img) : {};
        layer = {
          ...base,
          type,
          ratio: m ? { w: Number(m[1]), h: Number(m[2]) } : null,
          state: (SLOT_STATES as readonly string[]).includes(stateRaw)
            ? (stateRaw as SlotState)
            : null,
          label: getAttr(el, A.slotLabel),
          fit: fitOf(getAttr(el, A.slotFit)),
          image: img
            ? {
                src: getAttr(img, "src"),
                alt: getAttr(img, "alt"),
                fit: fitOf(imgStyle["object-fit"]),
                position: imgStyle["object-position"] ?? null,
              }
            : null,
        };
        break;
      }
      default:
        layer = { ...base, type: "group" };
    }
    layers.push(layer);
    byEl.set(el, layer);
  }
  const byId = new Map(layers.map((l) => [l.id, l]));
  for (const l of layers) if (l.parent) byId.get(l.parent)?.children.push(l.id);
  const roots = layers
    .filter(
      (l) =>
        l.parent === null && artboard && contains(artboard, (entries.get(l.id) as LayerEntry).el),
    )
    .map((l) => l.id);

  // Document metadata.
  const htmlEl = tree.childNodes.find(isElement);
  const lang = htmlEl ? getAttr(htmlEl, "lang") : null;
  const abStyle = artboard ? inlineStyle(artboard) : {};
  const w = parsePx(abStyle.width);
  const h = parsePx(abStyle.height);
  const artboardSize =
    w !== null &&
    h !== null &&
    Number.isInteger(w) &&
    Number.isInteger(h) &&
    w >= 1 &&
    h >= 1 &&
    w <= MAX_ARTBOARD_PX &&
    h <= MAX_ARTBOARD_PX
      ? { width: w, height: h }
      : null;

  const model: SlideModel = {
    contract: metaContent(tree, "studio:contract"),
    lang,
    format: parseFormat(metaContent(tree, "studio:format")),
    artboard: artboardSize,
    layers,
    roots,
    issues,
  };

  return {
    html,
    model,
    tree,
    artboard,
    entries,
    duplicateIds,
    layer: (id) => byId.get(id),
    layerHtml: (id) => {
      const e = entries.get(id);
      const r = e ? elementRanges(e.el) : null;
      return r ? html.slice(r.outer.start, r.outer.end) : undefined;
    },
  };
}

/** Artboard size: inline size, else `studio:format`, else `fallback`. */
export function slideSize(model: SlideModel, fallback?: ArtboardSize): ArtboardSize | null {
  return model.artboard ?? model.format ?? fallback ?? null;
}

/** Ids of `id` and all its descendant layers. */
export function subtreeIds(model: SlideModel, id: string): string[] {
  const byId = new Map(model.layers.map((l) => [l.id, l]));
  const out: string[] = [];
  const visit = (k: string) => {
    out.push(k);
    for (const c of byId.get(k)?.children ?? []) visit(c);
  };
  if (byId.has(id)) visit(id);
  return out;
}

/** Serialise: the document's exact source (kept for symmetry with `parseSlide`). */
export function serializeSlide(doc: SlideDocument): string {
  return doc.html;
}
