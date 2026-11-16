// Render + lint one design file.
// Usage: node scripts/lint.mjs <design.html> [--brand brand/venta] [--media <dir>] [--out <base>]
// Writes <base>.png, <base>.jpg, <base>.lint.json and prints the issue list.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { launch } from './lib/studio.mjs';
import { checkDesign } from './lib/check.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { brand: { type: 'string', default: 'brand/venta' }, media: { type: 'string' }, out: { type: 'string' } } });
const html = positionals[0];
if (!html) { console.error('usage: node scripts/lint.mjs <design.html> [--brand dir] [--media dir] [--out base]'); process.exit(2); }
const brand = JSON.parse(fs.readFileSync(path.join(values.brand, 'brand.json'), 'utf8'));
const facts = JSON.parse(fs.readFileSync(path.join(values.brand, 'facts.json'), 'utf8'));
const outBase = values.out ?? html.replace(/\.html$/, '');
const browser = await launch();
try {
  const { report } = await checkDesign(browser, { htmlPath: html, brandDir: values.brand, mediaDir: values.media ?? path.dirname(html), outBase, brand, facts });
  console.log(`${report.ok ? 'PASS' : 'FAIL'} ${html}  errors=${report.summary.errors} warnings=${report.summary.warnings} info=${report.summary.info}  render=${report.timing.renderMs}ms total=${report.timing.totalMs}ms`);
  for (const i of report.issues) console.log(`  [${i.severity}] ${i.rule}${i.layer ? ` (${i.layer})` : ''}: ${i.message}`);
  process.exitCode = report.ok ? 0 : 1;
} finally {
  await browser.close();
}
