// Render one design file to PNG + sRGB JPEG (no lint).
// Usage: node scripts/render.mjs <design.html> --out <file.jpg> [--brand brand/venta] [--media <dir>]
import { parseArgs } from 'node:util';
import path from 'node:path';
import { launch, openDesign, renderFiles } from './lib/studio.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, brand: { type: 'string', default: 'brand/venta' }, media: { type: 'string' }, width: { type: 'string', default: '1080' }, height: { type: 'string', default: '1350' } } });
const html = positionals[0];
const out = values.out ?? html.replace(/\.html$/, '.jpg');
const width = Number(values.width), height = Number(values.height);
const browser = await launch();
try {
  const t0 = Date.now();
  const { page, context, blocked } = await openDesign(browser, { htmlPath: html, brandDir: values.brand, mediaDir: values.media ?? path.dirname(html), width, height });
  await renderFiles(page, { pngPath: out.replace(/\.jpe?g$/, '.png'), jpgPath: out, width, height });
  await context.close();
  console.log(`rendered ${out} in ${Date.now() - t0}ms${blocked.length ? `; blocked: ${blocked.join(', ')}` : ''}`);
} finally {
  await browser.close();
}
