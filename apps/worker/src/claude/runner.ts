/**
 * One headless Claude call on the owner's subscription (the A3 recipe):
 * spawn `claude -p` with an allow-listed environment and locked-down flags,
 * send one stream-json user message (text + base64 images), stream deltas,
 * and read the final `result` line (structured output, session_id, usage, cost estimate).
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildClaudeArgs, buildClaudeEnv, type ClaudeEnvOptions } from "./args.ts";
import { ClaudeError, ClaudeUsageLimitError } from "./errors.ts";
import { classifyFailure, isRejectedStatus, type RateLimitInfo } from "./limits.ts";
import { JsonStringFieldStream, LineSplitter } from "./stream.ts";

export type ClaudeImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export type ClaudeContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: ClaudeImageMediaType; data: Uint8Array };

export interface ClaudeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The CLI's client-side list-price estimate; the subscription is not billed per call. */
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  /** Process start to exit, measured here. */
  wallMs: number;
}

export interface ClaudeCallOptions {
  /** Short name for logs and the stream log file. */
  label: string;
  system: string;
  content: ClaudeContentBlock[];
  /** JSON schema for `--json-schema`; the result then carries `structured_output`. */
  schema?: object;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Stream this top-level string field of the structured output (needs `schema`). */
  streamField?: string;
  /** Newly decoded text of `streamField`. Concatenated, the calls equal the final value. */
  onFieldDelta?: (text: string) => void;
  /** Text deltas of a plain (schema-less) or tool-using answer. */
  onTextDelta?: (text: string) => void;
  /** Keep the session on disk so a later turn can `--resume` it. */
  persistSession?: boolean;
  /** Continue an earlier Claude Code session (`--resume`). */
  resumeSessionId?: string;
  /** Path to MCP config JSON file (`--mcp-config`). */
  mcpConfigFile?: string;
  /** Allowed MCP tools (`--allowedTools`). */
  allowedTools?: readonly string[];
}

export interface ClaudeCallResult {
  /** `structured_output` (schema calls) or null. */
  output: unknown;
  /** `result` text of the final line. */
  text: string;
  model: string | undefined;
  cliVersion: string | undefined;
  /** Claude Code session id (when reported by `init` or `result`). */
  sessionId?: string | undefined;
  usage: ClaudeUsage;
  rateLimit: RateLimitInfo | undefined;
}

export interface ClaudeRunnerOptions {
  /** `claude` executable (default: `claude` from PATH). */
  bin?: string;
  env?: ClaudeEnvOptions;
  /** Parent environment the allow-list is applied to (default: process.env). */
  parentEnv?: NodeJS.ProcessEnv;
  /** Working directory root for the per-call temp dirs (system prompt file). */
  workRoot?: string;
  /** When set, every call's raw stdout is written to `<logDir>/<time>-<label>.stream.jsonl`. */
  logDir?: string;
  defaultModel?: string;
  defaultTimeoutMs?: number;
  /** Assumed reset delay when a usage limit names no reset time. */
  fallbackResetMs?: number;
  now?: () => Date;
  spawn?: typeof nodeSpawn;
}

export type ClaudeRunner = (options: ClaudeCallOptions) => Promise<ClaudeCallResult>;

/** Grace period between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 3000;

export function createClaudeRunner(runnerOptions: ClaudeRunnerOptions = {}): ClaudeRunner {
  return (options) => runClaude(options, runnerOptions);
}

export async function runClaude(
  options: ClaudeCallOptions,
  runnerOptions: ClaudeRunnerOptions = {},
): Promise<ClaudeCallResult> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const now = runnerOptions.now ?? (() => new Date());
  const workRoot = runnerOptions.workRoot ?? tmpdir();
  await mkdir(workRoot, { recursive: true });
  const workDir = await mkdtemp(path.join(workRoot, "claude-"));
  const systemPromptFile = path.join(workDir, "system-prompt.md");
  await writeFile(systemPromptFile, options.system, "utf8");
  const wantsStream = Boolean((options.streamField && options.onFieldDelta) || options.onTextDelta);
  const args = buildClaudeArgs({
    systemPromptFile,
    schema: options.schema,
    model: options.model ?? runnerOptions.defaultModel,
    effort: options.effort,
    partialMessages: wantsStream,
    ...(options.persistSession !== undefined ? { persistSession: options.persistSession } : {}),
    ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
    ...(options.mcpConfigFile ? { mcpConfigFile: options.mcpConfigFile } : {}),
    ...(options.allowedTools ? { allowedTools: options.allowedTools } : {}),
  });
  const env = buildClaudeEnv(runnerOptions.parentEnv ?? process.env, runnerOptions.env);
  let log: WriteStream | undefined;
  if (runnerOptions.logDir) {
    await mkdir(runnerOptions.logDir, { recursive: true });
    const stamp = now().toISOString().replace(/[:.]/g, "-");
    const safe = options.label.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
    log = createWriteStream(path.join(runnerOptions.logDir, `${stamp}-${safe}.stream.jsonl`));
  }
  try {
    return await execute({
      options,
      runnerOptions,
      args,
      env,
      cwd: workDir,
      log,
      now,
    });
  } finally {
    log?.end();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

interface ExecuteInput {
  options: ClaudeCallOptions;
  runnerOptions: ClaudeRunnerOptions;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  log: WriteStream | undefined;
  now: () => Date;
}

function execute(input: ExecuteInput): Promise<ClaudeCallResult> {
  const { options, runnerOptions, args, env, cwd, log, now } = input;
  const spawn = runnerOptions.spawn ?? nodeSpawn;
  const bin = runnerOptions.bin ?? "claude";
  const timeoutMs = options.timeoutMs ?? runnerOptions.defaultTimeoutMs ?? 15 * 60_000;
  const started = Date.now();

  return new Promise<ClaudeCallResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      reject(new ClaudeError("spawn", `could not start ${bin}: ${(error as Error).message}`));
      return;
    }

    const splitter = new LineSplitter();
    const field =
      options.streamField && options.onFieldDelta
        ? new JsonStringFieldStream(options.streamField)
        : undefined;
    let jsonBlockIndex: number | null = null;
    let emittedField = "";
    let sawStreamTextDelta = false;
    let lastTurnEmittedText = "";
    let initModel: string | undefined;
    let cliVersion: string | undefined;
    let initSessionId: string | undefined;
    let rateLimit: RateLimitInfo | undefined;
    let rejectedLimit: RateLimitInfo | undefined;
    let result: Record<string, unknown> | undefined;
    const assistantErrors: string[] = [];
    const assistantErrorTexts: string[] = [];
    let stderr = "";
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
        reject(new ClaudeError("timeout", `${options.label}: no result after ${timeoutMs} ms`)),
      );
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => {
      kill();
      finish(() => reject(options.signal?.reason ?? new Error("aborted")));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const emitField = (text: string) => {
      if (!text) return;
      emittedField += text;
      options.onFieldDelta?.(text);
    };

    const handleLine = (line: string) => {
      log?.write(`${line}\n`);
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return; // not JSON (should not happen with stream-json); ignored
      }
      if (typeof event.session_id === "string" && event.session_id) {
        initSessionId ??= event.session_id;
      }
      switch (event.type) {
        case "system":
          if (event.subtype === "init") {
            initModel = typeof event.model === "string" ? event.model : undefined;
            cliVersion =
              typeof event.claude_code_version === "string" ? event.claude_code_version : undefined;
          }
          return;
        case "stream_event":
          handleStreamEvent(event.event as Record<string, unknown> | undefined);
          return;
        case "assistant": {
          const error = (event as { error?: unknown }).error;
          if (typeof error === "string") {
            assistantErrors.push(error);
            const message = event.message as { content?: unknown } | undefined;
            const texts = Array.isArray(message?.content)
              ? (message.content as { type?: string; text?: string }[])
                  .filter((b) => b.type === "text" && typeof b.text === "string")
                  .map((b) => b.text as string)
              : [];
            assistantErrorTexts.push(texts.join("\n"));
          }
          return;
        }
        case "rate_limit_event": {
          const info = event.rate_limit_info as RateLimitInfo | undefined;
          if (info && typeof info === "object") {
            rateLimit = info;
            if (isRejectedStatus(info.status)) rejectedLimit = info;
          }
          return;
        }
        case "result":
          result = event;
          return;
        default:
          return;
      }
    };

    const handleStreamEvent = (ev: Record<string, unknown> | undefined) => {
      if (!ev) return;
      if (ev.type === "message_start") {
        lastTurnEmittedText = "";
        return;
      }
      if (ev.type === "content_block_start") {
        const block = ev.content_block as { type?: string; name?: string } | undefined;
        if (block?.type === "tool_use" && block.name === "StructuredOutput") {
          jsonBlockIndex = typeof ev.index === "number" ? ev.index : 0;
        }
        return;
      }
      if (ev.type !== "content_block_delta") return;
      const delta = ev.delta as { type?: string; partial_json?: string; text?: string } | undefined;
      if (delta?.type === "input_json_delta" && field && typeof delta.partial_json === "string") {
        if (jsonBlockIndex === null || ev.index === undefined || ev.index === jsonBlockIndex) {
          emitField(field.push(delta.partial_json));
        }
      } else if (delta?.type === "text_delta" && typeof delta.text === "string") {
        sawStreamTextDelta = true;
        lastTurnEmittedText += delta.text;
        options.onTextDelta?.(delta.text);
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
      finish(() =>
        reject(new ClaudeError("spawn", `could not start ${bin}: ${error.message}`, { stderr })),
      );
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      for (const line of splitter.end()) handleLine(line);
      if (settled) return;
      const wallMs = Date.now() - started;
      const details = {
        stderr: stderr.slice(0, 4000),
        exitCode: code,
        resultText: typeof result?.result === "string" ? result.result.slice(0, 4000) : "",
      };
      if (!result || result.is_error === true) {
        const fallbackResetMs = runnerOptions.fallbackResetMs ?? 30 * 60_000;
        const cls = classifyFailure({
          resultText: details.resultText,
          stderr,
          assistantErrors,
          assistantErrorTexts,
          rateLimit: rejectedLimit ?? rateLimit,
          now: now(),
          fallbackResetMs,
        });
        let error: ClaudeError;
        if (cls.code === "usage_limit") {
          error = new ClaudeUsageLimitError(
            `${options.label}: ${cls.message}`,
            cls.resetsAt ?? new Date(now().getTime() + fallbackResetMs),
            cls.resetSource ?? "fallback",
            details,
            rejectedLimit ?? rateLimit,
          );
        } else if (!result && cls.code === "process") {
          const hint = stderr ? `: ${stderr.trim().slice(0, 300)}` : "";
          error = new ClaudeError(
            "process",
            `${options.label}: claude exited ${code} without a result${hint}`,
            details,
          );
        } else {
          error = new ClaudeError(cls.code, `${options.label}: ${cls.message}`, details);
        }
        finish(() => reject(error));
        return;
      }
      const final = result;
      const output = final.structured_output ?? null;
      if (options.schema && (output === null || typeof output !== "object")) {
        finish(() =>
          reject(
            new ClaudeError(
              "output",
              `${options.label}: no structured output (stop: ${String(final.stop_reason ?? final.subtype ?? "?")})`,
              details,
            ),
          ),
        );
        return;
      }
      // Without partial messages (or if they were incomplete) emit the rest of the field now.
      if (field && options.streamField && output && typeof output === "object") {
        const value = (output as Record<string, unknown>)[options.streamField];
        if (typeof value === "string") {
          if (value.startsWith(emittedField)) emitField(value.slice(emittedField.length));
          else if (emittedField === "") emitField(value);
        }
      }
      const text = typeof final.result === "string" ? final.result : "";
      if (options.onTextDelta && !options.schema && text) {
        if (!sawStreamTextDelta) {
          options.onTextDelta(text);
        } else if (text.startsWith(lastTurnEmittedText)) {
          const rest = text.slice(lastTurnEmittedText.length);
          if (rest) options.onTextDelta(rest);
        }
      }
      const sessionId =
        typeof final.session_id === "string" && final.session_id ? final.session_id : initSessionId;
      finish(() =>
        resolve({
          output,
          text,
          model: firstModel(final.modelUsage) ?? initModel,
          cliVersion,
          ...(sessionId ? { sessionId } : {}),
          usage: readUsage(final, wallMs),
          rateLimit,
        }),
      );
    });

    const message = {
      type: "user",
      message: { role: "user", content: options.content.map(toWireBlock) },
    };
    child.stdin?.on("error", () => undefined); // EPIPE when the child dies early; handled on close
    child.stdin?.end(`${JSON.stringify(message)}\n`);
  });
}

function toWireBlock(block: ClaudeContentBlock): Record<string, unknown> {
  if (block.type === "text") return { type: "text", text: block.text };
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: block.mediaType,
      data: Buffer.from(block.data.buffer, block.data.byteOffset, block.data.byteLength).toString(
        "base64",
      ),
    },
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function firstModel(modelUsage: unknown): string | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  return Object.keys(modelUsage)[0];
}

function readUsage(result: Record<string, unknown>, wallMs: number): ClaudeUsage {
  const usage = (result.usage ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWriteTokens: num(usage.cache_creation_input_tokens),
    costUsd: num(result.total_cost_usd),
    durationMs: num(result.duration_ms),
    durationApiMs: num(result.duration_api_ms),
    wallMs,
  };
}

/** Sum of several calls' usage. */
export function addUsage(a: ClaudeUsage | undefined, b: ClaudeUsage): ClaudeUsage {
  if (!a) return { ...b };
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1e6) / 1e6,
    durationMs: a.durationMs + b.durationMs,
    durationApiMs: a.durationApiMs + b.durationApiMs,
    wallMs: a.wallMs + b.wallMs,
  };
}
