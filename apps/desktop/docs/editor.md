# Post editor (canvas)

Opening a post (a card on Postlar, click or ↩; a chat card; the calendar) opens it straight into
the canvas, **inside the app's layout** (`src/renderer/features/post-editor/workspace.tsx`): the
top bar stays the app's top bar, and

- **the sidebar keeps its navigation** (Yeni sohbet … Markalar) and, where the conversations are
  otherwise, shows **Wecra's Layers** in the sidebar's look; leaving the post brings the
  conversations back;

- **the centre column becomes Wecra's editor**: Wecra's own `EditorApp` — its engine draws the
  slides as frames and does everything Wecra does there: selection, handles, smart guides,
  snapping, auto layout, constraints, its text engine, images, effects, vector editing, its keys,
  clipboard, context menu, dialogs and overlays. One floating dock sits at its bottom;
- **the right panel becomes the post's panel** (same container as Ayrıntılar & co.: same width,
  resizable, expandable, its header in the top bar's panel segment): on Düzenle **Wecra's Design
  panel** (tab Tasarım; Wecra's zoom menu in the header) and the caption (tab Açıklama); on Sohbet
  the post's conversation;
- **the top bar's title area shows the post**: the title with the post's menu (quick look, copy
  caption, open in chat, duplicate, delete), its state, the version chip (versions popover), the
  save state, Onayla and Zamanla.

**Back is only the app's**: ‹ › at the right edge of the sidebar's top-bar segment (following its
width; with the sidebar hidden, beside the sidebar toggle in the top bar), ⌘[ ⌘], a swipe. The title area, the canvas and
the loading view have no back or close button of their own (there used to be a "‹ Postlar" in the
title area beside the app's ‹ — two backs). Reels keep the post detail over the centre (they are
edited in chat); its breadcrumb is plain text there too.

## Wecra's editor stack, vendored

Burak's Wecra (DesignerV2, closed source) is copied into
`src/renderer/vendor/wecra-editor/` by `scripts/vendor-wecra.mjs`, from DesignerV2's **git
history** (`git archive <ref>`, never its working tree, never written back): `src/renderer/src`
(the editor, the engine glue and the committed Wasm build, the design system, the store's browser
half), `src/shared`, `src/store`, `src/viewer` and Wecra's page-capture converter
(`src/main/agents/reach/webSpec.ts`). Tests are left out. Every `.ts`/`.tsx` gets `// @ts-nocheck`
(Wecra's compiler options are not Studio's; its own `tsconfig.json` is generated next to the copy,
Vite's transform reads it). `VERSION.json` records the Wecra version, the commit, the engine's
commit and ABI and the SHA-256 of every file.

**The copy is gitignored** (`apps/desktop/src/renderer/vendor/` in `.gitignore`): Studio's
repository is public and Wecra is closed source. `git status --porcelain
apps/desktop/src/renderer/vendor` must stay empty.

```sh
node apps/desktop/scripts/vendor-wecra.mjs                # HEAD of ../DesignerV2 (or --repo, WECRA_REPO)
node apps/desktop/scripts/vendor-wecra.mjs --ref <commit> # a given Wecra
node apps/desktop/scripts/vendor-wecra.mjs --check        # the copy matches VERSION.json
```

Without the copy the app still runs: opening a post says what to run
(`wecra/vendored.ts`), `electron-vite dev` warns at start, the engine tests stop with the same
message. A production build needs it.

### Embedding patches (the only changes to Wecra's code)

Applied by the script as exact text replacements (it stops when one no longer matches) and all
reading `globalThis.__wecraEmbed`, which `wecra/embed.ts` sets; without it Wecra behaves as in its
own app:

| File                                                                 | Patch                                                                                                                                                                                                      |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `editor/EditorApp.tsx`                                               | embedded: no rail, left / right panels, bottom toolbar or "?"; the theme on its own elements, not on `<html>`                                                                                              |
| `editor/canvas/BottomToolbar.tsx`, `ds/components/EditorToolbar.tsx` | `embedded`: in flow (the dock), no mode switch, no Comment group, no Actions                                                                                                                               |
| `editor/keyboard.ts`, `editor/clipboardIO.ts`                        | keys / clipboard only from the editor's places (`[data-wecra-region]`, Wecra's overlays) or from nowhere — Studio's fields, buttons and chat keep theirs, text selected in Studio is copied by the browser |
| `store/index.ts`                                                     | Wecra's browser store without its demo files, nothing kept in Studio's localStorage                                                                                                                        |

Build glue (`wecra.vite.ts`): Wecra's aliases `@/…` (its renderer) and `@shared/…`; stand-ins for
the packages of features the post editor leaves out (visual search and image models:
transformers.js, onnxruntime; plugins: QuickJS); Wecra's page-wide `ds/global.css` replaced by
`wecra/wecra.css`. Wecra's small runtime packages are Studio dependencies (clsx, fuse.js,
kiwi-schema, fzstd, gifenc, mp4-muxer, webm-muxer, qrcode-generator).

### Studio's places (`wecra/host.tsx`)

Wecra's components drawn in Studio's layout on the same editor (`EditorContext`), nothing
re-implemented:

| Studio                   | Wecra                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| centre column            | `EditorApp` (embedded)                                                                                                                                                                       |
| right panel, Tasarım     | `DesignPanel` (Frame / Text header with Status, Position, Auto layout / Layout, Appearance, Typography, Fill, Stroke, Effects, Selection colors, Layout guide, Export), Tab order as Wecra's |
| panel header             | `ZoomMenu` (zoom, pixel preview, rulers, outlines …)                                                                                                                                         |
| sidebar (`sidebar` slot) | `Layers` (Wecra's tree: select, ⇧ / ⌘ ranges, rename, eye, lock, drag to reorder and regroup, collapse)                                                                                      |
| dock, Düzenle            | `BottomToolbar` (embedded): Move ▾, Region ▾, Shape ▾, Creation ▾, Text ▾                                                                                                                    |

Hidden (a post editor doesn't need them): Prototype tab, Dev Mode and the mode switch, comments,
the rail (Assets, Agents, Brands), Pages, Actions, sharing, multiplayer chrome, the file menu.
Wecra's own dialogs that commands open still work (export, nudge, shortcuts …).

**Look** (`wecra/wecra.css`): Wecra's tokens and components unchanged; its colour tokens mapped
onto Studio's palette per theme (Studio's orange for "brand": the active tool, primary buttons,
focus rings; Wecra's blue stays for _selection_, which the engine draws on the canvas in blue);
controls (fields, selects, buttons, segmented controls, tools, layer rows) full round, menus and
popovers Studio's 14 px radius; its UI font stays Inter (the bundled 3.19), as Wecra's panel
layout is measured for it. The canvas (WebGL) is Wecra's: its page colour and selection colour are
the engine's.

**Layers in the sidebar, not a tab**: the right panel switches between Düzenle (Wecra's Design
panel) and Sohbet, while the layers are needed in both (picking what to talk about is picking
layers); the sidebar keeps Wecra's / Figma's arrangement (layers left of the canvas, properties
right) and the canvas stays clear (no card over it). The sidebar's lower part (where the brand
groups and their chats are) is a slot the workspace renders into (`ui/sidebar-layers.tsx`):
Wecra's own `Layers` (every interaction its own) under a "Katmanlar" header like the brand groups'
(it folds the list, remembered, `workspace-store.ts`), restyled in `wecra/wecra.css`
(`.wecra-sidebar-layers`) to the sidebar's look — Studio's type and colours, 32 rows 8 in with
the round full-row hover / selected fill, the frames ("Kare 1" …) drawn as the brand groups'
collapsible headers (footnote, tertiary, chevron after the name), the layers under them with
Wecra's glyph, 16 per level; Wecra's own header is left out. With the sidebar hidden (⌘\) the
layers are hidden too. Zoom to fit keeps clear of the dock (Wecra's view insets).

### Sohbet / Düzenle

The dock is one object: its content, a full-height line, and the mode switch **Sohbet / Düzenle**
at its right. On Düzenle it holds Wecra's tools; on Sohbet it morphs (`motion` layout animation)
into the post's message box and the right panel shows the post's conversation (`chat.ts`). A tool
picked on the canvas (V, T, R … ) goes to Düzenle. `@` chips and the canvas selection are Wecra's
layers (`wecra/scope.ts`: "Kare 2 › headline").

## The data model: a Wecra document per version

### Opening (`wecra/session.ts`)

- A version **saved from the canvas** carries an editor document (`ContentVersion.editorDocument`,
  `{ kind: "wecra", assetId, format: 1 }`): that bundle opens.
- **Any other version** (generated or revised by the AI: design-contract HTML) is **imported once**
  into a blank Wecra document as the editor comes up (`wecra/import.ts`), by Wecra's own importer —
  the one its agents use for web pages (`capture_web_design`): each slide is rendered as before
  (brand.css inlined, `/brand/` and `/media/` mapped, `html/slide-document.ts`) in a hidden frame,
  Wecra's DOM walker reads it as laid out (boxes, fills, borders, radii, shadows, linear gradients,
  flex → auto layout when the positions prove it, text runs with their fonts), Wecra's converter
  turns it into create_nodes specs and Wecra's `create_nodes` makes the layers — outside the undo
  history. Slide _i_ → top-level frame "Kare _i_" (its size, clipped, 120 px apart; Kare 1 on top
  in Layers); `data-layer` → the layer's name (a text too when it is its layer's only text);
  `<img>` / `url()` → an image fill with the file's own bytes (cover → FILL, contain → FIT, fill →
  CROP; SVG files drawn to PNG at 2×); inline `<svg>` → vector layers. A picture Wecra can't take
  is left out (the import goes on, a toast says so). Not carried over: `text-wrap: balance`,
  `object-position` (pictures are centred), filters on pictures, blend modes.

### Drafts and versions (S5)

An edit on the canvas only marks it **unsaved**; a moment later (0.8 s, not during a gesture) the
document is written to the post's **one draft on this Mac** — no API call, no version, approval and
schedules untouched. The main process keeps it (`src/main/drafts.ts`: `<state>/drafts/<post>.draft`,
0600, written atomically: temporary file, fsync, rename) through `window.studio.drafts`
(`src/shared/drafts.ts`). "Unsaved" is the document's hash against the version's
(`wecra/hash.ts`: the engine's kiwi snapshot with the editor session cleared), so undoing back to
the saved state is clean again and the draft goes. The title area says it quietly: Kaydedilmedi /
Kaydedildi (a warning icon when the frames can't be saved, see below).

A **version** is created only on ⌘S, "Sürüm kaydet" (with a name = the note), Onayla, Zamanla, a
Sohbet message and **closing the post with changes**:

1. the slides are the page's top-level frames in reading order (Wecra's `pageFrames`); they must
   fit the post (`wecra/frames.ts`, E15): no hidden frame (it would drop its slide), every frame
   the post's format (the size its version was made in — 1080×1350 or 1080×1080; a story
   1080×1920), the count of its type (a carousel 2–20: add, duplicate, delete freely; a single
   post or a story one — a post's type can't change, so a second frame there is explained). A
   canvas that doesn't fit is not saved; the draft keeps it and the reason is shown;
2. **each frame is exported by Wecra's engine** (its exporter, PNG 1x, sRGB);
3. the document's **pictures become the brand's assets**, each once (`wecra/assets.ts`, E13): one
   whose bytes (SHA-256) are a known asset — the opened bundle's references, a picture the import
   read from the brand's media, an earlier upload — is linked to it, any other is uploaded
   (`tuval-gorseli.*`, kind image); a file that can't be an asset stays inside the bundle;
4. the document is bundled (`wecra/bundle.ts`, format 2, a zip by Wecra's own writer):
   `meta.json` (format, Wecra's version and commit, the slides, the images, **the asset each image
   is**, the HTML version it came from), `document.kiwi` (the engine's own kiwi snapshot:
   lossless) and `images/<sha1>` only for pictures that are no asset. Format 1 bundles (every
   picture inside) still open;
5. renders and bundle are uploaded and a new `manual_edit` version is created: its slides are the
   renders (`wecra/slide-html.ts`), `renderedAssetIds` the renders, `editorDocument` the bundle;
6. a `content.check` job (no model pass) checks the new version; the post re-reads its versions
   and the new one is shown — the document on the canvas is the one just saved (no reload). Only
   now does the API take an approval away (a new version always does).

A version that can't be made (the frames, a failure) keeps the draft and says why. Closing the
post writes the draft first, then makes the version; when that fails the toast says the changes
wait as a draft (E14).

**Opening a post with a draft**: a draft made on the version that opens is put back on the canvas
silently ("Kaydedilmemiş değişiklikler geri yüklendi" · Vazgeç); one made on an older version, or
for a post that is locked now, is offered — "Taslağı aç / Sil" — and the canvas waits read only
until it is answered (it is never overwritten meanwhile). Looking at an older version keeps the
draft for the current one.

**A new version arriving** (the AI, a job) while the canvas has unsaved edits never replaces them
(E4): the canvas stays, the draft is written, and the user picks — "Benimkini kaydet" (the canvas
becomes a version on top; the arrived one stays in the history) or "Yeni sürümü aç" (it opens, the
edits stay a draft, offered). Onayla / Zamanla / Sohbet wait for the answer. (Versions carry no
"based on": asking is the one behaviour that is always safe.)

**Close, ⌘Q, reload** (E14): before the window closes or the app quits the main process asks the
page to write its drafts (`lifecycle:flush-request`, `src/main/flush.ts`: at most 2 s, then it
goes on); a reload writes it on `beforeunload` with a blocking IPC (`drafts:save-sync`).

### Read only (E3)

`edit-lock.ts`: the canvas opens in Wecra's own viewer mode (`Engine.setViewerMode`: no handles,
drags move nothing, edits and commands refused; the dock shows "Salt okunur") when the post is

- **approved or scheduled**: "Düzenle" first says what it costs — once a version is made the
  approval goes and the schedules (listed by account) are cancelled — and then unlocks;
- **publishing** or **published**: never unlocked; a published post offers "Kopyasını oluştur"
  (`POST /api/contents/{id}/duplicate`);
- an **older version** is shown: "Bu sürüme dön" (restore, explicit) or "Güncel sürüm" (E19);
- an **AI run** may make a version: the Sohbet answering, a `content.generate` job or a render
  with edits for the post.

### Keys and gestures (E8)

The canvas column is `data-no-swipe`: a two-finger sideways pan there moves the canvas, never the
app's history (also a wheel something already used, and the window's three-finger swipe over it).
⌘[ / ⌘] on the canvas and Wecra's layers are Wecra's (send backward / bring forward), even with
nothing selected: the workspace marks the key used after Wecra's handler, so the menu's Geri /
İleri (which carry the same keys) skip it; with the focus anywhere else — the page itself
included (`wecra/embed.ts ownsEvent`) — they go back and forward.

### A document this Wecra can't read (E19)

After re-vendoring, a bundle that no longer decodes falls back to importing the HTML version it
came from (`studio:source-version`), saying the canvas's hand edits are not in it; without one the
version's renders are shown read only with the reason.

### The AI

AI revisions still produce HTML versions; such a version has no editor document, so the canvas
**imports it anew** when it is shown (the simple path). A canvas-saved version's HTML is the render
with its layers described above it (see below): the Sohbet's first message tells the agent (`chat.ts postReference`) that the version
was edited on the canvas and which HTML version the canvas started from (`studio:source-version`),
to make text and layer changes from there. **Gap**: the agent's new version does not carry the
canvas's hand edits made after that import (a Wecra-aware agent tool — editing the Wecra document
through Wecra's own MCP tools — is the next step).

### What a canvas version says (canvas facts: E1, E5, E11)

The Wecra document stays the truth (S1) and the PNG is what gets published; the slide HTML of a
canvas version **describes** that PNG so checks, the AI, alt text and the iPhone can read it
(`@studio/design-kit/canvas`):

- **Facts** (`wecra/facts.ts`, read at the save from Wecra's engine, at once with the export):
  every layer of the frame in paint order — Wecra id, name, kind (text / image / shape / group /
  frame), box in slide px (axis-aligned, rotation given), opacity, visibility, the clip of
  enclosing frames, fills and strokes (pictures by Wecra's image key, fit, pixel size); texts with
  characters, font family / style / weight / size, line height, letter spacing, alignment,
  colours (runs too), **the lines Wecra's text engine laid out**, and Wecra's own overflow (layout
  taller / wider than a fixed box), truncation and missing-font flags; the frame's size and
  background; the fonts used and which Wecra did not have. Schema: `CanvasFacts`
  (`packages/design-kit/src/canvas/facts.ts`).
- **Contract meaning survives the canvas**: the import keeps each `data-layer`'s type, role, slot
  attributes and picture file on its Wecra layer as plugin data (`studio` / `layer`,
  `import.ts markLayers`), with the picture's image key as imported — so an image slot is still a
  slot, a logo still the brand's file (until its picture is replaced), a headline still a headline.
- **The slide HTML** (`canvasSlideHtml`): contract-valid (brand.css linked, lint-clean): the render
  as `<img data-layer="canvas">` at the bottom; above it one invisible (`opacity: 0`) `data-layer`
  per text (its real text; colours and fonts as `data-color`, `data-font` …), image slot
  (`data-slot-*`, filled or empty from the document), logo and picture, at their boxes; the facts
  as JSON in `<meta name="studio:canvas">` (a `<script>` would be removed by the sanitiser); a short
  `alt` from the most prominent texts. Chromium renders it to exactly the PNG (tested pixel for
  pixel). `layouts` of the version are these boxes.
- **Checks** (`apps/worker/src/checks/pipeline.ts` → `lintCanvasSlide`): no Chromium layout for a
  canvas slide; overflow, truncation, slide edge and clipping, safe area (the preset's), font sizes,
  fonts outside the brand kit or missing on the canvas, overlaps, text under an opaque layer, logo
  clear space / overlap / safe area, upscaled pictures from the facts; **contrast from the PNG's
  pixels** under each text's lines (its own ink told apart by colour and left out); numbers,
  banned words and the model pass on the real texts; empty slots; a logo the source design had
  but the canvas lost. Canvas slides are never auto-fixed (they are fixed on the canvas).
- **No vacuous passes**: a check that could not read every slide is `skipped` with the reason
  (`skipReasons` + `withPasses`), not `pass`. Versions saved before the facts (one `<img>`, no
  facts) still open (the bundle is the truth); their slide checks say "Eski tuval kaydı … yeniden
  kaydedin". When the facts can't be read at a save, the slide is the render alone (same skip).

## API (migration `0016_editor_documents`)

- `content_version_documents` (version → one editor document: kind `wecra`, the bundle asset,
  the format; goes with the version; not part of the hash).
- `ContentVersionCreate.editorDocument` (checked: an asset of the post's brand, a Wecra bundle);
  `ContentVersion.editorDocument` (`null`: none; absent from older servers); restore and duplicate
  copy it.
- Assets accept `application/vnd.wecra.document+zip` (kind `document`, ≤ 50 MB, sniffed as a zip).

## Fonts

Wecra's text engine shapes with the font files themselves (`wecra/fonts.ts`, Wecra's
`FontSource`): Wecra's bundled Inter; the fonts installed on this Mac (Studio's font list; a face's
bytes from the main process, `fonts:read` — `main/fonts.ts FontFiles`: the file located through
AppKit, a face of a `.ttc` / `.otc` cut out as a font of its own); the brand's uploaded TTF / OTF
files under their role's family. WOFF / WOFF2 files are not read by the engine: such a family is
"missing" in Wecra's Design panel (the text draws in Inter) unless it is installed.

## Gaps

- The canvas's selection and page colours are the engine's (blue selection): the engine has no
  colour option; making it Studio's orange needs a change in Wecra.
- Safe-area bands and collision chips (the old editor's) are not on Wecra's canvas yet (Wecra's
  Social mode has its own safe areas: a candidate to switch on).
- First comment and per-slide alt text fields: as before, not in the content model (a canvas
  slide's short alt is in its HTML, on the render's `<img>`).
- Canvas facts: a picture added on the canvas has no file of its own in the HTML (its layer points
  at the render; the facts keep its Wecra image key); logos added on the canvas are not recognised
  as the brand's logo (only imported ones); colours are taken as sRGB (a Display P3 document's
  colours are not converted); rotated texts are checked by their axis-aligned boxes.
- The frame size is checked when a version is made (and shown as a warning while editing), not
  held by the engine: a frame can still be resized on the canvas.
- The E19 fallback covers bundles that no longer decode; a document that decodes but that Wecra's
  engine then refuses to load still shows Wecra's own "could not be opened" message.
- Checked headless (Chromium + SwiftShader, `?demo=post-editor`; WebGPU is off there, the engine
  runs on WebGL2): opening, the import, selection, the Design panel, ⌘S → a version with renders
  and the bundle. The look and feel in the app is for Burak to judge.

## Files

```
scripts/vendor-wecra.mjs            vendor / check Wecra (gitignored copy)
wecra.vite.ts                       Wecra's aliases, stand-ins, its stylesheet → Studio's
src/renderer/vendor/wecra-editor/   the vendored Wecra (do not edit, never commit)
features/post-detail/post-detail.tsx  the opened post: the canvas workspace (lazy) or the reel detail
features/post-editor/
  workspace.tsx                     the post workspace (Wecra's editor in Studio's places)
  workspace-store.ts                mode per post, edit tab, sidebar layers folded, post → conversation
  slots.tsx                         the shell's slots (title area, panel header, panel)
  chat.ts                           the post's Sohbet (conversation binding, message text)
  wecra/embed.ts                    what the embedding patches read (places, store, keys)
  wecra/host.tsx                    EditorApp, Design panel, Layers, toolbar, zoom menu in Studio
  wecra/wecra.css                   Wecra's base rules in its places, Studio's colours and radii
  wecra/session.ts                  open (bundle, import, draft), unsaved, draft, version, read only
  wecra/frames.ts                   slide frames and whether they fit the post (E15)
  wecra/assets.ts                   pictures as the brand's assets, uploaded once (E13)
  wecra/hash.ts                     the document's hash (unsaved = differs from the version)
  edit-lock.ts                      when the canvas is read only, Düzenle's warning (E3)
  wecra/import.ts                   HTML slides → Wecra layers (Wecra's walker + converter)
  wecra/bundle.ts                   the Wecra document bundle
  wecra/slide-html.ts               a canvas-saved slide's HTML (render, hash, facts, alt)
  wecra/facts.ts                    a slide frame's canvas facts, read from Wecra's engine
  wecra/fonts.ts                    Wecra's font source in Studio
  wecra/scope.ts                    the Sohbet's layers (selection, @)
  wecra/vendored.ts                 is Wecra vendored here, what to do when not
  html/slide-document.ts            slide srcdoc (brand.css inlined, URLs mapped)
  model/brand-kit.ts                brand.css / fonts as the worker builds them
  ui/title-bar.tsx                  the top bar's title area (no back of its own), versions popover
  ui/mode-dock.tsx                  the dock: morph, mode switch, message box
  ui/sidebar-layers.tsx             the sidebar's "Katmanlar" (Wecra's Layers)
  ui/caption-panel.tsx, ui/chat-panel.tsx
  demo/                             `?demo=post-editor[&format=story]` (in-memory API and chat)
test/engine/wecra-post.test.ts      the real engine: import, bundle round trip, export, save, fonts
test/engine/wecra-facts.test.ts     the real engine (Inter loaded): marks, facts, overflow, HTML + checks
test/engine/wecra-save-model.test.ts  drafts vs versions, undo to clean, read only, incoming, close,
                                    picture dedupe, old bundles, frames, fallbacks
test/main/drafts.test.ts            the draft store (0600, atomic) and the close / quit flush
test/renderer/post-workspace.test.tsx  layout, single back, panels, sidebar layers, mode, Sohbet
test/renderer/post-editor-model.test.ts  slide documents, saved slide HTML / hash, keys, AI note
apps/api/test/contents-editor.test.ts  editor documents on versions
```
