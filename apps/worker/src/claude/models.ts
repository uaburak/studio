/**
 * Model and effort per run: the user picks a model family and an effort for a chat
 * turn or a generation (`run.model` / `run.effort`, `content.generate` payload
 * `model` / `effort`). They map 1:1 to the CLI's `--model <alias>` and `--effort <level>`.
 * Precedence: the run / job > worker env (STUDIO_CLAUDE_MODEL, STUDIO_CLAUDE_EFFORT_*) > opus / medium.
 */
import { z } from "zod";

export const MODEL_ALIASES = ["opus", "sonnet", "haiku"] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];
/** What the app offers; the CLI also accepts `max`. */
export const EFFORTS = ["low", "medium", "high", "xhigh"] as const;
export type Effort = (typeof EFFORTS)[number] | "max";

export const DEFAULT_MODEL: ModelAlias = "opus";
export const DEFAULT_EFFORT: Effort = "medium";

const Alias = z.enum(MODEL_ALIASES);
const EffortSchema = z.enum([...EFFORTS, "max"]);

/** Optional `model` / `effort` fields of a run or job payload (read structurally: older contracts lack them). */
export function readChoice(source: unknown): { model?: ModelAlias; effort?: Effort } {
  if (!source || typeof source !== "object") return {};
  const s = source as { model?: unknown; effort?: unknown };
  const model = Alias.safeParse(s.model);
  const effort = EffortSchema.safeParse(s.effort);
  return {
    ...(model.success ? { model: model.data } : {}),
    ...(effort.success ? { effort: effort.data } : {}),
  };
}

export interface ModelChoice {
  /** Passed to `--model`. */
  model: string;
  /** Passed to `--effort`. */
  effort: Effort;
  /** Where the choice came from (for logs and the usage metadata). */
  source: "run" | "settings" | "default";
}

export function chooseModel(
  requested: { model?: ModelAlias; effort?: Effort },
  settings: { model?: string | undefined; effort?: string | undefined },
): ModelChoice {
  const settingsEffort = EffortSchema.safeParse(settings.effort);
  return {
    model: requested.model ?? settings.model ?? DEFAULT_MODEL,
    effort: requested.effort ?? (settingsEffort.success ? settingsEffort.data : DEFAULT_EFFORT),
    source: requested.model || requested.effort ? "run" : settings.model ? "settings" : "default",
  };
}

/** The alias for `AgentRun.model` when the CLI reports a full id (`claude-opus-5-5` -> `opus`). */
export function aliasOf(model: string | undefined): ModelAlias | undefined {
  if (!model) return undefined;
  return MODEL_ALIASES.find((a) => model === a || model.includes(`-${a}-`) || model.includes(a));
}
