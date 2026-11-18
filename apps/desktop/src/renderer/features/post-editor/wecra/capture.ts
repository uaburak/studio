// Reading a slide as the browser laid it out (E11): Wecra's DOM walker (its boxes, fills, text
// runs, pictures) plus what the walker doesn't read and Wecra's document can still hold — CSS
// transforms, stacking (z-index), text shadows, a picture's object-position / object-fit and
// natural size, background sizes and positions, blend modes, filters, clip paths, balanced line
// breaks, the text of ::before / ::after. `fidelity.ts` turns these into Wecra layer properties
// (or into the import report when Wecra has no model for them).
//
// Transforms are taken off before the walker runs (`transform: none`, as `rotate`, `scale`,
// `translate`): the walker then reads every box as laid out, untransformed (its own boxes are the
// transformed bounding boxes), and the transform is put back on the Wecra layer.
//
// `captureInWindow` is self-contained (no imports, nothing from outside its arguments): the import
// runs it on a slide's hidden frame, the fidelity test in Chromium (its source, evaluated there).
import type { WNode } from "@shared/agents/web/convert";

/** A ::before / ::after's text (CSS `content`), with its type. */
export interface PseudoText {
  text: string;
  font: string;
  size: number;
  weight: number;
  color: string;
  lh: number | null;
  ls: number;
  italic: boolean;
}

/** What Studio reads of one captured element (the walker's `els[i]`) besides the walker. */
export interface ElementExtras {
  /** The contract layer it belongs to (its own `data-layer` or its nearest ancestor's). */
  layer: string | null;
  /** Its own `data-layer`, when it has one. */
  own: string | null;
  /** The contract layer's `data-type` (text, image, logo, slot, shape, group). */
  layerType: string | null;
  tag: string;
  /** Its text colour as computed. */
  color: string;
  /** CSS transform (with rotate / scale / translate) as matrix(a, b, c, d, e, f) and its origin (px). */
  tf?: { m: number[]; o: [number, number] };
  position: string;
  zIndex: string;
  textShadow?: string;
  objectFit?: string;
  objectPosition?: string;
  /** An <img>'s natural size. */
  natural?: [number, number];
  bgSize?: string;
  bgPosition?: string;
  bgRepeat?: string;
  bgClip?: string;
  bgBlend?: string;
  /** Natural sizes of the url() layers of background-image, in order (null: not loaded). */
  bgNatural?: ([number, number] | null)[];
  blend?: string;
  filter?: string;
  backdrop?: string;
  clipPath?: string;
  mask?: string;
  /** text-wrap: balance / pretty, with the lines the browser broke into (each text run's). */
  balanced?: { text: string; lines: string[] }[];
  /** The slot's state (data-type="slot"): its placeholder is only drawn while empty. */
  slotEmpty?: boolean;
  lang?: string;
  textTransform?: string;
  before?: PseudoText;
  after?: PseudoText;
  /** Two or more text runs side by side (inline elements in one paragraph) that wrap. */
  mixedWrap?: boolean;
}

export interface CaptureResult {
  tree: WNode | null;
  extras: ElementExtras[];
  /** The page's background when the artboard leaves it to the body. */
  bodyBackground: string;
}

/** Wecra's walker on a window (`studio/walker.mjs installWalker`). */
export type InstallWalker = (win: Window) => unknown;

/** Reads `root` in `win` with Wecra's walker and the extras above. Self-contained (see the top). */
export async function captureInWindow(
  win: Window,
  install: InstallWalker,
  root: Element,
): Promise<CaptureResult> {
  const doc = win.document;
  const css = (el: Element, pseudo?: string) => win.getComputedStyle(el, pseudo);
  const num = (v: string | null | undefined) => {
    const n = Number.parseFloat(v ?? "");
    return Number.isFinite(n) ? n : 0;
  };
  /** matrix() / matrix3d() → [a, b, c, d, e, f] (3D: its 2D part). */
  const matrixOf = (t: string): number[] | null => {
    if (!t || t === "none") return null;
    const m2 = /^matrix\(([^)]+)\)$/.exec(t);
    if (m2) return (m2[1] ?? "").split(",").map((x) => Number.parseFloat(x));
    const m3 = /^matrix3d\(([^)]+)\)$/.exec(t);
    if (m3) {
      const v = (m3[1] ?? "").split(",").map((x) => Number.parseFloat(x));
      return [v[0] ?? 1, v[1] ?? 0, v[4] ?? 0, v[5] ?? 1, v[12] ?? 0, v[13] ?? 0];
    }
    return null;
  };
  const mul = (p: number[], q: number[]): number[] => {
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = p;
    const [A = 1, B = 0, C = 0, D = 1, E = 0, F = 0] = q;
    return [
      a * A + c * B,
      b * A + d * B,
      a * C + c * D,
      b * C + d * D,
      a * E + c * F + e,
      b * E + d * F + f,
    ];
  };
  /** translate / rotate / scale (the individual properties) then transform, as CSS composes them. */
  const fullMatrix = (cs: CSSStyleDeclaration, box: { w: number; h: number }): number[] | null => {
    let m = [1, 0, 0, 1, 0, 0];
    let any = false;
    const tr = cs.getPropertyValue("translate");
    if (tr && tr !== "none") {
      const [x = "0", y = "0"] = tr.split(/\s+/);
      const px = (v: string, size: number) => (v.endsWith("%") ? (num(v) / 100) * size : num(v));
      m = mul(m, [1, 0, 0, 1, px(x, box.w), px(y, box.h)]);
      any = true;
    }
    const rot = cs.getPropertyValue("rotate");
    if (rot && rot !== "none") {
      const parts = rot.trim().split(/\s+/);
      const angle = parts[parts.length - 1] ?? "0deg";
      const deg = angle.endsWith("turn")
        ? num(angle) * 360
        : angle.endsWith("rad")
          ? (num(angle) * 180) / Math.PI
          : num(angle);
      // A 3D axis other than z: only its 2D effect is taken (none for x / y).
      if (parts.length === 1 || parts[0] === "z" || /^0 0 1/.test(rot)) {
        const r = (deg * Math.PI) / 180;
        m = mul(m, [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]);
        any = true;
      }
    }
    const sc = cs.getPropertyValue("scale");
    if (sc && sc !== "none") {
      const [sx = "1", sy] = sc.split(/\s+/);
      const k = (v: string) => (v.endsWith("%") ? num(v) / 100 : num(v));
      m = mul(m, [k(sx), 0, 0, k(sy ?? sx), 0, 0]);
      any = true;
    }
    const t = matrixOf(cs.transform);
    if (t) {
      m = mul(m, t);
      any = true;
    }
    return any ? m : null;
  };

  // 1. Transforms off (recorded), so every box is read as laid out.
  const transforms = new Map<Element, { m: number[]; o: [number, number] }>();
  const all = [root, ...Array.from(root.querySelectorAll("*"))];
  for (const el of all) {
    if (el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName.toLowerCase() !== "svg")
      continue;
    const cs = css(el);
    const html = el as HTMLElement;
    const box = { w: html.offsetWidth ?? 0, h: html.offsetHeight ?? 0 };
    const m = fullMatrix(cs, box);
    if (!m) continue;
    const [ox = "0", oy = "0"] = cs.transformOrigin.split(/\s+/);
    transforms.set(el, { m, o: [num(ox), num(oy)] });
  }
  for (const el of transforms.keys()) {
    const s = (el as HTMLElement).style;
    for (const p of ["transform", "rotate", "scale", "translate"])
      s.setProperty(p, "none", "important");
  }

  // 2. Wecra's walker.
  const uikit = install(win) as {
    capture(el: Element, viewportClip: boolean): WNode | null;
    els: Element[];
  };
  const tree = uikit.capture(root, false);
  const els = uikit.els;

  // 3. The rest, per captured element.
  const bodyBg = css(doc.body).backgroundColor;
  const natural = async (url: string): Promise<[number, number] | null> => {
    try {
      const img = new (win as unknown as { Image: typeof Image }).Image();
      img.src = url;
      await img.decode();
      return [img.naturalWidth, img.naturalHeight];
    } catch {
      return null;
    }
  };
  const pseudoText = (el: Element, which: "::before" | "::after"): PseudoText | undefined => {
    const cs = css(el, which);
    const content = cs.content;
    if (!content || content === "none" || content === "normal" || cs.display === "none") return;
    let text = "";
    const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|attr\(\s*([\w-]+)\s*\)/g;
    for (let m = re.exec(content); m; m = re.exec(content))
      text += m[3] ? (el.getAttribute(m[3]) ?? "") : (m[1] ?? m[2] ?? "").replace(/\\(.)/g, "$1");
    if (!text.trim()) return;
    return {
      text,
      font: cs.fontFamily,
      size: num(cs.fontSize),
      weight: Number(cs.fontWeight) || 400,
      color: cs.color,
      lh: cs.lineHeight === "normal" ? null : num(cs.lineHeight),
      ls: cs.letterSpacing === "normal" ? 0 : num(cs.letterSpacing),
      italic: cs.fontStyle === "italic",
    };
  };
  /** A text node's lines as the browser broke them (words by their first glyph's line). */
  const linesOf = (node: Text): string[] => {
    const raw = node.textContent ?? "";
    const range = doc.createRange();
    const lines: string[][] = [];
    let top: number | null = null;
    const re = /\S+/g;
    for (let m = re.exec(raw); m; m = re.exec(raw)) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + 1);
      const r = range.getClientRects()[0];
      if (!r) continue;
      if (top === null || r.top > top + r.height / 2) {
        lines.push([]);
        top = r.top;
      }
      lines[lines.length - 1]?.push(m[0]);
    }
    return lines.map((l) => l.join(" "));
  };
  const textRuns = (el: Element): Text[] =>
    Array.from(el.childNodes).filter(
      (n): n is Text => n.nodeType === 3 && !!n.textContent && !!n.textContent.trim(),
    );

  const extras: ElementExtras[] = [];
  for (const el of els) {
    const cs = css(el);
    const owner = el.closest("[data-layer]");
    const x: ElementExtras = {
      layer: owner?.getAttribute("data-layer") ?? null,
      own: el.getAttribute("data-layer"),
      layerType: owner?.getAttribute("data-type") ?? null,
      tag: el.tagName.toLowerCase(),
      color: cs.color,
      position: cs.position,
      zIndex: cs.zIndex,
    };
    const tf = transforms.get(el);
    if (tf) x.tf = tf;
    if (cs.textShadow && cs.textShadow !== "none") x.textShadow = cs.textShadow;
    if (el.tagName === "IMG") {
      const img = el as HTMLImageElement;
      x.objectFit = cs.objectFit;
      x.objectPosition = cs.objectPosition;
      if (img.naturalWidth && img.naturalHeight) x.natural = [img.naturalWidth, img.naturalHeight];
    }
    if (cs.backgroundImage && cs.backgroundImage !== "none") {
      x.bgSize = cs.backgroundSize;
      x.bgPosition = cs.backgroundPosition;
      x.bgRepeat = cs.backgroundRepeat;
      x.bgBlend = cs.backgroundBlendMode;
      const urls = Array.from(cs.backgroundImage.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g));
      if (urls.length) x.bgNatural = await Promise.all(urls.map((u) => natural(u[1] ?? "")));
    }
    const clip = cs.backgroundClip || cs.getPropertyValue("-webkit-background-clip");
    if (clip && clip !== "border-box") x.bgClip = clip;
    if (cs.mixBlendMode && cs.mixBlendMode !== "normal") x.blend = cs.mixBlendMode;
    if (cs.filter && cs.filter !== "none") x.filter = cs.filter;
    const backdrop = cs.backdropFilter || cs.getPropertyValue("-webkit-backdrop-filter");
    if (backdrop && backdrop !== "none") x.backdrop = backdrop;
    if (cs.clipPath && cs.clipPath !== "none") x.clipPath = cs.clipPath;
    const mask = cs.maskImage || cs.getPropertyValue("-webkit-mask-image");
    if (mask && mask !== "none") x.mask = mask;
    if (el.getAttribute("data-type") === "slot")
      x.slotEmpty = el.getAttribute("data-slot-state") !== "filled";
    const lang = el.closest("[lang]")?.getAttribute("lang");
    if (lang) x.lang = lang;
    if (cs.textTransform && cs.textTransform !== "none") x.textTransform = cs.textTransform;
    const wrap = `${cs.getPropertyValue("text-wrap-style") || ""} ${cs.getPropertyValue("text-wrap") || ""}`;
    const runs = textRuns(el);
    if (/balance|pretty/.test(wrap) && runs.length) {
      x.balanced = runs.map((n) => ({
        text: (n.textContent ?? "").replace(/\s+/g, " ").trim(),
        lines: linesOf(n),
      }));
    }
    // Inline elements beside text in one paragraph: the walker reads each run apart.
    const inline = Array.from(el.children).some((c) => /^inline/.test(css(c).display));
    if (inline && runs.length && runs.some((n) => linesOf(n).length > 1)) x.mixedWrap = true;
    const before = pseudoText(el, "::before");
    if (before) x.before = before;
    const after = pseudoText(el, "::after");
    if (after) x.after = after;
    extras.push(x);
  }
  return { tree, extras, bodyBackground: bodyBg };
}
