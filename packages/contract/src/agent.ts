import { z } from "zod";
import { ClaudeLimitChoice, ClaudeLimitMode } from "./ai.ts";
import { EntityId, Timestamp } from "./common.ts";

/*
 * The tool-using chat agent (task A5): its extra message parts, the Claude
 * Code session a conversation keeps, and the Mac's Claude sign-in.
 *
 * - `tool_step` parts show what the agent is doing ("Plan hazırlanıyor…",
 *   then "Plan hazırlandı"). The worker writes one per tool call and replaces
 *   it (same index, same type) when the call ends.
 * - `consent` parts are cards for actions the owner must allow first
 *   (scheduling, approving). The worker writes them `pending` and holds the
 *   tool call; the owner answers with
 *   `POST /api/conversations/{id}/messages/{messageId}/consent`. A card the
 *   owner did not answer becomes `expired` (5 minutes, or the run ended).
 * - `agentSession` on a conversation lets the next turn continue the same
 *   Claude Code session (`--resume`) instead of replaying the history.
 * - `ClaudeAccount` is the Mac's `claude` sign-in as the worker last saw it
 *   (presence `claude`); the app can ask the worker to sign in.
 */

/** Ids the agent chooses inside a message (same rule as chat.ts `PartKey`). */
const AgentKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/, "letters, digits and _ . : - only");

// --- tool steps ----------------------------------------------------------------------------

export const ToolStepState = z.enum(["running", "done", "error"]).meta({ id: "ToolStepState" });
export type ToolStepState = z.infer<typeof ToolStepState>;

/** One tool call of the agent, shown as a small secondary row. Replace it (same index) to update. */
export const ToolStepPart = z
  .object({
    type: z.literal("tool_step"),
    /** The tool call's id (unique inside the message). */
    id: AgentKey,
    /** Tool name without the server prefix, e.g. `propose_plan`. */
    name: z.string().min(1).max(64),
    /** Turkish: present tense while running ("Plan hazırlanıyor…"), past tense after ("Plan hazırlandı"). */
    label: z.string(),
    state: ToolStepState,
    /** One line about the result or the error. */
    summary: z.string().nullable(),
  })
  .meta({ id: "ToolStepPart" });
export type ToolStepPart = z.infer<typeof ToolStepPart>;

export const ToolStepPartInput = z
  .object({
    type: z.literal("tool_step"),
    id: AgentKey,
    name: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(200),
    state: ToolStepState,
    summary: z.string().max(300).nullable().default(null),
  })
  .meta({ id: "ToolStepPartInput" });

// --- consent cards ---------------------------------------------------------------------------

/**
 * `pending` until the owner answers; `allowed` / `denied` are the owner's
 * (final); `expired`: not answered in time, or the run ended first.
 */
export const ConsentState = z
  .enum(["pending", "allowed", "denied", "expired"])
  .meta({ id: "ConsentState" });
export type ConsentState = z.infer<typeof ConsentState>;

/** "May I do this?" card: Allow once / Deny. */
export const ConsentPart = z
  .object({
    type: z.literal("consent"),
    /** Unique inside the message; the consent endpoint addresses the card by it. */
    consentId: AgentKey,
    /** The tool that asks, e.g. `schedule_post`. */
    tool: z.string(),
    /** What will happen, in Turkish ("Postu zamanla"). */
    title: z.string(),
    /** What exactly (post, platform, time), in Turkish. */
    detail: z.string().nullable(),
    state: ConsentState,
    /** When the owner answered or the card expired. */
    decidedAt: Timestamp.nullable(),
  })
  .meta({ id: "ConsentPart" });
export type ConsentPart = z.infer<typeof ConsentPart>;

/**
 * What the worker writes: a new card is `pending`; the worker may only turn
 * a pending card into `expired` (its timeout). The owner's answer is final.
 */
export const ConsentPartInput = z
  .object({
    type: z.literal("consent"),
    consentId: AgentKey,
    tool: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(200),
    detail: z.string().max(2_000).nullable().default(null),
    state: z.enum(["pending", "expired"]).default("pending"),
  })
  .meta({ id: "ConsentPartInput" });

/** `POST /api/conversations/{id}/messages/{messageId}/consent`. */
export const ConsentDecisionCreate = z
  .object({
    consentId: AgentKey,
    /** true = Allow once, false = Deny. */
    allow: z.boolean(),
  })
  .meta({ id: "ConsentDecisionCreate" });
export type ConsentDecisionCreate = z.input<typeof ConsentDecisionCreate>;

// --- Claude Code session of a conversation ----------------------------------------------------

/**
 * The Claude Code session that answered the conversation's last completed
 * turn. It is current while the conversation still has exactly
 * `messageCount` messages besides the new turn's trigger (nothing else was
 * said since); otherwise the worker starts a new session with the history.
 */
export const AgentSession = z
  .object({
    /** Session id for `claude --resume`. */
    id: z.string().min(1).max(128),
    /** Messages in the conversation when the session's last turn completed. */
    messageCount: z.number().int().min(0),
    /** The run that last continued the session. */
    runId: EntityId,
    updatedAt: Timestamp,
  })
  .meta({ id: "AgentSession" });
export type AgentSession = z.infer<typeof AgentSession>;

/** Sent with `complete`: the session the run used (the server counts the messages). */
export const RunSessionInput = z
  .object({ id: z.string().trim().min(1).max(128) })
  .meta({ id: "RunSessionInput" });

// --- the Mac's Claude sign-in ------------------------------------------------------------------

export const ClaudeAccountStatus = z
  .enum(["signed_in", "signed_out", "signing_in", "not_installed", "error"])
  .meta({ id: "ClaudeAccountStatus" });
export type ClaudeAccountStatus = z.infer<typeof ClaudeAccountStatus>;

/**
 * Claude's usage window is used up and work waits for it (S7). With mode `ask` and no `decision`
 * the waiting jobs need the owner's answer (`POST /api/ai/claude-limit/decision`).
 */
export const ClaudeLimitState = z
  .object({
    /** When the window resets (best estimate). */
    resetsAt: Timestamp,
    mode: ClaudeLimitMode,
    /** The owner's answer for this window; null = none (mode `ask`: the work waits for one). */
    decision: ClaudeLimitChoice.nullable(),
    /** Claude calls waiting for the reset or the answer (jobs and chat turns). */
    waiting: z.number().int().min(0),
    /** A Gemini key is ready, so "Gemini ile devam et" can work. */
    geminiReady: z.boolean(),
  })
  .meta({ id: "ClaudeLimitState" });
export type ClaudeLimitState = z.infer<typeof ClaudeLimitState>;

/** `claude auth status` as the worker last read it (presence `claude`). */
export const ClaudeAccount = z
  .object({
    status: ClaudeAccountStatus,
    email: z.string().max(320).nullable(),
    /** "Claude Max", "Claude Team", ... */
    plan: z.string().max(200).nullable(),
    cliVersion: z.string().max(64).nullable(),
    /** While signing in: the sign-in page, when the CLI printed one (the browser normally opens by itself). */
    loginUrl: z.string().max(2_000).nullable(),
    /** Turkish one-liner: why signed out, what failed. */
    detail: z.string().max(500).nullable(),
    /**
     * The signed-in person's first name from Claude Code's local profile on the Mac
     * (`~/.claude.json` → `oauthAccount.displayName`, else the first word of `fullName`).
     * The apps greet with it unless the owner typed a name. Absent from older workers.
     */
    displayName: z.string().max(80).nullable().optional(),
    /** Set while Claude's usage window is used up and work waits (S7); absent otherwise. */
    limit: ClaudeLimitState.nullable().optional(),
    checkedAt: Timestamp,
  })
  .meta({ id: "ClaudeAccount" });
export type ClaudeAccount = z.infer<typeof ClaudeAccount>;

/** What the app can ask the worker to do about the sign-in. */
export const ClaudeCommand = z
  .enum(["claude.login", "claude.status"])
  .meta({ id: "ClaudeCommand" });
export type ClaudeCommand = z.infer<typeof ClaudeCommand>;

/** `GET /api/workers/claude` and the answer of its commands. */
export const ClaudeControl = z
  .object({
    /** Latest report from a worker; null until one sent it. */
    account: ClaudeAccount.nullable(),
    /** A worker is connected (commands need one). */
    online: z.boolean(),
    /** Workers the command was sent to (0 for GET). */
    sent: z.number().int().min(0),
  })
  .meta({ id: "ClaudeControl" });
export type ClaudeControl = z.infer<typeof ClaudeControl>;

// --- the Mac's Gemini connection ---------------------------------------------------------------

export const GeminiAccountStatus = z
  .enum(["ready", "not_configured", "error"])
  .meta({ id: "GeminiAccountStatus" });
export type GeminiAccountStatus = z.infer<typeof GeminiAccountStatus>;

export const GeminiMode = z.enum(["api", "cli", "both", "none"]).meta({ id: "GeminiMode" });
export type GeminiMode = z.infer<typeof GeminiMode>;

/** Gemini API key (.env) and/or `gemini` CLI readiness as the worker last saw it (`presence.gemini`). */
export const GeminiAccount = z
  .object({
    status: GeminiAccountStatus,
    mode: GeminiMode,
    /** True when the worker has a Gemini API key (the vault or `GEMINI_API_KEY` in its environment). */
    apiKeyConfigured: z.boolean(),
    /**
     * Where the key came from: `vault` (Ayarlar → Yapay zekâ, preferred) or `env` (`.env`
     * `GEMINI_API_KEY`); null without a key. Absent from older workers.
     */
    keySource: z.enum(["vault", "env"]).nullable().optional(),
    /** Installed `gemini` CLI version when found, else null. */
    cliVersion: z.string().max(64).nullable(),
    /** Default Gemini model id the worker uses for cheap chat turns. */
    defaultModel: z.string().max(128).nullable(),
    /** Turkish one-liner about readiness or error. */
    detail: z.string().max(500).nullable(),
    checkedAt: Timestamp,
  })
  .meta({ id: "GeminiAccount" });
export type GeminiAccount = z.infer<typeof GeminiAccount>;

export const GeminiCommand = z.enum(["gemini.status"]).meta({ id: "GeminiCommand" });
export type GeminiCommand = z.infer<typeof GeminiCommand>;

/**
 * `providers.status`: re-check Codex / OpenAI / Antigravity; `codex.login` / `antigravity.login`:
 * start the CLI's browser sign-in; `ai.credentials`: the stored API keys changed, read them again.
 */
export const WorkerCommand = z
  .enum([
    "claude.login",
    "claude.status",
    "gemini.status",
    "providers.status",
    "codex.login",
    "antigravity.login",
    "ai.credentials",
  ])
  .meta({ id: "WorkerCommand" });
export type WorkerCommand = z.infer<typeof WorkerCommand>;

/** `GET /api/workers/gemini` and the answer of its refresh command. */
export const GeminiControl = z
  .object({
    account: GeminiAccount.nullable(),
    online: z.boolean(),
    sent: z.number().int().min(0),
  })
  .meta({ id: "GeminiControl" });
export type GeminiControl = z.infer<typeof GeminiControl>;
