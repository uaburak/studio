// Paid AI spend (roadmap 11, U8): Gemini, OpenAI and ElevenLabs. The summary query and its
// wording for Ayarlar → Kullanım and the usage card under the Claude limits. The amounts are the
// worker's estimate (tokens or characters × its pricing tables), in USD; the monthly budget
// covers every paid service. The Gemini API has no balance endpoint.
import type { AiSpendModel, AiSpendProviderTotals, AiSpendSummary } from "@studio/contract";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { isHostUp, useHost } from "../state/studio.tsx";
import { ApiContext, useApi } from "./api.ts";

export const spendKey = ["ai", "spend"] as const;

/** `$0.0042`, `$1.27`, `$12.40` (more digits below a dollar so small spends are visible). */
export function formatUsd(value: number): string {
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  const digits = abs < 0.01 ? 4 : abs < 1 ? 3 : 2;
  return `${value < 0 ? "-" : ""}$${abs.toFixed(digits)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
}

/** "Bugün $0.042 · bu ay $1.27" plus a budget line. */
export function spendHeadline(spend: AiSpendSummary): string {
  return `Bugün ${formatUsd(spend.today.costUsd)} · bu ay ${formatUsd(spend.month.costUsd)}`;
}

export function budgetLine(spend: AiSpendSummary): string | null {
  const b = spend.budget;
  if (b.monthlyUsd === null || b.remainingUsd === null) return null;
  const used = b.usedPercent !== null ? ` (%${Math.round(b.usedPercent)} kullanıldı)` : "";
  return b.remainingUsd < 0
    ? `Bütçe aşıldı: ${formatUsd(-b.remainingUsd)} fazla${used}`
    : `Kalan bütçe ${formatUsd(b.remainingUsd)} / ${formatUsd(b.monthlyUsd)}${used}`;
}

/** Calls whose model is not in the pricing table are counted but not priced. */
export function unpricedNote(spend: AiSpendSummary): string | null {
  return spend.month.unpricedCalls > 0
    ? `${spend.month.unpricedCalls} çağrının modeli fiyat tablosunda yok (tutara dahil değil).`
    : null;
}

export const EXHAUSTED_TEXT = "Bütçe doldu: ücretli yapay zekâ çağrıları durduruldu.";

/** Set when "Bütçe dolunca dur" is on and the month's spend reached the budget. */
export function exhaustedNote(spend: AiSpendSummary): string | null {
  return spend.budget.exhausted === true ? EXHAUSTED_TEXT : null;
}

/** The budget row's message: used up (stopped), else the 80 % warning. */
export function budgetNotice(spend: AiSpendSummary): string | null {
  return exhaustedNote(spend) ?? (spend.budget.warning ? "Aylık bütçenin %80'i aşıldı." : null);
}

// --- per service ----------------------------------------------------------------------------------

/** The paid services the budget covers, in the order the owner reads them. */
export const PAID_SERVICES = ["gemini", "openai", "elevenlabs"] as const;

const SERVICE_LABELS: Record<string, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  elevenlabs: "ElevenLabs",
  claude: "Claude",
  codex: "Codex",
  antigravity: "Antigravity",
};

/** "OpenAI"; an unknown service keeps its own name. */
export function serviceLabel(provider: string): string {
  return SERVICE_LABELS[provider] ?? provider;
}

/**
 * This month per service: the API's `byProvider` (most expensive first), else (an older API that
 * counted Gemini only) the month as Gemini.
 */
export function serviceTotals(spend: AiSpendSummary): AiSpendProviderTotals[] {
  return spend.byProvider ?? [{ provider: "gemini", ...spend.month }];
}

/**
 * "OpenAI — $3.00 · 2 çağrı", one line per paid service (the ones without calls this month say
 * "harcama yok"), the most expensive first.
 */
export function serviceSpendLines(spend: AiSpendSummary): string[] {
  const totals = serviceTotals(spend);
  const shown = new Set(totals.map((t) => t.provider as string));
  const lines = totals.map(
    (t) => `${serviceLabel(t.provider)} — ${formatUsd(t.costUsd)} · ${t.calls} çağrı`,
  );
  for (const provider of PAID_SERVICES) {
    if (!shown.has(provider)) lines.push(`${serviceLabel(provider)} — harcama yok`);
  }
  return lines;
}

/**
 * "gemini-2.5-flash — $0.42 · 18 çağrı · 120K giriş / 8K çıkış"; ElevenLabs counts characters
 * ("eleven_multilingual_v2 — $0.25 · 2 çağrı · 12K karakter").
 */
export function modelSpendLine(m: AiSpendModel): string {
  const head = `${m.model} — ${formatUsd(m.costUsd)} · ${m.calls} çağrı`;
  if (m.provider === "elevenlabs") return `${head} · ${formatTokens(m.inputTokens)} karakter`;
  return `${head} · ${formatTokens(m.inputTokens)} giriş / ${formatTokens(m.outputTokens + m.thoughtsTokens)} çıkış`;
}

// --- budget input -----------------------------------------------------------------------------------

export type BudgetInput = { ok: true; value: number | null } | { ok: false; error: string };

/** The budget field: empty = no budget; "12,5" and "12.5" are both 12.5 USD. */
export function parseBudgetInput(raw: string): BudgetInput {
  const text = raw.trim().replace(",", ".");
  if (text === "") return { ok: true, value: null };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000) {
    return { ok: false, error: "Bütçe 0 ya da daha büyük bir sayı olmalı (USD)." };
  }
  return { ok: true, value };
}

// --- query --------------------------------------------------------------------------------------

export function useAiSpend(enabled = true) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: spendKey,
    queryFn: () => api.ai.spend({ tzOffset: new Date().getTimezoneOffset() }),
    enabled: up && enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

/** Older name (the usage card under the Claude limits); the summary covers every paid service. */
export const useGeminiSpend = useAiSpend;

/** True where the spend query can run (the app; not bare component previews or tests). */
export function useSpendAvailable(): boolean {
  return useContext(ApiContext) !== null && useContext(QueryClientContext) !== undefined;
}
