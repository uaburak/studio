/**
 * Direct Gemini REST API structured JSON caller (`v1beta` `generateContent`)
 * and unified Claude/Gemini structured AI router for `content.generate`,
 * `brand.analyze`, and the Reels video engine.
 */
import type { AgentSettings } from "../agent.ts";
import { ClaudeError, ClaudeUsageLimitError } from "../claude/errors.ts";
import { abortableSleep, type ClaudeGate, type GateHooks } from "../claude/gate.ts";
import type { ClaudeHealth } from "../claude/health.ts";
import {
  chooseModel,
  DEFAULT_EFFORT,
  type Effort,
  MODEL_ALIASES,
  readChoice,
} from "../claude/models.ts";
import type { ClaudeContentBlock, ClaudeUsage } from "../claude/runner.ts";
import { GeminiError } from "./errors.ts";
import {
  type GeminiModelAlias,
  isGeminiModelAlias,
  resolveGeminiModelId,
  thinkingConfigFor,
} from "./models.ts";

export type GeminiInlineInput =
  | ClaudeContentBlock
  | { type: "inline"; mimeType: string; data: Uint8Array };

export interface CallGeminiJsonOptions {
  apiKey: string;
  modelId: string;
  system: string;
  content: readonly GeminiInlineInput[];
  schema?: object;
  effort?: Effort;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface StructuredAiResult {
  output: unknown;
  text: string;
  model: string;
  provider: "claude" | "gemini";
  usage: ClaudeUsage;
}

interface GeminiGenerateResponse {
  candidates?: {
    content?: {
      parts?: { text?: string; thought?: boolean }[];
    };
    finishReason?: string;
  }[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
  };
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

function sanitizeSecret(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[REDACTED]");
}

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new GeminiError("api", "Gemini boş JSON yanıtı döndürdü.");
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    if (fenced?.[1]) {
      return JSON.parse(fenced[1]);
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(trimmed.slice(start, end + 1));
    }
    throw new GeminiError("api", `Gemini geçerli JSON döndürmedi: ${trimmed.slice(0, 200)}`);
  }
}

export async function callGeminiJson(options: CallGeminiJsonOptions): Promise<StructuredAiResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? abortableSleep;
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new GeminiError(
      "auth",
      "GEMINI_API_KEY tanımlı değil: lütfen apps/worker/.env dosyasına GEMINI_API_KEY ekleyin.",
    );
  }

  const parts = options.content.map((block) => {
    if (block.type === "text") return { text: block.text };
    const mimeType = block.type === "image" ? block.mediaType : block.mimeType;
    return {
      inlineData: {
        mimeType,
        data: Buffer.from(block.data.buffer, block.data.byteOffset, block.data.byteLength).toString(
          "base64",
        ),
      },
    };
  });

  const thinkingConfig = thinkingConfigFor(options.modelId, options.effort);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(options.modelId)}:generateContent`;
  const startedAt = Date.now();

  const buildBody = (includeJsonSchema: boolean): Record<string, unknown> => ({
    systemInstruction: { parts: [{ text: options.system }] },
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      ...(includeJsonSchema && options.schema ? { responseJsonSchema: options.schema } : {}),
      ...(thinkingConfig ? { thinkingConfig } : {}),
    },
  });

  let useJsonSchema = Boolean(options.schema);

  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "x-goog-api-key": apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify(buildBody(useJsonSchema)),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason ?? error;
      const msg = sanitizeSecret((error as Error).message ?? "network error", apiKey);
      if (attempt < 2) {
        await sleep(500 * 2 ** attempt, options.signal);
        continue;
      }
      throw new GeminiError("transient", msg);
    }

    const rawText = await res.text().catch(() => "");
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const parsedErr = JSON.parse(rawText) as { error?: { message?: string } };
        if (parsedErr.error?.message) msg = parsedErr.error.message;
      } catch {
        if (rawText.trim()) msg = rawText.trim().slice(0, 300);
      }
      msg = sanitizeSecret(msg, apiKey);

      if (res.status === 400 && useJsonSchema && /responseJsonSchema|schema/i.test(msg)) {
        useJsonSchema = false;
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        throw new GeminiError("auth", msg, res.status);
      }
      if (res.status === 429) {
        throw new GeminiError("rate_limit", msg, res.status);
      }
      if ((res.status >= 500 || res.status === 408) && attempt < 2) {
        await sleep(500 * 2 ** attempt, options.signal);
        continue;
      }
      throw new GeminiError(res.status >= 500 ? "transient" : "api", msg, res.status);
    }

    let body: GeminiGenerateResponse;
    try {
      body = JSON.parse(rawText) as GeminiGenerateResponse;
    } catch {
      throw new GeminiError("api", "Gemini yanıtı geçerli JSON değil.");
    }

    const textParts = (body.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === "string")
      .map((p) => p.text ?? "");
    const text = textParts.join("").trim();
    if (!text) {
      const reason = body.candidates?.[0]?.finishReason ?? "unknown";
      throw new GeminiError(
        "api",
        `Gemini yapılandırılmış çıktı üretmedi (finishReason=${reason}).`,
      );
    }

    const output = extractJsonObject(text);
    const wallMs = Math.max(1, Date.now() - startedAt);
    const u = body.usageMetadata;

    return {
      output,
      text,
      model: body.modelVersion ?? options.modelId,
      provider: "gemini",
      usage: {
        inputTokens: u?.promptTokenCount ?? 0,
        outputTokens: u?.candidatesTokenCount ?? 0,
        cacheReadTokens: u?.cachedContentTokenCount ?? 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        durationMs: wallMs,
        durationApiMs: wallMs,
        wallMs,
      },
    };
  }
}

export interface StructuredRouteOptions {
  requestedModel?: string | null | undefined;
  requestedEffort?: string | null | undefined;
  defaultEffort?: string | undefined;
  defaultGeminiAlias?: GeminiModelAlias;
  settings: AgentSettings;
  claudeHealth: ClaudeHealth;
}

export type StructuredRoute =
  | {
      provider: "claude";
      model: string;
      effort: Effort;
      canFallbackToGemini: boolean;
      fallbackModelId?: string;
    }
  | {
      provider: "gemini";
      alias: GeminiModelAlias;
      modelId: string;
      effort: Effort;
    };

export function hasGeminiApiKey(settings: AgentSettings): boolean {
  const key = settings.parentEnv.GEMINI_API_KEY ?? settings.geminiApiKey;
  return Boolean(key && key.trim().length > 0);
}

export function getGeminiApiKey(settings: AgentSettings): string | undefined {
  const key = (settings.parentEnv.GEMINI_API_KEY ?? settings.geminiApiKey)?.trim();
  return key && key.length > 0 ? key : undefined;
}

export function resolveStructuredRoute(input: StructuredRouteOptions): StructuredRoute {
  const { settings, claudeHealth } = input;
  const geminiReady = hasGeminiApiKey(settings);
  const fallbackAlias = input.defaultGeminiAlias ?? "gemini-flash";
  const fallbackModelId = resolveGeminiModelId(fallbackAlias, settings.geminiModels);
  const rawChoice = readChoice({
    ...(input.requestedModel ? { model: input.requestedModel } : {}),
    ...(input.requestedEffort ? { effort: input.requestedEffort } : {}),
  });
  const effort: Effort =
    rawChoice.effort ?? (input.defaultEffort as Effort | undefined) ?? DEFAULT_EFFORT;

  if (isGeminiModelAlias(input.requestedModel)) {
    if (!geminiReady) {
      throw new GeminiError(
        "auth",
        "Gemini modeli seçildi ancak .env dosyasında GEMINI_API_KEY tanımlı değil.",
      );
    }
    return {
      provider: "gemini",
      alias: input.requestedModel,
      modelId: resolveGeminiModelId(input.requestedModel, settings.geminiModels),
      effort,
    };
  }

  if (
    typeof input.requestedModel === "string" &&
    input.requestedModel.toLowerCase().startsWith("gemini-")
  ) {
    if (!geminiReady) {
      throw new GeminiError(
        "auth",
        "Gemini modeli seçildi ancak .env dosyasında GEMINI_API_KEY tanımlı değil.",
      );
    }
    return {
      provider: "gemini",
      alias: fallbackAlias,
      modelId: input.requestedModel,
      effort,
    };
  }

  const isExplicitClaude =
    typeof input.requestedModel === "string" &&
    (MODEL_ALIASES as readonly string[]).includes(input.requestedModel);

  if (claudeHealth.state === "ok") {
    const choice = chooseModel(rawChoice, {
      model: settings.model,
      effort: input.defaultEffort,
    });
    return {
      provider: "claude",
      model: choice.model,
      effort: choice.effort,
      canFallbackToGemini: geminiReady && !isExplicitClaude,
      ...(geminiReady ? { fallbackModelId } : {}),
    };
  }

  // Claude is limited / unauthenticated / error: use Gemini whenever GEMINI_API_KEY is configured!
  if (geminiReady && (!isExplicitClaude || claudeHealth.state !== "limited")) {
    return {
      provider: "gemini",
      alias: fallbackAlias,
      modelId: fallbackModelId,
      effort,
    };
  }

  if (claudeHealth.state === "limited") {
    const choice = chooseModel(rawChoice, {
      model: settings.model,
      effort: input.defaultEffort,
    });
    return {
      provider: "claude",
      model: choice.model,
      effort: choice.effort,
      canFallbackToGemini: geminiReady,
      ...(geminiReady ? { fallbackModelId } : {}),
    };
  }

  throw new Error(claudeHealth.message);
}

export interface CallStructuredAiOptions {
  label: string;
  system: string;
  content: ClaudeContentBlock[];
  schema: object;
  route: StructuredRoute;
  gate: ClaudeGate;
  settings: AgentSettings;
  timeoutMs: number;
  signal: AbortSignal;
  hooks?: GateHooks;
  geminiFetch?: typeof globalThis.fetch;
}

export async function callStructuredAi(
  options: CallStructuredAiOptions,
): Promise<StructuredAiResult> {
  const { route, settings } = options;

  if (route.provider === "gemini") {
    const apiKey = getGeminiApiKey(settings);
    if (!apiKey) {
      throw new GeminiError(
        "auth",
        "GEMINI_API_KEY tanımlı değil: lütfen apps/worker/.env dosyasına GEMINI_API_KEY ekleyin.",
      );
    }
    return callGeminiJson({
      apiKey,
      modelId: route.modelId,
      system: options.system,
      content: options.content,
      schema: options.schema,
      effort: route.effort,
      signal: options.signal,
      ...(options.geminiFetch ? { fetch: options.geminiFetch } : {}),
    });
  }

  try {
    const res = await options.gate.call(
      {
        label: options.label,
        system: options.system,
        content: options.content,
        schema: options.schema,
        model: route.model,
        effort: route.effort,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      },
      // When Gemini fallback is active, don't park on Claude usage limits — fall back immediately!
      route.canFallbackToGemini ? {} : (options.hooks ?? {}),
    );
    return {
      output: res.output,
      text: res.text,
      model: res.model ?? route.model,
      provider: "claude",
      usage: res.usage,
    };
  } catch (error) {
    if (
      route.canFallbackToGemini &&
      route.fallbackModelId &&
      !options.signal.aborted &&
      (error instanceof ClaudeUsageLimitError ||
        (error instanceof ClaudeError && (error.code === "auth" || error.code === "usage_limit")))
    ) {
      const apiKey = getGeminiApiKey(settings);
      if (apiKey) {
        return callGeminiJson({
          apiKey,
          modelId: route.fallbackModelId,
          system: options.system,
          content: options.content,
          schema: options.schema,
          effort: route.effort,
          signal: options.signal,
          ...(options.geminiFetch ? { fetch: options.geminiFetch } : {}),
        });
      }
    }
    throw error;
  }
}
