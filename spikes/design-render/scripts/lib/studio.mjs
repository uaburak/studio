// Shared Chromium page setup for render + lint.
// Designs are loaded from a fake origin (https://studio.local) so that root-relative
// URLs (/brand/..., /media/...) resolve to local folders. Every other request is
// aborted and recorded: rendering never touches the network.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

export const ORIGIN = 'https://studio.local';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

export async function launch() {
  return chromium.launch({
    headless: true,
    args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text', '--hide-scrollbars'],
  });
}

/**
 * Open one design file in a fresh, JS-disabled context.
 * @returns {{page, context, blocked: string[], served: string[]}}
 */
export async function openDesign(browser, { htmlPath, brandDir, mediaDir, width = 1080, height = 1350 }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    javaScriptEnabled: false, // statics have no JS; Playwright's evaluate() still works (protocol-level)
    colorScheme: 'light',
    locale: 'tr-TR',
    offline: false,
  });
  const blocked = [];
  const served = [];
  const htmlAbs = path.resolve(htmlPath);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) { blocked.push(route.request().url()); return route.abort('blockedbyclient'); }
    let file = null;
    const p = decodeURIComponent(url.pathname);
    if (p === '/design.html') file = htmlAbs;
    else if (p.startsWith('/brand/')) file = path.join(path.resolve(brandDir), p.slice('/brand/'.length));
    else if (p.startsWith('/media/') && mediaDir) file = path.join(path.resolve(mediaDir), p.slice('/media/'.length));
    const root = file && (p.startsWith('/brand/') ? path.resolve(brandDir) : p.startsWith('/media/') ? path.resolve(mediaDir) : path.dirname(htmlAbs));
    if (!file || !file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      blocked.push(route.request().url() + ' (not found)');
      return route.fulfill({ status: 404, body: 'not found' });
    }
    served.push(p);
    return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' } });
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/design.html`, { waitUntil: 'load' });
  // Wait for fonts and images: font-display:block + explicit decode.
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => null))));
    await document.fonts.ready;
  });
  return { page, context, blocked, served };
}

export async function artboardRect(page) {
  return page.evaluate(() => {
    const a = document.querySelector('[data-artboard]');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/** Screenshot the artboard to PNG, then write an sRGB JPEG (ICC embedded). */
export async function renderFiles(page, { pngPath, jpgPath, width = 1080, height = 1350, quality = 92 }) {
  const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height }, animations: 'disabled', caret: 'hide' });
  if (pngPath) fs.writeFileSync(pngPath, png);
  if (jpgPath) {
    await sharp(png)
      .toColorspace('srgb')
      .jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true })
      .withIccProfile('srgb')
      .toFile(jpgPath);
  }
  return png;
}
