// The thumbnail side of the image viewer's zoom: which `<img>` a thumbnail is, where it sits on
// screen with its corner radii (for the picture to fly out of and back into), and hiding it while
// the viewer shows its picture (Photos leaves the spot empty).
import {
  type Corners,
  containRect,
  type Frame,
  parseRadius,
  type Rect,
  visibleFraction,
} from "./lightbox.ts";

/** Below this share on screen the viewer fades instead of zooming (scrolled away). */
const MIN_VISIBLE = 0.5;

/** The `<img>` a thumbnail element stands for (the element itself when it has none). */
export function sourceImage(el: Element | null | undefined): HTMLElement | null {
  if (!(el instanceof HTMLElement)) return null;
  if (el instanceof HTMLImageElement) return el;
  return el.querySelector("img") ?? el;
}

/** A loaded `<img>`'s pixel size. */
export function naturalSizeOf(el: HTMLElement | null): { width: number; height: number } | null {
  if (!(el instanceof HTMLImageElement) || !el.naturalWidth || !el.naturalHeight) return null;
  return { width: el.naturalWidth, height: el.naturalHeight };
}

const isClipping = (overflow: string) =>
  overflow === "hidden" || overflow === "auto" || overflow === "scroll" || overflow === "clip";

const toRect = (r: DOMRect): Rect => ({ x: r.left, y: r.top, width: r.width, height: r.height });

/** Where the thumbnail shows its picture, with its corner radii; null when it is gone, empty or
 *  mostly out of view (the viewer then fades in / out instead). */
export function measureSource(el: HTMLElement | null): Frame | null {
  if (!el?.isConnected) return null;
  const box = el.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return null;
  let rect = toRect(box);
  const natural = naturalSizeOf(el);
  if (natural && getComputedStyle(el).objectFit === "contain") rect = containRect(rect, natural);
  const clips: Rect[] = [{ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }];
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (isClipping(s.overflowX) || isClipping(s.overflowY))
      clips.push(toRect(p.getBoundingClientRect()));
  }
  if (visibleFraction(rect, clips) < MIN_VISIBLE) return null;
  return { ...rect, radius: cornersOf(el, rect) };
}

/** The rounding the picture shows at each corner: its own, or a clipping ancestor's whose corner
 *  meets the picture's (a tile's `rounded-*` + `overflow-hidden`, a card's top corners). */
function cornersOf(el: HTMLElement, rect: Rect): Corners {
  const radius: Corners = [0, 0, 0, 0];
  const mine = corners(rect);
  let node: HTMLElement | null = el;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const s = getComputedStyle(node);
    if (node !== el && !isClipping(s.overflowX) && !isClipping(s.overflowY)) continue;
    const box = toRect(node.getBoundingClientRect());
    const theirs = corners(box);
    const values = [
      s.borderTopLeftRadius,
      s.borderTopRightRadius,
      s.borderBottomRightRadius,
      s.borderBottomLeftRadius,
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, ay] = mine[i] as [number, number];
      const [bx, by] = theirs[i] as [number, number];
      if (radius[i] === 0 && Math.abs(ax - bx) <= 1.5 && Math.abs(ay - by) <= 1.5) {
        radius[i] = parseRadius(values[i] ?? "", box.width, box.height);
      }
    }
  }
  return radius;
}

function corners(r: Rect): [number, number][] {
  const right = r.x + r.width;
  const bottom = r.y + r.height;
  return [
    [r.x, r.y],
    [right, r.y],
    [right, bottom],
    [r.x, bottom],
  ];
}

// Hidden thumbnails (counted: a closing viewer and a new one may share one).
const hidden = new Map<HTMLElement, number>();

export function concealSource(el: HTMLElement | null): void {
  if (!el) return;
  const n = hidden.get(el) ?? 0;
  hidden.set(el, n + 1);
  if (n === 0) el.style.visibility = "hidden";
}

export function revealSource(el: HTMLElement | null): void {
  if (!el || !hidden.has(el)) return;
  const n = (hidden.get(el) ?? 1) - 1;
  if (n > 0) {
    hidden.set(el, n);
    return;
  }
  hidden.delete(el);
  el.style.visibility = "";
}
