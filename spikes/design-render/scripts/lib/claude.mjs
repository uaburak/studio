// Headless Claude transports.
//
// cli      — spawns `claude -p` (the production path; needs the CLI to be logged in with the
//            subscription, see README "Headless recipe").
// handoff  — writes the exact request to disk and waits for a response directory. Used in the
//            spike because nested `claude -p` could not authenticate from inside the desktop-app
//            session; the response was produced by a fresh-context Claude subagent reading the
//            same request. The pipeline code around the call is identical.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Environment for the child: an allow-list. No ANTHROPIC_* (API key, auth token, base URL),
 *  no CLAUDECODE / CLAUDE_CODE_* from a parent session. CLAUDE_CODE_OAUTH_TOKEN (from
 *  `claude setup-token`) and CLAUDE_CONFIG_DIR are passed through when the operator sets them. */
export function cleanEnv(extra = {}) {
  const keep = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
  const env = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']) if (process.env[k]) env[k] = process.env[k];
  return { ...env, ...extra };
}

/** Locked-down flag set for unattended generation. */
export function lockedDownArgs({ model, effort, schema, systemPromptFile, tools = '' }) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json', '--verbose',
    '--system-prompt-file', systemPromptFile,   // replaces the Claude Code coding-agent prompt
    '--tools', tools,                            // '' = no built-in tools at all
    '--setting-sources', '',                     // ignore ~/.claude settings: no user hooks, plugins, permissions
    '--strict-mcp-config',                       // no MCP servers
    '--disable-slash-commands',                  // no skills
    '--no-session-persistence',
    '--permission-mode', 'dontAsk',              // anything not pre-approved is denied
    '--permission-prompts', 'none',
  ];
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  return args;
}

/**
 * One headless call via the CLI. Images are sent as base64 content blocks (stream-json input),
 * so the model needs no file tools to see them.
 */
export function callCli({ claudeBin = 'claude', cwd, system, userText, images = [], schema, model, effort, logBase, timeoutMs = 15 * 60 * 1000 }) {
  fs.mkdirSync(cwd, { recursive: true });
  const systemPromptFile = path.join(cwd, 'system-prompt.md');
  fs.writeFileSync(systemPromptFile, system);
  const args = lockedDownArgs({ model, effort, schema, systemPromptFile });
  const content = [{ type: 'text', text: userText }];
  for (const img of images) {
    const ext = path.extname(img).toLowerCase();
    content.push({ type: 'image', source: { type: 'base64', media_type: ext === '.png' ? 'image/png' : 'image/jpeg', data: fs.readFileSync(img).toString('base64') } });
  }
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin, args, { cwd, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGINT'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (logBase) { fs.writeFileSync(`${logBase}.stream.jsonl`, out); if (err) fs.writeFileSync(`${logBase}.stderr.txt`, err); }
      const lines = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const result = lines.findLast((l) => l.type === 'result');
      const init = lines.find((l) => l.type === 'system' && l.subtype === 'init');
      if (!result) return reject(new Error(`claude exited ${code} without a result. stderr: ${err.slice(0, 500)}`));
      resolve({
        ok: !result.is_error && !!result.structured_output,
        exitCode: code,
        wallMs: Date.now() - t0,
        output: result.structured_output ?? null,
        text: result.result,
        usage: result.usage, modelUsage: result.modelUsage, costUsdEstimate: result.total_cost_usd,
        durationMs: result.duration_ms, durationApiMs: result.duration_api_ms, numTurns: result.num_turns,
        permissionDenials: result.permission_denials,
        model: init?.model, tools: init?.tools, mcpServers: init?.mcp_servers,
        error: result.is_error ? result.result : null,
      });
    });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    child.stdin.end();
  });
}

/**
 * Handoff transport: write the request; if a response exists, read it.
 * Response layout: <dir>/<step>.response/{slide-1.html, ..., meta.json}
 * meta.json: { caption, rationale, critique, changes } ; optional <step>.usage.json with timing/tokens.
 */
export function callHandoff({ dir, step, system, userText, images = [], schema, slideIds }) {
  fs.mkdirSync(dir, { recursive: true });
  const reqPath = path.join(dir, `${step}.request.md`);
  const respDir = path.join(dir, `${step}.response`);
  const request = `# Headless request: ${step}

This file is the exact input a headless \`claude -p\` call receives. SYSTEM is the system prompt,
USER is the user message${images.length ? ' (with the images listed below attached)' : ''}.

## Response format (handoff)
Write one file per slide to \`${respDir}/\` named ${slideIds.map((s) => `\`${s}.html\``).join(', ')},
and \`${respDir}/meta.json\` = { "caption": string, "rationale": string, "critique": [ {"issue","severity","fix"} ], "changes": [string] }.
This mirrors the JSON schema used by the CLI transport:
\`\`\`json
${JSON.stringify(schema)}
\`\`\`
${images.length ? `\n## Attached images\n${images.map((i) => `- ${path.resolve(i)}`).join('\n')}\n` : ''}
## SYSTEM
${system}

## USER
${userText}
`;
  // keep the request that was actually answered: never overwrite it once a response exists
  if (!fs.existsSync(path.join(respDir, 'meta.json'))) fs.writeFileSync(reqPath, request);
  if (!fs.existsSync(path.join(respDir, 'meta.json'))) return { pending: true, requestPath: reqPath, responseDir: respDir };
  const meta = JSON.parse(fs.readFileSync(path.join(respDir, 'meta.json'), 'utf8'));
  const slides = slideIds.map((id) => {
    const f = path.join(respDir, `${id}.html`);
    if (!fs.existsSync(f)) throw new Error(`handoff response is missing ${f}`);
    return { id, html: fs.readFileSync(f, 'utf8') };
  });
  const usagePath = path.join(dir, `${step}.usage.json`);
  const usage = fs.existsSync(usagePath) ? JSON.parse(fs.readFileSync(usagePath, 'utf8')) : null;
  return { pending: false, ok: true, output: { slides, ...meta }, usage, requestPath: reqPath };
}
