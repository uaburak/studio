/**
 * Antigravity CLI (Google, `agy`): readiness and a headless chat-turn driver (print mode).
 *
 * Verified on this Mac (agy 1.5.10): `agy --version`, `agy models` (lists models only when signed
 * in; free), print mode `agy -p <prompt> --output-format stream-json` (documented at
 * https://antigravity.google/docs/cli/headless): NDJSON events `init`, `step_update`
 * (`step_type` `agent_response` carries `text_delta`), and one `result` (`status` SUCCESS /
 * ERROR / ..., `response`, `usage`). Headless runs use the CLI's cached Google sign-in; without
 * it the CLI exits with "authentication required".
 *
 * Studio's tools are NOT available to Antigravity: print mode reads MCP servers only from the
 * owner's global `~/.gemini/config/mcp_config.json` (no per-run config), and Studio does not
 * edit that file. Turns run text-only in an empty folder with the terminal sandbox on; tool
 * requests that need approval are soft-denied by the CLI (no `--dangerously-skip-permissions`).
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import type { RunUsage } from "@studio/contract";
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

export interface AntigravityProbe {
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  /** `slug` of each listed model (at most 100). */
  models: string[];
  error: string | null;
}

/** `agy --version` + `agy models` (signed in when it lists models). */
export async function probeAntigravity(
  bin: string,
  parentEnv: NodeJS.ProcessEnv,
  run: CmdRunner = execCmd,
): Promise<AntigravityProbe> {
  const env = buildCliEnv(parentEnv);
  const ver = await run(bin, ["--version"], { env, timeoutMs: 10_000 });
  const version = firstVersion(ver.stdout + ver.stderr);
  if (ver.notFound || (!version && ver.code !== 0)) {
    return { installed: false, version: null, loggedIn: false, models: [], error: null };
  }
  const list = await run(bin, ["models"], { env, timeoutMs: 30_000 });
  const models = list.stdout
    .split("\n")
    .map((line) => line.split("\t")[0]?.trim() ?? "")
    .filter((slug) => /^[a-z0-9][a-z0-9._-]*$/i.test(slug) && slug.length <= 128)
    .slice(0, 100);
  if (list.code === 0 && models.length > 0) {
    return { installed: true, version, loggedIn: true, models, error: null };
  }
  const text = `${list.stdout}\n${list.stderr}`;
  if (/auth|log ?in|sign ?in|credential/i.test(text)) {
    return { installed: true, version, loggedIn: false, models: [], error: null };
  }
  return {
    installed: true,
    version,
    loggedIn: false,
    models: [],
    error: list.timedOut
      ? "`agy models` yanıt vermedi."
      : `\`agy models\` okunamadı (çıkış kodu ${list.code}).`,
  };
}

/** Studio effort -> `--effort` (the CLI takes low|medium|high|xhigh|max, model permitting). */
export function antigravityEffort(effort: Effort | undefined): string | undefined {
  if (!effort) return undefined;
  return effort === "max" ? "xhigh" : effort;
}

export interface AntigravityTurnOptions {
  bin: string;
  parentEnv: NodeJS.ProcessEnv;
  /** `--model` slug (see `agy models`); undefined = the CLI's default. */
  model?: string | undefined;
  effort?: Effort | undefined;
  system: string;
  prompt: string;
  /** An empty working folder (the CLI's workspace). */
  cwd: string;
  onTextDelta?: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawn?: typeof nodeSpawn;
}

export interface AntigravityTurnResult {
  model: string;
  usage: RunUsage;
  conversationId: string | null;
}

export function antigravityArgs(options: AntigravityTurnOptions): string[] {
  const timeoutS = Math.max(30, Math.round((options.timeoutMs ?? 15 * 60_000) / 1000));
  const args = [
    "-p",
    `${options.system}\n\n${options.prompt}`,
    "--output-format",
    "stream-json",
    "--sandbox",
    "--disable-slash-commands",
    "--print-timeout",
    `${timeoutS}s`,
  ];
  if (options.model) args.push("--model", options.model);
  const effort = antigravityEffort(options.effort);
  // Only with an explicit model: the default model may not take every level.
  if (effort && options.model) args.push("--effort", effort);
  return args;
}

const KILL_GRACE_MS = 3_000;

export function runAntigravityTurn(
  options: AntigravityTurnOptions,
): Promise<AntigravityTurnResult> {
  options.signal?.throwIfAborted();
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = (options.timeoutMs ?? 15 * 60_000) + 30_000;
  const started = Date.now();
  const env = buildCliEnv(options.parentEnv);

  return new Promise<AntigravityTurnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(options.bin, antigravityArgs(options), {
        cwd: options.cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new ProviderError("antigravity", "spawn", (error as Error).message));
      return;
    }

    const splitter = new LineSplitter();
    let stderr = "";
    let emitted = "";
    let model: string | null = options.model ?? null;
    let conversationId: string | null = null;
    let result: Record<string, unknown> | null = null;
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
        reject(new ProviderError("antigravity", "timeout", `agy timed out after ${timeoutMs} ms`)),
      );
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      kill();
      finish(() => reject(options.signal?.reason ?? new Error("aborted")));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const handleLine = (line: string) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof ev.conversation_id === "string") conversationId = ev.conversation_id;
      if (ev.event === "init") {
        const init = ev.init as { model?: unknown } | undefined;
        if (typeof init?.model === "string") model = init.model;
        return;
      }
      if (ev.event === "step_update") {
        const step = (ev.step_update ?? {}) as Record<string, unknown>;
        if (typeof step.conversation_id === "string") conversationId = step.conversation_id;
        if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
          emitted += step.text_delta;
          options.onTextDelta?.(step.text_delta);
        }
        return;
      }
      if (ev.event === "result") {
        result = (ev.result ?? {}) as Record<string, unknown>;
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
      finish(() => reject(new ProviderError("antigravity", "spawn", error.message)));
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      for (const line of splitter.end()) handleLine(line);
      if (settled) return;
      const res = result as Record<string, unknown> | null;
      const status = typeof res?.status === "string" ? res.status : null;
      if (!res || status !== "SUCCESS") {
        const err = res?.error as { message?: unknown } | string | undefined;
        const msg = (
          (typeof err === "string" ? err : typeof err?.message === "string" ? err.message : null) ??
          (stderr.trim() || (status ? `agy: ${status}` : `agy exit ${code}`))
        ).slice(0, 400);
        finish(() => reject(new ProviderError("antigravity", classifyFailure(msg), msg)));
        return;
      }
      if (!emitted && typeof res.response === "string" && res.response) {
        options.onTextDelta?.(res.response);
      }
      const u = (res.usage ?? {}) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const used = model ?? "antigravity";
      const usage: RunUsage = {
        model: used,
        requestedModel: "antigravity",
        ...(options.effort ? { effort: options.effort } : {}),
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_tokens),
        durationMs: Math.max(0, Date.now() - started),
        calls: 1,
        runner: "antigravity-cli",
        ...(num(u.thinking_tokens) > 0 ? { thoughtsTokens: num(u.thinking_tokens) } : {}),
      };
      finish(() => resolve({ model: used, usage, conversationId }));
    });
  });
}
