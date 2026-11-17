// Lightbox paging and zoom (pure). ‹ › and ←/→ move between the images of one group,
// Space toggles zoom, Esc closes (zoomed: un-zoom first).

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

/** CSS transform that maps `to` onto `from` (the thumbnail), for the zoom-from-thumbnail open. */
export function flipTransform(from: Rect, to: Rect): string {
  const sx = from.width / Math.max(1, to.width);
  const sy = from.height / Math.max(1, to.height);
  const dx = from.x - to.x;
  const dy = from.y - to.y;
  return `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
}
