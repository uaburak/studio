// T1 via the Claude Agent SDK (TypeScript/JS) instead of spawning `claude -p` ourselves.
// Same locked-down configuration as scripts/lib/claude.mjs. Sends the product photo as an image
// block and asks for structured JSON.
// Usage: node scripts/t1-sdk.mjs            (from a plain terminal, after `claude auth login`)
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { cleanEnv } from './lib/claude.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cwd = path.join(ROOT, 'work', 't1-sdk');
fs.mkdirSync(cwd, { recursive: true });
const img = fs.readFileSync(path.join(ROOT, 'brand/venta/assets/product-venta-borinc.png')).toString('base64');
const schema = {
  type: 'object',
  properties: {
    product_name: { type: 'string' },
    package_type: { type: 'string' },
    dominant_colours_hex: { type: 'array', items: { type: 'string' } },
    readable_text: { type: 'array', items: { type: 'string' } },
  },
  required: ['product_name', 'package_type', 'dominant_colours_hex', 'readable_text'],
};

async function* prompt() {
  yield {
    type: 'user', parent_tool_use_id: null, session_id: '',
    message: { role: 'user', content: [
      { type: 'text', text: 'Describe this product photo. List only text you can actually read.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: img } },
    ] },
  };
}

const t0 = Date.now();
const log = [];
for await (const m of query({
  prompt: prompt(),
  options: {
    cwd,
    env: cleanEnv(),                 // REPLACES the child env: no ANTHROPIC_*, no parent-session vars
    systemPrompt: 'You are a precise product-photo describer.',
    tools: [],                       // no built-in tools
    settingSources: [],              // ignore ~/.claude settings (hooks, plugins, permissions)
    strictMcpConfig: true, mcpServers: {},
    permissionMode: 'dontAsk',
    permissionPrompts: 'none',
    persistSession: false,
    model: process.env.STUDIO_MODEL ?? 'opus',
    outputFormat: { type: 'json_schema', schema },
  },
})) {
  log.push(m);
  if (m.type === 'system' && m.subtype === 'init') console.log('init:', JSON.stringify({ model: m.model, tools: m.tools, mcp_servers: m.mcp_servers, permissionMode: m.permissionMode, apiKeySource: m.apiKeySource, claude_code_version: m.claude_code_version }));
  if (m.type === 'result') {
    console.log('result:', JSON.stringify({ is_error: m.is_error, wallMs: Date.now() - t0, duration_ms: m.duration_ms, usage: m.usage, total_cost_usd: m.total_cost_usd, structured_output: m.structured_output, error: m.is_error ? m.result : undefined }, null, 1));
  }
}
fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'logs', 't1-sdk.messages.json'), JSON.stringify(log, null, 1));
