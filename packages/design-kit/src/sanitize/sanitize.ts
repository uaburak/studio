/**
 * HTML sanitiser for untrusted design HTML (LLM output, pasted markup, patch fragments).
 *
 * It guarantees *safety*, not contract conformance (the linter does that): no script can
 * run and nothing outside the virtual asset origins can be fetched. The tree comes from a
 * spec-compliant parser (parse5, same tree as Chromium), so what is checked is what the
 * browser builds.
 *
 * Edits are applied as splices on the source, so clean input comes back byte-identical
 * and a cleaned document differs only where something was removed. The result is parsed
 * again and must come out clean; if splicing cannot converge (markup the parser rebuilt
 * without source locations), the cleaned tree is re-serialised instead and verified the
 * same way. Anything that still is not clean throws `SanitizeError`.
 */
import { type DefaultTreeAdapterTypes, serialize } from "parse5";
import { parseDeclarationBlock, tokenizeCss, urlReferences } from "../html/css.ts";
import {
  applySplices,
  attrRange,
  attrValueRange,
  elementRanges,
  escapeAttr,
  isElement,
  NS,
  type P5Document,
  type P5Element,
  type P5ParentNode,
  parseDocument,
  type Splice,
} from "../html/dom.ts";
import { sanitizeDeclarationList, sanitizeStylesheet } from "./css.ts";
import { isFragmentUrl, isVirtualAssetUrl } from "./url.ts";

export interface SanitizeFinding {
  kind: "element" | "attribute" | "css" | "url";
  /** Element name the finding is about. */
  tag: string;
  /** Attribute name, for attribute and url findings. */
  attribute?: string;
  /** `removed` (element and content), `unwrapped` (tags removed, content kept), `cleaned` (CSS edited). */
  action: "removed" | "unwrapped" | "cleaned";
  detail: string;
}

export interface SanitizeResult {
  html: string;
  /** False when the input was already clean (then `html === input`). */
  changed: boolean;
  findings: SanitizeFinding[];
  /** How the output was produced. */
  mode: "unchanged" | "splice" | "rebuild";
}

export interface SanitizeOptions {
  /** Root-relative prefixes allowed for images and CSS URLs (default `/brand/`, `/media/`). */
  assetPrefixes?: readonly string[];
}

export class SanitizeError extends Error {
  readonly findings: SanitizeFinding[];
  constructor(message: string, findings: SanitizeFinding[]) {
    super(message);
    this.name = "SanitizeError";
    this.findings = findings;
  }
}

// --- Policy ---------------------------------------------------------------------

const HTML_KEEP = new Set([
  "html",
  "head",
  "body",
  "meta",
  "title",
  "link",
  "style",
  "main",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "aside",
  "figure",
  "figcaption",
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "span",
  "br",
  "wbr",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "small",
  "sup",
  "sub",
  "mark",
  "ul",
  "ol",
  "li",
  "blockquote",
  "hr",
  "img",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "colgroup",
  "col",
  "svg",
]);

/** Removed together with their content. */
const HTML_DROP = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "param",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "form",
  "input",
  "textarea",
  "select",
  "option",
  "optgroup",
  "button",
  "datalist",
  "output",
  "base",
  "template",
  "portal",
  "fencedframe",
  "dialog",
  "slot",
  "xmp",
  "plaintext",
  "noembed",
  "noframes",
  "picture",
  "map",
  "area",
  "math",
  "search",
  "selectedcontent",
  "menu",
  "keygen",
]);

const SVG_KEEP = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "defs",
  "lineargradient",
  "radialgradient",
  "stop",
  "clippath",
  "mask",
  "pattern",
  "use",
  "symbol",
  "title",
  "desc",
  "text",
  "tspan",
  "filter",
  "feblend",
  "fecolormatrix",
  "fecomponenttransfer",
  "fecomposite",
  "fedropshadow",
  "feflood",
  "fefunca",
  "fefuncb",
  "fefuncg",
  "fefuncr",
  "fegaussianblur",
  "femerge",
  "femergenode",
  "femorphology",
  "feoffset",
  "feturbulence",
  "fedisplacementmap",
]);

const GLOBAL_ATTRS = new Set([
  "class",
  "id",
  "style",
  "lang",
  "dir",
  "title",
  "hidden",
  "role",
  "translate",
]);

const ELEMENT_ATTRS: Record<string, ReadonlySet<string>> = {
  img: new Set(["src", "alt", "width", "height", "decoding"]),
  meta: new Set(["charset", "name", "content"]),
  link: new Set(["rel", "href"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan", "scope"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  ol: new Set(["start", "reversed"]),
  li: new Set(["value"]),
};

const SVG_ATTRS = new Set([
  "viewbox",
  "xmlns",
  "xmlns:xlink",
  "version",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "d",
  "points",
  "transform",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-miterlimit",
  "opacity",
  "clip-path",
  "clip-rule",
  "mask",
  "preserveaspectratio",
  "offset",
  "stop-color",
  "stop-opacity",
  "gradientunits",
  "gradienttransform",
  "spreadmethod",
  "fx",
  "fy",
  "fr",
  "patternunits",
  "patterncontentunits",
  "patterntransform",
  "clippathunits",
  "maskunits",
  "maskcontentunits",
  "href",
  "xlink:href",
  "vector-effect",
  "shape-rendering",
  "paint-order",
  "filter",
  "flood-color",
  "flood-opacity",
  "stddeviation",
  "dx",
  "dy",
  "in",
  "in2",
  "result",
  "mode",
  "values",
  "type",
  "operator",
  "k1",
  "k2",
  "k3",
  "k4",
  "radius",
  "basefrequency",
  "numoctaves",
  "seed",
  "stitchtiles",
  "scale",
  "xchannelselector",
  "ychannelselector",
  "tablevalues",
  "slope",
  "intercept",
  "amplitude",
  "exponent",
  "focusable",
  "text-anchor",
  "dominant-baseline",
  "font-family",
  "font-size",
  "font-weight",
  "letter-spacing",
  "pathlength",
  "color",
  "display",
  "visibility",
  "class",
  "id",
  "style",
  "role",
  "lang",
  "filterunits",
  "primitiveunits",
  "markerwidth",
  "markerheight",
  "textlength",
  "lengthadjust",
]);

const NAME_ALLOWED = (name: string) => name.startsWith("data-") || name.startsWith("aria-");
const DATA_NAME = /^(data|aria)-[a-z0-9_.:-]+$/;

type Action = "keep" | "drop" | "unwrap";

function elementAction(el: P5Element, opts: SanitizeOptions): { action: Action; why?: string } {
  const tag = el.tagName.toLowerCase();
  if (el.namespaceURI === NS.SVG) {
    if (SVG_KEEP.has(tag)) return { action: "keep" };
    // A picture in an SVG design (the SVG engine): only a served asset, like <img src>.
    if (tag === "image") {
      const href = attr(el, "href") ?? attr(el, "xlink:href");
      return href !== null && isVirtualAssetUrl(href, opts.assetPrefixes)
        ? { action: "keep" }
        : { action: "drop", why: "<image> must reference an allowed asset URL" };
    }
    return { action: "drop", why: `<${tag}> is not allowed inside SVG` };
  }
  if (el.namespaceURI !== NS.HTML) return { action: "drop", why: `foreign element <${tag}>` };
  if (HTML_DROP.has(tag)) return { action: "drop", why: `<${tag}> is not allowed` };
  if (tag === "link") {
    const rel = (attr(el, "rel") ?? "").toLowerCase().trim().split(/\s+/);
    const href = attr(el, "href") ?? "";
    if (rel.length !== 1 || rel[0] !== "stylesheet")
      return { action: "drop", why: `<link rel="${rel.join(" ")}"> is not allowed` };
    if (!isVirtualAssetUrl(href, ["/brand/"]))
      return { action: "drop", why: `stylesheet "${href.slice(0, 120)}" is not on /brand/` };
    return { action: "keep" };
  }
  if (tag === "meta" && attr(el, "http-equiv") !== null)
    return { action: "drop", why: "<meta http-equiv> is not allowed" };
  if (HTML_KEEP.has(tag)) return { action: "keep" };
  return { action: "unwrap", why: `<${tag}> is not allowed; its content is kept` };
}

function attr(el: P5Element, name: string): string | null {
  for (const a of el.attrs) if (a.name.toLowerCase() === name) return a.value;
  return null;
}

function qualifiedName(a: { name: string; prefix?: string }): string {
  return (a.prefix ? `${a.prefix}:${a.name}` : a.name).toLowerCase();
}

/** `null` when the attribute is fine, else the reason it must go. */
function attributeProblem(
  el: P5Element,
  a: { name: string; prefix?: string; value: string },
  opts: SanitizeOptions,
): string | null {
  const tag = el.tagName.toLowerCase();
  const name = qualifiedName(a);
  const svg = el.namespaceURI === NS.SVG;
  if (name.startsWith("on")) return `event handler "${name}"`;
  const allowed = svg
    ? SVG_ATTRS.has(name) || (NAME_ALLOWED(name) && DATA_NAME.test(name))
    : GLOBAL_ATTRS.has(name) ||
      ELEMENT_ATTRS[tag]?.has(name) ||
      (NAME_ALLOWED(name) && DATA_NAME.test(name));
  if (!allowed) return `attribute "${name}" is not allowed on <${tag}>`;
  const v = a.value;
  if (svg) {
    if (name === "href" || name === "xlink:href") {
      if (tag === "image")
        return isVirtualAssetUrl(v, opts.assetPrefixes)
          ? null
          : `image href "${v.slice(0, 120)}" is not an allowed asset URL`;
      return isFragmentUrl(v) ? null : `"${name}" must be a #fragment`;
    }
    if (/url\s*\(|\\/i.test(v)) {
      const refs = urlReferences(tokenizeCss(v));
      if (refs.bad || refs.dynamic || refs.urls.some((u) => !isFragmentUrl(u.trim())))
        return `"${name}" references a non-local url()`;
    }
    return null;
  }
  if (tag === "img" && name === "src")
    return isVirtualAssetUrl(v, opts.assetPrefixes)
      ? null
      : `image src "${v.slice(0, 120)}" is not an allowed asset URL`;
  if (tag === "link" && name === "href")
    return isVirtualAssetUrl(v, ["/brand/"]) ? null : "stylesheet href";
  return null;
}

// --- Edit collection (splice mode) ---------------------------------------------

interface Collected {
  splices: Splice[];
  findings: SanitizeFinding[];
  /** An edit was needed where the parser left no source location. */
  needsRebuild: boolean;
}

function precedingWhitespaceStart(source: string, pos: number, floor: number): number {
  let k = pos;
  while (k > floor && /\s/.test(source[k - 1] as string)) k--;
  return k;
}

function collectEdits(source: string, root: P5ParentNode, opts: SanitizeOptions): Collected {
  const out: Collected = { splices: [], findings: [], needsRebuild: false };
  const visit = (parent: P5ParentNode) => {
    for (const node of parent.childNodes) {
      if (!isElement(node)) continue;
      const el = node;
      const tag = el.tagName.toLowerCase();
      const { action, why } = elementAction(el, opts);
      const ranges = elementRanges(el);
      if (action === "drop") {
        out.findings.push({ kind: "element", tag, action: "removed", detail: why ?? "" });
        if (ranges)
          out.splices.push({ start: ranges.outer.start, end: ranges.outer.end, text: "" });
        else out.needsRebuild = true;
        continue;
      }
      if (action === "unwrap") {
        out.findings.push({ kind: "element", tag, action: "unwrapped", detail: why ?? "" });
        if (ranges) {
          out.splices.push({ start: ranges.startTag.start, end: ranges.startTag.end, text: "" });
          if (ranges.endTag)
            out.splices.push({ start: ranges.endTag.start, end: ranges.endTag.end, text: "" });
        } else out.needsRebuild = true;
        visit(el);
        continue;
      }
      // keep: attributes
      for (const a of el.attrs) {
        const name = qualifiedName(a);
        const problem = attributeProblem(el, a, opts);
        const range = attrRange(el, a.prefix ? `${a.prefix}:${a.name}` : a.name);
        if (problem) {
          out.findings.push({
            kind: name === "src" || name === "href" ? "url" : "attribute",
            tag,
            attribute: name,
            action: "removed",
            detail: problem,
          });
          if (range && ranges)
            out.splices.push({
              start: precedingWhitespaceStart(source, range.start, ranges.startTag.start),
              end: range.end,
              text: "",
            });
          else out.needsRebuild = true;
          continue;
        }
        if (name === "style") {
          const res = sanitizeDeclarationList(a.value, { prefixes: opts.assetPrefixes });
          if (res.findings.length) {
            for (const f of res.findings)
              out.findings.push({
                kind: "css",
                tag,
                attribute: "style",
                action: "cleaned",
                detail: f.detail,
              });
            const vr = range ? attrValueRange(source, range) : null;
            if (range && vr && vr.quote === '"')
              out.splices.push({ start: vr.start, end: vr.end, text: escapeAttr(res.css) });
            else if (range)
              out.splices.push({
                start: range.start,
                end: range.end,
                text: `style="${escapeAttr(res.css)}"`,
              });
            else out.needsRebuild = true;
          }
        }
      }
      if (tag === "style" && el.namespaceURI === NS.HTML) {
        const text = el.childNodes
          .map((c) => ("value" in c ? (c as { value: string }).value : ""))
          .join("");
        const res = sanitizeStylesheet(text, { prefixes: opts.assetPrefixes });
        if (res.findings.length) {
          for (const f of res.findings)
            out.findings.push({ kind: "css", tag, action: "cleaned", detail: f.detail });
          if (ranges && source.slice(ranges.inner.start, ranges.inner.end) === text)
            out.splices.push({ start: ranges.inner.start, end: ranges.inner.end, text: res.css });
          else out.needsRebuild = true;
        }
        continue;
      }
      visit(el);
    }
  };
  visit(root);
  return out;
}

// --- Rebuild mode ------------------------------------------------------------------

function rebuildClean(root: P5ParentNode, opts: SanitizeOptions) {
  const next: DefaultTreeAdapterTypes.ChildNode[] = [];
  for (const node of root.childNodes) {
    if (!isElement(node)) {
      next.push(node);
      continue;
    }
    const el = node;
    const { action } = elementAction(el, opts);
    if (action === "drop") continue;
    rebuildClean(el, opts);
    if (action === "unwrap") {
      for (const c of el.childNodes) {
        c.parentNode = root;
        next.push(c);
      }
      continue;
    }
    el.attrs = el.attrs.filter((a) => !attributeProblem(el, a, opts));
    for (const a of el.attrs)
      if (qualifiedName(a) === "style")
        a.value = sanitizeDeclarationList(a.value, { prefixes: opts.assetPrefixes }).css;
    if (el.tagName === "style" && el.namespaceURI === NS.HTML) {
      for (const c of el.childNodes)
        if ("value" in c)
          (c as { value: string }).value = sanitizeStylesheet((c as { value: string }).value, {
            prefixes: opts.assetPrefixes,
          }).css;
    }
    next.push(el);
  }
  root.childNodes = next;
}

// --- Public API --------------------------------------------------------------------

/** Findings for a document without changing it (empty = clean). */
export function sanitizeFindings(html: string, options: SanitizeOptions = {}): SanitizeFinding[] {
  const doc = parseDocument(html);
  return collectEdits(html, doc, options).findings;
}

export function isSanitized(html: string, options: SanitizeOptions = {}): boolean {
  return sanitizeFindings(html, options).length === 0;
}

/** Make an untrusted slide document safe to preview and render. */
export function sanitizeSlideHtml(html: string, options: SanitizeOptions = {}): SanitizeResult {
  const allFindings: SanitizeFinding[] = [];
  let current = html;
  for (let pass = 0; pass < 4; pass++) {
    const doc = parseDocument(current);
    const edits = collectEdits(current, doc, options);
    if (edits.findings.length === 0) {
      return {
        html: current,
        changed: current !== html,
        findings: allFindings,
        mode: current === html ? "unchanged" : "splice",
      };
    }
    allFindings.push(...edits.findings);
    if (edits.needsRebuild) break;
    try {
      current = applySplices(current, dedupeNested(edits.splices));
    } catch {
      break;
    }
  }
  // Rebuild from the tree and verify.
  const doc: P5Document = parseDocument(current);
  rebuildClean(doc, options);
  const rebuilt = serialize(doc);
  const verify = collectEdits(rebuilt, parseDocument(rebuilt), options);
  if (verify.findings.length > 0)
    throw new SanitizeError("HTML could not be sanitised", verify.findings);
  return { html: rebuilt, changed: true, findings: allFindings, mode: "rebuild" };
}

/** Drop splices contained in another splice (an attribute edit inside a removed element). */
function dedupeNested(splices: Splice[]): Splice[] {
  const sorted = [...splices].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Splice[] = [];
  for (const sp of sorted) {
    const last = out[out.length - 1];
    if (
      last &&
      sp.start >= last.start &&
      sp.end <= last.end &&
      !(sp.start === sp.end && sp.start === last.end)
    )
      continue;
    out.push(sp);
  }
  return out;
}

/** Reason a CSS declaration list (style attribute value) is unsafe, for patch validation. */
export function styleAttributeFindings(css: string, options: SanitizeOptions = {}): string[] {
  const block = parseDeclarationBlock(css);
  const findings = sanitizeDeclarationList(css, { prefixes: options.assetPrefixes }).findings.map(
    (f) => f.detail,
  );
  if (block.rules.length) findings.push("rule blocks are not allowed in a style attribute");
  return [...new Set(findings)];
}
