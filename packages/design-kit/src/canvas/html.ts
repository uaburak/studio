/**
 * The slide HTML of a version saved from the canvas (Wecra's editor). The slide is published as
 * the PNG Wecra's engine exported; the HTML is a design-contract v1 document that
 *
 *   - shows exactly that PNG: the artboard's bottom layer, `<img data-layer="canvas">` (its SHA-256
 *     in `studio:render`, so the content hash — what approval is bound to — covers the pixels);
 *   - describes it: above the PNG, one `data-layer` element per text (its real text), image slot
 *     (`data-type="slot"` with the contract's `data-slot-*`), logo and picture, at the layer's
 *     place, painted with `opacity: 0` (the render keeps its pixels; the renderer's layout checks
 *     skip invisible layers, the canvas checks read the facts). Real colours and fonts are data
 *     attributes (`data-color`, `data-font` …);
 *   - carries the full facts (`facts.ts`) as JSON in `<meta name="studio:canvas">` — not a
 *     `<script>`: the sanitiser removes scripts, it keeps `meta` name/content.
 *
 * `readCanvas` tells the three kinds of slide HTML apart: not from the canvas, from the canvas
 * with facts, and an older canvas save (one image, no facts: the checks skip it).
 */
import { BRAND_CSS_PATH } from "../contract/constants.ts";
import { escapeAttr, getAttr, parseDocument, walkElements } from "../html/dom.ts";
import { type CanvasFacts, parseCanvasFacts } from "./facts.ts";
import { CANVAS_RENDER_LAYER, type CanvasLayer, canvasLayers } from "./layers.ts";

export const CANVAS_META = "studio:canvas";

export interface CanvasSlideHtmlOptions {
  facts: CanvasFacts;
  /** The render's URL (`/media/<asset>.png`). */
  src: string;
  /** SHA-256 (hex) of the render's bytes. */
  sha256: string;
  /** The HTML version the canvas document was imported from (the AI edits from there). */
  sourceVersion?: number | null;
  /** Brand language (`tr`). */
  lang?: string;
}

const attr = (s: string) => escapeAttr(s);
const text = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n?|[\n\u2028\u2029]/g, "<br>");
const px = (n: number) => `${Math.round(n * 100) / 100}px`;
const num = (n: number) => String(Math.round(n * 100) / 100);

function box(l: CanvasLayer): string {
  return `left:${px(l.rect.x)};top:${px(l.rect.y)};width:${px(l.rect.w)};height:${px(l.rect.h)}`;
}

function common(l: CanvasLayer, type: string): string {
  return `data-layer="${attr(l.id)}" data-type="${type}"${l.role ? ` data-role="${l.role}"` : ""} data-wecra-id="${attr(l.node.id)}"`;
}

function layerHtml(l: CanvasLayer, render: string): string {
  if (l.type === "text") {
    const t = l.node.text;
    if (!t) return "";
    const data = [
      t.color ? `data-color="${t.color}"` : "",
      t.colors.length > 1 ? `data-colors="${t.colors.join(" ")}"` : "",
      `data-font="${attr(t.family)}"`,
      `data-font-style="${attr(t.style)}"`,
      `data-weight="${t.weight}"`,
      `data-size="${num(t.size)}"`,
      t.lineHeight !== null ? `data-line-height="${num(t.lineHeight)}"` : "",
      t.letterSpacing ? `data-letter-spacing="${num(t.letterSpacing)}"` : "",
      `data-align="${t.align}"`,
      l.node.mark?.allowOverlap ? "data-allow-overlap" : "",
      t.overflow ? "data-overflow" : "",
      t.truncated ? "data-truncated" : "",
      t.missingFont ? "data-missing-font" : "",
    ]
      .filter(Boolean)
      .join(" ");
    const style = `${box(l)};font-size:${px(t.size)}${t.lineHeight !== null ? `;line-height:${px(t.lineHeight)}` : ""}`;
    return `<p ${common(l, "text")} ${data} style="${style}">${text(t.characters.trim())}</p>`;
  }
  const image = l.image?.image ? ` data-wecra-image="${attr(l.image.image)}"` : "";
  if (l.type === "slot" && l.slot) {
    const s = l.slot;
    const inner =
      s.state === "filled"
        ? `<img data-slot-image src="${attr(s.src ?? render)}" alt=""${s.image?.image ? ` data-wecra-image="${attr(s.image.image)}"` : ""}>`
        : "";
    return `<figure ${common(l, "slot")} data-slot-ratio="${s.ratio}" data-slot-state="${s.state}" data-slot-label="${attr(s.label)}" data-slot-fit="${s.fit}" style="${box(l)}">${inner}</figure>`;
  }
  const fit = l.image?.fit === "fit" ? "contain" : l.image?.fit === "crop" ? "fill" : "cover";
  return `<img ${common(l, l.type)}${image} src="${attr(l.src ?? render)}" alt="" style="${box(l)};object-fit:${fit}">`;
}

/** Short alt text of a canvas slide: its most prominent texts, in reading order. */
export function canvasAltText(facts: CanvasFacts, max = 250): string {
  const inFrame = (l: CanvasLayer) =>
    l.rect.x < facts.frame.width &&
    l.rect.y < facts.frame.height &&
    l.rect.x + l.rect.w > 0 &&
    l.rect.y + l.rect.h > 0;
  const texts = canvasLayers(facts)
    .filter((l) => l.type === "text" && inFrame(l))
    .map((l) => {
      const t = l.node.text as NonNullable<CanvasLayer["node"]["text"]>;
      const size = Math.max(t.size, ...t.runs.map((r) => r.size));
      return { text: t.characters.replace(/\s+/g, " ").trim(), size, x: l.rect.x, y: l.rect.y };
    })
    .filter((t) => t.text);
  const picked: typeof texts = [];
  let length = 0;
  for (const t of [...texts].sort((a, b) => b.size - a.size || a.y - b.y || a.x - b.x)) {
    if (length >= max) break;
    picked.push(t);
    length += t.text.length + 2;
  }
  picked.sort((a, b) => a.y - b.y || a.x - b.x);
  const joined = picked.map((t) => (/[.!?…:]$/u.test(t.text) ? t.text : `${t.text}.`)).join(" ");
  if (joined.length <= max) return joined;
  const cut = joined.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/u, "")}…`;
}

/** The slide HTML of a canvas render (see the top). */
export function canvasSlideHtml(o: CanvasSlideHtmlOptions): string {
  const { facts } = o;
  const w = Math.round(facts.frame.width);
  const h = Math.round(facts.frame.height);
  const layers = canvasLayers(facts)
    .map((l) => layerHtml(l, o.src))
    .filter(Boolean)
    .map((s) => `\n    ${s}`)
    .join("");
  return `<!doctype html>
<html lang="${attr(o.lang ?? "tr")}">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v1">
  <meta name="studio:format" content="${w}x${h}">
  <meta name="studio:editor" content="wecra">
  <meta name="studio:render" content="sha256:${o.sha256}">${o.sourceVersion ? `\n  <meta name="studio:source-version" content="${o.sourceVersion}">` : ""}
  <meta name="${CANVAS_META}" content="${attr(JSON.stringify(facts))}">
  <link rel="stylesheet" href="${BRAND_CSS_PATH}">
  <style>
    html, body { margin: 0; }
    [data-artboard] { position: relative; overflow: hidden; }
    [data-artboard] > [data-layer]:not([data-layer="${CANVAS_RENDER_LAYER}"]) { position: absolute; box-sizing: border-box; margin: 0; padding: 0; border: 0; opacity: 0 !important; pointer-events: none; }
  </style>
</head>
<body>
  <main data-artboard style="width:${w}px;height:${h}px">
    <img data-layer="${CANVAS_RENDER_LAYER}" data-type="image" data-role="background" src="${attr(o.src)}" alt="${attr(canvasAltText(facts))}" style="position:absolute;left:0;top:0;width:${w}px;height:${h}px">${layers}
  </main>
</body>
</html>`;
}

export type CanvasSlideKind =
  | { kind: "none" }
  /** Saved from the canvas before the facts (one image layer): nothing to check. */
  | { kind: "legacy"; sourceVersion: number | null }
  | { kind: "facts"; facts: CanvasFacts; sourceVersion: number | null };

/** What a slide HTML says about the canvas (see the top). */
export function readCanvas(html: string | null | undefined): CanvasSlideKind {
  if (!html?.includes("studio:editor")) return { kind: "none" };
  let editor: string | null = null;
  let source: string | null = null;
  let factsJson: string | null = null;
  for (const el of walkElements(parseDocument(html))) {
    if (el.tagName !== "meta") continue;
    const name = getAttr(el, "name");
    if (name === "studio:editor") editor = getAttr(el, "content");
    else if (name === "studio:source-version") source = getAttr(el, "content");
    else if (name === CANVAS_META) factsJson = getAttr(el, "content");
  }
  if (editor !== "wecra") return { kind: "none" };
  const sourceVersion = source && /^\d+$/.test(source) ? Number(source) : null;
  if (factsJson) {
    try {
      const facts = parseCanvasFacts(JSON.parse(factsJson));
      if (facts) return { kind: "facts", facts, sourceVersion };
    } catch {
      /* unreadable facts: as an older save */
    }
  }
  return { kind: "legacy", sourceVersion };
}
