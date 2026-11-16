// Editor operation stand-in: fill an image slot in a design (pure DOM edit), then lint + render.
// Usage: node scripts/fill-slot.mjs <design.html> <slot-layer-id> <image-file> --out <base>
// The image is copied into <dir of out>/media/ and referenced as /media/<name>.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { launch } from './lib/studio.mjs';
import { checkDesign } from './lib/check.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { out: { type: 'string' }, brand: { type: 'string', default: 'brand/venta' } } });
const [html, slotId, image] = positionals;
const outBase = values.out;
const mediaDir = path.join(path.dirname(outBase), 'media');
fs.mkdirSync(mediaDir, { recursive: true });
fs.copyFileSync(image, path.join(mediaDir, path.basename(image)));
let src = fs.readFileSync(html, 'utf8');
// find the slot element's opening tag by its data-layer id and flip its state; insert the image
const re = new RegExp(`(<[a-z]+[^>]*data-layer="${slotId}"[^>]*?)data-slot-state="empty"([^>]*>)`, 's');
if (!re.test(src)) throw new Error(`slot ${slotId} (empty) not found`);
src = src.replace(re, `$1data-slot-state="filled"$2<img data-slot-image src="/media/${path.basename(image)}" alt="">`);
fs.writeFileSync(`${outBase}.html`, src);
const brand = JSON.parse(fs.readFileSync(path.join(values.brand, 'brand.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(values.brand, 'facts.json'), 'utf8'));
const browser = await launch();
try {
  const { report } = await checkDesign(browser, { htmlPath: `${outBase}.html`, brandDir: values.brand, mediaDir, outBase, brand, facts });
  console.log(`${report.ok ? 'PASS' : 'FAIL'} ${outBase}.html errors=${report.summary.errors} warnings=${report.summary.warnings}`);
  for (const i of report.issues) console.log(`  [${i.severity}] ${i.rule}${i.layer ? ` (${i.layer})` : ''}: ${i.message}`);
} finally { await browser.close(); }
