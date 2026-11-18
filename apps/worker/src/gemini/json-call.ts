/**
 * Direct Gemini REST API structured JSON caller (`v1beta` `generateContent`)
 * and unified Claude/Gemini structured AI router for `content.generate`,
 * `brand.analyze`, and the Reels video engine.
 */
import type { AgentSettings } from "../agent.ts";
import { assertSinkBudget } from "../ai/usage-recorder.ts";
import { ClaudeError, ClaudeUsageLimitError } from "../claude/errors.ts";
import {
  abortableSleep,
  type ClaudeGate,
  type GateHooks,
  type LimitChoice,
} from "../claude/gate.ts";
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
import { type GeminiUsageMetadata, type GeminiUsageSample, sampleFromMetadata } from "./pricing.ts";
import { GEMINI_RATE_LIMIT_TRIES, rateLimitDelayMs } from "./retry.ts";

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
  /**
   * Called with the call's token counts (spend tracking). A sink from `geminiUsageSink` also
   * checks the monthly budget before each request (S7).
   */
  onUsage?: ((sample: GeminiUsageSample) => void) | undefined;
  /** Tries on HTTP 429 before it is a `rate_limit` error (default 4). */
  rateLimitTries?: number;
}

/** Why a structured call ran on Gemini instead of Claude (shown on the job / version). */
export interface StructuredFallback {
  reason: "claude_limit" | "claude_unavailable";
  /** When Claude's window resets (limit only). */
  resetsAt?: Date | undefined;
}

export interface StructuredAiResult {
  output: unknown;
  text: string;
  model: string;
  provider: "claude" | "gemini";
  usage: ClaudeUsage;
  /** Set when Claude was meant and Gemini answered (S7). */
  fallback?: StructuredFallback;
}

interface GeminiGenerateResponse {
  candidates?: {
    content?: {
      parts?: { text?: string; thought?: boolean }[];
    };
    finishReason?: string;
  }[];
  usageMetadata?: GeminiUsageMetadata;
  modelVersion?: string;
  error?: { code?: number; message?: string; status?: string };
}

function sanitizeSecret(text: string, secret: string): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[REDACTED]");
}

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new GeminiError("output", "Gemini boş JSON yanıtı döndürdü.");
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    try {
      if (fenced?.[1]) {
        return JSON.parse(fenced[1]);
      }
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start !== -1 && end > start) {
        return JSON.parse(trimmed.slice(start, end + 1));
      }
    } catch {
      // falls through to the output error
    }
    throw new GeminiError("output", `Gemini geçerli JSON döndürmedi: ${trimmed.slice(0, 200)}`);
  }
}

export async function callGeminiJson(options: CallGeminiJsonOptions): Promise<StructuredAiResult> {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const sleep = options.sleep ?? abortableSleep;
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new GeminiError("auth", GEMINI_KEY_MISSING);
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
  let rateLimited = 0;

  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    // "Bütçe dolunca dur": no paid request once the month's budget is used up (S7).
    assertSinkBudget(options.onUsage);
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
        // Usually a per-minute quota: wait as long as Google says and repeat (U4).
        const delay = rateLimitDelayMs(res.headers, rawText, rateLimited);
        rateLimited++;
        if (delay !== null && rateLimited < (options.rateLimitTries ?? GEMINI_RATE_LIMIT_TRIES)) {
          await sleep(delay, options.signal);
          continue;
        }
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
        "output",
        `Gemini yapılandırılmış çıktı üretmedi (finishReason=${reason}).`,
      );
    }

    const wallMs = Math.max(1, Date.now() - startedAt);
    const u = body.usageMetadata;
    if (u) {
      try {
        options.onUsage?.(sampleFromMetadata(body.modelVersion ?? options.modelId, u));
      } catch {
        // spend tracking never breaks a call
      }
    }
    const output = extractJsonObject(text);

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
  /**
   * The owner's choice at Claude's limit (S7, `AiPolicy.limitChoice`). Undefined: switch to
   * Gemini at once (the behaviour before S7; tests).
   */
  limitChoice?: LimitChoice | undefined;
}

export type StructuredRoute =
  | {
      provider: "claude";
      model: string;
      effort: Effort;
      canFallbackToGemini: boolean;
      fallbackModelId?: string;
      fallbackAlias?: GeminiModelAlias;
    }
  | {
      provider: "gemini";
      alias: GeminiModelAlias;
      modelId: string;
      effort: Effort;
      /** Claude was meant (not a Gemini model the owner picked): why Gemini answers. */
      fallback?: StructuredFallback;
    };

/** Turkish: no Gemini key anywhere (vault or .env). */
export const GEMINI_KEY_MISSING =
  "Gemini API anahtarı yok: Ayarlar → Yapay zekâ'dan anahtarı girin (ya da .env dosyasına GEMINI_API_KEY ekleyin).";

type KeySettings = Pick<AgentSettings, "parentEnv" | "geminiApiKey" | "vault">;

/** Where the Gemini key comes from: the vault (Ayarlar) wins over `.env`. */
export function geminiKeySource(settings: KeySettings): "vault" | "env" | null {
  if (settings.vault?.gemini?.apiKey.trim()) return "vault";
  const env = (settings.parentEnv.GEMINI_API_KEY ?? settings.geminiApiKey)?.trim();
  return env ? "env" : null;
}

export function hasGeminiApiKey(settings: KeySettings): boolean {
  return geminiKeySource(settings) !== null;
}

/** The Gemini API key: the vault's (Ayarlar → Yapay zekâ) first, else `.env` `GEMINI_API_KEY`. */
export function getGeminiApiKey(settings: KeySettings): string | undefined {
  const vault = settings.vault?.gemini?.apiKey.trim();
  if (vault) return vault;
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
      throw new GeminiError("auth", `Gemini modeli seçildi. ${GEMINI_KEY_MISSING}`);
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
      throw new GeminiError("auth", `Gemini modeli seçildi. ${GEMINI_KEY_MISSING}`);
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

  const claudeRoute = (): StructuredRoute => {
    const choice = chooseModel(rawChoice, {
      model: settings.model,
      effort: input.defaultEffort,
    });
    // A Claude model the owner named is never replaced (it waits at the limit).
    const canFallback = geminiReady && !isExplicitClaude;
    return {
      provider: "claude",
      model: choice.model,
      effort: choice.effort,
      canFallbackToGemini: canFallback,
      ...(canFallback ? { fallbackModelId, fallbackAlias } : {}),
    };
  };

  if (claudeHealth.state === "ok") return claudeRoute();

  if (claudeHealth.state === "limited") {
    // S7: at the limit the owner's choice decides; "ask" / "wait" park the call in the gate,
    // which still switches when the owner answers "Gemini ile devam et".
    const choice = input.limitChoice ?? "gemini";
    if (geminiReady && !isExplicitClaude && choice === "gemini") {
      return {
        provider: "gemini",
        alias: fallbackAlias,
        modelId: fallbackModelId,
        effort,
        fallback: {
          reason: "claude_limit",
          ...(claudeHealth.resetsAt ? { resetsAt: new Date(claudeHealth.resetsAt) } : {}),
        },
      };
    }
    return claudeRoute();
  }

  // Claude is signed out / broken: Gemini whenever a key is configured.
  if (geminiReady) {
    return {
      provider: "gemini",
      alias: fallbackAlias,
      modelId: fallbackModelId,
      effort,
      fallback: { reason: "claude_unavailable" },
    };
  }

  throw new Error(claudeHealth.message);
}

/** Gemini model name for notes ("Gemini Flash"). */
export function geminiAliasLabel(alias: GeminiModelAlias | undefined): string {
  if (alias === "gemini-flash-lite") return "Gemini Flash-Lite";
  if (alias === "gemini-pro") return "Gemini Pro";
  return "Gemini Flash";
}

/** Turkish note for a version / message that Gemini made instead of Claude (S7). */
export function fallbackNote(
  fallback: StructuredFallback,
  alias: GeminiModelAlias | undefined,
): string {
  const model = geminiAliasLabel(alias);
  return fallback.reason === "claude_limit"
    ? `Claude sınırı doldu, ${model} ile üretildi.`
    : `Claude kullanılamadı, ${model} ile üretildi.`;
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
  /** Test seam: Gemini's waits (429 backoff). */
  geminiSleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Gemini calls report their tokens here (spend tracking, budget check). */
  onGeminiUsage?: ((sample: GeminiUsageSample) => void) | undefined;
  /** Claude was meant but Gemini takes over now (show it on the job). */
  onFallback?: (fallback: StructuredFallback) => void | Promise<void>;
}

export async function callStructuredAi(
  options: CallStructuredAiOptions,
): Promise<StructuredAiResult> {
  const { route, settings } = options;

  if (route.provider === "gemini") {
    const apiKey = getGeminiApiKey(settings);
    if (!apiKey) {
      throw new GeminiError("auth", GEMINI_KEY_MISSING);
    }
    const res = await callGeminiJson({
      onUsage: options.onGeminiUsage,
      apiKey,
      modelId: route.modelId,
      system: options.system,
      content: options.content,
      schema: options.schema,
      effort: route.effort,
      signal: options.signal,
      ...(options.geminiFetch ? { fetch: options.geminiFetch } : {}),
      ...(options.geminiSleep ? { sleep: options.geminiSleep } : {}),
    });
    return route.fallback ? { ...res, fallback: route.fallback } : res;
  }

  const canFallback =
    route.canFallbackToGemini && Boolean(route.fallbackModelId) && hasGeminiApiKey(settings);
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
      // At the limit the gate parks (progress via the hooks) or, when the owner's choice is
      // "gemini", hands the call back at once for the switch below (S7, U3).
      { ...(options.hooks ?? {}), fallback: canFallback },
    );
    return {
      output: res.output,
      text: res.text,
      model: res.model ?? route.model,
      provider: "claude",
      usage: res.usage,
    };
  } catch (error) {
    const limit = error instanceof ClaudeUsageLimitError;
    if (
      canFallback &&
      route.fallbackModelId &&
      !options.signal.aborted &&
      (limit ||
        (error instanceof ClaudeError && (error.code === "auth" || error.code === "usage_limit")))
    ) {
      const apiKey = getGeminiApiKey(settings);
      if (apiKey) {
        const fallback: StructuredFallback = limit
          ? { reason: "claude_limit", resetsAt: (error as ClaudeUsageLimitError).resetsAt }
          : { reason: "claude_unavailable" };
        await options.onFallback?.(fallback);
        const res = await callGeminiJson({
          onUsage: options.onGeminiUsage,
          apiKey,
          modelId: route.fallbackModelId,
          system: options.system,
          content: options.content,
          schema: options.schema,
          effort: route.effort,
          signal: options.signal,
          ...(options.geminiFetch ? { fetch: options.geminiFetch } : {}),
          ...(options.geminiSleep ? { sleep: options.geminiSleep } : {}),
        });
        return { ...res, fallback };
      }
    }
    throw error;
  }
}
