import { z } from "zod";
import { EntityId, Timestamp } from "./common.ts";

/*
 * AI providers on the Mac (roadmap 7) and Gemini spend (roadmap 11).
 *
 * - Keys: the owner types a Gemini / OpenAI API key in Ayarlar → Yapay zekâ. The API seals it
 *   with the token vault (AES-GCM, the per-install key) and only the worker ever reads the
 *   plaintext (`GET /api/worker/ai/credentials`). The worker prefers a stored key over its
 *   `.env` (`GEMINI_API_KEY`), which stays as the fallback. Apps see `hint` (last 4 characters).
 * - Providers: Claude and Gemini keep their own presence fields (`claude`, `gemini`); the
 *   others (Codex CLI, OpenAI API, Antigravity CLI) arrive as presence `providers`.
 * - Spend: the worker records every paid Gemini call (tokens + cost from its pricing table);
 *   `GET /api/ai/spend` sums today / this month / per model and compares with the budget.
 */

/** AI providers Studio knows (clients must tolerate values they do not know). */
export const AiProvider = z
  .enum(["claude", "gemini", "codex", "openai", "antigravity"])
  .meta({ id: "AiProvider" });
export type AiProvider = z.infer<typeof AiProvider>;

/** Providers whose API key the app can keep in the vault. */
export const AiKeyProvider = z.enum(["gemini", "openai"]).meta({ id: "AiKeyProvider" });
export type AiKeyProvider = z.infer<typeof AiKeyProvider>;

// --- stored API keys ---------------------------------------------------------------------------

/** A stored key as the apps see it (never the key itself). */
export const AiKeyState = z
  .object({
    provider: AiKeyProvider,
    configured: z.boolean(),
    /** Last 4 characters ("…a1B2"); null when not configured. */
    hint: z.string().max(16).nullable(),
    /** Result of the last check (models.list); null = never checked or the service was unreachable. */
    valid: z.boolean().nullable(),
    checkedAt: Timestamp.nullable(),
    /** Turkish one-liner about the last check. */
    detail: z.string().max(500).nullable(),
    /** Model ids the key could list at the last check (at most 300). */
    models: z.array(z.string().max(128)).max(300),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: "AiKeyState" });
export type AiKeyState = z.infer<typeof AiKeyState>;

/** `GET /api/ai/keys`: one entry per `AiKeyProvider`. */
export const AiKeyList = z
  .object({
    items: z.array(AiKeyState),
    /** False when the vault key is missing (keys cannot be stored). */
    vaultReady: z.boolean(),
  })
  .meta({ id: "AiKeyList" });
export type AiKeyList = z.infer<typeof AiKeyList>;

/** `PUT /api/ai/keys/{provider}` (the Mac itself only). The key is checked before it is saved. */
export const AiKeyPut = z
  .object({
    key: z
      .string()
      .trim()
      .min(10)
      .max(512)
      .regex(/^[\x21-\x7e]+$/, "the key has spaces or unexpected characters"),
  })
  .meta({ id: "AiKeyPut" });
export type AiKeyPut = z.input<typeof AiKeyPut>;

export const AiKeyProviderParam = z.object({ provider: AiKeyProvider });

/** One plaintext key for the worker, with the models it listed at the last check. */
export const WorkerAiKey = z
  .object({ apiKey: z.string().min(1), models: z.array(z.string()) })
  .meta({ id: "WorkerAiKey" });
export type WorkerAiKey = z.infer<typeof WorkerAiKey>;

/** `GET /api/worker/ai/credentials` (worker token only). */
export const WorkerAiCredentials = z
  .object({
    gemini: WorkerAiKey.nullable(),
    openai: WorkerAiKey.nullable(),
  })
  .meta({ id: "WorkerAiCredentials" });
export type WorkerAiCredentials = z.infer<typeof WorkerAiCredentials>;

// --- provider readiness (presence `providers`) ---------------------------------------------------

export const AiProviderState = z
  .enum(["ready", "signed_out", "signing_in", "not_installed", "not_configured", "error"])
  .meta({ id: "AiProviderState" });
export type AiProviderState = z.infer<typeof AiProviderState>;

/** One provider as the worker last saw it (Codex CLI, OpenAI API, Antigravity CLI). */
export const AiProviderStatus = z
  .object({
    provider: AiProvider,
    state: AiProviderState,
    /** How it is signed in, in Turkish ("ChatGPT hesabı", "API anahtarı", "Google hesabı"). */
    account: z.string().max(200).nullable(),
    cliVersion: z.string().max(64).nullable(),
    /** Model id the worker uses for it by default, when known. */
    defaultModel: z.string().max(128).nullable(),
    /** Model ids the provider offers on this Mac (informational, at most 100). */
    models: z.array(z.string().max(128)).max(100),
    /** While signing in: the sign-in page (the browser normally opens by itself). */
    loginUrl: z.string().max(2_000).nullable(),
    /** True when chat turns can use Studio's tools (plans, posts, scheduling) with it. */
    tools: z.boolean(),
    /** Turkish one-liner: what is missing, or what it uses. */
    detail: z.string().max(500).nullable(),
    checkedAt: Timestamp,
  })
  .meta({ id: "AiProviderStatus" });
export type AiProviderStatus = z.infer<typeof AiProviderStatus>;

/** `GET /api/workers/providers` and the answer of its commands. */
export const AiProvidersControl = z
  .object({
    providers: z.array(AiProviderStatus),
    online: z.boolean(),
    /** Workers the command was sent to (0 for GET). */
    sent: z.number().int().min(0),
  })
  .meta({ id: "AiProvidersControl" });
export type AiProvidersControl = z.infer<typeof AiProvidersControl>;

// --- spend --------------------------------------------------------------------------------------

/**
 * Services whose calls cost money and are recorded in the spend store: the AI providers plus
 * ElevenLabs (voice-over). Clients must tolerate values they do not know.
 */
export const AiSpendProvider = z
  .enum(["claude", "gemini", "codex", "openai", "antigravity", "elevenlabs"])
  .meta({ id: "AiSpendProvider" });
export type AiSpendProvider = z.infer<typeof AiSpendProvider>;

/** One paid AI call, as the worker reports it. */
export const AiUsageRecordInput = z
  .object({
    /** `elevenlabs` records characters as `inputTokens`. */
    provider: AiSpendProvider,
    /** Model id the service reported (e.g. `gemini-2.5-flash`). */
    model: z.string().trim().min(1).max(128),
    /** What the call was for: chat | generate | brand | image | transcribe | reel | other. */
    kind: z.string().trim().min(1).max(32),
    jobId: EntityId.nullable().default(null),
    runId: EntityId.nullable().default(null),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    thoughtsTokens: z.number().int().min(0).default(0),
    cachedTokens: z.number().int().min(0).default(0),
    /** USD from the worker's pricing table; null when the model is not in it. */
    costUsd: z.number().min(0).max(100_000).nullable(),
    /** Date the pricing table was checked (YYYY-MM-DD). */
    pricingVersion: z.string().max(32).nullable().default(null),
    occurredAt: Timestamp,
  })
  .meta({ id: "AiUsageRecordInput" });
export type AiUsageRecordInput = z.input<typeof AiUsageRecordInput>;

/** `POST /api/worker/ai/usage` (worker token only). */
export const WorkerAiUsageReport = z
  .object({ records: z.array(AiUsageRecordInput).min(1).max(100) })
  .meta({ id: "WorkerAiUsageReport" });
export type WorkerAiUsageReport = z.input<typeof WorkerAiUsageReport>;

export const WorkerAiUsageAck = z
  .object({ stored: z.number().int().min(0) })
  .meta({ id: "WorkerAiUsageAck" });
export type WorkerAiUsageAck = z.infer<typeof WorkerAiUsageAck>;

export const AiSpendTotals = z
  .object({
    costUsd: z.number().min(0),
    calls: z.number().int().min(0),
    /** Calls whose model has no price in the worker's table (not in `costUsd`). */
    unpricedCalls: z.number().int().min(0),
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    thoughtsTokens: z.number().int().min(0),
  })
  .meta({ id: "AiSpendTotals" });
export type AiSpendTotals = z.infer<typeof AiSpendTotals>;

export const AiSpendModel = AiSpendTotals.extend({
  model: z.string(),
  /** Absent from older APIs (Gemini only then). */
  provider: AiSpendProvider.optional(),
}).meta({
  id: "AiSpendModel",
});
export type AiSpendModel = z.infer<typeof AiSpendModel>;

/** This month's spend of one paid service. */
export const AiSpendProviderTotals = AiSpendTotals.extend({ provider: AiSpendProvider }).meta({
  id: "AiSpendProviderTotals",
});
export type AiSpendProviderTotals = z.infer<typeof AiSpendProviderTotals>;

/** The owner's monthly budget and what is left of it (all null without a budget). */
export const AiBudget = z
  .object({
    monthlyUsd: z.number().min(0).nullable(),
    remainingUsd: z.number().nullable(),
    usedPercent: z.number().min(0).nullable(),
    /** True from 80 % of the budget on. */
    warning: z.boolean(),
    /** Paid calls are refused once the month's spend reached the budget (S7). Absent from older APIs. */
    stopAtBudget: z.boolean().optional(),
    /** True when `stopAtBudget` is on and the budget is used up: paid calls are refused. */
    exhausted: z.boolean().optional(),
  })
  .meta({ id: "AiBudget" });
export type AiBudget = z.infer<typeof AiBudget>;

/** Gemini AI Studio billing (there is no balance endpoint; the owner checks it there). */
export const GEMINI_BILLING_URL = "https://aistudio.google.com/usage";

/**
 * `GET /api/ai/spend`: paid AI spend (Gemini, OpenAI, ElevenLabs) today, this month, per model and
 * per service (this month). The budget covers all of them.
 */
export const AiSpendSummary = z
  .object({
    /** Kept for older clients (always `gemini`); the totals cover every paid service (`byProvider`). */
    provider: AiProvider,
    currency: z.literal("USD"),
    today: AiSpendTotals,
    month: AiSpendTotals,
    /** This month, most expensive first. */
    byModel: z.array(AiSpendModel),
    /** This month per paid service, most expensive first (absent from older APIs). */
    byProvider: z.array(AiSpendProviderTotals).optional(),
    budget: AiBudget,
    /** Remaining prepaid credit. The Gemini API has no balance endpoint: `known` is false. */
    balance: z.object({
      known: z.boolean(),
      remainingUsd: z.number().nullable(),
      billingUrl: z.string(),
    }),
    /** Pricing table date of the latest recorded call. */
    pricingVersion: z.string().nullable(),
    /** Start of "today" and of "this month" in the caller's time zone (UTC timestamps). */
    dayStart: Timestamp,
    monthStart: Timestamp,
  })
  .meta({ id: "AiSpendSummary" });
export type AiSpendSummary = z.infer<typeof AiSpendSummary>;

/** `tzOffset`: the caller's `Date#getTimezoneOffset()` in minutes (Istanbul: -180). */
export const AiSpendQuery = z.object({
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
});
export type AiSpendQuery = z.input<typeof AiSpendQuery>;

/**
 * `PUT /api/ai/budget`: the monthly budget of every paid AI service (the field keeps its old
 * name); null removes the budget.
 */
export const AiBudgetPut = z
  .object({
    geminiMonthlyUsd: z.number().min(0).max(1_000_000).nullable(),
    tzOffset: z.number().int().min(-840).max(840).default(0),
  })
  .meta({ id: "AiBudgetPut" });
export type AiBudgetPut = z.input<typeof AiBudgetPut>;

// --- preferences (S7) ---------------------------------------------------------------------------

/**
 * What happens when Claude's usage window is used up (S7, Ayarlar → Yapay zekâ):
 * - `ask` (default): the work pauses and the owner chooses "Gemini ile devam et" or "Sınırı bekle"
 *   (a consent card in the chat; for jobs presence `claude.limit` and
 *   `POST /api/ai/claude-limit/decision`);
 * - `gemini`: it goes on with Gemini at once (when a Gemini key is ready), with a visible note on
 *   the message / the post's version ("Claude sınırı doldu, Gemini Flash ile üretildi");
 * - `wait`: it waits for the reset and shows when it goes on.
 * A Claude model the owner picked by name is never replaced: it always waits.
 */
export const ClaudeLimitMode = z.enum(["ask", "gemini", "wait"]).meta({ id: "ClaudeLimitMode" });
export type ClaudeLimitMode = z.infer<typeof ClaudeLimitMode>;

export const DEFAULT_CLAUDE_LIMIT_MODE: ClaudeLimitMode = "ask";

export const ClaudeLimitChoice = z.enum(["gemini", "wait"]).meta({ id: "ClaudeLimitChoice" });
export type ClaudeLimitChoice = z.infer<typeof ClaudeLimitChoice>;

/** The owner's answer while Claude is at its limit (`ask`); it holds until `until` (the reset). */
export const ClaudeLimitDecision = z
  .object({
    choice: ClaudeLimitChoice,
    until: Timestamp,
    decidedAt: Timestamp,
  })
  .meta({ id: "ClaudeLimitDecision" });
export type ClaudeLimitDecision = z.infer<typeof ClaudeLimitDecision>;

/** `GET /api/ai/preferences`. */
export const AiPreferences = z
  .object({
    claudeLimit: ClaudeLimitMode,
    /** Monthly budget of the paid AI calls (Gemini, OpenAI, ElevenLabs) in USD; null = none. */
    monthlyBudgetUsd: z.number().min(0).nullable(),
    /** Refuse paid calls once this month's spend reached the budget ("bütçe dolunca dur"). */
    stopAtBudget: z.boolean(),
    /** The answer for the current Claude limit window (`ask`); null when none holds now. */
    limitDecision: ClaudeLimitDecision.nullable(),
    /**
     * N12: also describe each new picture with the AI (Gemini, paid; within the budget). Off by
     * default (absent from older servers = off); tags, text and colours are read on the Mac for
     * free either way.
     */
    mediaCaptions: z.boolean().optional(),
    updatedAt: Timestamp.nullable(),
  })
  .meta({ id: "AiPreferences" });
export type AiPreferences = z.infer<typeof AiPreferences>;

/** `PUT /api/ai/preferences` (Mac only): only the fields sent change. */
export const AiPreferencesPut = z
  .object({
    claudeLimit: ClaudeLimitMode.optional(),
    monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
    stopAtBudget: z.boolean().optional(),
    mediaCaptions: z.boolean().optional(),
  })
  .meta({ id: "AiPreferencesPut" });
export type AiPreferencesPut = z.input<typeof AiPreferencesPut>;

/** `POST /api/ai/claude-limit/decision` (Mac only): answers presence `claude.limit`. */
export const ClaudeLimitDecisionCreate = z
  .object({
    choice: ClaudeLimitChoice,
    /**
     * Until when the answer holds (the reset). Default: presence `claude.limit.resetsAt`, else
     * five hours from now.
     */
    until: Timestamp.optional(),
  })
  .meta({ id: "ClaudeLimitDecisionCreate" });
export type ClaudeLimitDecisionCreate = z.input<typeof ClaudeLimitDecisionCreate>;

/** `GET /api/worker/ai/settings` (worker token only): what the worker enforces. */
export const WorkerAiSettings = z
  .object({
    claudeLimit: ClaudeLimitMode,
    /** The answer that holds now (null: none, or it expired). */
    limitDecision: ClaudeLimitDecision.nullable(),
    budget: z.object({
      monthlyUsd: z.number().min(0).nullable(),
      stopAtBudget: z.boolean(),
      /** Recorded spend of this month (every paid service) when read. */
      spentUsd: z.number().min(0),
      /** Start of the month in the worker's time zone (`tzOffset`). */
      monthStart: Timestamp,
    }),
    /** N12: describe new pictures with the AI (see `AiPreferences.mediaCaptions`; absent = off). */
    mediaCaptions: z.boolean().optional(),
  })
  .meta({ id: "WorkerAiSettings" });
export type WorkerAiSettings = z.infer<typeof WorkerAiSettings>;

export const WorkerAiSettingsQuery = z.object({
  tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
});
export type WorkerAiSettingsQuery = z.input<typeof WorkerAiSettingsQuery>;
