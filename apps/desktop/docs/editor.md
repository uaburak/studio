# Post editor (canvas)

Opening a post (a card on Postlar, click or ↩; a chat card; the calendar) opens it straight into
the canvas, **inside the app's layout** (`src/renderer/features/post-editor/workspace.tsx`): the
sidebar stays the app's, the top bar stays the app's top bar, and

- **the centre column becomes the canvas**: slides as artboards on an infinite canvas, the
  floating layers list docked on its left edge, one floating dock at its bottom;
- **the right panel becomes the post's panel** (same container as Ayrıntılar & co.: same width,
  resizable, expandable, its header in the top bar's panel segment; a first tool icon switches
  back to it when another pane was picked);
- **the top bar's title area shows the post**: back (to where it was opened from), the title with
  the post's menu (quick look, copy caption, open in chat, duplicate, delete), its state, the
  version chip (versions popover), the save state, Onayla and Zamanla.

Back (the title area's ‹, the window's back, ⌘[ or a swipe) returns to the board. Reels keep the
post detail over the centre (they have no slides to edit; they are edited in chat).

### Sohbet / Düzenle

The dock is one object (Wecra's bottom toolbar): its content, a full-height line, and the mode
switch **Sohbet / Düzenle** at its right. On Düzenle it holds the edit tools (Seç ▾ / El / Ölçekle,
Metin, Şekil, Görsel, undo / redo, Güvenli alan, Görünüm ▾ (all slides / focus, layers list,
snapping, rulers, preview format), zoom ▾) and the right panel is the edit panel. On Sohbet the same
capsule morphs (`motion` layout animation: width, height and content) into the post's message box
and the right panel shows the post's conversation. The mode is remembered per post on this Mac
(`workspace-store.ts`); a tool key (V, H, K, T, R) goes to Düzenle, ⌘K to Sohbet.

The **edit panel** is Wecra's properties panel in Studio's controls (`ui/edit-panel.tsx`,
`ui/fields.tsx`: 40 px section headers, a two-column grid with a 24 px action column, capsule
fields). Tabs in its header: **Tasarım** and **Açıklama** (the caption editor). Tasarım, by
selection: the header (what is selected, its "…" menu), Konum (alignment, X / Y, lock, rotation),
Boyut, Görünüm (visibility, blend mode, opacity, corner radius), Metin (Studio: the text),
Tipografi (FontPicker with the Mac's fonts and the brand's pinned, weight, size, leading,
tracking, alignment, case, the brand's font roles), Dolgu (colour and alpha, brand swatches),
Kenarlık (a border the design already has: its colour), Görsel (Studio: replace, AI, fit, crop,
adjustments), Efektler (layer blur), AI ile düzenle. Nothing selected: the slide's header, Biçim
(preview format, safe area on / off, the insets), Uyarılar (safe-area collisions), Kontroller (the
checks list), AI ile düzenle, Dışa aktar (each slide's rendered PNG; unsaved edits are saved first).

**Layers** float on the canvas's left edge (`ui/layers-dock.tsx`), not in the right panel: the
right panel switches between Düzenle and Sohbet, while the layers are needed in both (picking what
to talk about is picking layers); it keeps Figma's / Wecra's arrangement (layers left of the
canvas, properties right); and the properties keep the panel's full height. Slides are its
top-level rows (as Figma's frames) with their layers inside; it folds into a "Katmanlar" pill
(remembered), and fitted slides keep clear of it.

The **Sohbet** is a conversation bound to the post (`chat.ts`): this Mac remembers which
conversation belongs to which post. The first message creates it (in the post's brand, named
after the post) and starts with the post's reference (`“Başlık” postu (id: …, vN) için:`); `@`
layer chips (or the canvas selection) become the scope line (`Kapsam: Kare 1 › headline …`).
The draft is saved before each message. The panel shows the app's own transcript (messages,
steps, cards, working line, queue); ↩ sends (queues while a reply runs), the empty send button
stops the reply. When a reply ends the post is re-read, and finished jobs of the post do the same
(post-detail.tsx), so versions the agent made land on the canvas. "Sohbette tam ekran aç" opens
the conversation in the chat; "Bu post için yeni sohbet" starts over. The edit panel's AI chips and
the selection toolbar's "Sohbette düzenle" go to the Sohbet.

The canvas follows Wecra's "Post Editor" draft (file *Studio*, page *Claude Code*, section *Post
Editor*), not pixel for pixel: where the draft and the design contract disagree, the contract
wins (see "What the contract allows" below).

## Decision: Wecra's engine for interaction, the slide's own HTML for pixels

**Wecra's engine is vendored as a versioned WebAssembly build and drives the canvas**: camera
(zoom, pan, pinch, space-drag), picking, hover, multi-selection, marquee, handles (move, resize,
rotate), smart guides with spacing labels, snapping, nudging, ⌥-drag copies, the scale tool,
alignment and stacking commands, focus view and the safe-area bands. Its document is an adapter
image of the post (below).

**What the canvas shows is the slide itself**: every slide is its design-contract HTML in a
sandboxed `<iframe>` (no scripts), with the brand's `brand.css` generated by design-kit exactly as
the Mac worker generates it, the same `/brand/` and `/media/` files, the same Chromium and the
Mac's installed fonts. The worker renders that same HTML with Playwright's Chromium, so the canvas
is the render (WYSIWYG by construction), including CSS the engine has no model for (flex/grid
groups, `text-wrap: balance`, blend modes, gradients, `color-mix`, filters).

Why not let the engine draw the slides: the engine is a Figma-model renderer (its own text
layout on HarfBuzz, its own paints). Turning contract HTML/CSS into engine nodes would be a
re-implementation of CSS layout that drifts from the render — the fidelity rule forbids exactly
that. Why not a TS canvas: the engine already is the interaction model Burak wants ("seçim,
kılavuz ve denetçi Wecra ile aynı mantıkta çalışır"), tested and Figma-calibrated.

### Making the engine's canvas transparent (no engine change)

The engine clears its WebGL2 canvas opaque with the page colour (`Renderer.cpp`: clear alpha 1).
The editor's page is black and every layer node paints nothing, so after a frame each pixel is
an overlay composited over black, i.e. its premultiplied colour. `engine/alpha-pass.ts` runs right
after each engine render on the same context: alpha = the brightest channel (exact for the
engine's overlay colours, which all have a channel at full strength), and the engine's selection
blue becomes the app's accent (orange, as in the draft). All GL state it touches is restored (the
engine re-binds its own state at every pass start). Frame titles are not drawn by the engine
(frames are unnamed): the editor draws theme-aware titles itself. The engine runs on WebGL2 only
(`gfx: "webgl2"`), since the pass needs the GL context.

If WebGL2 or Wasm is unavailable the editor degrades: the slides still render, layers are picked
from the panel and edited from the inspector (`canvasState.engine === "unavailable"`).

## Engine source and version

`src/renderer/vendor/wecra-engine/` is a verbatim copy, read from DesignerV2's **git history**
(never its working tree): the committed Emscripten build (`engine.mjs` + `engine.wasm`,
wasm-release, emsdk 6.0.11), the C ABI wrapper `EngineExports.ts`, `abi.ts`, the JSON codec
types (`codec.ts`), the input helpers, Figma's cursor pictures and the bundled Inter (the
overlays' labels). `VERSION.json` records the commit, the last engine commit, the ABI version and
the SHA-256 of every file. A blank engine document (DOCUMENT + one page, kiwi-encoded with
DesignerV2's generated codec, since `engine_load` takes kiwi only) is generated alongside;
everything else goes in as JSON changes (`engine_apply_changes` takes either).

```sh
node apps/desktop/scripts/vendor-engine.mjs                # HEAD of ../DesignerV2
node apps/desktop/scripts/vendor-engine.mjs --ref <commit> # a given engine build
node apps/desktop/scripts/vendor-engine.mjs --check        # vendored files match VERSION.json
```

To move to a newer engine: build and commit it in DesignerV2 (`npm run engine:build`), re-run the
script, then `pnpm --filter @studio/desktop test` (the `engine` project drives the real Wasm
build headless in Node). The renderer's CSP allows `'wasm-unsafe-eval'` for it.

Our facade is `engine/studio-engine.ts` (the slice of DesignerV2's `Engine.ts` the editor needs:
lifecycle, event pump, frames, input, camera, selection, commands, safe areas, focus).

## The adapter: post ⇄ engine document

`model/scene.ts`:

| Studio | Engine |
|---|---|
| slide *i* (`width × height`) | top-level `FRAME` `7:i+1`, unnamed, no fill, side by side 120 px apart |
| layer (`data-layer`) | `ROUNDED_RECTANGLE` (a group: `FRAME`, children inside), no fills / strokes, `name` = `"slide:id"` |
| painted box (measured) | node `size` + `transform` (turn about the centre) relative to its parent |
| `data-hidden` | `visible: false` |
| editor lock (per post, this Mac) | `locked: true` |
| logo | `proportionsConstrained` |

Boxes come from the live slide documents (`html/measure.ts`: centre from the bounding box, size
from the layout box × the scales on the way to the artboard, angle the sum of the turns), and
before a frame has loaded from the version's measured layouts. Every change rebuilds the wanted
node set and sends only the difference (`diffScene`, applied as remote changes: not undoable, not
echoed). The engine's own edits come back as `DOCUMENT_CHANGED` and are classified
(`classifyChanges`): geometry, ⌥-drag duplicate, a drawn shape, delete, reorder, visibility,
lock; moving or resizing an artboard is undone.

`model/geometry.ts` turns a box the engine moved / resized / turned / scaled into the contract's
editor-owned CSS: `translate` (in the parent's frame), `rotate`, `scale` (the Scale tool, K) and
`width` / `height` (`resize` op; text keeps its automatic height unless dragged only vertically).
After the re-measure a reflowed layer's top-left corner is put back where the engine left it (a
correction merged into the same undo step), so resizing works for absolutely positioned layers and
flex/grid children alike. During a gesture the dragged layer is previewed in its frame with the
same CSS, so text reflows live.

## Edits, saving, undo

`model/draft.ts` (`DraftSession`) holds the working copy: every edit is a list of design-kit ops
applied with design-kit's own `applyPatch` (the worker's code), instant on the canvas (the frames
are morphed in place, not reloaded), with design-kit's inverses on the undo stack. Saving is the
existing flow: pending ops go out as **one `content.render` job** with `patches`
(`PostEditor.commitPatches`), the worker stores a `manual_edit` version and renders it; the editor
adopts it and re-applies anything edited meanwhile. It saves on its own after a 1.8 s pause (never
during a gesture or text editing), on ⌘S / "Sürüm kaydet" (with a name = the version note), and
before approve, schedule, a Sohbet message, switching versions and closing. A failed save keeps the
edits (an offline worker) with "Yeniden dene"; unsaved edits survive a closed window (localStorage,
per post and base version). Undo/redo are local and instant; the inverses go to the server as
edits. Approve still checks the hash recomputed from the shown version (unchanged code path).

## Features

- Canvas: all slides / focus, zoom ⌘+ ⌘− ⌘0 ⇧1 ⇧2, pinch, space-drag, trackpad pan,
  multi-select, marquee, handles (move / resize / rotate), smart guides, spacing, snapping
  (⌘; toggles), nudge (⇧ ×10), ⌥-drag copies, the scale tool (K), rectangle tool (R → a shape
  layer), text tool (T → a text layer, editing at once), image placement (⇧⌘K, uploads),
  in-place text editing (double click / ↩; ⌘↩ applies, Esc cancels) in the slide's own fonts,
  image crop (focal point by dragging; double click or Kırp), rulers (⇧R, in artboard px),
  safe areas (⌘′) with the platform's bands, labels and collision chips. Fitted slides keep
  clear of the layers list and the dock and follow the canvas's size until you pan or zoom.
- Layers: the floating list (above), select / shift-select, hover highlights on canvas, hide,
  lock, drag to reorder within a container.
- Edit panel: above. Stacking is ⌥⌘] / ⌥⌘[ (⌘[ / ⌘] are the app's back / forward).
- Sohbet: above.
- Versions popover (the title area's chip, ⇧⌘V): the list, show / restore, "Sürüm kaydet" with
  a name.
- Caption (Açıklama tab, ⌘E): platform tabs with limits, the feed's preview cut, hashtag chips
  with the platform's limit, save.
- Shortcuts: `model/shortcuts.ts` (the draft's table of 32 plus K and ⌘A).

## What the contract allows (and where the draft goes further)

Additive design-kit changes made for this editor (`packages/design-kit`, with tests):
`font-family` takes a quoted installed family (`"Futura", sans-serif`) besides `var(--font-*)`;
`filter` takes picture adjustments (brightness / contrast / saturate / grayscale / sepia / invert /
hue-rotate / blur, bounded); `NEUTRAL_BRAND_TOKENS` (the worker's neutral default, so the editor
builds the same brand.css; the worker keeps its own copy — they should be unified).

Not done (gaps):

- Adding, duplicating, deleting and reordering **slides** (F, ⇧⌘D): there is no patch op for
  slides; it needs `contents.versions.create` + a render, or a new op. The commands explain this.
- Grouping (⌘G), renaming layers (the contract's ids are stable semantic ids), copy / paste.
- First comment and per-slide alt text: the content model has no fields for them (the publishers
  support alt text); the fields are shown disabled.
- Hashtag suggestions, caption AI buttons, image generation from the canvas (routes to Sohbet).
- Stroke width / style and shadows: the contract's style allow-list has `border-color` and
  `filter` (blur) only; Kenarlık recolours an existing border, Efektler is the layer blur.
- The Sohbet sends text only (no image attachments from the dock); the conversation ↔ post link
  lives on this Mac (localStorage), not on the server; a conversation deleted elsewhere needs
  "Bu post için yeni sohbet".
- The workspace has no own back/forward inside the post (versions are the history).
- Moving a layer to another slide (a drag across artboards is kept on its slide).
- Dark overlay pixels lose opacity in the alpha pass (none of the editor's overlays use them);
  engine rulers are not used (they are dark and opaque) — the editor draws its own.
- The canvas and the in-layout workspace were checked headless (Chromium + SwiftShader WebGL2,
  `?demo=post-editor`, which now shows the app's top bar and right panel around it); the real
  look and feel in the app is for Burak to judge.

## Files

```
scripts/vendor-engine.mjs           vendor / check the engine
src/renderer/vendor/wecra-engine/   the vendored engine (do not edit)
features/post-detail/post-detail.tsx  the opened post: canvas workspace (or the reel detail)
features/post-detail/post-facts.ts    state line, approve / schedule rules, the post's menu
features/post-editor/
  workspace.tsx                     the post workspace (canvas, dock, portals into the shell)
  workspace-store.ts                mode per post, edit tab, layers list, post → conversation
  slots.tsx                         the shell's slots (title area, panel header, panel)
  chat.ts                           the post's Sohbet (conversation binding, message text)
  session.ts                        draft + canvas + toasts of one open post
  engine/studio-engine.ts           facade over the C ABI (events, frames, input, camera …)
  engine/alpha-pass.ts              transparent canvas + accent selection colour
  engine/canvas-host.ts             DOM input → engine (after Wecra's CanvasController)
  canvas/controller.ts              PostCanvas: frames + engine + adapter + edits
  canvas/reader.ts                  engine reads for the adapter
  html/slide-document.ts            slide srcdoc (brand.css inlined, URLs mapped), morphing
  html/measure.ts                   layer boxes from the live document
  model/document.ts                 slides × layers (design-kit parser), labels
  model/scene.ts                    post ⇄ engine document, change classification
  model/geometry.ts                 boxes, matrices, edits → design-kit ops
  model/draft.ts                    working copy, saves, undo / redo
  model/brand-kit.ts                brand.css / patch context as the worker builds them
  model/safe-areas.ts               presets, bands, collisions
  model/shortcuts.ts, style-values.ts
  ui/title-bar.tsx                  the top bar's title area, versions popover
  ui/mode-dock.tsx                  the dock: morph, mode switch, edit tools, message box
  ui/layers-dock.tsx                the floating layers list
  ui/edit-panel.tsx, ui/fields.tsx  the edit panel (Wecra's properties panel, Studio controls)
  ui/caption-panel.tsx              the Açıklama tab
  ui/chat-panel.tsx                 the Sohbet panel (the app's transcript in panel form)
  ui/canvas-view.tsx                canvas, chrome (titles, safe areas, crop, rulers)
  demo/                             `?demo=post-editor[&format=story]` (in-memory API and chat,
                                    inside a stand-in of the app's layout)
test/engine/adapter.test.ts         the real engine: round trip, drag + snapping, resize, ⌥-drag, turn, reorder
test/renderer/post-canvas-model.test.ts
test/renderer/post-workspace.test.tsx  open → canvas, back → board, mode memory, the dock's
                                    morph, panel switching, the Sohbet bound to the post
```
