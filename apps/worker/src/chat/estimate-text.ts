/**
 * The time / cost line of a big generation's consent card (N4): "≈ 30 dakika, ≈ $0 (Claude
 * aboneliği: ücretsiz; Gemini görselleri: …)". Figures come from the API's estimate
 * (`GET /api/estimates/generation`), measured from this Mac's last generations.
 */
import type { GenerationEstimate } from "@studio/contract";

function usd(value: number): string {
  if (value === 0) return "$0";
  return `$${value < 0.1 ? value.toFixed(3) : value.toFixed(2)}`;
}

function duration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 90) return `${minutes} dakika`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} saat ${rest} dakika` : `${hours} saat`;
}

export function estimateLine(e: GenerationEstimate): string {
  const images =
    e.imageSlots === 0
      ? "yok"
      : e.imagesIncluded
        ? `${e.imageSlots} görsel ≈ ${usd(e.imageUsd)}`
        : `${e.imageSlots} yuva, bu üretimde yapılmaz (ayrıca üretilirse ≈ ${usd(e.imageUsd)})`;
  const notes = [`Claude aboneliği: ücretsiz`, `Gemini görselleri: ${images}`];
  if (e.budgetRemainingUsd !== null)
    notes.push(`aylık bütçeden kalan ${usd(e.budgetRemainingUsd)}`);
  const basis =
    e.basis === "default" ? ` Geçmiş üretim yok; ${e.defaultsAsOf} varsayımı kullanıldı.` : "";
  return `≈ ${duration(e.totalSeconds)}, ≈ ${usd(e.totalUsd)} (${notes.join("; ")}).${basis}`;
}
