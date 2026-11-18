import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import {
  AiKeyList,
  AiKeyState,
  AiPreferences,
  AiSpendSummary,
  WorkerAiCredentials,
  WorkerAiSettings,
} from "@studio/contract";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetState, periodStarts } from "../src/lib/ai-keys.ts";
import { api, BASE, expectError, localFetch } from "./helpers.ts";

const AUTH = () => ({ Authorization: `Bearer ${env.WORKER_TOKEN}` });
const GEMINI_KEY = "AIzaTestKey-0123456789abcdefWXYZ";
const OPENAI_KEY = "sk-test-0123456789abcdefghijklmn";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Fake Google / OpenAI model listings; a key ending in "BAD" is refused. */
function installFakeProviders(calls: string[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    if (url.hostname === "generativelanguage.googleapis.com") {
      const key = headers.get("x-goog-api-key") ?? "";
      calls.push(`gemini:${url.pathname}`);
      if (key.endsWith("BAD")) {
        return Response.json(
          {
            error: {
              code: 400,
              message: `API key not valid (${key}). Please pass a valid API key.`,
            },
          },
          { status: 400 },
        );
      }
      return Response.json({
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
        ],
      });
    }
    if (url.hostname === "api.openai.com") {
      calls.push(`openai:${url.pathname}`);
      if ((headers.get("authorization") ?? "").endsWith("BAD")) {
        return Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 });
      }
      return Response.json({ data: [{ id: "gpt-6-sol" }, { id: "gpt-6-luna" }] });
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

async function worker<T>(method: string, path: string, body?: unknown) {
  const res = await localFetch(`${BASE}${path}`, {
    method,
    headers: { ...AUTH(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

describe("AI keys in the vault", () => {
  it("checks a Gemini key with models.list, stores it sealed and shows only a hint", async () => {
    const calls: string[] = [];
    installFakeProviders(calls);
    const put = await api<AiKeyState>("PUT", "/api/ai/keys/gemini", { key: GEMINI_KEY });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const state = AiKeyState.parse(put.body);
    expect(state).toMatchObject({
      provider: "gemini",
      configured: true,
      hint: "…WXYZ",
      valid: true,
    });
    expect(state.models).toEqual(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
    expect(calls).toEqual(["gemini:/v1beta/models"]);

    const list = await api<AiKeyList>("GET", "/api/ai/keys");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(GEMINI_KEY);
    const parsed = AiKeyList.parse(list.body);
    expect(parsed.vaultReady).toBe(true);
    expect(parsed.items.map((k) => [k.provider, k.configured])).toEqual([
      ["gemini", true],
      ["openai", false],
    ]);

    // The row holds ciphertext, never the key.
    const row = await env.DB.prepare("select * from ai_keys where provider = 'gemini'").first();
    expect(JSON.stringify(row)).not.toContain(GEMINI_KEY);

    const creds = await worker<WorkerAiCredentials>("GET", "/api/worker/ai/credentials");
    expect(creds.status).toBe(200);
    expect(WorkerAiCredentials.parse(creds.body).gemini?.apiKey).toBe(GEMINI_KEY);
  });

  it("refuses a key the provider rejects and does not echo it in the error", async () => {
    installFakeProviders();
    const bad = `${OPENAI_KEY}BAD`;
    const res = await api("PUT", "/api/ai/keys/openai", { key: bad });
    const error = expectError(res, 400, "validation_error");
    expect(error.message).toContain("Anahtar geçersiz");
    expect(JSON.stringify(res.body)).not.toContain(bad);
    const list = AiKeyList.parse((await api("GET", "/api/ai/keys")).body);
    expect(list.items.find((k) => k.provider === "openai")?.configured).toBe(false);
  });

  it("re-checks, then deletes a stored key", async () => {
    installFakeProviders();
    expect((await api("PUT", "/api/ai/keys/openai", { key: OPENAI_KEY })).status).toBe(200);
    const check = await api<AiKeyState>("POST", "/api/ai/keys/openai/check");
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ valid: true, models: ["gpt-6-luna", "gpt-6-sol"] });
    const del = await api<AiKeyState>("DELETE", "/api/ai/keys/openai");
    expect(del.status).toBe(200);
    expect(del.body.configured).toBe(false);
    expectError(await api("POST", "/api/ai/keys/openai/check"), 404, "not_found");
  });

  it("is for the Mac itself and the worker only", async () => {
    const viaGateway = await localFetch(`${BASE}/api/ai/keys`, {
      headers: { "X-Studio-Gateway": "1", ...AUTH() },
    });
    expect(viaGateway.status).toBe(403);
    const noToken = await localFetch(`${BASE}/api/worker/ai/credentials`);
    expect(noToken.status).toBe(401);
  });
});

describe("Gemini spend", () => {
  it("sums recorded calls per day, month and model and compares with the budget", async () => {
    const now = Date.now();
    const record = (model: string, costUsd: number | null, ageMs = 0) => ({
      provider: "gemini",
      model,
      kind: "chat",
      inputTokens: 1000,
      outputTokens: 200,
      thoughtsTokens: 50,
      costUsd,
      pricingVersion: "2026-11-18",
      occurredAt: new Date(now - ageMs).toISOString(),
    });
    const stored = await worker<{ stored: number }>("POST", "/api/worker/ai/usage", {
      records: [
        record("gemini-2.5-flash", 0.25),
        record("gemini-2.5-flash", 0.5),
        record("gemini-2.5-pro", 1.25),
        record("gemini-x-unknown", null),
        // Two months ago: outside this month.
        record("gemini-2.5-pro", 9, 70 * 24 * 3600_000),
      ],
    });
    expect(stored).toEqual({ status: 200, body: { stored: 5 } });

    const res = await api<AiSpendSummary>("GET", "/api/ai/spend?tzOffset=-180");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const spend = AiSpendSummary.parse(res.body);
    expect(spend.month.costUsd).toBeCloseTo(2, 6);
    expect(spend.month.calls).toBe(4);
    expect(spend.month.unpricedCalls).toBe(1);
    expect(spend.today.calls).toBeGreaterThanOrEqual(4);
    expect(spend.byModel[0]).toMatchObject({ model: "gemini-2.5-pro", calls: 1 });
    expect(spend.balance).toMatchObject({ known: false, remainingUsd: null });
    expect(spend.pricingVersion).toBe("2026-11-18");
    expect(spend.budget.monthlyUsd).toBeNull();

    const budget = await api<AiSpendSummary>("PUT", "/api/ai/budget", {
      geminiMonthlyUsd: 2.4,
      tzOffset: -180,
    });
    expect(budget.status).toBe(200);
    expect(budget.body.budget).toMatchObject({ monthlyUsd: 2.4, warning: true });
    expect(budget.body.budget.remainingUsd).toBeCloseTo(0.4, 6);

    const cleared = await api<AiSpendSummary>("PUT", "/api/ai/budget", { geminiMonthlyUsd: null });
    expect(cleared.body.budget.monthlyUsd).toBeNull();
  });

  it("computes local day and month starts", () => {
    // 2026-11-01T00:30:00+03:00 is still October 31st in UTC.
    const now = Date.UTC(2026, 9, 31, 21, 30);
    const starts = periodStarts(now, -180);
    expect(new Date(starts.day).toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(new Date(starts.month).toISOString()).toBe("2026-10-31T21:00:00.000Z");
    expect(budgetState(10, 7.9).warning).toBe(false);
    expect(budgetState(10, 8).warning).toBe(true);
    expect(budgetState(0, 0)).toMatchObject({ usedPercent: 0, warning: false });
  });

  it("is exhausted only with stop-at-budget on and the budget reached", () => {
    expect(budgetState(10, 10, false)).toMatchObject({ stopAtBudget: false, exhausted: false });
    expect(budgetState(10, 9.99, true)).toMatchObject({ stopAtBudget: true, exhausted: false });
    expect(budgetState(10, 10, true)).toMatchObject({ stopAtBudget: true, exhausted: true });
    expect(budgetState(null, 50, true)).toMatchObject({ monthlyUsd: null, exhausted: false });
  });
});

const usage = (
  provider: string,
  model: string,
  costUsd: number | null,
  occurredAt = new Date().toISOString(),
) => ({
  provider,
  model,
  kind: "other",
  inputTokens: 100,
  outputTokens: 10,
  costUsd,
  pricingVersion: "2026-11-18",
  occurredAt,
});

async function resetAi() {
  await env.DB.prepare("delete from ai_usage").run();
  await env.DB.prepare("delete from ai_settings").run();
}

describe("Paid AI spend across services (U8)", () => {
  beforeEach(resetAi);

  it("stores OpenAI and ElevenLabs records and sums every service, per model and per service", async () => {
    const old = new Date(Date.now() - 70 * 24 * 3600_000).toISOString();
    const stored = await worker<{ stored: number }>("POST", "/api/worker/ai/usage", {
      records: [
        usage("gemini", "gemini-2.5-flash", 0.5),
        usage("openai", "gpt-image-1", 2),
        usage("openai", "gpt-image-1", 1),
        usage("elevenlabs", "eleven_multilingual_v2", 0.25),
        usage("elevenlabs", "eleven_turbo", null),
        usage("openai", "gpt-image-1", 40, old),
      ],
    });
    expect(stored).toEqual({ status: 200, body: { stored: 6 } });

    const res = await api<AiSpendSummary>("GET", "/api/ai/spend?tzOffset=-180");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const spend = AiSpendSummary.parse(res.body);
    expect(spend.provider).toBe("gemini");
    expect(spend.month.costUsd).toBeCloseTo(3.75, 6);
    expect(spend.month.calls).toBe(5);
    expect(spend.month.unpricedCalls).toBe(1);
    expect(spend.today.costUsd).toBeCloseTo(3.75, 6);
    expect(spend.byModel[0]).toMatchObject({ provider: "openai", model: "gpt-image-1", calls: 2 });
    expect(spend.byModel[0]?.costUsd).toBeCloseTo(3, 6);
    expect(spend.byProvider?.map((p) => [p.provider, p.calls])).toEqual([
      ["openai", 2],
      ["gemini", 1],
      ["elevenlabs", 2],
    ]);
    expect(spend.byProvider?.[2]).toMatchObject({ unpricedCalls: 1 });
    expect(spend.byProvider?.[2]?.costUsd).toBeCloseTo(0.25, 6);
    expect(spend.budget).toMatchObject({ monthlyUsd: null, stopAtBudget: false, exhausted: false });
  });

  it("reports the budget as exhausted when stop-at-budget is on and the month reached it", async () => {
    await worker("POST", "/api/worker/ai/usage", {
      records: [usage("openai", "gpt-image-1", 3), usage("gemini", "gemini-2.5-pro", 2)],
    });
    const prefs = await api<AiPreferences>("PUT", "/api/ai/preferences", {
      monthlyBudgetUsd: 5,
      stopAtBudget: true,
    });
    expect(prefs.status, JSON.stringify(prefs.body)).toBe(200);
    const spend = AiSpendSummary.parse((await api("GET", "/api/ai/spend")).body);
    expect(spend.budget).toMatchObject({
      monthlyUsd: 5,
      stopAtBudget: true,
      exhausted: true,
      warning: true,
    });
    // The budget endpoint sets the same stored budget.
    const raised = await api<AiSpendSummary>("PUT", "/api/ai/budget", { geminiMonthlyUsd: 6 });
    expect(raised.body.budget).toMatchObject({
      monthlyUsd: 6,
      stopAtBudget: true,
      exhausted: false,
    });
    const read = AiPreferences.parse((await api("GET", "/api/ai/preferences")).body);
    expect(read.monthlyBudgetUsd).toBe(6);
  });
});

describe("AI preferences (S7)", () => {
  beforeEach(resetAi);

  it("defaults to ask, no budget and no answer", async () => {
    const res = await api<AiPreferences>("GET", "/api/ai/preferences");
    expect(res.status).toBe(200);
    expect(AiPreferences.parse(res.body)).toEqual({
      claudeLimit: "ask",
      monthlyBudgetUsd: null,
      stopAtBudget: false,
      limitDecision: null,
      updatedAt: null,
    });
  });

  it("changes only the fields sent", async () => {
    const first = await api<AiPreferences>("PUT", "/api/ai/preferences", { claudeLimit: "wait" });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({ claudeLimit: "wait", monthlyBudgetUsd: null });
    const second = await api<AiPreferences>("PUT", "/api/ai/preferences", {
      monthlyBudgetUsd: 12.5,
    });
    expect(second.body).toMatchObject({
      claudeLimit: "wait",
      monthlyBudgetUsd: 12.5,
      stopAtBudget: false,
    });
    const third = await api<AiPreferences>("PUT", "/api/ai/preferences", { stopAtBudget: true });
    expect(third.body).toMatchObject({
      claudeLimit: "wait",
      monthlyBudgetUsd: 12.5,
      stopAtBudget: true,
    });
    const cleared = await api<AiPreferences>("PUT", "/api/ai/preferences", {
      monthlyBudgetUsd: null,
    });
    expect(cleared.body).toMatchObject({ monthlyBudgetUsd: null, stopAtBudget: true });
    expectError(
      await api("PUT", "/api/ai/preferences", { claudeLimit: "maybe" }),
      400,
      "validation_error",
    );
  });

  it("is changed by the Mac itself only", async () => {
    const viaGateway = await localFetch(`${BASE}/api/ai/preferences`, {
      method: "PUT",
      headers: { "X-Studio-Gateway": "1", ...AUTH(), "content-type": "application/json" },
      body: JSON.stringify({ claudeLimit: "gemini" }),
    });
    expect(viaGateway.status).toBe(403);
  });

  it("takes the Claude-limit answer from a paired phone too", async () => {
    const decision = await localFetch(`${BASE}/api/ai/claude-limit/decision`, {
      method: "POST",
      headers: { "X-Studio-Gateway": "1", ...AUTH(), "content-type": "application/json" },
      body: JSON.stringify({ choice: "wait" }),
    });
    expect(decision.status).not.toBe(403);
    expect(decision.status).toBeLessThan(500);
  });
});

describe("Claude limit decision (S7)", () => {
  beforeEach(resetAi);
  afterEach(async () => {
    await runInDurableObject(env.HUB.getByName("main"), async (_instance, state) => {
      await state.storage.delete("presence:claude");
    });
  });

  it("holds until presence claude.limit.resetsAt by default", async () => {
    const resetsAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    await runInDurableObject(env.HUB.getByName("main"), async (_instance, state) => {
      await state.storage.put("presence:claude", {
        status: "signed_in",
        email: null,
        plan: null,
        cliVersion: null,
        loginUrl: null,
        detail: null,
        limit: { resetsAt, mode: "ask", decision: null, waiting: 2, geminiReady: true },
        checkedAt: new Date().toISOString(),
      });
    });
    const res = await api<AiPreferences>("POST", "/api/ai/claude-limit/decision", {
      choice: "gemini",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const prefs = AiPreferences.parse(res.body);
    expect(prefs.limitDecision).toMatchObject({ choice: "gemini", until: resetsAt });
    const read = AiPreferences.parse((await api("GET", "/api/ai/preferences")).body);
    expect(read.limitDecision?.choice).toBe("gemini");
  });

  it("holds five hours without a known reset, and is gone once `until` passed", async () => {
    const before = Date.now();
    const res = await api<AiPreferences>("POST", "/api/ai/claude-limit/decision", {
      choice: "wait",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const until = Date.parse(res.body.limitDecision?.until ?? "");
    expect(until).toBeGreaterThanOrEqual(before + 5 * 3600_000);
    expect(until).toBeLessThanOrEqual(Date.now() + 5 * 3600_000);

    // Expire it.
    await env.DB.prepare("update ai_settings set limit_until = ?")
      .bind(Date.now() - 1000)
      .run();
    const read = AiPreferences.parse((await api("GET", "/api/ai/preferences")).body);
    expect(read.limitDecision).toBeNull();
    const settings = await worker<WorkerAiSettings>("GET", "/api/worker/ai/settings");
    expect(settings.body.limitDecision).toBeNull();
  });

  it("refuses an `until` in the past and drops the answer when the mode changes", async () => {
    expectError(
      await api("POST", "/api/ai/claude-limit/decision", {
        choice: "wait",
        until: new Date(Date.now() - 60_000).toISOString(),
      }),
      400,
      "validation_error",
    );
    const until = new Date(Date.now() + 3600_000).toISOString();
    const res = await api<AiPreferences>("POST", "/api/ai/claude-limit/decision", {
      choice: "wait",
      until,
    });
    expect(res.body.limitDecision).toMatchObject({ choice: "wait", until });
    // Same mode again: the answer stays.
    const same = await api<AiPreferences>("PUT", "/api/ai/preferences", { claudeLimit: "ask" });
    expect(same.body.limitDecision?.choice).toBe("wait");
    const changed = await api<AiPreferences>("PUT", "/api/ai/preferences", {
      claudeLimit: "gemini",
    });
    expect(changed.body).toMatchObject({ claudeLimit: "gemini", limitDecision: null });
  });
});

describe("Worker AI settings (S7)", () => {
  beforeEach(resetAi);

  it("needs the worker token", async () => {
    const res = await localFetch(`${BASE}/api/worker/ai/settings`);
    expect(res.status).toBe(401);
  });

  it("gives the mode, the answer and this month's spend of every service", async () => {
    const defaults = await worker<WorkerAiSettings>("GET", "/api/worker/ai/settings?tzOffset=-180");
    expect(defaults.status, JSON.stringify(defaults.body)).toBe(200);
    const parsed = WorkerAiSettings.parse(defaults.body);
    expect(parsed).toMatchObject({
      claudeLimit: "ask",
      limitDecision: null,
      budget: { monthlyUsd: null, stopAtBudget: false, spentUsd: 0 },
    });
    expect(parsed.budget.monthStart).toBe(
      new Date(periodStarts(Date.now(), -180).month).toISOString(),
    );

    const old = new Date(Date.now() - 70 * 24 * 3600_000).toISOString();
    await worker("POST", "/api/worker/ai/usage", {
      records: [
        usage("gemini", "gemini-2.5-flash", 0.5),
        usage("openai", "gpt-image-1", 1.25),
        usage("elevenlabs", "eleven_multilingual_v2", 0.25),
        usage("elevenlabs", "eleven_turbo", null),
        usage("openai", "gpt-image-1", 99, old),
      ],
    });
    await api("PUT", "/api/ai/preferences", {
      claudeLimit: "wait",
      monthlyBudgetUsd: 2,
      stopAtBudget: true,
    });
    const res = await worker<WorkerAiSettings>("GET", "/api/worker/ai/settings?tzOffset=-180");
    const settings = WorkerAiSettings.parse(res.body);
    expect(settings).toMatchObject({
      claudeLimit: "wait",
      limitDecision: null,
      budget: { monthlyUsd: 2, stopAtBudget: true },
    });
    expect(settings.budget.spentUsd).toBeCloseTo(2, 6);
  });
});
