// The post canvas: Wecra's engine for interaction and overlays, the slides' own HTML for what is
// drawn, and the adapter between the two.
//
//   frames  (bottom)  one sandboxed <iframe> per slide: the design-contract HTML as the worker
//                     renders it, placed on the page under the engine's camera
//   canvas  (middle)  the engine's WebGL2 canvas, made transparent by the alpha pass: selection,
//                     handles, size badges, smart guides, spacing, marquee, safe-area bands
//   chrome  (top)     React overlays (titles, safe-area labels, collision chips, toolbars)
//
// Data flow: draft (HTML) → frames (morphed in place) → measured boxes → engine scene (diffed).
// Engine edits (DOCUMENT_CHANGED) → scene edits → design-kit ops → draft → … again. While a
// gesture runs, the dragged layers are previewed in their frame with inline CSS.
import type { NodeChange } from "../../../vendor/wecra-engine/codec.ts";
import { AlphaPass } from "../engine/alpha-pass.ts";
import { CanvasHost, IS_MAC } from "../engine/canvas-host.ts";
import { type Camera, StudioEngine } from "../engine/studio-engine.ts";
import { documentReady, measureDocument } from "../html/measure.ts";
import { morphDocument, slideDocument } from "../html/slide-document.ts";
import type { RenderKit } from "../model/brand-kit.ts";
import {
  type EditorLayer,
  type EditorSlide,
  editorSlides,
  findLayer,
  layerKey,
  parseLayerKey,
  stackIndex,
} from "../model/document.ts";
import type { DraftSession, SlidePatchInput } from "../model/draft.ts";
import {
  aabb,
  type GeometryMode,
  geometryEdit,
  type MeasuredLayer,
  moveOps,
  type OBox,
  previewStyle,
  type Rect,
  rectBox,
  roundPx,
  topLeft,
} from "../model/geometry.ts";
import { collisions, type SafeAreaView } from "../model/safe-areas.ts";
import {
  classifyChanges,
  diffScene,
  type Guid,
  mergeApplied,
  type SceneEdit,
  SceneMap,
  type SceneReader,
  sceneNodes,
  slideRects,
} from "../model/scene.ts";
import { engineReader } from "./reader.ts";

export type CanvasTool = "MOVE" | "HAND" | "SCALE" | "RECTANGLE" | "TEXT";

export interface CanvasState {
  engine: "loading" | "ready" | "unavailable";
  engineError: string | null;
  /** Selected layer keys. */
  selection: string[];
  hover: string | null;
  tool: CanvasTool;
  /** Focus mode: only this slide is shown and picked. */
  focus: number | null;
  /** The slide the selection (or the last click) is on. */
  activeSlide: number;
  safeArea: boolean;
  snapping: boolean;
  rulers: boolean;
  editing: string | null;
  cropping: string | null;
  measures: (Record<string, MeasuredLayer> | null)[];
  locked: string[];
  /** Bumped when boxes change (the chrome re-reads them). */
  layoutRevision: number;
  /** A gesture is moving layers (the chrome hides what would lag behind). */
  dragging: boolean;
}

export interface ComputedLayerStyle {
  fontFamily: string;
  fontWeight: number;
  fontStyle: string;
  fontSize: number;
  /** Unitless (null: normal). */
  lineHeight: number | null;
  /** em */
  letterSpacing: number;
  textAlign: string;
  textTransform: string;
  color: string;
  backgroundColor: string;
  opacity: number;
  borderRadius: number;
  mixBlendMode: string;
  filter: string;
  objectFit: string | null;
  objectPosition: string | null;
  natural: { w: number; h: number } | null;
}

export interface CanvasView {
  camera: Camera;
  width: number;
  height: number;
}

export interface CanvasDeps {
  draft: DraftSession;
  kit(): RenderKit;
  /** Boxes the last render measured (until the live ones are in). */
  fallback(): readonly (
    | { id: string; x: number; y: number; w: number; h: number; visible: boolean }[]
    | null
    | undefined
  )[];
  safeArea(slide: number): SafeAreaView | null;
  notify(message: string, tone?: "error" | "notice"): void;
  /** Accent colour (CSS hex) the engine's selection is drawn in. */
  accent(): string;
  /** Edits are refused (an old version shown, a revision running …): the reason. */
  blocker(): string | null;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  storageKey?: string;
}

const GESTURE_NAMES: Record<string, string> = {
  Move: "Taşı",
  Resize: "Boyutlandır",
  Rotate: "Döndür",
  Scale: "Ölçekle",
  Nudge: "Kaydır",
  Duplicate: "Çoğalt",
  Delete: "Sil",
};

function gestureName(label: string, edits: readonly SceneEdit[]): string {
  if (edits.some((e) => e.kind === "duplicate")) return "Çoğalt";
  if (edits.some((e) => e.kind === "shape")) return "Şekil ekle";
  if (edits.some((e) => e.kind === "delete")) return "Sil";
  if (edits.some((e) => e.kind === "reorder")) return "Sırala";
  return GESTURE_NAMES[label] ?? (label.startsWith("Align") ? "Hizala" : "Düzenle");
}

/** Plain text of an element as the editor writes it (text nodes, `<br>` → `\n`). */
function plainText(node: Node): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) out += child.textContent ?? "";
    else if (child.nodeType === 1) {
      const tag = (child as Element).tagName.toLowerCase();
      if (tag === "br") out += "\n";
      else if (tag === "div" || tag === "p")
        out += (out && !out.endsWith("\n") ? "\n" : "") + plainText(child);
      else out += plainText(child);
    }
  }
  return out;
}

const INLINE = new Set([
  "SPAN",
  "BR",
  "STRONG",
  "EM",
  "B",
  "I",
  "U",
  "S",
  "SMALL",
  "SUP",
  "SUB",
  "MARK",
  "WBR",
]);

function hasInlineMarkup(el: Element): boolean {
  return Array.from(el.querySelectorAll("*")).some((e) => e.tagName !== "BR");
}

/** The element's inner HTML with what contenteditable adds turned back into contract markup. */
function editedHtml(el: Element): string | null {
  const clone = el.cloneNode(true) as Element;
  for (const div of Array.from(clone.querySelectorAll("div,p"))) {
    const br = clone.ownerDocument.createElement("br");
    div.before(br);
    div.replaceWith(...Array.from(div.childNodes));
  }
  for (const e of Array.from(clone.querySelectorAll("*"))) if (!INLINE.has(e.tagName)) return null;
  let html = clone.innerHTML.replace(/^(?:<br>)+/, "");
  html = html.replace(/<br>$/, "");
  return html;
}

export class PostCanvas {
  private state: CanvasState;
  private readonly listeners = new Set<() => void>();
  private readonly viewListeners = new Set<(view: CanvasView) => void>();
  private view: CanvasView = { camera: { x: 0, y: 0, zoom: 1 }, width: 0, height: 0 };

  private engine: StudioEngine | null = null;
  private host: CanvasHost | null = null;
  private pass: AlphaPass | null = null;
  private readonly map = new SceneMap();
  private readonly applied = new Map<Guid, NodeChange>();
  private slides: EditorSlide[] = [];
  private rects: Rect[] = [];
  private frames: HTMLIFrameElement[] = [];
  private framesLayer: HTMLDivElement | null = null;
  private framesWorld: HTMLDivElement | null = null;
  private srcdocs: string[] = [];
  private kitCss = "";
  private readonly cleanups: (() => void)[] = [];
  private revision = -1;
  private fitted = false;
  private previewed = new Set<number>();
  private releaseHold: (() => void) | null = null;
  /** Where layers must end up after an edit (top-left, artboard px): corrected after the re-measure. */
  private targets = new Map<string, { x: number; y: number }>();
  private textEdit: {
    key: string;
    el: HTMLElement;
    doc: Document;
    original: string;
    cleanup: () => void;
  } | null = null;
  private disposed = false;
  private mountToken = 0;

  constructor(private readonly deps: CanvasDeps) {
    const locked = this.readLocks();
    this.state = {
      engine: "loading",
      engineError: null,
      selection: [],
      hover: null,
      tool: "MOVE",
      focus: null,
      activeSlide: 0,
      safeArea: true,
      snapping: true,
      rulers: false,
      editing: null,
      cropping: null,
      measures: [],
      locked,
      layoutRevision: 0,
      dragging: false,
    };
  }

  // --- store ------------------------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CanvasState => this.state;

  onView(listener: (view: CanvasView) => void): () => void {
    this.viewListeners.add(listener);
    listener(this.view);
    return () => this.viewListeners.delete(listener);
  }

  getView(): CanvasView {
    return this.view;
  }

  private set(patch: Partial<CanvasState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get editorSlides(): EditorSlide[] {
    return this.slides;
  }

  get slideRects(): Rect[] {
    return this.rects;
  }

  // --- mounting ---------------------------------------------------------------------------------

  /** The brand kit (brand.css) changed: the frames load it. */
  refreshKit(): void {
    if (this.framesWorld) this.onDraft();
    this.updateSafeAreas();
  }

  async mount(canvas: HTMLCanvasElement, framesLayer: HTMLDivElement): Promise<void> {
    // (React's strict mode mounts twice: everything starts over.)
    const token = ++this.mountToken;
    this.disposed = false;
    this.applied.clear();
    this.fitted = false;
    this.revision = -1;
    this.kitCss = "";
    this.previewed.clear();
    this.set({ engine: "loading", engineError: null, measures: [] });
    this.framesLayer = framesLayer;
    const world = document.createElement("div");
    world.style.cssText =
      "position:absolute;left:0;top:0;transform-origin:0 0;will-change:transform";
    framesLayer.append(world);
    this.framesWorld = world;
    this.cleanups.push(() => world.remove());
    this.cleanups.push(this.deps.draft.subscribe(() => this.onDraft()));
    this.onDraft();
    try {
      // jsdom (unit tests) has neither WebGL nor a fetchable Wasm file.
      if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent))
        throw new Error("Bu ortamda WebGL yok.");
      const engine = await StudioEngine.create(canvas, { theme: "DARK" });
      if (this.disposed || token !== this.mountToken) {
        engine.destroy();
        return;
      }
      this.engine = engine;
      this.setupEngine(engine, canvas);
      this.set({ engine: "ready" });
    } catch (e) {
      if (token !== this.mountToken) return;
      // No WebGL2 / Wasm (a headless check, a broken GPU): the slides still show; layers are
      // picked from the panel and edited from the inspector.
      this.set({ engine: "unavailable", engineError: e instanceof Error ? e.message : String(e) });
      this.fitWithoutEngine();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.endTextEdit(false);
    for (const c of this.cleanups.splice(0)) c();
    this.host?.detach();
    this.host = null;
    this.pass?.dispose();
    this.pass = null;
    this.engine?.destroy();
    this.engine = null;
    for (const f of this.frames) f.remove();
    this.frames = [];
    this.srcdocs = [];
    this.releaseHold?.();
    this.releaseHold = null;
  }

  private setupEngine(engine: StudioEngine, canvas: HTMLCanvasElement): void {
    engine.loadBlank();
    engine.setViewOptions({ snapToObjects: this.state.snapping, rulers: false });
    engine.setNudge(1, 10);
    this.pass = AlphaPass.forCanvas(canvas);
    this.pass?.setAccent(this.deps.accent());
    engine.onRender = () => this.pass?.run();
    if (!this.pass) canvas.style.opacity = "0.999";
    this.host = new CanvasHost(canvas, engine, {
      pointerDown: (e, x, y, clicks) => this.onPointerDown(e, x, y, clicks),
      keyDown: (e) => this.onCanvasKey(e),
      pointerUp: () => this.onGestureEnd(),
      resized: (w, h) => {
        this.view = { ...this.view, width: w, height: h };
        this.emitView();
        if (!this.fitted && this.rects.length) this.fit();
      },
    });
    this.cleanups.push(this.host.attach());
    this.cleanups.push(
      engine.on("CAMERA_CHANGED", (e) => this.onCamera({ x: e.x, y: e.y, zoom: e.zoom })),
    );
    this.cleanups.push(engine.on("SELECTION_CHANGED", (e) => this.onSelection(e.refs)));
    this.cleanups.push(
      engine.on("HOVER_CHANGED", (e) => {
        const ref = (e as { ref?: string | null }).ref ?? null;
        const key = ref ? this.map.keyOf(ref) : null;
        if (key !== this.state.hover) this.set({ hover: key });
      }),
    );
    this.cleanups.push(
      engine.on("TOOL_CHANGED", (e) => {
        const tool = (e as { tool?: string }).tool;
        if (tool === "MOVE" || tool === "HAND" || tool === "SCALE" || tool === "RECTANGLE")
          this.set({ tool });
      }),
    );
    this.cleanups.push(
      engine.on("NODES_CHANGED", (e) => this.onNodesChanged(e.refs, e.fieldGroupMask)),
    );
    this.cleanups.push(
      engine.on("DOCUMENT_CHANGED", (e) => {
        const message = (e as { message?: { nodeChanges?: NodeChange[] } }).message;
        this.onDocumentChanged(message?.nodeChanges ?? [], e.label ?? "");
      }),
    );
    const camera = engine.getCamera();
    this.onCamera(camera);
    engine.setViewportInsets(0, 56, 0, 92);
    this.syncScene();
  }

  // --- slides → frames ----------------------------------------------------------------------------

  private onDraft(): void {
    const draft = this.deps.draft.getSnapshot();
    if (draft.revision === this.revision && this.kitCss === this.deps.kit().css) return;
    const kitChanged = this.kitCss !== this.deps.kit().css;
    this.kitCss = this.deps.kit().css;
    this.revision = draft.revision;
    this.slides = editorSlides(draft.slides);
    const sizes = this.slides.map((s) => ({ width: s.width, height: s.height }));
    const before = JSON.stringify(this.rects);
    this.rects = slideRects(sizes);
    const resized = before !== JSON.stringify(this.rects);
    const changed = new Set(kitChanged ? this.slides.map((_, i) => i) : draft.changedSlides);
    this.updateFrames(changed);
    if (this.state.measures.length !== this.slides.length) {
      this.set({ measures: this.slides.map((_, i) => this.state.measures[i] ?? null) });
    }
    // Keys that are gone leave the selection.
    const keys = new Set(this.slides.flatMap((s) => s.layers.map((l) => l.key)));
    const selection = this.state.selection.filter((k) => keys.has(k));
    if (selection.length !== this.state.selection.length) this.set({ selection });
    this.syncScene();
    if (resized && this.fitted) this.fit();
  }

  private updateFrames(changed: ReadonlySet<number>): void {
    const world = this.framesWorld;
    if (!world) return;
    const kit = this.deps.kit();
    this.slides.forEach((slide, i) => {
      const rect = this.rects[i];
      if (!rect) return;
      let frame = this.frames[i];
      const srcdoc = slideDocument(slide.html, kit);
      if (!frame) {
        frame = document.createElement("iframe");
        frame.setAttribute("sandbox", "allow-same-origin");
        frame.setAttribute("referrerpolicy", "no-referrer");
        frame.setAttribute("tabindex", "-1");
        frame.setAttribute("aria-hidden", "true");
        frame.dataset.slide = String(i);
        frame.style.cssText =
          "position:absolute;border:0;margin:0;padding:0;pointer-events:none;background:white;color-scheme:light";
        frame.addEventListener("load", () => void this.frameLoaded(i));
        world.append(frame);
        this.frames[i] = frame;
        this.srcdocs[i] = srcdoc;
        frame.srcdoc = srcdoc;
      } else if (changed.has(i) || this.srcdocs[i] !== srcdoc) {
        const doc = frame.contentDocument;
        this.srcdocs[i] = srcdoc;
        if (doc?.body && morphDocument(doc, srcdoc) === "morphed") {
          this.previewed.delete(i);
          this.measure(i);
        } else {
          frame.srcdoc = srcdoc;
        }
      }
      frame.style.left = `${rect.x}px`;
      frame.style.top = `${rect.y}px`;
      frame.style.width = `${slide.width}px`;
      frame.style.height = `${slide.height}px`;
      frame.style.visibility =
        this.state.focus === null || this.state.focus === i ? "visible" : "hidden";
    });
    for (const extra of this.frames.splice(this.slides.length)) extra.remove();
    this.srcdocs.length = this.slides.length;
  }

  private async frameLoaded(i: number): Promise<void> {
    const doc = this.frames[i]?.contentDocument;
    if (!doc) return;
    this.measure(i);
    await documentReady(doc);
    this.measure(i);
    // Late images (lazy decode) and fonts settle a box or two later.
    for (const img of Array.from(doc.images))
      if (!img.complete) img.addEventListener("load", () => this.measure(i), { once: true });
  }

  /** Re-measure one slide's layers and bring the engine's nodes to them. */
  measure(i: number): void {
    const doc = this.frames[i]?.contentDocument;
    if (!doc?.body) return;
    const measure = measureDocument(doc);
    const measures = [...this.state.measures];
    measures[i] = measure;
    this.set({ measures, layoutRevision: this.state.layoutRevision + 1 });
    this.correctTargets(i, measure);
    this.syncScene();
  }

  /** After a resize reflowed (text grew, a flex group re-laid out): put the corner back. */
  private correctTargets(i: number, measure: Record<string, MeasuredLayer>): void {
    if (this.targets.size === 0) return;
    const ops: SlidePatchInput[] = [];
    for (const [key, target] of this.targets) {
      const parsed = parseLayerKey(key);
      if (!parsed || parsed.slide !== i) continue;
      this.targets.delete(key);
      const layer = findLayer(this.slides, key);
      const m = measure[parsed.id];
      if (!layer || !m) continue;
      const at = topLeft(m.box);
      const dx = target.x - at.x;
      const dy = target.y - at.y;
      if (Math.abs(dx) < 0.6 && Math.abs(dy) < 0.6) continue;
      for (const op of moveOps(layer, m, dx, dy)) ops.push({ ...op, slide: i } as SlidePatchInput);
    }
    if (ops.length) this.deps.draft.apply(ops, "Düzenle", { merge: true });
  }

  // --- the engine scene ---------------------------------------------------------------------------

  private syncScene(): void {
    const engine = this.engine;
    if (!engine || this.host?.pressed) return;
    const next = sceneNodes(
      {
        slides: this.slides,
        measures: this.state.measures,
        fallback: this.deps.fallback(),
        locked: new Set(this.state.locked),
        rects: this.rects,
      },
      this.map,
    );
    const changes = diffScene(this.applied, next);
    if (changes.length === 0) return;
    engine.applyChanges(changes, "remote");
    mergeApplied(this.applied, changes);
    this.updateSafeAreas();
    if (!this.fitted && this.view.width > 0) this.fit();
  }

  updateSafeAreas(): void {
    const engine = this.engine;
    if (!engine) return;
    if (!this.state.safeArea) {
      engine.setSafeAreas([]);
      return;
    }
    const areas = this.slides.flatMap((_, i) => {
      const view = this.deps.safeArea(i);
      if (!view) return [];
      return [
        {
          id: this.map.frameGuid(i),
          insets: view.insets,
          // Platform UI bands (stories, reels) stronger than a feed's margin.
          color: { r: 1, g: 0.3, b: 0.25, a: view.bands.length ? 0.16 : 0.07 },
        },
      ];
    });
    engine.setSafeAreas(areas);
  }

  private reader(): SceneReader {
    return engineReader(this.engine as StudioEngine, this.map, () => this.rects);
  }

  // --- engine events --------------------------------------------------------------------------------

  private onCamera(camera: Camera): void {
    this.view = { ...this.view, camera };
    if (this.framesWorld) {
      this.framesWorld.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})`;
    }
    this.emitView();
  }

  private emitView(): void {
    for (const l of this.viewListeners) l(this.view);
  }

  private onSelection(refs: readonly string[]): void {
    const keys = refs.map((r) => this.map.keyOf(r)).filter((k): k is string => k !== null);
    const slide = keys[0]
      ? (parseLayerKey(keys[0])?.slide ?? this.state.activeSlide)
      : this.state.activeSlide;
    if (keys.join("|") !== this.state.selection.join("|") || slide !== this.state.activeSlide)
      this.set({ selection: keys, activeSlide: slide });
  }

  private onNodesChanged(refs: readonly string[], masks: readonly number[]): void {
    if (!this.host?.pressed || !this.engine) return;
    if (!this.releaseHold) this.releaseHold = this.deps.draft.hold();
    if (!this.state.dragging) this.set({ dragging: true });
    const reader = this.reader();
    refs.forEach((ref, i) => {
      if (((masks[i] ?? 0) & 1) === 0) return; // GEOMETRY
      const key = this.map.keyOf(ref);
      if (!key) return;
      const parsed = parseLayerKey(key);
      const layer = findLayer(this.slides, key);
      const before = parsed ? this.state.measures[parsed.slide]?.[parsed.id] : undefined;
      if (!parsed || !layer || !before) return;
      const box = reader.boxInSlide(ref, parsed.slide);
      if (!box) return;
      const { ops } = geometryEdit(layer, before, box, this.mode());
      const el = this.element(parsed.slide, parsed.id);
      if (!el) return;
      const css = previewStyle(ops);
      for (const [prop, value] of Object.entries(css)) {
        if (value === null) el.style.removeProperty(prop);
        else el.style.setProperty(prop, value);
      }
      this.previewed.add(parsed.slide);
    });
  }

  private onGestureEnd(): void {
    // A gesture that ended without a change (Esc, a click): the preview goes back to the HTML.
    setTimeout(() => {
      for (const i of [...this.previewed]) this.restoreFrame(i);
      this.previewed.clear();
      this.releaseHold?.();
      this.releaseHold = null;
      if (this.state.dragging) this.set({ dragging: false });
      this.syncScene();
    }, 0);
  }

  private restoreFrame(i: number): void {
    const doc = this.frames[i]?.contentDocument;
    const srcdoc = this.srcdocs[i];
    if (doc?.body && srcdoc) morphDocument(doc, srcdoc);
  }

  private mode(): GeometryMode {
    return this.state.tool === "SCALE" ? "scale" : "resize";
  }

  private onDocumentChanged(changes: readonly NodeChange[], label: string): void {
    const engine = this.engine;
    if (!engine) return;
    const before = new Map(this.applied);
    mergeApplied(this.applied, changes);
    const edits = classifyChanges(changes, this.map, before, this.reader());
    const blocker = this.deps.blocker();
    if (blocker && edits.length) {
      this.deps.notify(blocker, "error");
      this.resync();
      return;
    }
    const ops: SlidePatchInput[] = [];
    let select: string[] | null = null;
    const pendingDuplicates: { slide: number }[] = [];
    for (const edit of edits) {
      switch (edit.kind) {
        case "geometry": {
          const parsed = parseLayerKey(edit.key);
          const layer = findLayer(this.slides, edit.key);
          const m = parsed ? this.state.measures[parsed.slide]?.[parsed.id] : undefined;
          if (!parsed || !layer || !m) break;
          const g = geometryEdit(layer, m, edit.box, this.mode());
          for (const op of g.ops) ops.push({ ...op, slide: parsed.slide } as SlidePatchInput);
          if (g.ops.some((op) => op.op === "resize")) this.targets.set(edit.key, g.target);
          break;
        }
        case "duplicate": {
          const parsed = parseLayerKey(edit.sourceKey);
          const layer = findLayer(this.slides, edit.sourceKey);
          const m = parsed ? this.state.measures[parsed.slide]?.[parsed.id] : undefined;
          if (!parsed || !layer || !m) break;
          const k = m.inherited.scale || 1;
          ops.push({
            op: "duplicateLayer",
            layer: parsed.id,
            offset: {
              x: roundPx((edit.box.cx - m.box.cx) / k),
              y: roundPx((edit.box.cy - m.box.cy) / k),
            },
            slide: parsed.slide,
          } as SlidePatchInput);
          pendingDuplicates.push({ slide: parsed.slide });
          break;
        }
        case "shape": {
          const slide = this.slides[edit.slide];
          if (!slide) break;
          const r = aabb(edit.box);
          const id = this.uniqueId(slide, "shape");
          ops.push({
            op: "insertLayer",
            parent: null,
            index: slide.roots.length,
            html: `<div data-layer="${id}" data-type="shape" style="position: absolute; left: ${roundPx(r.x)}px; top: ${roundPx(r.y)}px; width: ${roundPx(r.w)}px; height: ${roundPx(r.h)}px; background-color: var(--color-${this.deps.kit().tokens.usage?.accent ?? "accent"})"></div>`,
            leading: "\n    ",
            slide: edit.slide,
          } as SlidePatchInput);
          select = [layerKey(edit.slide, id)];
          break;
        }
        case "delete": {
          const parsed = parseLayerKey(edit.key);
          if (parsed)
            ops.push({
              op: "deleteLayer",
              layer: parsed.id,
              slide: parsed.slide,
            } as SlidePatchInput);
          break;
        }
        case "reorder": {
          const parsed = parseLayerKey(edit.key);
          if (parsed)
            ops.push({
              op: "moveLayer",
              layer: parsed.id,
              index: edit.index,
              slide: parsed.slide,
            } as SlidePatchInput);
          break;
        }
        case "visibility": {
          const parsed = parseLayerKey(edit.key);
          if (parsed)
            ops.push({
              op: "setVisibility",
              layer: parsed.id,
              hidden: edit.hidden,
              slide: parsed.slide,
            } as SlidePatchInput);
          break;
        }
        case "lock":
          this.setLocked(edit.key, edit.locked);
          break;
        case "frame":
          break;
      }
    }
    if (ops.length === 0) {
      this.resync();
      return;
    }
    const draft = this.deps.draft;
    if (!draft.apply(ops, gestureName(label, edits))) {
      this.deps.notify(draft.lastError ?? "Bu değişiklik uygulanamadı.", "error");
      this.resync();
      return;
    }
    if (pendingDuplicates.length) {
      // The copies' ids come back as the inverses (deleteLayer of the copy).
      const last = draft.getSnapshot().undo.at(-1);
      select = (last?.inverses ?? [])
        .filter((op) => op.op === "deleteLayer")
        .map((op) => layerKey(op.slide, (op as { layer: string }).layer));
    }
    if (select) this.selectLayers(select);
  }

  /** The engine back to the HTML's state (an edit was refused or meant nothing to the post). */
  private resync(): void {
    for (const i of [...this.previewed]) this.restoreFrame(i);
    this.previewed.clear();
    setTimeout(() => this.syncScene(), 0);
  }

  private uniqueId(slide: EditorSlide, base: string): string {
    const taken = new Set(slide.layers.map((l) => l.id));
    for (let n = 1; ; n++) {
      const id = `${base}-${n}`;
      if (!taken.has(id)) return id;
    }
  }

  private element(slide: number, id: string): HTMLElement | null {
    const doc = this.frames[slide]?.contentDocument;
    return (doc?.querySelector(`[data-layer="${CSS.escape(id)}"]`) as HTMLElement | null) ?? null;
  }

  // --- input ------------------------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent, x: number, y: number, clicks: number): boolean {
    if (this.textEdit) {
      this.endTextEdit(true);
      return true;
    }
    if (this.state.cropping) {
      this.set({ cropping: null });
    }
    const engine = this.engine;
    if (!engine) return false;
    if (this.state.tool === "TEXT" && e.button === 0) {
      this.placeText(x, y);
      return true;
    }
    if (clicks === 2 && e.button === 0) {
      const hit = engine
        .hitTest(x, y)
        .map((g) => this.map.keyOf(g))
        .find((k): k is string => k !== null);
      const selected = this.state.selection.length === 1 ? this.state.selection[0] : null;
      const key = selected && hit === selected ? selected : null;
      const layer = key ? findLayer(this.slides, key) : null;
      if (layer?.type === "text") {
        this.startTextEdit(layer.key);
        return true;
      }
      if (
        layer &&
        (layer.type === "image" || (layer.type === "slot" && layer.slotState === "filled"))
      ) {
        this.set({ cropping: layer.key });
        return true;
      }
    }
    // Titles above the artboards select their slide.
    const world = this.toWorld(x, y);
    const titleSlide = this.rects.findIndex(
      (r) =>
        world.x >= r.x &&
        world.x <= r.x + r.w &&
        world.y < r.y &&
        world.y > r.y - 24 / this.view.camera.zoom,
    );
    if (titleSlide >= 0) {
      this.selectSlide(titleSlide);
      return true;
    }
    return false;
  }

  /** The editor's own keys on the canvas (the workspace handles the rest of the table). */
  private onCanvasKey(e: KeyboardEvent): boolean {
    const meta = IS_MAC ? e.metaKey : e.ctrlKey;
    if (e.code === "Escape" && this.state.cropping) {
      this.set({ cropping: null });
      return true;
    }
    // Arrows nudge a selection (the engine's, with snapping-free 1 / 10 px steps); without one,
    // ← → turn the slides (the workspace's table).
    if (e.code.startsWith("Arrow") && !meta) {
      if (this.state.selection.length > 0) return false;
      return this.keyHandler?.(e) ?? false;
    }
    return this.keyHandler?.(e) ?? false;
  }

  /** The workspace's shortcut table, run for keys pressed on the canvas. */
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;

  focusCanvas(): void {
    this.engine?.canvas?.focus({ preventScroll: true });
  }

  toWorld(x: number, y: number): { x: number; y: number } {
    const c = this.view.camera;
    return { x: (x - c.x) / c.zoom, y: (y - c.y) / c.zoom };
  }

  toScreen(x: number, y: number): { x: number; y: number } {
    const c = this.view.camera;
    return { x: x * c.zoom + c.x, y: y * c.zoom + c.y };
  }

  // --- commands from the workspace ------------------------------------------------------------------------

  selectLayers(keys: readonly string[]): void {
    const engine = this.engine;
    const known = keys.filter((k) => this.map.has(k));
    if (engine) {
      engine.setSelection(known.map((k) => this.map.guidOf(k)));
    }
    const slide = keys[0]
      ? (parseLayerKey(keys[0])?.slide ?? this.state.activeSlide)
      : this.state.activeSlide;
    this.set({ selection: [...keys], activeSlide: slide });
  }

  selectSlide(index: number, options: { zoom?: boolean } = {}): void {
    if (index < 0 || index >= this.slides.length) return;
    this.engine?.setSelection([]);
    this.set({ selection: [], activeSlide: index });
    if (options.zoom || this.state.focus !== null) this.zoomToSlide(index);
    else this.revealSlide(index);
  }

  hoverLayer(key: string | null): void {
    this.engine?.setHover(key && this.map.has(key) ? [this.map.guidOf(key)] : []);
  }

  setTool(tool: CanvasTool): void {
    const engine = this.engine;
    if (tool === "TEXT") {
      engine?.setTool("MOVE");
      this.set({ tool });
      return;
    }
    engine?.setTool(tool);
    this.set({ tool });
  }

  command(
    name:
      | "ZOOM_IN"
      | "ZOOM_OUT"
      | "ZOOM_TO_100"
      | "ZOOM_TO_FIT"
      | "ZOOM_TO_SELECTION"
      | "SELECT_ALL"
      | "SELECT_NONE",
  ): void {
    if (name === "ZOOM_TO_FIT") {
      this.fit();
      return;
    }
    this.engine?.command(name);
  }

  /** Every artboard (or the focused one) in view. */
  fit(): void {
    if (this.state.focus !== null) {
      this.zoomToSlide(this.state.focus);
      return;
    }
    const engine = this.engine;
    if (!engine || this.rects.length === 0 || this.view.width <= 0) return;
    const last = this.rects[this.rects.length - 1] as Rect;
    this.zoomToRect({ x: 0, y: 0, w: last.x + last.w, h: Math.max(...this.rects.map((r) => r.h)) });
    this.fitted = true;
  }

  zoomToSlide(index: number): void {
    const r = this.rects[index];
    if (r) this.zoomToRect(r);
  }

  private zoomToRect(r: Rect): void {
    const engine = this.engine;
    if (!engine) return;
    const top = 56 + 28;
    const bottom = 92 + 16;
    const side = 40;
    const w = Math.max(1, this.view.width - side * 2);
    const h = Math.max(1, this.view.height - top - bottom);
    const zoom = Math.min(w / r.w, h / r.h, 4);
    engine.setCamera({
      x: side + (w - r.w * zoom) / 2 - r.x * zoom,
      y: top + (h - r.h * zoom) / 2 - r.y * zoom,
      zoom,
    });
  }

  /** Pans (no zoom change) so a slide is in view. */
  private revealSlide(index: number): void {
    const r = this.rects[index];
    const engine = this.engine;
    if (!r || !engine) return;
    const c = this.view.camera;
    const left = r.x * c.zoom + c.x;
    const right = (r.x + r.w) * c.zoom + c.x;
    if (left >= 0 && right <= this.view.width) return;
    engine.setCamera({ ...c, x: this.view.width / 2 - (r.x + r.w / 2) * c.zoom });
  }

  private fitWithoutEngine(): void {
    // Without the engine the frames still need a camera: fit them by hand.
    const world = this.framesWorld;
    const layer = this.framesLayer;
    if (!world || !layer || this.rects.length === 0) return;
    const box = layer.getBoundingClientRect();
    const last = this.rects[this.rects.length - 1] as Rect;
    const total = { w: last.x + last.w, h: Math.max(...this.rects.map((r) => r.h)) };
    const zoom = Math.min((box.width - 80) / total.w, (box.height - 200) / total.h, 1);
    this.onCamera({ x: (box.width - total.w * zoom) / 2, y: 84, zoom: Math.max(0.05, zoom) });
    this.view = { ...this.view, width: box.width, height: box.height };
  }

  setFocus(index: number | null): void {
    this.set({ focus: index });
    const engine = this.engine;
    engine?.setFocus(index === null ? null : this.map.frameGuid(index));
    this.frames.forEach((f, i) => {
      f.style.visibility = index === null || index === i ? "visible" : "hidden";
    });
    if (index !== null) this.zoomToSlide(index);
    else this.fit();
  }

  setSafeArea(on: boolean): void {
    this.set({ safeArea: on });
    this.updateSafeAreas();
  }

  setSnapping(on: boolean): void {
    this.set({ snapping: on });
    this.engine?.setViewOptions({ snapToObjects: on, rulers: false });
  }

  setRulers(on: boolean): void {
    this.set({ rulers: on });
  }

  setAccent(hex: string): void {
    this.pass?.setAccent(hex);
    this.engine?.schedule();
  }

  /** Locks are the editor's own (the design contract has none): kept per post on this Mac. */
  setLocked(key: string, locked: boolean): void {
    const set = new Set(this.state.locked);
    if (locked) set.add(key);
    else set.delete(key);
    this.set({ locked: [...set] });
    this.writeLocks();
    this.syncScene();
  }

  private readLocks(): string[] {
    const { storage, storageKey } = this.deps;
    if (!storage || !storageKey) return [];
    try {
      const v = JSON.parse(storage.getItem(`${storageKey}.locks`) ?? "[]");
      return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
    } catch {
      return [];
    }
  }

  private writeLocks(): void {
    const { storage, storageKey } = this.deps;
    if (!storage || !storageKey) return;
    try {
      storage.setItem(`${storageKey}.locks`, JSON.stringify(this.state.locked));
    } catch {
      // not kept
    }
  }

  /** Moves layers by artboard px (the inspector's X / Y, "move into the safe area"). */
  moveBy(keys: readonly string[], dx: number, dy: number, name = "Taşı"): boolean {
    const ops: SlidePatchInput[] = [];
    for (const key of keys) {
      const parsed = parseLayerKey(key);
      const layer = findLayer(this.slides, key);
      const m = parsed ? this.state.measures[parsed.slide]?.[parsed.id] : undefined;
      if (!parsed || !layer || !m) continue;
      for (const op of moveOps(layer, m, dx, dy))
        ops.push({ ...op, slide: parsed.slide } as SlidePatchInput);
    }
    return this.applyOps(ops, name);
  }

  /** Sets a layer's painted box (the inspector's W / H / rotation). */
  setBox(key: string, box: Partial<OBox>, name = "Konum ve boyut"): boolean {
    const parsed = parseLayerKey(key);
    const layer = findLayer(this.slides, key);
    const m = parsed ? this.state.measures[parsed.slide]?.[parsed.id] : undefined;
    if (!parsed || !layer || !m) return false;
    const after = { ...m.box, ...box };
    const g = geometryEdit(layer, m, after, "resize");
    if (g.ops.some((op) => op.op === "resize")) this.targets.set(key, g.target);
    return this.applyOps(
      g.ops.map((op) => ({ ...op, slide: parsed.slide }) as SlidePatchInput),
      name,
    );
  }

  applyOps(
    ops: readonly SlidePatchInput[],
    name: string,
    options: { merge?: boolean } = {},
  ): boolean {
    if (ops.length === 0) return true;
    const blocker = this.deps.blocker();
    if (blocker) {
      this.deps.notify(blocker, "error");
      return false;
    }
    if (!this.deps.draft.apply(ops, name, options)) {
      this.deps.notify(this.deps.draft.lastError ?? "Bu değişiklik uygulanamadı.", "error");
      return false;
    }
    return true;
  }

  /** Collision warnings of a slide under its safe area. */
  collisionsOf(slide: number) {
    const s = this.slides[slide];
    const view = this.deps.safeArea(slide);
    if (!s || !view) return [];
    return collisions(s.layers, this.state.measures[slide] ?? null, s, view);
  }

  measureOf(key: string): MeasuredLayer | null {
    const parsed = parseLayerKey(key);
    if (!parsed) return null;
    const live = this.state.measures[parsed.slide]?.[parsed.id];
    if (live) return live;
    const f = this.deps.fallback()[parsed.slide]?.find((b) => b.id === parsed.id);
    return f
      ? {
          box: rectBox(f),
          layout: { w: f.w, h: f.h },
          inherited: { angle: 0, scale: 1 },
          visible: f.visible,
        }
      : null;
  }

  // --- text ----------------------------------------------------------------------------------------------

  private placeText(x: number, y: number): void {
    const world = this.toWorld(x, y);
    const slide = this.rects.findIndex(
      (r) => world.x >= r.x && world.x <= r.x + r.w && world.y >= r.y && world.y <= r.y + r.h,
    );
    this.set({ tool: "MOVE" });
    this.engine?.setTool("MOVE");
    if (slide < 0) return;
    const s = this.slides[slide] as EditorSlide;
    const r = this.rects[slide] as Rect;
    const id = this.uniqueId(s, "text");
    const left = roundPx(world.x - r.x);
    const top = roundPx(world.y - r.y);
    const width = roundPx(Math.max(200, Math.min(s.width - left - 64, 720)));
    const ok = this.applyOps(
      [
        {
          op: "insertLayer",
          parent: null,
          index: s.roots.length,
          html: `<p data-layer="${id}" data-type="text" data-role="body" class="ts-body" style="position: absolute; left: ${left}px; top: ${top}px; width: ${width}px; margin: 0">Metin</p>`,
          leading: "\n    ",
          slide,
        } as SlidePatchInput,
      ],
      "Metin ekle",
    );
    if (ok) {
      const key = layerKey(slide, id);
      setTimeout(() => {
        this.selectLayers([key]);
        this.startTextEdit(key, true);
      }, 0);
    }
  }

  /** In-place text editing in the slide's own document (its fonts, its line breaks). */
  startTextEdit(key: string, selectAll = true): void {
    const parsed = parseLayerKey(key);
    const layer = findLayer(this.slides, key);
    if (!parsed || layer?.type !== "text") return;
    const blocker = this.deps.blocker();
    if (blocker) {
      this.deps.notify(blocker, "error");
      return;
    }
    this.endTextEdit(true);
    const frame = this.frames[parsed.slide];
    const doc = frame?.contentDocument;
    const el = this.element(parsed.slide, parsed.id);
    if (!frame || !doc || !el) return;
    const release = this.deps.draft.hold();
    const original = el.innerHTML;
    el.setAttribute("contenteditable", "true");
    el.spellcheck = false;
    frame.style.pointerEvents = "auto";
    const canvas = this.engine?.canvas;
    if (canvas) canvas.style.pointerEvents = "none";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.endTextEdit(false);
      } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        this.endTextEdit(true);
      } else if (e.key === "Enter") {
        e.preventDefault();
        doc.execCommand("insertLineBreak");
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      doc.execCommand("insertText", false, text.replace(/\r\n?/g, "\n"));
    };
    const onInput = () => this.measure(parsed.slide);
    const onDown = (e: Event) => {
      if (!el.contains(e.target as Node)) this.endTextEdit(true);
    };
    const onParentDown = (e: Event) => {
      if (e.target !== frame) this.endTextEdit(true);
    };
    el.addEventListener("keydown", onKey);
    el.addEventListener("paste", onPaste);
    el.addEventListener("input", onInput);
    doc.addEventListener("pointerdown", onDown, true);
    this.framesLayer?.addEventListener("pointerdown", onParentDown, true);
    this.textEdit = {
      key,
      el,
      doc,
      original,
      cleanup: () => {
        el.removeEventListener("keydown", onKey);
        el.removeEventListener("paste", onPaste);
        el.removeEventListener("input", onInput);
        doc.removeEventListener("pointerdown", onDown, true);
        this.framesLayer?.removeEventListener("pointerdown", onParentDown, true);
        el.removeAttribute("contenteditable");
        frame.style.pointerEvents = "none";
        if (canvas) canvas.style.pointerEvents = "";
        release();
      },
    };
    this.set({ editing: key });
    frame.focus();
    el.focus();
    const range = doc.createRange();
    range.selectNodeContents(el);
    if (!selectAll) range.collapse(false);
    const sel = doc.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  /** Ends text editing: `commit` writes the text (setText), else the original comes back. */
  endTextEdit(commit: boolean): void {
    const edit = this.textEdit;
    if (!edit) return;
    this.textEdit = null;
    const { el, original, key } = edit;
    const changed = el.innerHTML !== original;
    const html = changed ? editedHtml(el) : null;
    const text = plainText(el).replace(/ /g, " ");
    const rich = hasInlineMarkup(el);
    edit.cleanup();
    this.set({ editing: null });
    this.focusCanvas();
    const parsed = parseLayerKey(key);
    if (!parsed) return;
    if (!commit || !changed) {
      if (changed) el.innerHTML = original;
      this.measure(parsed.slide);
      return;
    }
    const op =
      rich && html !== null
        ? { op: "setText", layer: parsed.id, html }
        : { op: "setText", layer: parsed.id, text };
    if (
      !this.deps.draft.apply([{ ...op, slide: parsed.slide } as SlidePatchInput], "Metni değiştir")
    ) {
      // Markup design-kit refused (pasted structure): plain text instead.
      if (
        !this.applyOps(
          [{ op: "setText", layer: parsed.id, text, slide: parsed.slide } as SlidePatchInput],
          "Metni değiştir",
        )
      ) {
        el.innerHTML = original;
        this.measure(parsed.slide);
      }
    }
  }

  startCrop(key: string): void {
    this.endTextEdit(true);
    this.set({ cropping: key });
  }

  endCrop(): void {
    if (this.state.cropping) this.set({ cropping: null });
  }

  /** Crop: the image's focal point (object-position), live while dragging. */
  previewCrop(key: string, position: { x: number; y: number }): void {
    const parsed = parseLayerKey(key);
    const layer = findLayer(this.slides, key);
    if (!parsed || !layer) return;
    let el = this.element(parsed.slide, parsed.id);
    if (layer.type === "slot") el = el?.querySelector("img[data-slot-image]") ?? null;
    if (!el) return;
    el.style.objectPosition = `${position.x}% ${position.y}%`;
    if (!el.style.objectFit && layer.type === "image") el.style.objectFit = "cover";
  }

  commitCrop(key: string, position: { x: number; y: number }): void {
    const parsed = parseLayerKey(key);
    if (!parsed) return;
    const x = `${Math.round(position.x)}%`;
    const y = `${Math.round(position.y)}%`;
    this.applyOps(
      [
        {
          op: "setImageFit",
          layer: parsed.id,
          fit: "cover",
          position: { x, y },
          slide: parsed.slide,
        } as SlidePatchInput,
      ],
      "Kırp",
    );
  }

  /** The natural size of a layer's picture (crop overlay). */
  imageSize(key: string): { w: number; h: number } | null {
    const parsed = parseLayerKey(key);
    const layer = findLayer(this.slides, key);
    if (!parsed || !layer) return null;
    let el = this.element(parsed.slide, parsed.id) as HTMLImageElement | null;
    if (layer.type === "slot")
      el = (el?.querySelector("img[data-slot-image]") as HTMLImageElement | null) ?? null;
    if (!el?.naturalWidth) return null;
    return { w: el.naturalWidth, h: el.naturalHeight };
  }

  /** Layer order helpers for ⌘] / ⌘[. */
  restack(key: string, delta: number): boolean {
    const parsed = parseLayerKey(key);
    const slide = parsed ? this.slides[parsed.slide] : undefined;
    if (!parsed || !slide) return false;
    const { index, count } = stackIndex(slide, parsed.id);
    const next = Math.max(0, Math.min(count - 1, index + delta));
    if (index < 0 || next === index) return false;
    return this.applyOps(
      [{ op: "moveLayer", layer: parsed.id, index: next, slide: parsed.slide } as SlidePatchInput],
      delta > 0 ? "Öne getir" : "Arkaya gönder",
    );
  }

  layer(key: string): EditorLayer | null {
    return findLayer(this.slides, key);
  }

  /** What the slide's layout resolved for a layer (the inspector shows it). */
  computed(key: string): ComputedLayerStyle | null {
    const parsed = parseLayerKey(key);
    const layer = findLayer(this.slides, key);
    if (!parsed || !layer) return null;
    const el = this.element(parsed.slide, parsed.id);
    const view = el?.ownerDocument.defaultView;
    if (!el || !view) return null;
    const cs = view.getComputedStyle(el);
    const img =
      layer.type === "slot"
        ? el.querySelector("img[data-slot-image]")
        : layer.type === "image"
          ? el
          : null;
    const ics = img ? view.getComputedStyle(img) : null;
    const px = (v: string) => Number.parseFloat(v) || 0;
    const fontSize = px(cs.fontSize);
    return {
      fontFamily: cs.fontFamily,
      fontWeight: Number(cs.fontWeight) || 400,
      fontStyle: cs.fontStyle,
      fontSize,
      lineHeight:
        cs.lineHeight === "normal" ? null : fontSize ? px(cs.lineHeight) / fontSize : null,
      letterSpacing:
        cs.letterSpacing === "normal" ? 0 : fontSize ? px(cs.letterSpacing) / fontSize : 0,
      textAlign: cs.textAlign,
      textTransform: cs.textTransform,
      color: cs.color,
      backgroundColor: cs.backgroundColor,
      opacity: Number(cs.opacity),
      borderRadius: px(cs.borderTopLeftRadius),
      mixBlendMode: cs.mixBlendMode,
      filter: (ics ?? cs).filter,
      objectFit: ics?.objectFit ?? null,
      objectPosition: ics?.objectPosition ?? null,
      natural:
        img instanceof view.HTMLImageElement ? { w: img.naturalWidth, h: img.naturalHeight } : null,
    };
  }

  /** Live preview of inline CSS on a layer (sliders), until the next edit morphs it back. */
  previewCss(key: string, css: Record<string, string>, onImage = false): void {
    const parsed = parseLayerKey(key);
    const layer = findLayer(this.slides, key);
    if (!parsed || !layer) return;
    let el = this.element(parsed.slide, parsed.id);
    if (onImage && layer.type === "slot") el = el?.querySelector("img[data-slot-image]") ?? null;
    if (!el) return;
    for (const [prop, value] of Object.entries(css)) el.style.setProperty(prop, value);
    this.previewed.add(parsed.slide);
  }

  /** Debug and tests: the engine's stats (null without an engine). */
  stats(): Record<string, unknown> | null {
    return this.engine?.stats() ?? null;
  }
}
