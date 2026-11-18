// Time and cost before a big job (N4): generating a plan or applying one instruction to many
// posts asks first when more than ESTIMATE_CONFIRM_THRESHOLD posts are involved. The figures come
// from the API (`GET /api/estimates/generation`): measured from the last generations on this Mac
// and the recorded AI spend, or dated defaults when there is no history yet.
import {
  ESTIMATE_CONFIRM_THRESHOLD,
  type GenerationEstimate,
  type GenerationEstimateQuery,
} from "@studio/contract";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Spinner } from "../../components/ui/controls.tsx";
import { Dialog } from "../../components/ui/dialog.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { formatUsd } from "../../lib/spend.ts";

/** Whether `count` posts need the estimate and a confirmation first. */
export function needsEstimate(count: number): boolean {
  return count > ESTIMATE_CONFIRM_THRESHOLD;
}

/** "≈ 12 dakika", "≈ 1 saat 40 dakika", "1 dakikadan kısa". */
export function durationText(seconds: number): string {
  if (seconds < 60) return "1 dakikadan kısa";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `≈ ${minutes} dakika`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `≈ ${hours} saat ${rest} dakika` : `≈ ${hours} saat`;
}

/** The one line: "≈ 36 dakika, ≈ $0 (Claude aboneliği: ücretsiz; Gemini görselleri: …)". */
export function estimateLine(e: GenerationEstimate): string {
  const text =
    e.perItemUsd > 0
      ? `yapay zekâ metinleri ≈ ${formatUsd(e.textUsd)}`
      : "Claude aboneliği: ücretsiz";
  const images =
    e.imageSlots === 0
      ? "Gemini görselleri: yok"
      : e.imagesIncluded
        ? `Gemini görselleri: ${e.imageSlots} × ${formatUsd(e.perImageUsd)} ≈ ${formatUsd(e.imageUsd)}`
        : `Gemini görselleri: bu üretimde yapılmaz (${e.imageSlots} görsel ayrıca üretilirse ≈ ${formatUsd(e.imageUsd)})`;
  return `${durationText(e.totalSeconds)}, ≈ ${formatUsd(e.totalUsd)} (${text}; ${images})`;
}

/** Where the figures come from. */
export function basisLine(e: GenerationEstimate): string {
  return e.basis === "history"
    ? `Bu Mac'teki son ${e.sampleSize} üretimden ölçüldü; post başına ${durationText(e.perItemSeconds).replace("≈ ", "")}.`
    : `Henüz ölçüm yok; varsayılan değerler (${e.defaultsAsOf}). Post başına ${durationText(e.perItemSeconds).replace("≈ ", "")}.`;
}

export function budgetLine(e: GenerationEstimate): string | null {
  if (e.budgetRemainingUsd === null) return null;
  return e.budgetRemainingUsd < e.totalUsd
    ? `Bu ayın yapay zekâ bütçesi yetmeyebilir: kalan ${formatUsd(Math.max(0, e.budgetRemainingUsd))}.`
    : `Bu ayın kalan yapay zekâ bütçesi: ${formatUsd(e.budgetRemainingUsd)}.`;
}

export function useGenerationEstimate(query: GenerationEstimateQuery | null) {
  const api = useApi();
  return useQuery({
    queryKey: ["estimate", "generation", query],
    queryFn: () => api.estimates.generation(query as GenerationEstimateQuery),
    enabled: query !== null,
    staleTime: 60_000,
  });
}

/**
 * The confirmation before a big job: the estimate, then "Başlat". `query` null keeps it closed.
 * An estimate that cannot be read does not block: the user may still start.
 */
export function EstimateDialog({
  query,
  title,
  what,
  confirmLabel = "Başlat",
  onConfirm,
  onClose,
}: {
  query: GenerationEstimateQuery | null;
  title: string;
  /** "30 post üretilecek." */
  what: string;
  confirmLabel?: string;
  onConfirm(): Promise<void> | void;
  onClose(): void;
}) {
  const estimate = useGenerationEstimate(query);
  const [busy, setBusy] = useState(false);
  const e = estimate.data;
  const budget = e ? budgetLine(e) : null;
  return (
    <Dialog
      open={query !== null}
      title={title}
      onClose={() => {
        if (!busy) onClose();
      }}
      width={480}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Vazgeç
          </Button>
          <Button
            variant="primary"
            data-autofocus=""
            disabled={busy || estimate.isLoading}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Başlatılıyor…" : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-body">
        <p className="text-fg">{what}</p>
        {estimate.isLoading && (
          <p className="flex items-center gap-2 text-fg-2">
            <Spinner size={12} /> Süre ve maliyet hesaplanıyor…
          </p>
        )}
        {e && (
          <>
            <p className="selectable font-medium text-fg">{estimateLine(e)}</p>
            <p className="text-footnote text-fg-2">{basisLine(e)}</p>
            {budget && <p className="text-footnote text-fg-2">{budget}</p>}
          </>
        )}
        {estimate.error && (
          <p className="text-footnote text-fg-2">
            Tahmin okunamadı ({describeError(estimate.error)}); yine de başlatabilirsin.
          </p>
        )}
      </div>
    </Dialog>
  );
}
