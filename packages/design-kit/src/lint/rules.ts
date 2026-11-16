/**
 * Lint rule registry. Rule ids are stable: prompts, stored reports and dashboards refer
 * to them. Never rename an id; add a new one and retire the old one instead.
 *
 * Stages:
 * - `static`: parse5 + CSS tokenizer, runs anywhere (worker, web, tests) without a browser.
 * - `layout`: the in-page script, needs a laid-out document (Chromium page or editor iframe).
 * - `pixel`: needs a raster of the artboard with text hidden (renderer only).
 * - `render`: facts only the renderer knows (blocked or missing requests).
 * - `carousel`: compares the reports of all slides of one carousel.
 */

export type Severity = "error" | "warning" | "info";
export type LintStage = "static" | "layout" | "pixel" | "render" | "carousel";

export interface RuleMeta {
  severity: Severity;
  stage: LintStage;
  /** Short English description (the contract Markdown explains the rule). */
  summary: string;
  /** First kit version that has the rule. */
  since: "0.0" | "0.1";
}

const r = (
  severity: Severity,
  stage: LintStage,
  summary: string,
  since: RuleMeta["since"] = "0.0",
): RuleMeta => ({
  severity,
  stage,
  summary,
  since,
});

export const LINT_RULES = {
  // document
  "contract-version": r(
    "info",
    "static",
    "Document declares an older or no studio:contract version.",
    "0.1",
  ),
  lang: r("error", "static", '<html lang="tr"> (the brand language) is required.'),
  "artboard-count": r("error", "static", "Exactly one [data-artboard]."),
  "artboard-inline-size": r(
    "warning",
    "static",
    "Artboard declares its px width/height inline.",
    "0.1",
  ),
  "artboard-format-mismatch": r(
    "warning",
    "static",
    "studio:format meta, inline artboard size and target size agree.",
    "0.1",
  ),
  "artboard-size": r("error", "layout", "Artboard renders at the target size at (0,0)."),
  "artboard-overflow": r("warning", "layout", "Artboard is overflow:hidden."),
  "document-size": r("warning", "layout", "Document does not scroll beyond the artboard."),
  // forbidden constructs
  "forbidden-element": r(
    "error",
    "static",
    "No script, iframe, form, media, base, template, meta refresh, ...",
  ),
  "forbidden-link": r("error", "static", 'Only <link rel="stylesheet" href="/brand/brand.css">.'),
  "brand-css-missing": r("error", "static", "brand.css is linked."),
  "event-handler": r("error", "static", "No on* attributes."),
  "javascript-url": r("error", "static", "No javascript: URLs."),
  "unsafe-markup": r(
    "error",
    "static",
    "Markup the sanitiser would remove (other than the cases above).",
    "0.1",
  ),
  "css-url": r(
    "error",
    "static",
    "No url() in design CSS: images are <img> layers, fonts come from brand.css.",
  ),
  "css-import": r("error", "static", "No @import."),
  "css-font-face": r("error", "static", "No @font-face outside brand.css."),
  "css-position": r("error", "static", "No position: fixed/sticky."),
  "css-viewport-unit": r("error", "static", "No viewport units."),
  "css-animation": r("warning", "static", "No animations/transitions in a still."),
  "colour-literal": r("warning", "static", "Colours come from brand tokens."),
  // layers
  "layer-id-format": r("error", "static", "data-layer ids are kebab-case."),
  "layer-id-duplicate": r("error", "static", "data-layer ids are unique."),
  "layer-type": r("error", "static", "data-type is one of the layer types."),
  "layer-role": r("warning", "static", "data-role is one of the known roles.", "0.1"),
  "layer-outside-artboard": r("error", "static", "Layers live inside the artboard."),
  "layer-nesting": r("error", "static", "Only groups contain layers."),
  "layer-count": r("warning", "static", "Keep a design under ~45 layers."),
  "image-not-img": r("error", "static", "Image and logo layers are <img> elements."),
  "img-not-layer": r("error", "static", "Every <img> is a layer (or a slot image)."),
  "image-src": r("error", "static", "Image src starts with /brand/ or /media/."),
  "logo-src": r("error", "static", "Logo layers use a file from /brand/logos/.", "0.1"),
  "svg-outside-shape": r("error", "static", "Inline SVG only inside shape or logo layers."),
  "svg-content": r("error", "static", "SVG contains geometry only."),
  "shape-has-text": r("error", "static", "Shapes contain no text."),
  "group-empty": r("warning", "static", "Groups contain layers."),
  "text-nested-layer": r("error", "static", "Text layers contain no layers."),
  "text-block-children": r("warning", "static", "Text layers contain inline markup only."),
  "text-empty": r("warning", "static", "Text layers have text."),
  "text-layer-inline": r("warning", "layout", "Text layers have a box (not display:inline)."),
  "text-outside-text-layer": r("error", "layout", "All visible text is in text layers."),
  "undeclared-visual": r(
    "warning",
    "layout",
    "Visible boxes are layers (selectable in the editor).",
  ),
  // slots
  "slot-ratio": r("error", "static", 'Slots declare data-slot-ratio="W:H".'),
  "slot-ratio-mismatch": r("error", "layout", "Slot box matches its declared ratio within 1%."),
  "slot-state": r("error", "static", "Slots declare data-slot-state empty|filled."),
  "slot-label": r("warning", "static", "Slots have a data-slot-label."),
  "slot-empty-has-img": r("error", "static", "Empty slots contain no image."),
  "slot-filled-img": r(
    "error",
    "static",
    "Filled slots contain exactly one <img data-slot-image>.",
  ),
  "slot-has-text": r("error", "static", "Slots contain no text."),
  "slot-empty": r("info", "static", "Slot is empty: fine for a draft, blocks publishing."),
  "slot-too-small": r("warning", "layout", "Slots are at least 200px on each side."),
  // images
  "image-broken": r("error", "layout", "Images load."),
  "image-upscaled": r("warning", "layout", "Images are not shown above 105% of their pixel size."),
  "image-distorted": r("error", "layout", "Images are not stretched."),
  // text
  "font-load": r("error", "layout", "Brand fonts load."),
  "font-family": r("error", "layout", "Text uses a brand font."),
  "min-font-size": r("error", "layout", "Text is at least 24px (legal 20px)."),
  "small-font-size": r("warning", "layout", "Running text is at least 28px."),
  "text-occluded": r("error", "layout", "Text is not painted under another element."),
  "text-clipped": r("error", "layout", "Text is not cut by its box or an ancestor."),
  "text-overflow-box": r("warning", "layout", "Text fits its own box."),
  "text-truncated": r("error", "layout", "No text-overflow: ellipsis."),
  "text-line-clamp": r("error", "layout", "No line-clamp."),
  "text-outside-artboard": r("error", "layout", "Text is not cut by the artboard edge."),
  "safe-area": r("warning", "layout", "Text and logos stay inside the safe area."),
  widow: r("warning", "layout", "Large text does not end on a lone short word."),
  "text-overlap": r("error", "layout", "Text layers do not overlap (unless data-allow-overlap)."),
  "text-logo-overlap": r("error", "layout", "Text never overlaps a logo."),
  "diacritic-collision": r(
    "warning",
    "layout",
    "Diacritics (İ Ö Ü Ğ Ç Ş) do not touch the neighbouring line.",
    "0.1",
  ),
  "logo-clear-space": r(
    "warning",
    "layout",
    "Nothing intrudes into the logo's clear space.",
    "0.1",
  ),
  "large-void": r("warning", "layout", "No large empty area inside the safe area.", "0.1"),
  // pixels
  contrast: r(
    "error",
    "pixel",
    "Text contrast against its rendered background meets WCAG (4.5:1, large 3:1).",
  ),
  "contrast-busy-background": r(
    "warning",
    "pixel",
    "Contrast holds on the darkest/lightest parts of the background.",
  ),
  "contrast-unknown": r(
    "info",
    "pixel",
    "Contrast could not be measured (gradient or clipped text).",
  ),
  // facts
  "unverified-number": r("error", "static", "Every number in the copy is in facts.allowedNumbers."),
  percentage: r("warning", "static", "Percent sign in copy: check it is a verified fact."),
  "numbers-unchecked": r("info", "static", "No facts were given, numbers were not checked.", "0.1"),
  // render
  "network-request": r(
    "error",
    "render",
    "The design requested something that is not a served /brand/ or /media/ file.",
  ),
  // carousel
  "carousel-artboard-mismatch": r(
    "error",
    "carousel",
    "All slides of a carousel have the same artboard size.",
    "0.1",
  ),
  "carousel-anchor-drift": r(
    "warning",
    "carousel",
    "Logo, counter and sign-off sit at the same place on every slide.",
    "0.1",
  ),
  "carousel-counter": r("error", "carousel", "Counters match the slide position and count.", "0.1"),
  "carousel-font-drift": r(
    "warning",
    "carousel",
    "A role uses the same font family on every slide.",
    "0.1",
  ),
} as const satisfies Record<string, RuleMeta>;

export type RuleId = keyof typeof LINT_RULES;
export const RULE_IDS = Object.keys(LINT_RULES) as RuleId[];

export function isRuleId(id: string): id is RuleId {
  return Object.hasOwn(LINT_RULES, id);
}
