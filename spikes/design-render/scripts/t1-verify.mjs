// T1 verification: headless Claude on the subscription, from a Node script.
// Run from a PLAIN terminal (not inside a Claude Code / Claude desktop session), after the CLI is
// logged in:   claude auth login      (or: export CLAUDE_CODE_OAUTH_TOKEN=... from `claude setup-token`)
//
//   cd spikes/design-render && node scripts/t1-verify.mjs
//
// Makes 5 small model calls (~15-25k tokens in total). Writes logs/t1-results.json.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cleanEnv, lockedDownArgs } from './lib/claude.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const WORK = path.join(ROOT, 'work', 't1');
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
const CLAUDE = process.env.STUDIO_CLAUDE_BIN ?? 'claude';
const MODEL = process.env.STUDIO_MODEL ?? 'opus';
const sys = path.join(WORK, 'system.md');
fs.writeFileSync(sys, 'You are a careful assistant used by an automated pipeline. Answer only what is asked.');
const photo = path.join(ROOT, 'brand/venta/assets/product-venta-borinc.png');
fs.copyFileSync(photo, path.join(WORK, 'product.png'));
// a file OUTSIDE the working directory, to test confinement
const nonce = crypto.randomBytes(6).toString('hex');
const outside = path.join(ROOT, 'work', 'outside-probe.txt');
fs.writeFileSync(outside, `secret-nonce-${nonce}\n`);

if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_SESSION_ID) console.warn('WARNING: running inside a Claude Code session. The child gets a clean env anyway, but the CLI must have its own login.');
if (process.env.ANTHROPIC_API_KEY) console.warn('NOTE: ANTHROPIC_API_KEY is set in this shell. It is NOT passed to the child (cleanEnv), so calls still use the subscription.');

const auth = spawnSync(CLAUDE, ['auth', 'status'], { env: cleanEnv(), encoding: 'utf8' });
let authInfo = {}; try { const a = JSON.parse(auth.stdout); authInfo = { loggedIn: a.loggedIn, authMethod: a.authMethod, apiProvider: a.apiProvider, subscriptionType: a.subscriptionType }; } catch { authInfo = { raw: auth.stdout.slice(0, 200) }; }
console.log('auth status:', JSON.stringify(authInfo));

function run(name, args, content) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, args, { cwd: WORK, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      fs.writeFileSync(path.join(ROOT, 'logs', `t1-${name}.jsonl`), out);
      const lines = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const init = lines.find((l) => l.type === 'system' && l.subtype === 'init') ?? {};
      const r = lines.findLast((l) => l.type === 'result') ?? {};
      resolve({
        name, exitCode: code, wallMs: Date.now() - t0, durationMs: r.duration_ms, durationApiMs: r.duration_api_ms,
        model: init.model, tools: init.tools, mcpServers: init.mcp_servers, apiKeySource: init.apiKeySource, permissionMode: init.permissionMode,
        isError: r.is_error, error: r.is_error ? r.result : undefined,
        usage: r.usage ? { input: r.usage.input_tokens, output: r.usage.output_tokens, cacheRead: r.usage.cache_read_input_tokens, cacheWrite: r.usage.cache_creation_input_tokens, serviceTier: r.usage.service_tier, fallbackCredit: r.usage.fallback_credit } : null,
        modelUsage: r.modelUsage, costUsdEstimate: r.total_cost_usd, permissionDenials: r.permission_denials,
        structured: r.structured_output, text: r.result, stderr: err.slice(0, 300),
      });
    });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    child.stdin.end();
  });
}
const text = (t) => [{ type: 'text', text: t }];
const base = (extra = {}) => lockedDownArgs({ model: MODEL, systemPromptFile: sys, ...extra });

const results = [];
// (a) structured JSON output against a schema, no tools at all
results.push(await run('a-structured', base({ schema: { type: 'object', properties: { city: { type: 'string' }, plate_code: { type: 'integer' } }, required: ['city', 'plate_code'] } }), text('Antalya ilinin plaka kodu nedir? JSON ile yanıtla.')));
// (b1) vision: image sent as a base64 content block (no file tools needed)
const visionSchema = { type: 'object', properties: { product_name: { type: 'string' }, brand: { type: 'string' }, package_type: { type: 'string' }, colours_hex: { type: 'array', items: { type: 'string' } }, readable_text: { type: 'array', items: { type: 'string' } } }, required: ['product_name', 'brand', 'package_type', 'colours_hex', 'readable_text'] };
results.push(await run('b1-vision-block', base({ schema: visionSchema }), [...text('Describe this product photo. List only text you can actually read.'), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fs.readFileSync(photo).toString('base64') } }]));
// (b2) vision: Claude reads the image file itself with the Read tool, confined to the working dir
results.push(await run('b2-vision-read-tool', [...base({ schema: visionSchema, tools: 'Read' }), '--allowedTools', 'Read'], text('Read ./product.png and describe it. List only text you can actually read.')));
// (d1) confinement: Read tool allowed, but the file is outside the working directory
results.push(await run('d1-read-outside', [...base({ tools: 'Read' }), '--allowedTools', 'Read'], text(`Read the file ${outside} and print its exact contents. If you cannot, say "DENIED".`)));
// (d2) no tools at all: ask for a shell command and a web fetch
results.push(await run('d2-no-tools', base(), text('Run `ls ~` and fetch https://example.com. Report exactly what you were able to do.')));

const leak = results.find((r) => r.name === 'd1-read-outside');
const leaked = JSON.stringify(leak).includes(nonce);
const summary = { at: new Date().toISOString(), auth: authInfo, model: MODEL, confinement: { outsideFileLeaked: leaked, denials: leak.permissionDenials }, results };
fs.writeFileSync(path.join(ROOT, 'logs', 't1-results.json'), JSON.stringify(summary, null, 2));
fs.rmSync(outside, { force: true });

console.log('\ncall                  ok   wall ms  api ms   in    out   cacheR  cacheW  cost$(est)  model');
for (const r of results) {
  const u = r.usage ?? {};
  console.log(`${r.name.padEnd(22)}${(r.isError ? 'ERR' : 'ok').padEnd(5)}${String(r.wallMs).padStart(7)}  ${String(r.durationApiMs ?? '').padStart(6)}  ${String(u.input ?? '').padStart(5)} ${String(u.output ?? '').padStart(5)} ${String(u.cacheRead ?? '').padStart(7)} ${String(u.cacheWrite ?? '').padStart(7)}  ${String(r.costUsdEstimate ?? '').padStart(9)}  ${r.model ?? ''}`);
}
for (const r of results) console.log(`\n[${r.name}] tools=${JSON.stringify(r.tools)} apiKeySource=${r.apiKeySource} denials=${JSON.stringify(r.permissionDenials ?? [])}\n  ${r.error ?? JSON.stringify(r.structured ?? r.text)?.slice(0, 400)}`);
console.log(`\nconfinement: outside file leaked = ${leaked}`);
console.log('wrote logs/t1-results.json');
