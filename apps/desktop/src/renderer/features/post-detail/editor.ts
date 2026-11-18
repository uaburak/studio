// An opened post and its editor, without views (tested with a fake API). Port of StudioKit's
// PostEditSession / the Mac's PostDetailModel:
//
// - Every design change goes through the API's patch path: the edit becomes design-kit patch
//   ops, a `content.render` job stores a new `manual_edit` version and renders it, and the
//   editor adopts the new version when the job is done. Edits sent while another one renders
//   wait and go out right after, on the new version.
// - Undo restores the version before an edit (a new version with the same hash), redo the
//   edited one.
// - Approval sends the hash recomputed here from the slides shown, only when it equals the
//   server's hash of the current version.
import {
  type ApiClient,
  type Content,
  type ContentVersion,
  type ContentVersionSummary,
  isTerminalJobStatus,
  type Job,
  type JobCreate,
  type Slide,
  statusIn,
  UNDELETABLE_STATUSES,
} from "@studio/contract";
import { describeError } from "../../lib/api.ts";
import { approvableHash, versionHash } from "../posts/board.ts";
import {
  type Box,
  boxOf,
  type ColorProperty,
  type DesignPatch,
  IDENTITY,
  isIdentity,
  type LayerTransform,
  layersInHtml,
  mediaSource,
  moved,
  previewBox,
  resized,
  type SlideLayer,
  transformPatch,
} from "../posts/slides.ts";

export type Activity =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "rendering"; message: string }
  | { kind: "measuring" }
  | { kind: "revising"; message: string }
  | { kind: "restoring" };

const IDLE: Activity = { kind: "idle" };

export function activityMessage(a: Activity): string {
  switch (a.kind) {
    case "idle":
      return "";
    case "uploading":
      return "Görsel yükleniyor";
    case "rendering":
      return a.message || "Render ediliyor";
    case "measuring":
      return "Katmanlar ölçülüyor";
    case "revising":
      return a.message || "AI düzenliyor";
    case "restoring":
      return "Sürüm geri yükleniyor";
  }
}

/** Busy with something that changes the version (measuring boxes does not). */
export function changesVersion(a: Activity): boolean {
  return a.kind !== "idle" && a.kind !== "measuring";
}

/** One undoable change: the version before it and the version it produced. */
export interface EditStep {
  before: number;
  after: number;
  name: string;
}

export type HashState = "checking" | "ok" | "mismatch" | "none";

export interface EditorSnapshot {
  content: Content;
  /** The current version once loaded (what approval checks). */
  current: ContentVersion | null;
  /** The version shown (an older one is read only). */
  displayed: ContentVersion | null;
  summaries: ContentVersionSummary[];
  slideIndex: number;
  selectedLayerId: string | null;
  activity: Activity;
  /** Boxes (artboard px) of layers moved or resized while their render runs. */
  previewBoxes: Record<string, Box>;
  /** Transforms sent but not yet in a loaded version (`"slide:layer"`). */
  pendingTransforms: Record<string, LayerTransform>;
  /** Hash to approve with: recomputed from `current` and equal to the server's. */
  approvableHash: string | null;
  hashState: HashState;
  undo: EditStep[];
  redo: EditStep[];
  approving: boolean;
  savingCaption: boolean;
  revisionJobId: string | null;
  error: string | null;
  notice: string | null;
}

// --- derived ------------------------------------------------------------------------------------

export function activeVersion(s: EditorSnapshot): ContentVersion | null {
  return s.displayed ?? s.current;
}

export function slidesOf(s: EditorSnapshot): Slide[] {
  return activeVersion(s)?.slides ?? [];
}

export function currentSlide(s: EditorSnapshot): Slide | null {
  return slidesOf(s)[s.slideIndex] ?? null;
}

export function isViewingCurrent(s: EditorSnapshot): boolean {
  const current = s.content.currentVersion?.version;
  const shown = activeVersion(s)?.version;
  return current === undefined || shown === undefined || current === shown;
}

export function isLocked(content: Content): boolean {
  return content.status === "publishing" || content.status === "published";
}

export function hasApproval(content: Content): boolean {
  return statusIn(content.status, ["approved", "scheduled", "publishing", "published"] as const);
}

/** Why the design cannot be edited right now (null: it can). */
export function editBlocker(s: EditorSnapshot): string | null {
  if (s.content.type === "reel") return "Reels metinleri ve süreleri sohbetten düzenlenir.";
  if (isLocked(s.content)) return "Yayındaki post düzenlenemez.";
  if (!activeVersion(s)) return "Henüz bir tasarım sürümü yok.";
  if (!isViewingCurrent(s))
    return "Eski bir sürümü görüntülüyorsun; düzenlemek için önce geri yükle.";
  if (s.activity.kind === "revising") return "AI düzenlemesi sürüyor.";
  if (s.activity.kind === "restoring") return "Sürüm geri yükleniyor.";
  return null;
}

/** Why approving is not possible right now (null: it is). */
export function approveBlocker(s: EditorSnapshot): string | null {
  if (hasApproval(s.content)) return "Bu post onaylandı.";
  if (s.content.status === "failed")
    return "Yayını başarısız olan post zamanlamadan yeniden denenir.";
  if (changesVersion(s.activity)) return "Değişiklik render edilirken onaylanamaz.";
  if (!isViewingCurrent(s))
    return "Eski bir sürümü görüntülüyorsun; onaylamak için güncel sürüme geç ya da bu sürümü geri yükle.";
  if (!s.content.currentVersion) return "Henüz bir sürüm yok.";
  if (!s.current) return "Sürüm yükleniyor.";
  if (s.hashState === "checking") return "Sürüm doğrulanıyor.";
  if (!s.approvableHash) return "Gösterilen sürüm sunucudakiyle eşleşmiyor; yenile.";
  return null;
}

export function canApprove(s: EditorSnapshot): boolean {
  return approveBlocker(s) === null && !s.approving;
}

export function canUndo(s: EditorSnapshot): boolean {
  return s.undo.length > 0 && !changesVersion(s.activity);
}

export function canRedo(s: EditorSnapshot): boolean {
  return s.redo.length > 0 && !changesVersion(s.activity);
}

export function slideLayers(s: EditorSnapshot): SlideLayer[] {
  const slide = currentSlide(s);
  return slide ? layersInHtml(slide.html, s.slideIndex) : [];
}

// --- controller ---------------------------------------------------------------------------------

export type EditorApi = {
  contents: Pick<ApiClient["contents"], "get" | "update" | "approve"> & {
    versions: Pick<ApiClient["contents"]["versions"], "get" | "list" | "restore">;
  };
  jobs: Pick<ApiClient["jobs"], "create" | "get" | "cancel">;
  assets: Pick<ApiClient["assets"], "upload">;
};

export interface EditorOptions {
  pollMs?: number;
  jobTimeoutMs?: number;
  revisionTimeoutMs?: number;
  nudgeMs?: number;
  /** A Mac worker is connected (measuring layer boxes needs one). */
  workerOnline?: () => boolean;
  /** The content or its current version changed (keep lists and caches in step). */
  onChange?: (content: Content, current: ContentVersion | null) => void;
  /** The post was approved (its status changed for the board and the calendar). */
  onApproved?: (content: Content) => void;
}

export class JobWaitError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PostEditor {
  private snapshotValue: EditorSnapshot;
  private listeners = new Set<() => void>();
  private queued: { patches: DesignPatch[]; name: string } | null = null;
  private measured = new Set<string>();
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  private nudgeDelta: { layer: string; dx: number; dy: number } | null = null;
  private verifyGeneration = 0;
  private disposed = false;
  private readonly pollMs: number;
  private readonly jobTimeoutMs: number;
  private readonly revisionTimeoutMs: number;
  private readonly nudgeMs: number;

  constructor(
    private readonly api: EditorApi,
    content: Content,
    current: ContentVersion | null,
    private readonly options: EditorOptions = {},
  ) {
    this.pollMs = options.pollMs ?? 400;
    this.jobTimeoutMs = options.jobTimeoutMs ?? 180_000;
    this.revisionTimeoutMs = options.revisionTimeoutMs ?? 1_200_000;
    this.nudgeMs = options.nudgeMs ?? 450;
    const usable = current && current.contentId === content.id ? current : null;
    this.snapshotValue = {
      content,
      current: usable && usable.version === content.currentVersion?.version ? usable : null,
      displayed: usable,
      summaries: [],
      slideIndex: 0,
      selectedLayerId: null,
      activity: IDLE,
      previewBoxes: {},
      pendingTransforms: {},
      approvableHash: null,
      hashState: "none",
      undo: [],
      redo: [],
      approving: false,
      savingCaption: false,
      revisionJobId: null,
      error: null,
      notice: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EditorSnapshot => this.snapshotValue;

  private get s(): EditorSnapshot {
    return this.snapshotValue;
  }

  private set(patch: Partial<EditorSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    for (const l of this.listeners) l();
  }

  /** The view is gone: pending nudges go out, job waits stop polling. */
  dispose(): void {
    this.flushNudge();
    this.disposed = true;
  }

  /** The view is (back) on screen (React strict mode mounts twice). */
  activate(): void {
    this.disposed = false;
  }

  clearError(): void {
    this.set({ error: null });
  }

  clearNotice(): void {
    this.set({ notice: null });
  }

  // --- loading & versions ---------------------------------------------------------------------

  /** Version list, the current version when it was not passed in, its hash check. */
  async load(): Promise<void> {
    await this.refreshVersionList();
    const ref = this.s.content.currentVersion;
    if (ref && (!this.s.current || !this.s.displayed)) {
      try {
        const version = await this.api.contents.versions.get(this.s.content.id, ref.version);
        this.set({
          current: version,
          displayed: this.s.displayed ?? version,
        });
        this.options.onChange?.(this.s.content, version);
      } catch (e) {
        this.set({ error: describeError(e) });
      }
    }
    await this.verify();
    this.ensureLayouts();
  }

  async refreshVersionList(): Promise<void> {
    try {
      const list = await this.api.contents.versions.list(this.s.content.id, { limit: 100 });
      this.set({ summaries: [...list.items].sort((a, b) => b.version - a.version) });
    } catch {
      // The list is a convenience; the shown version still works.
    }
  }

  /** Recompute the approval hash of the current version. */
  async verify(): Promise<void> {
    const generation = ++this.verifyGeneration;
    const { content, current } = this.s;
    const ref = content.currentVersion;
    if (!current || !ref || current.version !== ref.version) {
      this.set({ approvableHash: null, hashState: "none" });
      return;
    }
    this.set({ hashState: "checking" });
    // The hash state is about the slides shown; approving also needs an approvable status.
    const local = await versionHash(current).catch(() => null);
    if (generation !== this.verifyGeneration) return;
    const matches = local !== null && local === ref.contentHash;
    this.set({
      hashState: matches ? "ok" : "mismatch",
      approvableHash: matches ? await approvableHash(this.s.content, current) : null,
    });
  }

  /** Show another version (read only unless it is the current one). */
  async selectVersion(versionNumber: number): Promise<void> {
    if (this.s.current?.version === versionNumber) {
      this.showVersion(this.s.current);
      return;
    }
    try {
      const version = await this.api.contents.versions.get(this.s.content.id, versionNumber);
      this.showVersion(version);
      this.set({ error: null });
    } catch (e) {
      this.set({ error: describeError(e) });
    }
  }

  async showCurrent(): Promise<void> {
    const current = this.s.content.currentVersion?.version;
    if (current !== undefined) await this.selectVersion(current);
  }

  private showVersion(version: ContentVersion): void {
    const slideIndex = Math.min(this.s.slideIndex, Math.max(0, version.slides.length - 1));
    this.set({ displayed: version, slideIndex });
    this.keepSelection();
  }

  selectSlide(index: number): void {
    const count = slidesOf(this.s).length;
    const clamped = Math.max(0, Math.min(index, Math.max(0, count - 1)));
    if (clamped === this.s.slideIndex) return;
    this.flushNudge();
    this.set({ slideIndex: clamped, selectedLayerId: null });
    this.ensureLayouts();
  }

  selectLayer(layerId: string | null): void {
    if (layerId !== this.s.selectedLayerId) this.flushNudge();
    this.set({ selectedLayerId: layerId });
  }

  private keepSelection(): void {
    const selected = this.s.selectedLayerId;
    if (selected && !slideLayers(this.s).some((l) => l.layerId === selected)) {
      this.set({ selectedLayerId: null });
    }
  }

  /** Load `versionNumber` as the new current version (after an edit, restore or revision). */
  private async adopt(versionNumber: number): Promise<void> {
    const [version, content] = await Promise.all([
      this.api.contents.versions.get(this.s.content.id, versionNumber),
      this.api.contents.get(this.s.content.id),
    ]);
    const isCurrent = version.version === content.currentVersion?.version;
    const slideIndex = Math.min(this.s.slideIndex, Math.max(0, version.slides.length - 1));
    this.set({
      content,
      current: isCurrent ? version : this.s.current,
      displayed: version,
      slideIndex,
      pendingTransforms: {},
      previewBoxes: {},
    });
    this.keepSelection();
    this.options.onChange?.(content, isCurrent ? version : this.s.current);
    await Promise.all([this.refreshVersionList(), this.verify()]);
  }

  /**
   * The post changed elsewhere (a job in chat, another device, a schedule): take the fresh
   * content and, when the current version moved on and the current one is shown, follow it.
   */
  async refresh(fresh?: Content): Promise<void> {
    if (changesVersion(this.s.activity)) return;
    let content = fresh;
    if (!content) {
      try {
        content = await this.api.contents.get(this.s.content.id);
      } catch (e) {
        this.set({ error: describeError(e) });
        return;
      }
    }
    const wasCurrent = isViewingCurrent(this.s);
    const advanced = content.currentVersion?.version !== this.s.current?.version;
    if (wasCurrent && advanced && content.currentVersion) {
      this.set({ content });
      try {
        await this.adopt(content.currentVersion.version);
      } catch (e) {
        this.set({ error: describeError(e) });
      }
      return;
    }
    this.set({ content });
    this.options.onChange?.(content, this.s.current);
    await Promise.all([this.refreshVersionList(), this.verify()]);
  }

  /** Versions rendered before layer boxes were stored get measured once (needs the worker). */
  ensureLayouts(): void {
    const version = activeVersion(this.s);
    if (
      !version ||
      !isViewingCurrent(this.s) ||
      this.s.content.type === "reel" ||
      isLocked(this.s.content) ||
      !version.slides.some((sl) => sl.layers == null || sl.renderedAssetId == null) ||
      // An approved version's renders are frozen (the API refuses to replace them).
      (hasApproval(this.s.content) && version.slides.every((sl) => sl.renderedAssetId != null)) ||
      this.measured.has(version.id) ||
      this.s.activity.kind !== "idle" ||
      !(this.options.workerOnline?.() ?? false)
    ) {
      return;
    }
    this.measured.add(version.id);
    this.set({ activity: { kind: "measuring" } });
    void (async () => {
      try {
        const job = await this.createJob({
          type: "content.render",
          contentId: this.s.content.id,
          payload: { format: "jpeg", version: version.version },
        });
        await this.waitForJob(job.id, this.jobTimeoutMs);
        const measured = await this.api.contents.versions.get(this.s.content.id, version.version);
        if (this.s.displayed?.id === measured.id) this.set({ displayed: measured });
        if (this.s.current?.id === measured.id) {
          this.set({ current: measured });
          this.options.onChange?.(this.s.content, measured);
        }
      } catch {
        // The editor still works from the layer list; boxes come with the next render.
      } finally {
        if (this.s.activity.kind === "measuring") this.set({ activity: IDLE });
        this.flushQueued();
      }
    })();
  }

  // --- jobs -------------------------------------------------------------------------------------

  private createJob(input: JobCreate): Promise<Job> {
    return this.api.jobs.create(input);
  }

  /** Poll a job until it finishes; throws when it fails, is cancelled or takes too long. */
  async waitForJob(
    id: string,
    timeoutMs: number,
    interval = this.pollMs,
    onProgress?: (job: Job) => void,
  ): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.api.jobs.get(id);
      onProgress?.(job);
      if (job.status === "succeeded") return job;
      if (job.status === "failed") throw new JobWaitError(job.error ?? "İş başarısız oldu.");
      if (job.status === "cancelled") throw new JobWaitError("İş iptal edildi.");
      if (isTerminalJobStatus(job.status)) return job;
      if (Date.now() >= deadline || this.disposed)
        throw new JobWaitError("İş zamanında bitmedi; Mac'teki işçi çalışıyor mu?");
      await sleep(interval);
    }
  }

  // --- editing ----------------------------------------------------------------------------------

  private layer(layerId: string): SlideLayer | undefined {
    return slideLayers(this.s).find((l) => l.layerId === layerId);
  }

  /** The layer's box: the live preview while its edit renders, else the measured one. */
  box(layerId: string): Box | null {
    const preview = this.s.previewBoxes[layerId];
    if (preview) return preview;
    const measured = currentSlide(this.s)?.layers?.find((b) => b.id === layerId);
    return measured ? boxOf(measured) : null;
  }

  /** The editor transform a layer has, including edits still rendering. */
  transformOf(layerId: string): LayerTransform {
    return (
      this.s.pendingTransforms[`${this.s.slideIndex}:${layerId}`] ??
      this.layer(layerId)?.transform ??
      IDENTITY
    );
  }

  private guard(): boolean {
    const blocker = editBlocker(this.s);
    if (blocker) {
      this.set({ error: blocker });
      return false;
    }
    return true;
  }

  setText(layerId: string, text: string): void {
    if (!this.guard()) return;
    const layer = this.layer(layerId);
    if (!layer || layer.text === text) return;
    this.submit(
      [{ slide: this.s.slideIndex, op: "setText", layer: layerId, text }],
      "Metni değiştir",
    );
  }

  setHidden(layerId: string, hidden: boolean): void {
    if (!this.guard()) return;
    const layer = this.layer(layerId);
    if (!layer || layer.hidden === hidden) return;
    this.submit(
      [{ slide: this.s.slideIndex, op: "setVisibility", layer: layerId, hidden }],
      hidden ? "Katmanı gizle" : "Katmanı göster",
    );
  }

  /** `value` null removes the colour (back to the design's own). */
  setColor(layerId: string, value: string | null, property: ColorProperty = "color"): void {
    if (!this.guard()) return;
    const layer = this.layer(layerId);
    if (!layer) return;
    if (property === "color" && (layer.color ?? null) === value) return;
    this.submit(
      [
        {
          slide: this.s.slideIndex,
          op: "setColor",
          layer: layerId,
          property,
          value: value ? { literal: value } : null,
        },
      ],
      "Rengi değiştir",
    );
  }

  /** Move a layer by artboard px. */
  move(layerId: string, dx: number, dy: number): void {
    if (dx === 0 && dy === 0) return;
    const current = this.transformOf(layerId);
    this.applyTransform(layerId, current, moved(current, dx, dy), "Taşı");
  }

  /** Resize by `factor` with the top-left corner fixed. */
  resize(layerId: string, factor: number): void {
    const box = this.box(layerId);
    if (!(factor > 0) || Math.abs(factor - 1) <= 0.001 || !box) return;
    const current = this.transformOf(layerId);
    this.applyTransform(layerId, current, resized(current, box, factor), "Boyutlandır");
  }

  /** Absolute transform fields (inspector); omitted parts are kept. */
  setTransform(layerId: string, next: { x?: number; y?: number; scale?: number }): void {
    const current = this.transformOf(layerId);
    const target: LayerTransform = {
      translate: { x: next.x ?? current.translate.x, y: next.y ?? current.translate.y },
      scale: next.scale ?? current.scale,
    };
    if (
      target.translate.x === current.translate.x &&
      target.translate.y === current.translate.y &&
      target.scale === current.scale
    )
      return;
    this.applyTransform(layerId, current, target, "Konum ve boyut");
  }

  resetTransform(layerId: string): void {
    const current = this.transformOf(layerId);
    if (isIdentity(current)) return;
    this.applyTransform(layerId, current, IDENTITY, "Konumu sıfırla");
  }

  /** Arrow-key nudges: sent as one move once the keys rest. */
  nudge(layerId: string, dx: number, dy: number): void {
    if (!this.guard()) return;
    if (this.nudgeDelta && this.nudgeDelta.layer !== layerId) this.flushNudge();
    const delta = this.nudgeDelta ?? { layer: layerId, dx: 0, dy: 0 };
    this.nudgeDelta = { layer: layerId, dx: delta.dx + dx, dy: delta.dy + dy };
    const box = this.box(layerId);
    if (box) {
      this.set({
        previewBoxes: {
          ...this.s.previewBoxes,
          [layerId]: { ...box, x: box.x + dx, y: box.y + dy },
        },
      });
    }
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => this.flushNudge(), this.nudgeMs);
  }

  /** Send the nudge collected so far. */
  flushNudge(): void {
    clearTimeout(this.nudgeTimer);
    const delta = this.nudgeDelta;
    this.nudgeDelta = null;
    if (!delta || (delta.dx === 0 && delta.dy === 0)) return;
    const { [delta.layer]: _drop, ...rest } = this.s.previewBoxes;
    this.set({ previewBoxes: rest });
    this.move(delta.layer, delta.dx, delta.dy);
  }

  private applyTransform(
    layerId: string,
    from: LayerTransform,
    to: LayerTransform,
    name: string,
  ): void {
    if (!this.guard()) return;
    const box = this.box(layerId);
    const slide = this.s.slideIndex;
    this.set({
      previewBoxes: box
        ? { ...this.s.previewBoxes, [layerId]: previewBox(box, from, to) }
        : this.s.previewBoxes,
      pendingTransforms: { ...this.s.pendingTransforms, [`${slide}:${layerId}`]: to },
    });
    this.submit([transformPatch(slide, layerId, to)], name);
  }

  /** Upload a picture and put it into an image layer (replace) or a slot (fill). */
  async placeImage(file: Blob, layerId: string, slide = this.s.slideIndex): Promise<void> {
    if (!this.guard()) return;
    const html = slidesOf(this.s)[slide]?.html;
    const layer = html ? layersInHtml(html, slide).find((l) => l.layerId === layerId) : undefined;
    if (!layer) {
      this.set({ error: `Bu tasarımda “${layerId}” katmanı yok.` });
      return;
    }
    if (layer.kind !== "slot" && layer.kind !== "image") {
      this.set({
        error:
          layer.kind === "logo"
            ? "Logo marka kitinden gelir; buradan değiştirilemez."
            : "Bu katman bir görsel değil.",
      });
      return;
    }
    if (changesVersion(this.s.activity)) {
      this.set({ error: "Önceki değişiklik bitince yeniden dene." });
      return;
    }
    this.set({ activity: { kind: "uploading" }, error: null });
    try {
      const asset = await this.api.assets.upload({
        brandId: this.s.content.brandId,
        kind: "image",
        file,
      });
      this.set({ activity: IDLE });
      const src = mediaSource(asset.id, asset.mimeType);
      this.submit(
        [
          layer.kind === "slot"
            ? { slide, op: "fillSlot", layer: layerId, src }
            : { slide, op: "replaceImage", layer: layerId, src },
        ],
        layer.kind === "slot" ? "Yuvayı doldur" : "Görseli değiştir",
      );
    } catch (e) {
      this.set({ activity: IDLE, error: describeError(e) });
    }
  }

  clearSlot(layerId: string): void {
    if (!this.guard()) return;
    this.submit([{ slide: this.s.slideIndex, op: "clearSlot", layer: layerId }], "Yuvayı boşalt");
  }

  /** Send an edit; while another one renders it waits and goes out right after. */
  private submit(patches: DesignPatch[], name: string): void {
    if (!this.guard()) return;
    if (changesVersion(this.s.activity) || this.s.activity.kind === "measuring") {
      this.queued = {
        patches: [...(this.queued?.patches ?? []), ...patches],
        name,
      };
      return;
    }
    void this.start(patches, name);
  }

  private flushQueued(): void {
    const next = this.queued;
    if (!next || this.s.activity.kind !== "idle") return;
    this.queued = null;
    void this.start(next.patches, next.name);
  }

  private async start(patches: DesignPatch[], name: string): Promise<void> {
    const base = activeVersion(this.s)?.version;
    if (base === undefined) return;
    this.set({ activity: { kind: "rendering", message: "Render ediliyor" }, error: null });
    try {
      const job = await this.createJob({
        type: "content.render",
        contentId: this.s.content.id,
        payload: { format: "jpeg", version: base, patches },
      });
      const done = await this.waitForJob(job.id, this.jobTimeoutMs, this.pollMs, (j) => {
        if (this.s.activity.kind === "rendering" && j.progressMessage) {
          this.set({ activity: { kind: "rendering", message: j.progressMessage } });
        }
      });
      const output = (done.output ?? {}) as { version?: unknown; unchanged?: unknown };
      const number = typeof output.version === "number" ? output.version : null;
      if (output.unchanged !== true && number !== null && number !== base) {
        await this.adopt(number);
        this.set({ undo: [...this.s.undo, { before: base, after: number, name }], redo: [] });
      } else {
        this.set({ previewBoxes: {}, pendingTransforms: {} });
      }
    } catch (e) {
      this.set({ previewBoxes: {}, pendingTransforms: {}, error: `${name}: ${describeError(e)}` });
    }
    this.set({ activity: IDLE });
    this.flushQueued();
  }

  /** Resolves once nothing changes the version (a render, a revision, a restore, measuring). */
  whenIdle(): Promise<void> {
    if (this.s.activity.kind === "idle") return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.subscribe(() => {
        if (this.s.activity.kind !== "idle") return;
        off();
        resolve();
      });
    });
  }

  /**
   * The canvas editor's save (post-editor/model/draft.ts): design-kit patch ops, each with its
   * `slide`, as one `content.render` job on the shown version; the new version is adopted and
   * becomes an undo step of the version history. Resolves with the new version's number (null:
   * nothing changed); throws when the job fails or takes too long.
   */
  async commitPatches(
    patches: readonly Record<string, unknown>[],
    name: string,
    note?: string,
  ): Promise<number | null> {
    await this.whenIdle();
    const blocker = editBlocker(this.s);
    if (blocker) throw new Error(blocker);
    const base = activeVersion(this.s)?.version;
    if (base === undefined) throw new Error("Henüz bir tasarım sürümü yok.");
    this.set({ activity: { kind: "rendering", message: "Kaydediliyor" }, error: null });
    try {
      const job = await this.createJob({
        type: "content.render",
        contentId: this.s.content.id,
        payload: {
          format: "jpeg",
          version: base,
          patches: [...patches],
          ...(note ? { note: note.slice(0, 2000) } : {}),
        },
      });
      const done = await this.waitForJob(job.id, this.jobTimeoutMs, this.pollMs, (j) => {
        if (this.s.activity.kind === "rendering" && j.progressMessage)
          this.set({ activity: { kind: "rendering", message: j.progressMessage } });
      });
      const output = (done.output ?? {}) as { version?: unknown; unchanged?: unknown };
      const number = typeof output.version === "number" ? output.version : null;
      if (output.unchanged === true || number === null || number === base) return null;
      await this.adopt(number);
      this.set({ undo: [...this.s.undo, { before: base, after: number, name }], redo: [] });
      return number;
    } finally {
      this.set({ activity: IDLE });
      this.flushQueued();
    }
  }

  // --- undo / redo / restore ----------------------------------------------------------------

  async undo(): Promise<void> {
    if (!canUndo(this.s)) return;
    const step = this.s.undo.at(-1);
    if (!step) return;
    this.set({ undo: this.s.undo.slice(0, -1) });
    if ((await this.restore(step.before)) !== null) {
      this.set({ redo: [...this.s.redo, step], notice: `Geri alındı: ${step.name}` });
    } else {
      this.set({ undo: [...this.s.undo, step] });
    }
  }

  async redo(): Promise<void> {
    if (!canRedo(this.s)) return;
    const step = this.s.redo.at(-1);
    if (!step) return;
    this.set({ redo: this.s.redo.slice(0, -1) });
    if ((await this.restore(step.after)) !== null) {
      this.set({ undo: [...this.s.undo, step], notice: `Yinelendi: ${step.name}` });
    } else {
      this.set({ redo: [...this.s.redo, step] });
    }
  }

  /** "Bu sürümü geri yükle": a copy of the shown version becomes the current one. */
  async restoreDisplayed(): Promise<void> {
    const shown = activeVersion(this.s)?.version;
    const current = this.s.content.currentVersion?.version;
    if (shown === undefined || current === undefined || shown === current) return;
    const restored = await this.restore(shown);
    if (restored !== null) {
      this.set({
        undo: [...this.s.undo, { before: current, after: restored, name: `v${shown} geri yükle` }],
        redo: [],
        notice: `v${shown}, v${restored} olarak geri yüklendi.`,
      });
    }
  }

  private async restore(version: number): Promise<number | null> {
    if (isLocked(this.s.content)) {
      this.set({ error: "Yayındaki postun sürümü değiştirilemez." });
      return null;
    }
    this.set({ activity: { kind: "restoring" } });
    try {
      const restored = await this.api.contents.versions.restore(this.s.content.id, version);
      await this.adopt(restored.version);
      this.set({ error: null });
      return restored.version;
    } catch (e) {
      this.set({ error: describeError(e) });
      return null;
    } finally {
      this.set({ activity: IDLE });
      this.flushQueued();
    }
  }

  // --- "Neyi değiştireyim?" (AI revision) ------------------------------------------------------

  async sendInstruction(text: string): Promise<boolean> {
    const instructions = text.trim();
    if (!instructions) return false;
    const base = activeVersion(this.s)?.version;
    if (base === undefined || !isViewingCurrent(this.s)) {
      this.set({
        error:
          base === undefined
            ? "Henüz bir tasarım yok."
            : "Eski bir sürümü görüntülüyorsun; önce geri yükle.",
      });
      return false;
    }
    if (changesVersion(this.s.activity)) {
      this.set({ error: "Önceki değişiklik bitince yeniden dene." });
      return false;
    }
    const { content } = this.s;
    this.set({ activity: { kind: "revising", message: "İstek Mac'e gönderiliyor" }, error: null });
    let ok = false;
    try {
      const job = await this.createJob({
        type: "content.generate",
        brandId: content.brandId,
        contentId: content.id,
        payload: {
          brief: content.brief || content.title,
          title: content.title,
          type: content.type,
          instructions: instructions.slice(0, 4000),
          baseVersion: base,
        },
      });
      this.set({ revisionJobId: job.id });
      const done = await this.waitForJob(job.id, this.revisionTimeoutMs, 1500, (j) => {
        if (this.s.activity.kind !== "revising") return;
        const online = this.options.workerOnline?.() ?? true;
        const message =
          j.status === "queued"
            ? online
              ? "Sırada"
              : "Mac'teki işçiyi bekliyor"
            : (j.progressMessage ?? "AI düzenliyor");
        this.set({ activity: { kind: "revising", message } });
      });
      const number = (done.output as { version?: unknown } | undefined)?.version;
      if (typeof number === "number" && number !== base) {
        await this.adopt(number);
        this.set({
          undo: [...this.s.undo, { before: base, after: number, name: "AI düzenlemesi" }],
          redo: [],
          notice: `AI düzenlemesi v${number} olarak kaydedildi.`,
        });
      } else {
        this.set({ notice: "AI bu istekle bir değişiklik yapmadı." });
      }
      ok = true;
    } catch (e) {
      this.set({ error: `AI düzenlemesi: ${describeError(e)}` });
    }
    this.set({ revisionJobId: null, activity: IDLE });
    this.flushQueued();
    return ok;
  }

  async cancelRevision(): Promise<void> {
    const id = this.s.revisionJobId;
    if (!id) return;
    try {
      await this.api.jobs.cancel(id);
    } catch {
      // It may have finished meanwhile.
    }
  }

  // --- caption & approval ---------------------------------------------------------------------

  async saveCaption(caption: string): Promise<boolean> {
    if (caption === this.s.content.caption) return true;
    this.set({ savingCaption: true });
    try {
      const wasApproved = hasApproval(this.s.content);
      const content = await this.api.contents.update(this.s.content.id, { caption });
      this.set({
        content,
        error: null,
        notice:
          wasApproved && !hasApproval(content)
            ? "Açıklama kaydedildi; onay yeniden gerekiyor."
            : "Açıklama kaydedildi.",
      });
      this.options.onChange?.(content, this.s.current);
      await this.verify();
      return true;
    } catch (e) {
      this.set({ error: describeError(e) });
      return false;
    } finally {
      this.set({ savingCaption: false });
    }
  }

  /**
   * Approves the current version. `acknowledgeChecks`: the user saw that its checks did not pass
   * (or have not finished) and approves anyway — without it the API refuses then (E7).
   */
  async approve(options: { acknowledgeChecks?: boolean } = {}): Promise<boolean> {
    const hash = this.s.approvableHash;
    const blocker = approveBlocker(this.s);
    if (blocker || !hash || this.s.approving) {
      this.set({ error: blocker ?? "Onaylanamıyor." });
      return false;
    }
    this.set({ approving: true });
    try {
      const content = await this.api.contents.approve(
        this.s.content.id,
        options.acknowledgeChecks ? { hash, acknowledgeChecks: true } : hash,
      );
      this.set({ content, error: null, notice: "Onaylandı." });
      this.options.onChange?.(content, this.s.current);
      this.options.onApproved?.(content);
      return true;
    } catch (e) {
      this.set({ error: describeError(e) });
      return false;
    } finally {
      this.set({ approving: false });
    }
  }

  /** Take a content returned by another call (schedule, transition). */
  replaceContent(content: Content): void {
    if (content.id !== this.s.content.id) return;
    this.set({ content });
    this.options.onChange?.(content, this.s.current);
    void this.verify();
  }

  deletionAllowed(): boolean {
    return !statusIn(this.s.content.status, UNDELETABLE_STATUSES);
  }
}
