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

| Studio               | Wecra                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| centre column        | `EditorApp` (embedded)                                                                                                                                                                       |
| right panel, Tasarım | `DesignPanel` (Frame / Text header with Status, Position, Auto layout / Layout, Appearance, Typography, Fill, Stroke, Effects, Selection colors, Layout guide, Export), Tab order as Wecra's |
| panel header         | `ZoomMenu` (zoom, pixel preview, rulers, outlines …)                                                                                                                                         |
| sidebar (`sidebar` slot) | `Layers` (Wecra's tree: select, ⇧ / ⌘ ranges, rename, eye, lock, drag to reorder and regroup, collapse)                                                                                      |
| dock, Düzenle        | `BottomToolbar` (embedded): Move ▾, Region ▾, Shape ▾, Creation ▾, Text ▾                                                                                                                    |

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

### Saving

⌘S, "Sürüm kaydet" (with a name = the note), 6 s after the last edit (not during a gesture), and
before approve, schedule, a Sohbet message and leaving the post (the closing save reads everything
from the editor at once, before it goes):

1. the slides are the page's top-level frames in reading order (Wecra's `pageFrames`); their count
   must fit the post type (`SLIDE_LIMITS`: frames can be added, duplicated and deleted on the
   canvas now) and their size 1–4096 px;
2. **each frame is exported by Wecra's engine** (its exporter, PNG 1x, sRGB);
3. the document is bundled (`wecra/bundle.ts`, a zip by Wecra's own writer): `meta.json`
   (format, Wecra's version and commit, the slides, the images, the HTML version it came from),
   `document.kiwi` (the engine's own kiwi snapshot: lossless) and `images/<sha1>`;
4. renders and bundle are uploaded as the brand's assets (the bundle as
   `application/vnd.wecra.document+zip`, kind `document`) and a new `manual_edit` version is
   created: its slides are the renders (`wecra/slide-html.ts`: the render as the artboard's one
   image layer, **its SHA-256 in the HTML**, the slide's texts as alt), `renderedAssetIds` are the
   renders, `layouts` that one layer (measured: no measuring render replaces the engine's PNG),
   `editorDocument` the bundle;
5. a `content.check` job (no model pass) checks the new version; the post re-reads its versions
   and the new one is shown — the document on the canvas is the one just saved (no reload).

So the **content hash — what approval is bound to — covers the renders' pixels**; approving
recomputes it from the shown version as before (unchanged code path), scheduling and publishing
use the version's renders, previews and the board show them. Restoring and duplicating a version
carry its document.

### The AI

AI revisions still produce HTML versions; such a version has no editor document, so the canvas
**imports it anew** when it is shown (the simple path). A canvas-saved version's HTML is one image
per slide: the Sohbet's first message tells the agent (`chat.ts postReference`) that the version
was edited on the canvas and which HTML version the canvas started from (`studio:source-version`),
to make text and layer changes from there. **Gap**: the agent's new version does not carry the
canvas's hand edits made after that import (a Wecra-aware agent tool — editing the Wecra document
through Wecra's own MCP tools — is the next step).

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
- Unsaved edits live only in memory until the save 6 s later (no localStorage draft of the
  document).
- First comment and per-slide alt text fields: as before, not in the content model.
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
  wecra/session.ts                  open (bundle or import), dirty, save (engine export → version)
  wecra/import.ts                   HTML slides → Wecra layers (Wecra's walker + converter)
  wecra/bundle.ts                   the Wecra document bundle
  wecra/slide-html.ts               a canvas-saved slide's HTML (render, hash, alt)
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
test/renderer/post-workspace.test.tsx  layout, single back, panels, sidebar layers, mode, Sohbet
test/renderer/post-editor-model.test.ts  slide documents, saved slide HTML / hash, keys, AI note
apps/api/test/contents-editor.test.ts  editor documents on versions
```
