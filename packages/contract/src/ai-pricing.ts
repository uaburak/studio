/*
 * Prices of the paid AI services Studio calls, in USD — the one place they live. The worker
 * records each call's cost with them (spend, budget); the API can estimate a job's cost before it
 * runs with the same numbers (`aiCallCostUsd`).
 *
 * Every table carries the date it was checked. Check the source pages again when a provider
 * announces new prices, then update the table and its date. A model that is not in a table has no
 * price: its calls are recorded with `costUsd: null` ("fiyatı bilinmeyen çağrı").
 */

// --- Gemini -------------------------------------------------------------------------------------

/**
 * Gemini API prices (paid tier, "Standard"), USD per 1M tokens.
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing (now served at
 * https://aistudio.google.com/docs/pricing), checked on GEMINI_PRICING_CHECKED_AT. Output prices
 * include thinking tokens. Scheduled price changes listed on that page are encoded with `from`
 * (the call's date picks the price). Long-context models charge more when one request's prompt
 * is above `longContext.above` tokens.
 */
export const GEMINI_PRICING_CHECKED_AT = "2026-11-18";
export const GEMINI_PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";

export interface GeminiRates {
  /** Text / image / video input. */
  input: number;
  /** Audio input (defaults to `input`). */
  inputAudio?: number;
  /** Text output, thinking included. */
  output: number;
  /** Image output tokens (image models). */
  outputImage?: number;
  /** Cached input (context caching; storage per hour is not counted). */
  cached?: number;
}

export interface GeminiPrice extends GeminiRates {
  /** A price that applies from this date (YYYY-MM-DD, UTC) on. */
  from?: string;
  /** Prompt above this many tokens: these rates instead. */
  longContext?: { above: number } & GeminiRates;
}

/** Model id prefix -> prices, newest `from` last. The longest matching prefix wins. */
export const GEMINI_PRICES: Record<string, GeminiPrice[]> = {
  "gemini-4-carbon": [
    { input: 2, output: 10, cached: 0.1 },
    { from: "2026-12-01", input: 4, output: 20, cached: 0.2 },
  ],
  "gemini-4-argon": [
    { input: 2, output: 10, cached: 0.1 },
    { from: "2026-12-01", input: 4, output: 20, cached: 0.2 },
  ],
  "gemini-4-hydrogen": [{ input: 1.5, output: 7.5, cached: 0.075 }],
  "gemini-3.8-flash": [
    { input: 0.75, output: 3.75, cached: 0.075 },
    { from: "2027-01-01", input: 1.5, output: 7.5, cached: 0.15 },
  ],
  "gemini-3.8-flash-tts": [
    { input: 0.5, output: 9 },
    { from: "2027-01-01", input: 1, output: 18 },
  ],
  "gemini-3.8-flash-lite-tts": [
    { input: 0.5, output: 6 },
    { from: "2027-01-01", input: 1, output: 12 },
  ],
  "gemini-3.6-flash": [
    { input: 0.75, output: 3.75, cached: 0.075 },
    { from: "2027-01-01", input: 1.5, output: 7.5, cached: 0.15 },
  ],
  "gemini-3.5-flash-lite": [{ input: 0.3, inputAudio: 0.3, output: 2.5, cached: 0.03 }],
  "gemini-3.1-flash-lite": [{ input: 0.25, inputAudio: 0.5, output: 1.5, cached: 0.025 }],
  "gemini-3-flash-preview": [{ input: 0.5, inputAudio: 1, output: 3, cached: 0.05 }],
  "gemini-3.1-pro-preview": [
    {
      input: 2,
      output: 12,
      cached: 0.2,
      longContext: { above: 200_000, input: 4, output: 18, cached: 0.4 },
    },
  ],
  "gemini-2.5-pro": [
    {
      input: 1.25,
      output: 10,
      cached: 0.125,
      longContext: { above: 200_000, input: 2.5, output: 15, cached: 0.25 },
    },
  ],
  "gemini-2.5-flash": [{ input: 0.3, inputAudio: 1, output: 2.5, cached: 0.03 }],
  "gemini-2.5-flash-lite": [{ input: 0.1, inputAudio: 0.3, output: 0.4, cached: 0.01 }],
  // Image generation: image output tokens have their own price.
  "gemini-nano-banana-2.1": [{ input: 1.5, output: 7.5, outputImage: 30 }],
  "gemini-3.1-flash-image": [{ input: 0.5, output: 3, outputImage: 60 }],
  "gemini-3.1-flash-lite-image": [{ input: 0.25, output: 1.5, outputImage: 30 }],
  "gemini-3-pro-image": [{ input: 2, output: 12, outputImage: 120 }],
  "gemini-2.5-flash-image": [{ input: 0.3, output: 2.5, outputImage: 30 }],
};

/** What one Gemini call used (`usageMetadata`). */
export interface GeminiUsageSample {
  /** Model id the service reported (`modelVersion`) or the one requested. */
  model: string;
  /** `promptTokenCount` (cached tokens included). */
  promptTokens: number;
  /** `cachedContentTokenCount`. */
  cachedTokens: number;
  /** `candidatesTokenCount` (thinking excluded). */
  candidatesTokens: number;
  /** `thoughtsTokenCount`. */
  thoughtsTokens: number;
  /** Audio part of the prompt (`promptTokensDetails` modality AUDIO). */
  audioPromptTokens?: number;
  /** Image part of the output (`candidatesTokensDetails` modality IMAGE). */
  imageOutputTokens?: number;
}

function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
}

/**
 * A suffix that names another model, not a version of the same one: `gemini-3.8-flash-lite` is
 * not `gemini-3.8-flash`, `gpt-5-mini` is not `gpt-5`.
 */
const OTHER_MODEL_SUFFIX =
  /^(?:lite|image|tts|live|audio|native|embedding|mini|nano|pro|realtime|transcribe|search|codex|chat)(?:-|$)/;

/** Longest table key that `model` is or starts with (`<key>-…`), else null. */
function longestPrefix(table: Record<string, unknown>, model: string): string | null {
  const id = normalizeModel(model);
  let best: string | null = null;
  for (const prefix of Object.keys(table)) {
    const matches =
      id === prefix ||
      (id.startsWith(`${prefix}-`) && !OTHER_MODEL_SUFFIX.test(id.slice(prefix.length + 1)));
    if (matches && (!best || prefix.length > best.length)) best = prefix;
  }
  return best;
}

/** The entry of a dated list that applies at `at` (the last one whose `from` passed). */
function datedEntry<T extends { from?: string }>(entries: readonly T[], at: Date): T | null {
  const day = at.toISOString().slice(0, 10);
  let chosen: T | null = null;
  for (const entry of entries) {
    if (!entry.from || entry.from <= day) chosen = entry;
  }
  return chosen;
}

/** The price entry for a model at a date, or null when the model is not in the table. */
export function geminiPriceFor(model: string, at: Date = new Date()): GeminiPrice | null {
  const key = longestPrefix(GEMINI_PRICES, model);
  return key ? datedEntry(GEMINI_PRICES[key] ?? [], at) : null;
}

/** USD for one call, or null when the model has no price. */
export function geminiCostUsd(sample: GeminiUsageSample, at: Date = new Date()): number | null {
  const price = geminiPriceFor(sample.model, at);
  if (!price) return null;
  const rates: GeminiRates =
    price.longContext && sample.promptTokens > price.longContext.above ? price.longContext : price;
  const cached = Math.min(sample.cachedTokens, sample.promptTokens);
  const audio = Math.min(sample.audioPromptTokens ?? 0, sample.promptTokens - cached);
  const textIn = Math.max(0, sample.promptTokens - cached - audio);
  const imageOut = rates.outputImage
    ? Math.min(sample.imageOutputTokens ?? 0, sample.candidatesTokens)
    : 0;
  const textOut = sample.candidatesTokens - imageOut + sample.thoughtsTokens;
  const usd =
    (textIn * rates.input +
      audio * (rates.inputAudio ?? rates.input) +
      cached * (rates.cached ?? rates.input) +
      textOut * rates.output +
      imageOut * (rates.outputImage ?? rates.output)) /
    1_000_000;
  return roundCost(usd);
}

// --- OpenAI -------------------------------------------------------------------------------------

/**
 * OpenAI API prices (Standard tier, Responses API), USD per 1M tokens. Reasoning tokens are billed
 * as output. Source: https://openai.com/api/pricing/, checked on OPENAI_PRICING_CHECKED_AT for
 * the models listed. Newer models (the gpt-6 family, gpt-5.5, gpt-5.6) are not listed yet: their
 * calls are recorded unpriced until their prices are added here.
 */
export const OPENAI_PRICING_CHECKED_AT = "2026-11-18";
export const OPENAI_PRICING_SOURCE = "https://openai.com/api/pricing/";

export interface OpenAiPrice {
  from?: string;
  input: number;
  /** Cached input. */
  cached?: number;
  output: number;
}

export const OPENAI_PRICES: Record<string, OpenAiPrice[]> = {
  "gpt-5.2": [{ input: 1.75, cached: 0.175, output: 14 }],
  "gpt-5.1": [{ input: 1.25, cached: 0.125, output: 10 }],
  "gpt-5": [{ input: 1.25, cached: 0.125, output: 10 }],
  "gpt-5-mini": [{ input: 0.25, cached: 0.025, output: 2 }],
  "gpt-5-nano": [{ input: 0.05, cached: 0.005, output: 0.4 }],
  "gpt-4.1": [{ input: 2, cached: 0.5, output: 8 }],
  "gpt-4.1-mini": [{ input: 0.4, cached: 0.1, output: 1.6 }],
  "gpt-4.1-nano": [{ input: 0.1, cached: 0.025, output: 0.4 }],
  "gpt-4o": [{ input: 2.5, cached: 1.25, output: 10 }],
  "gpt-4o-mini": [{ input: 0.15, cached: 0.075, output: 0.6 }],
  o3: [{ input: 2, cached: 0.5, output: 8 }],
  "o4-mini": [{ input: 1.1, cached: 0.275, output: 4.4 }],
};

export interface OpenAiUsageSample {
  model: string;
  /** `input_tokens` (cached included). */
  inputTokens: number;
  /** `input_tokens_details.cached_tokens`. */
  cachedTokens: number;
  /** `output_tokens` (reasoning included). */
  outputTokens: number;
  /** `output_tokens_details.reasoning_tokens` (already in `outputTokens`; informational). */
  reasoningTokens?: number;
}

export function openAiPriceFor(model: string, at: Date = new Date()): OpenAiPrice | null {
  const key = longestPrefix(OPENAI_PRICES, model);
  return key ? datedEntry(OPENAI_PRICES[key] ?? [], at) : null;
}

/** USD for one Responses API request, or null when the model has no price. */
export function openAiCostUsd(sample: OpenAiUsageSample, at: Date = new Date()): number | null {
  const price = openAiPriceFor(sample.model, at);
  if (!price) return null;
  const cached = Math.min(sample.cachedTokens, sample.inputTokens);
  const usd =
    ((sample.inputTokens - cached) * price.input +
      cached * (price.cached ?? price.input) +
      sample.outputTokens * price.output) /
    1_000_000;
  return roundCost(usd);
}

// --- ElevenLabs ---------------------------------------------------------------------------------

/**
 * ElevenLabs text-to-speech, USD per 1,000 characters. ElevenLabs bills credits from a monthly
 * plan; these are the Creator plan's extra-credit price (1 credit per character for Multilingual
 * v2 / v3, half for Flash / Turbo) — an upper estimate of what a call costs. Source:
 * https://elevenlabs.io/pricing/api, checked on ELEVENLABS_PRICING_CHECKED_AT.
 */
export const ELEVENLABS_PRICING_CHECKED_AT = "2026-11-18";
export const ELEVENLABS_PRICING_SOURCE = "https://elevenlabs.io/pricing/api";

export interface CharacterPrice {
  from?: string;
  /** USD per 1,000 characters. */
  per1kChars: number;
}

export const ELEVENLABS_PRICES: Record<string, CharacterPrice[]> = {
  eleven_multilingual_v2: [{ per1kChars: 0.3 }],
  eleven_v3: [{ per1kChars: 0.3 }],
  eleven_flash_v2_5: [{ per1kChars: 0.15 }],
  eleven_turbo_v2_5: [{ per1kChars: 0.15 }],
};

export function elevenLabsCostUsd(
  model: string,
  characters: number,
  at: Date = new Date(),
): number | null {
  const key = longestPrefix(ELEVENLABS_PRICES, model);
  const price = key ? datedEntry(ELEVENLABS_PRICES[key] ?? [], at) : null;
  if (!price) return null;
  return roundCost((Math.max(0, characters) * price.per1kChars) / 1_000);
}

// --- one helper for estimates --------------------------------------------------------------------

/** One planned or finished call, for `aiCallCostUsd`. */
export interface AiCallEstimate {
  provider: "gemini" | "openai" | "elevenlabs" | "claude" | "codex" | "antigravity";
  model: string;
  /** Prompt tokens (cached included); characters for ElevenLabs. */
  inputTokens: number;
  outputTokens?: number;
  cachedTokens?: number;
  /** Gemini thinking tokens (billed as output). */
  thoughtsTokens?: number;
  /** Gemini image models: image output tokens (≈ 1,290 per 1K image, 1,120 per 2K…). */
  imageOutputTokens?: number;
}

/**
 * USD of one call from the tables above; null when the model has no price. Claude (the Mac's
 * subscription), Codex (a ChatGPT sign-in) and Antigravity (a Google sign-in) are not billed per
 * call: 0.
 */
export function aiCallCostUsd(call: AiCallEstimate, at: Date = new Date()): number | null {
  switch (call.provider) {
    case "gemini":
      return geminiCostUsd(
        {
          model: call.model,
          promptTokens: call.inputTokens,
          cachedTokens: call.cachedTokens ?? 0,
          candidatesTokens: (call.outputTokens ?? 0) + (call.imageOutputTokens ?? 0),
          thoughtsTokens: call.thoughtsTokens ?? 0,
          imageOutputTokens: call.imageOutputTokens ?? 0,
        },
        at,
      );
    case "openai":
      return openAiCostUsd(
        {
          model: call.model,
          inputTokens: call.inputTokens,
          cachedTokens: call.cachedTokens ?? 0,
          outputTokens: call.outputTokens ?? 0,
        },
        at,
      );
    case "elevenlabs":
      return elevenLabsCostUsd(call.model, call.inputTokens, at);
    default:
      return 0;
  }
}

function roundCost(usd: number): number {
  return Math.round(usd * 1_000_000_000) / 1_000_000_000;
}
