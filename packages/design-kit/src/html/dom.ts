/**
 * parse5 helpers. parse5 is a spec-compliant HTML parser (same tree as Chromium) that
 * runs in browsers and Node. Every parse keeps source locations so edits can be applied
 * as minimal splices on the original text: markup nobody touched stays byte-identical.
 */
import { type DefaultTreeAdapterTypes, parse, parseFragment } from "parse5";

export type P5Document = DefaultTreeAdapterTypes.Document;
export type P5Fragment = DefaultTreeAdapterTypes.DocumentFragment;
export type P5Element = DefaultTreeAdapterTypes.Element;
export type P5Node = DefaultTreeAdapterTypes.Node;
export type P5ChildNode = DefaultTreeAdapterTypes.ChildNode;
export type P5ParentNode = DefaultTreeAdapterTypes.ParentNode;
export type P5Text = DefaultTreeAdapterTypes.TextNode;

export const NS = {
  HTML: "http://www.w3.org/1999/xhtml",
  SVG: "http://www.w3.org/2000/svg",
  MATHML: "http://www.w3.org/1998/Math/MathML",
} as const;

/**
 * Parse a full document. `scriptingEnabled: false` matches every context a design is
 * shown in (renderer with JavaScript off, sandboxed preview without `allow-scripts`):
 * `<noscript>` content is parsed as markup there.
 */
export function parseDocument(html: string): P5Document {
  return parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false });
}

/** Parse a fragment as the inner HTML of `context` (a `<div>` in `<body>` when omitted). */
export function parseFragmentIn(html: string, context?: P5Element): P5Fragment {
  const opts = { sourceCodeLocationInfo: true, scriptingEnabled: false } as const;
  return context ? parseFragment(context, html, opts) : parseFragment(html, opts);
}

export function isElement(node: P5Node | null | undefined): node is P5Element {
  return !!node && "tagName" in node;
}

export function isText(node: P5Node | null | undefined): node is P5Text {
  return !!node && node.nodeName === "#text";
}

export function getAttr(el: P5Element, name: string): string | null {
  const lower = name.toLowerCase();
  for (const a of el.attrs) if (a.name.toLowerCase() === lower && !a.prefix) return a.value;
  for (const a of el.attrs) if (a.name.toLowerCase() === lower) return a.value;
  return null;
}

export function hasAttr(el: P5Element, name: string): boolean {
  return getAttr(el, name) !== null;
}

/** Child elements (template contents are not descended into). */
export function childElements(node: P5ParentNode): P5Element[] {
  return node.childNodes.filter(isElement);
}

/** Depth-first, document order. */
export function* walkElements(root: P5ParentNode): Generator<P5Element> {
  for (const child of root.childNodes) {
    if (isElement(child)) {
      yield child;
      yield* walkElements(child);
    }
  }
}

export function* walkNodes(root: P5ParentNode): Generator<P5ChildNode> {
  for (const child of root.childNodes) {
    yield child;
    if (isElement(child)) yield* walkNodes(child);
  }
}

/** Nearest ancestor element (or itself when `includeSelf`) matching `pred`. */
export function closest(
  el: P5Element,
  pred: (e: P5Element) => boolean,
  includeSelf = false,
): P5Element | null {
  let cur: P5Node | null = includeSelf ? el : el.parentNode;
  while (cur && isElement(cur)) {
    if (pred(cur)) return cur;
    cur = cur.parentNode;
  }
  return null;
}

export function contains(ancestor: P5Element, node: P5Node): boolean {
  let cur: P5Node | null = node;
  while (cur) {
    if (cur === ancestor) return true;
    cur = "parentNode" in cur ? cur.parentNode : null;
  }
  return false;
}

/** Concatenated text of all descendant text nodes (entities decoded). */
export function textContent(node: P5Node): string {
  if (isText(node)) return node.value;
  if (!("childNodes" in node)) return "";
  let out = "";
  for (const c of node.childNodes) out += textContent(c);
  return out;
}

/**
 * Rendered-ish plain text: `<br>` becomes `\n`, runs of whitespace collapse to one space,
 * leading/trailing whitespace of each line is trimmed. Good enough for copy checks.
 */
export function plainText(node: P5Node): string {
  const parts: string[] = [];
  const visit = (n: P5Node) => {
    if (isText(n)) parts.push(n.value);
    else if (isElement(n) && n.tagName === "br") parts.push("\n");
    else if ("childNodes" in n) for (const c of n.childNodes) visit(c);
  };
  visit(node);
  return parts
    .join("")
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\n]+/g, " ").trim())
    .join("\n")
    .trim();
}

// --- Source ranges ------------------------------------------------------------

export interface Range {
  start: number;
  end: number;
}

export interface ElementRanges {
  outer: Range;
  startTag: Range;
  /** Inner content (between the start tag and the end tag, or the element's end when implied). */
  inner: Range;
  endTag: Range | null;
}

/** Source ranges of an element, or `null` when the parser synthesised it (no location). */
export function elementRanges(el: P5Element): ElementRanges | null {
  const loc = el.sourceCodeLocation;
  if (!loc?.startTag) return null;
  const startTag = { start: loc.startTag.startOffset, end: loc.startTag.endOffset };
  const endTag = loc.endTag ? { start: loc.endTag.startOffset, end: loc.endTag.endOffset } : null;
  return {
    outer: { start: loc.startOffset, end: loc.endOffset },
    startTag,
    inner: {
      start: startTag.end,
      end: endTag ? endTag.start : Math.max(startTag.end, loc.endOffset),
    },
    endTag,
  };
}

/** Location of one attribute (`name="value"`), matching names case-insensitively. */
export function attrRange(el: P5Element, name: string): Range | null {
  const attrs = el.sourceCodeLocation?.attrs;
  if (!attrs) return null;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(attrs)) {
    if (k.toLowerCase() === lower) return { start: v.startOffset, end: v.endOffset };
  }
  return null;
}

export interface AttrValueRange extends Range {
  /** Quote character used in the source, `""` for unquoted values. */
  quote: '"' | "'" | "";
}

/** Range of the raw value inside an attribute's source text, `null` for a boolean attribute. */
export function attrValueRange(source: string, attr: Range): AttrValueRange | null {
  const text = source.slice(attr.start, attr.end);
  const eq = text.indexOf("=");
  if (eq === -1) return null;
  let k = eq + 1;
  while (k < text.length && /\s/.test(text[k] as string)) k++;
  const q = text[k];
  if (q === '"' || q === "'") {
    const close = text.lastIndexOf(q);
    return {
      start: attr.start + k + 1,
      end: attr.start + (close > k ? close : text.length),
      quote: q,
    };
  }
  return { start: attr.start + k, end: attr.end, quote: "" };
}

// --- Splices ------------------------------------------------------------------

export interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping splices to `source`. Throws when two splices overlap. */
export function applySplices(source: string, splices: readonly Splice[]): string {
  if (splices.length === 0) return source;
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const sp of sorted) {
    if (sp.start < pos) throw new Error(`overlapping edits at ${sp.start}`);
    if (sp.end < sp.start || sp.end > source.length)
      throw new Error(`bad edit range ${sp.start}-${sp.end}`);
    out += source.slice(pos, sp.start) + sp.text;
    pos = sp.end;
  }
  return out + source.slice(pos);
}

/** Escape text content for HTML. */
export function escapeHtmlText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/ /g, "&nbsp;");
}

/** Escape a double-quoted attribute value. */
export function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/ /g, "&nbsp;");
}
