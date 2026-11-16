import { z } from "zod";
import type { Effort } from "../claude/models.ts";

export const GEMINI_MODEL_ALIASES = ["gemini-flash-lite", "gemini-flash", "gemini-pro"] as const;

export type GeminiModelAlias = (typeof GEMINI_MODEL_ALIASES)[number];

export const DEFAULT_GEMINI_MODELS: Record<GeminiModelAlias, string> = {
  "gemini-flash-lite": "gemini-2.5-flash-lite",
  "gemini-flash": "gemini-2.5-flash",
  "gemini-pro": "gemini-2.5-pro",
};

const GeminiAliasSchema = z.enum(GEMINI_MODEL_ALIASES);

export function isGeminiModelAlias(value: unknown): value is GeminiModelAlias {
  return GeminiAliasSchema.safeParse(value).success;
}

export function resolveGeminiModelId(
  alias: GeminiModelAlias,
  overrides?: Partial<Record<GeminiModelAlias, string>>,
): string {
  return overrides?.[alias] ?? DEFAULT_GEMINI_MODELS[alias];
}

/**
 * Map Studio `effort` to Gemini 2.5 `thinkingConfig`.
 * - `gemini-2.5-pro` requires `thinkingBudget >= 128`.
 * - `gemini-2.5-flash` and `gemini-2.5-flash-lite` accept `0..24576`.
 */
export function thinkingConfigFor(
  modelId: string,
  effort: Effort | undefined,
): { thinkingBudget: number } | undefined {
  if (!/gemini-2\.5/i.test(modelId)) return undefined;
  const isPro = /pro/i.test(modelId);
  switch (effort ?? "medium") {
    case "low":
      return { thinkingBudget: isPro ? 1024 : 0 };
    case "medium":
      return { thinkingBudget: isPro ? 4096 : 2048 };
    case "high":
      return { thinkingBudget: isPro ? 12288 : 8192 };
    case "xhigh":
    case "max":
      return { thinkingBudget: isPro ? 24576 : 16384 };
  }
}
