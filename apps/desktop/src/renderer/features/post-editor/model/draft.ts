// The canvas editor's working copy of a post: the version it started from plus the edits made
// since, applied here with design-kit's own patch engine (the worker applies the same ops to
// the same HTML, so what the canvas shows is what the render will be).
//
// - Every edit is a list of design-kit ops, each with its slide. It applies at once (the canvas
//   never waits for a render), goes on the undo stack with its inverses, and waits in `pending`.
// - Saving sends `pending` as one `content.render` job (PostEditor.commitPatches): a new
//   `manual_edit` version. Edits made while it renders wait for the next save. Saving happens on
//   its own after a pause, and before anything that needs the version (approve, schedule, an AI
//   revision, another version); ⌘S saves at once with a name.
// - Undo / redo apply the inverses / the ops again — new edits for the server, instant here.
// - A version that arrives from elsewhere (an AI revision, a restore, a job in chat) replaces the
//   base; edits not saved yet are applied on top of it again when they still fit.
// - Unsaved edits survive a closed window (localStorage, per post and base version).
import {
  applyPatch,
  type PatchContext,
  PatchError,
  type PatchOp,
  type PatchOpInput,
} from "@studio/design-kit/patch";
import type { SlideSource } from "./document.ts";

export type SlidePatchInput = PatchOpInput & { slide: number };
export type SlidePatch = PatchOp & { slide: number };

export interface HistoryEntry {
  name: string;
  ops: SlidePatch[];
  inverses: SlidePatch[];
}

export interface DraftSnapshot {
  /** Version the working copy is built on (null: no design yet). */
  baseVersion: number | null;
  slides: SlideSource[];
  /** Bumped on every change of `slides`. */
  revision: number;
  pending: SlidePatch[];
  inflight: SlidePatch[] | null;
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  saving: boolean;
  saveError: string | null;
  lastSavedAt: number | null;
  /** Slides whose HTML changed with the last edit (the canvas re-measures them). */
  changedSlides: number[];
}

export interface DraftBackend {
  /** Save: the ops as one render job on `baseVersion`; resolves with the new version number. */
  commit(patches: SlidePatch[], name: string, note?: string): Promise<number | null>;
}

export interface DraftOptions {
  /** Pause after the last edit before saving on its own (ms; 0: never). */
  autosaveMs?: number;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  storageKey?: string;
}

export class DraftError extends Error {}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class DraftSession {
  private state: DraftSnapshot;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private held = 0;
  private readonly autosaveMs: number;

  constructor(
    private readonly backend: DraftBackend,
    base: { version: number | null; slides: SlideSource[] },
    private ctx: PatchContext = {},
    private readonly options: DraftOptions = {},
  ) {
    this.autosaveMs = options.autosaveMs ?? 1800;
    this.state = {
      baseVersion: base.version,
      slides: base.slides.map((s) => ({ ...s })),
      revision: 0,
      pending: [],
      inflight: null,
      undo: [],
      redo: [],
      saving: false,
      saveError: null,
      lastSavedAt: null,
      changedSlides: [],
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DraftSnapshot => this.state;

  private set(patch: Partial<DraftSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  setContext(ctx: PatchContext): void {
    this.ctx = ctx;
  }

  get dirty(): boolean {
    return this.state.pending.length > 0 || this.state.inflight !== null;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }

  // --- applying -------------------------------------------------------------------------------

  /** Ops applied to `slides` in order; throws a PatchError (nothing applied) when one fails. */
  private run(
    slides: readonly SlideSource[],
    ops: readonly SlidePatchInput[],
  ): { slides: SlideSource[]; applied: SlidePatch[]; inverses: SlidePatch[]; changed: number[] } {
    const next = slides.map((s) => ({ ...s }));
    const applied: SlidePatch[] = [];
    const inverses: SlidePatch[] = [];
    const changed = new Set<number>();
    for (const input of ops) {
      const { slide, ...op } = input;
      const target = next[slide];
      if (!target) throw new DraftError(`Kare ${slide + 1} yok.`);
      const result = applyPatch(target.html, op as PatchOpInput, this.ctx);
      if (result.html !== target.html) changed.add(slide);
      target.html = result.html;
      applied.push({ ...result.op, slide } as SlidePatch);
      inverses.unshift({ ...result.inverse, slide } as SlidePatch);
    }
    return { slides: next, applied, inverses, changed: [...changed] };
  }

  /**
   * One edit (one undo step). `merge`: joins the last step instead (a correction that belongs to
   * it, e.g. the position fix after a resize reflowed). Returns false (and the reason in
   * `lastError`) when design-kit refused an op; nothing is applied then.
   */
  apply(ops: readonly SlidePatchInput[], name: string, options: { merge?: boolean } = {}): boolean {
    if (ops.length === 0) return true;
    let result: ReturnType<DraftSession["run"]>;
    try {
      result = this.run(this.state.slides, ops);
    } catch (e) {
      this.lastError = e instanceof PatchError || e instanceof DraftError ? e.message : describe(e);
      return false;
    }
    this.lastError = null;
    if (result.changed.length === 0) return true;
    const last = this.state.undo.at(-1);
    const undo =
      options.merge && last
        ? [
            ...this.state.undo.slice(0, -1),
            {
              name: last.name,
              ops: [...last.ops, ...result.applied],
              inverses: [...result.inverses, ...last.inverses],
            },
          ]
        : [...this.state.undo, { name, ops: result.applied, inverses: result.inverses }];
    this.commitLocal(result, { undo, redo: [] });
    return true;
  }

  lastError: string | null = null;

  private commitLocal(
    result: { slides: SlideSource[]; applied: SlidePatch[]; changed: number[] },
    patch: Partial<DraftSnapshot>,
  ): void {
    this.set({
      ...patch,
      slides: result.slides,
      revision: this.state.revision + 1,
      pending: [...this.state.pending, ...result.applied],
      changedSlides: result.changed,
      saveError: null,
    });
    this.persist();
    this.scheduleSave();
  }

  canUndo(): boolean {
    return this.state.undo.length > 0;
  }

  canRedo(): boolean {
    return this.state.redo.length > 0;
  }

  undo(): string | null {
    const step = this.state.undo.at(-1);
    if (!step) return null;
    try {
      const result = this.run(this.state.slides, step.inverses);
      this.commitLocal(result, {
        undo: this.state.undo.slice(0, -1),
        redo: [...this.state.redo, step],
      });
      return step.name;
    } catch (e) {
      // The step no longer fits the document (a version came from elsewhere): forget the stack.
      this.lastError = describe(e);
      this.set({ undo: [], redo: [] });
      return null;
    }
  }

  redo(): string | null {
    const step = this.state.redo.at(-1);
    if (!step) return null;
    try {
      const result = this.run(this.state.slides, step.ops);
      this.commitLocal(result, {
        undo: [...this.state.undo, step],
        redo: this.state.redo.slice(0, -1),
      });
      return step.name;
    } catch (e) {
      this.lastError = describe(e);
      this.set({ undo: [], redo: [] });
      return null;
    }
  }

  // --- saving -------------------------------------------------------------------------------------

  /** Holds autosave while a gesture or a text edit runs (nested). */
  hold(): () => void {
    this.held++;
    clearTimeout(this.timer);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held = Math.max(0, this.held - 1);
      this.scheduleSave();
    };
  }

  private scheduleSave(): void {
    clearTimeout(this.timer);
    if (!this.autosaveMs || this.held > 0 || this.state.pending.length === 0) return;
    if (this.state.saveError) return;
    this.timer = setTimeout(() => void this.flush(), this.autosaveMs);
  }

  /**
   * Save everything pending (and wait for a save already running). `note` names the version
   * (Sürüm kaydet). Resolves true when nothing is left unsaved.
   */
  async flush(note?: string): Promise<boolean> {
    clearTimeout(this.timer);
    while (this.saving) await this.saving;
    if (this.state.pending.length === 0) return this.state.saveError === null;
    const batch = this.state.pending;
    const name = this.state.undo.at(-1)?.name ?? "Düzenleme";
    this.set({ pending: [], inflight: batch, saving: true, saveError: null });
    let ok = false;
    this.saving = (async () => {
      try {
        const version = await this.backend.commit(batch, name, note);
        ok = true;
        // The new version holds exactly `batch` on the old base; pending edits stay on top.
        this.set({
          inflight: null,
          saving: false,
          lastSavedAt: Date.now(),
          ...(version !== null ? { baseVersion: version } : {}),
        });
      } catch (e) {
        // Kept: the edits go out again with the next save (a worker that was offline).
        this.set({
          inflight: null,
          pending: [...batch, ...this.state.pending],
          saving: false,
          saveError: describe(e),
        });
      } finally {
        this.saving = null;
        this.persist();
      }
    })();
    await this.saving;
    if (ok && this.state.pending.length > 0) return this.flush(note);
    return ok;
  }

  /** Try again after a failed save. */
  retry(): Promise<boolean> {
    this.set({ saveError: null });
    return this.flush();
  }

  /**
   * A version from elsewhere is now the current one: it becomes the base, and the edits not
   * saved yet are applied on it again (dropped, with the history, when they no longer fit).
   * Returns false when unsaved edits had to be dropped.
   */
  rebase(base: { version: number | null; slides: SlideSource[] }): boolean {
    if (base.version !== null && base.version === this.state.baseVersion && !this.dirty) {
      // The same version again (a refresh): take its slides (renders, layouts) as they are.
      this.set({ slides: base.slides.map((s) => ({ ...s })), changedSlides: [] });
      return true;
    }
    if (this.state.inflight) return true; // our own save lands on its own
    const pending = this.state.pending;
    let slides = base.slides.map((s) => ({ ...s }));
    let kept = pending;
    let ok = true;
    if (pending.length > 0) {
      try {
        slides = this.run(slides, pending).slides;
      } catch {
        kept = [];
        ok = false;
      }
    }
    this.set({
      baseVersion: base.version,
      slides,
      pending: kept,
      revision: this.state.revision + 1,
      changedSlides: slides.map((_, i) => i),
      undo: ok ? this.state.undo : [],
      redo: ok ? this.state.redo : [],
    });
    this.persist();
    return ok;
  }

  /** Throw away the unsaved edits (back to the base version's slides). */
  discard(base: { version: number | null; slides: SlideSource[] }): void {
    clearTimeout(this.timer);
    this.set({
      baseVersion: base.version,
      slides: base.slides.map((s) => ({ ...s })),
      pending: [],
      revision: this.state.revision + 1,
      changedSlides: base.slides.map((_, i) => i),
      undo: [],
      redo: [],
      saveError: null,
    });
    this.persist();
  }

  // --- persistence ------------------------------------------------------------------------------

  private persist(): void {
    const { storage, storageKey } = this.options;
    if (!storage || !storageKey) return;
    try {
      const unsaved = [...(this.state.inflight ?? []), ...this.state.pending];
      if (unsaved.length === 0) storage.removeItem(storageKey);
      else
        storage.setItem(
          storageKey,
          JSON.stringify({ base: this.state.baseVersion, patches: unsaved, at: Date.now() }),
        );
    } catch {
      // Storage full or unavailable: the edits still save on their own.
    }
  }

  /** Unsaved edits a closed window left for this base version: applied again (true when any). */
  recover(): boolean {
    const { storage, storageKey } = this.options;
    if (!storage || !storageKey) return false;
    let saved: { base?: unknown; patches?: unknown } | null = null;
    try {
      saved = JSON.parse(storage.getItem(storageKey) ?? "null");
    } catch {
      saved = null;
    }
    if (!saved || saved.base !== this.state.baseVersion || !Array.isArray(saved.patches))
      return false;
    const ops = saved.patches as SlidePatchInput[];
    if (ops.length === 0) return false;
    return this.apply(ops, "Kaydedilmemiş değişiklikler");
  }
}
