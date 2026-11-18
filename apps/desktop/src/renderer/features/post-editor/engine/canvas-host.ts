// Wires the editor's <canvas> to the engine (after Wecra's CanvasController): pointer events with
// capture and click counts, the wheel (trackpad pinch arrives as ctrl + wheel; Figma's source
// rules from the vendored pointerInput), keys, the canvas size in CSS and device pixels, the
// engine's cursors and WebGL context loss. The editor sees every event first (`hooks`): it takes
// double clicks on text (in-place editing in the slide), its own shortcuts and drops onto the
// canvas; the rest goes straight to the engine (no React state on the way).
import {
  KEY_HANDLED,
  MOD_ALT,
  MOD_CTRL,
  MOD_META,
  MOD_PRIMARY,
  MOD_SHIFT,
  POINTER_CAPTURE,
  POINTER_HANDLED,
  PointerType,
  WHEEL_PINCH,
} from "../../../vendor/wecra-engine/abi.ts";
import { cssCursor } from "../../../vendor/wecra-engine/cursors.ts";
import {
  CLICK_MS,
  pinchDelta,
  TouchPinch,
  WheelNormalizer,
  withinClickBox,
} from "../../../vendor/wecra-engine/pointerInput.ts";
import type { StudioEngine } from "./studio-engine.ts";

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function modifiersOf(e: {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): number {
  return (
    (e.shiftKey ? MOD_SHIFT : 0) |
    (e.altKey ? MOD_ALT : 0) |
    (e.ctrlKey ? MOD_CTRL : 0) |
    (e.metaKey ? MOD_META : 0) |
    ((IS_MAC ? e.metaKey : e.ctrlKey) ? MOD_PRIMARY : 0)
  );
}

/** Keys the engine handles itself (everything else is the editor's or nobody's). */
const ENGINE_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Escape",
  "Tab",
  "Space",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "ControlLeft",
  "ControlRight",
]);

export interface CanvasHooks {
  /** A press before the engine sees it (canvas CSS px, click count); true: taken. */
  pointerDown?(e: PointerEvent, x: number, y: number, clicks: number): boolean;
  /** A key before the engine; true: taken. */
  keyDown?(e: KeyboardEvent): boolean;
  /** After every gesture's end (pointer up / cancel). */
  pointerUp?(): void;
  /** The canvas's size changed (CSS px). */
  resized?(width: number, height: number): void;
}

const POINTER_KIND: Record<string, number> = { mouse: 0, pen: 1, touch: 2 };
const OFF_CANVAS = -1e5;

export class CanvasHost {
  private readonly cleanups: (() => void)[] = [];
  private readonly wheelInput = new WheelNormalizer({ mac: IS_MAC, windows: false });
  private readonly pinch = new TouchPinch();
  private lastDown = { t: -1e9, x: 0, y: 0, button: -1, count: 0 };
  /** A press is down on the canvas (a gesture may be running). */
  pressed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly engine: StudioEngine,
    private readonly hooks: CanvasHooks = {},
  ) {}

  attach(): () => void {
    const c = this.canvas;
    c.tabIndex = 0;
    c.style.touchAction = "none";
    c.style.outline = "none";
    this.listen(c, "pointerdown", this.onPointerDown);
    this.listen(c, "pointermove", this.onPointerMove);
    this.listen(c, "pointerup", this.onPointerUp);
    this.listen(c, "pointercancel", this.onPointerCancel);
    this.listen(c, "pointerenter", (e: PointerEvent) => void this.send(PointerType.ENTER, e));
    this.listen(c, "pointerleave", this.onPointerLeave);
    this.listen(c, "wheel", this.onWheel, { passive: false });
    this.listen(c, "keydown", this.onKeyDown);
    this.listen(c, "keyup", this.onKeyUp);
    this.listen(c, "blur", () => this.engine.blur());
    this.listen(window, "blur", () => this.engine.blur());
    this.listen(c, "contextmenu", (e: Event) => e.preventDefault());
    this.listen(c, "webglcontextlost", (e: Event) => e.preventDefault());
    this.cleanups.push(
      this.engine.on("CURSOR", (e) => {
        c.style.cursor = cssCursor(e.kind, e.angleDeg);
      }),
    );
    this.observeSize();
    this.engine.setCoalesceMoves(true);
    this.cleanups.push(() => this.engine.setCoalesceMoves(false));
    return () => this.detach();
  }

  detach(): void {
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private listen<E extends Event>(
    target: EventTarget,
    type: string,
    handler: (e: E) => void,
    options?: AddEventListenerOptions,
  ): void {
    const h = handler as EventListener;
    target.addEventListener(type, h, options);
    this.cleanups.push(() => target.removeEventListener(type, h, options));
  }

  private observeSize(): void {
    const c = this.canvas;
    let last = "";
    const apply = (cssW: number, cssH: number, pxW: number, pxH: number, draw = true) => {
      if (this.engine.destroyed || cssW <= 0 || cssH <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const key = `${cssW} ${cssH} ${dpr} ${pxW} ${pxH}`;
      if (key === last) return;
      last = key;
      this.engine.setViewport(cssW, cssH, dpr, Math.max(1, pxW), Math.max(1, pxH));
      this.hooks.resized?.(cssW, cssH);
      if (draw) this.engine.frameNow();
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const css = entry.contentBoxSize?.[0];
      const cssW = css ? css.inlineSize : entry.contentRect.width;
      const cssH = css ? css.blockSize : entry.contentRect.height;
      const device = entry.devicePixelContentBoxSize?.[0];
      const dpr = window.devicePixelRatio || 1;
      const exact = (px: number | undefined, v: number) =>
        px !== undefined && Math.abs(px - v * dpr) <= 2 ? px : Math.round(v * dpr);
      apply(cssW, cssH, exact(device?.inlineSize, cssW), exact(device?.blockSize, cssH));
    });
    try {
      observer.observe(c, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(c);
    }
    this.cleanups.push(() => observer.disconnect());
    const rect = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    apply(
      rect.width,
      rect.height,
      Math.round(rect.width * dpr),
      Math.round(rect.height * dpr),
      false,
    );
  }

  at(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  private clickCount(e: PointerEvent): number {
    const [x, y] = this.at(e);
    const l = this.lastDown;
    const near =
      e.timeStamp - l.t < CLICK_MS &&
      withinClickBox(x - l.x, y - l.y, e.pointerType === "touch") &&
      e.button === l.button;
    const count = Math.max(e.detail || 0, near ? l.count + 1 : 1);
    this.lastDown = { t: e.timeStamp, x, y, button: e.button, count };
    return count;
  }

  private send(type: number, e: PointerEvent, clicks = this.lastDown.count || 1): number {
    const [x, y] = this.at(e);
    return this.engine.pointer(
      type,
      x,
      y,
      e.button,
      e.buttons,
      modifiersOf(e),
      e.pressure,
      clicks,
      POINTER_KIND[e.pointerType] ?? 0,
      e.timeStamp,
    );
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.canvas.focus({ preventScroll: true });
    if (e.pointerType === "touch") {
      const [x, y] = this.at(e);
      if (this.pinch.down(e.pointerId, x, y)) this.send(PointerType.CANCEL, e);
      if (this.pinch.active) {
        this.canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
    }
    const clicks = this.clickCount(e);
    const [x, y] = this.at(e);
    if (this.hooks.pointerDown?.(e, x, y, clicks)) {
      e.preventDefault();
      this.swallowed = true;
      return;
    }
    this.swallowed = false;
    this.pressed = true;
    const r = this.send(PointerType.DOWN, e, clicks);
    if (r & POINTER_CAPTURE) this.canvas.setPointerCapture(e.pointerId);
    if (r & POINTER_HANDLED) e.preventDefault();
  };

  private readonly onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === "touch" && this.pinchMove(e)) return;
    this.send(PointerType.MOVE, e);
  };

  /** The editor took the last press: its release is not the engine's either. */
  private swallowed = false;

  private readonly onPointerUp = (e: PointerEvent) => {
    if (e.pointerType === "touch" && this.pinchEnd(e)) return;
    if (this.swallowed) {
      this.swallowed = false;
      return;
    }
    const r = this.send(PointerType.UP, e);
    if (r & POINTER_HANDLED) e.preventDefault();
    this.pressed = false;
    this.hooks.pointerUp?.();
  };

  private readonly onPointerCancel = (e: PointerEvent) => {
    if (e.pointerType === "touch" && this.pinchEnd(e)) return;
    this.send(PointerType.CANCEL, e);
    this.pressed = false;
    this.hooks.pointerUp?.();
  };

  private readonly onPointerLeave = (e: PointerEvent) => {
    if (!e.buttons)
      this.engine.pointer(
        PointerType.MOVE,
        OFF_CANVAS,
        OFF_CANVAS,
        e.button,
        0,
        modifiersOf(e),
        e.pressure,
        this.lastDown.count || 1,
        POINTER_KIND[e.pointerType] ?? 0,
        e.timeStamp,
      );
    this.send(PointerType.LEAVE, e);
  };

  private pinchMove(e: PointerEvent): boolean {
    const [x, y] = this.at(e);
    const step = this.pinch.move(e.pointerId, x, y);
    if (!this.pinch.active) return false;
    if (!step) return true;
    if (step.panX || step.panY) {
      const c = this.engine.getCamera();
      this.engine.setCamera({ ...c, x: c.x + step.panX, y: c.y + step.panY });
    }
    if (step.ratio !== 1)
      this.engine.wheel(
        step.cx,
        step.cy,
        0,
        pinchDelta(step.ratio),
        0,
        modifiersOf(e),
        WHEEL_PINCH | 2,
      );
    return true;
  }

  private pinchEnd(e: PointerEvent): boolean {
    const was = this.pinch.active;
    this.pinch.up(e.pointerId);
    return was;
  }

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const [x, y] = this.at(e);
    const w = this.wheelInput.normalize({
      dx: e.deltaX,
      dy: e.deltaY,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      t: e.timeStamp,
    });
    this.engine.wheel(
      x,
      y,
      w.dx,
      w.dy,
      e.deltaMode,
      modifiersOf(e),
      (e.ctrlKey ? WHEEL_PINCH : 0) | w.source,
    );
  };

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return;
    if (this.hooks.keyDown?.(e)) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!ENGINE_KEYS.has(e.code)) return;
    if (this.engine.key("down", e.code, e.key, modifiersOf(e), e.repeat) & KEY_HANDLED) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (!ENGINE_KEYS.has(e.code)) return;
    if (this.engine.key("up", e.code, e.key, modifiersOf(e)) & KEY_HANDLED) e.preventDefault();
  };
}
