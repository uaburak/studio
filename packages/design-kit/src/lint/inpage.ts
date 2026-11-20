/**
 * Layout checks that need a laid-out document. `studioInPageLint` is SELF-CONTAINED: no
 * imports, no references to module scope. The renderer injects it as a script string
 * (`IN_PAGE_LINT_SCRIPT`); the web editor can call it directly with the preview iframe's
 * document (`studioInPageLint(input, iframe.contentDocument)`), because a sandboxed
 * `allow-same-origin` preview is readable from the parent page.
 *
 * It returns raw findings without severities; the orchestrator (`lintSlide`) assigns
 * severities from the rule registry and adds pixel and geometry checks.
 */

export interface InPageRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InPageInput {
  width: number;
  height: number;
  safe: { top: number; right: number; bottom: number; left: number };
  minFont: number;
  warnFont: number;
  legalMinFont: number;
  /** Brand font families; `null` skips the font-family rule. */
  brandFonts: string[] | null;
  /** Brand families that must be installed fonts (checked for `font-missing`); optional. */
  systemFonts?: string[];
}

export interface InPageFinding {
  rule: string;
  layer: string | null;
  message: string;
  data?: Record<string, unknown>;
}

export interface InPageTextRun {
  color: string;
  fontSize: number;
  weight: string;
  rects: InPageRect[];
}

export interface InPageText {
  id: string;
  role: string | null;
  lines: number;
  lineRects: InPageRect[];
  fontSize: number;
  minFontSize: number;
  weight: string;
  family: string;
  color: string;
  clipText: boolean;
  textRect: InPageRect;
  chars: number;
  runs: InPageTextRun[];
}

export type InPageBoxKind = "text" | "image" | "logo" | "slot" | "shape" | "background";

export interface InPageBox {
  layer: string;
  kind: InPageBoxKind;
  rect: InPageRect;
}

export interface InPageLayer {
  id: string;
  type: string;
  role: string | null;
  parent: string | null;
  rect: InPageRect;
  visible: boolean;
}

export interface InPageResult {
  findings: InPageFinding[];
  layers: InPageLayer[];
  text: InPageText[];
  boxes: InPageBox[];
  logos: { id: string; src: string; rect: InPageRect }[];
  fontsLoaded: string[];
}

export function studioInPageLint(input: InPageInput, docArg?: Document): InPageResult {
  const doc: Document = docArg ?? document;
  const win = (doc.defaultView ?? window) as Window & typeof globalThis;
  const { width, height, safe } = input;
  const findings: InPageFinding[] = [];
  const add = (
    rule: string,
    layer: string | null,
    message: string,
    data?: Record<string, unknown>,
  ) => findings.push(data ? { rule, layer, message, data } : { rule, layer, message });
  const round = (n: number) => Math.round(n);
  const box = (r: { left: number; top: number; width: number; height: number }): InPageRect => ({
    x: round(r.left),
    y: round(r.top),
    w: round(r.width),
    h: round(r.height),
  });
  const cssOf = (el: Element) => win.getComputedStyle(el);
  const layerOf = (el: Element | null): string | null =>
    el ? (el.closest("[data-layer]")?.getAttribute("data-layer") ?? null) : null;
  const SHOW_TEXT = 4;

  // ---------- artboard ----------
  const artboards = doc.querySelectorAll("[data-artboard]");
  const ab = (artboards[0] as HTMLElement | undefined) ?? doc.body;
  const abr = ab.getBoundingClientRect();
  if (
    round(abr.width) !== width ||
    round(abr.height) !== height ||
    round(abr.left) !== 0 ||
    round(abr.top) !== 0
  )
    add(
      "artboard-size",
      null,
      `Artboard must be ${width}x${height} at (0,0); got ${JSON.stringify(box(abr))}.`,
      { rect: box(abr) },
    );
  if (cssOf(ab).overflow !== "hidden")
    add("artboard-overflow", null, "Artboard should be overflow:hidden.");
  const de = doc.documentElement;
  if (de.scrollWidth > width || de.scrollHeight > height)
    add(
      "document-size",
      null,
      `Document scroll size ${de.scrollWidth}x${de.scrollHeight} exceeds the ${width}x${height} artboard.`,
    );

  // ---------- layers ----------
  const isVisible = (el: Element) => {
    const cs = cssOf(el);
    const r = el.getBoundingClientRect();
    return (
      cs.visibility !== "hidden" &&
      cs.display !== "none" &&
      Number.parseFloat(cs.opacity) > 0 &&
      r.width > 0 &&
      r.height > 0
    );
  };
  const layerEls = Array.from(doc.querySelectorAll("[data-layer]"));
  const layers: InPageLayer[] = [];
  const boxes: InPageBox[] = [];
  const clipToArtboard = (r: InPageRect): InPageRect | null => {
    const x0 = Math.max(0, r.x);
    const y0 = Math.max(0, r.y);
    const x1 = Math.min(width, r.x + r.w);
    const y1 = Math.min(height, r.y + r.h);
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  for (const el of layerEls) {
    const id = el.getAttribute("data-layer") ?? "";
    const type = el.getAttribute("data-type") ?? "";
    const role = el.getAttribute("data-role");
    const parentLayer = el.parentElement?.closest("[data-layer]") ?? null;
    const r = el.getBoundingClientRect();
    const visible = isVisible(el);
    layers.push({
      id,
      type,
      role,
      parent: parentLayer?.getAttribute("data-layer") ?? null,
      rect: box(r),
      visible,
    });
    if (!visible) continue;
    if (type === "text") {
      if (cssOf(el).display === "inline")
        add(
          "text-layer-inline",
          id,
          "Text layer is display:inline; give it a box (block, inline-block or flex item).",
        );
    }
    if (type === "slot") {
      const ratio = el.getAttribute("data-slot-ratio") ?? "";
      const m = /^(\d+):(\d+)$/.exec(ratio);
      if (m) {
        const want = Number(m[1]) / Number(m[2]);
        const actual = r.width / r.height;
        if (Math.abs(actual - want) / want > 0.01)
          add(
            "slot-ratio-mismatch",
            id,
            `Slot box is ${round(r.width)}x${round(r.height)} (${actual.toFixed(3)}), declared ${ratio} (${want.toFixed(3)}).`,
          );
      }
      if (r.width < 200 || r.height < 200)
        add("slot-too-small", id, "Slot is very small for a photo.");
    }
    const clipped = clipToArtboard(box(r));
    if (!clipped) continue;
    if (type === "image" || type === "logo" || type === "slot")
      boxes.push({ layer: id, kind: type, rect: clipped });
    if (type === "shape") {
      const big = (clipped.w * clipped.h) / (width * height) >= 0.25;
      boxes.push({
        layer: id,
        kind: role === "background" || big ? "background" : "shape",
        rect: clipped,
      });
    }
  }

  // ---------- images ----------
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const id = img.getAttribute("data-layer") ?? layerOf(img);
    const src = img.getAttribute("src") ?? "";
    if (!img.complete || img.naturalWidth === 0) {
      add("image-broken", id, `Image did not load: ${src}`);
      continue;
    }
    const r = img.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const fit = cssOf(img).objectFit;
    const sx = r.width / img.naturalWidth;
    const sy = r.height / img.naturalHeight;
    const scale =
      fit === "contain" || fit === "scale-down"
        ? Math.min(sx, sy)
        : fit === "none"
          ? 1
          : Math.max(sx, sy);
    if (scale > 1.05)
      add(
        "image-upscaled",
        id,
        `Image is shown at ${(scale * 100).toFixed(0)}% of its pixel size (${img.naturalWidth}x${img.naturalHeight}); it will look soft.`,
        { scale: Number(scale.toFixed(2)) },
      );
    if (fit === "fill" && Math.abs(sx - sy) / Math.max(sx, sy) > 0.02)
      add(
        "image-distorted",
        id,
        "Image is stretched (object-fit:fill with a different aspect ratio).",
      );
  }

  // ---------- text outside text layers, undeclared visuals ----------
  const tw = doc.createTreeWalker(ab, SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!(n.textContent ?? "").trim()) continue;
    const parent = n.parentElement;
    if (!parent) continue;
    const L = parent.closest("[data-layer]");
    if (L?.getAttribute("data-type") !== "text") {
      const pcs = cssOf(parent);
      if (pcs.display === "none" || pcs.visibility === "hidden") continue;
      add(
        "text-outside-text-layer",
        L?.getAttribute("data-layer") ?? null,
        `Text "${(n.textContent ?? "").trim().slice(0, 40)}" is not inside a data-type="text" layer, so it is not editable.`,
      );
    }
  }
  for (const el of Array.from(ab.querySelectorAll("*"))) {
    if (el.closest("[data-layer]")) continue;
    const cs = cssOf(el);
    const painted =
      cs.backgroundColor !== "rgba(0, 0, 0, 0)" ||
      cs.backgroundImage !== "none" ||
      Number.parseFloat(cs.borderTopWidth) > 0 ||
      cs.boxShadow !== "none";
    if (painted && el.getBoundingClientRect().width > 0)
      add(
        "undeclared-visual",
        null,
        `A visible <${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}"> is not a layer and cannot be selected in the editor.`,
      );
  }

  // ---------- fonts ----------
  // Iterate, do not use forEach: with page JavaScript disabled, native APIs cannot call
  // back into script ("callback is no longer runnable").
  const faces: FontFace[] = Array.from(doc.fonts.values());
  for (const f of faces)
    if (f.status === "error")
      add("font-load", null, `Font failed to load: ${f.family} ${f.style} ${f.weight}`);
  const fontsLoaded = faces
    .filter((f) => f.status === "loaded")
    .map((f) => `${f.family.replace(/["']/g, "")} ${f.style} ${f.weight} ${f.stretch}`);
  // System brand fonts are used by name: one that is not installed falls back silently. A
  // family is installed when text set in it measures differently from at least one generic.
  const systemFonts = input.systemFonts ?? [];
  if (systemFonts.length > 0) {
    const c2d = doc.createElement("canvas").getContext("2d");
    if (c2d) {
      const sample = "mmmmmmmmmmlli WwQq ĞğİıŞş 0123456789";
      for (const family of systemFonts) {
        const quoted = `"${family.replace(/["\\]/g, "")}"`;
        let installed = false;
        for (const generic of ["monospace", "serif", "sans-serif"]) {
          c2d.font = `72px ${generic}`;
          const base = c2d.measureText(sample).width;
          c2d.font = `72px ${quoted}, ${generic}`;
          if (Math.abs(c2d.measureText(sample).width - base) > 0.5) {
            installed = true;
            break;
          }
        }
        if (!installed)
          add(
            "font-missing",
            null,
            `System font "${family}" is not installed on this Mac; text set in it used the fallback.`,
            { family },
          );
      }
    }
  }

  // ---------- text metrics ----------
  type Line = { left: number; right: number; top: number; bottom: number };
  const mergeLines = (rects: DOMRect[]): Line[] => {
    const lines: Line[] = [];
    for (const r of rects.slice().sort((a, b) => a.top - b.top || a.left - b.left)) {
      const last = lines[lines.length - 1];
      const midY = r.top + r.height / 2;
      if (last && midY > last.top && midY < last.bottom) {
        last.left = Math.min(last.left, r.left);
        last.right = Math.max(last.right, r.right);
        last.top = Math.min(last.top, r.top);
        last.bottom = Math.max(last.bottom, r.bottom);
      } else lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    return lines;
  };
  // Range rects cover the font's full ascent+descent (taller than the glyphs, and taller than
  // the line box when line-height < 1). Use a cap-height-ish core band for geometry checks.
  const core = (l: Line): InPageRect => {
    const h = l.bottom - l.top;
    return { x: l.left, y: l.top + 0.14 * h, w: l.right - l.left, h: 0.68 * h };
  };
  const roundRect = (r: InPageRect): InPageRect => ({
    x: round(r.x),
    y: round(r.y),
    w: round(r.w),
    h: round(r.h),
  });
  const textInfo: InPageText[] = [];
  // Keyed per element: duplicate ids (a contract error) are still measured.
  const textLines: Record<string, InPageRect[]> = {};
  const textEls: Record<string, Element> = {};
  const canvas = doc.createElement("canvas");
  const ctx2d = canvas.getContext("2d");
  const STRETCH: [number, string][] = [
    [50, "ultra-condensed"],
    [62.5, "extra-condensed"],
    [75, "condensed"],
    [87.5, "semi-condensed"],
    [100, "normal"],
    [112.5, "semi-expanded"],
    [125, "expanded"],
    [150, "extra-expanded"],
    [200, "ultra-expanded"],
  ];
  const MARK_ABOVE = /[̀-̽̕̚-̈́͆͊-͌͐-͒͗͛]/;
  const MARK_BELOW = /[̖-̙̜-̳̹-̼͇-͉͍͎͓-͖͙͚]/;

  for (const el of Array.from(doc.querySelectorAll('[data-type="text"]'))) {
    const id = el.getAttribute("data-layer") ?? "";
    if (!isVisible(el)) continue;
    let tkey = id;
    for (let k = 2; tkey in textLines; k++) tkey = `${id}#${k}`;
    textEls[tkey] = el;
    const cs = cssOf(el);
    const range = doc.createRange();
    range.selectNodeContents(el);
    const raw = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5);
    const merged = mergeLines(raw);
    const L = merged.map(core);
    textLines[tkey] = L.map(roundRect);
    if (!L.length) continue;
    const u = {
      left: Math.min(...L.map((l) => l.x)),
      top: Math.min(...L.map((l) => l.y)),
      right: Math.max(...L.map((l) => l.x + l.w)),
      bottom: Math.max(...L.map((l) => l.y + l.h)),
    };

    // occlusion: is something opaque painted on top of the text?
    {
      let pts = 0;
      let hidden = 0;
      const by = new Set<string>();
      const paints = (e: Element) => {
        const tag = e.tagName.toLowerCase();
        if (tag === "img" || tag === "svg" || tag === "video") return true;
        const s = cssOf(e);
        if (s.backgroundImage !== "none") return true;
        const m = s.backgroundColor.match(/rgba?\(([^)]+)\)/);
        if (!m) return false;
        const p = (m[1] ?? "")
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number);
        return (p.length > 3 ? (p[3] as number) : 1) * Number.parseFloat(s.opacity) > 0.5;
      };
      for (const l of L)
        for (const fx of [0.15, 0.5, 0.85]) {
          const x = l.x + l.w * fx;
          const y = l.y + l.h * 0.5;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          pts++;
          for (const e of doc.elementsFromPoint(x, y)) {
            if (e === el || el.contains(e) || e.contains(el)) break;
            if (paints(e)) {
              hidden++;
              by.add(
                e.closest("[data-layer]")?.getAttribute("data-layer") ?? e.tagName.toLowerCase(),
              );
              break;
            }
          }
        }
      if (pts && hidden / pts > 0.34)
        add(
          "text-occluded",
          id,
          `Text is painted underneath "${Array.from(by).join('", "')}" (${hidden}/${pts} sample points covered), so it is not visible. Fix stacking (z-index / DOM order).`,
          { by: Array.from(by) },
        );
    }

    // runs: font size, family, colour per text node
    let minSize = Number.POSITIVE_INFINITY;
    const families = new Set<string>();
    const runs: InPageTextRun[] = [];
    const w2 = doc.createTreeWalker(el, SHOW_TEXT);
    for (let n = w2.nextNode(); n; n = w2.nextNode()) {
      if (!(n.textContent ?? "").trim() || !n.parentElement) continue;
      const pcs = cssOf(n.parentElement);
      if (pcs.visibility === "hidden") continue;
      const size = Number.parseFloat(pcs.fontSize);
      minSize = Math.min(minSize, size);
      families.add((pcs.fontFamily.split(",")[0] ?? "").replace(/["']/g, "").trim());
      const rr = doc.createRange();
      rr.selectNodeContents(n);
      const rects = mergeLines(
        Array.from(rr.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5),
      ).map((l) => roundRect(core(l)));
      runs.push({ color: pcs.color, fontSize: size, weight: pcs.fontWeight, rects });
    }
    const role = el.getAttribute("data-role");
    const floor = role === "legal" ? input.legalMinFont : input.minFont;
    if (minSize < floor)
      add(
        "min-font-size",
        id,
        `Smallest text is ${minSize}px; minimum is ${floor}px at 1080 width (≈${(floor * 0.36).toFixed(0)}px on a phone).`,
        { fontSize: minSize },
      );
    else if (
      minSize < input.warnFont &&
      !["legal", "eyebrow", "counter", "badge", "caption"].includes(role ?? "")
    )
      add(
        "small-font-size",
        id,
        `Smallest text is ${minSize}px; running text reads better at ≥ ${input.warnFont}px.`,
        { fontSize: minSize },
      );
    if (input.brandFonts)
      for (const f of families)
        if (!input.brandFonts.includes(f))
          add(
            "font-family",
            id,
            `Font "${f}" is not a brand font (${input.brandFonts.join(", ")}). Use the brand font variables.`,
            { family: f },
          );

    // overflow of its own box
    const clipsSelf =
      cs.overflow !== "visible" || cs.overflowX !== "visible" || cs.overflowY !== "visible";
    const fs0 = Number.parseFloat(cs.fontSize);
    const he = el as HTMLElement;
    if (
      he.scrollWidth > he.clientWidth + Math.max(2, 0.12 * fs0) ||
      he.scrollHeight > he.clientHeight + Math.max(2, 0.3 * fs0)
    ) {
      if (clipsSelf)
        add(
          "text-clipped",
          id,
          `Text overflows its box and is clipped (content ${he.scrollWidth}x${he.scrollHeight} > box ${he.clientWidth}x${he.clientHeight}).`,
        );
      else
        add(
          "text-overflow-box",
          id,
          `Text extends beyond its own box (content ${he.scrollWidth}x${he.scrollHeight} > box ${he.clientWidth}x${he.clientHeight}); give the box room or shorten the copy.`,
        );
    }
    if (cs.textOverflow === "ellipsis")
      add("text-truncated", id, "text-overflow: ellipsis hides copy; size the box instead.");
    const clamp = cs.getPropertyValue("-webkit-line-clamp");
    if (clamp && clamp !== "none") add("text-line-clamp", id, "line-clamp hides copy.");
    // clipping by ancestors (incl. artboard)
    for (let a = el.parentElement; a && a !== doc.body; a = a.parentElement) {
      const acs = cssOf(a);
      if (acs.overflow === "visible" && acs.clipPath === "none") continue;
      const ar = a.getBoundingClientRect();
      if (
        u.left < ar.left - 1 ||
        u.right > ar.right + 1 ||
        u.top < ar.top - 1 ||
        u.bottom > ar.bottom + 1
      ) {
        add(
          a === ab ? "text-outside-artboard" : "text-clipped",
          id,
          `Text is cut off by ${a === ab ? "the artboard edge" : `ancestor "${a.getAttribute("data-layer") ?? a.tagName.toLowerCase()}"`}.`,
        );
        break;
      }
    }
    // safe area
    const s = {
      l: u.left - safe.left,
      t: u.top - safe.top,
      r: width - safe.right - u.right,
      b: height - safe.bottom - u.bottom,
    };
    const worst = Math.min(s.l, s.t, s.r, s.b);
    if (worst < -0.5)
      add(
        "safe-area",
        id,
        `Text is ${round(-worst)}px outside the safe area (left ${round(u.left)}, top ${round(u.top)}, right ${round(width - u.right)}, bottom ${round(height - u.bottom)} from the edges).`,
        { overflow: round(-worst) },
      );
    // widow in large text
    const fsz = Number.parseFloat(cs.fontSize);
    if (L.length >= 2 && fsz >= 44) {
      const maxW = Math.max(...L.map((l) => l.w));
      const lastW = (L[L.length - 1] as InPageRect).w;
      // biome-ignore lint/performance/useDomNodeTextContent: innerText keeps the rendered line breaks (<br>)
      const lastText = ((he.innerText || "").trim().split(/\n/).pop() ?? "").trim();
      if (lastW < maxW * 0.22 || (lastText.split(/\s+/).length === 1 && lastW < maxW * 0.4))
        add(
          "widow",
          id,
          `Last line is a lone short word ("${lastText.slice(0, 24)}"); rebalance the line breaks (text-wrap: balance or a manual <br>).`,
        );
    }

    // diacritic collision between adjacent lines: candidate glyph pairs (a mark above in the
    // lower line, or a mark below in the upper line) are drawn on a canvas at their real
    // positions; overlapping ink (dilated by 1px) is a collision. Exact for italics too.
    if (merged.length >= 2 && ctx2d) {
      const lang = (el.closest("[lang]")?.getAttribute("lang") ?? "tr").toLowerCase();
      const transform = cs.textTransform;
      type G = {
        ch: string;
        line: number;
        left: number;
        right: number;
        base: number;
        asc: number;
        desc: number;
        above: boolean;
        below: boolean;
        font: string;
        stretch: string;
        size: number;
      };
      const glyphs: G[] = [];
      const metrics = new Map<string, { asc: number; desc: number; fontAsc: number }>();
      const setFont = (font: string, stretch: string) => {
        ctx2d.font = font;
        try {
          (ctx2d as unknown as { fontStretch: string }).fontStretch = stretch;
        } catch {
          /* older engines */
        }
      };
      const w3 = doc.createTreeWalker(el, SHOW_TEXT);
      for (let n = w3.nextNode(); n; n = w3.nextNode()) {
        const text = n.textContent ?? "";
        if (!text.trim() || !n.parentElement) continue;
        const pcs = cssOf(n.parentElement);
        const st = Number.parseFloat(pcs.fontStretch) || 100;
        let kw = "normal";
        let best = Number.POSITIVE_INFINITY;
        for (const [pct, name] of STRETCH)
          if (Math.abs(pct - st) < best) {
            best = Math.abs(pct - st);
            kw = name;
          }
        const font = `${pcs.fontStyle} ${pcs.fontWeight} ${pcs.fontSize} ${pcs.fontFamily}`;
        setFont(font, kw);
        const rr = doc.createRange();
        for (let i = 0; i < text.length; i++) {
          let ch = text[i] as string;
          if (/\s/.test(ch)) continue;
          if (transform === "uppercase") ch = ch.toLocaleUpperCase(lang);
          else if (transform === "lowercase") ch = ch.toLocaleLowerCase(lang);
          rr.setStart(n, i);
          rr.setEnd(n, i + 1);
          const cr = rr.getClientRects()[0];
          if (!cr || cr.width === 0) continue;
          const mid = cr.top + cr.height / 2;
          const line = merged.findIndex((l) => mid > l.top && mid < l.bottom);
          if (line < 0) continue;
          const key = `${font}|${kw}|${ch}`;
          let m = metrics.get(key);
          if (!m) {
            const tm = ctx2d.measureText(ch);
            m = {
              asc: tm.actualBoundingBoxAscent,
              desc: tm.actualBoundingBoxDescent,
              fontAsc: tm.fontBoundingBoxAscent,
            };
            metrics.set(key, m);
          }
          const nfd = ch.normalize("NFD");
          // baseline = rect top + font ascent (Range rects span the font's ascent + descent)
          glyphs.push({
            ch,
            line,
            left: cr.left,
            right: cr.right,
            base: cr.top + m.fontAsc,
            asc: m.asc,
            desc: m.desc,
            above: MARK_ABOVE.test(nfd),
            below: MARK_BELOW.test(nfd),
            font,
            stretch: kw,
            size: Number.parseFloat(pcs.fontSize),
          });
        }
      }
      const inkOverlap = (a: G, b: G): boolean => {
        const reach = Math.max(a.size, b.size);
        const x0 = Math.floor(Math.min(a.left, b.left) - reach);
        const x1 = Math.ceil(Math.max(a.right, b.right) + reach);
        const y0 = Math.floor(a.base - a.asc - 4);
        const y1 = Math.ceil(b.base + b.desc + 4);
        const cw = x1 - x0;
        const chh = y1 - y0;
        if (cw <= 0 || chh <= 0 || cw * chh > 4_000_000) return false;
        canvas.width = cw;
        canvas.height = chh;
        ctx2d.globalCompositeOperation = "source-over";
        ctx2d.clearRect(0, 0, cw, chh);
        ctx2d.fillStyle = "#000";
        ctx2d.strokeStyle = "#000";
        setFont(a.font, a.stretch);
        ctx2d.fillText(a.ch, a.left - x0, a.base - y0);
        ctx2d.globalCompositeOperation = "source-in";
        setFont(b.font, b.stretch);
        ctx2d.lineWidth = 2;
        ctx2d.fillText(b.ch, b.left - x0, b.base - y0);
        ctx2d.strokeText(b.ch, b.left - x0, b.base - y0);
        const data = ctx2d.getImageData(0, 0, cw, chh).data;
        let hits = 0;
        for (let k = 3; k < data.length; k += 4)
          if ((data[k] as number) > 64 && ++hits > 1) return true;
        return false;
      };
      const hits: string[] = [];
      for (let li = 0; li < merged.length - 1; li++) {
        const upper = glyphs.filter((g) => g.line === li);
        const lower = glyphs.filter((g) => g.line === li + 1);
        for (const a of upper)
          for (const b of lower) {
            if (!(a.below || b.above)) continue;
            const reach = Math.max(a.size, b.size) * 0.4;
            if (Math.min(a.right, b.right) + reach - Math.max(a.left, b.left) <= 0) continue;
            if (b.base - b.asc - (a.base + a.desc) >= 1) continue;
            const pair = `${a.ch}/${b.ch}`;
            if (hits.includes(pair)) continue;
            if (inkOverlap(a, b)) hits.push(pair);
          }
      }
      if (hits.length)
        add(
          "diacritic-collision",
          id,
          `Diacritics touch the neighbouring line (${hits.slice(0, 6).join(", ")}). Increase line-height (≥ 0.96 for uppercase display type) or change the line breaks.`,
          { pairs: hits },
        );
    }

    const clipText =
      (cs.getPropertyValue("-webkit-background-clip") || cs.getPropertyValue("background-clip")) ===
      "text";
    textInfo.push({
      id,
      role,
      lines: L.length,
      lineRects: textLines[tkey] ?? [],
      fontSize: fsz,
      minFontSize: minSize,
      weight: cs.fontWeight,
      family: Array.from(families).join(","),
      color: cs.color,
      clipText,
      textRect: {
        x: round(u.left),
        y: round(u.top),
        w: round(u.right - u.left),
        h: round(u.bottom - u.top),
      },
      chars: (el.textContent ?? "").trim().length,
      runs,
    });
    for (const l of textLines[tkey] ?? []) {
      const c = clipToArtboard(l);
      if (c) boxes.push({ layer: id, kind: "text", rect: c });
    }
  }

  // ---------- overlaps ----------
  const ids = Object.keys(textLines);
  const idOf = (key: string) => textEls[key]?.getAttribute("data-layer") ?? key;
  const inter = (a: InPageRect, b: InPageRect) =>
    Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) {
      const ia = ids[i] as string;
      const ib = ids[j] as string;
      const A = textLines[ia] ?? [];
      const B = textLines[ib] ?? [];
      const allow =
        textEls[ia]?.hasAttribute("data-allow-overlap") ||
        textEls[ib]?.hasAttribute("data-allow-overlap");
      let area = 0;
      for (const a of A) for (const b of B) area += inter(a, b);
      if (area > 40 && !allow)
        add(
          "text-overlap",
          idOf(ia),
          `Text of "${idOf(ia)}" overlaps text of "${idOf(ib)}" (${round(area)}px²).`,
          { other: idOf(ib), area: round(area) },
        );
    }
  // ---------- text vs shapes, pictures and slots ----------
  // A shape, picture or slot that cuts into a text's ink is a collision whether it is painted
  // above the text or under it (a badge under the first letters, text straddling a photo's
  // edge). A backdrop that holds the whole text (a panel or photo behind a caption, a badge's
  // own letter on its shape) is intended; an element painted over ALL of a text is the
  // `text-occluded` finding. Logos have their own rule; backgrounds (data-role="background" or
  // ≥ 25% of the artboard) never collide. The overlap is measured by hit-testing the element at
  // sample points inside the text's ink band, so clip-paths (hexagons) and rounded corners count
  // as drawn, not as their bounding box.
  {
    const TOL = 2;
    const paintsBox = (e: Element): boolean => {
      const tag = e.tagName.toLowerCase();
      if (tag === "img" || tag === "svg" || tag === "video" || tag === "canvas") return true;
      if (e.getAttribute("data-type") === "slot") return true;
      const s = cssOf(e);
      const alpha = (c: string) => {
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return 0;
        const p = (m[1] ?? "")
          .split(/[\s,/]+/)
          .filter(Boolean)
          .map(Number);
        return p.length > 3 ? (p[3] as number) : 1;
      };
      return (
        s.backgroundImage !== "none" ||
        alpha(s.backgroundColor) > 0.05 ||
        (Number.parseFloat(s.borderTopWidth) > 0 && alpha(s.borderTopColor) > 0.05) ||
        (Number.parseFloat(s.borderLeftWidth) > 0 && alpha(s.borderLeftColor) > 0.05) ||
        s.boxShadow !== "none" ||
        e.querySelector("img, svg, video, canvas") !== null
      );
    };
    const visuals: { el: Element; id: string; rect: InPageRect }[] = [];
    for (const el of layerEls) {
      const type = el.getAttribute("data-type") ?? "";
      if (type !== "shape" && type !== "image" && type !== "slot") continue;
      if (el.getAttribute("data-role") === "background" || !isVisible(el)) continue;
      const c = clipToArtboard(box(el.getBoundingClientRect()));
      if (!c || (c.w * c.h) / (width * height) >= 0.25) continue;
      if (!paintsBox(el)) continue;
      visuals.push({ el, id: el.getAttribute("data-layer") ?? "", rect: c });
    }
    // A picture's box is not its ink: a cut-out product photo (transparent, or white under
    // mix-blend-mode multiply) or the letterbox of object-fit: contain paints nothing there.
    const pixels = new Map<Element, { data: Uint8ClampedArray; w: number; h: number } | null>();
    const imageInk = (img: HTMLImageElement, x: number, y: number): boolean => {
      const ir = img.getBoundingClientRect();
      const s = cssOf(img);
      const bl = Number.parseFloat(s.borderLeftWidth) + Number.parseFloat(s.paddingLeft) || 0;
      const bt = Number.parseFloat(s.borderTopWidth) + Number.parseFloat(s.paddingTop) || 0;
      const br = Number.parseFloat(s.borderRightWidth) + Number.parseFloat(s.paddingRight) || 0;
      const bb = Number.parseFloat(s.borderBottomWidth) + Number.parseFloat(s.paddingBottom) || 0;
      const cx = ir.left + bl;
      const cy = ir.top + bt;
      const cw = ir.width - bl - br;
      const ch = ir.height - bt - bb;
      const nw = img.naturalWidth;
      const nh = img.naturalHeight;
      if (!nw || !nh || cw <= 0 || ch <= 0) return true;
      const fit = s.objectFit;
      let sx = cw / nw;
      let sy = ch / nh;
      if (fit === "contain") sx = sy = Math.min(sx, sy);
      else if (fit === "cover") sx = sy = Math.max(sx, sy);
      else if (fit === "none") sx = sy = 1;
      else if (fit === "scale-down") sx = sy = Math.min(1, Math.min(sx, sy));
      const dw = nw * sx;
      const dh = nh * sy;
      const pos = (v: string | undefined, free: number) => {
        if (!v) return free / 2;
        if (v === "left" || v === "top") return 0;
        if (v === "right" || v === "bottom") return free;
        if (v === "center") return free / 2;
        if (v.endsWith("%")) return (free * Number.parseFloat(v)) / 100;
        return Number.parseFloat(v) || 0;
      };
      const op = s.objectPosition.split(/\s+/);
      const dx = cx + pos(op[0], cw - dw);
      const dy = cy + pos(op[1], ch - dh);
      if (x < dx || y < dy || x >= dx + dw || y >= dy + dh) return false;
      let px = pixels.get(img);
      if (px === undefined) {
        px = null;
        try {
          const k = Math.min(1, 512 / Math.max(nw, nh));
          const c = doc.createElement("canvas");
          c.width = Math.max(1, Math.round(nw * k));
          c.height = Math.max(1, Math.round(nh * k));
          const g = c.getContext("2d");
          if (g) {
            g.drawImage(img, 0, 0, c.width, c.height);
            px = { data: g.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
          }
        } catch {
          px = null; // unreadable (cross-origin): count the box as ink
        }
        pixels.set(img, px);
      }
      if (!px) return true;
      const u = Math.min(px.w - 1, Math.max(0, Math.floor(((x - dx) / dw) * px.w)));
      const w = Math.min(px.h - 1, Math.max(0, Math.floor(((y - dy) / dh) * px.h)));
      const i = (w * px.w + u) * 4;
      const r = px.data[i] ?? 0;
      const g = px.data[i + 1] ?? 0;
      const b = px.data[i + 2] ?? 0;
      if ((px.data[i + 3] ?? 0) < 26) return false;
      const blend = s.mixBlendMode;
      if ((blend === "multiply" || blend === "darken") && Math.min(r, g, b) > 240) return false;
      if ((blend === "screen" || blend === "lighten") && Math.max(r, g, b) < 15) return false;
      return true;
    };
    if (visuals.length > 0) {
      // Hit-testing must see every element, whatever its pointer-events.
      const force = doc.createElement("style");
      force.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
      (doc.head ?? doc.documentElement).appendChild(force);
      try {
        for (const tkey of ids) {
          const te = textEls[tkey];
          const L = textLines[tkey] ?? [];
          if (!te || !L.length || te.hasAttribute("data-allow-overlap")) continue;
          const U = {
            x0: Math.min(...L.map((l) => l.x)),
            y0: Math.min(...L.map((l) => l.y)),
            x1: Math.max(...L.map((l) => l.x + l.w)),
            y1: Math.max(...L.map((l) => l.y + l.h)),
          };
          for (const v of visuals) {
            if (v.el.hasAttribute("data-allow-overlap")) continue;
            if (v.el.contains(te) || te.contains(v.el)) continue;
            const r = v.rect;
            // Backdrop (or a full cover, which text-occluded reports): it holds the whole text.
            if (
              r.x - TOL <= U.x0 &&
              r.y - TOL <= U.y0 &&
              r.x + r.w + TOL >= U.x1 &&
              r.y + r.h + TOL >= U.y1
            )
              continue;
            let area = 0;
            let above: boolean | null = null;
            for (const l of L) {
              const x0 = Math.max(l.x, r.x + TOL);
              const y0 = Math.max(l.y, r.y + TOL);
              const x1 = Math.min(l.x + l.w, r.x + r.w - TOL);
              const y1 = Math.min(l.y + l.h, r.y + r.h - TOL);
              if (x1 - x0 < 1 || y1 - y0 < 1) continue;
              const step = Math.max(2, Math.ceil(Math.sqrt(((x1 - x0) * (y1 - y0)) / 400)));
              for (let y = y0 + step / 2; y < y1; y += step)
                for (let x = x0 + step / 2; x < x1; x += step) {
                  if (x < 0 || y < 0 || x >= width || y >= height) continue;
                  const stack = doc.elementsFromPoint(x, y);
                  const vi = stack.findIndex(
                    (e) =>
                      (e === v.el || v.el.contains(e)) &&
                      !(
                        e.tagName.toLowerCase() === "img" && !imageInk(e as HTMLImageElement, x, y)
                      ),
                  );
                  if (vi < 0) continue;
                  area += step * step;
                  if (above === null) {
                    const ti = stack.findIndex((e) => e === te || te.contains(e));
                    above = ti < 0 || vi < ti;
                  }
                }
            }
            if (area > 40)
              add(
                "text-element-overlap",
                idOf(tkey),
                above
                  ? `"${v.id}" is painted over part of the text of "${idOf(tkey)}" (${round(area)}px²). Move it clear of the text or make it a backdrop that holds the whole text.`
                  : `The text of "${idOf(tkey)}" runs onto the edge of "${v.id}" (${round(area)}px² of its letters sit on it). Move the text or the element so they do not touch, or make it a backdrop that holds the whole text.`,
                { element: v.id, area: round(area), above: above === true },
              );
          }
        }
      } finally {
        force.remove();
      }
    }
  }

  const logos: { id: string; src: string; rect: InPageRect }[] = [];
  for (const lg of Array.from(doc.querySelectorAll('[data-type="logo"]'))) {
    if (!isVisible(lg)) continue;
    const lid = lg.getAttribute("data-layer") ?? "";
    const lr = lg.getBoundingClientRect();
    const lb = { x: lr.left, y: lr.top, w: lr.width, h: lr.height };
    logos.push({ id: lid, src: lg.getAttribute("src") ?? "", rect: box(lr) });
    for (const id of ids) {
      let area = 0;
      for (const a of textLines[id] ?? []) area += inter(a, lb);
      if (area > 40)
        add("text-logo-overlap", idOf(id), `Text overlaps logo "${lid}".`, { logo: lid });
    }
    const s = Math.min(
      lr.left - safe.left,
      lr.top - safe.top,
      width - safe.right - lr.right,
      height - safe.bottom - lr.bottom,
    );
    if (s < -0.5)
      add("safe-area", lid, `Logo is ${round(-s)}px outside the safe area.`, {
        overflow: round(-s),
      });
  }

  return { findings, layers, text: textInfo, boxes, logos, fontsLoaded };
}

/**
 * The in-page function as an expression string that evaluates to the function. A no-op
 * `__name` is defined first because some TypeScript runners (tsx/esbuild `keepNames`)
 * insert `__name(...)` calls into function bodies.
 */
export const IN_PAGE_LINT_SCRIPT = `(() => { const __name = (f) => f; return (${studioInPageLint.toString()}); })()`;

/** Script string that runs the checks with `input` and returns the result (for `page.evaluate`). */
export function inPageLintInvocation(input: InPageInput): string {
  return `(${IN_PAGE_LINT_SCRIPT})(${JSON.stringify(input)})`;
}

/** CSS that makes all layer text transparent, for the pixel-contrast background capture. */
export const HIDE_TEXT_CSS =
  '[data-type="text"], [data-type="text"] * { color: transparent !important; text-shadow: none !important; -webkit-text-stroke-color: transparent !important; text-decoration-color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; }';
