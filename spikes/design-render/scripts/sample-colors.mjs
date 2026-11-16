// Samples brand colours from the product photo. Reports the median colour of
// "ink" pixels (pixels that differ clearly from the white bag) inside each region.
// Usage: node scripts/sample-colors.mjs brand/venta/assets/product-venta-borinc.png
import sharp from 'sharp';
import fs from 'node:fs';

const file = process.argv[2];
const regions = {
  // name: [left, top, width, height] in source pixels (1200x1200 photo)
  'band-green':     [420, 376, 360, 6],   // horizontal green band at top of label
  'band-green-low': [380, 902, 440, 6],   // green band at the bottom of the label
  'hex-boron-orange': [415, 412, 26, 26],
  'hex-zinc-green':   [452, 412, 26, 26],
  'wordmark-black':   [505, 515, 180, 45], // VENTA logotype
  'borinc-green':     [535, 563, 120, 28], // BORINC
  'mtm-agro-grey':    [680, 422, 100, 12],
  'body-text-grey':   [385, 650, 180, 10],
};
const img = sharp(file).removeAlpha();
const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const out = {};
for (const [name, [l, t, w, h]] of Object.entries(regions)) {
  const R = [], G = [], B = [];
  let total = 0;
  for (let y = t; y < t + h; y++) for (let x = l; x < l + w; x++) {
    const i = (y * info.width + x) * 3;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    total++;
    // ink = clearly darker or more saturated than the white/grey bag
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max - min > 40 || max < 150) { R.push(r); G.push(g); B.push(b); }
  }
  out[name] = R.length ? { hex: hex(median(R), median(G), median(B)), inkPixels: R.length, of: total } : { hex: null, inkPixels: 0, of: total };
}
// bag surface and photo background
for (const [name, [l, t, w, h]] of Object.entries({ 'bag-surface': [560, 760, 40, 40], 'photo-background': [20, 20, 60, 60] })) {
  const R = [], G = [], B = [];
  for (let y = t; y < t + h; y++) for (let x = l; x < l + w; x++) { const i = (y * info.width + x) * 3; R.push(data[i]); G.push(data[i + 1]); B.push(data[i + 2]); }
  out[name] = { hex: hex(median(R), median(G), median(B)) };
}
console.log(JSON.stringify(out, null, 2));
if (process.argv[3]) fs.writeFileSync(process.argv[3], JSON.stringify({ source: file, method: 'median of ink pixels per region', regions, samples: out }, null, 2));
