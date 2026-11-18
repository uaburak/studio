// Lightbox paging, zoom and the zoom transition's geometry (pure). ‹ › and ←/→ move between the
// images of one group, Space toggles zoom, Esc closes (zoomed: un-zoom first); the picture flies
// between its thumbnail's frame and the fitted frame, and a drag down dismisses it.

export interface LightboxState {
  index: number;
  count: number;
  zoomed: boolean;
}

export type LightboxAction =
  | { kind: "next" }
  | { kind: "prev" }
  | { kind: "go"; index: number }
  | { kind: "toggleZoom" }
  | { kind: "close" };

export function canGoPrev(state: LightboxState): boolean {
  return state.index > 0;
}

export function canGoNext(state: LightboxState): boolean {
  return state.index < state.count - 1;
}

/** Returns the next state, or null when the lightbox closes. */
export function reduceLightbox(state: LightboxState, action: LightboxAction): LightboxState | null {
  switch (action.kind) {
    case "next":
      return canGoNext(state) ? { ...state, index: state.index + 1, zoomed: false } : state;
    case "prev":
      return canGoPrev(state) ? { ...state, index: state.index - 1, zoomed: false } : state;
    case "go": {
      const index = Math.min(Math.max(action.index, 0), Math.max(state.count - 1, 0));
      return { ...state, index, zoomed: false };
    }
    case "toggleZoom":
      return { ...state, zoomed: !state.zoomed };
    case "close":
      return state.zoomed ? { ...state, zoomed: false } : null;
  }
}

/** Keyboard → action (null: not ours). */
export function lightboxKey(key: string): LightboxAction | null {
  switch (key) {
    case "ArrowRight":
      return { kind: "next" };
    case "ArrowLeft":
      return { kind: "prev" };
    case " ":
      return { kind: "toggleZoom" };
    case "Escape":
      return { kind: "close" };
    default:
      return null;
  }
}

/** "2 / 5". */
export function counterText(state: LightboxState): string {
  return `${state.index + 1} / ${state.count}`;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The image's frame when fitted into the viewport (keeps aspect; never upscales past 1:1·2). */
export function fitRect(
  natural: { width: number; height: number },
  viewport: { width: number; height: number },
  insets = { top: 64, bottom: 72, side: 64 },
): Rect {
  const maxW = Math.max(1, viewport.width - insets.side * 2);
  const maxH = Math.max(1, viewport.height - insets.top - insets.bottom);
  const w = natural.width || maxW;
  const h = natural.height || maxH;
  const scale = Math.min(maxW / w, maxH / h, 2);
  const width = w * scale;
  const height = h * scale;
  return {
    x: (viewport.width - width) / 2,
    y: insets.top + (maxH - height) / 2,
    width,
    height,
  };
}

/** Corner radii in px: top-left, top-right, bottom-right, bottom-left. */
export type Corners = [number, number, number, number];

/** A frame of the moving picture: its box on screen and its corner radii. */
export interface Frame extends Rect {
  radius: Corners;
}

/** The viewer's corner radius (the thumbnail's radius morphs into it). */
export const VIEWER_RADIUS = 12;

/** The fitted frame of the viewer. */
export function viewerFrame(fit: Rect): Frame {
  const r = VIEWER_RADIUS;
  return { ...fit, radius: [r, r, r, r] };
}

/** The picture box `object-fit: contain` draws inside `box` (logos). */
export function containRect(box: Rect, natural: { width: number; height: number }): Rect {
  if (natural.width <= 0 || natural.height <= 0) return box;
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const width = natural.width * scale;
  const height = natural.height * scale;
  return {
    x: box.x + (box.width - width) / 2,
    y: box.y + (box.height - height) / 2,
    width,
    height,
  };
}

/** How much of `rect` shows through its clipping boxes (the window, scrolled lists): 0…1. */
export function visibleFraction(rect: Rect, clips: readonly Rect[]): number {
  if (rect.width <= 0 || rect.height <= 0) return 0;
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  for (const c of clips) {
    left = Math.max(left, c.x);
    top = Math.max(top, c.y);
    right = Math.min(right, c.x + c.width);
    bottom = Math.min(bottom, c.y + c.height);
  }
  const area = Math.max(0, right - left) * Math.max(0, bottom - top);
  return area / (rect.width * rect.height);
}

/** A computed corner radius ("12px", "50%", "8px 12px", Tailwind's infinite "full") → px. */
export function parseRadius(value: string, width: number, height: number): number {
  const first = value.trim().split(/\s+/)[0] ?? "";
  const n = Number.parseFloat(first);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const side = Math.min(width, height);
  const px = first.endsWith("%") ? (n / 100) * side : n;
  return Math.min(px, side / 2);
}

/** `frame` scaled about its centre, then moved: where it shows with that transform applied.
 *  A close starts from it, so it leaves exactly where a drag or a zoom left the picture. */
export function bakeTransform(frame: Frame, t: { x: number; y: number; scale: number }): Frame {
  const width = frame.width * t.scale;
  const height = frame.height * t.scale;
  return {
    x: frame.x + (frame.width - width) / 2 + t.x,
    y: frame.y + (frame.height - height) / 2 + t.y,
    width,
    height,
    radius: frame.radius.map((r) => r * t.scale) as Corners,
  };
}

/** Drag to dismiss (Photos): the picture follows the pointer (upward damped) and shrinks as it
 *  goes down; `progress` (0…1) also clears the scrim. */
export function dismissDrag(
  dx: number,
  dy: number,
  viewportHeight: number,
): { x: number; y: number; scale: number; progress: number } {
  const progress = Math.min(Math.max(dy / Math.max(1, viewportHeight * 0.5), 0), 1);
  return { x: dx, y: dy >= 0 ? dy : dy * 0.3, scale: 1 - 0.4 * progress, progress };
}

export const DISMISS_DISTANCE = 110;
export const DISMISS_VELOCITY = 600;

/** On release: close (far enough down, or flicked down) or spring back. Velocity in px/s. */
export function shouldDismiss(dy: number, velocityY: number): boolean {
  if (velocityY < -200) return false;
  return dy > DISMISS_DISTANCE || (dy > 16 && velocityY > DISMISS_VELOCITY);
}
