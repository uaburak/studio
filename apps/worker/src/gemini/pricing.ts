/**
 * Gemini API prices: the dated tables live in the contract (`@studio/contract` ai-pricing.ts, so
 * the API can estimate costs with the same numbers); this module keeps the worker's names and
 * reads Gemini's `usageMetadata`.
 */
import type { GeminiUsageSample } from "@studio/contract";

export {
  GEMINI_PRICES,
  GEMINI_PRICING_CHECKED_AT as PRICING_CHECKED_AT,
  GEMINI_PRICING_SOURCE as PRICING_SOURCE,
  type GeminiPrice,
  type GeminiRates,
  type GeminiUsageSample,
  geminiCostUsd,
  geminiPriceFor,
} from "@studio/contract";

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
