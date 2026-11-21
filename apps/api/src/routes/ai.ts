import { createRoute } from "@hono/zod-openapi";
import {
  AiBudgetPut,
  AiKeyList,
  AiKeyProvider,
  AiKeyProviderParam,
  AiKeyPut,
  AiKeyState,
  AiPreferences,
  AiPreferencesPut,
  type AiSpendModel,
  AiSpendProvider,
  type AiSpendProviderTotals,
  AiSpendQuery,
  AiSpendSummary,
  type AiSpendTotals,
  ApiErrorBody,
  ClaudeLimitDecisionCreate,
  GEMINI_BILLING_URL,
  WorkerAiCredentials,
  WorkerAiSettings,
  WorkerAiSettingsQuery,
  WorkerAiUsageAck,
  WorkerAiUsageReport,
} from "@studio/contract";
import { desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { Context } from "hono";
import { createDb, type Db } from "../db/client.ts";
import { aiKeys, aiUsage } from "../db/schema.ts";
import {
  budgetState,
  checkKey,
  decisionUntil,
  loadKeyRow,
  loadSettings,
  openKey,
  periodStarts,
  recordCheck,
  roundUsd,
  saveBudget,
  saveKey,
  saveLimitDecision,
  savePreferences,
  sortModels,
  sumTotals,
  toKeyState,
  toPreferences,
  toTotals,
} from "../lib/ai-keys.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { type AppEnv, createRouter, errors, json, jsonBody } from "../lib/router.ts";
import { VAULT_UNAVAILABLE_MESSAGE, vaultReady } from "../lib/token-vault.ts";
import { requireOwner } from "../middleware/access.ts";
import { requireWorkerToken } from "../middleware/worker-auth.ts";
import { hubStub } from "./jobs.ts";

/*
 * AI provider keys (roadmap 7), paid AI spend (roadmap 11, U8) and the S7 preferences.
 *
 * Keys: the owner (the Mac or a paired phone; a phone never sees the hint). A key is checked with the provider's free models listing before
 * it is stored; a key the provider refuses is not stored. After a change the worker is told to
 * read the keys again (`worker.command ai.credentials`). Only the worker reads the plaintext.
 *
 * Preferences (S7): what happens when Claude's limit is used up (`ask` / `gemini` / `wait`), the
 * owner's answer while it is (`/api/ai/claude-limit/decision`) and the monthly budget with
 * "stop at budget". The worker reads them from `/api/worker/ai/settings` (after the same
 * `ai.credentials` command).
 */

const tags = ["AI"];
const forbidden = json(ApiErrorBody, "Not called by the owner (`forbidden`).");
const security = [{ workerToken: [] }];
const unauthorized = { description: "Missing or wrong worker token (plain text)." };

const router = createRouter();

// The owner (the Mac or a paired phone, iOS Ayarlar → Yapay zekâ); never the worker token. A
// phone may store or remove a key but never reads it back (not even the hint).
router.use("/api/ai/keys", requireOwner);
router.use("/api/ai/keys/*", requireOwner);
router.use("/api/ai/budget", requireOwner);
// Anyone signed in may read the preferences; only the owner changes them.
router.use("/api/ai/preferences", async (c, next) =>
  c.req.method === "GET" || c.req.method === "HEAD" ? next() : requireOwner(c, next),
);
// The Claude-limit answer ("Gemini ile devam et / Sınırı bekle") may also come from a paired
// phone: it only picks between two choices the owner already allowed in the preferences.
router.use("/api/worker/ai/*", requireWorkerToken);

/**
 * Tell the connected worker(s) to read the keys and the AI settings (`/api/worker/ai/settings`)
 * again (best effort).
 */
async function notifyWorker(env: Env): Promise<void> {
  try {
    await hubStub(env).providersControl("ai.credentials");
  } catch (error) {
    console.warn("api: could not tell the worker about the new AI keys:", (error as Error).message);
  }
}

async function keyList(db: Db, env: Env): Promise<AiKeyList> {
  const items = [];
  for (const provider of AiKeyProvider.options) {
    items.push(toKeyState(provider, await loadKeyRow(db, provider)));
  }
  return { items, vaultReady: vaultReady(env) };
}

/** A paired phone sees only whether a key is stored, never its last characters. */
function shown(c: Context<AppEnv>, state: AiKeyState): AiKeyState {
  return c.get("principal")?.kind === "device" ? { ...state, hint: null } : state;
}

const totalsColumns = {
  costUsd: sql<number | null>`sum(${aiUsage.costUsd})`,
  calls: sql<number>`count(*)`,
  unpricedCalls: sql<number>`sum(case when ${aiUsage.costUsd} is null then 1 else 0 end)`,
  inputTokens: sql<number>`sum(${aiUsage.inputTokens})`,
  outputTokens: sql<number>`sum(${aiUsage.outputTokens})`,
  thoughtsTokens: sql<number>`sum(${aiUsage.thoughtsTokens})`,
};

/** A stored provider name as the contract knows it (rows from older workers are kept as is). */
function spendProvider(value: string): AiSpendProvider | null {
  const parsed = AiSpendProvider.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Recorded spend of every paid service since `sinceMs` (unpriced calls count 0). */
async function spentSince(db: Db, sinceMs: number): Promise<number> {
  const [row] = await db
    .select({ costUsd: sql<number | null>`sum(${aiUsage.costUsd})` })
    .from(aiUsage)
    .where(gte(aiUsage.occurredAt, new Date(sinceMs)));
  return roundUsd(Number(row?.costUsd ?? 0));
}

/** Paid AI spend of every recorded service (Gemini, OpenAI, ElevenLabs, ...). */
async function spendSummary(db: Db, tzOffset: number, nowMs = Date.now()) {
  const starts = periodStarts(nowMs, tzOffset);
  const [monthRows, todayRows, latest, settings] = await Promise.all([
    db
      .select({ provider: aiUsage.provider, model: aiUsage.model, ...totalsColumns })
      .from(aiUsage)
      .where(gte(aiUsage.occurredAt, new Date(starts.month)))
      .groupBy(aiUsage.provider, aiUsage.model),
    db
      .select(totalsColumns)
      .from(aiUsage)
      .where(gte(aiUsage.occurredAt, new Date(starts.day))),
    db
      .select({ version: aiUsage.pricingVersion })
      .from(aiUsage)
      .where(isNotNull(aiUsage.pricingVersion))
      .orderBy(desc(aiUsage.occurredAt))
      .limit(1),
    loadSettings(db),
  ]);
  const rows = monthRows.map((r) => ({ provider: r.provider, model: r.model, ...toTotals(r) }));
  const byModel: AiSpendModel[] = sortModels(
    rows.map(({ provider, ...r }) => {
      const known = spendProvider(provider);
      return known ? { ...r, provider: known } : r;
    }),
  );
  const perProvider = new Map<AiSpendProvider, AiSpendTotals[]>();
  for (const { provider, model: _model, ...totals } of rows) {
    const known = spendProvider(provider);
    if (!known) continue;
    perProvider.set(known, [...(perProvider.get(known) ?? []), totals]);
  }
  const byProvider: AiSpendProviderTotals[] = sortModels(
    [...perProvider].map(([provider, list]) => ({ provider, ...sumTotals(list) })),
  );
  const month = sumTotals(byModel);
  const today = todayRows[0] ? toTotals(todayRows[0]) : sumTotals([]);
  const monthlyUsd = settings?.geminiMonthlyBudgetUsd ?? null;
  return AiSpendSummary.parse({
    provider: "gemini",
    currency: "USD",
    today,
    month,
    byModel,
    byProvider,
    budget: budgetState(monthlyUsd, month.costUsd, settings?.stopAtBudget ?? false),
    balance: { known: false, remainingUsd: null, billingUrl: GEMINI_BILLING_URL },
    pricingVersion: latest[0]?.version ?? null,
    dayStart: new Date(starts.day).toISOString(),
    monthStart: new Date(starts.month).toISOString(),
  });
}

/** Presence `claude.limit.resetsAt` (best effort: null when the hub cannot tell). */
async function claudeResetsAt(env: Env): Promise<string | null> {
  try {
    const control = await hubStub(env).claudeControl();
    return control.account?.limit?.resetsAt ?? null;
  } catch (error) {
    console.warn("api: could not read the Claude limit from the hub:", (error as Error).message);
    return null;
  }
}

export const aiRoutes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/api/ai/keys",
      tags,
      summary: "Stored AI provider keys (hint, last check, models; never the key) (owner)",
      responses: { 200: json(AiKeyList, "Keys."), 403: forbidden },
    }),
    async (c) => {
      const list = await keyList(createDb(c.env.DB), c.env);
      return c.json({ ...list, items: list.items.map((item) => shown(c, item)) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/ai/keys/{provider}",
      tags,
      summary: "Check and store an API key in the vault (owner)",
      description:
        "Lists the provider's models with the key first (free). A key the provider refuses is " +
        "not stored (400). When the provider cannot be reached the key is stored unchecked. " +
        "409 when the vault key is missing.",
      request: { params: AiKeyProviderParam, body: jsonBody(AiKeyPut) },
      responses: {
        200: json(AiKeyState, "Stored."),
        400: errors[400],
        403: forbidden,
        409: errors[409],
      },
    }),
    async (c) => {
      const { provider } = c.req.valid("param");
      const { key } = c.req.valid("json");
      if (!vaultReady(c.env)) throw conflict(VAULT_UNAVAILABLE_MESSAGE);
      const check = await checkKey(provider, key);
      if (check.valid === false)
        throw badRequest(check.detail, [{ path: "key", message: check.detail }]);
      const row = await saveKey(createDb(c.env.DB), c.env, provider, key, check);
      await notifyWorker(c.env);
      return c.json(shown(c, toKeyState(provider, row)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/ai/keys/{provider}/check",
      tags,
      summary: "Check the stored key again (models.list; free) (owner)",
      request: { params: AiKeyProviderParam },
      responses: { 200: json(AiKeyState, "Checked."), 403: forbidden, 404: errors[404] },
    }),
    async (c) => {
      const { provider } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const row = await loadKeyRow(db, provider);
      const key = await openKey(c.env, provider, row);
      if (!row || !key) throw notFound("AI key", provider);
      const next = await recordCheck(db, provider, await checkKey(provider, key));
      await notifyWorker(c.env);
      return c.json(shown(c, toKeyState(provider, next)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/api/ai/keys/{provider}",
      tags,
      summary: "Forget the stored key (the worker falls back to its .env) (owner)",
      request: { params: AiKeyProviderParam },
      responses: { 200: json(AiKeyState, "Deleted."), 403: forbidden },
    }),
    async (c) => {
      const { provider } = c.req.valid("param");
      const db = createDb(c.env.DB);
      await db.delete(aiKeys).where(eq(aiKeys.provider, provider));
      await notifyWorker(c.env);
      return c.json(toKeyState(provider, null), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/ai/spend",
      tags,
      summary:
        "Paid AI spend (Gemini, OpenAI, ElevenLabs): today, this month, per model and service",
      description:
        "Sums the calls the worker recorded with its pricing tables, across every paid service, " +
        "and compares the month with the monthly budget. The Gemini API has no balance " +
        "endpoint, so `balance.known` is false (see `balance.billingUrl`).",
      request: { query: AiSpendQuery },
      responses: { 200: json(AiSpendSummary, "Spend."), 400: errors[400] },
    }),
    async (c) => {
      const { tzOffset } = c.req.valid("query");
      return c.json(await spendSummary(createDb(c.env.DB), tzOffset), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/ai/budget",
      tags,
      summary: "Set (or clear with null) the monthly budget of the paid AI services in USD (owner)",
      request: { body: jsonBody(AiBudgetPut) },
      responses: { 200: json(AiSpendSummary, "Saved."), 400: errors[400], 403: forbidden },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await saveBudget(db, input.geminiMonthlyUsd);
      await notifyWorker(c.env);
      return c.json(await spendSummary(db, input.tzOffset), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/ai/preferences",
      tags,
      summary: "What happens when Claude's limit is used up, and the monthly AI budget (S7)",
      description:
        "`limitDecision` is the owner's answer for the current Claude limit window; null when " +
        "none was given or it expired (`until` passed).",
      responses: { 200: json(AiPreferences, "Preferences.") },
    }),
    async (c) => c.json(toPreferences(await loadSettings(createDb(c.env.DB))), 200),
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/ai/preferences",
      tags,
      summary: "Change the Claude-limit behaviour, the monthly budget or stop-at-budget (owner)",
      description:
        "Only the fields sent change. `monthlyBudgetUsd` is the same budget `PUT /api/ai/budget` " +
        "sets. A new `claudeLimit` drops the answer given under the old one. The worker is told " +
        "to read its settings again.",
      request: { body: jsonBody(AiPreferencesPut) },
      responses: { 200: json(AiPreferences, "Saved."), 400: errors[400], 403: forbidden },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await savePreferences(db, input);
      await notifyWorker(c.env);
      return c.json(toPreferences(await loadSettings(db)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/ai/claude-limit/decision",
      tags,
      summary: "Answer the Claude limit: go on with Gemini, or wait for the reset (owner)",
      description:
        "The answer holds until `until`: by default presence `claude.limit.resetsAt` (when " +
        "still ahead), else five hours from now. 400 when `until` is not in the future. The " +
        "worker is told to read its settings again.",
      request: { body: jsonBody(ClaudeLimitDecisionCreate) },
      responses: { 200: json(AiPreferences, "Saved."), 400: errors[400], 403: forbidden },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const nowMs = Date.now();
      const untilMs =
        input.until !== undefined
          ? Date.parse(input.until)
          : decisionUntil(await claudeResetsAt(c.env), nowMs);
      if (!(untilMs > nowMs)) {
        throw badRequest("`until` must be in the future", [
          { path: "until", message: "must be in the future" },
        ]);
      }
      const db = createDb(c.env.DB);
      await saveLimitDecision(db, input.choice, untilMs, nowMs);
      await notifyWorker(c.env);
      return c.json(toPreferences(await loadSettings(db), nowMs), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/ai/settings",
      tags,
      security,
      summary: "Claude-limit behaviour, the owner's answer and the budget state (worker only)",
      description:
        "`budget.spentUsd` is this month's recorded spend of every paid service (unpriced calls " +
        "count 0) from the start of the month in the worker's time zone (`tzOffset`).",
      request: { query: WorkerAiSettingsQuery },
      responses: {
        200: json(WorkerAiSettings, "Settings."),
        400: errors[400],
        401: unauthorized,
      },
    }),
    async (c) => {
      const { tzOffset } = c.req.valid("query");
      const db = createDb(c.env.DB);
      const nowMs = Date.now();
      const monthStart = periodStarts(nowMs, tzOffset).month;
      const [settings, spentUsd] = await Promise.all([
        loadSettings(db),
        spentSince(db, monthStart),
      ]);
      const prefs = toPreferences(settings, nowMs);
      const out: WorkerAiSettings = {
        claudeLimit: prefs.claudeLimit,
        limitDecision: prefs.limitDecision,
        budget: {
          monthlyUsd: prefs.monthlyBudgetUsd,
          stopAtBudget: prefs.stopAtBudget,
          spentUsd,
          monthStart: new Date(monthStart).toISOString(),
        },
        mediaCaptions: prefs.mediaCaptions ?? false,
      };
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/ai/credentials",
      tags,
      security,
      summary: "The stored AI keys in plaintext (worker only)",
      responses: {
        200: json(WorkerAiCredentials, "Keys (null when not stored)."),
        401: unauthorized,
      },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      const out: WorkerAiCredentials = { gemini: null, openai: null };
      for (const provider of AiKeyProvider.options) {
        const row = await loadKeyRow(db, provider);
        const key = await openKey(c.env, provider, row);
        if (row && key) out[provider] = { apiKey: key, models: toKeyState(provider, row).models };
      }
      return c.json(out, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/ai/usage",
      tags,
      security,
      summary: "Record paid AI calls (tokens and cost) (worker only)",
      request: { body: jsonBody(WorkerAiUsageReport) },
      responses: {
        200: json(WorkerAiUsageAck, "Stored."),
        400: errors[400],
        401: unauthorized,
      },
    }),
    async (c) => {
      const { records } = c.req.valid("json");
      const db = createDb(c.env.DB);
      const now = new Date();
      const rows = records.map((r) => ({
        id: newId(),
        provider: r.provider,
        model: r.model,
        kind: r.kind,
        jobId: r.jobId,
        runId: r.runId,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        thoughtsTokens: r.thoughtsTokens,
        cachedTokens: r.cachedTokens,
        costUsd: r.costUsd,
        pricingVersion: r.pricingVersion,
        occurredAt: new Date(r.occurredAt),
        createdAt: now,
      }));
      // D1 limits bound parameters per statement: insert in small batches.
      for (let i = 0; i < rows.length; i += 6) {
        await db.insert(aiUsage).values(rows.slice(i, i + 6));
      }
      return c.json({ stored: rows.length }, 200);
    },
  );
