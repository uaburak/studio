/**
 * Gemini API prices (paid tier, "Standard"), USD per 1M tokens — the one place they live.
 *
 * Source: https://ai.google.dev/gemini-api/docs/pricing (now served at
 * https://aistudio.google.com/docs/pricing), checked on PRICING_CHECKED_AT. Output prices include
 * thinking tokens. Scheduled price changes listed on that page are encoded with `from`
 * (the call's date picks the price). Long-context models charge more when one request's prompt
 * is above `longContext.above` tokens. Check the page again when Google announces new prices,
 * then update the table and the date.
 */

export const PRICING_CHECKED_AT = "2026-11-18";
export const PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";

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

/** Gemini's `usageMetadata` (only the fields the cost needs). */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: { modality?: string; tokenCount?: number }[];
  candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
}

function modalityCount(
  details: { modality?: string; tokenCount?: number }[] | undefined,
  modality: string,
): number {
  return (details ?? [])
    .filter((d) => d.modality?.toUpperCase() === modality)
    .reduce((sum, d) => sum + (d.tokenCount ?? 0), 0);
}

export function sampleFromMetadata(
  model: string,
  meta: GeminiUsageMetadata | undefined,
): GeminiUsageSample {
  return {
    model,
    promptTokens: meta?.promptTokenCount ?? 0,
    cachedTokens: meta?.cachedContentTokenCount ?? 0,
    candidatesTokens: meta?.candidatesTokenCount ?? 0,
    thoughtsTokens: meta?.thoughtsTokenCount ?? 0,
    audioPromptTokens: modalityCount(meta?.promptTokensDetails, "AUDIO"),
    imageOutputTokens: modalityCount(meta?.candidatesTokensDetails, "IMAGE"),
  };
}

function normalize(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
}

/** The price entry for a model at a date, or null when the model is not in the table. */
export function geminiPriceFor(model: string, at: Date = new Date()): GeminiPrice | null {
  const id = normalize(model);
  let best: string | null = null;
  for (const prefix of Object.keys(GEMINI_PRICES)) {
    const matches = id === prefix || id.startsWith(`${prefix}-`);
    if (matches && (!best || prefix.length > best.length)) {
      best = prefix;
    }
  }
  if (!best) return null;
  const day = at.toISOString().slice(0, 10);
  const entries = GEMINI_PRICES[best] ?? [];
  let chosen: GeminiPrice | null = null;
  for (const entry of entries) {
    if (!entry.from || entry.from <= day) chosen = entry;
  }
  return chosen;
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
  return Math.round(usd * 1_000_000_000) / 1_000_000_000;
}
