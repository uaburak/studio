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

/** One paid AI call, as the worker reports it. */
export const AiUsageRecordInput = z
  .object({
    provider: AiProvider,
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

export const AiSpendModel = AiSpendTotals.extend({ model: z.string() }).meta({
  id: "AiSpendModel",
});
export type AiSpendModel = z.infer<typeof AiSpendModel>;

/** The owner's monthly budget and what is left of it (all null without a budget). */
export const AiBudget = z
  .object({
    monthlyUsd: z.number().min(0).nullable(),
    remainingUsd: z.number().nullable(),
    usedPercent: z.number().min(0).nullable(),
    /** True from 80 % of the budget on. */
    warning: z.boolean(),
  })
  .meta({ id: "AiBudget" });
export type AiBudget = z.infer<typeof AiBudget>;

/** Gemini AI Studio billing (there is no balance endpoint; the owner checks it there). */
export const GEMINI_BILLING_URL = "https://aistudio.google.com/usage";

/** `GET /api/ai/spend`: Gemini API spend today, this month and per model (this month). */
export const AiSpendSummary = z
  .object({
    provider: AiProvider,
    currency: z.literal("USD"),
    today: AiSpendTotals,
    month: AiSpendTotals,
    /** This month, most expensive first. */
    byModel: z.array(AiSpendModel),
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

/** `PUT /api/ai/budget`: null removes the budget. */
export const AiBudgetPut = z
  .object({
    geminiMonthlyUsd: z.number().min(0).max(1_000_000).nullable(),
    tzOffset: z.number().int().min(-840).max(840).default(0),
  })
  .meta({ id: "AiBudgetPut" });
export type AiBudgetPut = z.input<typeof AiBudgetPut>;
