/**
 * Direct Gemini REST API runner (`v1beta` `streamGenerateContent?alt=sse`).
 *
 * Streams non-thought text parts live via `onTextDelta`, preserves `thought`,
 * `thoughtSignature`, and `functionCall` parts verbatim on `model` turns, and
 * executes tool calls sequentially through `StudioToolExecutor` for up to 12 rounds.
 */
import type { Brand, RunUsage, TurnContext } from "@studio/contract";
import type { ChatImageNote } from "../chat/prompt.ts";
import { buildConversationMetadataBlock, messageText } from "../chat/prompt.ts";
import type { StudioToolExecutor, ToolJsonSchema } from "../chat/tools.ts";
import { abortableSleep } from "../claude/gate.ts";
import type { Effort } from "../claude/models.ts";
import type { ClaudeContentBlock } from "../claude/runner.ts";
import { GeminiError } from "./errors.ts";
import { type GeminiModelAlias, thinkingConfigFor } from "./models.ts";
import { type GeminiUsageMetadata, type GeminiUsageSample, sampleFromMetadata } from "./pricing.ts";

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  inlineData?: { mimeType: string; data: string };
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  [key: string]: unknown;
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface BuildGeminiContentsInput {
  context: TurnContext;
  now: Date;
  brands: readonly Brand[];
  imageNotes: readonly ChatImageNote[];
  imageBlocks: readonly ClaudeContentBlock[];
}

/**
 * Build alternating `user` / `model` turns from `TurnContext` + loaded images.
 * Always starts and ends with `role: "user"`.
 */
export function buildGeminiContents(input: BuildGeminiContentsInput): GeminiContent[] {
  const { context } = input;
  const aliases = context.aliases ?? [];
  const metaHeader = buildConversationMetadataBlock({
    context,
    now: input.now,
    brands: input.brands,
    images: input.imageNotes,
  });

  const messages = context.messages.filter((m) => m.id !== context.assistantMessage?.id);
  const turns: GeminiContent[] = [];

  for (const m of messages) {
    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    const text = messageText(m, aliases).trim() || (m.role === "user" ? "(ek)" : "(yanıt)");
    const prev = turns.at(-1);
    if (prev && prev.role === role) {
      prev.parts.push({ text });
    } else {
      turns.push({ role, parts: [{ text }] });
    }
  }

  if (turns.length === 0 || turns[0]?.role !== "user") {
    turns.unshift({ role: "user", parts: [{ text: metaHeader }] });
  } else {
    const firstPart = turns[0]?.parts[0];
    if (firstPart && typeof firstPart.text === "string") {
      firstPart.text = `${metaHeader}\n\n${firstPart.text}`;
    } else {
      turns[0]?.parts.unshift({ text: metaHeader });
    }
  }

  if (turns.at(-1)?.role === "model") {
    turns.push({
      role: "user",
      parts: [{ text: "Yukarıdaki soruya verilen cevaba göre devam et." }],
    });
  }

  const lastUser = turns.at(-1);
  if (lastUser && input.imageBlocks.length > 0) {
    for (const block of input.imageBlocks) {
      if (block.type === "text") {
        lastUser.parts.push({ text: block.text });
      } else {
        lastUser.parts.push({
          inlineData: {
            mimeType: block.mediaType,
            data: Buffer.from(
              block.data.buffer,
              block.data.byteOffset,
              block.data.byteLength,
            ).toString("base64"),
          },
        });
      }
    }
  }

  return turns;
}

export interface GeminiApiTurnOptions {
  apiKey: string;
  modelId: string;
  requestedModel?: GeminiModelAlias | string;
  effort?: Effort;
  system: string;
  contents: GeminiContent[];
  executor: StudioToolExecutor;
  onTextDelta?: (text: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRounds?: number;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called once per request round with its token counts (spend tracking). */
  onUsage?: (sample: GeminiUsageSample) => void;
}

export interface GeminiTurnResult {
  model: string;
  usage: RunUsage;
  rounds: number;
}

interface GeminiStreamChunk {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }[];
  usageMetadata?: GeminiUsageMetadata & { totalTokenCount?: number };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

function sanitizeSecret(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[REDACTED]");
}

function cleanSchema(schema: ToolJsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = { type: schema.type };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = [...schema.enum];
  if (schema.items) out.items = cleanSchema(schema.items);
  if (schema.properties) {
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      props[k] = cleanSchema(v);
    }
    out.properties = props;
  }
  if (schema.required && schema.required.length > 0) {
    out.required = [...schema.required];
  }
  return out;
}

/** Parse SSE `data: ...` frames from a ReadableStream (handles arbitrary byte boundaries). */
export async function* parseSseJsonStream<T>(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];

  const flushEvent = (): T | undefined => {
    if (dataLines.length === 0) return undefined;
    const joined = dataLines.join("\n").trim();
    dataLines = [];
    if (!joined || joined === "[DONE]") return undefined;
    return JSON.parse(joined) as T;
  };

  try {
    for (;;) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const rawLine = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (rawLine === "") {
          const parsed = flushEvent();
          if (parsed !== undefined) yield parsed;
        } else if (rawLine.startsWith("data:")) {
          dataLines.push(rawLine.slice(5).replace(/^ /, ""));
        }
        nl = buffer.indexOf("\n");
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      for (const rawLine of buffer.split(/\r?\n/)) {
        if (rawLine.startsWith("data:")) {
          dataLines.push(rawLine.slice(5).replace(/^ /, ""));
        }
      }
    }
    const last = flushEvent();
    if (last !== undefined) yield last;
  } finally {
    reader.releaseLock();
  }
}

function appendModelPart(target: GeminiPart[], part: GeminiPart): void {
  const isPlainTextOnly =
    typeof part.text === "string" &&
    part.thoughtSignature === undefined &&
    part.functionCall === undefined &&
    part.inlineData === undefined;
  const prev = target.at(-1);
  const prevIsPlainTextOnly =
    prev !== undefined &&
    typeof prev.text === "string" &&
    prev.thoughtSignature === undefined &&
    prev.functionCall === undefined &&
    prev.inlineData === undefined &&
    Boolean(prev.thought) === Boolean(part.thought);

  if (isPlainTextOnly && prevIsPlainTextOnly && prev) {
    prev.text = `${prev.text}${part.text}`;
    return;
  }
  target.push({ ...part });
}

export async function runGeminiApiTurn(options: GeminiApiTurnOptions): Promise<GeminiTurnResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? abortableSleep;
  const maxRounds = options.maxRounds ?? 12;
  const startedAt = Date.now();
  const contents: GeminiContent[] = options.contents.map((c) => ({
    role: c.role,
    parts: [...c.parts],
  }));

  const functionDeclarations = options.executor.geminiFunctionDeclarations().map((d) => ({
    name: d.name,
    description: d.description,
    parameters: cleanSchema(d.parameters),
  }));
  const thinkingConfig = thinkingConfigFor(options.modelId, options.effort);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.modelId)}:streamGenerateContent?alt=sse`;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let thoughtsTokens = 0;
  let modelVersion: string | undefined;
  let rounds = 0;

  for (let round = 0; round < maxRounds; round++) {
    options.signal?.throwIfAborted();
    rounds++;

    const requestBody: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: options.system }] },
      contents,
      ...(functionDeclarations.length > 0 ? { tools: [{ functionDeclarations }] } : {}),
      ...(thinkingConfig ? { generationConfig: { thinkingConfig } } : {}),
    };

    const res = await fetchWithRetry(
      doFetch,
      url,
      options.apiKey,
      requestBody,
      options.signal,
      sleep,
    );
    if (!res.body) {
      throw new GeminiError("api", "Gemini boş yanıt gövdesi döndürdü.", res.status);
    }

    const roundParts: GeminiPart[] = [];
    let roundPrompt = 0;
    let roundCandidates = 0;
    let roundCached = 0;
    let roundThoughts = 0;
    let roundMeta: GeminiUsageMetadata | undefined;

    for await (const chunk of parseSseJsonStream<GeminiStreamChunk>(res.body, options.signal)) {
      if (chunk.error) {
        const msg = sanitizeSecret(chunk.error.message ?? "stream error", options.apiKey);
        throw classifyHttpError(chunk.error.code ?? 500, msg);
      }
      if (chunk.modelVersion) modelVersion = chunk.modelVersion;
      if (chunk.usageMetadata) {
        roundMeta = chunk.usageMetadata;
        if (typeof chunk.usageMetadata.promptTokenCount === "number") {
          roundPrompt = chunk.usageMetadata.promptTokenCount;
        }
        if (typeof chunk.usageMetadata.candidatesTokenCount === "number") {
          roundCandidates = chunk.usageMetadata.candidatesTokenCount;
        }
        if (typeof chunk.usageMetadata.cachedContentTokenCount === "number") {
          roundCached = chunk.usageMetadata.cachedContentTokenCount;
        }
        if (typeof chunk.usageMetadata.thoughtsTokenCount === "number") {
          roundThoughts = chunk.usageMetadata.thoughtsTokenCount;
        }
      }

      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (!part.thought && typeof part.text === "string" && part.text.length > 0) {
          options.onTextDelta?.(part.text);
        }
        appendModelPart(roundParts, part);
      }
    }

    if (roundMeta) {
      try {
        options.onUsage?.(sampleFromMetadata(modelVersion ?? options.modelId, roundMeta));
      } catch {
        // spend tracking never breaks a turn
      }
    }
    inputTokens += roundPrompt;
    outputTokens += roundCandidates;
    cacheReadTokens += roundCached;
    thoughtsTokens += roundThoughts;

    const functionCalls = roundParts
      .map((p) => p.functionCall)
      .filter((fc): fc is NonNullable<GeminiPart["functionCall"]> => Boolean(fc?.name));

    if (functionCalls.length === 0) {
      break;
    }

    if (round === maxRounds - 1) {
      throw new GeminiError("api", `Gemini çok fazla araç adımı istedi (sınır: ${maxRounds}).`);
    }

    contents.push({ role: "model", parts: roundParts });

    const responseParts: GeminiPart[] = [];
    for (const fc of functionCalls) {
      options.signal?.throwIfAborted();
      const out = await options.executor.execute(fc.name, fc.args ?? {}, fc.id);
      responseParts.push({
        functionResponse: {
          ...(fc.id ? { id: fc.id } : {}),
          name: fc.name,
          response: out.data,
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  const finalModel = modelVersion ?? options.modelId;
  const usage: RunUsage = {
    model: finalModel,
    ...(options.requestedModel ? { requestedModel: options.requestedModel } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    durationMs: Math.max(0, Date.now() - startedAt),
    calls: rounds,
    ...(thoughtsTokens > 0 ? { thoughtsTokens } : {}),
  };

  return { model: finalModel, usage, rounds };
}

async function fetchWithRetry(
  doFetch: typeof globalThis.fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
): Promise<Response> {
  const payload = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: payload,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      const msg = sanitizeSecret((error as Error).message ?? "network error", apiKey);
      if (attempt < 2) {
        await sleep(500 * 2 ** attempt, signal);
        continue;
      }
      throw new GeminiError("transient", msg);
    }

    if (res.ok) return res;

    const rawText = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(rawText) as { error?: { message?: string; status?: string } };
      if (parsed.error?.message) message = parsed.error.message;
    } catch {
      if (rawText.trim()) message = rawText.trim().slice(0, 300);
    }
    message = sanitizeSecret(message, apiKey);

    const err = classifyHttpError(res.status, message);
    if (err.code === "transient" && attempt < 2) {
      await sleep(500 * 2 ** attempt, signal);
      continue;
    }
    throw err;
  }
}

function classifyHttpError(status: number, message: string): GeminiError {
  if (
    status === 401 ||
    status === 403 ||
    /api[_ ]?key[_ ]?invalid|unauthenticated/i.test(message)
  ) {
    return new GeminiError("auth", message, status);
  }
  if (status === 429 || /resource_exhausted|quota|rate limit/i.test(message)) {
    return new GeminiError("rate_limit", message, status);
  }
  if (status >= 500 || status === 408) {
    return new GeminiError("transient", message, status);
  }
  return new GeminiError("api", message, status);
}
