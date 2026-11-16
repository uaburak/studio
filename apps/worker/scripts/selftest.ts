/**
 * Check that the worker can use headless Claude on this Mac:
 * `claude --version`, `claude auth status` and (unless STUDIO_CLAUDE_SELFTEST=never) one tiny call.
 *   pnpm --filter @studio/worker selftest
 * Exits 0 when Claude is usable (ok or only usage-limited), 1 otherwise.
 */
import path from "node:path";
import { loadAgentSettings } from "../src/agent.ts";
import { claudeSelfTest } from "../src/claude/health.ts";
import { createClaudeRunner } from "../src/claude/runner.ts";
import { loadConfig } from "../src/config.ts";

const config = loadConfig();
const settings = loadAgentSettings();
const env = {
  configDir: settings.claudeConfigDir,
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
};
const health = await claudeSelfTest({
  bin: settings.claudeBin,
  env,
  runner: createClaudeRunner({
    bin: settings.claudeBin,
    env,
    workRoot: path.join(config.stateDir, "claude-work"),
    defaultModel: settings.model,
  }),
  model: settings.model,
  callMode: settings.selfTest === "auto" ? "always" : settings.selfTest,
  stateDir: config.stateDir,
});
console.log(JSON.stringify(health, null, 2));
process.exit(health.state === "ok" || health.state === "limited" ? 0 : 1);
