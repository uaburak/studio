/**
 * Locks a headless `gemini` CLI chat turn down to Studio's own tools (PLAN.md §10: the chat agent
 * has no shell, no web and no file writes; only Studio's MCP tools).
 *
 * Checked against Gemini CLI 0.63 (its bundled docs `reference/configuration.md`,
 * `reference/policy-engine.md`, `cli/enterprise.md` and the settings loader):
 *
 * - `tools.core: []` registers none of the built-in tools (shell, file read/write/edit, web
 *   fetch/search, memory, skills, sub-agents); MCP tools are registered separately.
 *   `tools.exclude` repeats the dangerous ones for CLI versions that read `core` differently.
 * - An admin-tier policy (`adminPolicyPaths`) denies every tool except the `studio` MCP server's,
 *   so the turn runs in the CLI's `default` approval mode (no `--yolo`): Studio's tools are
 *   allowed by the policy (and `trust: true` on the server), anything else is refused.
 * - `mcp.allowed` / `--allowed-mcp-server-names` keep only the `studio` server.
 * - The CLI runs with its own `HOME` / `GEMINI_CLI_HOME` inside the turn's folder, so the owner's
 *   `~/.gemini` settings, extensions, MCP servers, hooks, skills, policies and `GEMINI.md` never
 *   load. Only the sign-in is carried over: `oauth_creds.json` and `google_accounts.json` are
 *   copied (0600) and the selected auth type is taken from the owner's settings; the copies are
 *   deleted with the turn folder. The restrictive settings file is also the CLI's *system*
 *   settings file (`GEMINI_CLI_SYSTEM_SETTINGS_PATH`), which takes precedence over every other
 *   settings layer, and the throwaway folder is trusted (`GEMINI_CLI_TRUST_WORKSPACE`).
 */
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** The MCP server name Studio registers (no `_`: the CLI splits `mcp_<server>_<tool>` on it). */
export const GEMINI_STUDIO_SERVER = "studio";

/** Built-in Gemini CLI tools a Studio turn never gets (`tools.exclude`, belt and braces). */
export const GEMINI_EXCLUDED_BUILTIN_TOOLS = [
  "run_shell_command",
  "write_file",
  "replace",
  "read_file",
  "read_many_files",
  "list_directory",
  "glob",
  "grep_search",
  "search_file_content",
  "web_fetch",
  "google_web_search",
  "save_memory",
  "write_todos",
  "activate_skill",
  "get_internal_docs",
  "list_mcp_resources",
  "read_mcp_resource",
  "list_background_processes",
  "read_background_output",
  "enter_plan_mode",
  "exit_plan_mode",
  "codebase_investigator",
  "cli_help",
  "invoke_agent",
] as const;

/** Files of the owner's `~/.gemini` that carry the sign-in (nothing else is copied). */
export const GEMINI_AUTH_FILES = ["oauth_creds.json", "google_accounts.json"] as const;

export interface GeminiMcpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** The admin-tier policy: Studio's MCP tools are allowed, every other tool is denied. */
export function buildGeminiPolicyToml(server = GEMINI_STUDIO_SERVER): string {
  return `# Studio: the chat agent may only use Studio's own tools (no shell, web or file access).
[[rule]]
mcpName = "${server}"
decision = "allow"
priority = 900

[[rule]]
toolName = "*"
decision = "deny"
priority = 100
denyMessage = "Studio sohbetinde yalnızca Studio araçları kullanılabilir."
`;
}

/** `.gemini/settings.json` of a Studio turn (also the CLI's system settings file). */
export function buildGeminiCliSettings(input: {
  server: GeminiMcpServerSpec;
  policyPath: string;
}): Record<string, unknown> {
  return {
    mcpServers: {
      [GEMINI_STUDIO_SERVER]: {
        command: input.server.command,
        args: input.server.args,
        env: input.server.env,
        trust: true,
      },
    },
    mcp: { allowed: [GEMINI_STUDIO_SERVER] },
    tools: {
      core: [],
      exclude: [...GEMINI_EXCLUDED_BUILTIN_TOOLS],
      allowed: [],
    },
    adminPolicyPaths: [input.policyPath],
    security: {
      disableYoloMode: true,
      disableAlwaysAllow: true,
      folderTrust: { enabled: false },
    },
    skills: { enabled: false },
    hooksConfig: { enabled: false },
    experimental: { enableAgents: false },
    useWriteTodos: false,
    context: { includeDirectoryTree: false, includeDirectories: [] },
  };
}

/** Headless CLI flags of a Studio turn (no `--yolo`). */
export function geminiCliArgs(modelId: string, format: "stream-json" | "text"): string[] {
  const args = [
    "--model",
    modelId,
    "--approval-mode",
    "default",
    "--allowed-mcp-server-names",
    GEMINI_STUDIO_SERVER,
  ];
  if (format === "stream-json") args.push("--output-format", "stream-json");
  args.push("-p", "Yukarıdaki Studio bağlamına ve son kullanıcı mesajına Türkçe yanıt ver.");
  return args;
}

/** Where the owner's Gemini CLI keeps its files (`$GEMINI_CLI_HOME/.gemini` or `~/.gemini`). */
export function ownerGeminiDir(parent: NodeJS.ProcessEnv): string | null {
  const home = parent.GEMINI_CLI_HOME || parent.HOME;
  return home ? path.join(home, ".gemini") : null;
}

/** The auth type the owner picked in the CLI (`security.auth.selectedType`), if any. */
export async function readOwnerAuthType(geminiDir: string | null): Promise<string | null> {
  if (!geminiDir) return null;
  try {
    const raw = JSON.parse(await readFile(path.join(geminiDir, "settings.json"), "utf8")) as {
      security?: { auth?: { selectedType?: unknown } };
      selectedAuthType?: unknown;
    };
    const picked = raw.security?.auth?.selectedType ?? raw.selectedAuthType;
    return typeof picked === "string" && picked.trim() ? picked.trim() : null;
  } catch {
    return null;
  }
}

export interface GeminiCliHome {
  /** `HOME` and `GEMINI_CLI_HOME` of the CLI process. */
  home: string;
  /** Environment overrides for the CLI process. */
  env: Record<string, string>;
}

/**
 * Prepare the CLI's own home inside the turn folder: the sign-in copied from the owner's
 * `~/.gemini`, nothing else. Returns the env overrides (`HOME`, `GEMINI_CLI_HOME`, the system
 * settings path, workspace trust).
 */
export async function prepareGeminiCliHome(input: {
  workDir: string;
  settingsPath: string;
  parentEnv: NodeJS.ProcessEnv;
  apiKey?: string | undefined;
}): Promise<GeminiCliHome> {
  const home = path.join(input.workDir, "gemini-home");
  const dir = path.join(home, ".gemini");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const owner = ownerGeminiDir(input.parentEnv);
  if (owner) {
    for (const file of GEMINI_AUTH_FILES) {
      const target = path.join(dir, file);
      try {
        await copyFile(path.join(owner, file), target);
        await chmod(target, 0o600);
      } catch {
        // Not signed in with Google (API key) or a different layout: nothing to carry over.
      }
    }
  }
  const authType = (await readOwnerAuthType(owner)) ?? (input.apiKey ? "gemini-api-key" : null);
  await writeFile(
    path.join(dir, "settings.json"),
    JSON.stringify(authType ? { security: { auth: { selectedType: authType } } } : {}, null, 2),
    { mode: 0o600 },
  );
  return {
    home,
    env: {
      HOME: home,
      GEMINI_CLI_HOME: home,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: input.settingsPath,
      GEMINI_CLI_TRUST_WORKSPACE: "true",
    },
  };
}
