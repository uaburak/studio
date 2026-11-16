// render + lint in one page load. Produces:
//   <outBase>.png / <outBase>.jpg   the render
//   <outBase>.lint.json             machine-readable lint report (fed back to Claude)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { openDesign, renderFiles } from './studio.mjs';
import { inPageLint } from './lint-inpage.js';

export const LINT_DEFAULTS = {
  width: 1080,
  height: 1350,
  safe: 64,          // px; also covers Instagram's 3:4 profile-grid crop of 4:5 posts (~34px each side)
  minFont: 24,       // hard floor at 1080 width
  warnFont: 28,      // body copy floor
  legalMinFont: 20,  // data-role="legal" (contact lines, footnotes)
  allowedTypes: ['text', 'image', 'shape', 'logo', 'slot', 'group'],
};

function lum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
function parseColor(s) {
  const m = s.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 };
}
const pct = (arr, q) => arr[Math.min(arr.length - 1, Math.max(0, Math.floor(q * (arr.length - 1))))];

/**
 * @param browser playwright Browser
 * @param o { htmlPath, brandDir, mediaDir, outBase, brand (brand.json), facts (facts.json) }
 */
export async function checkDesign(browser, o) {
  const cfg = { ...LINT_DEFAULTS, ...(o.lint ?? {}) };
  const t0 = Date.now();
  const { page, context, blocked } = await openDesign(browser, { htmlPath: o.htmlPath, brandDir: o.brandDir, mediaDir: o.mediaDir, width: cfg.width, height: cfg.height });
  try {
    const png = await renderFiles(page, { pngPath: `${o.outBase}.png`, jpgPath: `${o.outBase}.jpg`, width: cfg.width, height: cfg.height });
    const tRender = Date.now() - t0;
    const brandFonts = [o.brand.font.display.family, o.brand.font.text.family];
    const res = await page.evaluate(inPageLint, { ...cfg, brandFonts, allowedNumbers: o.facts.allowedNumbers });
    for (const b of blocked) res.issues.push({ rule: 'network-request', severity: b.includes('(not found)') ? 'error' : 'error', layer: null, message: `Blocked/missing request: ${b}` });

    // ---- pixel-based contrast: hide text, screenshot the background, compare ----
    await page.evaluate(() => {
      const st = document.createElement('style');
      st.textContent = '[data-type="text"], [data-type="text"] * { color: transparent !important; text-shadow: none !important; -webkit-text-stroke-color: transparent !important; text-decoration-color: transparent !important; -webkit-text-fill-color: transparent !important; }';
      document.head.appendChild(st);
    });
    const bgPng = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: cfg.width, height: cfg.height } });
    const { data, info } = await sharp(bgPng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (const t of res.text) {
      const tc = parseColor(t.color);
      if (!tc || t.clipText) { res.issues.push({ rule: 'contrast-unknown', severity: 'info', layer: t.id, message: 'Text colour could not be measured (gradient/clip text).' }); continue; }
      const lums = []; const px = [];
      for (const r of res.textLines[t.id] ?? []) {
        for (let y = Math.max(0, r.y + 1); y < Math.min(info.height, r.y + r.h - 1); y += 2)
          for (let x = Math.max(0, r.x + 1); x < Math.min(info.width, r.x + r.w - 1); x += 2) {
            const i = (y * info.width + x) * 3; const c = [data[i], data[i + 1], data[i + 2]]; px.push(c); lums.push(lum(c));
          }
      }
      if (!px.length) continue;
      const order = lums.map((l, i) => [l, i]).sort((a, b) => a[0] - b[0]);
      const pick = (q) => px[order[Math.floor(q * (order.length - 1))][1]];
      const bgMed = pick(0.5), bgDark = pick(0.05), bgLight = pick(0.95);
      const blend = (bg) => tc.rgb.map((c, k) => c * tc.a + bg[k] * (1 - tc.a));
      const cMed = contrast(blend(bgMed), bgMed);
      const cWorst = Math.min(contrast(blend(bgDark), bgDark), contrast(blend(bgLight), bgLight));
      const large = t.fontSize >= 48 || (t.fontSize >= 36 && Number(t.weight) >= 700);
      const need = large ? 3 : 4.5;
      t.contrast = { median: +cMed.toFixed(2), worst: +cWorst.toFixed(2), required: need, background: `rgb(${bgMed.join(',')})` };
      if (cMed < need) res.issues.push({ rule: 'contrast', severity: 'error', layer: t.id, message: `Contrast ${cMed.toFixed(2)}:1 against its background (needs ${need}:1 for ${large ? 'large' : 'normal'} text).`, data: t.contrast });
      else if (cWorst < need) res.issues.push({ rule: 'contrast-busy-background', severity: 'warning', layer: t.id, message: `Contrast drops to ${cWorst.toFixed(2)}:1 on parts of the background (median ${cMed.toFixed(2)}:1).`, data: t.contrast });
    }

    const order = { error: 0, warning: 1, info: 2 };
    res.issues.sort((a, b) => order[a.severity] - order[b.severity]);
    const summary = { errors: res.issues.filter((i) => i.severity === 'error').length, warnings: res.issues.filter((i) => i.severity === 'warning').length, info: res.issues.filter((i) => i.severity === 'info').length };
    const report = {
      contract: 'v0', file: path.relative(process.cwd(), o.htmlPath), artboard: { width: cfg.width, height: cfg.height },
      ok: summary.errors === 0, summary, issues: res.issues,
      layers: res.layers, text: res.text, fontsLoaded: res.fontsLoaded,
      timing: { renderMs: tRender, totalMs: Date.now() - t0 },
    };
    fs.writeFileSync(`${o.outBase}.lint.json`, JSON.stringify(report, null, 2));
    return { report, png };
  } finally {
    await context.close();
  }
}

/** Compact form of a lint report for prompts. */
export function lintForPrompt(report) {
  return {
    ok: report.ok, summary: report.summary,
    issues: report.issues.map(({ rule, severity, layer, message }) => ({ rule, severity, layer, message })),
    text: report.text.map(({ id, role, lines, fontSize, minFontSize, textRect, contrast: c }) => ({ id, role, lines, fontSize, minFontSize, textRect, contrast: c ? `${c.median}:1 (min ${c.worst}:1, need ${c.required}:1)` : null })),
  };
}
