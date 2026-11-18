import type {
  AiBudget,
  AiKeyProvider,
  AiKeyState,
  AiSpendModel,
  AiSpendTotals,
} from "@studio/contract";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { aiKeys, aiSettings } from "../db/schema.ts";
import { decryptSetting, encryptSetting, type VaultEnv } from "./token-vault.ts";

/*
 * AI provider keys in the token vault (roadmap 7) and the spend arithmetic (roadmap 11).
 * Keys are sealed per provider (`ai_key:<provider>` as the vault's additional data) and never
 * leave the API except to the worker. Error texts from the providers are cleaned of the key.
 */

export type AiKeyRow = typeof aiKeys.$inferSelect;

const SETTINGS_ID = "main";
const MAX_MODELS = 300;

function settingName(provider: AiKeyProvider): string {
  return `ai_key:${provider}`;
}

/** "…a1B2": the last 4 characters (never more). */
export function keyHint(key: string): string {
  return `…${key.slice(-4)}`;
}

function clean(text: string, key: string): string {
  const out = key.length >= 4 ? text.split(key).join("[anahtar]") : text;
  return out.replace(/\s+/g, " ").trim().slice(0, 300);
}

export interface KeyCheck {
  /** false: the provider refused the key; null: could not tell (network, rate limit). */
  valid: boolean | null;
  detail: string;
  models: string[];
}

async function readError(res: Response, key: string): Promise<string> {
  const raw = await res.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } | string };
    const message = typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
    if (message) return clean(message, key);
  } catch {
    // not JSON
  }
  return clean(raw || `HTTP ${res.status}`, key);
}

/** `GET v1beta/models` (free): is the key accepted, and which models does it list? */
export async function checkGeminiKey(
  key: string,
  doFetch: typeof fetch = globalThis.fetch,
): Promise<KeyCheck> {
  let res: Response;
  try {
    res = await doFetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
      headers: { "x-goog-api-key": key, accept: "application/json" },
    });
  } catch {
    return { valid: null, detail: "Google'a ulaşılamadı; anahtar denetlenemedi.", models: [] };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    };
    const models = (body.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.length > 0)
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      .filter((id) => id.length > 0 && id.length <= 128)
      .slice(0, MAX_MODELS);
    return { valid: true, detail: `Anahtar geçerli · ${models.length} model`, models };
  }
  const message = await readError(res, key);
  if (res.status === 429) {
    return { valid: null, detail: `Google hız sınırı: ${message}`, models: [] };
  }
  if (res.status >= 500) {
    return { valid: null, detail: `Google yanıt veremedi (HTTP ${res.status}).`, models: [] };
  }
  return { valid: false, detail: `Anahtar geçersiz: ${message}`, models: [] };
}

/** `GET v1/models` (free): is the key accepted, and which models does it list? */
export async function checkOpenAiKey(
  key: string,
  doFetch: typeof fetch = globalThis.fetch,
): Promise<KeyCheck> {
  let res: Response;
  try {
    res = await doFetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    });
  } catch {
    return { valid: null, detail: "OpenAI'ye ulaşılamadı; anahtar denetlenemedi.", models: [] };
  }
  if (res.ok) {
    const body = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
    const models = (body.data ?? [])
      .map((m) => m.id ?? "")
      .filter((id) => id.length > 0 && id.length <= 128)
      .sort()
      .slice(0, MAX_MODELS);
    return { valid: true, detail: `Anahtar geçerli · ${models.length} model`, models };
  }
  const message = await readError(res, key);
  if (res.status === 429) {
    return { valid: null, detail: `OpenAI hız sınırı: ${message}`, models: [] };
  }
  if (res.status >= 500) {
    return { valid: null, detail: `OpenAI yanıt veremedi (HTTP ${res.status}).`, models: [] };
  }
  return { valid: false, detail: `Anahtar geçersiz: ${message}`, models: [] };
}

export function checkKey(provider: AiKeyProvider, key: string): Promise<KeyCheck> {
  return provider === "gemini" ? checkGeminiKey(key) : checkOpenAiKey(key);
}

function parseModels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

export function toKeyState(provider: AiKeyProvider, row: AiKeyRow | null | undefined): AiKeyState {
  if (!row) {
    return {
      provider,
      configured: false,
      hint: null,
      valid: null,
      checkedAt: null,
      detail: null,
      models: [],
      updatedAt: null,
    };
  }
  return {
    provider,
    configured: true,
    hint: row.hint,
    valid: row.valid ?? null,
    checkedAt: row.checkedAt ? row.checkedAt.toISOString() : null,
    detail: row.detail,
    models: parseModels(row.models),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadKeyRow(db: Db, provider: AiKeyProvider): Promise<AiKeyRow | null> {
  return (await db.query.aiKeys.findFirst({ where: eq(aiKeys.provider, provider) })) ?? null;
}

export async function saveKey(
  db: Db,
  env: VaultEnv,
  provider: AiKeyProvider,
  key: string,
  check: KeyCheck,
): Promise<AiKeyRow> {
  const sealed = await encryptSetting(env, settingName(provider), key);
  const now = new Date();
  const values = {
    ciphertext: sealed.ciphertext,
    iv: sealed.iv,
    keyVersion: sealed.keyVersion,
    hint: keyHint(key),
    valid: check.valid,
    checkedAt: now,
    detail: check.detail,
    models: JSON.stringify(check.models),
    updatedAt: now,
  };
  await db
    .insert(aiKeys)
    .values({ provider, ...values, createdAt: now })
    .onConflictDoUpdate({ target: aiKeys.provider, set: values });
  return (await loadKeyRow(db, provider)) as AiKeyRow;
}

export async function recordCheck(
  db: Db,
  provider: AiKeyProvider,
  check: KeyCheck,
): Promise<AiKeyRow | null> {
  const now = new Date();
  await db
    .update(aiKeys)
    .set({
      valid: check.valid,
      checkedAt: now,
      detail: check.detail,
      // An unreachable service keeps the model list of the last good check.
      ...(check.valid === null ? {} : { models: JSON.stringify(check.models) }),
      updatedAt: now,
    })
    .where(eq(aiKeys.provider, provider));
  return loadKeyRow(db, provider);
}

/** The plaintext key, or null when there is none or the vault cannot open it. */
export async function openKey(
  env: VaultEnv,
  provider: AiKeyProvider,
  row: AiKeyRow | null,
): Promise<string | null> {
  if (!row) return null;
  try {
    return await decryptSetting(env, settingName(provider), {
      ciphertext: row.ciphertext,
      iv: row.iv,
      keyVersion: row.keyVersion,
    });
  } catch {
    return null;
  }
}

// --- spend --------------------------------------------------------------------------------------

/** Start of the caller's local day and month as UTC ms (`tzOffset` = `getTimezoneOffset()`). */
export function periodStarts(nowMs: number, tzOffset: number): { day: number; month: number } {
  const shift = tzOffset * 60_000;
  const local = new Date(nowMs - shift);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  return { day: Date.UTC(y, m, d) + shift, month: Date.UTC(y, m, 1) + shift };
}

export function emptyTotals(): AiSpendTotals {
  return {
    costUsd: 0,
    calls: 0,
    unpricedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    thoughtsTokens: 0,
  };
}

/** Sum per-model rows (SQLite sums come back as numbers or null). */
export function sumTotals(rows: readonly AiSpendTotals[]): AiSpendTotals {
  const out = emptyTotals();
  for (const r of rows) {
    out.costUsd += r.costUsd;
    out.calls += r.calls;
    out.unpricedCalls += r.unpricedCalls;
    out.inputTokens += r.inputTokens;
    out.outputTokens += r.outputTokens;
    out.thoughtsTokens += r.thoughtsTokens;
  }
  out.costUsd = roundUsd(out.costUsd);
  return out;
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function toTotals(row: {
  costUsd: number | null;
  calls: number | null;
  unpricedCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  thoughtsTokens: number | null;
}): AiSpendTotals {
  return {
    costUsd: roundUsd(Number(row.costUsd ?? 0)),
    calls: Number(row.calls ?? 0),
    unpricedCalls: Number(row.unpricedCalls ?? 0),
    inputTokens: Number(row.inputTokens ?? 0),
    outputTokens: Number(row.outputTokens ?? 0),
    thoughtsTokens: Number(row.thoughtsTokens ?? 0),
  };
}

/** Budget state; warns from 80 % of the budget on. */
export function budgetState(monthlyUsd: number | null, spentUsd: number): AiBudget {
  if (monthlyUsd === null) {
    return { monthlyUsd: null, remainingUsd: null, usedPercent: null, warning: false };
  }
  const usedPercent =
    monthlyUsd > 0 ? Math.round((spentUsd / monthlyUsd) * 1000) / 10 : spentUsd > 0 ? 100 : 0;
  return {
    monthlyUsd,
    remainingUsd: roundUsd(monthlyUsd - spentUsd),
    usedPercent,
    warning: usedPercent >= 80,
  };
}

export function sortModels(rows: AiSpendModel[]): AiSpendModel[] {
  return [...rows].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
}

export async function loadBudget(db: Db): Promise<number | null> {
  const row = await db.query.aiSettings.findFirst({ where: eq(aiSettings.id, SETTINGS_ID) });
  return row?.geminiMonthlyBudgetUsd ?? null;
}

export async function saveBudget(db: Db, monthlyUsd: number | null): Promise<void> {
  const now = new Date();
  await db
    .insert(aiSettings)
    .values({ id: SETTINGS_ID, geminiMonthlyBudgetUsd: monthlyUsd, updatedAt: now })
    .onConflictDoUpdate({
      target: aiSettings.id,
      set: { geminiMonthlyBudgetUsd: monthlyUsd, updatedAt: now },
    });
}
