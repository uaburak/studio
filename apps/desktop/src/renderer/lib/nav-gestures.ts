// Back / forward without the keyboard: the mouse's side buttons and a two-finger horizontal
// swipe on the trackpad (like Safari's "swipe between pages"). Electron's BrowserWindow
// "swipe" event only fires when macOS is set to swipe with three fingers, so the two-finger
// swipe is read from wheel events here: one gesture (a stream of wheel events, momentum
// included) that travels far enough sideways, and clearly more sideways than up / down,
// counts once. Gestures over something that scrolls sideways itself, over text fields, or
// marked `data-no-swipe` are left alone.

export type NavDirection = "back" | "forward";

/** Mouse buttons 4 / 5 (`button` 3 / 4): back / forward. */
export function mouseButtonDirection(event: Pick<MouseEvent, "button">): NavDirection | null {
  if (event.button === 3) return "back";
  if (event.button === 4) return "forward";
  return null;
}

export interface WheelSample {
  deltaX: number;
  deltaY: number;
  /** 0 pixels, 1 lines, 2 pages (WheelEvent.deltaMode). */
  deltaMode: number;
  /** Pinch-zoom arrives as a wheel with ctrlKey. */
  ctrlKey: boolean;
  timeStamp: number;
}

/** Sideways travel (px) one gesture needs. */
export const SWIPE_DISTANCE = 220;
/** A pause this long (ms) between wheel events starts a new gesture. */
export const SWIPE_GESTURE_GAP = 240;
/** Vertical travel (px) after which the gesture is a scroll, not a swipe. */
const VERTICAL_LIMIT = 48;

export class SwipeDetector {
  private x = 0;
  private y = 0;
  private last = Number.NEGATIVE_INFINITY;
  /** The gesture already navigated, or it is not a swipe; ignore the rest of it. */
  private done = false;

  /** Feed one wheel event; returns the direction once per qualifying gesture. */
  wheel(sample: WheelSample, blocked = false): NavDirection | null {
    if (sample.timeStamp - this.last > SWIPE_GESTURE_GAP) {
      this.x = 0;
      this.y = 0;
      this.done = false;
    }
    this.last = sample.timeStamp;
    if (this.done) return null;
    if (blocked || sample.ctrlKey) {
      this.done = true;
      return null;
    }
    const scale = sample.deltaMode === 1 ? 16 : sample.deltaMode === 2 ? 400 : 1;
    this.x += sample.deltaX * scale;
    this.y += sample.deltaY * scale;
    const ax = Math.abs(this.x);
    const ay = Math.abs(this.y);
    if (ay > VERTICAL_LIMIT && ay > ax) {
      this.done = true;
      return null;
    }
    if (ax >= SWIPE_DISTANCE && ax > ay * 2.5) {
      this.done = true;
      // Fingers to the right scroll towards the left edge (negative deltaX): back.
      return this.x < 0 ? "back" : "forward";
    }
    return null;
  }
}

/** Whether a swipe starting on `target` belongs to the element itself, not the history. */
export function swipeBlockedAt(target: EventTarget | null): boolean {
  let node = target instanceof Element ? target : null;
  while (node && node !== document.body && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      if (node.dataset.noSwipe !== undefined) return true;
      if (
        node instanceof HTMLInputElement ||
        node instanceof HTMLTextAreaElement ||
        node instanceof HTMLSelectElement ||
        node.isContentEditable
      ) {
        return true;
      }
      if (node.scrollWidth > node.clientWidth + 1) {
        const overflow = getComputedStyle(node).overflowX;
        if (overflow === "auto" || overflow === "scroll") return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}
