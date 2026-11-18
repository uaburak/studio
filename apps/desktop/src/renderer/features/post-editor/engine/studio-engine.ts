// The editor's facade over Wecra's engine (vendored in src/renderer/vendor/wecra-engine): the
// slice of DesignerV2's Engine.ts the post editor needs, on the same C ABI and JSON wire.
//
// - One Wasm module per renderer process (loadEngineModule), one engine per open editor.
// - Every call drains the engine's event queue afterwards and dispatches the events
//   synchronously (the engine never calls JS back during its own work).
// - Frames are on demand: a call that changes what is drawn asks for an animation frame;
//   `onRender` runs right after each engine render (the alpha pass hooks in there).
// - Documents: `engine_load` takes kiwi only, so the editor loads the vendored blank
//   document once and sends everything else as JSON changes (`applyChanges`).
import {
  ABI_VERSION,
  APPLY_LOAD,
  APPLY_REMOTE,
  APPLY_SYSTEM,
  APPLY_USER,
  CommandId,
  type CommandName,
  INCLUDE_CHILD_IDS,
  KeyType,
  READ_SUBTREE,
  Status,
  TICK_NEEDS_RENDER,
  TOOLS,
  type ToolName,
} from "../../../vendor/wecra-engine/abi.ts";
import { BLANK_DOCUMENT_BASE64 } from "../../../vendor/wecra-engine/blank-document.ts";
import type {
  Camera,
  EngineEvent,
  EngineEventType,
  EventOf,
  Guid,
  NodeChange,
  Selection,
} from "../../../vendor/wecra-engine/codec.ts";
import { EngineExports } from "../../../vendor/wecra-engine/EngineExports.ts";
import { keyCodeOf } from "../../../vendor/wecra-engine/keyCodes.ts";
import createEngineModule, {
  type EngineModuleOptions,
} from "../../../vendor/wecra-engine/wasm/engine.mjs";

export type { Camera, CommandName, EngineEvent, EventOf, Guid, NodeChange, Selection, ToolName };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

let loading: Promise<EngineExports> | null = null;

/** The module, loaded once (tests pass `wasmBinary`; the options count on the first call only). */
export function loadEngineModule(options: EngineModuleOptions = {}): Promise<EngineExports> {
  loading ??= createEngineModule({
    printErr: (text: string) => console.warn(`[engine] ${text}`),
    ...options,
  }).then((module) => {
    const exports = new EngineExports(module);
    const version = exports.abiVersion();
    if (version !== ABI_VERSION) throw new Error(`engine: ABI ${version}, expected ${ABI_VERSION}`);
    return exports;
  });
  loading.catch(() => {
    loading = null;
  });
  return loading;
}

/** Fonts the overlays draw with: Inter (bundled with the engine), answered once per module. */
const fontModules = new WeakSet<EngineExports>();
let interBytes: Promise<Uint8Array | null> | null = null;

/** Where the bundled Inter comes from (the app: a Vite asset URL; tests: the file). */
let interSource: () => Promise<Uint8Array | null> = async () => {
  const { default: url } = await import("../../../vendor/wecra-engine/fonts/Inter-3.19.ttf?url");
  const response = await fetch(url);
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
};

export function setInterSource(source: () => Promise<Uint8Array | null>): void {
  interSource = source;
  interBytes = null;
}

const INTER_STYLES = ["Regular", "Medium", "Semi Bold", "Bold"];

async function attachFonts(x: EngineExports, after: () => void): Promise<void> {
  if (fontModules.has(x)) return;
  fontModules.add(x);
  x.setFallbackFonts(json([]));
  interBytes ??= interSource().catch(() => null);
  const bytes = await interBytes;
  if (!bytes) {
    for (const style of INTER_STYLES) x.fontMissing(encoder.encode("Inter"), encoder.encode(style));
    after();
    return;
  }
  const face = x.fontAddTake(bytes, 0);
  for (const style of INTER_STYLES) {
    if (face >= 0) x.fontBind(encoder.encode("Inter"), encoder.encode(style), face);
    else x.fontMissing(encoder.encode("Inter"), encoder.encode(style));
  }
  after();
}

function base64Bytes(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type ApplyKind = "user" | "system" | "remote" | "load";

const APPLY_FLAGS: Record<ApplyKind, number> = {
  user: APPLY_USER,
  system: APPLY_SYSTEM,
  remote: APPLY_REMOTE,
  load: APPLY_LOAD,
};

type Handler = (event: EngineEvent) => void;

export interface ViewOptionFlags {
  rulers?: boolean;
  snapToObjects?: boolean;
  snapToPixelGrid?: boolean;
  showDimensions?: boolean;
}

// View option bits (abi.ts VIEW_*), spelled out here so the defaults read as a sentence.
const VIEW = {
  LAYOUT_GUIDES: 4,
  RULERS: 8,
  SNAP_PIXELS: 16,
  SNAP_GEOMETRY: 256,
  SNAP_OBJECTS: 512,
  SHOW_DIMENSIONS: 2048,
  FLIP_RESIZE: 4096,
  RIGHT_DRAG_PAN: 65536,
} as const;

export class StudioEngine {
  /** The engine drawing into `canvas` (WebGL2: the alpha pass needs it); `null` = headless. */
  static async create(
    canvas: HTMLCanvasElement | null,
    options: { sessionID?: number; theme?: "LIGHT" | "DARK" } = {},
  ): Promise<StudioEngine> {
    const x = await loadEngineModule();
    if (canvas && !canvas.id) canvas.id = `post-canvas-${Math.random().toString(36).slice(2, 8)}`;
    const handle = x.create(
      canvas ? `#${canvas.id}` : null,
      json({
        sessionID: options.sessionID ?? 1,
        theme: options.theme ?? "DARK",
        wire: "json",
        gfx: "webgl2",
      }),
    );
    if (!handle) {
      x.lastError();
      throw new Error(`engine: ${decoder.decode(x.result()) || "could not start"}`);
    }
    const engine = new StudioEngine(x, handle, canvas);
    void attachFonts(x, () => engine.fontsChanged());
    return engine;
  }

  private h: number;
  private readonly handlers = new Map<EngineEventType | "*", Set<Handler>>();
  private queue: EngineEvent[] = [];
  private dispatching = false;
  private frameRequested = 0;
  private frameTimer: ReturnType<typeof setTimeout> | undefined;
  /** Runs after every frame the engine drew (the canvas picture changed). */
  onRender: (() => void) | null = null;

  private constructor(
    private readonly x: EngineExports,
    handle: number,
    readonly canvas: HTMLCanvasElement | null,
  ) {
    this.h = handle;
  }

  get destroyed(): boolean {
    return this.h === 0;
  }

  get module(): EngineExports["module"] {
    return this.x.module;
  }

  destroy(): void {
    if (!this.h) return;
    if (this.frameRequested) cancelAnimationFrame(this.frameRequested);
    clearTimeout(this.frameTimer);
    this.x.destroy(this.h);
    this.h = 0;
    this.handlers.clear();
    this.onRender = null;
  }

  // --- events ---------------------------------------------------------------------------------

  on<T extends EngineEventType>(type: T, handler: (event: EventOf<T>) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const h = handler as Handler;
    set.add(h);
    return () => set.delete(h);
  }

  onAny(handler: Handler): () => void {
    return this.on("*" as EngineEventType, handler as never);
  }

  private after<T>(value: T): T {
    if (!this.h) return value;
    if (this.x.eventsPending() && this.x.hasEvents(this.h)) {
      this.x.takeEvents(this.h);
      const decoded = JSON.parse(decoder.decode(this.x.result())) as { events: EngineEvent[] };
      this.queue.push(...decoded.events);
    }
    if (this.x.needsFrame(this.h)) this.schedule();
    if (!this.dispatching) {
      this.dispatching = true;
      try {
        while (this.queue.length) {
          const event = this.queue.shift() as EngineEvent;
          if (event.type === "REQUEST_FONT") this.answerFont(event.family, event.style);
          for (const handler of this.handlers.get(event.type) ?? []) handler(event);
          for (const handler of this.handlers.get("*" as EngineEventType) ?? []) handler(event);
        }
      } finally {
        this.dispatching = false;
      }
    }
    return value;
  }

  /** Only Inter is served (the overlays' labels); anything else is missing. */
  private answerFont(family: string, style: string): void {
    if (family === "Inter" && INTER_STYLES.includes(style)) return;
    this.x.fontMissing(encoder.encode(family), encoder.encode(style));
  }

  private fontsChanged(): void {
    this.pump();
    this.schedule();
  }

  /** Drain events after work the engine did on its own. */
  pump(): void {
    if (this.h) this.after(undefined);
  }

  // --- frames ---------------------------------------------------------------------------------

  schedule(): void {
    if (this.frameRequested || !this.h || !this.canvas) return;
    this.frameRequested = requestAnimationFrame(this.frame);
  }

  private readonly frame = (time: number): void => {
    this.frameRequested = 0;
    if (!this.h) return;
    if (this.x.tick(this.h, time) & TICK_NEEDS_RENDER) {
      this.x.render(this.h);
      this.onRender?.();
    }
    const delay = this.x.nextFrameDelay(this.h);
    if (delay === 0) this.schedule();
    else if (delay > 0) this.frameTimer = setTimeout(() => this.schedule(), delay);
    this.after(undefined);
  };

  /** Draw now (a resized drawing buffer is blank until drawn: do it in the same frame). */
  frameNow(): void {
    if (!this.h || !this.canvas) return;
    if (this.frameRequested) cancelAnimationFrame(this.frameRequested);
    this.frameRequested = 0;
    this.frame(performance.now());
  }

  // --- document -------------------------------------------------------------------------------

  /** The blank document: DOCUMENT, the page 0:1 (black) and the internal canvas. */
  loadBlank(): number {
    return this.after(this.x.load(this.h, base64Bytes(BLANK_DOCUMENT_BASE64)));
  }

  applyChanges(nodeChanges: readonly NodeChange[], kind: ApplyKind = "remote"): number {
    if (nodeChanges.length === 0) return Status.OK;
    return this.after(
      this.x.applyChanges(
        this.h,
        json({ type: "NODE_CHANGES", sessionID: 0, nodeChanges }),
        APPLY_FLAGS[kind],
      ),
    );
  }

  readNodes(
    refs: readonly Guid[],
    options: { fields?: readonly string[]; childIds?: boolean; subtree?: boolean } = {},
  ): NodeChange[] {
    const flags = (options.childIds ? INCLUDE_CHILD_IDS : 0) | (options.subtree ? READ_SUBTREE : 0);
    const payload = options.fields ? json({ refs, fields: options.fields }) : json({ refs });
    this.x.readNodes(this.h, payload, flags);
    const message = JSON.parse(decoder.decode(this.x.result()) || "{}") as {
      nodeChanges?: NodeChange[];
    };
    return this.after(message.nodeChanges ?? []);
  }

  readNode(ref: Guid, options: { fields?: readonly string[]; childIds?: boolean } = {}) {
    return this.readNodes([ref], options)[0] ?? null;
  }

  // --- view -----------------------------------------------------------------------------------

  setViewport(cssW: number, cssH: number, dpr: number, pxW: number, pxH: number): void {
    this.after(this.x.setViewport(this.h, cssW, cssH, dpr, pxW, pxH));
  }

  setViewportInsets(left: number, top: number, right: number, bottom: number): void {
    this.after(this.x.setViewportInsets(this.h, left, top, right, bottom));
  }

  setCamera(camera: Camera): void {
    this.after(this.x.setCamera(this.h, camera.x, camera.y, camera.zoom));
  }

  getCamera(): Camera {
    this.x.getCamera(this.h);
    return this.after(JSON.parse(decoder.decode(this.x.result())) as Camera);
  }

  centerOn(x: number, y: number, zoom: number): void {
    this.after(this.x.centerOn(this.h, x, y, zoom));
  }

  setTheme(theme: "LIGHT" | "DARK"): void {
    this.after(this.x.setTheme(this.h, theme === "LIGHT" ? 0 : 1));
  }

  setViewOptions(options: ViewOptionFlags): void {
    const flags =
      VIEW.LAYOUT_GUIDES |
      VIEW.SNAP_GEOMETRY |
      VIEW.FLIP_RESIZE |
      VIEW.RIGHT_DRAG_PAN |
      (options.rulers ? VIEW.RULERS : 0) |
      (options.snapToPixelGrid !== false ? VIEW.SNAP_PIXELS : 0) |
      (options.snapToObjects !== false ? VIEW.SNAP_OBJECTS : 0) |
      (options.showDimensions !== false ? VIEW.SHOW_DIMENSIONS : 0);
    this.after(this.x.setViewOptions(this.h, flags));
  }

  setNudge(small: number, big: number): void {
    this.after(this.x.setNudge(this.h, small, big));
  }

  /**
   * Safe-area bands per frame (the frame's own units), drawn by the engine inside it and
   * following it wherever it is drawn. [] clears them.
   */
  setSafeAreas(
    areas: readonly {
      id: Guid;
      insets: { top: number; right: number; bottom: number; left: number };
      color: { r: number; g: number; b: number; a: number };
    }[],
  ): void {
    const payload = {
      areas: areas.map((a) => ({
        id: a.id,
        insets: [a.insets.top, a.insets.right, a.insets.bottom, a.insets.left],
        color: [a.color.r, a.color.g, a.color.b, a.color.a],
      })),
    };
    this.after(this.x.setSafeAreas(this.h, json(payload)));
  }

  /** Focus view: only `node` (a frame on the page) is drawn and picked; null leaves it. */
  setFocus(node: Guid | null): number {
    const [s, l] = node ? ids(node) : [0xffffffff, 0xffffffff];
    const status = this.x.setFocus(this.h, s, l);
    this.schedule();
    return this.after(status);
  }

  // --- input ----------------------------------------------------------------------------------

  pointer(
    type: number,
    x: number,
    y: number,
    button: number,
    buttons: number,
    mods: number,
    pressure = 0,
    clickCount = 1,
    pointerType = 0,
    timeMs = 0,
  ): number {
    return this.after(
      this.x.pointer(
        this.h,
        type,
        x,
        y,
        button,
        buttons,
        mods,
        pressure,
        clickCount,
        pointerType,
        timeMs,
      ),
    );
  }

  wheel(x: number, y: number, dx: number, dy: number, mode: number, mods: number, flags: number) {
    return this.after(this.x.wheel(this.h, x, y, dx, dy, mode, mods, flags));
  }

  key(type: "down" | "up", code: string, key: string, mods: number, repeat = false): number {
    const codepoint = key.length > 0 && [...key].length === 1 ? (key.codePointAt(0) ?? 0) : 0;
    return this.after(
      this.x.key(
        this.h,
        type === "down" ? KeyType.DOWN : KeyType.UP,
        keyCodeOf(code),
        codepoint,
        mods,
        repeat ? 1 : 0,
      ),
    );
  }

  modifiers(mods: number): void {
    this.after(this.x.modifiers(this.h, mods));
  }

  blur(): void {
    this.after(this.x.blur(this.h));
  }

  setCoalesceMoves(on: boolean): void {
    if (this.h) this.after(this.x.setCoalesceMoves(this.h, on ? 1 : 0));
  }

  setTool(tool: ToolName): number {
    return this.after(this.x.setTool(this.h, TOOLS.indexOf(tool)));
  }

  // --- selection, reads, commands ----------------------------------------------------------------

  getSelection(): Selection {
    this.x.getSelection(this.h);
    return this.after(JSON.parse(decoder.decode(this.x.result())) as Selection);
  }

  setSelection(refs: readonly Guid[]): number {
    return this.after(this.x.setSelection(this.h, json({ refs })));
  }

  setHover(refs: readonly Guid[]): void {
    this.after(this.x.setHover(this.h, json({ refs })));
  }

  /** Nodes under a canvas point (CSS px), top first. */
  hitTest(x: number, y: number): Guid[] {
    this.x.hitTest(this.h, x, y, 0);
    return this.after(
      (JSON.parse(decoder.decode(this.x.result()) || '{"refs":[]}') as { refs: Guid[] }).refs,
    );
  }

  command(name: CommandName, args?: Readonly<Record<string, unknown>>): number {
    return this.after(this.x.command(this.h, CommandId[name], args ? json(args) : null));
  }

  commandState(name: CommandName): number {
    return this.after(this.x.commandState(this.h, CommandId[name]));
  }

  stats(): Record<string, unknown> {
    this.x.stats(this.h);
    return this.after(
      JSON.parse(decoder.decode(this.x.result()) || "{}") as Record<string, unknown>,
    );
  }
}

function ids(ref: Guid): [number, number] {
  const [s, l] = ref.split(":").map(Number);
  return [(s ?? 0) >>> 0, (l ?? 0) >>> 0];
}
