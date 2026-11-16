/**
 * Static checks: everything that can be decided from the markup and CSS alone. Runs in
 * the worker, the web editor and tests without a browser.
 */
import {
  LAYER_ATTRIBUTES as A,
  BRAND_CSS_PATH,
  CONTRACT_LIMITS,
  FORBIDDEN_ELEMENTS,
  LOGO_PREFIX,
} from "../contract/constants.ts";
import type { ParsedSlide } from "../document/model.ts";
import {
  type CssDeclaration,
  type CssToken,
  parseDeclarationList,
  parseStylesheet,
  urlReferences,
  walkRules,
} from "../html/css.ts";
import {
  closest,
  getAttr,
  hasAttr,
  NS,
  type P5Element,
  plainText,
  textContent,
  walkElements,
} from "../html/dom.ts";
import { sanitizeFindings } from "../sanitize/sanitize.ts";
import { isVirtualAssetUrl } from "../sanitize/url.ts";
import { SUPPORTED_CONTRACT_VERSIONS } from "../version.ts";
import { extractNumbers, hasPercent, isAllowedNumber } from "./numbers.ts";
import { issue, type LayerMetrics, type LintConfig, type LintIssue } from "./report.ts";

const NEUTRAL_HEX = /^#(fff|ffffff|000|000000)$/i;
const NEUTRAL_FN = /^rgba?\(\s*(0\s*[, ]\s*0\s*[, ]\s*0|255\s*[, ]\s*255\s*[, ]\s*255)\b[^)]*\)$/i;
const COLOR_FNS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
]);
const VIEWPORT_UNITS = new Set([
  "vw",
  "vh",
  "vmin",
  "vmax",
  "svh",
  "lvh",
  "dvh",
  "svw",
  "lvw",
  "dvw",
  "vi",
  "vb",
  "svi",
  "svb",
  "lvi",
  "lvb",
  "dvi",
  "dvb",
]);
const BLOCK_IN_TEXT = new Set([
  "div",
  "p",
  "section",
  "figure",
  "img",
  "svg",
  "ul",
  "ol",
  "table",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

/** Colour literals in a value (hex tokens and colour functions), excluding pure black/white. */
function colourLiterals(value: string, tokens: CssToken[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as CssToken;
    if (t.type === "hash" && /^([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t.value)) {
      const lit = `#${t.value}`;
      if (!NEUTRAL_HEX.test(lit)) out.push(lit);
    }
    if (t.type === "function" && COLOR_FNS.has(t.value.toLowerCase())) {
      let depth = 1;
      let j = i + 1;
      for (; j < tokens.length && depth > 0; j++) {
        const u = tokens[j] as CssToken;
        if (u.type === "function" || u.type === "(") depth++;
        else if (u.type === ")") depth--;
      }
      const end = tokens[j - 1]?.end ?? t.end;
      const text = value.slice(t.start, end);
      if (!NEUTRAL_FN.test(text.replace(/\s+/g, " "))) out.push(text);
    }
  }
  return out;
}

interface CssCheckState {
  issues: LintIssue[];
  colours: Set<string>;
}

function checkDeclaration(
  decl: CssDeclaration,
  where: string,
  layer: string | null,
  state: CssCheckState,
) {
  const v = decl.value;
  const at = `${where}: "${decl.name}: ${v.slice(0, 80)}"`;
  const refs = urlReferences(decl.tokens);
  if (refs.urls.length || refs.bad || refs.dynamic)
    state.issues.push(
      issue(
        "css-url",
        layer,
        `${at} uses url(); images must be <img> layers and fonts come from brand.css.`,
      ),
    );
  if (
    decl.name === "position" &&
    decl.tokens.some((t) => t.type === "ident" && /^(fixed|sticky)$/i.test(t.value))
  )
    state.issues.push(issue("css-position", layer, `${where}: position:${v} is not allowed.`));
  if (
    decl.tokens.some(
      (t) => t.type === "dimension" && VIEWPORT_UNITS.has((t.unit ?? "").toLowerCase()),
    )
  )
    state.issues.push(
      issue(
        "css-viewport-unit",
        layer,
        `${where}: viewport units (${v.slice(0, 40)}) are not allowed; use px.`,
      ),
    );
  if (
    /^(animation|animation-name|transition|transition-property)$/.test(decl.name) &&
    !/^(none|all 0s ease 0s|0s|initial|unset)$/i.test(v.trim())
  )
    state.issues.push(
      issue(
        "css-animation",
        layer,
        `${where}: ${decl.name} has no effect in a static render; remove it.`,
      ),
    );
  if (!decl.name.startsWith("--"))
    for (const c of colourLiterals(v, decl.tokens)) state.colours.add(c);
}

function layerIdOf(el: P5Element): string | null {
  const l = closest(el, (e) => hasAttr(e, A.id), true);
  return l ? getAttr(l, A.id) : null;
}

export function staticLint(
  doc: ParsedSlide,
  config: LintConfig,
): { issues: LintIssue[]; layers: LayerMetrics[] } {
  const issues: LintIssue[] = [];
  const { model, tree, artboard } = doc;
  const push = (i: LintIssue) => issues.push(i);

  // ---- document
  if (!model.contract)
    push(
      issue(
        "contract-version",
        null,
        'No <meta name="studio:contract">; contract v1 rules were applied.',
      ),
    );
  else if (!(SUPPORTED_CONTRACT_VERSIONS as readonly string[]).includes(model.contract))
    push(
      issue(
        "contract-version",
        null,
        `Unknown contract "${model.contract}"; contract v1 rules were applied.`,
      ),
    );
  else if (model.contract !== "v1")
    push(
      issue(
        "contract-version",
        null,
        `Document declares contract ${model.contract}; contract v1 rules were applied.`,
      ),
    );
  const lang = (config.lang ?? "tr").toLowerCase();
  if ((model.lang ?? "").toLowerCase().split("-")[0] !== lang)
    push(
      issue(
        "lang",
        null,
        `<html lang="${lang}"> is required (Turkish casing İ/ı in text-transform).`,
      ),
    );
  for (const i of model.issues)
    push({ rule: i.rule, severity: i.severity, layer: i.layer, message: i.message });
  if (artboard && !model.artboard)
    push(
      issue(
        "artboard-inline-size",
        null,
        `The artboard should declare style="width:${config.width}px;height:${config.height}px".`,
      ),
    );
  if (
    model.artboard &&
    (model.artboard.width !== config.width || model.artboard.height !== config.height)
  )
    push(
      issue(
        "artboard-format-mismatch",
        null,
        `Artboard is ${model.artboard.width}x${model.artboard.height}, the target format is ${config.width}x${config.height}.`,
      ),
    );
  if (
    model.format &&
    model.artboard &&
    (model.format.width !== model.artboard.width || model.format.height !== model.artboard.height)
  )
    push(
      issue(
        "artboard-format-mismatch",
        null,
        `studio:format says ${model.format.width}x${model.format.height}, the artboard is ${model.artboard.width}x${model.artboard.height}.`,
      ),
    );

  // ---- forbidden constructs
  const forbidden = new Set<string>(FORBIDDEN_ELEMENTS);
  for (const el of walkElements(tree)) {
    const tag = el.tagName.toLowerCase();
    if (
      forbidden.has(tag) ||
      (tag === "meta" && hasAttr(el, "http-equiv")) ||
      (el.namespaceURI === NS.HTML && (tag === "frame" || tag === "frameset"))
    )
      push(
        issue(
          "forbidden-element",
          layerIdOf(el),
          `<${tag}${tag === "meta" ? " http-equiv" : ""}> is not allowed in a static design.`,
        ),
      );
    for (const a of el.attrs) {
      if (/^on/i.test(a.name))
        push(
          issue(
            "event-handler",
            layerIdOf(el),
            `Event handler attribute "${a.name}" is not allowed.`,
          ),
        );
      // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers strip these before parsing URLs
      if (/^javascript:/i.test(a.value.replace(/[\u0000- ]/g, "")))
        push(issue("javascript-url", layerIdOf(el), "javascript: URLs are not allowed."));
    }
  }
  const links = [...walkElements(tree)].filter((e) => e.tagName === "link");
  for (const l of links) {
    if (
      !(
        (getAttr(l, "rel") ?? "").toLowerCase().trim() === "stylesheet" &&
        getAttr(l, "href") === BRAND_CSS_PATH
      )
    ) {
      const desc = l.attrs
        .map((a) => `${a.name}="${a.value}"`)
        .join(" ")
        .slice(0, 140);
      push(
        issue(
          "forbidden-link",
          null,
          `Only <link rel="stylesheet" href="${BRAND_CSS_PATH}"> is allowed, found: <link ${desc}>`,
        ),
      );
    }
  }
  if (!links.some((l) => getAttr(l, "href") === BRAND_CSS_PATH))
    push(
      issue("brand-css-missing", null, `Missing <link rel="stylesheet" href="${BRAND_CSS_PATH}">.`),
    );
  for (const f of sanitizeFindings(doc.html)) {
    const covered =
      f.kind === "css" ||
      (f.kind === "element" &&
        (forbidden.has(f.tag) ||
          f.tag === "meta" ||
          f.tag === "link" ||
          f.tag === "frame" ||
          f.tag === "frameset")) ||
      (f.attribute ?? "").startsWith("on") ||
      (f.tag === "img" && f.attribute === "src");
    if (!covered)
      push(
        issue(
          "unsafe-markup",
          null,
          `<${f.tag}${f.attribute ? ` ${f.attribute}` : ""}>: ${f.detail} (${f.action} by the sanitiser).`,
        ),
      );
  }

  // ---- CSS
  const css: CssCheckState = { issues, colours: new Set() };
  for (const el of walkElements(tree)) {
    if (el.tagName === "style" && el.namespaceURI === NS.HTML) {
      const sheet = parseStylesheet(textContent(el));
      for (const rule of walkRules(sheet.rules)) {
        if (rule.kind === "at" && rule.name === "import")
          push(issue("css-import", null, "<style>: @import is not allowed."));
        if (rule.kind === "at" && rule.name === "font-face")
          push(issue("css-font-face", null, "<style>: @font-face is only allowed in brand.css."));
        if (
          rule.kind === "at" &&
          (rule.name === "keyframes" || rule.name === "-webkit-keyframes")
        ) {
          push(
            issue("css-animation", null, "<style>: @keyframes has no effect in a static render."),
          );
          continue;
        }
        const where =
          `<style> ${rule.kind === "qualified" ? rule.prelude.slice(0, 60) : `@${rule.name}`}`.trim();
        if (rule.kind === "at" && rule.name === "font-face") continue;
        for (const d of rule.declarations) checkDeclaration(d, where, null, css);
      }
    }
    const style = getAttr(el, "style");
    if (style) {
      const lid = layerIdOf(el);
      for (const d of parseDeclarationList(style))
        checkDeclaration(d, `style attr on ${lid ?? el.tagName}`, lid, css);
    }
  }
  if (css.colours.size)
    push(
      issue(
        "colour-literal",
        null,
        `Hard-coded colours found; use brand tokens var(--color-*) or color-mix() with tokens: ${[...css.colours].slice(0, 12).join(", ")}`,
        { colours: [...css.colours] },
      ),
    );

  // ---- layers
  const minLayers = model.layers;
  const byId = new Map(minLayers.map((l) => [l.id, l]));
  for (const layer of minLayers) {
    const el = doc.entries.get(layer.id)?.el as P5Element;
    if ((layer.type === "image" || layer.type === "logo") && el.tagName !== "img")
      push(
        issue(
          "image-not-img",
          layer.id,
          `${layer.type} layers must be <img> elements (replaceable), not <${el.tagName}>.`,
        ),
      );
    if (
      layer.type === "logo" &&
      el.tagName === "img" &&
      !(getAttr(el, "src") ?? "").startsWith(LOGO_PREFIX)
    )
      push(
        issue(
          "logo-src",
          layer.id,
          `Logo layers use a logo file from ${LOGO_PREFIX}, got "${(getAttr(el, "src") ?? "").slice(0, 80)}".`,
        ),
      );
    if (layer.type === "shape" && textContent(el).trim())
      push(
        issue(
          "shape-has-text",
          layer.id,
          "Shape layers must not contain text; put text in a text layer.",
        ),
      );
    if (layer.type === "group" && ![...walkElements(el)].some((e) => hasAttr(e, A.id)))
      push(issue("group-empty", layer.id, "Group has no child layers."));
    if (layer.type === "text") {
      const kids = [...walkElements(el)];
      if (kids.some((e) => hasAttr(e, A.id)))
        push(issue("text-nested-layer", layer.id, "Text layers must not contain other layers."));
      if (kids.some((e) => BLOCK_IN_TEXT.has(e.tagName)))
        push(
          issue(
            "text-block-children",
            layer.id,
            "Text layers should contain only text and inline markup (span, br, strong, em, b, i, sup, sub).",
          ),
        );
      if (!plainText(el)) push(issue("text-empty", layer.id, "Empty text layer."));
    }
    if (layer.type === "slot") {
      const ratioRaw = getAttr(el, A.slotRatio);
      if (!layer.ratio)
        push(
          issue(
            "slot-ratio",
            layer.id,
            `Slot needs data-slot-ratio="W:H"${ratioRaw ? `, got "${ratioRaw}"` : ""}.`,
          ),
        );
      if (!layer.state)
        push(issue("slot-state", layer.id, 'Slot needs data-slot-state="empty" or "filled".'));
      if (!layer.label)
        push(
          issue(
            "slot-label",
            layer.id,
            "Slot should have a short data-slot-label (what goes here).",
          ),
        );
      const imgs = [...walkElements(el)].filter((e) => e.tagName === "img");
      if (layer.state === "empty" && imgs.length)
        push(issue("slot-empty-has-img", layer.id, "An empty slot must not contain an <img>."));
      if (
        layer.state === "filled" &&
        (imgs.length !== 1 || !hasAttr(imgs[0] as P5Element, A.slotImage))
      )
        push(
          issue(
            "slot-filled-img",
            layer.id,
            "A filled slot must contain exactly one <img data-slot-image>.",
          ),
        );
      if (layer.state === "empty")
        push(issue("slot-empty", layer.id, "Slot is empty: fine for a draft, blocks publishing."));
      if (textContent(el).trim())
        push(
          issue(
            "slot-has-text",
            layer.id,
            "Slots must not contain text; the placeholder label comes from brand.css.",
          ),
        );
    }
  }
  const layerCount = [...walkElements(tree)].filter((e) => hasAttr(e, A.id)).length;
  const maxLayers = config.maxLayers ?? CONTRACT_LIMITS.maxLayers;
  if (layerCount > maxLayers)
    push(
      issue(
        "layer-count",
        null,
        `${layerCount} layers; keep designs under ~${maxLayers} layers so they stay editable.`,
      ),
    );

  // images and svg
  for (const img of walkElements(tree)) {
    if (img.tagName === "img") {
      const id = layerIdOf(img);
      if (!hasAttr(img, A.id) && !hasAttr(img, A.slotImage))
        push(
          issue(
            "img-not-layer",
            id,
            `<img src="${getAttr(img, "src") ?? ""}"> must be a layer (data-layer + data-type).`,
          ),
        );
      const src = getAttr(img, "src") ?? "";
      if (!isVirtualAssetUrl(src))
        push(
          issue(
            "image-src",
            id,
            `Image src must start with /brand/ or /media/, got "${src.slice(0, 80)}".`,
          ),
        );
    }
    if (img.tagName === "svg" && img.namespaceURI === NS.SVG) {
      const L = closest(img, (e) => hasAttr(e, A.id), true);
      const t = L ? getAttr(L, A.type) : null;
      if (!L || !(t === "shape" || t === "logo"))
        push(
          issue(
            "svg-outside-shape",
            L ? getAttr(L, A.id) : null,
            "Inline <svg> is only allowed inside a shape layer.",
          ),
        );
      if (
        [...walkElements(img)].some((e) =>
          ["text", "foreignobject", "image", "script", "textpath", "tspan"].includes(
            e.tagName.toLowerCase(),
          ),
        )
      )
        push(
          issue(
            "svg-content",
            L ? getAttr(L, A.id) : null,
            "SVG must not contain text, images, foreignObject or script.",
          ),
        );
    }
  }

  // ---- facts: every element typed as text counts (also ones with a bad or duplicate id),
  // except hidden layers, which are not published.
  const copy: { id: string | null; text: string }[] = [];
  for (const el of walkElements(tree)) {
    if (getAttr(el, A.type) !== "text") continue;
    if (closest(el, (e) => hasAttr(e, A.hidden), true)) continue;
    copy.push({ id: getAttr(el, A.id), text: plainText(el) });
  }
  if (config.allowedNumbers) {
    for (const c of copy) {
      for (const n of extractNumbers(c.text)) {
        if (!isAllowedNumber(n, config.allowedNumbers))
          push(
            issue(
              "unverified-number",
              c.id,
              `"${n.text}" is not a high-confidence fact from facts.json; remove it or use only verified numbers.`,
              { number: n.text },
            ),
          );
      }
      if (hasPercent(c.text))
        push(issue("percentage", c.id, "Percent sign in copy: make sure it is a verified fact."));
    }
  } else if (copy.some((c) => extractNumbers(c.text).length > 0)) {
    push(
      issue(
        "numbers-unchecked",
        null,
        "The copy contains numbers but no facts (allowedNumbers) were given, so they were not checked.",
      ),
    );
  }

  const layers: LayerMetrics[] = minLayers.map((l) => ({
    id: l.id,
    type: l.type,
    role: l.role,
    parent: l.parent,
    rect: null,
    visible: !l.hidden && !hiddenByAncestor(byId, l.id),
    ...(l.type === "text" ? { content: l.text.slice(0, 200) } : {}),
  }));
  return { issues, layers };
}

function hiddenByAncestor(
  byId: Map<string, { parent: string | null; hidden: boolean }>,
  id: string,
): boolean {
  let cur = byId.get(id)?.parent ?? null;
  while (cur) {
    const l = byId.get(cur);
    if (!l) return false;
    if (l.hidden) return true;
    cur = l.parent;
  }
  return false;
}
