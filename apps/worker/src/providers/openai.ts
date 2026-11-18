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
import type { RunUsage } from "@studio/contract";
import type { StudioToolExecutor, ToolJsonSchema } from "../chat/tools.ts";
import { abortableSleep } from "../claude/gate.ts";
import type { Effort } from "../claude/models.ts";
import type { GeminiContent } from "../gemini/api-runner.ts";
import { classifyFailure, ProviderError } from "./cli.ts";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

/** Newest first: the default model when STUDIO_OPENAI_MODEL is not set. */
export const OPENAI_MODEL_PREFERENCE = [
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.5",
] as const;

/**
 * The model for "GPT (OpenAI API)": STUDIO_OPENAI_MODEL, else the first preferred model the key
 * listed at its last check, else the first preferred one.
 */
export function pickOpenAiModel(
  configured: string | undefined,
  available: readonly string[],
): string {
  if (configured) return configured;
  const set = new Set(available);
  return OPENAI_MODEL_PREFERENCE.find((m) => set.has(m)) ?? OPENAI_MODEL_PREFERENCE[0];
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
  maxRounds?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

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
    const res = await post(options, body);
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
