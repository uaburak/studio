/**
 * Headless `gemini` CLI runner (used when `STUDIO_GEMINI_MODE=cli` or when
 * `GEMINI_API_KEY` is absent in `.env` while `gemini` CLI is installed).
 *
 * Runs inside the per-turn `McpBridge` `workDir`, where `.gemini/settings.json`
 * points at `studio-mcp.mjs` (`trust: true`) and `--yolo` lets tool calls reach
 * Studio's own `consent` card enforcement without interactive terminal prompts.
 */
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { RunUsage } from "@studio/contract";
import type { McpBridge } from "../chat/mcp-bridge.ts";
import type { Effort } from "../claude/models.ts";
import { LineSplitter } from "../claude/stream.ts";
import { GeminiError } from "./errors.ts";
import { buildGeminiEnv } from "./health.ts";
import type { GeminiModelAlias } from "./models.ts";

export interface GeminiCliTurnOptions {
  bin?: string;
  apiKey?: string | undefined;
  parentEnv?: NodeJS.ProcessEnv;
  modelId: string;
  requestedModel?: GeminiModelAlias | string;
  effort?: Effort;
  system: string;
  prompt: string;
  bridge: McpBridge;
  onTextDelta?: (text: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
  spawn?: typeof nodeSpawn;
}

export interface GeminiCliTurnResult {
  model: string;
  usage: RunUsage;
}

const KILL_GRACE_MS = 3_000;

export async function runGeminiCliTurn(
  options: GeminiCliTurnOptions,
): Promise<GeminiCliTurnResult> {
  options.signal?.throwIfAborted();
  const systemFile = path.join(options.bridge.workDir, "gemini-system.md");
  await writeFile(systemFile, options.system, "utf8");

  const env = buildGeminiEnv(options.parentEnv ?? process.env, {
    apiKey: options.apiKey,
    extra: {
      GEMINI_SYSTEM_MD: systemFile,
    },
  });

  try {
    return await executeCli(options, env, "stream-json");
  } catch (error) {
    if (
      error instanceof GeminiError &&
      error.code === "api" &&
      /output-format|stream-json|unknown (?:option|argument)/i.test(error.message)
    ) {
      return executeCli(options, env, "text");
    }
    throw error;
  }
}

function executeCli(
  options: GeminiCliTurnOptions,
  env: Record<string, string>,
  format: "stream-json" | "text",
): Promise<GeminiCliTurnResult> {
  const spawn = options.spawn ?? nodeSpawn;
  const bin = options.bin ?? "gemini";
  const timeoutMs = options.timeoutMs ?? 15 * 60_000;
  const started = Date.now();

  const args = ["--model", options.modelId, "--yolo"];
  if (format === "stream-json") {
    args.push("--output-format", "stream-json");
  }
  args.push("-p", "Yukarıdaki Studio bağlamına ve son kullanıcı mesajına Türkçe yanıt ver.");

  return new Promise<GeminiCliTurnResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        cwd: options.bridge.workDir,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new GeminiError("spawn", `could not start ${bin}: ${(error as Error).message}`));
      return;
    }

    const splitter = new LineSplitter();
    let stdoutRaw = "";
    let stderr = "";
    let emitted = "";
    let sawJsonStream = false;
    let initModel: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let resultError: string | undefined;
    let finalResponseText: string | undefined;
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
        reject(new GeminiError("timeout", `gemini CLI timed out after ${timeoutMs} ms`)),
      );
    }, timeoutMs);
    timer.unref?.();

    const onAbort = () => {
      kill();
      finish(() => reject(options.signal?.reason ?? new Error("aborted")));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const handleLine = (line: string) => {
      if (format !== "stream-json") return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      sawJsonStream = true;
      const type = ev.type;
      if (type === "init" && typeof ev.model === "string") {
        initModel = ev.model;
        return;
      }
      if (
        type === "message" &&
        (ev.role === "assistant" || ev.role === "model") &&
        typeof ev.content === "string"
      ) {
        if (ev.delta === true || emitted === "") {
          emitted += ev.content;
          options.onTextDelta?.(ev.content);
        } else if (ev.content.startsWith(emitted)) {
          const rest = ev.content.slice(emitted.length);
          if (rest) {
            emitted += rest;
            options.onTextDelta?.(rest);
          }
        }
        return;
      }
      if (type === "result") {
        if (ev.status === "error" || ev.is_error === true) {
          const errObj = ev.error as { message?: string } | string | undefined;
          resultError =
            typeof errObj === "string"
              ? errObj
              : typeof errObj?.message === "string"
                ? errObj.message
                : typeof ev.result === "string"
                  ? ev.result
                  : "gemini CLI reported an error";
        }
        if (typeof ev.response === "string") finalResponseText = ev.response;
        else if (typeof ev.result === "string") finalResponseText = ev.result;
        const stats = ev.stats as Record<string, unknown> | undefined;
        if (stats) {
          if (typeof stats.input_tokens === "number") inputTokens = stats.input_tokens;
          if (typeof stats.inputTokens === "number") inputTokens = stats.inputTokens;
          if (typeof stats.output_tokens === "number") outputTokens = stats.output_tokens;
          if (typeof stats.outputTokens === "number") outputTokens = stats.outputTokens;
          if (typeof stats.cached === "number") cachedTokens = stats.cached;
        }
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdoutRaw.length < 200_000) stdoutRaw += chunk;
      if (format === "text") {
        emitted += chunk;
        options.onTextDelta?.(chunk);
        return;
      }
      for (const line of splitter.push(chunk)) handleLine(line);
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 20_000) stderr += chunk;
    });
    child.on("error", (error) => {
      finish(() => reject(new GeminiError("spawn", `could not start ${bin}: ${error.message}`)));
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      for (const line of splitter.end()) handleLine(line);
      if (settled) return;

      if (code !== 0 || resultError) {
        const msg = (resultError || stderr.trim() || stdoutRaw.trim() || `exit ${code}`).slice(
          0,
          400,
        );
        if (/401|403|api[_ ]?key|unauthenticated|not logged in/i.test(msg)) {
          finish(() => reject(new GeminiError("auth", msg)));
          return;
        }
        if (/429|quota|rate[_ ]?limit|resource_exhausted/i.test(msg)) {
          finish(() => reject(new GeminiError("rate_limit", msg)));
          return;
        }
        finish(() => reject(new GeminiError("api", msg)));
        return;
      }

      if (!sawJsonStream && format === "stream-json" && stdoutRaw.trim()) {
        // Fallback if CLI printed a single JSON object `{ "response": "..." }` or plain text
        try {
          const single = JSON.parse(stdoutRaw.trim()) as { response?: unknown };
          if (typeof single.response === "string" && single.response) {
            options.onTextDelta?.(single.response);
            emitted += single.response;
          } else {
            options.onTextDelta?.(stdoutRaw.trim());
            emitted += stdoutRaw.trim();
          }
        } catch {
          options.onTextDelta?.(stdoutRaw.trim());
          emitted += stdoutRaw.trim();
        }
      } else if (finalResponseText && emitted === "") {
        options.onTextDelta?.(finalResponseText);
      }

      const model = initModel ?? options.modelId;
      const usage: RunUsage = {
        model,
        ...(options.requestedModel ? { requestedModel: options.requestedModel } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        inputTokens,
        outputTokens,
        cacheReadTokens: cachedTokens,
        durationMs: Math.max(0, Date.now() - started),
        calls: 1,
        runner: "gemini-cli",
      };
      finish(() => resolve({ model, usage }));
    });

    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`${options.system}\n\n${options.prompt}\n`);
  });
}
