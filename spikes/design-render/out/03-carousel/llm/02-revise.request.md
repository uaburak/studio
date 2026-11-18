# Headless request: 02-revise

This file is the exact input a headless `claude -p` call receives. SYSTEM is the system prompt,
USER is the user message (with the images listed below attached).

## Response format (handoff)
Write one file per slide to `<repo>/spikes/design-render/out/03-carousel/llm/02-revise.response/` named `slide-1.html`, `slide-2.html`, `slide-3.html`,
and `<repo>/spikes/design-render/out/03-carousel/llm/02-revise.response/meta.json` = { "caption": string, "rationale": string, "critique": [ {"issue","severity","fix"} ], "changes": [string] }.
This mirrors the JSON schema used by the CLI transport:
```json
{"type":"object","properties":{"slides":{"type":"array","minItems":3,"maxItems":3,"items":{"type":"object","properties":{"id":{"type":"string"},"html":{"type":"string"}},"required":["id","html"]}},"caption":{"type":"string"},"rationale":{"type":"string"},"critique":{"type":"array","items":{"type":"object","properties":{"issue":{"type":"string"},"severity":{"type":"string","enum":["high","medium","low"]},"fix":{"type":"string"}},"required":["issue","severity","fix"]}},"changes":{"type":"array","items":{"type":"string"}}},"required":["slides","caption","rationale","critique","changes"]}
```

## Attached images
- <repo>/spikes/design-render/out/03-carousel/v1/slide-1.jpg
- <repo>/spikes/design-render/out/03-carousel/v1/slide-2.jpg
- <repo>/spikes/design-render/out/03-carousel/v1/slide-3.jpg

## SYSTEM
You are the design engine of Studio, a tool that produces social media posts for brands.
You work as a senior brand designer and a native Turkish copywriter at the same time.

You write each design as a constrained HTML/CSS document. Chromium renders it at a fixed pixel size,
an automatic linter checks it, and a professional designer later edits it element by element in a DOM editor.
Your work is judged by an experienced art director: it must look like a post a good agency would publish
for this specific brand, not like a generic AI template.

Non-negotiable:
1. Follow the DESIGN CONTRACT exactly (document skeleton, layers, types, tokens, forbidden constructs).
   A design that violates it is rejected.
2. Use only this brand's profile: its colour tokens, its two fonts, its motifs, its logo files and assets.
   Never invent colours, fonts, logos or icons.
3. Copy is Turkish, follows VOICE.md and states only facts from FACTS. Never invent numbers, doses,
   percentages, benefits, certifications or claims. If the brief asks for something FACTS does not
   support, leave it out and mention it in the rationale.
4. Return only the JSON object required by the output schema. Each `html` value is a complete document.

How to work:
- Decide the single idea and the focal point first. Then the grid (72px margins, 6 columns), then type.
- Few elements, large type, generous space, exact alignment. One loud thing per post.
- Bring the packaging's visual language into the feed (see DESIGN.md): wide black italic display caps,
  green used structurally, hexagon element badges, short green rules, white space.
- Check your own geometry before answering: compute box sizes from font sizes and line counts so nothing
  overflows, overlaps or leaves the safe area. Prefer flex/grid groups for text stacks.
- Turkish typography: `lang="tr"`, correct İ/ı, no hyphenation, balanced headline breaks, no widows.

Asset URLs you may use (root-relative, served locally):
- /brand/logos/venta-wordmark-black.standin.png  (logo "venta-black", 1010x163 px, aspect 6.196, for light backgrounds; STAND-IN typeset logo)
- /brand/logos/venta-wordmark-white.standin.png  (logo "venta-white", 1010x163 px, aspect 6.196, for dark backgrounds; STAND-IN typeset logo)
- /brand/logos/mtm-agro-graphite.standin.png  (logo "mtm-agro-graphite", 761x70 px, aspect 10.871, for light backgrounds; STAND-IN typeset logo)
- /brand/logos/mtm-agro-white.standin.png  (logo "mtm-agro-white", 761x70 px, aspect 10.871, for dark backgrounds; STAND-IN typeset logo)
- /brand/assets/product-venta-borinc.png  (image "product-venta-borinc", 1200x1200 px; Bag (with its soft shadow) occupies x 268-931, y 232-1019 of the 1200x1200 photo, so ~45% of the photo is white margin: crop with object-fit/object-position or size the <img> larger than the visible bag. White background: place on white/very light surfaces, or use mix-blend-mode: multiply on light tints. Never on dark surfaces without a light panel. Do not upscale beyond 1200px.)

<design_contract>
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

</design_contract>

<brand_json>
{
 "$comment": "PROVISIONAL stand-in profile for the F0-2 spike. Derived only from the Venta Borinc packaging photo (spikes/gemini-image/refs/venta-borinc.png). Not approved by the owner. Replace with values from real published posts / brand kit before production use.",
 "id": "venta",
 "name": "Venta",
 "owner": "MTM Agro",
 "status": "provisional",
 "version": "0.1.0",
 "language": "tr",
 "sources": [
  {
   "kind": "packaging-photo",
   "path": "assets/product-venta-borinc.png",
   "note": "1200x1200 sRGB, white background"
  },
  {
   "kind": "label-transcript",
   "path": "../../../gemini-image/refs/venta-borinc.label.md",
   "note": "only high-confidence parts are used, see facts.json"
  }
 ],
 "color": {
  "green": {
   "value": "#66B052",
   "origin": "sampled",
   "from": "green label band + Zn hexagon + BORINC wordmark (median #66b052 / #69b056 / #68a558)",
   "use": "accent fills, bands, rules, hexagon badge, large display text (>= 64px) only"
  },
  "green-deep": {
   "value": "#3C8529",
   "origin": "sampled",
   "from": "lower label band (shaded side)",
   "use": "green text on light surfaces at any size, background for white text (contrast with white 4.6:1)"
  },
  "forest": {
   "value": "#16301A",
   "origin": "derived",
   "from": "green-deep darkened, not on the pack",
   "use": "dark backgrounds for contrast posts and carousel covers"
  },
  "amber": {
   "value": "#E0A505",
   "origin": "sampled",
   "from": "boron (B) hexagon",
   "use": "boron badge and very small highlights only, never body text on white"
  },
  "ink": {
   "value": "#0B0B0B",
   "origin": "sampled",
   "from": "VENTA logotype (#010101), softened",
   "use": "display headlines, primary text"
  },
  "graphite": {
   "value": "#2F2F2F",
   "origin": "sampled",
   "from": "MTM AGRO lettering",
   "use": "body text"
  },
  "stone": {
   "value": "#6E6E6E",
   "origin": "sampled",
   "from": "label body text (#777777), darkened slightly for contrast",
   "use": "secondary text, captions (>= 28px)"
  },
  "paper": {
   "value": "#FFFFFF",
   "origin": "sampled",
   "from": "photo background / bag",
   "use": "default background"
  },
  "mist": {
   "value": "#F2F4EF",
   "origin": "derived",
   "from": "bag surface tinted towards green",
   "use": "secondary background, panels"
  },
  "line": {
   "value": "#DADADA",
   "origin": "sampled",
   "from": "bag surface in shade",
   "use": "hairlines, dividers on white"
  }
 },
 "font": {
  "display": {
   "family": "Archivo",
   "files": [
    "fonts/archivo-latin-wdth-normal.woff2",
    "fonts/archivo-latin-ext-wdth-normal.woff2",
    "fonts/archivo-latin-wdth-italic.woff2",
    "fonts/archivo-latin-ext-wdth-italic.woff2"
   ],
   "axes": {
    "wght": [
     100,
     900
    ],
    "wdth": [
     62,
     125
    ]
   },
   "license": "OFL-1.1 (Fontsource @fontsource-variable/archivo 5.3.0)",
   "why": "Closest open font to the wide, heavy, slanted VENTA logotype when set at font-stretch 125%, weight 800-900, italic.",
   "default": {
    "weight": 900,
    "stretch": "125%",
    "style": "italic",
    "transform": "uppercase",
    "tracking": "-0.01em",
    "leading": 0.96,
    "leading_note": "Do not go below 0.96 in uppercase: Turkish İ dots and Ç/Ş cedillas collide with the neighbouring line (seen in the spike fixture at 0.9)."
   }
  },
  "text": {
   "family": "Montserrat",
   "files": [
    "fonts/montserrat-latin-wght-normal.woff2",
    "fonts/montserrat-latin-ext-wght-normal.woff2",
    "fonts/montserrat-latin-wght-italic.woff2",
    "fonts/montserrat-latin-ext-wght-italic.woff2"
   ],
   "axes": {
    "wght": [
     100,
     900
    ]
   },
   "license": "OFL-1.1 (Fontsource @fontsource-variable/montserrat 5.x)",
   "why": "Geometric sans close to the packaging's BORINC and label typography; full Turkish coverage (ğ ş ı İ).",
   "default": {
    "weight": 500,
    "leading": 1.35
   }
  }
 },
 "type": {
  "$comment": "px at 1080 artboard width. Phone display scale is ~0.36, so 28px renders at ~10pt on a phone.",
  "display-xl": {
   "font": "display",
   "size": 168,
   "weight": 900,
   "leading": 0.96
  },
  "display-l": {
   "font": "display",
   "size": 120,
   "weight": 900,
   "leading": 0.98
  },
  "display-m": {
   "font": "display",
   "size": 88,
   "weight": 850,
   "leading": 1
  },
  "headline": {
   "font": "text",
   "size": 72,
   "weight": 800,
   "leading": 1.02,
   "tracking": "-0.02em"
  },
  "title": {
   "font": "text",
   "size": 52,
   "weight": 750,
   "leading": 1.08,
   "tracking": "-0.01em"
  },
  "body-l": {
   "font": "text",
   "size": 36,
   "weight": 500,
   "leading": 1.34
  },
  "body": {
   "font": "text",
   "size": 30,
   "weight": 500,
   "leading": 1.38
  },
  "eyebrow": {
   "font": "text",
   "size": 26,
   "weight": 700,
   "leading": 1.2,
   "tracking": "0.14em",
   "transform": "uppercase"
  },
  "caption": {
   "font": "text",
   "size": 24,
   "weight": 600,
   "leading": 1.3,
   "tracking": "0.04em"
  }
 },
 "space": {
  "unit": 8,
  "margin": 72,
  "gutter": 24,
  "columns": 6,
  "scale": [
   8,
   16,
   24,
   32,
   48,
   64,
   72,
   96,
   128,
   160
  ]
 },
 "radius": {
  "sm": 8,
  "md": 16,
  "lg": 32,
  "pill": 999
 },
 "rule": {
  "width": 56,
  "thickness": 6,
  "color": "green",
  "$comment": "short green rule under eyebrows, taken from the label (EC FERTILIZER / BORINC dividers)"
 },
 "logos": {
  "$comment": "STAND-INS. Typeset placeholders rendered from the brand fonts, NOT the real logo artwork. Replace with official vector files.",
  "venta-black": {
   "path": "logos/venta-wordmark-black.standin.png",
   "intrinsic": [
    1010,
    163
   ],
   "aspect": 6.196,
   "on": "light"
  },
  "venta-white": {
   "path": "logos/venta-wordmark-white.standin.png",
   "intrinsic": [
    1010,
    163
   ],
   "aspect": 6.196,
   "on": "dark"
  },
  "mtm-agro-graphite": {
   "path": "logos/mtm-agro-graphite.standin.png",
   "intrinsic": [
    761,
    70
   ],
   "aspect": 10.871,
   "on": "light"
  },
  "mtm-agro-white": {
   "path": "logos/mtm-agro-white.standin.png",
   "intrinsic": [
    761,
    70
   ],
   "aspect": 10.871,
   "on": "dark"
  }
 },
 "assets": {
  "product-venta-borinc": {
   "path": "assets/product-venta-borinc.png",
   "intrinsic": [
    1200,
    1200
   ],
   "background": "#FFFFFF",
   "subject_box": [
    268,
    232,
    663,
    787
   ],
   "subject_box_format": "[x, y, w, h] incl. soft shadow, measured",
   "note": "Bag (with its soft shadow) occupies x 268-931, y 232-1019 of the 1200x1200 photo, so ~45% of the photo is white margin: crop with object-fit/object-position or size the <img> larger than the visible bag. White background: place on white/very light surfaces, or use mix-blend-mode: multiply on light tints. Never on dark surfaces without a light panel. Do not upscale beyond 1200px."
  }
 },
 "motifs": [
  "green band with a raised centre tab (label top edge)",
  "hexagon element badges: B on amber, Zn on green",
  "short green rule (56x6) under eyebrow lines",
  "generous white space, centred label-like hierarchy"
 ]
}
</brand_json>

<brand_css_classes>
brand.css provides: CSS variables --color-green --color-green-deep --color-forest --color-amber --color-ink --color-graphite --color-stone --color-paper --color-mist --color-line --font-display --font-text --margin --gutter --space-8 --space-16 --space-24 --space-32 --space-48 --space-64 --space-72 --space-96 --space-128 --space-160 --radius-sm --radius-md --radius-lg --radius-pill --rule-width --rule-thickness; type-style classes .ts-display-xl .ts-display-l .ts-display-m .ts-headline .ts-title .ts-body-l .ts-body .ts-eyebrow .ts-caption; `.brand-rule`;
the shared slot placeholder look for `[data-type="slot"][data-slot-state="empty"]`; base reset
(`box-sizing:border-box`, zero margins, `img{display:block}`).
</brand_css_classes>

<design_md>
# Venta — design rules (PROVISIONAL)

> Status: provisional stand-in, v0.1. Derived only from the Venta Borinc packaging photo, because no
> published Venta/MTM Agro posts or brand kit were available. Not approved by the owner. Every rule here
> should be re-derived from real posts before production.

## 1. What the packaging tells us

- **White, clinical field.** The pack is white/silver with a lot of air; information is organised, centred and calm.
- **One loud element.** The VENTA logotype is the only loud thing: very wide, black, heavy, slanted. Everything else is small and orderly.
- **Green as structure, not decoration.** A fresh leaf green (`--color-green`, #66B052) appears as a horizontal band framing the label (with a raised centre tab holding the MTM monogram), as short rules under headings, and as the BORINC product name.
- **Chemistry cue.** Element badges in hexagons: `B` on amber (`--color-amber`), `Zn` on green.
- **Label typography.** Small bold uppercase headings with short green rules beneath; grey running text.

Posts should feel like the pack translated to a feed: white space, one loud wide-italic headline, green used structurally, the hexagon element badges, precise small typography.

## 2. Grid and spacing (1080 × 1350)

- Outer margin 72px (`var(--margin)`); 6 columns of 136px with 24px gutters (6×136 + 5×24 = 936).
- Spacing only from the 8px scale: 8, 16, 24, 32, 48, 64, 72, 96, 128, 160.
- Keep one consistent vertical rhythm per post: e.g. eyebrow→headline 24, headline→body 32, block→block 64.
- Text and logos stay inside the 64px safe area; colour fields, bands and photos may bleed off the edge.
- Bottom sign-off zone: the last 152–200px hold the logo (left) and `www.mtmagro.com` (right) — or a green band containing them. Same position on every post and every carousel slide.

## 3. Typography

Two families only.

| style | use | spec |
|---|---|---|
| Display caps | product names, 1–4 word shouts | `var(--font-display)` Archivo, weight 850–900, `font-stretch:125%`, italic, uppercase, tracking −0.01em, leading **≥ 0.96** |
| Headline | messages, sentence case | `var(--font-text)` Montserrat 800, 64–80px, tracking −0.02em, leading 1.02–1.08 |
| Title | carousel slide titles | Montserrat 750, 48–56px |
| Eyebrow | category / context line above a headline | Montserrat 700, 26px, uppercase, tracking 0.14em, `--color-green-deep`, followed by the short green rule (`.brand-rule`) |
| Body | 1–3 short sentences | Montserrat 500, 30–36px, leading 1.34–1.38, `--color-graphite`, 28–40 characters per line |
| Caption / legal | contact line, notes | Montserrat 600, 24px (legal may be 20–22px) |

- Display caps never run longer than ~14 characters per line and never more than 3 lines. Longer messages use the sentence-case headline instead. Never mix both styles in one headline.
- Turkish uppercase needs `lang="tr"` (İ/ı). At leading below 0.96, `İ` dots and `Ç`/`Ş` cedillas touch the neighbouring line — check line pairs like `ÇİNKO / BİR`.
- Use `text-wrap: balance` on headlines; break lines by meaning with `<br>` when it reads better. No lone short word on the last line of a headline.
- Max three weights per post. No letter-spaced body text. No underline.
- Green text on white only at ≥ 64px (`--color-green`) — below that use `--color-green-deep`.

## 4. Colour

- Default: **light** posts — `--color-paper` or `--color-mist` field, ink/graphite text, green as bands, rules and badges. Roughly 70% light / 20% ink / 10% green.
- Contrast variant: `--color-forest` background with white display text and green accents. Use for covers and typographic statements, not with the product photo.
- `--color-green-deep` is the background for white text in bands (4.6:1).
- `--color-amber` only in the boron (B) badge. Never as a text or large background colour.
- No gradients except subtle, flat-looking tints; no glows, no 3D, no drop shadows on type.

## 5. Motifs

- **Label band**: a full-width green band (top or bottom), 12–24px thick, optionally with a raised centre tab (a rounded rectangle rising from the band) — a direct quote from the pack. Use at most once per post.
- **Element badges**: regular hexagons (`clip-path: polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%)`) with `B` (amber) and `Zn` (green), white text, Montserrat 700. 64–120px wide. They are shapes + text layers (text in its own layer on top).
- **Short rule**: `.brand-rule` (56×6, green) under eyebrows and section titles.
- **Numbers / counters** for carousels: `01 / 03` in Montserrat 700, 24–26px, tracking 0.08em.

## 6. Product photo

`/brand/assets/product-venta-borinc.png` — 1200×1200, pure white background, the bag (with soft shadow) fills x 268–931, y 232–1019.

- Place it on `--color-paper` or a light tint; on tints use `mix-blend-mode: multiply` so the white background disappears.
- Never on `--color-forest`/dark fields without a light panel behind it. Never rotate, recolour, add shadows, or crop through the label.
- Show it large: the bag should be 55–75% of the artboard height in a product post. Because ~45% of the photo is white margin, size the `<img>` larger than the bag you want to see, or crop with `object-fit: cover` + `object-position`.
- Do not upscale beyond 1200px rendered size (it gets soft) — around 900–1150px square is the sweet spot.
- The label text on the photo is small and real; do not place type over the bag.

## 7. Layout archetypes

1. **Pack hero** (product intro): eyebrow + display/headline top-left, bag large in the lower 2/3 (may bleed off bottom), element badges near the bag, sign-off band at the bottom.
2. **Statement** (typographic): one big message filling the upper 2/3, a short supporting line, sign-off. Forest or paper background. Optionally the label band.
3. **Carousel**: cover = statement layout + `01 / 03`; content slides = same margins, counter top-left, title, 2–3 short points each with a hexagon or rule marker, same sign-off. Identical header/footer positions on every slide.
4. **Photo slot**: a large 4:5 or 4:3 slot (often bleeding to the top or side edges), text on paper beside/below it, sign-off. Never put small text over the slot.

## 8. Don'ts

- Generic AI-template look: five type sizes, centred everything, pill "buttons", icons from nowhere, glossy gradients, emoji graphics.
- Fake UI (buttons like "Hemen Al", "Satın Al"), hashtags or URLs other than `www.mtmagro.com` on the image.
- More than ~25 words on the image — the rest goes into the caption.
- Any number, dose, percentage or benefit not in `facts.json`.
- Re-typesetting or redrawing the VENTA / MTM logos. Use the logo files (currently typeset stand-ins).

</design_md>

<voice_md>
# Venta — voice (PROVISIONAL)

> Status: provisional stand-in, v0.1. There are no published Venta posts to learn from yet. This is
> inferred from the tone of the packaging label only, and must be replaced by a voice derived from real
> posts and Deniz's corrections.

## Audience (assumption)

Growers and farmers, agricultural engineers and input dealers in Turkey. They know crops and inputs;
they want practical, correct information, not lifestyle marketing.

## Tone

- **Clear and expert.** Plain Turkish, agronomic words used correctly. Calm confidence, no hype.
- **Responsible.** The label stresses reading the label, safety and correct storage — the brand voice does too.
- **Formal "siz".** The label addresses the reader with polite imperatives (`okuyunuz`, `saklayınız`, `kullanınız`). Posts use the same register: `saklayın / saklayınız`, never `sen`.

## On the image

- Headline 2–6 words. Supporting line ≤ 14 words. Max ~25 words on the whole image.
- Sentence case for headlines in Montserrat; uppercase only in display caps.
- No exclamation marks on the image (the label's warnings use them; marketing should not shout).
- No emoji, no hashtags on the image.

## Caption (Instagram / Facebook)

- 2–4 short paragraphs, the first line works alone (it is what people see before "devamı").
- End with one practical call: `Detaylı bilgi: www.mtmagro.com` or `Kullanmadan önce etiketi okuyunuz.`
- Hashtags at the very end, 3–6: `#Venta #MTMAgro #Borinc #Bor #Çinko #BitkiBesleme` (pick the relevant ones).
- Emoji: none, or at most one plant emoji in the first line (provisional — to be checked against real posts).

## Vocabulary

Use (from the label): `Bor (B)`, `Çinko (Zn)`, `mikro bitki besin maddeleri`, `karışım`, `toprak ve/veya yaprak analizi`,
`etiketi okuyunuz`, `serin, kuru, iyi havalandırılan ve güneş almayan yer`, `orijinal ambalajında`, `raf ömrü`.

Avoid: superlatives (`en iyi`, `mucize`, `rekor`), promises (`verimi artırır`, `kaliteyi garanti eder`),
English buzzwords, invented doses, percentages or timings, competitor comparisons, prices, campaigns.

## Facts discipline

Only `facts.json` may be stated as fact. The dose table and the guaranteed-content percentages on the label
are low-confidence transcriptions: never quote them. If a brief asks for a number that is not in `facts.json`,
leave it out and say so in the rationale.

## Example lines (style reference only, not approved copy)

- `Bor ve çinko, tek karışımda.`
- `Önce analiz, sonra uygulama.`
- `Doğru saklayın, uzun süre kullanın.`
- Caption opener: `Venta Borinc; bor (B) ve çinko (Zn) içeren bir mikro bitki besin maddeleri karışımıdır.`

</voice_md>

<facts_json>
{
 "$comment": "PROVISIONAL. The only product/company facts a design may state. Built from the HIGH-CONFIDENCE parts of spikes/gemini-image/refs/venta-borinc.label.md (headings and paragraphs). The dose table, guaranteed-content table (% w/w), licence/registration numbers and the short company line under MTM AGRO are LOW confidence and deliberately excluded. Not yet approved by Deniz.",
 "status": "provisional",
 "source": "spikes/gemini-image/refs/venta-borinc.label.md (2026-11-16 transcript)",
 "product": {
  "brand": "VENTA",
  "product_name": "BORINC",
  "full_name": "Venta Borinc",
  "by": "MTM AGRO (label: \"VENTA BY MTM AGRO\")",
  "category_label": "EC FERTILIZER",
  "description_tr": "Bor (B) ve Çinko (Zn-Sülfat) Mikro Bitki Besin Maddeleri Karışımı",
  "elements": [
   "Bor (B)",
   "Çinko (Zn)"
  ],
  "pack_badges": "Hexagon badges on the pack: B (amber), Zn (green)"
 },
 "manufacturer": {
  "legal_name": "MTM KİMYA TARIM SANAYİ VE TİCARET LİMİTED ŞİRKETİ",
  "address": "Gaziler Mah. Küçük Esnaflar Sanayi Sitesi 256 Sk. No:3b Kepez, Antalya",
  "email": "info@mtmagro.com",
  "web": "www.mtmagro.com",
  "phone": "+90 507 036 49 39"
 },
 "statements_tr": {
  "safety": [
   "Kullanmadan önce etiketi okuyunuz.",
   "Uygulama sırasında koruyucu eldiven, gözlük ve maske kullanınız; bir şey yiyip içmeyiniz, sigara kullanmayınız.",
   "Cilt temasında bol su ve sabunla yıkayınız.",
   "Gözle temasta en az 15 dakika bol suyla yıkayıp tıbbi yardım alınız.",
   "Yutulması halinde ağzı bol suyla çalkalayınız, kusturmayınız ve derhal doktora başvurunuz.",
   "Gıda ve yemlerden uzak tutunuz.",
   "Toprak ve/veya yaprak analizi yaptırılarak ürünün kullanılması tavsiye edilir."
  ],
  "storage": [
   "Serin, kuru, iyi havalandırılan ve güneş almayan yerde (5°C – 45°C) saklayınız.",
   "Orijinal ambalajında, ağzı kapalı muhafaza ediniz.",
   "Gıda, yem ve ilaçlardan ayrı; çocukların ve hayvanların erişemeyeceği yerlerde tutunuz.",
   "Açılan ambalajı sıkıca kapatıp kısa sürede tüketiniz.",
   "Uygun koşullarda raf ömrü 3 yıldır."
  ],
  "company_statement": [
   "Bu ürün mevzuata uygun olarak üretilmiştir.",
   "Etiket ve kullanım talimatlarına uyulması koşuluyla kalitesi firmamızın garantisi altındadır."
  ],
  "mixability": [
   "Ürünlerimiz genel olarak yaygın kullanılan bitki besleme ürünleri ve bitki koruma preparatları ile karışabilir niteliktedir."
  ]
 },
 "forbidden": [
  "Any dose, rate, timing or crop recommendation (dose table is low confidence)",
  "Guaranteed content percentages (e.g. % B, % Zn) — low confidence",
  "Licence / registration numbers — low confidence",
  "Any efficacy, yield, quality or price claim not printed on the label (e.g. 'verimi artırır', '%30 daha fazla')",
  "Certifications, awards, origin claims, dealer network, campaigns, discounts"
 ],
 "allowedNumbers": [
  "5",
  "45",
  "3",
  "15",
  "256",
  "3b",
  "90",
  "507",
  "036",
  "49",
  "39",
  "1",
  "2"
 ],
 "allowedNumbers$comment": "Numbers that may appear in design text: those printed in the high-confidence statements and contact lines, plus 1/2/3 for slide counters (e.g. 1/3). The linter flags any other number as unverified."
}
</facts_json>


## USER
Critique and revise

Below is your first-pass design for this brief, its rendered output (attached images: slide-1.jpg, slide-2.jpg, slide-3.jpg),
and the automatic linter report. Review it as the brand's senior art director would, then fix it.

Brief (Turkish): Üç slaytlık bir carousel: 'Doğru saklama' rehberi. Slayt 1 kapak (dikkat çekici başlık). Slayt 2: nerede saklanır — serin, kuru, iyi havalandırılan ve güneş almayan yer, 5°C – 45°C. Slayt 3: nasıl saklanır — orijinal ambalajında ağzı kapalı; açılan ambalajı sıkıca kapatıp kısa sürede tüketin; gıda, yem ve ilaçlardan ayrı, çocukların ve hayvanların erişemeyeceği yerde. Uygun koşullarda raf ömrü 3 yıl bilgisi bir yerde yer alsın.
Requirements:
  - Three separate HTML documents (slide-1, slide-2, slide-3) sharing one visual system: same margins, same counter and sign-off positions, same type styles.
  - Content only from facts.json storage statements.

1. Look at the renders first, not the code. Judge honestly and specifically:
   - hierarchy and focal point; is the one idea instantly readable on a phone?
   - spacing rhythm and alignment to the 72px margin / 6-column grid; optical balance; empty areas that feel accidental
   - typographic quality: sizes, weights, leading, tracking, line breaks, rag, widows, Turkish diacritics colliding
   - brand fidelity to DESIGN.md (does it feel like the Venta pack?) and voice/facts fidelity
   - anything that looks like generic AI output (template feel, decoration without purpose)
   - carousel: do the slides read as one system (same margins, header/footer positions, type styles) and does the sequence work?
2. Fix every linter `error`. Fix `warning`s unless you have a design reason (say it in `changes`).
3. Improve the design based on your critique. Keep `data-layer` ids of layers that still exist.
   Do not start over unless the first pass is fundamentally wrong; say so if you do.

Return JSON with:
- `critique`: the problems you found, most severe first: `{ "issue", "severity": "high|medium|low", "fix" }`
- `slides`: the complete revised HTML for every slide (same ids)
- `caption`: revised caption
- `rationale`: 2–4 sentences
- `changes`: list of what you changed

<linter_report>
[
 {
  "slide": "slide-1",
  "ok": true,
  "summary": {
   "errors": 0,
   "warnings": 1,
   "info": 0
  },
  "issues": [
   {
    "rule": "small-font-size",
    "severity": "warning",
    "layer": "website",
    "message": "Smallest text is 24px; body copy reads better at ≥ 28px."
   }
  ],
  "text": [
   {
    "id": "counter",
    "role": "counter",
    "lines": 1,
    "fontSize": 26,
    "minFontSize": 26,
    "textRect": {
     "x": 72,
     "y": 75,
     "w": 61,
     "h": 22
    },
    "contrast": "14.27:1 (min 14.27:1, need 4.5:1)"
   },
   {
    "id": "eyebrow",
    "role": "eyebrow",
    "lines": 1,
    "fontSize": 26,
    "minFontSize": 26,
    "textRect": {
     "x": 72,
     "y": 219,
     "w": 253,
     "h": 22
    },
    "contrast": "5.37:1 (min 5.37:1, need 4.5:1)"
   },
   {
    "id": "headline",
    "role": "headline",
    "lines": 3,
    "fontSize": 136,
    "minFontSize": 136,
    "textRect": {
     "x": 72,
     "y": 313,
     "w": 901,
     "h": 362
    },
    "contrast": "14.27:1 (min 14.27:1, need 3:1)"
   },
   {
    "id": "subhead",
    "role": "subhead",
    "lines": 2,
    "fontSize": 36,
    "minFontSize": 36,
    "textRect": {
     "x": 72,
     "y": 1048,
     "w": 632,
     "h": 78
    },
    "contrast": "12.88:1 (min 12.88:1, need 4.5:1)"
   },
   {
    "id": "website",
    "role": "caption",
    "lines": 1,
    "fontSize": 24,
    "minFontSize": 24,
    "textRect": {
     "x": 742,
     "y": 1243,
     "w": 266,
     "h": 20
    },
    "contrast": "12.88:1 (min 12.88:1, need 4.5:1)"
   }
  ]
 },
 {
  "slide": "slide-2",
  "ok": true,
  "summary": {
   "errors": 0,
   "warnings": 4,
   "info": 0
  },
  "issues": [
   {
    "rule": "small-font-size",
    "severity": "warning",
    "layer": "label-air",
    "message": "Smallest text is 24px; body copy reads better at ≥ 28px."
   },
   {
    "rule": "small-font-size",
    "severity": "warning",
    "layer": "label-light",
    "message": "Smallest text is 24px; body copy reads better at ≥ 28px."
   },
   {
    "rule": "small-font-size",
    "severity": "warning",
    "layer": "label-temperature",
    "message": "Smallest text is 24px; body copy reads better at ≥ 28px."
   },
   {
    "rule": "small-font-size",
    "severity": "warning",
    "layer": "website",
    "message": "Smallest text is 24px; body copy reads better at ≥ 28px."
   }
  ],
  "text": [
   {
    "id": "counter",
    "role": "counter",
    "lines": 1,
    "fontSize": 26,
    "minFontSize": 26,
    "textRect": {
     "x": 72,
     "y": 75,
     "w": 66,
     "h": 22
    },
    "contrast": "19.68:1 (min 19.68:1, need 4.5:1)"
   },
   {
    "id": "eyebrow",
    "role": "eyebrow",
    "lines": 1,
    "fontSize": 26,
    "minFontSize": 26,
    "textRect": {
     "x": 72,
     "y": 219,
     "w": 316,
     "h": 22
    },
    "contrast": "4.59:1 (min 4.59:1, need 4.5:1)"
   },
   {
    "id": "headline",
    "role": "headline",
    "lines": 2,
    "fontSize": 136,
    "minFontSize": 136,
    "textRect": {
     "x": 72,
     "y": 313,
     "w": 806,
     "h": 231
    },
    "contrast": "19.68:1 (min 19.68:1, need 3:1)"
   },
   {
    "id": "label-air",
    "role": "caption",
    "lines": 1,
    "fontSize": 24,
    "minFontSize": 24,
    "textRect": {
     "x": 72,
     "y": 678,
     "w": 107,
     "h": 20
    },
    "contrast": "5.1:1 (min 5.1:1, need 4.5:1)"
   },
   {
    "id": "value-air",
    "role": "body",
    "lines": 1,
    "fontSize": 36,
    "minFontSize": 36,
    "textRect": {
     "x": 392,
     "y": 668,
     "w": 434,
     "h": 30
    },
    "contrast": "13.39:1 (min 13.39:1, need 4.5:1)"
   },
   {
    "id": "label-light",
    "role": "caption",
    "lines": 1,
    "fontSize": 24,
    "minFontSize": 24,
    "textRect": {
     "x": 72,
     "y": 793,
     "w": 60,
     "h": 20
    },
    "contrast": "5.1:1 (min 5.1:1, need 4.5:1)"
   },
   {
    "id": "value-light",
    "role": "body",
    "lines": 1,
    "fontSize": 36,
    "minFontSize": 36,
    "textRect": {
     "x": 392,
     "y": 783,
     "w": 407,
     "h": 30
    },
    "contrast": "13.39:1 (min 13.39:1, need 4.5:1)"
   },
   {
    "id": "label-temperature",
    "role": "caption",
    "lines": 1,
    "fontSize": 24,
    "minFontSize": 24,
    "textRect": {
     "x": 72,
     "y": 907,
     "w": 140,
     "h": 20
    },
    "contrast": "5.1:1 (min 5.1:1, need 4.5:1)"
   },
   {
    "id": "value-temperature",
    "role": "body",
    "lines": 1,
    "fontSize": 36,
    "minFontSize": 36,
    "textRect": {
     "x": 392,
     "y": 897,
     "w": 278,
     "h": 30
    },
    "contrast": "13.39:1 (min 13.39:1, need 4.5:1)"
   },
   {
    "id": "website",
    "role": "caption",
    "lines": 1,
    "fontSize": 24,
    "minFontSize": 24,
    "textRect": {
     "x": 742,
     "y": 1243,
     "w": 266,
     "h": 20
    },
    "contrast": "5.1:1 (min 5.1:1, need 4.5:1)"
   }
  ]
 },
 {
  "slide": "slide-3",
  "ok": true,
  "summary": {
   "errors": 0,
   "warnings": 4,
   "info": 0
  },
  "issues": [
   {
    "rule": "small-font-size",
    "severity": "warning",
    "layer": "label-pack",
    "message": "Smallest text is 24px; body copy reads better at ≥ 28px."
   },
   {
    "rule": "small-font-size",
    "severity": "warning",
    "layer": "label-opened",
    "message": "Smallest text is 24px; body copy reads better at ≥ 28px."
   },
   {
    "rule": "small-font-size",
    "severity": "warning",
    "layer": "label-safety",
    "message": "Smallest text is 24px; body copy reads better at ≥ 28px."
   },
   {
    "rule": "small-font-size",
    "severity": "warning",
    "layer": "website",
    "message": "Smallest text is 24px; body copy reads better at ≥ 28px."
   }
  ],
  "text": [
   {
    "id": "counter",
    "role": "counter",
    "lines": 1,
    "fontSize": 26,
    "minFontSize": 26,
    "textRect": {
     "x": 72,
     "y": 75,
     "w": 66,
     "h": 22
    },
    "contrast": "19.68:1 (min 19.68:1, need 4.5:1)"
   },
   {
    "id": "eyebrow",
    "role": "eyebrow",
    "lines": 1,
    "fontSize": 26,
    "minFontSize": 26,
    "textRect": {
     "x": 72,
     "y": 219,
     "w": 280,
     "h": 22
    },
    "contrast": "4.59:1 (min 4.59:1, need 4.5:1)"
   },
   {
    "id": "headline",
    "role": "headline",
    "lines": 2,
    "fontSize": 136,
    "minFontSize": 136,
    "textRect": {
     "x": 72,
     "y": 313,
     "w": 646,
     "h": 231
    },
    "contrast": "19.68:1 (min 19.68:1, need 3:1)"
   },
   {
    "id": "label-pack",
    "role": "caption",
    "lines": 1,
    "fontSize": 24,
    "minFontSize": 24,
    "textRect": {
     "x": 72,
     "y": 678,
     "w": 145,
     "h": 20
    },
    "contrast": "5.1:1 (min 5.1:1, need 4.5:1)"
   },
   {
    "id": "value-pack",
    "role": "body",
    "lines": 1,
    "fontSize": 36,
    "minFontSize": 36,
    "textRect": {
     "x": 392,
     "y": 668,
     "w": 534,
     "h": 30
    },
    "contrast": "13.39:1 (min 13.39:1, need 4.5:1)"
   },
   {
    "id": "label-opened",
    "role": "caption",
    "lines": 1,
    "fontSize": 24,
    "minFontSize": 24,
    "textRect": {
     "x": 72,
     "y": 793,
     "w": 144,
     "h": 20
    },
    "contrast": "5.1:1 (min 5.1:1, need 4.5:1)"
   },
   {
    "id": "value-opened",
    "role": "body",
    "lines": 2,
    "fontSize": 36,
    "minFontSize": 36,
    "textRect": {
     "x": 392,
     "y": 783,
     "w": 336,
     "h": 78
    },
    "contrast": "13.39:1 (min 13.39:1, need 4.5:1)"
   },
   {
    "id": "label-safety",
    "role": "caption",
    "lines": 1,
    "fontSize": 24,
    "minFontSize": 24,
    "textRect": {
     "x": 72,
     "y": 955,
     "w": 154,
     "h": 20
    },
    "contrast": "5.1:1 (min 5.1:1, need 4.5:1)"
   },
   {
    "id": "value-safety",
    "role": "body",
    "lines": 3,
    "fontSize": 36,
    "minFontSize": 36,
    "textRect": {
     "x": 392,
     "y": 945,
     "w": 504,
     "h": 126
    },
    "contrast": "13.39:1 (min 13.39:1, need 4.5:1)"
   },
   {
    "id": "website",
    "role": "caption",
    "lines": 1,
    "fontSize": 24,
    "minFontSize": 24,
    "textRect": {
     "x": 742,
     "y": 1243,
     "w": 266,
     "h": 20
    },
    "contrast": "5.1:1 (min 5.1:1, need 4.5:1)"
   }
  ]
 }
]
</linter_report>

<first_pass_html>
<!-- slide-1 -->
<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v0">
  <meta name="studio:format" content="1080x1350">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>
    [data-artboard] { position: relative; }
    .theme-paper  { background: var(--color-paper); }
    .theme-forest { background: var(--color-forest); }

    /* header: counter */
    .counter { margin: 0; font-family: var(--font-text); font-size: 26px; font-weight: 700; line-height: 1.2; letter-spacing: 0.08em; white-space: nowrap; color: var(--color-ink); }
    .counter .of { color: var(--color-stone); }
    .theme-forest .counter { color: var(--color-paper); }
    .theme-forest .counter .of { color: var(--color-green); }

    /* stacks */
    .stack { display: flex; flex-direction: column; align-items: stretch; }
    .content { gap: 64px; }
    .intro { gap: 32px; }
    .eyebrow-block { gap: 16px; }

    .eyebrow { margin: 0; font-family: var(--font-text); font-size: 26px; font-weight: 700; line-height: 1.2; letter-spacing: 0.14em; text-transform: uppercase; color: var(--color-green-deep); }
    .theme-forest .eyebrow { color: var(--color-green); }
    .rule { flex: none; align-self: flex-start; width: 56px; height: 6px; background: var(--color-green); }

    /* one loud line per slide: wide black italic caps */
    .display { margin: 0; font-family: var(--font-display); font-size: 136px; font-weight: 900; font-stretch: 125%; font-style: italic; line-height: 0.96; letter-spacing: -0.01em; text-transform: uppercase; text-wrap: balance; hyphens: none; color: var(--color-ink); }
    .theme-forest .display { color: var(--color-paper); }
    .display .accent { color: var(--color-green); }

    .lede { margin: 0; font-family: var(--font-text); font-size: 36px; font-weight: 500; line-height: 1.34; hyphens: none; color: var(--color-graphite); }
    .lede strong { font-weight: 700; color: var(--color-ink); }
    .theme-forest .lede { color: var(--color-mist); }
    .theme-forest .lede strong { color: var(--color-paper); }

    /* label-like spec table */
    .spec { display: flex; flex-direction: column; border-bottom: 2px solid var(--color-line); }
    .spec-row { display: flex; flex-direction: row; align-items: baseline; gap: 24px; padding: 32px 0; border-top: 2px solid var(--color-line); }
    .spec-label { flex: none; width: 296px; margin: 0; font-family: var(--font-text); font-size: 24px; font-weight: 700; line-height: 1.2; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-stone); }
    .spec-value { flex: 1 1 0; min-width: 0; margin: 0; font-family: var(--font-text); font-size: 36px; font-weight: 500; line-height: 1.34; text-wrap: balance; hyphens: none; color: var(--color-graphite); }

    /* sign-off */
    .web { margin: 0; font-family: var(--font-text); font-size: 24px; font-weight: 700; line-height: 1.3; letter-spacing: 0.04em; text-align: right; white-space: nowrap; color: var(--color-stone); }
    .theme-forest .web { color: var(--color-mist); }
    .band-fill { fill: var(--color-green); }
  </style>
</head>
<body>
  <main data-artboard class="theme-forest" style="width:1080px;height:1350px">
    <p data-layer="counter" data-type="text" data-role="counter" class="counter" style="position:absolute;left:72px;top:72px;width:400px">1<span class="of"> / 3</span></p>

    <div data-layer="intro" data-type="group" class="stack intro" style="position:absolute;left:72px;top:216px;width:936px">
      <div data-layer="eyebrow-block" data-type="group" class="stack eyebrow-block">
        <p data-layer="eyebrow" data-type="text" data-role="eyebrow" class="ts-eyebrow eyebrow">VENTA BORINC</p>
        <div data-layer="eyebrow-rule" data-type="shape" data-role="decoration" class="brand-rule rule"></div>
      </div>
      <h1 data-layer="headline" data-type="text" data-role="headline" class="ts-display-xl display"><span class="accent">Doğru</span><br>saklama<br>rehberi</h1>
    </div>

    <p data-layer="subhead" data-type="text" data-role="subhead" class="ts-body-l lede" style="position:absolute;left:72px;top:1040px;width:776px">Uygun koşullarda raf ömrü <strong>3&nbsp;yıldır.</strong><br>Bu koşullar neler?</p>

    <img data-layer="logo" data-type="logo" src="/brand/logos/venta-wordmark-white.standin.png" alt="Venta" style="position:absolute;left:72px;top:1232px;height:44px;width:auto">
    <p data-layer="website" data-type="text" data-role="caption" class="web" style="position:absolute;left:648px;top:1238px;width:360px">www.mtmagro.com</p>
    <svg data-layer="label-band" data-type="shape" data-role="decoration" viewBox="0 0 1080 40" aria-hidden="true" style="position:absolute;left:0;top:1310px;width:1080px;height:40px"><path class="band-fill" d="M0 24H456V12A12 12 0 0 1 468 0H612A12 12 0 0 1 624 12V24H1080V40H0Z"/></svg>
  </main>
</body>
</html>


<!-- slide-2 -->
<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v0">
  <meta name="studio:format" content="1080x1350">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>
    [data-artboard] { position: relative; }
    .theme-paper  { background: var(--color-paper); }
    .theme-forest { background: var(--color-forest); }

    /* header: counter */
    .counter { margin: 0; font-family: var(--font-text); font-size: 26px; font-weight: 700; line-height: 1.2; letter-spacing: 0.08em; white-space: nowrap; color: var(--color-ink); }
    .counter .of { color: var(--color-stone); }
    .theme-forest .counter { color: var(--color-paper); }
    .theme-forest .counter .of { color: var(--color-green); }

    /* stacks */
    .stack { display: flex; flex-direction: column; align-items: stretch; }
    .content { gap: 64px; }
    .intro { gap: 32px; }
    .eyebrow-block { gap: 16px; }

    .eyebrow { margin: 0; font-family: var(--font-text); font-size: 26px; font-weight: 700; line-height: 1.2; letter-spacing: 0.14em; text-transform: uppercase; color: var(--color-green-deep); }
    .theme-forest .eyebrow { color: var(--color-green); }
    .rule { flex: none; align-self: flex-start; width: 56px; height: 6px; background: var(--color-green); }

    /* one loud line per slide: wide black italic caps */
    .display { margin: 0; font-family: var(--font-display); font-size: 136px; font-weight: 900; font-stretch: 125%; font-style: italic; line-height: 0.96; letter-spacing: -0.01em; text-transform: uppercase; text-wrap: balance; hyphens: none; color: var(--color-ink); }
    .theme-forest .display { color: var(--color-paper); }
    .display .accent { color: var(--color-green); }

    .lede { margin: 0; font-family: var(--font-text); font-size: 36px; font-weight: 500; line-height: 1.34; hyphens: none; color: var(--color-graphite); }
    .lede strong { font-weight: 700; color: var(--color-ink); }
    .theme-forest .lede { color: var(--color-mist); }
    .theme-forest .lede strong { color: var(--color-paper); }

    /* label-like spec table */
    .spec { display: flex; flex-direction: column; border-bottom: 2px solid var(--color-line); }
    .spec-row { display: flex; flex-direction: row; align-items: baseline; gap: 24px; padding: 32px 0; border-top: 2px solid var(--color-line); }
    .spec-label { flex: none; width: 296px; margin: 0; font-family: var(--font-text); font-size: 24px; font-weight: 700; line-height: 1.2; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-stone); }
    .spec-value { flex: 1 1 0; min-width: 0; margin: 0; font-family: var(--font-text); font-size: 36px; font-weight: 500; line-height: 1.34; text-wrap: balance; hyphens: none; color: var(--color-graphite); }

    /* sign-off */
    .web { margin: 0; font-family: var(--font-text); font-size: 24px; font-weight: 700; line-height: 1.3; letter-spacing: 0.04em; text-align: right; white-space: nowrap; color: var(--color-stone); }
    .theme-forest .web { color: var(--color-mist); }
    .band-fill { fill: var(--color-green); }
  </style>
</head>
<body>
  <main data-artboard class="theme-paper" style="width:1080px;height:1350px">
    <p data-layer="counter" data-type="text" data-role="counter" class="counter" style="position:absolute;left:72px;top:72px;width:400px">2<span class="of"> / 3</span></p>

    <div data-layer="content" data-type="group" class="stack content" style="position:absolute;left:72px;top:216px;width:936px">
      <div data-layer="intro" data-type="group" class="stack intro">
        <div data-layer="eyebrow-block" data-type="group" class="stack eyebrow-block">
          <p data-layer="eyebrow" data-type="text" data-role="eyebrow" class="ts-eyebrow eyebrow">Nerede saklanır</p>
          <div data-layer="eyebrow-rule" data-type="shape" data-role="decoration" class="brand-rule rule"></div>
        </div>
        <h1 data-layer="headline" data-type="text" data-role="headline" class="ts-display-xl display">Serin<br>ve kuru</h1>
      </div>

      <div data-layer="spec" data-type="group" class="spec">
        <div data-layer="row-air" data-type="group" class="spec-row">
          <p data-layer="label-air" data-type="text" data-role="caption" class="ts-caption spec-label">Ortam</p>
          <p data-layer="value-air" data-type="text" data-role="body" class="ts-body-l spec-value">İyi havalandırılan bir yer</p>
        </div>
        <div data-layer="row-light" data-type="group" class="spec-row">
          <p data-layer="label-light" data-type="text" data-role="caption" class="ts-caption spec-label">Işık</p>
          <p data-layer="value-light" data-type="text" data-role="body" class="ts-body-l spec-value">Güneş almayan bir yer</p>
        </div>
        <div data-layer="row-temperature" data-type="group" class="spec-row">
          <p data-layer="label-temperature" data-type="text" data-role="caption" class="ts-caption spec-label">Sıcaklık</p>
          <p data-layer="value-temperature" data-type="text" data-role="body" class="ts-body-l spec-value">5°C&nbsp;–&nbsp;45°C arası</p>
        </div>
      </div>
    </div>

    <img data-layer="logo" data-type="logo" src="/brand/logos/venta-wordmark-black.standin.png" alt="Venta" style="position:absolute;left:72px;top:1232px;height:44px;width:auto">
    <p data-layer="website" data-type="text" data-role="caption" class="web" style="position:absolute;left:648px;top:1238px;width:360px">www.mtmagro.com</p>
    <svg data-layer="label-band" data-type="shape" data-role="decoration" viewBox="0 0 1080 40" aria-hidden="true" style="position:absolute;left:0;top:1310px;width:1080px;height:40px"><path class="band-fill" d="M0 24H456V12A12 12 0 0 1 468 0H612A12 12 0 0 1 624 12V24H1080V40H0Z"/></svg>
  </main>
</body>
</html>


<!-- slide-3 -->
<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v0">
  <meta name="studio:format" content="1080x1350">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>
    [data-artboard] { position: relative; }
    .theme-paper  { background: var(--color-paper); }
    .theme-forest { background: var(--color-forest); }

    /* header: counter */
    .counter { margin: 0; font-family: var(--font-text); font-size: 26px; font-weight: 700; line-height: 1.2; letter-spacing: 0.08em; white-space: nowrap; color: var(--color-ink); }
    .counter .of { color: var(--color-stone); }
    .theme-forest .counter { color: var(--color-paper); }
    .theme-forest .counter .of { color: var(--color-green); }

    /* stacks */
    .stack { display: flex; flex-direction: column; align-items: stretch; }
    .content { gap: 64px; }
    .intro { gap: 32px; }
    .eyebrow-block { gap: 16px; }

    .eyebrow { margin: 0; font-family: var(--font-text); font-size: 26px; font-weight: 700; line-height: 1.2; letter-spacing: 0.14em; text-transform: uppercase; color: var(--color-green-deep); }
    .theme-forest .eyebrow { color: var(--color-green); }
    .rule { flex: none; align-self: flex-start; width: 56px; height: 6px; background: var(--color-green); }

    /* one loud line per slide: wide black italic caps */
    .display { margin: 0; font-family: var(--font-display); font-size: 136px; font-weight: 900; font-stretch: 125%; font-style: italic; line-height: 0.96; letter-spacing: -0.01em; text-transform: uppercase; text-wrap: balance; hyphens: none; color: var(--color-ink); }
    .theme-forest .display { color: var(--color-paper); }
    .display .accent { color: var(--color-green); }

    .lede { margin: 0; font-family: var(--font-text); font-size: 36px; font-weight: 500; line-height: 1.34; hyphens: none; color: var(--color-graphite); }
    .lede strong { font-weight: 700; color: var(--color-ink); }
    .theme-forest .lede { color: var(--color-mist); }
    .theme-forest .lede strong { color: var(--color-paper); }

    /* label-like spec table */
    .spec { display: flex; flex-direction: column; border-bottom: 2px solid var(--color-line); }
    .spec-row { display: flex; flex-direction: row; align-items: baseline; gap: 24px; padding: 32px 0; border-top: 2px solid var(--color-line); }
    .spec-label { flex: none; width: 296px; margin: 0; font-family: var(--font-text); font-size: 24px; font-weight: 700; line-height: 1.2; letter-spacing: 0.12em; text-transform: uppercase; color: var(--color-stone); }
    .spec-value { flex: 1 1 0; min-width: 0; margin: 0; font-family: var(--font-text); font-size: 36px; font-weight: 500; line-height: 1.34; text-wrap: balance; hyphens: none; color: var(--color-graphite); }

    /* sign-off */
    .web { margin: 0; font-family: var(--font-text); font-size: 24px; font-weight: 700; line-height: 1.3; letter-spacing: 0.04em; text-align: right; white-space: nowrap; color: var(--color-stone); }
    .theme-forest .web { color: var(--color-mist); }
    .band-fill { fill: var(--color-green); }
  </style>
</head>
<body>
  <main data-artboard class="theme-paper" style="width:1080px;height:1350px">
    <p data-layer="counter" data-type="text" data-role="counter" class="counter" style="position:absolute;left:72px;top:72px;width:400px">3<span class="of"> / 3</span></p>

    <div data-layer="content" data-type="group" class="stack content" style="position:absolute;left:72px;top:216px;width:936px">
      <div data-layer="intro" data-type="group" class="stack intro">
        <div data-layer="eyebrow-block" data-type="group" class="stack eyebrow-block">
          <p data-layer="eyebrow" data-type="text" data-role="eyebrow" class="ts-eyebrow eyebrow">Nasıl saklanır</p>
          <div data-layer="eyebrow-rule" data-type="shape" data-role="decoration" class="brand-rule rule"></div>
        </div>
        <h1 data-layer="headline" data-type="text" data-role="headline" class="ts-display-xl display">Ağzı<br>kapalı</h1>
      </div>

      <div data-layer="spec" data-type="group" class="spec">
        <div data-layer="row-pack" data-type="group" class="spec-row">
          <p data-layer="label-pack" data-type="text" data-role="caption" class="ts-caption spec-label">Ambalaj</p>
          <p data-layer="value-pack" data-type="text" data-role="body" class="ts-body-l spec-value">Orijinal ambalajında saklayın.</p>
        </div>
        <div data-layer="row-opened" data-type="group" class="spec-row">
          <p data-layer="label-opened" data-type="text" data-role="caption" class="ts-caption spec-label">Açılınca</p>
          <p data-layer="value-opened" data-type="text" data-role="body" class="ts-body-l spec-value">Sıkıca kapatıp kısa sürede tüketin.</p>
        </div>
        <div data-layer="row-safety" data-type="group" class="spec-row">
          <p data-layer="label-safety" data-type="text" data-role="caption" class="ts-caption spec-label">Güvenlik</p>
          <p data-layer="value-safety" data-type="text" data-role="body" class="ts-body-l spec-value">Gıda, yem ve ilaçlardan ayrı; çocukların ve hayvanların erişemeyeceği yerde tutun.</p>
        </div>
      </div>
    </div>

    <img data-layer="logo" data-type="logo" src="/brand/logos/venta-wordmark-black.standin.png" alt="Venta" style="position:absolute;left:72px;top:1232px;height:44px;width:auto">
    <p data-layer="website" data-type="text" data-role="caption" class="web" style="position:absolute;left:648px;top:1238px;width:360px">www.mtmagro.com</p>
    <svg data-layer="label-band" data-type="shape" data-role="decoration" viewBox="0 0 1080 40" aria-hidden="true" style="position:absolute;left:0;top:1310px;width:1080px;height:40px"><path class="band-fill" d="M0 24H456V12A12 12 0 0 1 468 0H612A12 12 0 0 1 624 12V24H1080V40H0Z"/></svg>
  </main>
</body>
</html>

</first_pass_html>

