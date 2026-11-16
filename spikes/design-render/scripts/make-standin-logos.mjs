// Renders TYPESET STAND-IN logos (transparent PNG) from the brand fonts.
// These are placeholders, not the real VENTA / MTM AGRO artwork.
// Usage: node scripts/make-standin-logos.mjs brand/venta
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';

const brandDir = process.argv[2] ?? 'brand/venta';
fs.mkdirSync(path.join(brandDir, 'logos'), { recursive: true });
const brandCss = fs.readFileSync(path.join(brandDir, 'brand.css'), 'utf8');
const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });
const jobs = [
  { file: 'venta-wordmark-black.standin.png', w: 1200, h: 252, color: '#0B0B0B', html: '<span class="w">VENTA</span>' },
  { file: 'venta-wordmark-white.standin.png', w: 1200, h: 252, color: '#FFFFFF', html: '<span class="w">VENTA</span>' },
  { file: 'mtm-agro-graphite.standin.png', w: 1200, h: 120, color: '#2F2F2F', html: '<span class="m">MTM AGRO</span>' },
  { file: 'mtm-agro-white.standin.png', w: 1200, h: 120, color: '#FFFFFF', html: '<span class="m">MTM AGRO</span>' },
];
for (const j of jobs) {
  const ctx = await browser.newContext({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: 1 });
  await ctx.route('https://studio.local/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    if (p.startsWith('/brand/')) return r.fulfill({ body: fs.readFileSync(path.join(brandDir, p.slice(7))), contentType: 'font/woff2' });
    return r.fulfill({ body: '<!doctype html><html></html>', contentType: 'text/html' });
  });
  const page = await ctx.newPage();
  await page.goto('https://studio.local/blank');
  await page.setContent(`<html lang="tr"><head><base href="https://studio.local/"><style>${brandCss}
    html,body{background:transparent!important;margin:0}
    .box{width:${j.w}px;height:${j.h}px;display:flex;align-items:center;justify-content:center;color:${j.color}}
    .w{font-family:'Archivo';font-weight:900;font-stretch:125%;font-style:italic;font-size:236px;line-height:1;letter-spacing:-0.02em}
    .m{font-family:'Archivo';font-weight:700;font-stretch:125%;font-size:96px;line-height:1;letter-spacing:0.12em}
  </style></head><body><div class="box">${j.html}</div></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const png = await page.screenshot({ omitBackground: true });
  // trim to the ink bounds so the <img> box equals the visible logo
  const { data, info } = await sharp(png).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
  fs.writeFileSync(path.join(brandDir, 'logos', j.file), data);
  await ctx.close();
  console.log('wrote', j.file, `${info.width}x${info.height}`);
}
await browser.close();
