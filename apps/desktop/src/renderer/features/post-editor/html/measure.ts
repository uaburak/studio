// Layer boxes measured in a slide's live document (the frame's own Chromium layout, the same
// engine the worker renders with): each `[data-layer]` element's painted box — centre from its
// bounding box, size from its layout box times the scales on its way to the artboard, angle the
// sum of the turns — plus what the geometry mapping needs (layout size, inherited turn/scale).
import type { MeasuredLayer, SlideMeasure } from "../model/geometry.ts";

const RAD = Math.PI / 180;

/** Turn (deg) and uniform-ish scale one element adds through `rotate`, `scale` and `transform`. */
export function ownTransform(style: CSSStyleDeclaration): {
  angle: number;
  sx: number;
  sy: number;
} {
  let angle = 0;
  let sx = 1;
  let sy = 1;
  const rotate = style.rotate;
  if (rotate && rotate !== "none") {
    const m = /(-?\d*\.?\d+)(deg|rad|turn|grad)?/.exec(rotate);
    if (m) {
      const n = Number(m[1]);
      angle += m[2] === "rad" ? n / RAD : m[2] === "turn" ? n * 360 : m[2] === "grad" ? n * 0.9 : n;
    }
  }
  const scale = style.scale;
  if (scale && scale !== "none") {
    const parts = scale
      .trim()
      .split(/\s+/)
      .map((p) => (p.endsWith("%") ? Number.parseFloat(p) / 100 : Number(p)));
    const a = parts[0];
    if (a !== undefined && Number.isFinite(a)) {
      sx *= a;
      sy *= parts[1] !== undefined && Number.isFinite(parts[1]) ? parts[1] : a;
    }
  }
  const transform = style.transform;
  if (transform && transform !== "none") {
    const m = /matrix\(([^)]+)\)/.exec(transform);
    if (m) {
      const [a = 1, b = 0, c = 0, d = 1] = (m[1] ?? "").split(",").map(Number);
      angle += Math.atan2(b, a) / RAD;
      sx *= Math.hypot(a, b);
      sy *= Math.hypot(c, d);
    }
  }
  return { angle, sx, sy };
}

function layoutSize(el: Element): { w: number; h: number } | null {
  const html = el as HTMLElement;
  if (typeof html.offsetWidth === "number") return { w: html.offsetWidth, h: html.offsetHeight };
  // An inline <svg> layer: its own viewport size.
  const svg = el as SVGSVGElement;
  if (typeof svg.width?.baseVal?.value === "number" && el.tagName.toLowerCase() === "svg") {
    const r = el.getBoundingClientRect();
    return { w: svg.clientWidth || r.width, h: svg.clientHeight || r.height };
  }
  return null;
}

/** Every layer of the document, measured against its artboard. */
export function measureDocument(doc: Document): SlideMeasure {
  const artboard = doc.querySelector("[data-artboard]") ?? doc.body;
  const origin = artboard.getBoundingClientRect();
  const view = doc.defaultView;
  const out: SlideMeasure = {};
  if (!view) return out;
  for (const el of Array.from(doc.querySelectorAll("[data-layer]"))) {
    const id = el.getAttribute("data-layer");
    if (!id || out[id]) continue;
    const style = view.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const size = layoutSize(el) ?? { w: rect.width, h: rect.height };
    const own = ownTransform(style);
    let inheritedAngle = 0;
    let inheritedScale = 1;
    for (let p = el.parentElement; p && p !== artboard && p !== doc.body; p = p.parentElement) {
      const t = ownTransform(view.getComputedStyle(p));
      inheritedAngle += t.angle;
      inheritedScale *= Math.sqrt(Math.abs(t.sx * t.sy)) || 1;
    }
    const displayed = style.display !== "none" && (rect.width > 0 || rect.height > 0);
    const measured: MeasuredLayer = {
      box: {
        cx: rect.left - origin.left + rect.width / 2,
        cy: rect.top - origin.top + rect.height / 2,
        w: size.w * Math.abs(own.sx) * inheritedScale,
        h: size.h * Math.abs(own.sy) * inheritedScale,
        angle: normalize(own.angle + inheritedAngle),
      },
      layout: size,
      inherited: { angle: inheritedAngle, scale: inheritedScale },
      visible: displayed,
    };
    // An unturned box is its bounding box (sub-pixel layout included).
    if (measured.box.angle === 0) {
      measured.box.w = rect.width;
      measured.box.h = rect.height;
    }
    out[id] = measured;
  }
  return out;
}

function normalize(deg: number): number {
  let a = deg % 360;
  if (a <= -180) a += 360;
  if (a > 180) a -= 360;
  return Math.abs(a) < 1e-6 ? 0 : Math.round(a * 1000) / 1000;
}

/** Resolves when the document's fonts and images are ready (so boxes are final). */
export async function documentReady(doc: Document): Promise<void> {
  const images = Array.from(doc.images).filter((img) => !img.complete);
  await Promise.all([
    (doc as Document & { fonts?: FontFaceSet }).fonts?.ready.catch(() => undefined),
    ...images.map(
      (img) =>
        new Promise<void>((resolve) => {
          img.addEventListener("load", () => resolve(), { once: true });
          img.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  ]);
}
