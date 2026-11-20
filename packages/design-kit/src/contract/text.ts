// GENERATED from contract/DESIGN_CONTRACT.v1.md by scripts/sync-contract.mjs. Do not edit.
/** The design contract v1 as Markdown, for generation prompts. */
export const DESIGN_CONTRACT_MD = `# Design contract v1

Rules for every static design (post, carousel slide, story) written as HTML/CSS for Studio.
The contract exists so that a design (1) renders identically on the Mac worker and in the
editor, (2) can be edited element by element, and (3) can be checked by a machine.
Rules marked **[lint: rule-id]** are enforced by the linter of \`@studio/design-kit\`; the rest
are reviewed in the critique pass. v1 extends v0 (the F0-2 spike); the changes are listed at the end.

## 1. Document

\`\`\`html
<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v1">
  <meta name="studio:format" content="1080x1350">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>/* this design's CSS */</style>
</head>
<body>
  <main data-artboard style="width:1080px;height:1350px">
    <!-- layers -->
  </main>
</body>
</html>
\`\`\`

- \`lang\` is the brand language, \`tr\` by default **[lint: lang]**: it makes \`text-transform: uppercase\` produce \`İ\` from \`i\` and keeps \`ı\` correct.
- \`studio:contract\` says \`v1\` (info) **[lint: contract-version]**. \`studio:format\` matches the artboard **[lint: artboard-format-mismatch]**.
- Exactly one element with \`data-artboard\` **[lint: artboard-count]**, at (0,0), with the fixed pixel size of the target format
  **[lint: artboard-size]**, declared inline as \`style="width:…px;height:…px"\` **[lint: artboard-inline-size]**.
  Sizes come from the platform presets: 1080×1350 (4:5, default), 1080×1080 (1:1), 1080×1920 (9:16 story).
  \`overflow: hidden\` comes from brand.css.
- The only external stylesheet is \`/brand/brand.css\` **[lint: forbidden-link, brand-css-missing]**. It defines fonts,
  colour tokens, type styles, brand components and the slot placeholder. Do not add \`@font-face\` or \`@import\`
  **[lint: css-font-face, css-import]**.
- A carousel is one HTML document per slide. Slides of one carousel use the same \`<style>\` block so the system is shared,
  the same artboard size **[lint: carousel-artboard-mismatch]** and the same positions for logo, counter and sign-off
  **[lint: carousel-anchor-drift]**.

## 2. Layers

Every element the user may want to select, move, restyle or replace is a **layer**:

\`\`\`html
<h1 data-layer="headline" data-type="text" data-role="headline">…</h1>
\`\`\`

Attributes:

- \`data-layer\`: unique in the document, kebab-case, at most 48 characters, semantic (\`headline\`, \`product-photo\`,
  \`cta\`, \`badge-zn\`) **[lint: layer-id-format, layer-id-duplicate]**. The id is stable: a revision keeps the ids of
  layers that still exist.
- \`data-type\`: one of \`text\`, \`image\`, \`shape\`, \`logo\`, \`slot\`, \`group\` **[lint: layer-type]**.
- \`data-role\` (optional): \`eyebrow\`, \`headline\`, \`subhead\`, \`body\`, \`cta\`, \`caption\`, \`legal\`, \`badge\`, \`decoration\`,
  \`counter\`, \`background\`, \`sign-off\` **[lint: layer-role]**. Prompts like "make the headline shorter" resolve through it.
- \`data-allow-overlap\` (optional): on a text layer whose overlap with another text layer is intentional.
- \`data-hidden\`: set by the editor. The layer is not painted (brand.css: \`visibility: hidden\`) but keeps its box, so
  siblings do not reflow. Hidden layers are not checked and not published.

Types:

- **text** — a block element (\`h1\`, \`p\`, \`div\`) containing only text and inline markup (\`span\`, \`br\`, \`strong\`, \`em\`,
  \`b\`, \`i\`, \`u\`, \`s\`, \`small\`, \`sup\`, \`sub\`, \`mark\`, \`wbr\`) **[lint: text-block-children, text-nested-layer]**. All visible
  text lives in text layers; text anywhere else is not editable **[lint: text-outside-text-layer]**. No text inside SVG
  **[lint: svg-content]**, no text baked into images.
- **image** — the \`<img>\` element itself is the layer **[lint: image-not-img, img-not-layer]**. \`src\` starts with
  \`/brand/\` or \`/media/\` **[lint: image-src]**. Crop with \`object-fit\` and \`object-position\`; shape with \`border-radius\`,
  \`clip-path\` or a parent group. Never a CSS \`background-image: url()\` **[lint: css-url — any \`url()\` in design CSS fails]**.
  Never stretched **[lint: image-distorted]**. Avoid upscaling above 105% of the pixel size **[lint: image-upscaled]**.
- **logo** — an \`<img>\` pointing at a file in \`/brand/logos/\` **[lint: logo-src]**. Height-driven size, never stretched,
  never re-typeset as text, never recoloured with filters. Clear space on every side ≥ half the logo's rendered height
  (brand profiles may set another ratio per logo) **[lint: logo-clear-space]**. Inside the safe area **[lint: safe-area]**.
  Text never overlaps a logo **[lint: text-logo-overlap]**.
- **shape** — a \`div\` (or an inline \`svg\` containing only geometry) for colour fields, bands, rules, badges, dividers.
  No text inside **[lint: shape-has-text]**. Inline SVG only in shape layers **[lint: svg-outside-shape]**. Give
  full-bleed colour fields \`data-role="background"\`.
- **slot** — a placeholder for an image the user adds later (see §5).
- **group** — a container that lays out child layers with flex/grid (e.g. eyebrow + headline + body stack). Groups are
  the only layers that may contain layers **[lint: layer-nesting]** and must contain at least one **[lint: group-empty]**.
  The editor moves a group as a unit; children reflow when copy changes.

Visible boxes that are not layers (a \`div\` with a background or border and no \`data-layer\`) cannot be selected in the
editor **[lint: undeclared-visual]**. Keep a design under ~45 layers **[lint: layer-count]**.

## 3. Positioning

- Top-level layers are direct children of the artboard, positioned with \`position:absolute\` and \`left/top/width\`
  (and \`height\` where the box matters) in **px**.
- Inside a group, use flex or grid with \`gap\` — not absolute offsets — so text can grow or shrink without collisions.
- Units: \`px\` for geometry and type; \`%\`, \`fr\`, unitless line-height and \`em\` letter-spacing are fine. Viewport units
  are forbidden **[lint: css-viewport-unit]**. \`position: fixed/sticky\` is forbidden **[lint: css-position]**.
- **The editor owns the individual transform properties** \`translate\`, \`rotate\` and \`scale\` in a layer's inline style:
  moving, rotating or scaling a layer writes them, so siblings never reflow and a \`transform\` declared in the design's
  \`<style>\` is never overwritten. Generated designs place layers with \`left/top/width\`, not with these properties.

## 4. Tokens

- Colours only through \`var(--color-*)\` from brand.css, or \`color-mix(in srgb, var(--color-x) N%, transparent)\` for
  tints. Hard-coded colours produce a warning **[lint: colour-literal]** (pure black/white, also with alpha, is accepted
  for shadows and scrims).
- Fonts only through the font variables (\`var(--font-display)\`, \`var(--font-text)\`, …); the computed family must be a
  brand font **[lint: font-family]**. Use the \`.ts-*\` type-style classes from brand.css as the starting point; override
  size per layer when the layout needs it.
- Spacing from the brand scale (\`--space-*\`), outer margin \`var(--margin)\`.

## 5. Image slots

\`\`\`html
<figure data-layer="field-photo" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty"
        data-slot-label="Saha fotoğrafı" data-slot-fit="cover"
        style="position:absolute; left:72px; top:120px; width:560px; height:700px; border-radius:var(--radius-lg)"></figure>
\`\`\`

- \`data-slot-ratio="W:H"\` **[lint: slot-ratio]**; the box's measured ratio must equal it within 1%
  **[lint: slot-ratio-mismatch]**. At least 200px on each side **[lint: slot-too-small]**.
- \`data-slot-state\` is \`empty\` or \`filled\` **[lint: slot-state]**; \`data-slot-label\` says what goes there **[lint: slot-label]**;
  \`data-slot-fit\` (\`cover\` default, or \`contain\`) is the default fit of the image that fills it.
- Empty state: no children, no text **[lint: slot-empty-has-img, slot-has-text]**. The placeholder look comes from brand.css.
- Filled state: \`data-slot-state="filled"\` and exactly one \`<img data-slot-image src="/media/…" alt="…">\` inside
  **[lint: slot-filled-img]**; brand.css makes it cover the slot. The editor may add \`object-fit\`/\`object-position\`
  inline on that image to crop it.
- The design must also work when the slot holds a busy photo: no small text over a slot.
- An empty slot is reported as \`info\` **[lint: slot-empty]**: fine for a draft, blocks publishing.

## 6. Brand components

brand.css ships tested components. Use them instead of rebuilding the same element; keep their markup structure.

- \`brand-rule\` — short accent rule (shape layer).
- \`brand-badge\` — group with a shape (\`brand-badge__shape\`) and a label (\`brand-badge__label\`); the component stacks
  the label above the shape, so the label is never painted under it **[lint: text-occluded]**. Tone: \`brand-badge--<colour>\`.
- \`brand-sign-off\` — logo + web address row (group, role \`sign-off\`), at the same place on every post and slide.
- \`brand-band\` — full-width accent band (shape layer); \`brand-band--tab\` adds the raised centre tab.
- \`brand-counter\` — carousel counter text layer (role \`counter\`): \`2<span class="brand-counter__total"> / 5</span>\`;
  it must match the slide position and count **[lint: carousel-counter]**.

The generation prompt lists the exact classes and an example of each component for the brand.

## 7. Forbidden in statics

\`<script>\`, event handler attributes, \`javascript:\` URLs, \`iframe/object/embed/video/audio/canvas/form/input/textarea/select/button/base/template/math\`,
\`<meta http-equiv>\`, \`<link>\` other than brand.css, \`@import\`, \`@font-face\`, any \`url()\` in design CSS, network URLs,
\`data:\` images, CSS animations/transitions **[lint: forbidden-element, event-handler, javascript-url, forbidden-link,
css-url, css-animation, unsafe-markup]**. The renderer runs with JavaScript disabled under a strict Content Security
Policy and blocks every request that is not a served \`/brand/…\` or \`/media/…\` file **[lint: network-request]**.
The sanitiser removes all of the above from untrusted HTML before it is previewed or stored.

## 8. Layout quality rules

Machine-checked:

- **Safe area**: text and logos stay inside the platform preset's safe area (64px on feed posts, which also covers
  Instagram's 3:4 profile-grid crop of 4:5 posts; larger top/bottom margins on stories) **[lint: safe-area]**.
  Images and shapes may bleed.
- **Minimum size**: 24px absolute minimum, 28px for running text; \`data-role="legal"\` may go down to 20px
  **[lint: min-font-size, small-font-size]**. (A 1080px post is shown ~390pt wide on a phone: 28px ≈ 10pt.)
- **Contrast**: measured on the rendered pixels behind every text run (each colour in a layer separately); 4.5:1 for
  normal text, 3:1 for ≥ 48px (or ≥ 36px bold) **[lint: contrast, contrast-busy-background]**.
- **No overflow or clipping**: text fits its own box and is not cut by an ancestor or the artboard; no ellipsis or
  line-clamp **[lint: text-overflow-box, text-clipped, text-outside-artboard, text-truncated, text-line-clamp]**.
- **Visible**: text is not painted underneath another element **[lint: text-occluded]**.
- **No overlapping text** between layers unless marked \`data-allow-overlap\` **[lint: text-overlap]**.
- **Nothing cuts into text**: no shape, badge, picture or slot may touch a text layer's letters, above or below
  them (e.g. a badge whose edge sits under the first letter of an eyebrow). Place them side by side with a gap. A
  panel or photo that holds the whole text behind it is fine; mark a deliberate overlap with \`data-allow-overlap\`
  **[lint: text-element-overlap]**.
- **Diacritics**: Turkish marks (İ Ö Ü Ğ above, Ç Ş below) must not touch the neighbouring line. In uppercase display
  type keep line-height ≥ 0.96 **[lint: diacritic-collision]**.
- **Widows**: large text (≥ 44px) must not end on a lone short word **[lint: widow]**. Use \`text-wrap: balance\` for
  headlines and deliberate \`<br>\` where the break carries meaning.
- **Voids**: no large accidental empty area inside the safe area (warning) **[lint: large-void]**. White space is a tool;
  an empty quarter of the post usually means the focal element is too small or the copy is in the wrong place.
- **Facts**: every number in the copy must appear in the brand's \`facts.json\` \`allowedNumbers\`
  **[lint: unverified-number]**; percentages are flagged **[lint: percentage]**. A unit counts only when it is attached
  (\`3b\`, \`150g\`); \`%10\` is a percentage.

Reviewed by the critique pass (not machine-checked): one clear focal point; at most three levels of hierarchy; a
consistent spacing rhythm from the brand scale; alignment to the margin/column grid; no more than two type families and
three weights; copy follows VOICE.md; claims only from facts.json.

## 9. Output format (what the generator returns)

\`\`\`json
{
  "slides": [{ "id": "slide-1", "html": "<!doctype html>…" }],
  "caption": "Caption in the brand language, hashtags per VOICE.md",
  "rationale": "2–4 sentences: the idea and the main layout decision",
  "critique": [{ "issue": "…", "severity": "high|medium|low", "fix": "…" }],
  "changes": ["…"]
}
\`\`\`

\`critique\` and \`changes\` are filled only in the critique-and-revise pass. The caption is checked with the same numbers
guard as the design.

## Changes against v0 (spike) and why

The eight v0 changes against PLAN.md §5 stay: \`group\` type, \`data-role\`, slot placeholder owned by brand.css, one
generated stylesheet for fonts and tokens, root-relative URLs on a virtual origin, mandatory \`lang\`, the numbers guard,
pixel-measured contrast. v1 adds:

1. **Editor-owned transforms** (\`translate\`/\`rotate\`/\`scale\` properties, §3). Moving a layer inside a flex group with
   \`left/top\` would reflow its siblings; the individual properties do not, and never clobber a design's \`transform\`.
   v0 allowed \`transform: rotate()\` on layers; rotation is now the \`rotate\` property.
2. **\`data-hidden\`** for show/hide (§2). \`display:none\` would reflow groups; a \`[hidden]\` attribute loses against
   author \`display\` rules. brand.css hides \`[data-hidden]\` with \`visibility:hidden\`.
3. **Brand components** (§6), as the spike recommended: the model built the badge wrong in two of four first drafts.
4. **Roles \`background\` and \`sign-off\`** so the void and clear-space checks can ignore colour fields and carousel checks
   can find the sign-off.
5. **Logo rules are checked**: \`logo-src\` (v0 text, not linted before) and \`logo-clear-space\` (v0 said "cap height";
   v1 uses half the rendered logo height by default because a raster logo has no measurable cap height).
6. **Safe area from the platform preset** instead of a fixed 64px, so stories keep text clear of the top and bottom UI.
7. **New checks** from the spike backlog: \`large-void\`, \`diacritic-collision\`, carousel consistency
   (\`carousel-artboard-mismatch\`, \`carousel-anchor-drift\`, \`carousel-counter\`, \`carousel-font-drift\`), plus
   \`layer-role\`, \`artboard-inline-size\`, \`artboard-format-mismatch\`, \`unsafe-markup\`.
8. **Numbers guard fixed**: units only when attached (\`10 bor\` is \`10\`, not \`10 bo\`); \`%10\` is a percentage; numbers in
   every text element count, also ones with a broken id.
9. **Contrast per text run**: an accent-coloured word inside a headline is measured with its own colour.
10. **Inline markup list** in text layers adds \`u\`, \`s\`, \`small\`, \`mark\`, \`wbr\`.
`;
