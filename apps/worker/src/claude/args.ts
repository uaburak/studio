/**
 * The verified headless recipe (A3, measured on this Mac):
 * subscription login, no built-in tools, no user settings/plugins/skills, stream-json in and out,
 * plus optional per-turn Studio MCP bridge and session persistence for Wecra-style chat (A5).
 */

import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** Variables the child may inherit. Everything else (ANTHROPIC_*, CLAUDE_CODE_* of a parent session, secrets) is dropped. */
const ENV_ALLOW = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG"] as const;
/**
 * Never forwarded, even when listed in `extra`: they switch the CLI away from the
 * subscription (ANTHROPIC_API_KEY / AUTH_TOKEN / BASE_URL), make it a nested session of
 * a parent Claude Code (CLAUDECODE, CLAUDE_CODE_*), or inject code (NODE_OPTIONS).
 */
const ENV_DENY =
  /^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_(?!OAUTH_TOKEN$)|CLAUDE_AGENT_SDK_|NODE_OPTIONS$)/;

/**
 * Folders searched for `claude` besides PATH: a worker started by the Mac app (launchd)
 * gets a short PATH, so the usual install folders are added (Wecra's `searchPath`).
 */
export function searchPath(home = homedir(), path = process.env.PATH ?? ""): string[] {
  const extra = [
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".npm-global", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".volta", "bin"),
    "/usr/bin",
    "/bin",
  ];
  return [...new Set([...path.split(delimiter).filter(Boolean), ...extra])];
}

export interface ClaudeEnvOptions {
  /** Separate login for the worker (`CLAUDE_CONFIG_DIR=<dir> claude auth login`). */
  configDir?: string | undefined;
  /** Long-lived token from `claude setup-token`. */
  oauthToken?: string | undefined;
  /** Extra variables for this call (e.g. MCP_TOOL_TIMEOUT); the deny list still applies. */
  extra?: Record<string, string> | undefined;
}

/** Environment for the `claude` child process: an allow-list, never the parent's environment. */
export function buildClaudeEnv(
  parent: NodeJS.ProcessEnv,
  options: ClaudeEnvOptions = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOW) {
    const value = parent[key];
    if (value) env[key] = value;
  }
  env.LANG ??= "en_US.UTF-8";
  env.PATH = searchPath(env.HOME ?? homedir(), env.PATH ?? "").join(delimiter);
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;
  if (options.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
  for (const [key, value] of Object.entries(options.extra ?? {})) env[key] = value;
  for (const key of Object.keys(env)) {
    if (ENV_DENY.test(key)) delete env[key];
  }
  return env;
}

export interface ClaudeArgsOptions {
  systemPromptFile: string;
  /** JSON schema for structured output (`--json-schema`). */
  schema?: object | undefined;
  model?: string | undefined;
  effort?: string | undefined;
  /** `--include-partial-messages`: token-level deltas (needed for streaming text into the chat). */
  partialMessages?: boolean;
  /** Keep the session on disk so the next turn can `--resume` it (default false). */
  persistSession?: boolean;
  /** Continue an earlier Claude Code session (`--resume <id>`). */
  resumeSessionId?: string | undefined;
  /** Path to MCP config JSON file (`--mcp-config <path>`). */
  mcpConfigFile?: string | undefined;
  /** MCP tools allowed without interactive prompts (`--allowedTools a,b`). */
  allowedTools?: readonly string[] | undefined;
}

/** Locked-down flags for unattended calls. Never `--bare` (it ignores the subscription login). */
export function buildClaudeArgs(options: ClaudeArgsOptions): string[] {
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--system-prompt-file",
    options.systemPromptFile,
    // No built-in tools at all: the A3 probe showed Read could leave the working directory.
    "--tools",
    "",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ];
  if (!options.persistSession && !options.resumeSessionId) {
    args.push("--no-session-persistence");
  }
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  }
  args.push("--permission-mode", "dontAsk", "--permission-prompts", "none");
  if (options.mcpConfigFile) {
    args.push("--mcp-config", options.mcpConfigFile);
  }
  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  if (options.partialMessages) args.push("--include-partial-messages");
  if (options.schema) args.push("--json-schema", JSON.stringify(options.schema));
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  return args;
}

export interface AgentArgsOptions {
  /** Path of the run's MCP config (`--mcp-config`). */
  mcpConfigFile: string;
  /** Appended to Claude Code's own system prompt (`--append-system-prompt`). */
  appendSystemPrompt: string;
  /** MCP server whose tools are allowed without asking (`mcp__<server>`). */
  mcpServer?: string;
  model?: string | undefined;
  effort?: string | undefined;
  /** Continue this session (`--resume`)… */
  resumeSessionId?: string | undefined;
  /** …or start a new one with this id (`--session-id`). */
  sessionId?: string | undefined;
}

/**
 * The chat agent's flags (A5, after Wecra's claudeCode.ts `plan`): no built-in tools, only
 * Studio's MCP server (strict config, allowed without asking), the studio guide appended to
 * the system prompt, partial messages for streaming, the session kept for `--resume`.
 * Images of the user's message go inline (stream-json input).
 */
export function buildAgentArgs(options: AgentArgsOptions): string[] {
  const server = options.mcpServer ?? "studio";
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--mcp-config",
    options.mcpConfigFile,
    "--strict-mcp-config",
    "--tools",
    "",
    "--allowedTools",
    `mcp__${server}`,
    "--permission-mode",
    "dontAsk",
    "--append-system-prompt",
    options.appendSystemPrompt,
    // No user settings, hooks or plugins; no slash commands from the prompt.
    "--setting-sources",
    "",
    "--disable-slash-commands",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  else if (options.sessionId) args.push("--session-id", options.sessionId);
  return args;
}
