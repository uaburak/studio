# Design contract v0

Rules for every static design (post, carousel slide, story) that Claude writes in HTML/CSS.
The contract exists so that a design (1) renders identically on the Mac worker and in the
editor, (2) can be edited element by element, and (3) can be checked by a machine.
`scripts/lint.mjs` enforces every rule marked **[lint]**; the rest are reviewed in the critique pass.

Source: PLAN.md §5, extended after the F0-2 spike. Changes against PLAN.md are listed at the end.

## 1. Document

```html
<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v0">
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
```

- `lang="tr"` is required **[lint]**: it makes `text-transform: uppercase` produce `İ` from `i` and keeps `ı` correct.
- Exactly one element with `data-artboard`, at (0,0), with the fixed pixel size of the format **[lint]**:
  1080×1350 (4:5 post, default), 1080×1080, 1080×1920 (story). `overflow: hidden` comes from brand.css.
- The only external stylesheet is `/brand/brand.css` **[lint]**. It defines fonts, colour tokens, type styles
  and the slot placeholder look. Do not add `@font-face` or `@import` **[lint]**.
- A carousel is one HTML document per slide. Slides of one carousel use the same `<style>` block so the system is shared.

## 2. Layers

Every element the user may want to select, move, restyle or replace is a **layer**:

```html
<h1 data-layer="headline" data-type="text" data-role="headline">…</h1>
```

| attribute | rule |
|---|---|
| `data-layer` | unique in the document, kebab-case, semantic (`headline`, `product-photo`, `cta`, `badge-zn`) **[lint]**. The id is stable: a revision keeps the ids of layers that still exist. |
| `data-type` | one of `text`, `image`, `shape`, `logo`, `slot`, `group` **[lint]** |
| `data-role` | optional meaning: `eyebrow`, `headline`, `subhead`, `body`, `cta`, `caption`, `legal`, `badge`, `decoration`, `counter`. Prompts like "make the headline shorter" resolve through it. |
| `data-allow-overlap` | optional, on a text layer whose overlap with another text layer is intentional |

Types:

- **text** — a block element (`h1`, `p`, `div`) containing only text and inline markup (`span`, `br`, `strong`, `em`, `b`, `i`, `sup`, `sub`) **[lint]**. All visible text lives in text layers; text anywhere else is not editable and fails **[lint]**. No text inside SVG **[lint]**, no text baked into images.
- **image** — the `<img>` element itself is the layer **[lint]**. `src` starts with `/brand/` or `/media/` **[lint]**. Crop with `object-fit` and `object-position`; shape with `border-radius`, `clip-path` or a parent group. Never a CSS `background-image: url()` **[lint: any `url()` in design CSS fails]**. Never stretched **[lint]**. Avoid upscaling above 100% of the pixel size **[lint warning]**.
- **logo** — an `<img>` pointing at a file in `/brand/logos/` **[lint]**. Height-driven size, never stretched, never re-typeset as text, never recoloured with filters. Clear space ≥ the logo's cap height. Inside the safe area **[lint]**.
- **shape** — a `div` (or inline `svg` containing only geometry **[lint]**) for colour fields, bands, rules, badges, dividers. No text inside **[lint]**.
- **slot** — a placeholder for an image the user adds later (see §5).
- **group** — a container that lays out child layers with flex/grid (e.g. eyebrow + headline + body stack). Groups are the only layers that may contain layers **[lint]**. The editor moves a group as a unit; children reflow when copy changes.

Visible boxes that are not layers (a `div` with a background or border and no `data-layer`) cannot be selected in the editor and produce a warning **[lint]**. Keep a design under ~45 layers **[lint warning]**.

## 3. Positioning

- Top-level layers are direct children of the artboard and are positioned with `position:absolute` and `left/top/width` (and `height` where the box matters) in **px**. This is what the editor's move/resize/rotate handles change.
- Inside a group, use flex or grid with `gap` — not absolute offsets — so text can grow or shrink without collisions.
- Units: `px` for geometry and type; `%`, `fr`, unitless line-height and `em` letter-spacing are fine. Viewport units (`vw`, `vh`, …) are forbidden **[lint]**. `position: fixed/sticky` forbidden **[lint]**.
- `transform: rotate()` is allowed on top-level layers (the editor supports rotation). Prefer no rotation on text.

## 4. Tokens

- Colours only through `var(--color-*)` from brand.css, or `color-mix(in srgb, var(--color-x) N%, transparent)` for tints. Hard-coded colours produce a warning **[lint]** (pure black/white with alpha for shadows/scrims is accepted).
- Fonts only through `var(--font-display)` and `var(--font-text)` **[lint: computed family must be a brand font]**. Use the `.ts-*` type-style classes from brand.css as the starting point; override size per layer when the layout needs it.
- Spacing from the 8px scale (`--space-*`), outer margin `var(--margin)`.

## 5. Image slots

```html
<figure data-layer="field-photo" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty"
        data-slot-label="Saha fotoğrafı" data-slot-fit="cover"
        style="position:absolute; left:72px; top:120px; width:560px; height:700px; border-radius:var(--radius-lg)"></figure>
```

- Fixed aspect ratio: the box's measured ratio must equal `data-slot-ratio` within 1% **[lint]**.
- Empty state: no children, no text **[lint]**. The placeholder look (tinted fill, fine hatch, inset hairline, label pill) comes from brand.css so every empty slot looks the same and is clearly a placeholder, not a design element.
- Filled state: `data-slot-state="filled"` and exactly one `<img data-slot-image src="/media/…">` inside **[lint]**; brand.css makes it `object-fit: cover` over the whole slot.
- The design must also work when the slot is filled with a busy photo: do not put small text over a slot.
- An empty slot is reported as `info` (`slot-empty`): fine for a draft, blocks publishing.

## 6. Forbidden in statics

`<script>`, event handler attributes, `javascript:` URLs, `iframe/object/embed/video/audio/canvas/form/input/button/base/template`,
`<link>` other than brand.css, `@import`, `@font-face`, any `url()` in design CSS, network URLs, `data:` images,
CSS animations/transitions (no effect in a still) **[lint]**. The renderer runs with JavaScript disabled and blocks every request
that is not `/brand/…` or `/media/…` **[lint: reported as network-request]**.

## 7. Layout quality rules

Machine-checked:

- **Safe area**: text and logos stay ≥ 64px from every edge **[lint]** (also covers Instagram's 3:4 grid crop of 4:5 posts). Images and shapes may bleed.
- **Minimum size**: 24px absolute minimum, 28px for running text; `data-role="legal"` may go down to 20px **[lint]**. (A 1080px post is shown ~390pt wide on a phone: 28px ≈ 10pt.)
- **Contrast**: measured on the rendered pixels behind each line of text; 4.5:1 for normal text, 3:1 for ≥ 48px (or ≥ 36px bold) **[lint]**.
- **No overflow or clipping**: text fits its own box and is not cut by an ancestor or the artboard; no ellipsis or line-clamp **[lint]**.
- **No overlapping text** between layers unless marked `data-allow-overlap` **[lint]**; text never overlaps a logo **[lint]**.
- **Widows**: large text (≥ 44px) must not end on a lone short word **[lint warning]**. Use `text-wrap: balance` for headlines and deliberate `<br>` where the break carries meaning.
- **Facts**: every number in the copy must appear in the brand's `facts.json` `allowedNumbers` **[lint]**; percentages are flagged **[lint warning]**.

Reviewed by the critique pass (not machine-checked): one clear focal point; at most three levels of hierarchy; a consistent spacing rhythm from the 8px scale; alignment to the margin/column grid; no more than two type families and three weights; copy follows VOICE.md; claims only from facts.json.

## 8. Output format (what Claude returns)

Headless calls return structured JSON (CLI `--json-schema`):

```json
{
  "slides": [{ "id": "slide-1", "html": "<!doctype html>…" }],
  "caption": "Instagram caption in Turkish, with hashtags per VOICE.md",
  "rationale": "2–4 sentences: the idea and the main layout decision",
  "critique": [{ "issue": "…", "severity": "high|medium|low", "fix": "…" }],
  "changes": ["…"]
}
```

`critique` and `changes` are only filled in the critique-and-revise pass.

## Changes against PLAN.md §5 and why

1. **`group` type added.** Text stacks (eyebrow + headline + body + CTA) must reflow together when the user edits copy; absolute positioning of every line made revisions collide. Groups keep flex layout inside, absolute positioning outside.
2. **`data-role` added.** "Fix the headline" style prompts, brand rules (e.g. eyebrow tracking) and the lint thresholds (legal text) need to know what a text layer *is*, independent of its id.
3. **Slot placeholder look is owned by brand.css**, not by each design. Otherwise every generation invents a different placeholder, some of which look like finished graphics.
4. **Fonts and tokens come from one generated stylesheet** (`/brand/brand.css` built from brand.json). Designs cannot add fonts, so a design can never silently fall back to a system font.
5. **Root-relative asset URLs on a virtual origin** (`/brand/…`, `/media/…`). The same HTML renders on the worker, in the editor iframe and in tests without rewriting paths; anything else is blocked.
6. **`lang="tr"` mandatory**, because Turkish uppercase/lowercase mapping is wrong without it.
7. **Numbers guard.** Brand safety: a design may only state numbers that exist in the high-confidence facts. This catches the most dangerous hallucination (doses, percentages) mechanically.
8. **Pixel-measured contrast** instead of CSS-declared colours, because text often sits on images, gradients and tints.
