/**
 * Patch engine. Every operation:
 *  1. is validated (schema, target layer, allow-listed values),
 *  2. is applied as minimal splices on the source (markup it does not touch stays byte-identical),
 *  3. is checked by outcome: the result must parse, must not add structural contract errors
 *     and must not add anything the sanitiser would remove,
 *  4. returns the new document and an inverse operation. Applying the inverse to the result
 *     restores the previous document byte-for-byte.
 * Output is deterministic: same input, same operation, same bytes.
 */
import {
  LAYER_ATTRIBUTES as A,
  LAYER_ID_PATTERN,
  TEXT_INLINE_TAGS,
} from "../contract/constants.ts";
import {
  inlineStyle,
  isLayerElement,
  type ParsedSlide,
  parseSlide,
  readTransform,
  subtreeIds,
} from "../document/model.ts";
import {
  applySplices,
  attrRange,
  attrValueRange,
  elementRanges,
  escapeAttr,
  escapeHtmlText,
  getAttr,
  isElement,
  type P5Element,
  parseFragmentIn,
  type Splice,
  walkElements,
} from "../html/dom.ts";
import { sanitizeFindings } from "../sanitize/sanitize.ts";
import { isVirtualAssetUrl } from "../sanitize/url.ts";
import {
  type ColorValue,
  type NewLayerSpec,
  type PatchEntry,
  PatchOp,
  type PatchOpInput,
} from "./ops.ts";
import {
  editDeclarations,
  isAllowedStyle,
  isColorLiteral,
  num,
  STYLE_PROPERTIES,
} from "./style.ts";

export type PatchErrorCode =
  | "invalid_op"
  | "unknown_layer"
  | "ambiguous_layer"
  | "wrong_layer_type"
  | "invalid_value"
  | "invalid_html"
  | "unsafe_html"
  | "contract_violation"
  | "not_editable";

export class PatchError extends Error {
  readonly code: PatchErrorCode;
  readonly details: unknown;
  constructor(code: PatchErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "PatchError";
    this.code = code;
    this.details = details;
  }
}

export interface PatchContext {
  /** Brand colour token names (`green`, `ink`, ...). When given, colour tokens must be one of them. */
  colorTokens?: readonly string[];
  /** Brand font role tokens (`display`, `text`). When given, font tokens must be one of them. */
  fontTokens?: readonly string[];
  /** Allowed asset prefixes (default `/brand/`, `/media/`). */
  assetPrefixes?: readonly string[];
}

export interface PatchResult {
  html: string;
  /** Parsed result, ready for the next operation. */
  doc: ParsedSlide;
  op: PatchOp;
  inverse: PatchOp;
}

// --- Location helpers --------------------------------------------------------------

function fail(code: PatchErrorCode, message: string, details?: unknown): never {
  throw new PatchError(code, message, details);
}

function target(doc: ParsedSlide, id: string): { el: P5Element; type: string } {
  if (doc.duplicateIds.has(id)) fail("ambiguous_layer", `layer "${id}" occurs more than once`);
  const entry = doc.entries.get(id);
  if (!entry) fail("unknown_layer", `no layer "${id}"`);
  return { el: entry.el, type: entry.type };
}

function ranges(el: P5Element) {
  return elementRanges(el) ?? fail("not_editable", `<${el.tagName}> has no source location`);
}

function outerHtml(doc: ParsedSlide, el: P5Element): string {
  const r = ranges(el);
  return doc.html.slice(r.outer.start, r.outer.end);
}

/** Set (string), set as boolean (`true`) or remove (`null`) an attribute with a minimal diff. */
function attrSplice(
  source: string,
  el: P5Element,
  name: string,
  value: string | true | null,
): Splice | null {
  const r = attrRange(el, name);
  const current = getAttr(el, name);
  if (value === null) {
    if (!r) return null;
    const st = ranges(el).startTag;
    let start = r.start;
    while (start > st.start && /\s/.test(source[start - 1] as string)) start--;
    return { start, end: r.end, text: "" };
  }
  const text = value === true ? name : `${name}="${escapeAttr(value)}"`;
  if (r) {
    if (value === true) return current === "" ? null : { start: r.start, end: r.end, text };
    if (current === value) return null;
    const vr = attrValueRange(source, r);
    if (vr && vr.quote === '"') return { start: vr.start, end: vr.end, text: escapeAttr(value) };
    return { start: r.start, end: r.end, text };
  }
  const st = ranges(el).startTag;
  const end = source[st.end - 2] === "/" ? st.end - 2 : st.end - 1;
  let at = end;
  while (at > st.start && /\s/.test(source[at - 1] as string)) at--;
  return { start: at, end: at, text: ` ${text}` };
}

function styleSplice(
  source: string,
  el: P5Element,
  changes: ReadonlyArray<readonly [string, string | null]>,
): Splice | null {
  const current = getAttr(el, "style") ?? "";
  const next = editDeclarations(current, changes);
  if (next === current) return null;
  if (next.trim() === "") return attrSplice(source, el, "style", null);
  return attrSplice(source, el, "style", next);
}

function validateStyle(changes: ReadonlyArray<readonly [string, string | null]>) {
  for (const [p, v] of changes) {
    if (!Object.hasOwn(STYLE_PROPERTIES, p))
      fail("invalid_value", `style property "${p}" is not editable`, { property: p });
    if (v !== null && !isAllowedStyle(p, v))
      fail("invalid_value", `style "${p}: ${v}" is not allowed`, { property: p, value: v });
  }
}

function colorCss(value: ColorValue, ctx: PatchContext): string {
  if ("token" in value) {
    if (ctx.colorTokens && !ctx.colorTokens.includes(value.token))
      fail("invalid_value", `unknown colour token "${value.token}"`, { known: ctx.colorTokens });
    return `var(--color-${value.token})`;
  }
  if (!isColorLiteral(value.literal))
    fail("invalid_value", `"${value.literal}" is not a colour literal`);
  return value.literal.trim();
}

// --- Containers and gaps -----------------------------------------------------------

interface Container {
  el: P5Element;
  /** Direct element children that are layers, in order. */
  kids: P5Element[];
  inner: { start: number; end: number };
}

function container(doc: ParsedSlide, parent: string | null): Container {
  let el: P5Element;
  if (parent === null) {
    el = doc.artboard ?? fail("contract_violation", "document has no artboard");
  } else {
    const t = target(doc, parent);
    if (t.type !== "group")
      fail("wrong_layer_type", `"${parent}" is a ${t.type}; only groups contain layers`);
    el = t.el;
  }
  const r = ranges(el);
  const kids = el.childNodes.filter((n): n is P5Element => isElement(n) && isLayerElement(n));
  return { el, kids, inner: r.inner };
}

function containerOf(
  doc: ParsedSlide,
  el: P5Element,
): { parent: string | null; c: Container; index: number } {
  const p = el.parentNode;
  if (!p || !isElement(p)) fail("not_editable", "layer has no parent element");
  let parent: string | null;
  if (p === doc.artboard) parent = null;
  else if (isLayerElement(p) && getAttr(p, A.type) === "group") parent = getAttr(p, A.id);
  else
    fail(
      "not_editable",
      "layer must be a direct child of a group or the artboard for this operation",
    );
  const c = container(doc, parent);
  return { parent, c, index: c.kids.indexOf(el) };
}

function gap(c: Container, i: number): { start: number; end: number } {
  const prev = i > 0 ? c.kids[i - 1] : undefined;
  const next = c.kids[i];
  const start = prev ? ranges(prev).outer.end : c.inner.start;
  const end = next ? ranges(next).outer.start : c.inner.end;
  return { start, end };
}

/** Whitespace immediately before `pos`, not crossing `floor`. */
function wsBefore(source: string, pos: number, floor: number): number {
  let k = pos;
  while (k > floor && /\s/.test(source[k - 1] as string)) k--;
  return pos - k;
}

/** Leading whitespace for a new layer at `index` that matches its neighbours' indentation. */
function defaultLeading(source: string, c: Container, index: number): string {
  const ref = c.kids[Math.min(index, c.kids.length - 1)];
  if (ref) {
    const g = gap(c, c.kids.indexOf(ref));
    const r = ranges(ref).outer;
    return source.slice(r.start - wsBefore(source, r.start, g.start), r.start);
  }
  const st = ranges(c.el).startTag;
  const lineStart = source.lastIndexOf("\n", st.start - 1) + 1;
  if (lineStart === 0 && !source.includes("\n")) return "";
  const indent = /^[ \t]*/.exec(source.slice(lineStart, st.start))?.[0] ?? "";
  return `\n${indent}  `;
}

interface Removal {
  splice: Splice;
  parent: string | null;
  index: number;
  leading: string;
  gapOffset: number;
  html: string;
}

function removal(doc: ParsedSlide, el: P5Element): Removal {
  const { parent, c, index } = containerOf(doc, el);
  const g = gap(c, index);
  const r = ranges(el).outer;
  const ws = wsBefore(doc.html, r.start, g.start);
  return {
    splice: { start: r.start - ws, end: r.end, text: "" },
    parent,
    index,
    leading: doc.html.slice(r.start - ws, r.start),
    gapOffset: r.start - ws - g.start,
    html: doc.html.slice(r.start, r.end),
  };
}

function insertion(
  doc: ParsedSlide,
  parent: string | null,
  index: number,
  text: string,
  gapOffset = 0,
): Splice {
  const c = container(doc, parent);
  if (index > c.kids.length)
    fail("invalid_value", `index ${index} is past the end (${c.kids.length} layers)`);
  const g = gap(c, index);
  const at = g.start + gapOffset;
  if (at > g.end) fail("invalid_value", `gapOffset ${gapOffset} is outside the gap`);
  return { start: at, end: at, text };
}

// --- Fragment validation -------------------------------------------------------------

function singleElement(html: string, context: P5Element | undefined): P5Element {
  const frag = parseFragmentIn(html, context);
  const elements = frag.childNodes.filter(isElement);
  const strayText = frag.childNodes.some(
    (n) => n.nodeName === "#text" && "value" in n && (n as { value: string }).value.trim() !== "",
  );
  if (elements.length !== 1 || strayText)
    fail("invalid_html", "html must contain exactly one element");
  const el = elements[0] as P5Element;
  const r = elementRanges(el);
  if (
    !r ||
    r.outer.start !== html.length - html.trimStart().length ||
    r.outer.end !== html.trimEnd().length
  )
    fail("invalid_html", "html must be exactly one element (no surrounding text or comments)");
  if (html !== html.trim())
    fail("invalid_html", "html must not have surrounding whitespace (use `leading`)");
  if (!r.endTag && !VOID_ELEMENTS.has(el.tagName))
    fail("invalid_html", `<${el.tagName}> must be closed with </${el.tagName}>`);
  return el;
}

const VOID_ELEMENTS = new Set([
  "img",
  "br",
  "hr",
  "wbr",
  "col",
  "meta",
  "link",
  "area",
  "base",
  "embed",
  "input",
  "source",
  "track",
]);

/**
 * Layers the operation does not touch must come out byte-identical, and none may vanish.
 * Catches markup that is well-formed on its own but swallows its neighbours once spliced
 * in (an unterminated comment, an unclosed element).
 */
function checkUntouched(before: ParsedSlide, after: ParsedSlide, op: PatchOp) {
  const changed = new Set<string>();
  const withAncestors = (id: string) => {
    let cur: string | null = id;
    while (cur) {
      changed.add(cur);
      cur = before.layer(cur)?.parent ?? null;
    }
  };
  if ("layer" in op && typeof op.layer === "string") {
    for (const id of subtreeIds(before.model, op.layer)) changed.add(id);
    withAncestors(op.layer);
  }
  if ((op.op === "addLayer" || op.op === "insertLayer") && op.parent) withAncestors(op.parent);
  for (const id of before.entries.keys()) {
    if (changed.has(id)) continue;
    if (!after.entries.has(id)) fail("invalid_html", `the edit removed layer "${id}"`);
    if (after.layerHtml(id) !== before.layerHtml(id))
      fail("invalid_html", `the edit changed layer "${id}"`);
  }
}

function validateInlineHtml(html: string, context: P5Element) {
  const frag = parseFragmentIn(html, context);
  const allowed = new Set<string>(TEXT_INLINE_TAGS);
  for (const el of walkElements(frag)) {
    if (isLayerElement(el)) fail("invalid_html", "text layers must not contain layers");
    if (!allowed.has(el.tagName))
      fail(
        "invalid_html",
        `<${el.tagName}> is not allowed in text; use ${TEXT_INLINE_TAGS.join(", ")}`,
      );
    for (const a of el.attrs) {
      if (!["class", "style", "lang", "dir"].includes(a.name))
        fail("invalid_html", `attribute "${a.name}" is not allowed in text markup`);
    }
  }
}

function checkAsset(src: string, ctx: PatchContext, what: string) {
  if (!isVirtualAssetUrl(src, ctx.assetPrefixes))
    fail("invalid_value", `${what} "${src}" must be a /brand/ or /media/ path`);
}

// --- Layer HTML generation --------------------------------------------------------------

function styleText(style: Record<string, string> | undefined): string | null {
  if (!style) return null;
  const entries = Object.entries(style);
  validateStyle(entries);
  return entries.length ? entries.map(([p, v]) => `${p}: ${v.trim()}`).join("; ") : null;
}

export function layerSpecHtml(spec: NewLayerSpec, ctx: PatchContext = {}): string {
  const attrs: string[] = [`data-layer="${spec.id}"`, `data-type="${spec.type}"`];
  if (spec.role) attrs.push(`data-role="${spec.role}"`);
  const extra: string[] = [];
  if (spec.className) extra.push(`class="${escapeAttr(spec.className)}"`);
  const st = styleText(spec.style);
  const styleAttr = st ? `style="${escapeAttr(st)}"` : null;
  switch (spec.type) {
    case "text": {
      const tag = spec.tag ?? "p";
      return `<${tag} ${[...attrs, ...extra, styleAttr].filter(Boolean).join(" ")}>${textHtml(spec.text)}</${tag}>`;
    }
    case "image":
    case "logo":
      checkAsset(spec.src, ctx, "src");
      if (spec.type === "logo" && !spec.src.startsWith("/brand/logos/"))
        fail("invalid_value", "logos come from /brand/logos/");
      return `<img ${[...attrs, ...extra, `src="${escapeAttr(spec.src)}"`, `alt="${escapeAttr(spec.alt ?? "")}"`, styleAttr].filter(Boolean).join(" ")}>`;
    case "slot":
      return `<figure ${[...attrs, `data-slot-ratio="${spec.ratio}"`, `data-slot-state="empty"`, `data-slot-label="${escapeAttr(spec.label)}"`, spec.fit ? `data-slot-fit="${spec.fit}"` : null, ...extra, styleAttr].filter(Boolean).join(" ")}></figure>`;
    default:
      return `<div ${[...attrs, ...extra, styleAttr].filter(Boolean).join(" ")}></div>`;
  }
}

function textHtml(text: string): string {
  return text.split("\n").map(escapeHtmlText).join("<br>");
}

// --- Outcome checks -------------------------------------------------------------------

function issueKeys(doc: ParsedSlide): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of doc.model.issues) {
    if (i.severity !== "error") continue;
    const k = `${i.rule}|${i.layer ?? ""}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function findingKeys(html: string, ctx: PatchContext): Map<string, number> {
  const m = new Map<string, number>();
  for (const f of sanitizeFindings(html, { assetPrefixes: ctx.assetPrefixes })) {
    const k = `${f.kind}|${f.tag}|${f.attribute ?? ""}|${f.detail}`;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

function added(before: Map<string, number>, after: Map<string, number>): string[] {
  const out: string[] = [];
  for (const [k, n] of after) if (n > (before.get(k) ?? 0)) out.push(k);
  return out;
}

// --- Operations ---------------------------------------------------------------------------

interface Planned {
  splices: Splice[];
  inverse: (before: ParsedSlide, after: ParsedSlide) => PatchOp;
  /** Id that must exist after the edit (insertions). */
  expect?: string;
}

const replaceInverse = (id: string, html: string) => (): PatchOp => ({
  op: "replaceLayer",
  layer: id,
  html,
});

function plan(doc: ParsedSlide, op: PatchOp, ctx: PatchContext): Planned {
  const src = doc.html;
  switch (op.op) {
    case "setText": {
      const { el, type } = target(doc, op.layer);
      if (type !== "text") fail("wrong_layer_type", `"${op.layer}" is a ${type} layer`);
      const html = op.html ?? textHtml(op.text ?? "");
      if (op.html !== undefined) validateInlineHtml(op.html, el);
      const r = ranges(el);
      if (!r.endTag) fail("not_editable", "text layer has no end tag");
      return {
        splices: [{ start: r.inner.start, end: r.inner.end, text: html }],
        inverse: replaceInverse(op.layer, outerHtml(doc, el)),
      };
    }
    case "setStyle": {
      const { el } = target(doc, op.layer);
      const changes = Object.entries(op.set);
      validateStyle(changes);
      const sp = styleSplice(
        src,
        el,
        changes.map(([p, v]) => [p, v === null ? null : v.trim()] as const),
      );
      return { splices: sp ? [sp] : [], inverse: replaceInverse(op.layer, outerHtml(doc, el)) };
    }
    case "transform": {
      const { el } = target(doc, op.layer);
      const changes: [string, string | null][] = [];
      if (op.translate !== undefined)
        changes.push([
          "translate",
          op.translate === null ? null : `${num(op.translate.x)}px ${num(op.translate.y)}px`,
        ]);
      if (op.rotate !== undefined)
        changes.push(["rotate", op.rotate === null ? null : `${num(op.rotate)}deg`]);
      if (op.scale !== undefined)
        changes.push([
          "scale",
          op.scale === null
            ? null
            : typeof op.scale === "number"
              ? num(op.scale)
              : `${num(op.scale.x)} ${num(op.scale.y)}`,
        ]);
      validateStyle(changes);
      const sp = styleSplice(src, el, changes);
      return { splices: sp ? [sp] : [], inverse: replaceInverse(op.layer, outerHtml(doc, el)) };
    }
    case "resize": {
      const { el } = target(doc, op.layer);
      const changes: [string, string | null][] = [];
      if (op.width !== undefined)
        changes.push(["width", op.width === null ? null : `${num(op.width)}px`]);
      if (op.height !== undefined)
        changes.push(["height", op.height === null ? null : `${num(op.height)}px`]);
      const sp = styleSplice(src, el, changes);
      return { splices: sp ? [sp] : [], inverse: replaceInverse(op.layer, outerHtml(doc, el)) };
    }
    case "setColor": {
      const { el } = target(doc, op.layer);
      const value = op.value === null ? null : colorCss(op.value, ctx);
      const sp = styleSplice(src, el, [[op.property, value]]);
      return { splices: sp ? [sp] : [], inverse: replaceInverse(op.layer, outerHtml(doc, el)) };
    }
    case "setTypography": {
      const { el, type } = target(doc, op.layer);
      if (type !== "text" && type !== "group")
        fail(
          "wrong_layer_type",
          `typography applies to text and group layers, "${op.layer}" is ${type}`,
        );
      if (op.fontFamily && ctx.fontTokens && !ctx.fontTokens.includes(op.fontFamily))
        fail("invalid_value", `unknown font token "${op.fontFamily}"`, { known: ctx.fontTokens });
      const changes: [string, string | null][] = [];
      const put = (p: string, v: string | null | undefined) => {
        if (v !== undefined) changes.push([p, v]);
      };
      put(
        "font-family",
        op.fontFamily === undefined
          ? undefined
          : op.fontFamily === null
            ? null
            : `var(--font-${op.fontFamily})`,
      );
      put(
        "font-size",
        op.fontSize === undefined
          ? undefined
          : op.fontSize === null
            ? null
            : `${num(op.fontSize)}px`,
      );
      put(
        "font-weight",
        op.fontWeight === undefined
          ? undefined
          : op.fontWeight === null
            ? null
            : String(op.fontWeight),
      );
      put(
        "line-height",
        op.lineHeight === undefined
          ? undefined
          : op.lineHeight === null
            ? null
            : num(op.lineHeight),
      );
      put(
        "letter-spacing",
        op.letterSpacing === undefined
          ? undefined
          : op.letterSpacing === null
            ? null
            : `${num(op.letterSpacing)}em`,
      );
      put("text-align", op.textAlign);
      put("font-style", op.fontStyle);
      put("text-transform", op.textTransform);
      validateStyle(changes);
      const sp = styleSplice(src, el, changes);
      return { splices: sp ? [sp] : [], inverse: replaceInverse(op.layer, outerHtml(doc, el)) };
    }
    case "replaceImage": {
      const { el, type } = target(doc, op.layer);
      if (type !== "image" && type !== "logo")
        fail("wrong_layer_type", `"${op.layer}" is a ${type} layer; use fillSlot for slots`);
      if (el.tagName !== "img") fail("not_editable", "image layer is not an <img>");
      checkAsset(op.src, ctx, "src");
      if (type === "logo" && !op.src.startsWith("/brand/logos/"))
        fail("invalid_value", "logos come from /brand/logos/");
      const splices = [
        attrSplice(src, el, "src", op.src),
        op.alt !== undefined ? attrSplice(src, el, "alt", op.alt) : null,
      ].filter((s): s is Splice => !!s);
      return { splices, inverse: replaceInverse(op.layer, outerHtml(doc, el)) };
    }
    case "setImageFit": {
      const { el, type } = target(doc, op.layer);
      let img: P5Element | null = null;
      if (type === "image") img = el;
      else if (type === "slot")
        img =
          [...walkElements(el)].find(
            (e) => e.tagName === "img" && getAttr(e, A.slotImage) !== null,
          ) ?? null;
      if (type === "logo") fail("wrong_layer_type", "logos are never cropped");
      if (!img)
        fail("wrong_layer_type", `"${op.layer}" has no image to fit (empty slot or ${type} layer)`);
      const changes: [string, string | null][] = [];
      if (op.fit !== undefined) changes.push(["object-fit", op.fit]);
      if (op.position !== undefined)
        changes.push([
          "object-position",
          op.position === null ? null : `${op.position.x} ${op.position.y}`,
        ]);
      validateStyle(changes);
      const sp = styleSplice(src, img, changes);
      return { splices: sp ? [sp] : [], inverse: replaceInverse(op.layer, outerHtml(doc, el)) };
    }
    case "fillSlot": {
      const { el, type } = target(doc, op.layer);
      if (type !== "slot") fail("wrong_layer_type", `"${op.layer}" is a ${type} layer`);
      checkAsset(op.src, ctx, "src");
      const r = ranges(el);
      if (!r.endTag) fail("not_editable", "slot has no end tag");
      const style = [
        op.fit ? `object-fit: ${op.fit}` : null,
        op.position ? `object-position: ${op.position.x} ${op.position.y}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      const img = `<img data-slot-image src="${escapeAttr(op.src)}" alt="${escapeAttr(op.alt ?? "")}"${style ? ` style="${escapeAttr(style)}"` : ""}>`;
      const splices = [
        attrSplice(src, el, A.slotState, "filled"),
        { start: r.inner.start, end: r.inner.end, text: img },
      ].filter((s): s is Splice => !!s);
      return { splices, inverse: replaceInverse(op.layer, outerHtml(doc, el)) };
    }
    case "clearSlot": {
      const { el, type } = target(doc, op.layer);
      if (type !== "slot") fail("wrong_layer_type", `"${op.layer}" is a ${type} layer`);
      const r = ranges(el);
      const splices = [
        attrSplice(src, el, A.slotState, "empty"),
        r.inner.end > r.inner.start ? { start: r.inner.start, end: r.inner.end, text: "" } : null,
      ].filter((s): s is Splice => !!s);
      return { splices, inverse: replaceInverse(op.layer, outerHtml(doc, el)) };
    }
    case "setVisibility": {
      const { el } = target(doc, op.layer);
      const sp = attrSplice(src, el, A.hidden, op.hidden ? true : null);
      return { splices: sp ? [sp] : [], inverse: replaceInverse(op.layer, outerHtml(doc, el)) };
    }
    case "replaceLayer": {
      const { el } = target(doc, op.layer);
      const parentEl = el.parentNode && isElement(el.parentNode) ? el.parentNode : undefined;
      const root = singleElement(op.html, parentEl);
      if (getAttr(root, A.id) !== op.layer)
        fail("invalid_html", `the replacement must keep data-layer="${op.layer}"`);
      const r = ranges(el);
      return {
        splices: [{ start: r.outer.start, end: r.outer.end, text: op.html }],
        inverse: replaceInverse(op.layer, outerHtml(doc, el)),
        expect: op.layer,
      };
    }
    case "deleteLayer": {
      const { el } = target(doc, op.layer);
      const rm = removal(doc, el);
      return {
        splices: [rm.splice],
        inverse: () => ({
          op: "insertLayer",
          parent: rm.parent,
          index: rm.index,
          html: rm.html,
          ...(rm.leading ? { leading: rm.leading } : {}),
          ...(rm.gapOffset ? { gapOffset: rm.gapOffset } : {}),
        }),
      };
    }
    case "insertLayer": {
      const c = container(doc, op.parent);
      const root = singleElement(op.html, c.el);
      const id = getAttr(root, A.id);
      if (!id || !LAYER_ID_PATTERN.test(id))
        fail("invalid_html", "the inserted element needs a valid data-layer id");
      if (doc.entries.has(id) || doc.duplicateIds.has(id))
        fail("invalid_value", `layer "${id}" already exists`);
      const sp = insertion(
        doc,
        op.parent,
        op.index,
        (op.leading ?? "") + op.html,
        op.gapOffset ?? 0,
      );
      if (sp.start > 0 && (op.gapOffset ?? 0) > 0 && /\s/.test(src[sp.start - 1] as string))
        fail("invalid_value", "gapOffset must not point into whitespace");
      return { splices: [sp], inverse: () => ({ op: "deleteLayer", layer: id }), expect: id };
    }
    case "addLayer": {
      const c = container(doc, op.parent);
      const id = op.layer.id;
      if (doc.entries.has(id) || doc.duplicateIds.has(id))
        fail("invalid_value", `layer "${id}" already exists`);
      const index = op.index ?? c.kids.length;
      const html = layerSpecHtml(op.layer, ctx);
      const sp = insertion(doc, op.parent, index, defaultLeading(src, c, index) + html);
      return { splices: [sp], inverse: () => ({ op: "deleteLayer", layer: id }), expect: id };
    }
    case "duplicateLayer": {
      const { el } = target(doc, op.layer);
      const { parent, c, index } = containerOf(doc, el);
      const taken = new Set([...doc.entries.keys(), ...doc.duplicateIds]);
      const unique = (base: string) => {
        let cand = base.slice(0, 48);
        for (let n = 2; taken.has(cand); n++) cand = `${base.slice(0, 44)}-${n}`;
        taken.add(cand);
        return cand;
      };
      let copy = outerHtml(doc, el);
      // Rename every layer id inside the copy.
      const frag = parseFragmentIn(copy, c.el);
      const renames: Splice[] = [];
      let rootId = "";
      for (const e of walkElements(frag)) {
        const id = getAttr(e, A.id);
        if (id === null) continue;
        const isRoot = rootId === "";
        let next: string;
        if (isRoot && op.newId) {
          if (taken.has(op.newId)) fail("invalid_value", `layer "${op.newId}" already exists`);
          taken.add(op.newId);
          next = op.newId;
        } else next = unique(`${id}-copy`);
        if (isRoot) rootId = next;
        const ar = attrRange(e, A.id);
        const vr = ar ? attrValueRange(copy, ar) : null;
        if (!ar) fail("not_editable", "layer id has no source location");
        renames.push(
          vr && vr.quote === '"'
            ? { start: vr.start, end: vr.end, text: next }
            : { start: ar.start, end: ar.end, text: `${A.id}="${next}"` },
        );
      }
      copy = applySplices(copy, renames);
      if (op.offset) {
        const f2 = parseFragmentIn(copy, c.el);
        const root = f2.childNodes.find(isElement) as P5Element;
        const cur = readTransform(inlineStyle(root));
        const tx = (cur.translate?.x ?? 0) + op.offset.x;
        const ty = (cur.translate?.y ?? 0) + op.offset.y;
        const sp = styleSplice(copy, root, [["translate", `${num(tx)}px ${num(ty)}px`]]);
        if (sp) copy = applySplices(copy, [sp]);
      }
      const leading = (() => {
        const g = gap(c, index);
        const r = ranges(el).outer;
        return src.slice(r.start - wsBefore(src, r.start, g.start), r.start);
      })();
      const sp = insertion(doc, parent, index + 1, leading + copy);
      return {
        splices: [sp],
        inverse: () => ({ op: "deleteLayer", layer: rootId }),
        expect: rootId,
      };
    }
    case "moveLayer": {
      const { el } = target(doc, op.layer);
      const rm = removal(doc, el);
      const max = container(doc, rm.parent).kids.length - 1;
      if (op.index > max) fail("invalid_value", `index ${op.index} is past the end (max ${max})`);
      // Two phases; the second needs offsets in the document after removal.
      return {
        splices: [rm.splice],
        inverse: () => ({
          op: "moveLayer",
          layer: op.layer,
          index: rm.index,
          ...(rm.gapOffset ? { gapOffset: rm.gapOffset } : {}),
        }),
        expect: op.layer,
      };
    }
  }
}

/** Apply one operation. Throws `PatchError` when the operation is invalid. */
export function applyPatch(
  input: string | ParsedSlide,
  opInput: PatchOpInput | PatchOp,
  ctx: PatchContext = {},
): PatchResult {
  const doc = typeof input === "string" ? parseSlide(input) : input;
  const parsed = PatchOp.safeParse(opInput);
  if (!parsed.success)
    fail(
      "invalid_op",
      `invalid operation: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      parsed.error.issues,
    );
  const op = parsed.data;
  const p = plan(doc, op, ctx);
  let html = applySplices(doc.html, p.splices);
  if (op.op === "moveLayer") {
    const mid = parseSlide(html);
    const rm = removal(doc, target(doc, op.layer).el);
    const sp = insertion(mid, rm.parent, op.index, rm.leading + rm.html, op.gapOffset ?? 0);
    if ((op.gapOffset ?? 0) > 0 && /\s/.test(html[sp.start - 1] as string))
      fail("invalid_value", "gapOffset must not point into whitespace");
    html = applySplices(html, [sp]);
  }
  const after = parseSlide(html);
  if (p.expect && !after.entries.has(p.expect))
    fail(
      "invalid_html",
      `layer "${p.expect}" is not a layer after the edit (markup was not well-formed)`,
    );
  if (op.op === "insertLayer" || op.op === "moveLayer") {
    const id = op.op === "insertLayer" ? (p.expect as string) : op.layer;
    const el = after.entries.get(id)?.el as P5Element;
    const { parent, index } = containerOf(after, el);
    if (op.op === "insertLayer" && parent !== op.parent)
      fail("invalid_html", "the element did not land in the requested container");
    if (index !== op.index)
      fail("invalid_value", `the layer landed at index ${index}, not ${op.index}`);
  }
  const newIssues = added(issueKeys(doc), issueKeys(after));
  if (newIssues.length)
    fail(
      "contract_violation",
      `the edit breaks the design contract: ${newIssues.join(", ")}`,
      newIssues,
    );
  checkUntouched(doc, after, op);
  const newFindings = added(findingKeys(doc.html, ctx), findingKeys(html, ctx));
  if (newFindings.length)
    fail("unsafe_html", `the edit adds unsafe markup: ${newFindings.join(", ")}`, newFindings);
  return { html, doc: after, op, inverse: p.inverse(doc, after) };
}

/** Apply operations in order. Returns the final document and one entry per operation. */
export function applyPatches(
  input: string | ParsedSlide,
  ops: ReadonlyArray<PatchOpInput | PatchOp>,
  ctx: PatchContext = {},
): { html: string; doc: ParsedSlide; entries: PatchEntry[] } {
  let doc = typeof input === "string" ? parseSlide(input) : input;
  const entries: PatchEntry[] = [];
  for (const op of ops) {
    const r = applyPatch(doc, op, ctx);
    entries.push({ op: r.op, inverse: r.inverse });
    doc = r.doc;
  }
  return { html: doc.html, doc, entries };
}

/** Undo a list of entries (applies the inverses in reverse order). */
export function revertPatches(
  input: string | ParsedSlide,
  entries: readonly PatchEntry[],
  ctx: PatchContext = {},
): { html: string; doc: ParsedSlide } {
  let doc = typeof input === "string" ? parseSlide(input) : input;
  for (const e of [...entries].reverse()) doc = applyPatch(doc, e.inverse, ctx).doc;
  return { html: doc.html, doc };
}
