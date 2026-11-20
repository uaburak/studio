/**
 * The SVG engine's slide document (docs/URETIM-RESIM.md, Faz 3).
 *
 * The design model writes each slide as one `<svg>` at the artboard size. What is stored on the
 * version (and rendered by Chromium, like every slide) is a small HTML document around it:
 *
 *   <!doctype html>
 *   <html lang="tr" data-studio-engine="svg">
 *   <head> brand.css (the brand's @font-face rules and variables), the page reset,
 *          the SVG's own <style> rules (hoisted, sanitised) </head>
 *   <body><svg width=W height=H viewBox="0 0 W H"> … </svg></body>
 *   </html>
 *
 * The `<svg>` plus its hoisted style is the engine's source: `readSvgSlide` gives it back for a
 * chat revision. Sanitising is strict and twofold: this module's SVG pass (one root, the
 * artboard size, `<style>` hoisted without @import / @font-face, links unwrapped, pictures only
 * from the brand's files and the offered `/media/<assetId>` files) and then design-kit's HTML
 * sanitiser on the whole document (scripts, foreignObject, event handlers, animation and every
 * reference outside the served assets go), verified once more by `assertSafeSvgSlide`.
 *
 * "AI görsel" slots: `<rect data-slot="ai-image" data-slot-ratio="4:5" data-slot-label="AI görsel"
 * x y width height …/>`. `fillSvgSlot` turns the marker into an `<image>` of the approved picture
 * at the same box (cropped to fill; rounded corners kept by a clip path).
 */
import { SVG_SLIDE_ATTR } from "@studio/contract";
import {
  isVirtualAssetUrl,
  SanitizeError,
  sanitizeSlideHtml,
  sanitizeStylesheet,
} from "@studio/design-kit/sanitize";
import { type DefaultTreeAdapterTypes, parse, serializeOuter } from "parse5";

type Node = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const SVG_NS = "http://www.w3.org/2000/svg";
/** Asset prefixes an SVG design may reference. */
export const SVG_ASSET_PREFIXES = ["/brand/", "/media/"] as const;
/** The empty slot marker's default label. */
export const AI_SLOT_LABEL = "AI görsel";

export class SvgSlideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SvgSlideError";
  }
}

export interface PrepareSvgOptions {
  width: number;
  height: number;
  lang: string;
  /**
   * Asset ids a `/media/<assetId>.<ext>` picture may name (the brand's offered pictures, the
   * chat's @images, product photos, pictures already in the base version). Absent: any.
   */
  mediaIds?: ReadonlySet<string>;
}

export interface PreparedSvgSlide {
  /** The stored slide document. */
  html: string;
  /** The sanitised `<svg>` (without its hoisted style). */
  svg: string;
  css: string;
  /** What was removed or changed (English: it goes back to the model; logs). */
  findings: string[];
}

function isElement(node: Node | ParentNode): node is Element {
  return "tagName" in node;
}

function* walk(node: ParentNode): Generator<Element> {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue;
    yield child;
    yield* walk(child);
  }
}

function attrOf(el: Element, name: string): string | null {
  for (const a of el.attrs) if (a.name.toLowerCase() === name) return a.value;
  return null;
}

function setAttr(el: Element, name: string, value: string): void {
  const existing = el.attrs.find((a) => a.name.toLowerCase() === name && !a.prefix);
  if (existing) existing.value = value;
  else el.attrs.push({ name, value });
}

function removeAttr(el: Element, name: string): void {
  el.attrs = el.attrs.filter((a) => a.name.toLowerCase() !== name);
}

function textOf(node: ParentNode): string {
  let out = "";
  for (const c of node.childNodes) {
    if ("value" in c && c.nodeName === "#text") out += (c as { value: string }).value;
    else if (isElement(c)) {
      // A <tspan> placed on its own line (x, y or dy) starts a new line: the line break is a
      // word break ("bağlama" + "döneminde" read as "bağlamadöneminde" failed the spelling check).
      if (startsSvgLine(c) && out && !/\s$/.test(out)) out += " ";
      out += textOf(c);
    }
  }
  return out;
}

function startsSvgLine(el: Element): boolean {
  if (el.tagName.toLowerCase() !== "tspan") return false;
  const dy = attrOf(el, "dy");
  return (
    attrOf(el, "x") !== null ||
    attrOf(el, "y") !== null ||
    (dy !== null && Number.parseFloat(dy) !== 0)
  );
}

function detach(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  parent.childNodes = parent.childNodes.filter((c) => c !== el);
}

function unwrap(el: Element): void {
  const parent = el.parentNode;
  if (!parent) return;
  const index = parent.childNodes.indexOf(el);
  for (const c of el.childNodes) c.parentNode = parent;
  parent.childNodes.splice(index, 1, ...el.childNodes);
}

/** `/media/<assetId>.<ext>` → the asset id (null for any other path). */
export function mediaAssetId(href: string): string | null {
  const m = /^\/media\/([^/?#]+?)(?:\.[a-z0-9]+)?$/i.exec(href);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** The model's answer for one slide → its `<svg>…</svg>` (fences, XML prolog, comments off). */
function svgSourceOf(raw: string): string {
  const text = raw
    .replace(/^\s*```[a-z]*\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const start = text.search(/<svg[\s>]/i);
  const end = text.toLowerCase().lastIndexOf("</svg>");
  if (start < 0 || end < start) throw new SvgSlideError("the slide has no <svg> root element");
  return text.slice(start, end + "</svg>".length);
}

/** The document's root `<svg>` (the first SVG element of the body). */
function rootSvg(doc: ParentNode): Element | null {
  for (const el of walk(doc)) {
    if (el.namespaceURI === SVG_NS && el.tagName.toLowerCase() === "svg") return el;
  }
  return null;
}

/** CSS the SVG carried: no @import or @font-face (fonts come from brand.css), sanitised. */
function cleanCss(css: string, findings: string[]): string {
  let text = css;
  if (/@import\b/i.test(text)) {
    findings.push("@import removed from <style> (fonts and colours come from brand.css)");
    text = text.replace(/@import\b[^;]*;?/gi, "");
  }
  if (/@font-face\b/i.test(text)) {
    findings.push("@font-face removed from <style> (the brand's fonts are loaded by brand.css)");
    text = text.replace(/@font-face\s*\{[^}]*\}/gi, "");
  }
  const res = sanitizeStylesheet(text, { prefixes: SVG_ASSET_PREFIXES });
  for (const f of res.findings) findings.push(`<style>: ${f.detail}`);
  return res.css.replace(/<\//g, "<\\/").trim();
}

/** The stored slide document around a sanitised `<svg>`. */
export function wrapSvgSlide(input: {
  svg: string;
  css: string;
  width: number;
  height: number;
  lang: string;
}): string {
  const lang = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(input.lang) ? input.lang : "tr";
  return [
    "<!doctype html>",
    `<html lang="${lang}" ${SVG_SLIDE_ATTR}="svg">`,
    "<head>",
    '<meta charset="utf-8">',
    '<link rel="stylesheet" href="/brand/brand.css">',
    `<style>html, body { margin: 0; padding: 0; width: ${input.width}px; height: ${input.height}px; overflow: hidden; } body > svg { display: block; }</style>`,
    ...(input.css ? [`<style data-svg-style>${input.css}</style>`] : []),
    "</head>",
    "<body>",
    input.svg,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * A slide from the model (or a revision) → the stored, sanitised document. Throws
 * `SvgSlideError` when there is no usable `<svg>` or the result is not safe.
 */
export function prepareSvgSlide(raw: string, options: PrepareSvgOptions): PreparedSvgSlide {
  const findings: string[] = [];
  const source = svgSourceOf(raw);
  const doc = parse(`<!doctype html><html><head></head><body>${source}</body></html>`);
  const svg = rootSvg(doc);
  if (!svg) throw new SvgSlideError("the slide has no <svg> root element");

  // The <style> rules go to the head (the HTML sanitiser keeps SVG content only).
  const styles: string[] = [];
  for (const el of [...walk(svg)]) {
    const tag = el.tagName.toLowerCase();
    if (el.namespaceURI !== SVG_NS) continue;
    if (tag === "style") {
      styles.push(textOf(el));
      detach(el);
    } else if (tag === "a") {
      findings.push("<a> unwrapped (a post has no links)");
      unwrap(el);
    } else if (tag === "image") {
      const href = (attrOf(el, "href") ?? "").trim();
      // xlink:href → href (one spelling for the sanitiser and the slot filler)
      el.attrs = el.attrs.filter((a) => a.name.toLowerCase() !== "href");
      if (href) el.attrs.push({ name: "href", value: href });
      const id = mediaAssetId(href);
      const allowed =
        isVirtualAssetUrl(href, SVG_ASSET_PREFIXES) &&
        (id === null || !options.mediaIds || options.mediaIds.has(id));
      if (!allowed) {
        findings.push(
          `<image href="${href.slice(0, 120)}"> removed: only the listed /brand/ and /media/ pictures may be used`,
        );
        detach(el);
      } else if (/^none$/i.test(attrOf(el, "preserveaspectratio")?.trim() ?? "")) {
        findings.push(`<image href="${href.slice(0, 80)}">: preserveAspectRatio="none" stretches`);
      }
    }
  }

  // The root: the artboard size, a viewBox, no position of its own.
  const w = String(options.width);
  const h = String(options.height);
  if (attrOf(svg, "width") !== w || attrOf(svg, "height") !== h)
    findings.push(`root <svg> set to width="${w}" height="${h}" (the artboard)`);
  setAttr(svg, "width", w);
  setAttr(svg, "height", h);
  if (!attrOf(svg, "viewbox")) setAttr(svg, "viewBox", `0 0 ${w} ${h}`);
  removeAttr(svg, "x");
  removeAttr(svg, "y");
  if (!attrOf(svg, "xmlns")) svg.attrs.unshift({ name: "xmlns", value: SVG_NS });

  const css = cleanCss(styles.join("\n"), findings);
  const html = wrapSvgSlide({
    svg: serializeOuter(svg),
    css,
    width: options.width,
    height: options.height,
    lang: options.lang,
  });
  let clean: ReturnType<typeof sanitizeSlideHtml>;
  try {
    clean = sanitizeSlideHtml(html, { assetPrefixes: SVG_ASSET_PREFIXES });
  } catch (error) {
    if (error instanceof SanitizeError) throw new SvgSlideError(`unsafe SVG: ${error.message}`);
    throw error;
  }
  for (const f of clean.findings)
    findings.push(`${f.tag}${f.attribute ? ` ${f.attribute}` : ""}: ${f.detail}`);
  assertSafeSvgSlide(clean.html);
  const read = readSvgSlide(clean.html);
  if (!read) throw new SvgSlideError("the sanitised slide lost its <svg>");
  return { html: clean.html, svg: read.svg, css: read.css, findings };
}

const FORBIDDEN_TAGS = new Set([
  "script",
  "foreignobject",
  "iframe",
  "object",
  "embed",
  "a",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "feimage",
]);

/**
 * The last fence on a stored SVG slide: no script, foreignObject, link or animation element, no
 * event handler, no reference outside the served assets. Throws `SvgSlideError`.
 */
export function assertSafeSvgSlide(html: string): void {
  const doc = parse(html);
  for (const el of walk(doc)) {
    const tag = el.tagName.toLowerCase();
    if (FORBIDDEN_TAGS.has(tag)) throw new SvgSlideError(`<${tag}> is not allowed`);
    for (const a of el.attrs) {
      const name = (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase();
      if (name.startsWith("on")) throw new SvgSlideError(`event handler "${name}"`);
      if (tag === "meta" && name === "content") continue;
      // Namespace declarations name a namespace; nothing is fetched.
      if (name === "xmlns" || name.startsWith("xmlns:")) continue;
      const value = a.value.replace(/\s/g, "");
      if (/javascript:|vbscript:|data:|https?:|^\/\//i.test(value))
        throw new SvgSlideError(`"${name}" references outside the design (${value.slice(0, 80)})`);
      if (name === "href" || name === "xlink:href" || name === "src") {
        const ok =
          (tag === "link" && value === "/brand/brand.css") ||
          (tag === "image" && isVirtualAssetUrl(a.value, SVG_ASSET_PREFIXES)) ||
          /^#[A-Za-z_][\w.:-]*$/.test(value);
        if (!ok) throw new SvgSlideError(`<${tag} ${name}="${value.slice(0, 80)}"> is not allowed`);
      }
    }
  }
}

/** The engine's source of a stored slide: its `<svg>` and hoisted CSS (null: not an SVG slide). */
export function readSvgSlide(html: string): { svg: string; css: string } | null {
  let doc: DefaultTreeAdapterTypes.Document;
  try {
    doc = parse(html);
  } catch {
    return null;
  }
  const svg = rootSvg(doc);
  if (!svg) return null;
  let css = "";
  for (const el of walk(doc)) {
    if (el.tagName.toLowerCase() === "style" && attrOf(el, "data-svg-style") !== null)
      css += textOf(el);
  }
  return { svg: serializeOuter(svg), css: css.trim() };
}

/** A stored slide as the model edits it: the `<svg>` with its style back inside. */
export function svgSourceForModel(html: string): string | null {
  const read = readSvgSlide(html);
  if (!read) return null;
  if (!read.css) return read.svg;
  return read.svg.replace(/^(<svg\b[^>]*>)/i, `$1<style>${read.css}</style>`);
}

export interface SvgSlot {
  /** 0-based slide. */
  slide: number;
  slotId: string;
  state: "empty" | "filled";
  ratio: { w: number; h: number } | null;
  label: string | null;
  box: { x: number; y: number; width: number; height: number } | null;
}

function num(value: string | null): number | null {
  if (value === null) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function ratioOf(value: string | null): { w: number; h: number } | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*$/i.exec(value ?? "");
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? { w, h } : null;
}

/** The image slot markers (`data-slot`) of SVG slides, in slide order. */
export function svgSlots(slides: ReadonlyArray<{ html: string }>): SvgSlot[] {
  const out: SvgSlot[] = [];
  for (const [slide, s] of slides.entries()) {
    let doc: DefaultTreeAdapterTypes.Document;
    try {
      doc = parse(s.html);
    } catch {
      continue;
    }
    const svg = rootSvg(doc);
    if (!svg) continue;
    for (const el of walk(svg)) {
      const id = attrOf(el, "data-slot")?.trim();
      if (!id) continue;
      const tag = el.tagName.toLowerCase();
      const filled =
        attrOf(el, "data-slot-state") === "filled" || (tag === "image" && !!attrOf(el, "href"));
      const x = num(attrOf(el, "x")) ?? 0;
      const y = num(attrOf(el, "y")) ?? 0;
      const width = num(attrOf(el, "width"));
      const height = num(attrOf(el, "height"));
      const box = width && height ? { x, y, width, height } : null;
      out.push({
        slide,
        slotId: id,
        state: filled ? "filled" : "empty",
        ratio:
          ratioOf(attrOf(el, "data-slot-ratio")) ??
          (box ? { w: Math.round(box.width), h: Math.round(box.height) } : null),
        label: attrOf(el, "data-slot-label"),
        box,
      });
    }
  }
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

const CARRIED = [
  "transform",
  "opacity",
  "clip-path",
  "mask",
  "filter",
  "data-slot-ratio",
  "data-slot-label",
  "id",
  "class",
];

/**
 * Put a picture into an SVG slide's slot: the marker becomes an `<image>` of `src` at the same
 * box (`xMidYMid slice`: it fills the box, cropped; a rounded rect keeps its corners through a
 * clip path). `matched: false` when the slide has no such slot.
 */
export function fillSvgSlot(
  html: string,
  slotId: string,
  src: string,
): { html: string; matched: boolean } {
  if (!isVirtualAssetUrl(src, SVG_ASSET_PREFIXES)) throw new SvgSlideError(`bad picture ${src}`);
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const svg = rootSvg(doc);
  if (!svg) return { html, matched: false };
  const el = [...walk(svg)].find((e) => attrOf(e, "data-slot")?.trim() === slotId);
  const loc = el?.sourceCodeLocation;
  if (!el || !loc) return { html, matched: false };
  const tag = el.tagName.toLowerCase();
  const attrs: string[] = [];
  const keep = (name: string) => {
    const v = attrOf(el, name);
    if (v !== null) attrs.push(`${name}="${escapeAttr(v)}"`);
  };
  for (const name of ["x", "y", "width", "height"]) keep(name);
  for (const name of CARRIED) keep(name);
  let clip = "";
  const rx = attrOf(el, "rx");
  const ry = attrOf(el, "ry");
  if (tag !== "image" && (rx || ry) && attrOf(el, "clip-path") === null) {
    const clipId = `slot-clip-${slotId.replace(/[^\w-]/g, "-")}`;
    // The clip's box is in the image's own user space (its transform applies to both).
    const box = ["x", "y", "width", "height", "rx", "ry"]
      .map((n) => {
        const v = attrOf(el, n);
        return v === null ? "" : ` ${n}="${escapeAttr(v)}"`;
      })
      .join("");
    clip = `<clipPath id="${clipId}"><rect${box}></rect></clipPath>`;
    attrs.push(`clip-path="url(#${clipId})"`);
  }
  const preserve = tag === "image" ? attrOf(el, "preserveaspectratio") : null;
  attrs.push(
    `preserveAspectRatio="${escapeAttr(preserve && !/^none$/i.test(preserve) ? preserve : "xMidYMid slice")}"`,
  );
  attrs.push(
    `data-slot="${escapeAttr(slotId)}"`,
    'data-slot-state="filled"',
    `href="${escapeAttr(src)}"`,
  );
  const markup = `${clip}<image ${attrs.join(" ")}></image>`;
  const next = html.slice(0, loc.startOffset) + markup + html.slice(loc.endOffset);
  return { html: next, matched: true };
}

/** The visible copy of an SVG slide: each `<text>` with its id (or `text-N`). */
export function svgTexts(html: string): { id: string; text: string }[] {
  let doc: DefaultTreeAdapterTypes.Document;
  try {
    doc = parse(html);
  } catch {
    return [];
  }
  const svg = rootSvg(doc);
  if (!svg) return [];
  const out: { id: string; text: string }[] = [];
  let n = 0;
  for (const el of walk(svg)) {
    if (el.tagName.toLowerCase() !== "text") continue;
    n += 1;
    const text = textOf(el).replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.push({ id: attrOf(el, "id") || `text-${n}`, text });
  }
  return out;
}

/** The `/media/<assetId>` pictures a stored slide shows (kept by a revision). */
export function svgMediaIds(html: string): string[] {
  const ids = new Set<string>();
  for (const m of html.matchAll(/\bhref="(\/media\/[^"]+)"/g)) {
    const id = mediaAssetId(m[1] as string);
    if (id) ids.add(id);
  }
  return [...ids];
}
