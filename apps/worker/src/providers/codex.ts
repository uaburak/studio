/**
 * Codex CLI (OpenAI's `codex`): readiness (`codex --version`, `codex login status`) and a
 * headless chat-turn driver (`codex exec --json`), the Codex counterpart of the Claude driver.
 *
 * - Sign-in is the CLI's own (`codex login`: ChatGPT account in the browser). The environment
 *   is allow-listed, so an `OPENAI_API_KEY` in the worker's environment never turns a ChatGPT
 *   plan into API billing.
 * - Studio's tools reach Codex through the per-turn MCP bridge (stdio script), configured with
 *   `-c mcp_servers.studio.*` overrides; `--ignore-user-config` keeps the owner's own Codex
 *   config (other MCP servers, profiles) out of Studio turns. The agent gets Studio's tools only
 *   (PLAN.md §10): the shell tool, image viewing (local files), web search, apps/connectors,
 *   plugins, browser and computer use are switched off (`CODEX_TOOL_LOCKDOWN`), and the sandbox
 *   stays read-only, so the file-edit tool that remains cannot write. Tool calls never ask
 *   (`approval_policy="never"`): Studio's own consent cards guard the actions that need the owner.
 * - `--json` prints JSONL events: `thread.started`, `turn.started`, `item.started|updated|
 *   completed` (`agent_message`, `reasoning`, `mcp_tool_call`, `command_execution`, `error`),
 *   `turn.completed` (with `usage`), `turn.failed`, `error`.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { RunUsage } from "@studio/contract";
import type { McpBridge } from "../chat/mcp-bridge.ts";
import type { Effort } from "../claude/models.ts";
import { LineSplitter } from "../claude/stream.ts";
import {
  buildCliEnv,
  type CmdRunner,
  classifyFailure,
  execCmd,
  firstVersion,
  ProviderError,
} from "./cli.ts";

export interface CodexProbe {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** How the CLI is signed in. */
  method: "chatgpt" | "api_key" | null;
  error: string | null;
}

/** `codex --version` + `codex login status` (never forwards the raw output: it may name a key). */
export async function probeCodex(
  bin: string,
  parentEnv: NodeJS.ProcessEnv,
  run: CmdRunner = execCmd,
): Promise<CodexProbe> {
  const env = buildCliEnv(parentEnv);
  const ver = await run(bin, ["--version"], { env, timeoutMs: 10_000 });
  const version = firstVersion(ver.stdout + ver.stderr);
  if (ver.notFound || (!version && ver.code !== 0)) {
    return { installed: false, version: null, loggedIn: false, method: null, error: null };
  }
  const status = await run(bin, ["login", "status"], { env, timeoutMs: 15_000 });
  const text = `${status.stdout}\n${status.stderr}`;
  if (/not logged in/i.test(text)) {
    return { installed: true, version, loggedIn: false, method: null, error: null };
  }
  if (/logged in/i.test(text)) {
    return {
      installed: true,
      version,
      loggedIn: true,
      method: /api key/i.test(text) ? "api_key" : "chatgpt",
      error: null,
    };
  }
  return {
    installed: true,
    version,
    loggedIn: false,
    method: null,
    error: status.timedOut
      ? "`codex login status` yanıt vermedi."
      : `\`codex login status\` okunamadı (çıkış kodu ${status.code}).`,
  };
}

/** Studio effort -> `model_reasoning_effort` (xhigh/max map to high, which every model takes). */
export function codexEffort(effort: Effort | undefined): "low" | "medium" | "high" {
  switch (effort) {
    case "low":
      return "low";
    case "high":
    case "xhigh":
    case "max":
      return "high";
    default:
      return "medium";
  }
}

/** A TOML string literal for `-c key=value` (TOML basic strings share JSON's escapes). */
function toml(value: string): string {
  return JSON.stringify(value);
}

export interface CodexTurnOptions {
  bin: string;
  parentEnv: NodeJS.ProcessEnv;
  /** `-m`; undefined = the CLI's default model. */
  model?: string | undefined;
  effort?: Effort | undefined;
  system: string;
  prompt: string;
  /** Working directory (the turn's bridge folder). */
  cwd: string;
  /** Studio's tools; without it the turn answers with text only. */
  bridge?: McpBridge | undefined;
  /** Image files attached to the prompt (`-i`). */
  images?: string[];
  onTextDelta?: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawn?: typeof nodeSpawn;
}

export interface CodexTurnResult {
  model: string;
  usage: RunUsage;
  threadId: string | null;
}

/**
 * `-c` overrides that leave the agent with Studio's MCP tools only. Checked against
 * codex-cli 0.169 (`codex features list`, `codex debug prompt-input`): `features.shell_tool=false`
 * removes `exec_command` / `write_stdin`, `features.view_image=false` removes local image
 * reading. `-c` (unlike `--disable`) accepts keys an older or newer CLI does not know, so the
 * older spellings (`tools.web_search`, `tools.view_image`) ride along.
 */
export const CODEX_TOOL_LOCKDOWN = [
  "features.shell_tool=false",
  "features.unified_exec=false",
  "features.view_image=false",
  `web_search=${toml("disabled")}`,
  "tools.web_search=false",
  "tools.view_image=false",
  "features.apps=false",
  "features.plugins=false",
  "features.image_generation=false",
  "features.browser_use=false",
  "features.browser_use_external=false",
  "features.in_app_browser=false",
  "features.computer_use=false",
  "features.hooks=false",
  "features.memories=false",
  "features.tool_suggest=false",
  "features.skill_mcp_dependency_install=false",
  `shell_environment_policy.inherit=${toml("none")}`,
] as const;

export function codexExecArgs(options: CodexTurnOptions): string[] {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "-s",
    "read-only",
    "-C",
    options.cwd,
    "-c",
    `approval_policy=${toml("never")}`,
    "-c",
    `model_reasoning_effort=${toml(codexEffort(options.effort))}`,
    ...CODEX_TOOL_LOCKDOWN.flatMap((override) => ["-c", override]),
  ];
  if (options.model) args.push("-m", options.model);
  if (options.bridge) {
    args.push(
      "-c",
      `mcp_servers.studio.command=${toml(process.execPath)}`,
      "-c",
      `mcp_servers.studio.args=[${toml(options.bridge.scriptPath)}]`,
      "-c",
      "mcp_servers.studio.tool_timeout_sec=1800",
      "-c",
      "mcp_servers.studio.startup_timeout_sec=30",
    );
  }
  for (const image of options.images ?? []) args.push("-i", image);
  // The prompt comes on stdin.
  args.push("-");
  return args;
}

const KILL_GRACE_MS = 3_000;

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
}

export function runCodexTurn(options: CodexTurnOptions): Promise<CodexTurnResult> {
  options.signal?.throwIfAborted();
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const started = Date.now();
  const env = buildCliEnv(options.parentEnv);
  const args = codexExecArgs(options);

  return new Promise<CodexTurnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.bin, args, { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new ProviderError("codex", "spawn", (error as Error).message));
      return;
    }

    const splitter = new LineSplitter();
    let stderr = "";
    let threadId: string | null = null;
    let failure: string | null = null;
    let lastError: string | null = null;
    let completed = false;
    let inputTokens = 0;
    let cachedTokens = 0;
    let outputTokens = 0;
    let reasoningTokens = 0;
    let wroteAny = false;
    const emittedPerItem = new Map<string, number>();
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const kill = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      kill();
      finish(() =>
        reject(new ProviderError("codex", "timeout", `codex timed out after ${timeoutMs} ms`)),
      );
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      kill();
      finish(() => reject(options.signal?.reason ?? new Error("aborted")));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const emitMessage = (item: CodexItem) => {
      if (item.type !== "agent_message" || typeof item.text !== "string") return;
      const key = item.id ?? "message";
      const already = emittedPerItem.get(key) ?? 0;
      if (already === 0 && item.text.length > 0 && wroteAny) options.onTextDelta?.("\n\n");
      const rest = item.text.slice(already);
      if (rest) {
        options.onTextDelta?.(rest);
        wroteAny = true;
      }
      emittedPerItem.set(key, Math.max(already, item.text.length));
    };

    const handleLine = (line: string) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (ev.type) {
        case "thread.started":
          if (typeof ev.thread_id === "string") threadId = ev.thread_id;
          return;
        case "item.updated":
        case "item.completed": {
          const item = (ev.item ?? {}) as CodexItem;
          if (item.type === "error" && typeof item.message === "string") lastError = item.message;
          else emitMessage(item);
          return;
        }
        case "turn.completed": {
          completed = true;
          const u = (ev.usage ?? {}) as Record<string, unknown>;
          const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          inputTokens += num(u.input_tokens);
          cachedTokens += num(u.cached_input_tokens);
          outputTokens += num(u.output_tokens);
          reasoningTokens += num(u.reasoning_output_tokens);
          return;
        }
        case "turn.failed": {
          const err = ev.error as { message?: unknown } | undefined;
          failure = typeof err?.message === "string" ? err.message : "Codex turn failed";
          return;
        }
        case "error":
          // "Reconnecting... n/5" notices come before the final turn.failed.
          if (typeof ev.message === "string") lastError = ev.message;
          return;
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      for (const line of splitter.push(chunk)) handleLine(line);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.on("error", (error) => {
      finish(() => reject(new ProviderError("codex", "spawn", error.message)));
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      for (const line of splitter.end()) handleLine(line);
      if (settled) return;
      if (failure || (!completed && code !== 0) || (!completed && !wroteAny)) {
        const msg = (failure ?? lastError ?? (stderr.trim() || `codex exit ${code}`)).slice(0, 400);
        finish(() => reject(new ProviderError("codex", classifyFailure(msg), msg)));
        return;
      }
      const model = options.model ?? "codex";
      const usage: RunUsage = {
        model,
        requestedModel: "codex",
        ...(options.effort ? { effort: options.effort } : {}),
        inputTokens,
        outputTokens,
        cacheReadTokens: cachedTokens,
        durationMs: Math.max(0, Date.now() - started),
        calls: 1,
        runner: "codex-cli",
        ...(reasoningTokens > 0 ? { thoughtsTokens: reasoningTokens } : {}),
      };
      finish(() => resolve({ model, usage, threadId }));
    });

    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`${options.system}\n\n${options.prompt}\n`);
  });
}
