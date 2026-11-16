/**
 * The verified headless recipe (A3, measured on this Mac):
 * subscription login, no built-in tools, no user settings/plugins/skills, stream-json in and out,
 * plus optional per-turn Studio MCP bridge and session persistence for Wecra-style chat (A5).
 */

/** Variables the child may inherit. Everything else (ANTHROPIC_*, CLAUDE_CODE_* of a parent session, secrets) is dropped. */
const ENV_ALLOW = ["HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG"] as const;
/** Never forwarded, even when listed in `extra`: they switch the CLI away from the subscription. */
const ENV_DENY = /^(ANTHROPIC_|CLAUDECODE$|CLAUDE_CODE_(?!OAUTH_TOKEN$))/;

export interface ClaudeEnvOptions {
  /** Separate login for the worker (`CLAUDE_CONFIG_DIR=<dir> claude auth login`). */
  configDir?: string | undefined;
  /** Long-lived token from `claude setup-token`. */
  oauthToken?: string | undefined;
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
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir;
  if (options.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = options.oauthToken;
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
