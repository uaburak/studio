import { env } from "cloudflare:workers";
import { AiKeyList, AiKeyState, AiSpendSummary, WorkerAiCredentials } from "@studio/contract";
import { afterEach, describe, expect, it } from "vitest";
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
});
