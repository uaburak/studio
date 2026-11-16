/**
 * Isomorphic DOM/HTML `[data-layer]` parser, patcher, slot filler, and
 * undo/redo history engine for the Faz 2 Interactive HTML Slide Editor.
 *
 * Uses the standard `DOMParser` / `XMLSerializer`-free HTML serialization
 * available in browsers and Vitest's jsdom environment.
 */

export type LayerKind = "text" | "image" | "slot" | "logo" | "shape" | "group";

export const LAYER_KIND_LABELS: Record<LayerKind, string> = {
  text: "Metin",
  image: "Görsel",
  slot: "Görsel yuvası",
  logo: "Logo",
  shape: "Şekil",
  group: "Grup",
};

export interface LayerBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ParsedLayer {
  id: string;
  type: LayerKind;
  role: string | null;
  tagName: string;
  parentId: string | null;
  /** 0-based order among sibling `[data-layer]` elements in the same parent. */
  index: number;
  siblingCount: number;
  hidden: boolean;
  opacity: number;
  bounds: LayerBounds;
  translate: { x: number; y: number };
  text: string;
  fontFamily: string;
  fontSize: number | null;
  color: string;
  backgroundColor: string;
  textAlign: "left" | "center" | "right" | "justify";
  src: string | null;
  alt: string;
  assetId: string | null;
  slotState: "empty" | "filled" | null;
  slotRatio: string | null;
  slotLabel: string | null;
  slotFit: "cover" | "contain";
}

export interface ParsedSlideLayers {
  artboard: { width: number; height: number };
  layers: ParsedLayer[];
}

const VALID_KINDS = new Set<string>(["text", "image", "slot", "logo", "shape", "group"]);

function parsePxNumber(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^\s*(-?\d+(?:\.\d+)?)(?:px)?\s*$/i.exec(raw);
  return m ? Number(m[1]) : null;
}

function parseTranslateFromStyle(el: HTMLElement): { x: number; y: number } {
  const trProp = el.style.getPropertyValue("translate").trim();
  if (trProp && trProp !== "none") {
    const parts = trProp.split(/\s+/);
    const x = parsePxNumber(parts[0]) ?? 0;
    const y = parts[1] !== undefined ? (parsePxNumber(parts[1]) ?? 0) : 0;
    return { x, y };
  }
  const transform = el.style.transform || "";
  const m = /translate(?:3d)?\(\s*(-?\d+(?:\.\d+)?)px(?:\s*,\s*(-?\d+(?:\.\d+)?)px)?/i.exec(
    transform,
  );
  if (m) {
    return { x: Number(m[1] ?? 0), y: Number(m[2] ?? 0) };
  }
  return { x: 0, y: 0 };
}

function inferLayerKind(el: HTMLElement): LayerKind {
  const explicit = (el.getAttribute("data-type") ?? el.getAttribute("data-layer-type") ?? "")
    .trim()
    .toLowerCase();
  if (VALID_KINDS.has(explicit)) return explicit as LayerKind;
  if (el.hasAttribute("data-slot-state") || el.hasAttribute("data-slot-ratio")) return "slot";
  const tag = el.tagName.toLowerCase();
  if (tag === "img") {
    const src = el.getAttribute("src") ?? "";
    return src.includes("/logos/") ? "logo" : "image";
  }
  if (tag === "svg") return "shape";
  if (el.querySelector("[data-layer]")) return "group";
  return "text";
}

function extractAssetIdFromSrc(el: HTMLElement, src: string | null): string | null {
  const attrId = el.getAttribute("data-asset-id");
  if (attrId) return attrId;
  if (!src) return null;
  const apiMatch = /^\/api\/assets\/([^/?#]+)\/content/i.exec(src);
  if (apiMatch?.[1]) return decodeURIComponent(apiMatch[1]);
  const mediaMatch = /^\/media\/([^/?#.]+)(?:\.[a-z0-9]+)?$/i.exec(src);
  if (mediaMatch?.[1]) return decodeURIComponent(mediaMatch[1]);
  return null;
}

function readSimpleClassRules(doc: Document): Map<string, Record<string, string>> {
  const map = new Map<string, Record<string, string>>();
  for (const styleEl of Array.from(doc.querySelectorAll("style"))) {
    const css = styleEl.textContent ?? "";
    const ruleRe = /([.#a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g;
    let m: RegExpExecArray | null = ruleRe.exec(css);
    while (m !== null) {
      const selector = (m[1] ?? "").trim();
      const body = m[2] ?? "";
      const props: Record<string, string> = map.get(selector) ?? {};
      for (const decl of body.split(";")) {
        const colon = decl.indexOf(":");
        if (colon === -1) continue;
        const k = decl.slice(0, colon).trim().toLowerCase();
        const v = decl.slice(colon + 1).trim();
        if (k && v) props[k] = v;
      }
      map.set(selector, props);
      m = ruleRe.exec(css);
    }
  }
  return map;
}

function lookupStyle(
  el: HTMLElement,
  prop: string,
  classRules: Map<string, Record<string, string>>,
): string {
  const inlineVal = el.style.getPropertyValue(prop).trim();
  if (inlineVal) return inlineVal;
  for (const cls of Array.from(el.classList)) {
    const found = classRules.get(`.${cls}`)?.[prop];
    if (found) return found;
  }
  return "";
}

function extractTextWithNewlines(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  for (const br of Array.from(clone.querySelectorAll("br"))) {
    br.replaceWith("\n");
  }
  return clone.textContent ?? "";
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseDoc(html: string): { doc: Document; hasDoctype: boolean } {
  const hasDoctype = /^\s*<!doctype\b/i.test(html);
  const doc = new DOMParser().parseFromString(html, "text/html");
  return { doc, hasDoctype };
}

function serializeDoc(doc: Document, hasDoctype: boolean): string {
  const outer = doc.documentElement.outerHTML;
  return hasDoctype ? `<!doctype html>\n${outer}` : outer;
}

function findLayerElement(doc: Document, layerId: string): HTMLElement | null {
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>("[data-layer]"))) {
    if (el.getAttribute("data-layer") === layerId) return el;
  }
  return null;
}

/**
 * Parse `[data-layer]` elements and artboard dimensions from a slide HTML document.
 */
export function parseSlideLayers(
  html: string,
  fallbackArtboard = { width: 1080, height: 1350 },
): ParsedSlideLayers {
  const { doc } = parseDoc(html);
  const classRules = readSimpleClassRules(doc);

  const artboardEl = doc.querySelector<HTMLElement>("[data-artboard]");
  const formatMeta = doc
    .querySelector('meta[name="studio:format"]')
    ?.getAttribute("content")
    ?.trim();
  const formatMatch = formatMeta ? /^(\d+)\s*[x×]\s*(\d+)$/i.exec(formatMeta) : null;

  const artWidth =
    parsePxNumber(artboardEl?.style.width) ??
    (formatMatch ? Number(formatMatch[1]) : null) ??
    fallbackArtboard.width;
  const artHeight =
    parsePxNumber(artboardEl?.style.height) ??
    (formatMatch ? Number(formatMatch[2]) : null) ??
    fallbackArtboard.height;

  const elements = Array.from(doc.querySelectorAll<HTMLElement>("[data-layer]")).filter(
    (el) => el !== artboardEl && Boolean(el.getAttribute("data-layer")?.trim()),
  );

  const boundsById = new Map<string, LayerBounds>();
  const layers: ParsedLayer[] = [];

  elements.forEach((el, idx) => {
    const id = (el.getAttribute("data-layer") ?? "").trim();
    const type = inferLayerKind(el);
    const parentLayerEl = el.parentElement?.closest<HTMLElement>("[data-layer]") ?? null;
    const parentId =
      parentLayerEl && parentLayerEl !== artboardEl
        ? parentLayerEl.getAttribute("data-layer")
        : null;

    const container = el.parentElement;
    const siblingLayers = container
      ? Array.from(container.children).filter((c) => c.hasAttribute("data-layer"))
      : [el];
    const siblingIndex = Math.max(0, siblingLayers.indexOf(el));

    const translate = parseTranslateFromStyle(el);
    const parentBounds = parentId ? boundsById.get(parentId) : undefined;

    const rawLeft = parsePxNumber(lookupStyle(el, "left", classRules));
    const rawTop = parsePxNumber(lookupStyle(el, "top", classRules));
    const rawWidth = parsePxNumber(lookupStyle(el, "width", classRules));
    const rawHeight = parsePxNumber(lookupStyle(el, "height", classRules));

    const fontSize = parsePxNumber(lookupStyle(el, "font-size", classRules));
    const defaultWidth = parentBounds
      ? Math.max(120, parentBounds.width)
      : type === "logo"
        ? 220
        : Math.round(artWidth * 0.8);
    const defaultHeight =
      type === "text"
        ? Math.max(56, Math.round((fontSize ?? 44) * 1.45))
        : type === "logo"
          ? 64
          : Math.round(artHeight * 0.22);

    const baseX = rawLeft ?? (parentBounds ? parentBounds.x : Math.round(artWidth * 0.07));
    const baseY =
      rawTop ??
      (parentBounds
        ? parentBounds.y + siblingIndex * Math.min(96, Math.round(defaultHeight * 0.9))
        : Math.min(artHeight - 100, 72 + idx * 96));

    const bounds: LayerBounds = {
      x: Math.round(baseX + translate.x),
      y: Math.round(baseY + translate.y),
      width: Math.max(24, Math.round(rawWidth ?? defaultWidth)),
      height: Math.max(24, Math.round(rawHeight ?? defaultHeight)),
    };
    boundsById.set(id, bounds);

    const hidden =
      el.hasAttribute("data-hidden") ||
      el.style.visibility === "hidden" ||
      el.style.display === "none";
    const opacityNum = Number.parseFloat(el.style.opacity);
    const opacity = Number.isFinite(opacityNum) ? Math.min(1, Math.max(0, opacityNum)) : 1;

    const alignRaw = lookupStyle(el, "text-align", classRules).toLowerCase();
    const textAlign: ParsedLayer["textAlign"] =
      alignRaw === "center" || alignRaw === "right" || alignRaw === "justify" ? alignRaw : "left";

    const slotImg =
      type === "slot" ? el.querySelector<HTMLImageElement>("img[data-slot-image], img") : null;
    const src =
      type === "slot"
        ? (slotImg?.getAttribute("src") ?? null)
        : type === "image" || type === "logo"
          ? el.getAttribute("src")
          : null;
    const alt =
      type === "slot" ? (slotImg?.getAttribute("alt") ?? "") : (el.getAttribute("alt") ?? "");

    const rawSlotState = el.getAttribute("data-slot-state");
    const slotState: ParsedLayer["slotState"] =
      type === "slot"
        ? rawSlotState === "filled" || slotImg?.getAttribute("src")
          ? "filled"
          : "empty"
        : null;
    const slotFit: "cover" | "contain" =
      el.getAttribute("data-slot-fit") === "contain" ? "contain" : "cover";

    layers.push({
      id,
      type,
      role: el.getAttribute("data-role"),
      tagName: el.tagName.toLowerCase(),
      parentId,
      index: siblingIndex,
      siblingCount: siblingLayers.length,
      hidden,
      opacity,
      bounds,
      translate,
      text: type === "text" ? extractTextWithNewlines(el) : "",
      fontFamily: lookupStyle(el, "font-family", classRules),
      fontSize,
      color: lookupStyle(el, "color", classRules),
      backgroundColor:
        lookupStyle(el, "background-color", classRules) ||
        lookupStyle(el, "background", classRules),
      textAlign,
      src,
      alt,
      assetId: extractAssetIdFromSrc(slotImg ?? el, src),
      slotState,
      slotRatio: type === "slot" ? el.getAttribute("data-slot-ratio") : null,
      slotLabel: type === "slot" ? el.getAttribute("data-slot-label") : null,
      slotFit,
    });
  });

  return {
    artboard: { width: artWidth, height: artHeight },
    layers,
  };
}

/**
 * Move a layer by `(dx, dy)` in artboard pixels.
 * Top-level absolute layers with `left`/`top` update `left`/`top`; nested group
 * children (or layers without `left`/`top`) update `translate` / `transform` so
 * sibling flex layouts never reflow unexpectedly.
 */
export function moveSlideLayer(
  html: string,
  layerId: string,
  delta: { dx: number; dy: number },
): string {
  const { doc, hasDoctype } = parseDoc(html);
  const el = findLayerElement(doc, layerId);
  if (!el) return html;

  const dx = Math.round(delta.dx);
  const dy = Math.round(delta.dy);
  if (dx === 0 && dy === 0) return html;

  const artboardEl = doc.querySelector("[data-artboard]");
  const parentLayer = el.parentElement?.closest("[data-layer]");
  const isNestedInGroup = Boolean(parentLayer && parentLayer !== artboardEl);
  const curLeft = parsePxNumber(el.style.left);
  const curTop = parsePxNumber(el.style.top);

  if (!isNestedInGroup && (curLeft !== null || curTop !== null)) {
    el.style.left = `${Math.round((curLeft ?? 0) + dx)}px`;
    el.style.top = `${Math.round((curTop ?? 0) + dy)}px`;
  } else {
    const prev = parseTranslateFromStyle(el);
    const nx = Math.round(prev.x + dx);
    const ny = Math.round(prev.y + dy);
    el.style.setProperty("translate", `${nx}px ${ny}px`);
    // Remove legacy translate() in `transform` if we owned it.
    if (/^translate(?:3d)?\([^)]+\)$/i.test(el.style.transform.trim())) {
      el.style.removeProperty("transform");
    }
  }

  return serializeDoc(doc, hasDoctype);
}

/** Resize a layer's box (and optionally reposition top-left for NW/SW/NE handles). */
export function resizeSlideLayer(
  html: string,
  layerId: string,
  next: { x?: number; y?: number; width: number; height: number },
): string {
  const { doc, hasDoctype } = parseDoc(html);
  const el = findLayerElement(doc, layerId);
  if (!el) return html;

  el.style.width = `${Math.max(24, Math.round(next.width))}px`;
  el.style.height = `${Math.max(24, Math.round(next.height))}px`;
  if (next.x !== undefined && parsePxNumber(el.style.left) !== null) {
    el.style.left = `${Math.round(next.x)}px`;
  }
  if (next.y !== undefined && parsePxNumber(el.style.top) !== null) {
    el.style.top = `${Math.round(next.y)}px`;
  }

  return serializeDoc(doc, hasDoctype);
}

/** Replace the text content of a `text` layer, converting `\n` into `<br>`. */
export function updateSlideLayerText(html: string, layerId: string, text: string): string {
  const { doc, hasDoctype } = parseDoc(html);
  const el = findLayerElement(doc, layerId);
  if (!el) return html;
  el.innerHTML = escapeHtml(text).replace(/\r?\n/g, "<br>");
  return serializeDoc(doc, hasDoctype);
}

export interface LayerStylePatch {
  fontFamily?: string;
  fontSize?: number | null;
  color?: string;
  backgroundColor?: string;
  textAlign?: "left" | "center" | "right" | "justify";
  opacity?: number;
  hidden?: boolean;
}

/** Update typography, colours, alignment, opacity or visibility of a layer. */
export function updateSlideLayerStyle(
  html: string,
  layerId: string,
  patch: LayerStylePatch,
): string {
  const { doc, hasDoctype } = parseDoc(html);
  const el = findLayerElement(doc, layerId);
  if (!el) return html;

  if (patch.fontFamily !== undefined) {
    if (patch.fontFamily.trim()) el.style.fontFamily = patch.fontFamily.trim();
    else el.style.removeProperty("font-family");
  }
  if (patch.fontSize !== undefined) {
    if (patch.fontSize && patch.fontSize > 0) el.style.fontSize = `${Math.round(patch.fontSize)}px`;
    else el.style.removeProperty("font-size");
  }
  if (patch.color !== undefined) {
    if (patch.color.trim()) el.style.color = patch.color.trim();
    else el.style.removeProperty("color");
  }
  if (patch.backgroundColor !== undefined) {
    if (patch.backgroundColor.trim()) el.style.backgroundColor = patch.backgroundColor.trim();
    else el.style.removeProperty("background-color");
  }
  if (patch.textAlign !== undefined) {
    el.style.textAlign = patch.textAlign;
  }
  if (patch.opacity !== undefined) {
    const clamped = Math.min(1, Math.max(0, patch.opacity));
    if (clamped >= 1) el.style.removeProperty("opacity");
    else el.style.opacity = String(Number(clamped.toFixed(2)));
  }
  if (patch.hidden !== undefined) {
    if (patch.hidden) {
      el.setAttribute("data-hidden", "");
      el.style.visibility = "hidden";
    } else {
      el.removeAttribute("data-hidden");
      if (el.style.visibility === "hidden") el.style.removeProperty("visibility");
    }
  }

  return serializeDoc(doc, hasDoctype);
}

/** Move a layer forward/backward in DOM stacking order (z-order). */
export function reorderSlideLayer(
  html: string,
  layerId: string,
  direction: "up" | "down" | "front" | "back",
): string {
  const { doc, hasDoctype } = parseDoc(html);
  const el = findLayerElement(doc, layerId);
  const parent = el?.parentElement;
  if (!el || !parent) return html;

  const siblings = Array.from(parent.children).filter((c) => c.hasAttribute("data-layer"));
  const idx = siblings.indexOf(el);
  if (idx === -1) return html;

  if (direction === "up" && idx < siblings.length - 1) {
    const nextSibling = siblings[idx + 1];
    nextSibling?.after(el);
  } else if (direction === "down" && idx > 0) {
    const prevSibling = siblings[idx - 1];
    parent.insertBefore(el, prevSibling ?? null);
  } else if (direction === "front" && idx < siblings.length - 1) {
    parent.appendChild(el);
  } else if (direction === "back" && idx > 0) {
    const first = siblings[0];
    parent.insertBefore(el, first ?? null);
  } else {
    return html;
  }

  return serializeDoc(doc, hasDoctype);
}

/** Fill an image `slot` layer or replace an `image` / `logo` layer's source. */
export function fillSlideSlot(
  html: string,
  layerId: string,
  input: {
    src: string;
    alt?: string;
    assetId?: string;
    fit?: "cover" | "contain";
  },
): string {
  const { doc, hasDoctype } = parseDoc(html);
  const el = findLayerElement(doc, layerId);
  if (!el) return html;

  const kind = inferLayerKind(el);
  const fit = input.fit ?? (el.getAttribute("data-slot-fit") === "contain" ? "contain" : "cover");

  if (kind === "slot") {
    el.setAttribute("data-slot-state", "filled");
    el.setAttribute("data-slot-fit", fit);
    if (input.assetId) el.setAttribute("data-asset-id", input.assetId);
    el.innerHTML = "";
    const img = doc.createElement("img");
    img.setAttribute("data-slot-image", "");
    img.setAttribute("src", input.src);
    img.setAttribute("alt", input.alt ?? el.getAttribute("data-slot-label") ?? "");
    if (input.assetId) img.setAttribute("data-asset-id", input.assetId);
    img.style.position = "absolute";
    img.style.inset = "0";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = fit;
    el.appendChild(img);
  } else if (el.tagName.toLowerCase() === "img") {
    el.setAttribute("src", input.src);
    if (input.alt !== undefined) el.setAttribute("alt", input.alt);
    if (input.assetId) el.setAttribute("data-asset-id", input.assetId);
    if (input.fit) el.style.objectFit = input.fit;
  }

  return serializeDoc(doc, hasDoctype);
}

/** Reset a filled `slot` layer back to its `empty` placeholder state. */
export function clearSlideSlot(html: string, layerId: string): string {
  const { doc, hasDoctype } = parseDoc(html);
  const el = findLayerElement(doc, layerId);
  if (!el || inferLayerKind(el) !== "slot") return html;

  el.setAttribute("data-slot-state", "empty");
  el.removeAttribute("data-asset-id");
  el.innerHTML = "";
  return serializeDoc(doc, hasDoctype);
}

/** Update a slide's artboard dimensions (`1080×1350`, `1080×1080`, `1080×1920`). */
export function setSlideArtboardSize(html: string, width: number, height: number): string {
  const { doc, hasDoctype } = parseDoc(html);
  const artboard = doc.querySelector<HTMLElement>("[data-artboard]");
  if (artboard) {
    artboard.style.width = `${width}px`;
    artboard.style.height = `${height}px`;
  } else if (doc.body) {
    doc.body.style.width = `${width}px`;
    doc.body.style.height = `${height}px`;
  }
  const meta = doc.querySelector('meta[name="studio:format"]');
  if (meta) meta.setAttribute("content", `${width}x${height}`);
  return serializeDoc(doc, hasDoctype);
}

/** Collect `{ [slotLayerId]: assetId }` across slides for `content.render`. */
export function collectSlotAssignments(
  slides: ReadonlyArray<{ html: string; width: number; height: number }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of slides) {
    const parsed = parseSlideLayers(s.html, { width: s.width, height: s.height });
    for (const layer of parsed.layers) {
      if (layer.type === "slot" && layer.slotState === "filled" && layer.assetId) {
        out[layer.id] = layer.assetId;
      }
    }
  }
  return out;
}

// --- Undo / Redo History Engine ------------------------------------------------

export interface EditorHistory<T> {
  past: T[];
  present: T;
  future: T[];
}

export function createHistory<T>(initial: T): EditorHistory<T> {
  return { past: [], present: initial, future: [] };
}

export function pushHistory<T>(
  history: EditorHistory<T>,
  next: T,
  maxDepth = 50,
): EditorHistory<T> {
  if (Object.is(history.present, next)) return history;
  const past = [...history.past, history.present];
  if (past.length > maxDepth) past.shift();
  return { past, present: next, future: [] };
}

/** Update `present` during a continuous gesture without pushing every pointermove. */
export function replacePresent<T>(history: EditorHistory<T>, next: T): EditorHistory<T> {
  return { ...history, present: next };
}

export function undoHistory<T>(history: EditorHistory<T>): EditorHistory<T> {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1] as T;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoHistory<T>(history: EditorHistory<T>): EditorHistory<T> {
  if (history.future.length === 0) return history;
  const next = history.future[0] as T;
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}
