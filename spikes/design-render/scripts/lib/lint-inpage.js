// This function is serialised and executed inside the rendered page by Playwright
// (page.evaluate). It must be self-contained: no imports, no closures.
// It returns { issues, layers, textLines } — pixel contrast is computed in Node afterwards.
export function inPageLint(opts) {
  const { width, height, safe, minFont, warnFont, legalMinFont, allowedTypes, brandFonts, allowedNumbers } = opts;
  const issues = [];
  const add = (rule, severity, layer, message, data) => issues.push({ rule, severity, layer: layer ?? null, message, ...(data ? { data } : {}) });
  const box = (r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
  const layerOf = (el) => el?.closest?.('[data-layer]')?.getAttribute('data-layer') ?? null;

  // ---------- 1. document + artboard ----------
  if ((document.documentElement.getAttribute('lang') || '').toLowerCase() !== 'tr')
    add('lang', 'error', null, '<html lang="tr"> is required (Turkish casing İ/ı in text-transform).');
  const artboards = document.querySelectorAll('[data-artboard]');
  if (artboards.length !== 1) add('artboard-count', 'error', null, `Expected exactly one [data-artboard], found ${artboards.length}.`);
  const ab = artboards[0] ?? document.body;
  const abr = ab.getBoundingClientRect();
  if (Math.round(abr.width) !== width || Math.round(abr.height) !== height || Math.round(abr.left) !== 0 || Math.round(abr.top) !== 0)
    add('artboard-size', 'error', null, `Artboard must be ${width}x${height} at (0,0); got ${JSON.stringify(box(abr))}.`);
  if (getComputedStyle(ab).overflow !== 'hidden') add('artboard-overflow', 'warning', null, 'Artboard should be overflow:hidden.');
  const de = document.documentElement;
  if (de.scrollWidth > width || de.scrollHeight > height)
    add('document-size', 'warning', null, `Document scroll size ${de.scrollWidth}x${de.scrollHeight} exceeds the ${width}x${height} artboard.`);

  // ---------- 2. forbidden constructs ----------
  for (const sel of ['script', 'noscript', 'iframe', 'object', 'embed', 'video', 'audio', 'canvas', 'form', 'input', 'textarea', 'select', 'button', 'base', 'frame', 'frameset', 'template', 'meta[http-equiv]'])
    document.querySelectorAll(sel).forEach((el) => add('forbidden-element', 'error', layerOf(el), `<${el.tagName.toLowerCase()}> is not allowed in a static design.`));
  const links = [...document.querySelectorAll('link')];
  links.forEach((l) => { if (!(l.rel === 'stylesheet' && l.getAttribute('href') === '/brand/brand.css')) add('forbidden-link', 'error', null, `Only <link rel="stylesheet" href="/brand/brand.css"> is allowed, found: ${l.outerHTML.slice(0, 140)}`); });
  if (!links.some((l) => l.getAttribute('href') === '/brand/brand.css')) add('brand-css-missing', 'error', null, 'Missing <link rel="stylesheet" href="/brand/brand.css">.');
  for (const el of document.querySelectorAll('*')) {
    for (const a of el.attributes) {
      if (/^on/i.test(a.name)) add('event-handler', 'error', layerOf(el), `Event handler attribute "${a.name}" is not allowed.`);
      if (/^\s*javascript:/i.test(a.value)) add('javascript-url', 'error', layerOf(el), 'javascript: URLs are not allowed.');
    }
  }

  // CSS checks on the design's own styles (brand.css is exempt)
  const cssProblems = [];
  const colourLiterals = new Set();
  const NEUTRAL = /^(#fff(fff)?|#000(000)?|rgba?\(\s*(0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255)\b[^)]*\)|transparent)$/i;
  function checkDecl(prop, value, where) {
    const v = String(value);
    if (/url\(/i.test(v)) cssProblems.push(['css-url', 'error', `${where}: "${prop}: ${v.slice(0, 80)}" uses url(); images must be <img> layers and fonts come from brand.css.`]);
    if (/^position$/i.test(prop) && /fixed|sticky/i.test(v)) cssProblems.push(['css-position', 'error', `${where}: position:${v} is not allowed.`]);
    if (/(^|[\s(,])-?[\d.]+(vw|vh|vmin|vmax|svh|lvh|dvh)\b/i.test(v)) cssProblems.push(['css-viewport-unit', 'error', `${where}: viewport units (${v.slice(0, 40)}) are not allowed; use px.`]);
    if (/^(animation|animation-name|transition)$/i.test(prop) && !/^(none|all 0s ease 0s|0s)$/i.test(v.trim())) cssProblems.push(['css-animation', 'warning', `${where}: ${prop} has no effect in a static render; remove it.`]);
    for (const m of v.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi)) if (!NEUTRAL.test(m[0].trim())) colourLiterals.add(m[0]);
  }
  function walkRules(rules, where) {
    for (const rule of rules) {
      if (rule.type === CSSRule.IMPORT_RULE) cssProblems.push(['css-import', 'error', `${where}: @import is not allowed.`]);
      else if (rule.type === CSSRule.FONT_FACE_RULE) cssProblems.push(['css-font-face', 'error', `${where}: @font-face is only allowed in brand.css.`]);
      else if (rule.type === CSSRule.KEYFRAMES_RULE) cssProblems.push(['css-animation', 'warning', `${where}: @keyframes has no effect in a static render.`]);
      if (rule.style) for (let i = 0; i < rule.style.length; i++) { const p = rule.style[i]; checkDecl(p, rule.style.getPropertyValue(p), `${where} ${rule.selectorText ?? ''}`.trim()); }
      if (rule.cssRules) walkRules(rule.cssRules, where);
    }
  }
  for (const sheet of document.styleSheets) {
    if (sheet.href && new URL(sheet.href).pathname === '/brand/brand.css') continue;
    try { walkRules(sheet.cssRules, '<style>'); } catch (e) { cssProblems.push(['css-unreadable', 'warning', String(e)]); }
  }
  for (const el of document.querySelectorAll('[style]')) {
    for (let i = 0; i < el.style.length; i++) { const p = el.style[i]; checkDecl(p, el.style.getPropertyValue(p), `style attr on ${layerOf(el) ?? el.tagName.toLowerCase()}`); }
  }
  const seen = new Set();
  for (const [rule, sev, msg] of cssProblems) { if (seen.has(msg)) continue; seen.add(msg); add(rule, sev, null, msg); }
  if (colourLiterals.size) add('colour-literal', 'warning', null, `Hard-coded colours found; use brand tokens var(--color-*) or color-mix() with tokens: ${[...colourLiterals].slice(0, 12).join(', ')}`);

  // ---------- 3. layers ----------
  const layerEls = [...document.querySelectorAll('[data-layer]')];
  const ids = new Map();
  const layers = [];
  for (const el of layerEls) {
    const id = el.getAttribute('data-layer');
    const type = el.getAttribute('data-type');
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(id || '')) add('layer-id-format', 'error', id, 'data-layer must be kebab-case: [a-z][a-z0-9-]*.');
    if (ids.has(id)) add('layer-id-duplicate', 'error', id, `Duplicate data-layer id "${id}".`);
    ids.set(id, el);
    if (!allowedTypes.includes(type)) add('layer-type', 'error', id, `data-type="${type}" is not one of ${allowedTypes.join(', ')}.`);
    if (!ab.contains(el) || el === ab) add('layer-outside-artboard', 'error', id, 'Layer must be inside the artboard.');
    const parentLayer = el.parentElement?.closest('[data-layer]');
    if (parentLayer && parentLayer.getAttribute('data-type') !== 'group') add('layer-nesting', 'error', id, `Layers may only be nested inside a group; parent "${parentLayer.getAttribute('data-layer')}" is ${parentLayer.getAttribute('data-type')}.`);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const info = { id, type, role: el.getAttribute('data-role') ?? null, parent: parentLayer?.getAttribute('data-layer') ?? null, rect: box(r), visible: cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0 };

    if (type === 'image' || type === 'logo') {
      if (el.tagName !== 'IMG') add('image-not-img', 'error', id, `${type} layers must be <img> elements (replaceable), not ${el.tagName.toLowerCase()}.`);
    }
    if (type === 'shape' && el.textContent.trim()) add('shape-has-text', 'error', id, 'Shape layers must not contain text; put text in a text layer.');
    if (type === 'group' && !el.querySelector('[data-layer]')) add('group-empty', 'warning', id, 'Group has no child layers.');
    if (type === 'text') {
      if (el.querySelector('[data-layer]')) add('text-nested-layer', 'error', id, 'Text layers must not contain other layers.');
      const blockKids = el.querySelectorAll('div,p,section,figure,img,svg,ul,ol,table,h1,h2,h3,h4,h5,h6');
      if (blockKids.length) add('text-block-children', 'warning', id, 'Text layers should contain only text and inline markup (span, br, strong, em, b, i, sup, sub).');
      if (!el.textContent.trim()) add('text-empty', 'warning', id, 'Empty text layer.');
      if (cs.display === 'inline') add('text-layer-inline', 'warning', id, 'Text layer is display:inline; give it a box (block, inline-block or flex item).');
    }
    if (type === 'slot') {
      const ratio = el.getAttribute('data-slot-ratio');
      const state = el.getAttribute('data-slot-state');
      if (!/^\d+:\d+$/.test(ratio || '')) add('slot-ratio', 'error', id, 'Slot needs data-slot-ratio="W:H".');
      else {
        const [w, h] = ratio.split(':').map(Number);
        const actual = r.width / r.height;
        if (Math.abs(actual - w / h) / (w / h) > 0.01) add('slot-ratio-mismatch', 'error', id, `Slot box is ${Math.round(r.width)}x${Math.round(r.height)} (${actual.toFixed(3)}), declared ${ratio} (${(w / h).toFixed(3)}).`);
      }
      if (!['empty', 'filled'].includes(state)) add('slot-state', 'error', id, 'Slot needs data-slot-state="empty" or "filled".');
      if (!el.getAttribute('data-slot-label')) add('slot-label', 'warning', id, 'Slot should have a short data-slot-label (what goes here).');
      const imgs = el.querySelectorAll('img');
      if (state === 'empty' && imgs.length) add('slot-empty-has-img', 'error', id, 'An empty slot must not contain an <img>.');
      if (state === 'filled' && (imgs.length !== 1 || !imgs[0].hasAttribute('data-slot-image'))) add('slot-filled-img', 'error', id, 'A filled slot must contain exactly one <img data-slot-image>.');
      if (state === 'empty') add('slot-empty', 'info', id, 'Slot is empty: fine for a draft, blocks publishing.');
      if (el.textContent.trim()) add('slot-has-text', 'error', id, 'Slots must not contain text; the placeholder label comes from brand.css.');
      if (r.width < 200 || r.height < 200) add('slot-too-small', 'warning', id, 'Slot is very small for a photo.');
    }
    layers.push(info);
  }
  if (layerEls.length > 45) add('layer-count', 'warning', null, `${layerEls.length} layers; keep designs under ~45 layers so they stay editable.`);

  // images
  for (const img of document.querySelectorAll('img')) {
    const id = img.getAttribute('data-layer') ?? layerOf(img);
    if (!img.hasAttribute('data-layer') && !img.hasAttribute('data-slot-image')) add('img-not-layer', 'error', id, `<img src="${img.getAttribute('src')}"> must be a layer (data-layer + data-type).`);
    const src = img.getAttribute('src') || '';
    if (!/^\/(brand|media)\//.test(src)) add('image-src', 'error', id, `Image src must start with /brand/ or /media/, got "${src.slice(0, 80)}".`);
    if (!img.complete || img.naturalWidth === 0) { add('image-broken', 'error', id, `Image did not load: ${src}`); continue; }
    const r = img.getBoundingClientRect();
    const fit = getComputedStyle(img).objectFit;
    const sx = r.width / img.naturalWidth, sy = r.height / img.naturalHeight;
    const scale = fit === 'contain' || fit === 'scale-down' ? Math.min(sx, sy) : fit === 'none' ? 1 : Math.max(sx, sy);
    if (scale > 1.05) add('image-upscaled', 'warning', id, `Image is shown at ${(scale * 100).toFixed(0)}% of its pixel size (${img.naturalWidth}x${img.naturalHeight}); it will look soft.`, { scale: +scale.toFixed(2) });
    if (fit === 'fill' && Math.abs(sx - sy) / Math.max(sx, sy) > 0.02) add('image-distorted', 'error', id, 'Image is stretched (object-fit:fill with a different aspect ratio).');
  }
  // inline svg
  for (const s of document.querySelectorAll('svg')) {
    const L = s.closest('[data-layer]');
    if (!L || !['shape', 'logo'].includes(L.getAttribute('data-type'))) add('svg-outside-shape', 'error', L?.getAttribute('data-layer'), 'Inline <svg> is only allowed inside a shape layer.');
    if (s.querySelector('text, foreignObject, image, script')) add('svg-content', 'error', L?.getAttribute('data-layer'), 'SVG must not contain text, images, foreignObject or script.');
  }

  // ---------- 4. text outside text layers / undeclared visuals ----------
  const tw = document.createTreeWalker(ab, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (!n.textContent.trim()) continue;
    const L = n.parentElement.closest('[data-layer]');
    if (!L || L.getAttribute('data-type') !== 'text') {
      if (getComputedStyle(n.parentElement).display === 'none') continue;
      add('text-outside-text-layer', 'error', L?.getAttribute('data-layer'), `Text "${n.textContent.trim().slice(0, 40)}" is not inside a data-type="text" layer, so it is not editable.`);
    }
  }
  for (const el of ab.querySelectorAll('*')) {
    if (el.closest('[data-layer]')) continue;
    const cs = getComputedStyle(el);
    const visible = (cs.backgroundColor !== 'rgba(0, 0, 0, 0)' || cs.backgroundImage !== 'none' || parseFloat(cs.borderTopWidth) > 0 || cs.boxShadow !== 'none') && el.getBoundingClientRect().width > 0;
    if (visible) add('undeclared-visual', 'warning', null, `A visible <${el.tagName.toLowerCase()} class="${el.className}"> is not a layer and cannot be selected in the editor.`);
  }

  // ---------- 5. text metrics: overflow, clipping, size, safe area, widows, numbers ----------
  const textLines = {}; // id -> [{x,y,w,h}] for pixel contrast
  const textInfo = [];
  const fontFaces = [...document.fonts];
  fontFaces.filter((f) => f.status === 'error').forEach((f) => add('font-load', 'error', null, `Font failed to load: ${f.family} ${f.style} ${f.weight}`));
  for (const el of document.querySelectorAll('[data-type="text"]')) {
    const id = el.getAttribute('data-layer');
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const raw = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    // merge fragments into visual lines (same vertical band)
    const lines = [];
    for (const r of raw.sort((a, b) => a.top - b.top || a.left - b.left)) {
      const last = lines[lines.length - 1];
      const midY = r.top + r.height / 2;
      if (last && midY > last.top && midY < last.bottom) { last.left = Math.min(last.left, r.left); last.right = Math.max(last.right, r.right); last.top = Math.min(last.top, r.top); last.bottom = Math.max(last.bottom, r.bottom); }
      else lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }
    // Range rects cover the font's full ascent+descent, which is taller than the
    // visible glyphs (and taller than the line box when line-height < 1). Use a
    // "core" band (cap-height-ish) for overlap / safe-area / clipping / contrast.
    const L = lines.map((l) => { const h = l.bottom - l.top; return { x: l.left, y: l.top + 0.14 * h, w: l.right - l.left, h: 0.68 * h }; });
    textLines[id] = L.map((l) => ({ x: Math.round(l.x), y: Math.round(l.y), w: Math.round(l.w), h: Math.round(l.h) }));
    if (!L.length) continue;
    const u = { left: Math.min(...L.map((l) => l.x)), top: Math.min(...L.map((l) => l.y)), right: Math.max(...L.map((l) => l.x + l.w)), bottom: Math.max(...L.map((l) => l.y + l.h)) };
    // occlusion: is something opaque painted on top of the text? (added after the spike's first
    // product post: hexagon badges painted over their B/Zn letters and the DOM checks all passed)
    {
      let pts = 0, hidden = 0; const by = new Set();
      const paints = (e) => {
        if (e.tagName === 'IMG' || e.tagName === 'svg' || e.tagName === 'VIDEO') return true;
        const s = getComputedStyle(e);
        if (s.backgroundImage !== 'none') return true;
        const m = s.backgroundColor.match(/rgba?\(([^)]+)\)/);
        if (!m) return false;
        const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
        return (p.length > 3 ? p[3] : 1) * parseFloat(s.opacity) > 0.5;
      };
      for (const l of L) for (const fx of [0.15, 0.5, 0.85]) {
        const x = l.x + l.w * fx, y = l.y + l.h * 0.5;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        pts++;
        for (const e of document.elementsFromPoint(x, y)) {
          if (e === el || el.contains(e) || e.contains(el)) break;
          if (paints(e)) { hidden++; by.add(e.closest('[data-layer]')?.getAttribute('data-layer') ?? e.tagName.toLowerCase()); break; }
        }
      }
      if (pts && hidden / pts > 0.34) add('text-occluded', 'error', id, `Text is painted underneath "${[...by].join('", "')}" (${hidden}/${pts} sample points covered), so it is not visible. Fix stacking (z-index / DOM order).`);
    }
    // font sizes (smallest run inside the layer)
    let minSize = Infinity; const families = new Set();
    const w2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w2.nextNode(); n; n = w2.nextNode()) {
      if (!n.textContent.trim()) continue;
      const pcs = getComputedStyle(n.parentElement);
      minSize = Math.min(minSize, parseFloat(pcs.fontSize));
      families.add(pcs.fontFamily.split(',')[0].replace(/["']/g, '').trim());
    }
    const role = el.getAttribute('data-role');
    const floor = role === 'legal' ? legalMinFont : minFont;
    if (minSize < floor) add('min-font-size', 'error', id, `Smallest text is ${minSize}px; minimum is ${floor}px at 1080 width (≈${(floor * 0.36).toFixed(0)}px on a phone).`, { fontSize: minSize });
    else if (minSize < warnFont && !['legal', 'eyebrow', 'counter', 'badge'].includes(role)) add('small-font-size', 'warning', id, `Smallest text is ${minSize}px; body copy reads better at ≥ ${warnFont}px.`, { fontSize: minSize });
    for (const f of families) if (!brandFonts.includes(f)) add('font-family', 'error', id, `Font "${f}" is not a brand font (${brandFonts.join(', ')}). Use var(--font-display) / var(--font-text).`);

    // overflow of its own box
    const clipsSelf = cs.overflow !== 'visible' || cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    const fs0 = parseFloat(cs.fontSize);
    if (el.scrollWidth > el.clientWidth + Math.max(2, 0.12 * fs0) || el.scrollHeight > el.clientHeight + Math.max(2, 0.3 * fs0)) {
      if (clipsSelf) add('text-clipped', 'error', id, `Text overflows its box and is clipped (content ${el.scrollWidth}x${el.scrollHeight} > box ${el.clientWidth}x${el.clientHeight}).`);
      else add('text-overflow-box', 'warning', id, `Text extends beyond its own box (content ${el.scrollWidth}x${el.scrollHeight} > box ${el.clientWidth}x${el.clientHeight}); give the box room or shorten the copy.`);
    }
    if (cs.textOverflow === 'ellipsis') add('text-truncated', 'error', id, 'text-overflow: ellipsis hides copy; size the box instead.');
    if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') add('text-line-clamp', 'error', id, 'line-clamp hides copy.');
    // clipping by ancestors (incl. artboard)
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
      const acs = getComputedStyle(a);
      const clips = acs.overflow !== 'visible' || acs.clipPath !== 'none';
      if (!clips) continue;
      const ar = a.getBoundingClientRect();
      if (u.left < ar.left - 1 || u.right > ar.right + 1 || u.top < ar.top - 1 || u.bottom > ar.bottom + 1) {
        add(a === ab ? 'text-outside-artboard' : 'text-clipped', 'error', id, `Text is cut off by ${a === ab ? 'the artboard edge' : `ancestor "${a.getAttribute('data-layer') ?? a.tagName.toLowerCase()}"`}.`);
        break;
      }
    }
    // safe area
    const s = { l: u.left - safe, t: u.top - safe, r: width - safe - u.right, b: height - safe - u.bottom };
    const worst = Math.min(s.l, s.t, s.r, s.b);
    if (worst < -0.5) add('safe-area', 'warning', id, `Text is ${Math.round(-worst)}px outside the ${safe}px safe margin (left ${Math.round(u.left)}, top ${Math.round(u.top)}, right ${Math.round(width - u.right)}, bottom ${Math.round(height - u.bottom)} from the edges).`);
    // widow in large text
    const fsz = parseFloat(cs.fontSize);
    if (L.length >= 2 && fsz >= 44) {
      const maxW = Math.max(...L.map((l) => l.w));
      const lastW = L[L.length - 1].w;
      const lastText = (el.innerText || '').trim().split(/\n/).pop() || '';
      if (lastW < maxW * 0.22 || (lastText.trim().split(/\s+/).length === 1 && lastW < maxW * 0.4)) add('widow', 'warning', id, `Last line is a lone short word ("${lastText.trim().slice(0, 24)}"); rebalance the line breaks (text-wrap: balance or a manual <br>).`);
    }
    // unverified numbers
    const txt = el.textContent;
    for (const m of txt.matchAll(/\d+(?:[.,]\d+)*\s*[a-zA-ZçğıöşüÇĞİÖŞÜ%]{0,2}/g)) {
      const raw2 = m[0].trim();
      const lower = raw2.toLowerCase().replace(/\s+/g, '');
      const digits = lower.match(/^\d+(?:[.,]\d+)*/)[0];
      const cands = [lower, digits, lower.replace(/^0+(?=\d)/, ''), digits.replace(/^0+(?=\d)/, '')];
      if (!cands.some((c) => allowedNumbers.includes(c))) add('unverified-number', 'error', id, `"${raw2}" is not a high-confidence fact from facts.json; remove it or use only verified numbers.`);
    }
    if (/%/.test(txt)) add('percentage', 'warning', id, 'Percent sign in copy: make sure it is a verified fact (the label percentages are low confidence).');
    textInfo.push({ id, role, lines: L.length, fontSize: fsz, minFontSize: minSize, weight: cs.fontWeight, family: [...families].join(','), color: cs.color, clipText: (cs.webkitBackgroundClip || cs.backgroundClip) === 'text', textRect: { x: Math.round(u.left), y: Math.round(u.top), w: Math.round(u.right - u.left), h: Math.round(u.bottom - u.top) }, chars: txt.trim().length });
  }

  // ---------- 6. overlaps ----------
  const ids2 = Object.keys(textLines);
  const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  for (let i = 0; i < ids2.length; i++) for (let j = i + 1; j < ids2.length; j++) {
    const A = textLines[ids2[i]], B = textLines[ids2[j]];
    const allowA = ids.get(ids2[i])?.hasAttribute('data-allow-overlap'), allowB = ids.get(ids2[j])?.hasAttribute('data-allow-overlap');
    let area = 0; for (const a of A) for (const b of B) area += inter(a, b);
    if (area > 40 && !(allowA || allowB)) add('text-overlap', 'error', ids2[i], `Text of "${ids2[i]}" overlaps text of "${ids2[j]}" (${Math.round(area)}px²).`, { other: ids2[j] });
  }
  for (const lg of document.querySelectorAll('[data-type="logo"]')) {
    const lr = lg.getBoundingClientRect();
    const lb = { x: lr.left, y: lr.top, w: lr.width, h: lr.height };
    for (const id of ids2) { let area = 0; for (const a of textLines[id]) area += inter(a, lb); if (area > 40) add('text-logo-overlap', 'error', id, `Text overlaps logo "${lg.getAttribute('data-layer')}".`); }
    const s = Math.min(lr.left - safe, lr.top - safe, width - safe - lr.right, height - safe - lr.bottom);
    if (s < -0.5) add('safe-area', 'warning', lg.getAttribute('data-layer'), `Logo is ${Math.round(-s)}px outside the ${safe}px safe margin.`);
  }

  return { issues, layers, text: textInfo, textLines, fontsLoaded: fontFaces.filter((f) => f.status === 'loaded').map((f) => `${f.family} ${f.style} ${f.weight} ${f.stretch}`) };
}
