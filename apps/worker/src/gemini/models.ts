import { z } from "zod";
import type { Effort } from "../claude/models.ts";
import { GEMINI_PRICES, geminiPriceFor } from "./pricing.ts";

export const GEMINI_MODEL_ALIASES = ["gemini-flash-lite", "gemini-flash", "gemini-pro"] as const;

export type GeminiModelAlias = (typeof GEMINI_MODEL_ALIASES)[number];

/**
 * Static fallback per alias: used when no env override is set and the key's model list (cached
 * by the API at key check, `settings.vault.gemini.models`) is unknown or names no newer priced
 * model of that tier. These ids were confirmed to exist on GEMINI_MODELS_CHECKED_AT; check
 * https://ai.google.dev/gemini-api/docs/models again when Google retires the 2.5 generation.
 */
export const GEMINI_MODELS_CHECKED_AT = "2026-11-18";

export const DEFAULT_GEMINI_MODELS: Record<GeminiModelAlias, string> = {
  "gemini-flash-lite": "gemini-2.5-flash-lite",
  "gemini-flash": "gemini-2.5-flash",
  "gemini-pro": "gemini-2.5-pro",
};

const GeminiAliasSchema = z.enum(GEMINI_MODEL_ALIASES);

export function isGeminiModelAlias(value: unknown): value is GeminiModelAlias {
  return GeminiAliasSchema.safeParse(value).success;
}

/**
 * Model id for an alias from a model table (`settings.geminiModels`, which already resolves
 * env override → key's model list → static fallback), else the static fallback.
 */
export function resolveGeminiModelId(
  alias: GeminiModelAlias,
  overrides?: Partial<Record<GeminiModelAlias, string>>,
): string {
  return overrides?.[alias] ?? DEFAULT_GEMINI_MODELS[alias];
}

type GeminiTier = "flash-lite" | "flash" | "pro";

const ALIAS_TIER: Record<GeminiModelAlias, GeminiTier> = {
  "gemini-flash-lite": "flash-lite",
  "gemini-flash": "flash",
  "gemini-pro": "pro",
};

interface GeminiTextModel {
  id: string;
  version: [number, number];
  tier: GeminiTier;
  preview: boolean;
  /** Pinned (`-001`) or dated preview (`-preview-09-2025`): the plain id is preferred. */
  pinned: boolean;
}

/**
 * Plain text models only: `gemini-<version>-<tier>[-NNN][-preview[-MM-YYYY]]`. TTS, image,
 * live/audio, embedding, `-latest` and other variants never match.
 */
const TEXT_MODEL_ID =
  /^gemini-(\d+)(?:\.(\d+))?-(flash-lite|flash|pro)(-\d{3})?(?:-(preview)(-\d{2}-\d{2,4})?)?$/;

function parseTextModel(raw: string): GeminiTextModel | null {
  const id = raw
    .trim()
    .toLowerCase()
    .replace(/^models\//, "");
  const m = TEXT_MODEL_ID.exec(id);
  if (!m) return null;
  return {
    id,
    version: [Number(m[1]), Number(m[2] ?? 0)],
    tier: m[3] as GeminiTier,
    preview: m[5] === "preview",
    pinned: Boolean(m[4] || m[6]),
  };
}

/**
 * True when the price table has an entry for exactly this model's tier (the table's longest
 * matching prefix must be the same tier: `gemini-3.8-flash` must not price `gemini-3.8-flash-lite`),
 * so its calls are recorded with a cost.
 */
function hasTierPrice(model: GeminiTextModel): boolean {
  let best: string | null = null;
  for (const key of Object.keys(GEMINI_PRICES)) {
    if ((model.id === key || model.id.startsWith(`${key}-`)) && (!best || key.length > best.length))
      best = key;
  }
  if (!best || parseTextModel(best)?.tier !== model.tier) return false;
  return geminiPriceFor(model.id) !== null;
}

function compareCandidates(a: GeminiTextModel, b: GeminiTextModel): number {
  // Newest generation first, then stable before preview within it: Google closes older stable
  // models to new keys (2.5 Pro was "no longer available to new users" while 3.1 Pro was still
  // a preview), so a stable-first order could pick a model the key cannot call.
  if (a.version[0] !== b.version[0]) return b.version[0] - a.version[0];
  if (a.version[1] !== b.version[1]) return b.version[1] - a.version[1];
  if (a.preview !== b.preview) return a.preview ? 1 : -1;
  if (a.pinned !== b.pinned) return a.pinned ? 1 : -1;
  return a.id.localeCompare(b.id);
}

/**
 * The newest model of an alias's tier that the key lists and the price table knows, stable
 * (non-preview) models first; undefined when the list names none.
 */
export function pickGeminiModel(
  alias: GeminiModelAlias,
  available: readonly string[] | undefined,
): string | undefined {
  const tier = ALIAS_TIER[alias];
  const candidates: GeminiTextModel[] = [];
  for (const raw of available ?? []) {
    const model = parseTextModel(raw);
    if (model && model.tier === tier && hasTierPrice(model)) candidates.push(model);
  }
  return candidates.sort(compareCandidates)[0]?.id;
}

/** Env override → newest priced model of the tier in the key's list → static fallback. */
export function resolveGeminiModel(
  alias: GeminiModelAlias,
  source: {
    overrides?: Partial<Record<GeminiModelAlias, string>>;
    available?: readonly string[] | undefined;
  },
): string {
  return (
    source.overrides?.[alias] ??
    pickGeminiModel(alias, source.available) ??
    DEFAULT_GEMINI_MODELS[alias]
  );
}

/**
 * The model table the handlers read (`settings.geminiModels`): each alias resolves live with
 * `resolveGeminiModel`, so a key change (new model list) applies without a restart. Assigning
 * an alias sets an override.
 */
export function liveGeminiModels(
  overrides: Partial<Record<GeminiModelAlias, string>>,
  available: () => readonly string[] | undefined,
): Record<GeminiModelAlias, string> {
  let memoList: readonly string[] | undefined;
  let memo: Partial<Record<GeminiModelAlias, string | undefined>> = {};
  const picked = (alias: GeminiModelAlias): string | undefined => {
    const list = available();
    if (list !== memoList) {
      memoList = list;
      memo = {};
    }
    if (!(alias in memo)) memo[alias] = pickGeminiModel(alias, list);
    return memo[alias];
  };
  const table = {} as Record<GeminiModelAlias, string>;
  for (const alias of GEMINI_MODEL_ALIASES) {
    Object.defineProperty(table, alias, {
      enumerable: true,
      get: () => overrides[alias] ?? picked(alias) ?? DEFAULT_GEMINI_MODELS[alias],
      set: (value: string) => {
        overrides[alias] = value;
      },
    });
  }
  return table;
}

/** Gemini 3+ `thinkingLevel` values Studio sends (documented for that generation). */
export type GeminiThinkingLevel = "low" | "medium" | "high";

export type GeminiThinkingConfig =
  | { thinkingBudget: number }
  | { thinkingLevel: GeminiThinkingLevel };

/**
 * Map Studio `effort` to Gemini `thinkingConfig`; undefined leaves the model's default.
 * - Gemini 2.5 (`thinkingBudget`): `gemini-2.5-pro` requires `>= 128`; `gemini-2.5-flash` and
 *   `gemini-2.5-flash-lite` accept `0..24576`.
 * - Gemini 3 and newer (`thinkingLevel`): `low` / `high` for every model, `medium` only on Flash
 *   and Flash-Lite (Pro documents low and high only). A budget is not sent with a level.
 */
export function thinkingConfigFor(
  modelId: string,
  effort: Effort | undefined,
): GeminiThinkingConfig | undefined {
  const version = /gemini-(\d+)(?:\.(\d+))?-/i.exec(modelId);
  if (!version) return undefined;
  const major = Number(version[1]);
  const minor = Number(version[2] ?? 0);
  if (/-(?:image|tts|audio|live|embedding)/i.test(modelId)) return undefined;
  const level = effort ?? "medium";

  if (major >= 3) {
    const isFlash = /-flash(?:-|$)/i.test(modelId);
    switch (level) {
      case "low":
        return { thinkingLevel: "low" };
      case "medium":
        return { thinkingLevel: isFlash ? "medium" : "low" };
      case "high":
      case "xhigh":
      case "max":
        return { thinkingLevel: "high" };
    }
  }

  if (major !== 2 || minor !== 5) return undefined;
  const isPro = /-pro(?:-|$)/i.test(modelId);
  switch (level) {
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
