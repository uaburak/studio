// The open post's Wecra document: where it comes from, when it changed, how it is saved.
//
// Open (a version shown on the canvas):
//   - the version has an editor document (saved from the canvas before) → that bundle;
//   - otherwise its HTML slides are imported once into a blank document (import.ts) as soon as
//     the editor is up — a post the AI made or revised opens as Wecra layers.
// Save (⌘S, after a pause, before approve / schedule / a chat message / leaving):
//   each slide frame is exported to PNG by Wecra's engine (its exporter, 1x, sRGB) and the
//   document is bundled (bundle.ts); both are uploaded as the brand's assets and a new
//   `manual_edit` version is created whose slides are those renders (`canvasSlideHtml`: the
//   render as the slide's one image layer, its SHA-256 in the HTML, so the content hash — what
//   approval is bound to — covers the pixels) with the bundle as its `editorDocument`. The
//   renders are the version's rendered assets: previews, checks and publishing use them as they
//   use the worker's renders. A `content.check` job (no model pass) checks the new version.
import {
  type ApiClient,
  type ContentType,
  type ContentVersion,
  MAX_ARTBOARD_PX,
  SLIDE_LIMITS,
  WECRA_DOCUMENT_MIME,
} from "@studio/contract";
import type { EditorController } from "@/editor/controller";
import { type MemoryDocumentSource, memoryDocumentSource } from "@/editor/documentSource";
import { convertPixels } from "@/editor/exportCore";
import { encodePixels, pageFrames, renderExport } from "@/editor/exporting";
import { EMPTY_DOCUMENT } from "@/editor/fixtures";
import type { ExportOutput, Message } from "@/engine/codec";
import type { RenderKit } from "../model/brand-kit.ts";
import {
  BUNDLE_FORMAT,
  BundleImages,
  type BundleSlide,
  decodeBundle,
  encodeBundle,
} from "./bundle.ts";
import { type CapturedSlide, captureSlides, importSlides, type SlideSource } from "./import.ts";
import { canvasSlideHtml, sha256Hex } from "./slide-html.ts";

export type WecraPhase = "loading" | "importing" | "ready" | "error";

export interface WecraSessionState {
  phase: WecraPhase;
  error: string | null;
  /** The version the open document is of. */
  version: number | null;
  /** A saved canvas document, or an import of the version's HTML. */
  origin: "document" | "import" | null;
  /** Edits since the document was opened or saved. */
  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  lastSavedAt: number | null;
  /** What the import could not carry over (pictures that did not load). */
  warnings: string[];
  /** Wecra's editor on the open document, once it is up. */
  editor: EditorController | null;
}

export interface WecraSessionDeps {
  api: Pick<ApiClient, "assets" | "jobs"> & {
    contents: { versions: Pick<ApiClient["contents"]["versions"], "create"> };
  };
  content: () => { id: string; brandId: string; type: ContentType; title: string };
  kit: () => Pick<RenderKit, "css" | "files">;
  /** The post re-reads its versions (the new one becomes the shown one). */
  refresh: () => Promise<void>;
  /** Pause before saving on its own (ms; 0: never). */
  autosaveMs?: number;
  /** Fetches an asset's bytes (tests). */
  fetchAsset?: (assetId: string) => Promise<Uint8Array>;
}

/** A fresh session for new layers (Wecra makes ids `session:local`; each open gets its own). */
const freshSession = () => 2 + (Math.floor(Date.now() / 1000) % 2_000_000_000);

const DIRTY_KINDS = new Set(["USER", "UNDO", "REDO"]);

/** A slide's render: the frame at 1x, in sRGB. */
const EXPORT = {
  imageType: "PNG",
  constraint: { type: "CONTENT_SCALE", value: 1 },
  useAbsoluteBounds: true,
  colorProfile: "SRGB",
} as const;

export interface SavedSlide extends BundleSlide {
  png: Uint8Array;
}

export class WecraPostSession {
  private state: WecraSessionState = {
    phase: "loading",
    error: null,
    version: null,
    origin: null,
    dirty: false,
    saving: false,
    saveError: null,
    lastSavedAt: null,
    warnings: [],
    editor: null,
  };
  private listeners = new Set<() => void>();
  /** The document the editor shows (a new one per opened version). */
  source: MemoryDocumentSource | null = null;
  images = new BundleImages();
  private loadedVersionId: string | null = null;
  private pendingImport: SlideSource[] | null = null;
  /** Versions this session saved: their document is the one already open. */
  private created = new Set<string>();
  private changes = 0;
  /** The HTML version the open document was imported from (kept through saves). */
  private sourceVersion: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<boolean> | null = null;
  private opening = 0;
  private disposed = false;

  constructor(private readonly deps: WecraSessionDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getState = (): WecraSessionState => this.state;

  private get ed(): EditorController | null {
    return this.state.editor;
  }

  private set(patch: Partial<WecraSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
  }

  activate(): void {
    this.disposed = false;
  }

  private newSource(message: Message): MemoryDocumentSource {
    const source = memoryDocumentSource(message, {
      fileName: this.deps.content().title,
      location: "Studio",
      sessionID: freshSession(),
      images: this.images,
      // A post opens without Wecra's rulers (its zoom menu turns them on).
      uiState: {
        currentPageId: null,
        pages: {},
        leftPanelWidth: 0,
        rightPanelWidth: 0,
        rulers: false,
      },
    });
    const onChanges = source.onChanges.bind(source);
    source.onChanges = (changes, info) => {
      onChanges(changes, info);
      if (source !== this.source || this.state.phase !== "ready") return;
      if (info?.kind && !DIRTY_KINDS.has(info.kind)) return;
      this.changes++;
      if (!this.state.dirty) this.set({ dirty: true });
      this.scheduleSave();
    };
    return source;
  }

  /** Shows `version` on the canvas (no-op when it is the open one or one this session saved). */
  async open(version: ContentVersion): Promise<void> {
    if (version.id === this.loadedVersionId) return;
    if (this.created.has(version.id) && this.source) {
      this.loadedVersionId = version.id;
      this.set({ version: version.version });
      return;
    }
    const ticket = ++this.opening;
    clearTimeout(this.timer);
    this.loadedVersionId = version.id;
    this.source = null;
    this.pendingImport = null;
    this.changes = 0;
    this.set({
      editor: null,
      phase: "loading",
      error: null,
      version: version.version,
      origin: version.editorDocument ? "document" : "import",
      dirty: false,
      saveError: null,
      warnings: [],
    });
    try {
      if (version.editorDocument) {
        const bytes = await (this.deps.fetchAsset ?? fetchAsset(this.deps.api))(
          version.editorDocument.assetId,
        );
        const bundle = decodeBundle(bytes);
        if (ticket !== this.opening) return;
        this.sourceVersion = bundle.meta.sourceVersion ?? null;
        this.images = bundle.images;
        this.source = this.newSource(bundle.message);
        this.set({ phase: "ready" });
      } else {
        this.images = new BundleImages();
        this.sourceVersion = version.version;
        this.pendingImport = version.slides.map((s) => ({
          html: s.html,
          width: s.width,
          height: s.height,
        }));
        this.source = this.newSource(structuredClone(EMPTY_DOCUMENT));
        this.set({ phase: "importing" });
      }
    } catch (e) {
      if (ticket !== this.opening) return;
      this.set({ phase: "error", error: describe(e) });
    }
  }

  /** Opens `version` again (after an error). */
  reopen(version: ContentVersion): Promise<void> {
    this.loadedVersionId = null;
    this.created.delete(version.id);
    return this.open(version);
  }

  /** The editor is up on `source` (EditorApp's onReady): imports the slides when needed. */
  attach = async (ed: EditorController): Promise<void> => {
    if (ed.source !== this.source) return;
    this.set({ editor: ed });
    const slides = this.pendingImport;
    if (!slides) {
      if (!ed.engine.destroyed) ed.engine.command("ZOOM_TO_FIT");
      return;
    }
    this.pendingImport = null;
    const ticket = this.opening;
    try {
      const captured: CapturedSlide[] = await captureSlides(slides, this.deps.kit());
      if (ticket !== this.opening || ed.engine.destroyed) return;
      await importSlides(ed, captured);
      ed.engine.command("ZOOM_TO_FIT");
      const missing = captured.flatMap((c) => c.missing);
      this.set({
        phase: "ready",
        warnings: missing.length
          ? [`${missing.length} görsel içe aktarılamadı; yerlerinde boş katman var.`]
          : [],
      });
    } catch (e) {
      if (ticket !== this.opening) return;
      this.set({ phase: "error", error: `İçe aktarılamadı: ${describe(e)}` });
    }
  };

  private scheduleSave(): void {
    const ms = this.deps.autosaveMs ?? 6000;
    if (!ms) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.disposed || !this.state.dirty) return;
      if (pointerDown) return this.scheduleSave();
      void this.save();
    }, ms);
  }

  /** The slide frames (the page's top-level frames in reading order) with their sizes. */
  slides(): BundleSlide[] {
    const ed = this.ed;
    if (!ed) return [];
    const frames = pageFrames(ed);
    const nodes = ed.engine.readNodes(
      frames.map((f) => f.ref),
      { fields: ["size", "name"] },
    );
    return frames.map((f, i) => {
      const size = (nodes[i] as { size?: { x: number; y: number } } | undefined)?.size;
      return {
        guid: f.ref,
        name: f.name,
        width: Math.round(size?.x ?? 0),
        height: Math.round(size?.y ?? 0),
      };
    });
  }

  /** Why the canvas can't be saved as this post's slides (count, sizes), or null. */
  saveBlocker(slides = this.slides()): string | null {
    const type = this.deps.content().type;
    const limits = SLIDE_LIMITS[type];
    if (slides.length < limits.min || slides.length > limits.max)
      return limits.min === limits.max
        ? `Bu post ${limits.min} kare ister; tuvalde ${slides.length} çerçeve var.`
        : `Bu post ${limits.min}–${limits.max} kare ister; tuvalde ${slides.length} çerçeve var.`;
    const bad = slides.find(
      (s) => s.width < 1 || s.height < 1 || s.width > MAX_ARTBOARD_PX || s.height > MAX_ARTBOARD_PX,
    );
    if (bad)
      return `${bad.name}: kare 1–${MAX_ARTBOARD_PX} px olmalı (${bad.width}×${bad.height}).`;
    return null;
  }

  /**
   * Every slide frame as Wecra's engine exports it (PNG, 1x, sRGB). The engine draws them at
   * once (synchronously: a save started as the post closes gets the pixels before the editor
   * goes); a frame still waiting for a font or an image is exported through Wecra's own export,
   * which waits for them — unless the editor is closing, then it is drawn as it is.
   */
  async exportSlides(slides = this.slides(), closing = false): Promise<SavedSlide[]> {
    return this.encode(this.capture(slides, closing));
  }

  private capture(
    slides: BundleSlide[],
    closing: boolean,
  ): { slide: BundleSlide; out: ExportOutput }[] {
    const ed = this.ed;
    if (!ed || ed.engine.destroyed) throw new Error("Tuval hazır değil.");
    return slides.map((slide) => ({
      slide,
      out: ed.engine.exportNodes(
        [slide.guid],
        EXPORT,
        closing ? { allowPending: true } : undefined,
      ),
    }));
  }

  private async encode(
    captured: { slide: BundleSlide; out: ExportOutput }[],
  ): Promise<SavedSlide[]> {
    const ed = this.ed;
    const out: SavedSlide[] = [];
    for (const { slide, out: o } of captured) {
      let png: Uint8Array;
      if (o.status === "ok" && "pixels" in o) {
        const from = ed?.engine.destroyed === false ? ed.engine.colorProfile : "SRGB";
        png = await encodePixels(
          { ...o.pixels, pixels: convertPixels(o.pixels.pixels, from, "SRGB") },
          "image/png",
          undefined,
          "SRGB",
        );
      } else if (ed && !ed.engine.destroyed) {
        const r = await renderExport(ed, [slide.guid], EXPORT);
        if ("error" in r) throw new Error(`${slide.name} dışa aktarılamadı: ${r.error}`);
        png = r.bytes;
      } else {
        throw new Error(`${slide.name} dışa aktarılamadı.`);
      }
      out.push({ ...slide, png });
    }
    return out;
  }

  /** The texts a slide shows (its render's alt text). */
  private slideText(guid: string): string {
    const ed = this.ed;
    if (!ed) return "";
    const nodes = ed.engine.readNodes([guid], {
      subtree: true,
      fields: ["type", "textData", "visible"],
    }) as { type?: string; textData?: { characters?: string }; visible?: boolean }[];
    return nodes
      .filter((n) => n.type === "TEXT" && n.visible !== false && n.textData?.characters)
      .map((n) => (n.textData?.characters ?? "").replace(/\s+/g, " ").trim())
      .join(" · ");
  }

  /**
   * Saves the canvas as a new version (see the top). False: not saved (the reason is shown).
   * `closing`: the post is being left — everything the save reads of the editor is read now.
   */
  save(note?: string, options: { closing?: boolean } = {}): Promise<boolean> {
    if (this.inflight)
      return this.inflight.then(() => (this.state.dirty ? this.save(note, options) : true));
    this.inflight = this.doSave(note, options.closing === true).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doSave(note: string | undefined, closing: boolean): Promise<boolean> {
    const ed = this.ed;
    const source = this.source;
    if (!ed || ed.engine.destroyed || !source || this.state.phase !== "ready") return false;
    clearTimeout(this.timer);
    // Everything from the editor first, at once (it may be going: `closing`).
    const slides = this.slides();
    const blocker = this.saveBlocker(slides);
    if (blocker) {
      this.set({ saveError: blocker });
      return false;
    }
    const at = this.changes;
    const texts = slides.map((s) => this.slideText(s.guid));
    const document = ed.engine.encodeDocumentKiwi();
    const images = this.images;
    const captured = this.capture(slides, closing);
    this.set({ saving: true, saveError: null });
    try {
      const content = this.deps.content();
      const api = this.deps.api;
      const exported = await this.encode(captured);
      const sourceVersion = this.sourceVersion;
      const bundle = encodeBundle(document, images, slides, sourceVersion);
      const renders = await Promise.all(
        exported.map(async (s, i) => {
          const asset = await api.assets.upload({
            brandId: content.brandId,
            kind: "image",
            source: "generated",
            width: s.width,
            height: s.height,
            file: new Blob([s.png as BlobPart], { type: "image/png" }),
            filename: `kare-${i + 1}.png`,
          });
          return { asset, sha256: await sha256Hex(s.png) };
        }),
      );
      const documentAsset = await api.assets.upload({
        brandId: content.brandId,
        kind: "document",
        source: "generated",
        file: new Blob([bundle as BlobPart], { type: WECRA_DOCUMENT_MIME }),
        filename: "post.wecra",
      });
      const version = await api.contents.versions.create(content.id, {
        origin: "manual_edit",
        note: note?.trim() || "Tuvalde düzenlendi.",
        slides: exported.map((s, i) => ({
          html: canvasSlideHtml({
            src: `/media/${encodeURIComponent((renders[i] as { asset: { id: string } }).asset.id)}.png`,
            sha256: (renders[i] as { sha256: string }).sha256,
            width: s.width,
            height: s.height,
            text: texts[i] ?? "",
            sourceVersion,
          }),
          width: s.width,
          height: s.height,
        })),
        renderedAssetIds: renders.map((r) => r.asset.id),
        // The slide's one layer, measured (the render is its box): no measuring render follows.
        layouts: exported.map((s) => [
          {
            id: "canvas",
            type: "image",
            role: "background",
            parent: null,
            x: 0,
            y: 0,
            w: s.width,
            h: s.height,
            visible: true,
          },
        ]),
        editorDocument: { kind: "wecra", assetId: documentAsset.id, format: BUNDLE_FORMAT },
      });
      this.created.add(version.id);
      this.loadedVersionId = version.id;
      this.set({
        saving: false,
        dirty: this.changes !== at,
        version: version.version,
        lastSavedAt: Date.now(),
      });
      // The deterministic checks on the new renders (the model pass stays a manual run).
      void api.jobs
        .create({
          type: "content.check",
          brandId: content.brandId,
          contentId: content.id,
          payload: { version: version.version, model: false },
        })
        .catch(() => {});
      await this.deps.refresh();
      if (this.state.dirty) this.scheduleSave();
      return true;
    } catch (e) {
      this.set({ saving: false, saveError: `Kaydedilemedi: ${describe(e)}` });
      return false;
    }
  }

  /** Unsaved edits saved (true also when there were none); `closing`: see `save`. */
  async flush(options: { closing?: boolean } = {}): Promise<boolean> {
    if (this.inflight && !options.closing) await this.inflight;
    if (!this.state.dirty) return true;
    return this.save(undefined, options);
  }
}

function fetchAsset(api: Pick<ApiClient, "assets">) {
  return async (assetId: string): Promise<Uint8Array> => {
    const res = await fetch(api.assets.contentUrl(assetId));
    if (!res.ok) throw new Error(`Wecra belgesi okunamadı (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// A gesture on the canvas is not interrupted by an automatic save.
let pointerDown = false;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => (pointerDown = true), true);
  window.addEventListener("pointerup", () => (pointerDown = false), true);
  window.addEventListener("pointercancel", () => (pointerDown = false), true);
}
