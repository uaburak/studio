# Venta — design rules (PROVISIONAL)

> Status: provisional stand-in, v0.1. Derived only from the Venta Borinc packaging photo, because no
> published Venta/MTM Agro posts or brand kit were available. Not approved by Burak. Every rule here
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
