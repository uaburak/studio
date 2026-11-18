// Pure helpers of the statistics views (N15): numbers in Turkish, the heatmap's levels, follower
// changes, read times and account states in words.
import type {
  EngagementSyncState,
  InsightMetricKey,
  InsightMetrics,
  PostInsight,
} from "@studio/contract";

const COMPACT = new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 });
const PLAIN = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });

/** 950 → "950", 12 345 → "12,3 B". */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return Math.abs(value) >= 10_000 ? COMPACT.format(value) : PLAIN.format(value);
}

/** 0.0542 → "%5,4". */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  return `%${(rate * 100).toFixed(1).replace(".", ",")}`;
}

/** Relative engagement: 1.4 → "1,40×" (1,00× = the brand's typical post). */
export function formatIndex(index: number | null | undefined): string {
  if (index === null || index === undefined || !Number.isFinite(index)) return "—";
  return `${index.toFixed(2).replace(".", ",")}×`;
}

/** Order the metrics are listed in. */
export const METRIC_ORDER: readonly InsightMetricKey[] = [
  "reach",
  "views",
  "plays",
  "likes",
  "comments",
  "saves",
  "shares",
  "clicks",
  "interactions",
  "avgWatchMs",
];

export function formatMetric(key: InsightMetricKey, value: number | undefined): string {
  if (value === undefined) return "—";
  if (key === "avgWatchMs") return `${(value / 1000).toFixed(1).replace(".", ",")} sn`;
  return formatCount(value);
}

/** The metrics a post has, in display order. */
export function metricEntries(metrics: InsightMetrics): [InsightMetricKey, number][] {
  return METRIC_ORDER.filter((k) => typeof metrics[k] === "number").map((k) => [
    k,
    metrics[k] as number,
  ]);
}

/** A read's age after publishing: "1. saat", "24. saat", "3. gün". */
export function hoursLabel(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return "—";
  if (hours < 1.5) return "1. saat";
  if (hours < 36) return `${Math.round(hours)}. saat`;
  return `${Math.round(hours / 24)}. gün`;
}

/** Min and max of the grid's values (null: empty grid). */
export function gridRange(grid: readonly (readonly (number | null)[])[]): {
  min: number;
  max: number;
} | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const row of grid)
    for (const v of row) {
      if (v === null || !Number.isFinite(v)) continue;
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  return Number.isFinite(min) ? { min, max } : null;
}

/** 0 (nothing published) or 1–4 (weakest → strongest within the grid). */
export function heatLevel(
  value: number | null,
  range: { min: number; max: number } | null,
): 0 | 1 | 2 | 3 | 4 {
  if (value === null || !range) return 0;
  if (range.max === range.min) return 2;
  const t = (value - range.min) / (range.max - range.min);
  return t >= 0.75 ? 4 : t >= 0.5 ? 3 : t >= 0.25 ? 2 : 1;
}

/** Follower count now and its change over the points. */
export function followerChange(points: readonly { followers: number }[]): {
  last: number | null;
  delta: number | null;
} {
  const first = points[0];
  const last = points.at(-1);
  if (!last) return { last: null, delta: null };
  return {
    last: last.followers,
    delta: first && points.length > 1 ? last.followers - first.followers : null,
  };
}

/** "+12" / "−3" / "0". */
export function signed(value: number): string {
  if (value > 0) return `+${formatCount(value)}`;
  if (value < 0) return `−${formatCount(-value)}`;
  return "0";
}

/** "az önce", "5 dk önce", "3 sa önce", "2 gün önce". */
export function ago(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "henüz okunmadı";
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "az önce";
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} dk önce`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} sa önce`;
  return `${Math.round(h / 24)} gün önce`;
}

/** An account's statistics / comment reads in one line. */
export function syncStateText(s: EngagementSyncState, now: Date = new Date()): string {
  if (s.needsReconnect)
    return "Yeniden bağlayın: istatistik ve yorum izinleri eksik ya da erişim anahtarı geçersiz (Ayarlar → Hesaplar).";
  if (s.retryAt)
    return `Meta istek sınırı: ${new Date(s.retryAt).toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
    })} sonrası yeniden okunacak.`;
  if (s.error) return s.error;
  return `Son okuma: ${ago(s.insightsSyncedAt, now)}`;
}

/** Status of one post's numbers in words (null: nothing to say). */
export function insightStatusText(p: Pick<PostInsight, "status" | "note">): string | null {
  switch (p.status) {
    case "pending":
      return "Henüz okunmadı; yayından bir saat sonra okunur.";
    case "partial":
      return p.note ?? "Yalnızca beğeni ve yorum sayıları okunabildi.";
    case "deleted":
      return "Gönderi platformda bulunamadı; silinmiş görünüyor.";
    case "error":
      return p.note ?? "Son okuma başarısız; yeniden denenecek.";
    default:
      return p.note;
  }
}
