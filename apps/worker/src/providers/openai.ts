/**
 * OpenAI API driver (ChatGPT models with the API key from the vault): one chat turn through the
 * Responses API (`POST /v1/responses`) with Studio's tools as function tools, the OpenAI
 * counterpart of the direct Gemini API runner.
 *
 * Each round is one request; function calls run through the turn's `StudioToolExecutor`
 * (tool steps, plans and consent cards go through the turn writer as with the other drivers)
 * and the next round continues with `previous_response_id` plus the `function_call_output`s.
 * Answers are written when a round ends (no token streaming). Errors never carry the key.
 */
import type { OpenAiUsageSample, RunUsage } from "@studio/contract";
import type { StudioToolExecutor, ToolJsonSchema } from "../chat/tools.ts";
import { abortableSleep } from "../claude/gate.ts";
import type { Effort } from "../claude/models.ts";
import { startTurnTimer, type TurnWaits } from "../claude/turn-waits.ts";
import type { GeminiContent } from "../gemini/api-runner.ts";
import { classifyFailure, ProviderError } from "./cli.ts";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

/**
 * Preferred models, best first (checked on OPENAI_MODELS_CHECKED_AT against
 * https://platform.openai.com/docs/models). Picked from the key's model list; the static list is
 * used as is only when the key's list is unknown (empty).
 */
export const OPENAI_MODELS_CHECKED_AT = "2026-11-18";
export const OPENAI_MODEL_PREFERENCE = [
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.5",
] as const;

/** Model families that are not general chat models (Responses API with function tools). */
const NOT_GENERAL_CHAT =
  /(?:audio|realtime|image|embedding|tts|transcribe|search|codex|instruct|moderation|whisper|dall-e|computer-use|deep-research|diarize)/;

interface ChatModelRank {
  id: string;
  version: [number, number];
  /** Smaller, costlier or less stable variants (mini/nano/pro/preview/chat): only when nothing else. */
  secondary: boolean;
  /** Dated snapshot (`-2025-08-07`): the plain alias is preferred. */
  dated: boolean;
}

function rankChatModel(id: string): ChatModelRank | null {
  const m = /^gpt-(\d+)(?:\.(\d+))?(o)?(?=-|$)/.exec(id);
  if (!m || NOT_GENERAL_CHAT.test(id)) return null;
  return {
    id,
    // `gpt-4o` sits between gpt-4 and gpt-4.1.
    version: [Number(m[1]), m[2] !== undefined ? Number(m[2]) : m[3] ? 0.5 : 0],
    secondary: /-(?:mini|nano|pro|preview|chat)(?:-|$)/.test(id),
    dated: /-\d{4}-\d{2}-\d{2}$/.test(id),
  };
}

/** Newest general chat model of a key's model list (`gpt-*`), undefined when it has none. */
export function newestOpenAiChatModel(available: readonly string[]): string | undefined {
  const ranked = available.map(rankChatModel).filter((r): r is ChatModelRank => r !== null);
  ranked.sort(
    (a, b) =>
      Number(a.secondary) - Number(b.secondary) ||
      b.version[0] - a.version[0] ||
      b.version[1] - a.version[1] ||
      Number(a.dated) - Number(b.dated) ||
      a.id.length - b.id.length ||
      a.id.localeCompare(b.id),
  );
  return ranked[0]?.id;
}

/**
 * The model for "GPT (OpenAI API)": STUDIO_OPENAI_MODEL, else the first preferred model the key
 * listed at its last check, else the newest general chat model of that list; the static
 * preference only when the list is empty (unknown) or names no chat model.
 */
export function pickOpenAiModel(
  configured: string | undefined,
  available: readonly string[],
): string {
  if (configured) return configured;
  const set = new Set(available);
  return (
    OPENAI_MODEL_PREFERENCE.find((m) => set.has(m)) ??
    newestOpenAiChatModel(available) ??
    OPENAI_MODEL_PREFERENCE[0]
  );
}

export function openAiReasoning(effort: Effort | undefined): "low" | "medium" | "high" {
  if (effort === "low") return "low";
  if (effort === "high" || effort === "xhigh" || effort === "max") return "high";
  return "medium";
}

type InputContent =
  | { type: "input_text"; text: string }
  | { type: "output_text"; text: string }
  | { type: "input_image"; image_url: string };

type InputItem =
  | { role: "user" | "assistant"; content: InputContent[] }
  | { type: "function_call_output"; call_id: string; output: string };

/** Gemini-shaped turns (`buildGeminiContents`) as Responses API input messages. */
export function toResponsesInput(contents: readonly GeminiContent[]): InputItem[] {
  return contents.map((turn) => {
    const role = turn.role === "model" ? "assistant" : "user";
    const content: InputContent[] = [];
    for (const part of turn.parts) {
      if (typeof part.text === "string" && part.text.length > 0) {
        content.push(
          role === "assistant"
            ? { type: "output_text", text: part.text }
            : { type: "input_text", text: part.text },
        );
      } else if (part.inlineData && role === "user") {
        content.push({
          type: "input_image",
          image_url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        });
      }
    }
    if (content.length === 0) content.push({ type: "input_text", text: "(boş)" });
    return { role, content };
  });
}

function cleanSchema(schema: ToolJsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: schema.type };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = [...schema.enum];
  if (schema.items) out.items = cleanSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, cleanSchema(v)]),
    );
  }
  if (schema.required && schema.required.length > 0) out.required = [...schema.required];
  return out;
}

export interface OpenAiTurnOptions {
  apiKey: string;
  model: string;
  effort?: Effort | undefined;
  system: string;
  contents: GeminiContent[];
  executor: StudioToolExecutor;
  onTextDelta?: (text: string) => void;
  signal?: AbortSignal;
  /**
   * The turn's cap on the model's own work (default 15 min); the waits (consent, ask_user,
   * wait_jobs) do not count (U8, U1).
   */
  timeoutMs?: number;
  waits?: TurnWaits;
  maxRounds?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Before each paid request (the monthly budget check, S7); throwing stops the turn. */
  beforeRequest?: () => void;
  /** Each request's tokens (spend tracking, U8). */
  onUsage?: (sample: OpenAiUsageSample) => void;
}

/** Default cap of an OpenAI turn's own work. */
export const OPENAI_TURN_TIMEOUT_MS = 15 * 60_000;

export interface OpenAiTurnResult {
  model: string;
  usage: RunUsage;
  rounds: number;
}

interface ResponsesBody {
  id?: string;
  model?: string;
  status?: string;
  error?: { message?: string } | null;
  incomplete_details?: { reason?: string } | null;
  output?: {
    type?: string;
    role?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: { type?: string; text?: string }[];
  }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens_details?: { reasoning_tokens?: number };
  };
}

function clean(text: string, key: string): string {
  return (key.length >= 4 ? text.split(key).join("[anahtar]") : text).slice(0, 400);
}

async function post(
  options: OpenAiTurnOptions,
  body: Record<string, unknown>,
): Promise<ResponsesBody> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? abortableSleep;
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let res: Response;
    try {
      res = await doFetch(RESPONSES_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: payload,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      if (attempt < 2) {
        await sleep(500 * 2 ** attempt, options.signal);
        continue;
      }
      throw new ProviderError(
        "openai",
        "transient",
        clean((error as Error).message, options.apiKey),
      );
    }
    const raw = await res.text().catch(() => "");
    if (res.ok) {
      try {
        return JSON.parse(raw) as ResponsesBody;
      } catch {
        throw new ProviderError("openai", "api", "OpenAI yanıtı geçerli JSON değil.");
      }
    }
    let message = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      if (raw.trim()) message = raw.trim();
    }
    message = clean(message, options.apiKey);
    const code =
      res.status === 401 || res.status === 403
        ? "auth"
        : res.status === 429
          ? "rate_limit"
          : res.status >= 500 || res.status === 408
            ? "transient"
            : classifyFailure(message) === "auth"
              ? "auth"
              : "api";
    if (code === "transient" && attempt < 2) {
      await sleep(500 * 2 ** attempt, options.signal);
      continue;
    }
    throw new ProviderError("openai", code, message, res.status);
  }
}

export async function runOpenAiTurn(options: OpenAiTurnOptions): Promise<OpenAiTurnResult> {
  // The turn had no time cap at all (U8): a hung request held the job forever.
  const timeoutMs = options.timeoutMs ?? OPENAI_TURN_TIMEOUT_MS;
  const timeout = new AbortController();
  const timer = startTurnTimer({
    timeoutMs,
    waits: options.waits,
    onTimeout: () =>
      timeout.abort(
        new ProviderError(
          "openai",
          "timeout",
          `OpenAI turn: no answer after ${timeoutMs} ms of work`,
        ),
      ),
  });
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout.signal])
    : timeout.signal;
  try {
    return await runOpenAiRounds({ ...options, signal });
  } catch (error) {
    if (timeout.signal.aborted && !options.signal?.aborted) throw timeout.signal.reason;
    throw error;
  } finally {
    timer.cancel();
  }
}

async function runOpenAiRounds(options: OpenAiTurnOptions): Promise<OpenAiTurnResult> {
  const started = Date.now();
  const maxRounds = options.maxRounds ?? 12;
  const tools = options.executor.geminiFunctionDeclarations().map((d) => ({
    type: "function",
    name: d.name,
    description: d.description,
    parameters: cleanSchema(d.parameters),
    strict: false,
  }));
  let input: InputItem[] = toResponsesInput(options.contents);
  let previousId: string | undefined;
  let usedModel = options.model;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let rounds = 0;
  let wroteAny = false;

  for (let round = 0; round < maxRounds; round++) {
    rounds++;
    const body: Record<string, unknown> = {
      model: options.model,
      instructions: options.system,
      input,
      reasoning: { effort: openAiReasoning(options.effort) },
      ...(tools.length > 0 ? { tools, tool_choice: "auto", parallel_tool_calls: false } : {}),
      ...(previousId ? { previous_response_id: previousId } : {}),
    };
    options.beforeRequest?.();
    const res = await post(options, body);
    if (res.usage) {
      try {
        options.onUsage?.({
          model: res.model ?? options.model,
          inputTokens: res.usage.input_tokens ?? 0,
          cachedTokens: res.usage.input_tokens_details?.cached_tokens ?? 0,
          outputTokens: res.usage.output_tokens ?? 0,
          reasoningTokens: res.usage.output_tokens_details?.reasoning_tokens ?? 0,
        });
      } catch {
        // spend tracking never breaks a turn
      }
    }
    if (res.status === "failed" || res.error?.message) {
      const msg = clean(res.error?.message ?? "OpenAI yanıtı başarısız", options.apiKey);
      throw new ProviderError("openai", classifyFailure(msg), msg);
    }
    if (res.model) usedModel = res.model;
    inputTokens += res.usage?.input_tokens ?? 0;
    outputTokens += res.usage?.output_tokens ?? 0;
    cachedTokens += res.usage?.input_tokens_details?.cached_tokens ?? 0;
    reasoningTokens += res.usage?.output_tokens_details?.reasoning_tokens ?? 0;

    const output = res.output ?? [];
    const text = output
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content ?? [])
      .filter((c) => c.type === "output_text" && typeof c.text === "string")
      .map((c) => c.text ?? "")
      .join("");
    if (text) {
      options.onTextDelta?.(wroteAny ? `\n\n${text}` : text);
      wroteAny = true;
    }
    const calls = output.filter((o) => o.type === "function_call" && o.name && o.call_id);
    if (calls.length === 0) {
      if (!wroteAny && res.status === "incomplete") {
        throw new ProviderError(
          "openai",
          "api",
          `OpenAI yanıtı yarım kaldı (${res.incomplete_details?.reason ?? "bilinmiyor"}).`,
        );
      }
      break;
    }
    if (round === maxRounds - 1) {
      throw new ProviderError(
        "openai",
        "api",
        `Çok fazla araç adımı istendi (sınır: ${maxRounds}).`,
      );
    }
    if (!res.id) throw new ProviderError("openai", "api", "OpenAI yanıt kimliği döndürmedi.");
    previousId = res.id;
    const outputs: InputItem[] = [];
    for (const call of calls) {
      options.signal?.throwIfAborted();
      let args: unknown = {};
      try {
        args = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        args = {};
      }
      const out = await options.executor.execute(call.name as string, args, call.call_id);
      outputs.push({
        type: "function_call_output",
        call_id: call.call_id as string,
        output: JSON.stringify(out.data),
      });
    }
    input = outputs;
  }

  const usage: RunUsage = {
    model: usedModel,
    requestedModel: "gpt",
    ...(options.effort ? { effort: options.effort } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens: cachedTokens,
    durationMs: Math.max(0, Date.now() - started),
    calls: rounds,
    runner: "openai-api",
    ...(reasoningTokens > 0 ? { thoughtsTokens: reasoningTokens } : {}),
  };
  return { model: usedModel, usage, rounds };
}
