// Brief -> headless Claude -> HTML -> lint+render -> ONE critique-and-revise pass -> final render.
//
// Usage:
//   node scripts/generate.mjs briefs/01-product-intro.json [--transport cli|handoff] [--model opus] [--effort high] [--tag run2]
//
// Output: out/<brief-id>/
//   v1/slide-N.html|.jpg|.png|.lint.json   first pass
//   v2/slide-N.html|.jpg|.png|.lint.json   after critique-and-revise
//   compare.jpg                            first pass (left) vs final (right)
//   caption.v1.txt, caption.v2.txt, critique.json, run.json (timings, tokens, lint summaries)
//   llm/                                   exact requests (and handoff responses / CLI stream logs)
//
// The run is resumable: each step's result is cached on disk. With --transport handoff the script stops
// with exit code 3 when it needs an LLM response and prints the request path.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { launch } from './lib/studio.mjs';
import { checkDesign, lintForPrompt } from './lib/check.mjs';
import { callCli, callHandoff } from './lib/claude.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    transport: { type: 'string', default: process.env.STUDIO_TRANSPORT ?? 'cli' },
    model: { type: 'string', default: process.env.STUDIO_MODEL ?? 'opus' },
    effort: { type: 'string', default: process.env.STUDIO_EFFORT },
    claude: { type: 'string', default: process.env.STUDIO_CLAUDE_BIN ?? 'claude' },
    tag: { type: 'string' },   // writes to out/<brief-id>--<tag>/ so stored runs are kept
  },
});
const briefPath = positionals[0];
if (!briefPath) { console.error('usage: node scripts/generate.mjs <brief.json> [--transport cli|handoff] [--model opus]'); process.exit(2); }
const brief = JSON.parse(fs.readFileSync(briefPath, 'utf8'));
const brandDir = path.join(ROOT, 'brand', brief.brand);
const outDir = path.join(ROOT, 'out', values.tag ? `${brief.id}--${values.tag}` : brief.id);
const llmDir = path.join(outDir, 'llm');
fs.mkdirSync(llmDir, { recursive: true });
const [W, H] = brief.format.split('x').map(Number);
const slideIds = Array.from({ length: brief.slides }, (_, i) => `slide-${i + 1}`);

// ---------- prompt assembly ----------
const read = (p) => fs.readFileSync(p, 'utf8');
const brand = JSON.parse(read(path.join(brandDir, 'brand.json')));
const facts = JSON.parse(read(path.join(brandDir, 'facts.json')));
const css = read(path.join(brandDir, 'brand.css'));
const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
const assets = [
  ...Object.entries(brand.logos).filter(([k]) => !k.startsWith('$')).map(([k, v]) => `- /brand/${v.path}  (logo "${k}", ${v.intrinsic[0]}x${v.intrinsic[1]} px, aspect ${v.aspect}, for ${v.on} backgrounds; STAND-IN typeset logo)`),
  ...Object.entries(brand.assets).map(([k, v]) => `- /brand/${v.path}  (image "${k}", ${v.intrinsic[0]}x${v.intrinsic[1]} px; ${v.note})`),
].join('\n');
const system = fill(read(path.join(ROOT, 'prompts/system.md')), {
  ASSETS: assets,
  CONTRACT: read(path.join(ROOT, 'CONTRACT.md')),
  BRAND_JSON: JSON.stringify(brand, null, 1),
  CSS_VARS: [...new Set(css.match(/--[a-z0-9-]+(?=:)/g))].join(' '),
  TYPE_CLASSES: [...new Set(css.match(/\.ts-[a-z0-9-]+/g))].join(' '),
  DESIGN_MD: read(path.join(brandDir, 'DESIGN.md')),
  VOICE_MD: read(path.join(brandDir, 'VOICE.md')),
  FACTS_JSON: JSON.stringify(facts, null, 1),
});
const requirements = brief.requirements.map((r) => `  - ${r}`).join('\n');

const slideSchema = { type: 'object', properties: { id: { type: 'string' }, html: { type: 'string' } }, required: ['id', 'html'] };
const critiqueSchema = { type: 'array', items: { type: 'object', properties: { issue: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] }, fix: { type: 'string' } }, required: ['issue', 'severity', 'fix'] } };
const schemaFor = (revise) => ({
  type: 'object',
  properties: {
    slides: { type: 'array', minItems: brief.slides, maxItems: brief.slides, items: slideSchema },
    caption: { type: 'string' }, rationale: { type: 'string' },
    critique: critiqueSchema, changes: { type: 'array', items: { type: 'string' } },
  },
  required: revise ? ['slides', 'caption', 'rationale', 'critique', 'changes'] : ['slides', 'caption', 'rationale'],
});

// ---------- run state ----------
const runPath = path.join(outDir, 'run.json');
const run = fs.existsSync(runPath) ? JSON.parse(read(runPath)) : { brief: brief.id, transport: values.transport, model: values.model, steps: {} };
const save = () => fs.writeFileSync(runPath, JSON.stringify(run, null, 2));

async function llm(step, userText, images, revise) {
  const cached = path.join(llmDir, `${step}.output.json`);
  if (fs.existsSync(cached)) return JSON.parse(read(cached));
  const schema = schemaFor(revise);
  let res;
  if (values.transport === 'cli') {
    res = await callCli({ claudeBin: values.claude, cwd: path.join(ROOT, 'work', path.basename(outDir)), system, userText, images, schema, model: values.model, effort: values.effort, logBase: path.join(llmDir, step) });
    if (!res.ok) throw new Error(`${step}: headless call failed: ${res.error ?? 'no structured_output'}`);
  } else {
    res = callHandoff({ dir: llmDir, step, system, userText, images, schema, slideIds });
    if (res.pending) {
      console.log(`AWAITING ${step}: request ${res.requestPath}\n  write the response to ${res.responseDir}/`);
      save();
      process.exit(3);
    }
  }
  const { output, ...rest } = res;
  run.steps[step] = { transport: values.transport, ...rest, at: new Date().toISOString() };
  save();
  fs.writeFileSync(cached, JSON.stringify(output, null, 2));
  return output;
}

async function checkVersion(browser, ver, output) {
  const dir = path.join(outDir, ver);
  fs.mkdirSync(dir, { recursive: true });
  const reports = [];
  for (const s of output.slides) {
    const html = path.join(dir, `${s.id}.html`);
    fs.writeFileSync(html, s.html);
    const { report } = await checkDesign(browser, { htmlPath: html, brandDir, mediaDir: path.join(outDir, 'media'), outBase: path.join(dir, s.id), brand, facts, lint: { width: W, height: H } });
    reports.push({ id: s.id, report });
    console.log(`  ${ver}/${s.id}: ${report.ok ? 'PASS' : 'FAIL'} errors=${report.summary.errors} warnings=${report.summary.warnings} (render ${report.timing.renderMs}ms)`);
  }
  fs.writeFileSync(path.join(outDir, `caption.${ver}.txt`), output.caption ?? '');
  // same numbers guard as the in-page linter, applied to the caption
  const captionUnverified = [...(output.caption ?? '').matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0])
    .filter((n) => !facts.allowedNumbers.includes(n) && !facts.allowedNumbers.includes(n.replace(/^0+(?=\d)/, '')));
  if (captionUnverified.length) console.log(`  ${ver}/caption: unverified numbers ${captionUnverified.join(', ')}`);
  run.steps[`check-${ver}`] = { captionUnverifiedNumbers: captionUnverified, slides: reports.map(({ id, report }) => ({ id, ok: report.ok, ...report.summary, rules: [...new Set(report.issues.filter((i) => i.severity !== 'info').map((i) => `${i.severity}:${i.rule}`))] })) };
  save();
  return reports;
}

async function compareImage() {
  const tiles = [];
  for (const id of slideIds) for (const ver of ['v1', 'v2']) tiles.push({ id, ver, file: path.join(outDir, ver, `${id}.jpg`) });
  const tw = 540, th = Math.round(540 * H / W), pad = 24, label = 56;
  const cols = 2, rows = slideIds.length;
  const width = cols * tw + (cols + 1) * pad, height = rows * (th + label) + (rows + 1) * pad;
  const comps = [];
  for (const [i, t] of tiles.entries()) {
    const c = i % 2, r = Math.floor(i / 2);
    const x = pad + c * (tw + pad), y = pad + r * (th + label + pad);
    comps.push({ input: await sharp(t.file).resize(tw, th).toBuffer(), left: x, top: y + label });
    const txt = `${t.id} — ${t.ver === 'v1' ? 'first pass' : 'after critique + revise'}`;
    comps.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${label}"><text x="0" y="36" font-family="Helvetica, Arial, sans-serif" font-size="24" font-weight="700" fill="#222">${txt}</text></svg>`), left: x, top: y });
  }
  await sharp({ create: { width, height, channels: 3, background: '#ececec' } }).composite(comps).jpeg({ quality: 88 }).toFile(path.join(outDir, 'compare.jpg'));
}

// ---------- pipeline ----------
console.log(`[${brief.id}] transport=${values.transport} model=${values.model}`);
const browser = await launch();
try {
  const tStart = Date.now();
  // 1. first pass
  const genText = fill(read(path.join(ROOT, 'prompts/generate.md')), {
    BRAND_NAME: `${brand.name} (${brand.owner}) — profile status: ${brand.status}`,
    FORMAT: brief.format, SLIDES: String(brief.slides), SLIDE_IDS: brief.slides > 1 ? ` (${slideIds.join(', ')})` : ' (slide-1)',
    BRIEF: brief.brief, REQUIREMENTS: requirements,
  });
  const v1 = await llm('01-generate', genText, [], false);
  const r1 = await checkVersion(browser, 'v1', v1);

  // 2. critique and revise (ONE pass), with renders + lint report
  const images = slideIds.map((id) => path.join(outDir, 'v1', `${id}.jpg`));
  const revText = fill(read(path.join(ROOT, 'prompts/revise.md')), {
    PLURAL: images.length > 1 ? 's' : '',
    IMAGE_LIST: slideIds.map((id) => `${id}.jpg`).join(', '),
    BRIEF: brief.brief, REQUIREMENTS: requirements,
    CAROUSEL_NOTE: brief.slides > 1 ? '- carousel: do the slides read as one system (same margins, header/footer positions, type styles) and does the sequence work?' : '',
    LINT: JSON.stringify(r1.map(({ id, report }) => ({ slide: id, ...lintForPrompt(report) })), null, 1),
    HTML: v1.slides.map((s) => `<!-- ${s.id} -->\n${s.html}`).join('\n\n'),
  });
  const v2 = await llm('02-revise', revText, images, true);
  fs.writeFileSync(path.join(outDir, 'critique.json'), JSON.stringify({ critique: v2.critique, changes: v2.changes, rationale_v1: v1.rationale, rationale_v2: v2.rationale }, null, 2));
  await checkVersion(browser, 'v2', v2);
  await compareImage();
  run.pipelineMsThisInvocation = Date.now() - tStart;
  save();
  console.log(`[${brief.id}] done -> ${path.relative(ROOT, outDir)}/compare.jpg`);
} finally {
  await browser.close();
}
