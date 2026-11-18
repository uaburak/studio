// Gemini API spend (roadmap 11): the summary query and its wording for Ayarlar → Kullanım and
// the usage card under the Claude limits. The amounts are the worker's estimate (tokens × the
// pricing table), in USD; the Gemini API has no balance endpoint.
import type { AiSpendSummary } from "@studio/contract";
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

export function useGeminiSpend(enabled = true) {
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

/** True where the spend query can run (the app; not bare component previews or tests). */
export function useSpendAvailable(): boolean {
  return useContext(ApiContext) !== null && useContext(QueryClientContext) !== undefined;
}
