// The open post's Wecra document: where it comes from, when it changed, how it is kept.
//
// Open (a version shown on the canvas):
//   - the version has an editor document (saved from the canvas before) → that bundle, its
//     pictures read from the brand's assets (bundle.ts); a bundle this Wecra can't read falls
//     back to the HTML version it was imported from (`studio:source-version`), else to the
//     version's renders, read only, with the reason (E19);
//   - otherwise its HTML slides are imported once into a blank document (import.ts) as soon as
//     the editor is up — a post the AI made or revised opens as Wecra layers;
//   - the post's working draft on this Mac (shared/drafts.ts) made on that same version is put
//     on the canvas instead, silently ("Kaydedilmemiş değişiklikler geri yüklendi" · Vazgeç); a
//     draft made on an older version, or one for a post that is locked, is offered (Taslağı aç
//     / Sil) and never overwritten meanwhile (the canvas waits read only).
//
// Drafts vs versions (S5, E12): an edit only marks the canvas unsaved; a moment later the document
// is written to the post's one draft on this Mac — no API call, no version, approval untouched.
// "Unsaved" is the document's hash against the version's (hash.ts), so undoing back to the saved
// state is clean again (E19). A version is created only on ⌘S, "Sürüm kaydet", Onayla, Zamanla, a
// Sohbet message and closing the post with changes:
//   each slide frame is exported to PNG by Wecra's engine (its exporter, 1x, sRGB); the
//   document's pictures become the brand's assets (each one once: assets.ts) and the document is
//   bundled with references to them; the renders and the bundle are uploaded and a new
//   `manual_edit` version is created whose slides are those renders (`canvasSlideHtml`: the
//   render as the slide's bottom image layer, the slide's texts, slots and logos described above
//   it with the canvas facts read from the document: facts.ts; its SHA-256 in the HTML, so the
//   content hash — what approval is bound to — covers the pixels) with the bundle as its
//   `editorDocument`. A
//   `content.check` job (no model pass) checks it. Only then does the API clear an approval.
// A save that can't be made (frames that don't fit the post: frames.ts; a failure) keeps the
// draft and says why.
//
// A new version arriving (AI, a job) while the canvas has unsaved edits never replaces them
// (E4): the canvas stays, the draft is written, and the user picks — "Benimkini kaydet" (the
// canvas becomes a version on top) or "Yeni sürümü aç" (the edits stay a draft, offered later).
//
// Read only (E3): the workspace locks the canvas (approved, scheduled, published, an older
// version, an AI run); Wecra's own viewer mode refuses edits then (`Engine.setViewerMode`).
import type { ApiClient, ContentType, ContentVersion } from "@studio/contract";
import type { EditorController } from "@/editor/controller";
import { type MemoryDocumentSource, memoryDocumentSource } from "@/editor/documentSource";
import { EMPTY_DOCUMENT } from "@/editor/fixtures";
import type { Message } from "@/engine/codec";
import type { Draft, DraftsBridge } from "../../../../shared/drafts.ts";
import type { RenderKit } from "../model/brand-kit.ts";
import { assetIdOfUrl, linkKnownImages, rememberAsset } from "./assets.ts";
import { BundleImages, type BundleSlide, encodeBundle, loadBundle } from "./bundle.ts";
import type { ImportChange } from "./fidelity.ts";
import {
  type CanvasFrame,
  canvasFrames,
  type FrameSize,
  frameBlocker,
  postFormat,
} from "./frames.ts";
import { documentHash } from "./hash.ts";
import { type CapturedSlide, captureSlides, importSlides, type SlideSource } from "./import.ts";
import { missingFamilies, missingFontMessage } from "./missing-fonts.ts";
import {
  type CanvasCapture,
  type CapturedFrame,
  captureDocument,
  createCanvasVersion,
  encodeFrames,
  exportFrames,
  type SavedSlide,
  slideFrames,
} from "./save.ts";
import { canvasOrigin } from "./slide-html.ts";

export type { SavedSlide } from "./save.ts";

export type WecraPhase = "loading" | "importing" | "ready" | "error" | "fallback";

/** The post's draft, as the canvas tells about it. */
export type DraftNotice =
  /** Put back on the canvas when the post opened ("Vazgeç" drops it). */
  | { kind: "restored"; savedAt: number; baseVersion: number }
  /** Kept but not applied: made on an older version, or the post is locked (Taslağı aç / Sil). */
  | { kind: "offer"; savedAt: number; baseVersion: number; reason: "older" | "locked" };

export interface WecraSessionState {
  phase: WecraPhase;
  error: string | null;
  /** The version the open document is of. */
  version: number | null;
  /** A saved canvas document, or an import of the version's HTML. */
  origin: "document" | "import" | null;
  /** The canvas differs from its version (by the document's hash). */
  dirty: boolean;
  /** A version is being created. */
  saving: boolean;
  saveError: string | null;
  /** When this session last created a version. */
  lastSavedAt: number | null;
  /** When the draft was last written on this Mac. */
  draftSavedAt: number | null;
  /** What the import could not carry over (pictures that did not load), fallbacks. */
  warnings: string[];
  /** What the import changed or could not carry over, layer by layer (fidelity.ts). */
  importReport: ImportChange[];
  /** Wecra's editor on the open document, once it is up. */
  editor: EditorController | null;
  /** The canvas refuses edits (the workspace's lock, a draft waiting for an answer). */
  readOnly: boolean;
  /** Why the canvas can't become a version as it is (frames.ts), or null. */
  blocker: string | null;
  draft: DraftNotice | null;
  /** A newer version arrived while the canvas had unsaved edits (E4). */
  incoming: { version: number } | null;
  /** The document could not be opened: the version's renders, read only (E19). */
  fallback: { message: string; images: { src: string; width: number; height: number }[] } | null;
}

export interface WecraSessionDeps {
  api: Pick<ApiClient, "assets" | "jobs"> & {
    contents: { versions: Pick<ApiClient["contents"]["versions"], "create" | "get"> };
  };
  content: () => { id: string; brandId: string; type: ContentType; title: string };
  kit: () => Pick<RenderKit, "css" | "files">;
  /** The post re-reads its versions (the new one becomes the shown one). */
  refresh: () => Promise<void>;
  /** The post's drafts on this Mac (null: none kept — the canvas still works). */
  drafts?: DraftsBridge | null;
  /** Pause after an edit before the draft is written (ms; 0: only when asked). */
  draftMs?: number;
  /** Fetches an asset's bytes (tests). */
  fetchAsset?: (assetId: string) => Promise<Uint8Array>;
  /** Tells the user something after the post was left (closing could not create a version). */
  report?: (message: string) => void;
  /**
   * Readies an opened document before it counts (the brand's styles: brand-styles.ts) — run
   * before the editor is attached (a document) or right after the import, so it is no edit.
   */
  prepare?: (ed: EditorController) => Promise<void> | void;
}

/** A fresh session for new layers (Wecra makes ids `session:local`; each open gets its own). */
const freshSession = () => 2 + (Math.floor(Date.now() / 1000) % 2_000_000_000);

const DIRTY_KINDS = new Set(["USER", "UNDO", "REDO"]);

/** Everything a version is made of, read from the editor at once (save.ts), and the edit count. */
interface Capture extends CanvasCapture {
  changes: number;
}

/** A draft on its way onto the canvas (applied when the editor is up). */
interface Restoring {
  draft: Draft;
  /** What the canvas is compared with (the version's document hash). */
  baseHash: string | null;
  /** Say so ("restored"); false when the user asked for it (Taslağı aç). */
  notice: boolean;
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
    draftSavedAt: null,
    warnings: [],
    importReport: [],
    editor: null,
    readOnly: false,
    blocker: null,
    draft: null,
    incoming: null,
    fallback: null,
  };
  private listeners = new Set<() => void>();
  /** The document the editor shows (a new one per opened version). */
  source: MemoryDocumentSource | null = null;
  images = new BundleImages();
  private loadedVersionId: string | null = null;
  private opened: ContentVersion | null = null;
  private pendingImport: SlideSource[] | null = null;
  private restoring: Restoring | null = null;
  /** A draft offered and not answered yet (never overwritten meanwhile). */
  private offered: Draft | null = null;
  /** A newer version waiting while the canvas has unsaved edits. */
  private pendingIncoming: ContentVersion | null = null;
  /** Versions this session saved: their document is the one already open. */
  private created = new Set<string>();
  /** Edits counted (a save tells whether the canvas changed while it ran). */
  private changes = 0;
  /** Edits not in the draft file yet. */
  private undrafted = false;
  /** The open version's document hash: the canvas is unsaved when it differs. */
  private baseHash: string | null = null;
  /** The HTML version the open document was imported from (kept through saves). */
  private sourceVersion: number | null = null;
  /** The size every frame of the post has (frames.ts). */
  private format: FrameSize | null = null;
  /** The workspace's lock (approved, scheduled, published, an older version, an AI run). */
  private locked = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private rebaseTimer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<boolean> | null = null;
  private drafting: Promise<void> = Promise.resolve();
  private opening = 0;
  /** `open` calls (a later one wins). */
  private requests = 0;
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

  private get drafts(): DraftsBridge | null {
    return this.deps.drafts ?? null;
  }

  private set(patch: Partial<WecraSessionState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.rebaseTimer);
  }

  activate(): void {
    this.disposed = false;
  }

  private live(ed: EditorController | null = this.ed): ed is EditorController {
    return !!ed && !ed.engine.destroyed && this.state.phase === "ready" && !!this.source;
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
      if (source !== this.source || this.state.phase !== "ready" || !this.state.editor) return;
      if (info?.kind && !DIRTY_KINDS.has(info.kind)) {
        // The engine's own (fonts arriving, layout): the saved state moves with it while clean.
        if (!this.state.dirty) this.scheduleRebase();
        return;
      }
      this.changes++;
      this.undrafted = true;
      if (!this.state.dirty) this.set({ dirty: true });
      this.scheduleDraft();
    };
    return source;
  }

  // --- opening --------------------------------------------------------------------------------

  /**
   * Shows `version` on the canvas (no-op when it is the open one or one this session saved).
   * Unsaved edits are written to the draft first; a newer version then waits for the user (E4).
   */
  async open(version: ContentVersion): Promise<void> {
    const request = ++this.requests;
    if (version.id === this.loadedVersionId) return;
    if (this.created.has(version.id) && this.source) {
      this.loadedVersionId = version.id;
      this.opened = version;
      this.set({ version: version.version });
      return;
    }
    if (this.state.dirty && this.live()) {
      await this.writeDraft();
      // Another version was asked for meanwhile (the one this session just saved): that one.
      if (request !== this.requests) return;
      if (this.state.dirty && this.state.version !== null && version.version > this.state.version) {
        this.pendingIncoming = version;
        this.set({ incoming: { version: version.version } });
        return;
      }
    }
    await this.load(version);
  }

  /** Opens `version` again (after an error). */
  reopen(version: ContentVersion): Promise<void> {
    this.loadedVersionId = null;
    this.created.delete(version.id);
    return this.load(version);
  }

  private async load(version: ContentVersion, options: { skipDraft?: boolean } = {}) {
    const ticket = ++this.opening;
    clearTimeout(this.timer);
    clearTimeout(this.rebaseTimer);
    this.loadedVersionId = version.id;
    this.opened = version;
    this.source = null;
    this.pendingImport = null;
    this.restoring = null;
    this.offered = null;
    this.pendingIncoming = null;
    this.baseHash = null;
    this.changes = 0;
    this.undrafted = false;
    const first = version.slides[0];
    this.format = postFormat(
      this.deps.content().type,
      first ? { width: first.width, height: first.height } : null,
    );
    this.set({
      editor: null,
      phase: "loading",
      error: null,
      version: version.version,
      origin: version.editorDocument ? "document" : "import",
      dirty: false,
      saveError: null,
      warnings: [],
      importReport: [],
      blocker: null,
      draft: null,
      incoming: null,
      fallback: null,
      readOnly: this.locked,
    });
    const draft = options.skipDraft ? null : await this.readDraft();
    if (ticket !== this.opening) return;
    const sameBase =
      !!draft &&
      draft.baseVersion === version.version &&
      (!draft.baseVersionId || draft.baseVersionId === version.id);
    if (draft && sameBase && !this.locked) {
      // The edits left on this version: back on the canvas, said quietly.
      await this.loadDraftDocument(draft, ticket, { baseHash: draft.baseHash, notice: true });
      return;
    }
    if (draft && (draft.baseVersion < version.version || sameBase)) {
      // Made on an older version, or the post is locked now: offered, never applied on its own.
      this.offered = draft;
      this.set({
        draft: {
          kind: "offer",
          savedAt: draft.savedAt,
          baseVersion: draft.baseVersion,
          reason: sameBase ? "locked" : "older",
        },
      });
    }
    // (A draft made on a newer version than the one shown — an older version is being looked
    // at — waits for that version.)
    await this.loadVersionDocument(version, ticket);
    this.applyReadOnly();
  }

  private async loadVersionDocument(version: ContentVersion, ticket: number): Promise<void> {
    try {
      if (version.editorDocument) {
        const bytes = await this.fetch(version.editorDocument.assetId);
        if (ticket !== this.opening) return;
        let bundle: Awaited<ReturnType<typeof loadBundle>>;
        try {
          bundle = await loadBundle(bytes, (id) => this.fetch(id));
        } catch (e) {
          if (ticket === this.opening) await this.fallback(version, ticket, e);
          return;
        }
        if (ticket !== this.opening) return;
        this.sourceVersion = bundle.meta.sourceVersion ?? null;
        this.images = bundle.images;
        this.source = this.newSource(bundle.message);
        this.set({
          phase: "ready",
          warnings: bundle.missing?.length
            ? [`${bundle.missing.length} görsel medyada bulunamadı; yerleri boş görünür.`]
            : [],
        });
      } else {
        this.importHtml(version.slides, version.version);
      }
    } catch (e) {
      if (ticket !== this.opening) return;
      this.set({ phase: "error", error: describe(e) });
    }
  }

  private importHtml(slides: ContentVersion["slides"], sourceVersion: number, warnings?: string[]) {
    this.images = new BundleImages();
    this.sourceVersion = sourceVersion;
    this.pendingImport = slides.map((s) => ({ html: s.html, width: s.width, height: s.height }));
    this.source = this.newSource(structuredClone(EMPTY_DOCUMENT));
    this.set({ phase: "importing", origin: "import", ...(warnings ? { warnings } : {}) });
  }

  /**
   * The version's document can't be opened by this Wecra (E19): the HTML version it was imported
   * from is imported again (said so: the canvas's hand edits are not in it), else its renders are
   * shown read only.
   */
  private async fallback(version: ContentVersion, ticket: number, error: unknown): Promise<void> {
    const reason = describe(error);
    const from = canvasOrigin(version.slides[0]?.html).sourceVersion;
    if (from) {
      try {
        const source = await this.deps.api.contents.versions.get(this.deps.content().id, from);
        if (ticket !== this.opening) return;
        this.importHtml(source.slides, from, [
          `v${version.version}'in Wecra belgesi bu Wecra ile açılamadı (${reason}). Tuval v${from} HTML'sinden yeniden kuruldu; v${version.version}'de tuvalde yapılan değişiklikler bunda yok. Kaydetmeden önce kontrol et.`,
        ]);
        return;
      } catch {
        if (ticket !== this.opening) return;
      }
    }
    this.set({
      phase: "fallback",
      fallback: {
        message: `v${version.version}'in Wecra belgesi açılamadı (${reason}). Kareler kayıtlı görüntüleriyle gösteriliyor; tuvalde düzenlenemez. Sohbetten yeni bir sürüm isteyebilirsin.`,
        images: version.slides.flatMap((s) =>
          s.renderedAssetId
            ? [
                {
                  src: this.deps.api.assets.contentUrl(s.renderedAssetId),
                  width: s.width,
                  height: s.height,
                },
              ]
            : [],
        ),
      },
    });
  }

  /** A draft's document onto the canvas (compared with `baseHash` once the editor is up). */
  private async loadDraftDocument(
    draft: Draft,
    ticket: number,
    options: { baseHash: string | null; notice: boolean },
  ): Promise<void> {
    try {
      const bundle = await loadBundle(draft.bundle, (id) => this.fetch(id));
      if (ticket !== this.opening) return;
      this.sourceVersion = bundle.meta.sourceVersion ?? null;
      this.images = bundle.images;
      this.restoring = { draft, baseHash: options.baseHash, notice: options.notice };
      this.source = this.newSource(bundle.message);
      this.set({ phase: "ready", origin: "document" });
    } catch (e) {
      // A draft that can't be read is no reason not to open the post: the version opens.
      if (ticket !== this.opening) return;
      await this.removeDraft();
      this.set({ warnings: [`Kaydedilmemiş taslak okunamadı: ${describe(e)}`] });
      const version = this.opened;
      if (version) await this.loadVersionDocument(version, ticket);
    }
  }

  /** The editor is up on `source` (EditorApp's onReady): imports the slides when needed. */
  attach = async (ed: EditorController): Promise<void> => {
    if (ed.source !== this.source) return;
    const ticket = this.opening;
    const slides = this.pendingImport;
    // An opened document is readied before the editor counts its changes (no edit).
    if (!slides) {
      await this.prepare(ed);
      if (ticket !== this.opening || ed.engine.destroyed) return;
    }
    this.set({ editor: ed });
    if (slides) {
      this.pendingImport = null;
      try {
        const remembered: Promise<void>[] = [];
        const captured: CapturedSlide[] = await captureSlides(slides, this.deps.kit(), {
          // A picture from the brand's media is that asset already (no upload when saved).
          onPicture: (url, bytes) => {
            const id = assetIdOfUrl(url);
            if (id) remembered.push(rememberAsset(this.images, id, bytes).catch(() => {}));
          },
        });
        if (ticket !== this.opening || ed.engine.destroyed) return;
        await importSlides(ed, captured);
        await this.prepare(ed);
        await Promise.all(remembered);
        await linkKnownImages(this.images);
        ed.engine.command("ZOOM_TO_FIT");
        const missing = captured.flatMap((c) => c.missing);
        this.set({
          phase: "ready",
          importReport: captured.flatMap((c) => c.report ?? []),
          warnings: [
            ...this.state.warnings,
            ...(missing.length
              ? [`${missing.length} görsel içe aktarılamadı; yerlerinde boş katman var.`]
              : []),
          ],
        });
      } catch (e) {
        if (ticket !== this.opening) return;
        this.set({ phase: "error", error: `İçe aktarılamadı: ${describe(e)}` });
        return;
      }
    } else if (!ed.engine.destroyed) {
      ed.engine.command("ZOOM_TO_FIT");
    }
    if (ed.engine.destroyed || ticket !== this.opening) return;
    // What "unsaved" is measured against.
    const hash = await documentHash(ed.engine.encodeDocumentKiwi());
    if (ticket !== this.opening || ed.engine.destroyed) return;
    const restoring = this.restoring;
    this.restoring = null;
    if (restoring) {
      this.baseHash = restoring.baseHash;
      if (hash === restoring.baseHash) {
        await this.removeDraft();
      } else {
        this.set({
          dirty: true,
          ...(restoring.notice
            ? {
                draft: {
                  kind: "restored" as const,
                  savedAt: restoring.draft.savedAt,
                  baseVersion: restoring.draft.baseVersion,
                },
              }
            : {}),
        });
        // Made on an older version and opened now: from here on it is this version's draft.
        if (restoring.draft.baseVersion !== this.state.version) await this.writeDraft(true);
      }
    } else {
      this.baseHash = hash;
    }
    this.set({ blocker: this.frameBlocker(ed) });
    this.applyReadOnly();
  };

  private async prepare(ed: EditorController): Promise<void> {
    if (ed.engine.destroyed) return;
    try {
      await this.deps.prepare?.(ed);
    } catch {
      // The document opens without it.
    }
  }

  // --- read only --------------------------------------------------------------------------------

  /** The workspace's lock: approved, scheduled, published, an older version, an AI run (E3). */
  setReadOnly(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.applyReadOnly();
  }

  private applyReadOnly(): void {
    const on = this.locked || this.offered !== null;
    const ed = this.ed;
    // Wecra's viewer mode: no handles, drags move nothing, edits and commands are refused.
    if (ed && !ed.engine.destroyed && this.state.phase === "ready" && !this.pendingImport)
      ed.engine.setViewerMode?.(on);
    if (this.state.readOnly !== on) this.set({ readOnly: on });
  }

  // --- drafts -------------------------------------------------------------------------------------

  private async readDraft(): Promise<Draft | null> {
    try {
      return (await this.drafts?.load(this.deps.content().id)) ?? null;
    } catch {
      return null;
    }
  }

  private async removeDraft(): Promise<void> {
    try {
      await this.drafts?.remove(this.deps.content().id);
    } catch {
      // Nothing to do: it is overwritten by the next one.
    }
  }

  private scheduleDraft(): void {
    const ms = this.deps.draftMs ?? 800;
    if (!ms) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.disposed) return;
      if (pointerDown) return this.scheduleDraft();
      void this.writeDraft();
    }, ms);
  }

  private scheduleRebase(): void {
    clearTimeout(this.rebaseTimer);
    this.rebaseTimer = setTimeout(() => {
      const ed = this.ed;
      if (this.disposed || this.state.dirty || !this.live(ed)) return;
      const ticket = this.opening;
      void documentHash(ed.engine.encodeDocumentKiwi()).then((hash) => {
        if (ticket === this.opening && !this.state.dirty) this.baseHash = hash;
      });
    }, 400);
  }

  /** Why the canvas can't become this post's slides now (frames.ts), or null. */
  private frameBlocker(ed: EditorController): string | null {
    return frameBlocker(this.deps.content().type, canvasFrames(ed), this.format);
  }

  /**
   * The canvas as the post's draft, now (read at once; written in order). Clean again (undone back
   * to the version) → the draft goes. `force`: written even when nothing changed since the last one.
   */
  writeDraft(force = false): Promise<void> {
    const ed = this.ed;
    if (!this.live(ed) || this.offered) return this.drafting;
    if (!force && !this.undrafted && !this.state.dirty) return this.drafting;
    clearTimeout(this.timer);
    const document = ed.engine.encodeDocumentKiwi();
    const slides = this.slides();
    const blocker = this.frameBlocker(ed);
    this.undrafted = false;
    return this.storeDraft(document, slides, blocker);
  }

  private storeDraft(
    document: Uint8Array,
    slides: BundleSlide[],
    blocker: string | null,
  ): Promise<void> {
    const content = this.deps.content();
    const version = this.state.version ?? 0;
    const versionId = this.loadedVersionId;
    const baseHash = this.baseHash;
    const sourceVersion = this.sourceVersion;
    const images = this.images;
    const ticket = this.opening;
    this.drafting = this.drafting
      .then(async () => {
        const hash = await documentHash(document);
        if (ticket !== this.opening) return;
        if (hash === baseHash) {
          // Back to the version (undone): nothing unsaved, no draft.
          if (this.state.dirty || this.state.blocker !== blocker)
            this.set({ dirty: this.changesAfter(document), blocker });
          await this.removeDraft();
          return;
        }
        if (this.state.blocker !== blocker) this.set({ blocker });
        const drafts = this.drafts;
        if (!drafts) return;
        const savedAt = Date.now();
        try {
          await drafts.save({
            contentId: content.id,
            baseVersion: version,
            baseVersionId: versionId,
            savedAt,
            baseHash,
            docHash: hash,
            bundle: encodeBundle(document, images, slides, sourceVersion),
          });
          if (ticket === this.opening) this.set({ draftSavedAt: savedAt });
        } catch (e) {
          if (ticket === this.opening) this.set({ saveError: `Taslak yazılamadı: ${describe(e)}` });
        }
      })
      .catch(() => {});
    return this.drafting;
  }

  /** Whether the canvas changed after `document` was read (an edit while hashing). */
  private changesAfter(document: Uint8Array): boolean {
    const ed = this.ed;
    if (!this.live(ed) || !this.undrafted) return false;
    const now = ed.engine.encodeDocumentKiwi();
    return now.length !== document.length || now.some((b, i) => b !== document[i]);
  }

  /** The draft, written without waiting (the page is unloading: a reload). */
  saveDraftSync(): void {
    const ed = this.ed;
    const drafts = this.drafts;
    if (!drafts?.saveSync || !this.live(ed) || this.offered) return;
    if (!this.state.dirty && !this.undrafted) return;
    const document = ed.engine.encodeDocumentKiwi();
    drafts.saveSync({
      contentId: this.deps.content().id,
      baseVersion: this.state.version ?? 0,
      baseVersionId: this.loadedVersionId,
      savedAt: Date.now(),
      baseHash: this.baseHash,
      docHash: null,
      bundle: encodeBundle(document, this.images, this.slides(), this.sourceVersion),
    });
    this.undrafted = false;
  }

  /** "Vazgeç" on a restored draft: the draft goes, the version opens as it is. */
  async discardDraft(): Promise<void> {
    const version = this.opened;
    if (!version) return;
    await this.drafting;
    await this.removeDraft();
    this.loadedVersionId = null;
    await this.load(version, { skipDraft: true });
  }

  /** "Taslağı aç" on an offered draft: its document on the canvas, unsaved, on this version. */
  async openDraft(): Promise<void> {
    const draft = this.offered;
    if (!draft || this.locked) return;
    const ticket = ++this.opening;
    this.offered = null;
    const baseHash = this.baseHash;
    this.set({ draft: null, editor: null, phase: "loading" });
    this.source = null;
    this.changes = 0;
    this.undrafted = false;
    await this.loadDraftDocument(draft, ticket, { baseHash, notice: false });
  }

  /** "Sil" on an offered draft: it goes; the canvas is the version's (editable unless locked). */
  async deleteDraft(): Promise<void> {
    if (!this.offered) return;
    this.offered = null;
    await this.removeDraft();
    this.set({ draft: null });
    this.applyReadOnly();
  }

  /** The restored note was read. */
  dismissDraftNotice(): void {
    if (this.state.draft?.kind === "restored") this.set({ draft: null });
  }

  // --- an incoming version (E4) -------------------------------------------------------------------

  /**
   * "Benimkini kaydet": the canvas becomes a version on top of the new one (which stays in the
   * history). "Yeni sürümü aç": the new version opens; the edits stay a draft, offered.
   */
  async resolveIncoming(choice: "mine" | "theirs"): Promise<boolean> {
    const incoming = this.pendingIncoming;
    if (!incoming) return true;
    this.pendingIncoming = null;
    this.set({ incoming: null });
    if (choice === "mine") {
      if (await this.save()) return true;
      // Not saved: the question stays.
      this.pendingIncoming = incoming;
      this.set({ incoming: { version: incoming.version } });
      return false;
    }
    await this.writeDraft();
    await this.drafting;
    await this.load(incoming);
    return true;
  }

  // --- versions -----------------------------------------------------------------------------------

  /** The slide frames (the page's top-level frames in reading order) with their sizes. */
  slides(): BundleSlide[] {
    const ed = this.ed;
    return ed ? slideFrames(ed) : [];
  }

  /** Why these frames can't be saved as this post's slides (count, sizes, hidden), or null. */
  saveBlocker(frames: readonly (CanvasFrame | BundleSlide)[]): string | null {
    return frameBlocker(
      this.deps.content().type,
      frames.map((f) => ({ visible: true, ...f })),
      this.format,
    );
  }

  /**
   * Every slide frame as Wecra's engine exports it (PNG, 1x, sRGB). The engine draws them at
   * once (synchronously: a save started as the post closes gets the pixels before the editor
   * goes); a frame still waiting for a font or an image is exported through Wecra's own export,
   * which waits for them — unless the editor is closing, then it is drawn as it is.
   */
  async exportSlides(slides = this.slides(), closing = false): Promise<SavedSlide[]> {
    return encodeFrames(this.ed, this.capture(slides, closing));
  }

  private capture(slides: BundleSlide[], closing: boolean): CapturedFrame[] {
    const ed = this.ed;
    if (!ed || ed.engine.destroyed) throw new Error("Tuval hazır değil.");
    return exportFrames(ed, slides, closing);
  }

  /** Why a version can't be made from the canvas now (a question waits, read only), or null. */
  private versionBlocker(): string | null {
    if (this.pendingIncoming)
      return "Önce yeni gelen sürüm için seç: “Benimkini kaydet” ya da “Yeni sürümü aç”.";
    if (this.offered) return "Önce kaydedilmemiş taslak için seç: “Taslağı aç” ya da “Sil”.";
    if (this.locked) return "Tuval salt okunur; önce “Düzenle” ile aç.";
    return null;
  }

  /** Everything a version is made of, from the editor at once (it may be going: `closing`). */
  private captureSave(closing: boolean): Capture | string {
    const ed = this.ed;
    if (!this.live(ed)) return "Tuval hazır değil.";
    const frames = canvasFrames(ed);
    const blocker = frameBlocker(this.deps.content().type, frames, this.format);
    if (blocker) {
      this.set({ blocker });
      void this.storeDraft(ed.engine.encodeDocumentKiwi(), this.slides(), blocker);
      return blocker;
    }
    const capture = captureDocument(ed, closing);
    // A text drawn without its font would be published in the fallback (E9): the draft keeps it.
    const missing = missingFontMessage(missingFamilies(capture.facts));
    if (missing) {
      this.set({ blocker: missing });
      void this.storeDraft(capture.document, capture.slides, missing);
      return missing;
    }
    return { ...capture, changes: this.changes };
  }

  /**
   * Creates a version from the canvas (see the top). False: not saved (the reason is shown, the
   * edits stay in the draft). `closing`: the post is being left — the editor is read now.
   */
  save(note?: string, options: { closing?: boolean } = {}): Promise<boolean> {
    if (this.inflight)
      return this.inflight.then(() => (this.state.dirty ? this.save(note, options) : true));
    const run = async (): Promise<boolean> => {
      const blocked = this.versionBlocker();
      if (blocked) {
        this.set({ saveError: blocked });
        return false;
      }
      clearTimeout(this.timer);
      const capture = this.captureSave(options.closing === true);
      if (typeof capture === "string") {
        this.set({ saveError: capture });
        await this.drafting;
        return false;
      }
      return this.commit(capture, note);
    };
    this.inflight = run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async commit(capture: Capture, note: string | undefined): Promise<boolean> {
    const { document, slides } = capture;
    const hash = await documentHash(document);
    if (hash === this.baseHash && !note?.trim()) {
      // Nothing differs from the version (undone back to it): no version.
      if (this.changes === capture.changes) this.set({ dirty: false });
      await this.removeDraft();
      return true;
    }
    const images = this.images;
    const sourceVersion = this.sourceVersion;
    const ticket = this.opening;
    this.set({ saving: true, saveError: null });
    try {
      // Renders, pictures and the bundle uploaded, the version created, its checks queued (save.ts).
      const { version } = await createCanvasVersion({
        api: this.deps.api,
        content: this.deps.content(),
        ed: this.ed,
        capture,
        images,
        sourceVersion,
        origin: "manual_edit",
        note: note?.trim() || "Tuvalde düzenlendi.",
      });
      this.created.add(version.id);
      if (ticket === this.opening) {
        this.loadedVersionId = version.id;
        this.baseHash = hash;
        // A version that arrived while this one was being made is under it now: no question.
        if (this.pendingIncoming && this.pendingIncoming.version < version.version) {
          this.pendingIncoming = null;
          this.set({ incoming: null });
        }
        const dirty = this.changes !== capture.changes;
        this.set({
          saving: false,
          dirty,
          version: version.version,
          lastSavedAt: Date.now(),
        });
        // The draft is the version now; edits made meanwhile stay a draft of the new version.
        if (dirty) await this.writeDraft(true);
        else await this.drafting.then(() => this.removeDraft());
      } else {
        this.set({ saving: false });
      }
      await this.deps.refresh();
      return true;
    } catch (e) {
      this.set({ saving: false, saveError: `Kaydedilemedi: ${describe(e)}` });
      // The edits are not lost: they stay this Mac's draft.
      await this.storeDraft(document, slides, null);
      return false;
    }
  }

  /** Unsaved edits made a version (true also when there were none): approve, schedule, chat. */
  async flush(): Promise<boolean> {
    if (this.inflight) await this.inflight;
    if (!this.state.dirty) return true;
    return this.save();
  }

  /**
   * The post is being left (E14): the canvas is read now, before the editor goes; the draft is
   * written first, then a version is created. When that can't be done the draft stays and the
   * user is told (`report`).
   */
  async close(): Promise<void> {
    clearTimeout(this.timer);
    clearTimeout(this.rebaseTimer);
    if (!this.state.dirty || !this.live()) return;
    const blocked = this.versionBlocker();
    if (blocked) {
      await this.writeDraft(true);
      await this.drafting;
      this.deps.report?.(
        "Değişikliklerin bu Mac'te taslak olarak saklandı; sürüm oluşturulmadı. Postu açınca geri gelir.",
      );
      return;
    }
    if (this.inflight) {
      // A save runs: what changed since goes to the draft (the editor is going).
      await this.writeDraft(true);
      if (!(await this.inflight))
        this.deps.report?.(
          `${this.state.saveError ?? "Sürüm kaydedilemedi."} Değişikliklerin bu Mac'te taslak olarak duruyor; postu açınca geri gelir.`,
        );
      return;
    }
    const capture = this.captureSave(true);
    if (typeof capture === "string") {
      await this.drafting;
      this.deps.report?.(
        `Sürüm kaydedilemedi: ${capture} Değişikliklerin bu Mac'te taslak olarak duruyor; postu açınca geri gelir.`,
      );
      return;
    }
    await this.storeDraft(capture.document, capture.slides, null);
    this.inflight = this.commit(capture, undefined).finally(() => {
      this.inflight = null;
    });
    if (!(await this.inflight))
      this.deps.report?.(
        `${this.state.saveError ?? "Sürüm kaydedilemedi."} Değişikliklerin bu Mac'te taslak olarak duruyor; postu açınca geri gelir.`,
      );
  }

  private fetch(assetId: string): Promise<Uint8Array> {
    return (this.deps.fetchAsset ?? fetchAsset(this.deps.api))(assetId);
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

// A gesture on the canvas is not interrupted by writing the draft.
let pointerDown = false;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", () => (pointerDown = true), true);
  window.addEventListener("pointerup", () => (pointerDown = false), true);
  window.addEventListener("pointercancel", () => (pointerDown = false), true);
}
