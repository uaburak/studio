import { z } from "zod";
import { EntityId, Platform, Timestamp } from "./common.ts";
import { ContentType } from "./content.ts";

/**
 * Post statistics (N15). The Mac's worker reads them from Instagram and Facebook (`insights.sync`)
 * one hour, one day and three days after a post is published, then daily for 90 days; each read
 * is kept as a snapshot (history) and the latest is the post's current numbers. Follower counts
 * are read daily per account. LinkedIn member posts are not read: LinkedIn gives personal
 * profiles almost no statistics through its API.
 *
 * Everything is computed on the Mac from what was read: per-brand summaries (top posts, pillars,
 * formats, weekday and hour), the best-time grid and suggested slots, and the short performance
 * summary the plan agent and the brand analysis read.
 */

/** Days after publishing during which a post's statistics are still read. */
export const INSIGHTS_MAX_AGE_DAYS = 90;
/** Reads after publishing (hours); then once a day. */
export const INSIGHTS_CHECKPOINT_HOURS = [1, 24, 72] as const;
/** Comments are read for posts published within this many days. */
export const COMMENTS_MAX_AGE_DAYS = 30;
/** How often the comment inbox is refreshed while the Mac is on (minutes). */
export const COMMENTS_SYNC_MINUTES = 15;

/** Studio's time zone for weekdays, hours and days (Türkiye, UTC+3 all year). */
export const STUDIO_UTC_OFFSET_HOURS = 3;

export const InsightMetricKey = z
  .enum([
    "reach",
    "views",
    "likes",
    "comments",
    "saves",
    "shares",
    "interactions",
    "plays",
    "clicks",
    "avgWatchMs",
  ])
  .meta({ id: "InsightMetricKey" });
export type InsightMetricKey = z.infer<typeof InsightMetricKey>;

const Metric = z.number().min(0);
/** Missing keys: the platform does not give that number for the post. */
export const InsightMetrics = z
  .object({
    reach: Metric.optional(),
    views: Metric.optional(),
    likes: Metric.optional(),
    comments: Metric.optional(),
    saves: Metric.optional(),
    shares: Metric.optional(),
    interactions: Metric.optional(),
    plays: Metric.optional(),
    clicks: Metric.optional(),
    avgWatchMs: Metric.optional(),
  })
  .meta({ id: "InsightMetrics" });
export type InsightMetrics = z.infer<typeof InsightMetrics>;

export const METRIC_LABEL: Record<InsightMetricKey, string> = {
  reach: "Erişim",
  views: "Görüntülenme",
  likes: "Beğeni",
  comments: "Yorum",
  saves: "Kaydetme",
  shares: "Paylaşım",
  interactions: "Etkileşim",
  plays: "Oynatma",
  clicks: "Tıklama",
  avgWatchMs: "Ort. izlenme",
};

/**
 * `pending`: not read yet; `ok`; `partial`: counts only (statistics permission missing or
 * refused); `deleted`: the post is gone on the platform (read twice to be sure); `error`: the last
 * read failed (it is tried again).
 */
export const PostInsightStatus = z
  .enum(["pending", "ok", "partial", "deleted", "error"])
  .meta({ id: "PostInsightStatus" });
export type PostInsightStatus = z.infer<typeof PostInsightStatus>;

/** Interactions (or likes + comments + saves + shares) per reach, 0–1; null without reach. */
export function engagementRate(m: InsightMetrics): number | null {
  const reach = m.reach ?? m.views;
  if (!reach) return null;
  const interactions =
    m.interactions ?? (m.likes ?? 0) + (m.comments ?? 0) + (m.saves ?? 0) + (m.shares ?? 0);
  return Math.min(1, interactions / reach);
}

/** Interactions for ranking when reach is unknown (saves and shares weigh more). */
export function interactionScore(m: InsightMetrics): number {
  return (m.likes ?? 0) + 2 * (m.comments ?? 0) + 3 * (m.saves ?? 0) + 3 * (m.shares ?? 0);
}

/** One published post (a schedule) and its latest numbers. */
export const PostInsight = z
  .object({
    scheduleId: EntityId,
    contentId: EntityId,
    brandId: EntityId,
    socialAccountId: EntityId,
    platform: Platform,
    /** Platform id the numbers belong to (IG media id, FB post / video id). */
    externalPostId: z.string(),
    contentType: ContentType,
    publishedAt: Timestamp.nullable(),
    permalink: z.string().nullable(),
    status: PostInsightStatus,
    metrics: InsightMetrics,
    engagementRate: z.number().min(0).max(1).nullable(),
    /** Why the numbers are partial or missing (Turkish). */
    note: z.string().nullable(),
    syncedAt: Timestamp.nullable(),
    nextSyncAt: Timestamp.nullable(),
  })
  .meta({ id: "PostInsight" });
export type PostInsight = z.infer<typeof PostInsight>;

export const InsightSnapshot = z
  .object({
    at: Timestamp,
    /** Hours between publishing and this read. */
    hoursAfterPublish: z.number().min(0).nullable(),
    metrics: InsightMetrics,
  })
  .meta({ id: "InsightSnapshot" });
export type InsightSnapshot = z.infer<typeof InsightSnapshot>;

/** `GET /api/contents/{id}/performance`: every account the post went to, with its history. */
export const ContentPerformance = z
  .object({
    contentId: EntityId,
    posts: z.array(
      PostInsight.extend({
        accountHandle: z.string(),
        snapshots: z.array(InsightSnapshot),
      }),
    ),
    /** Sum over accounts (keys present in at least one). */
    totals: InsightMetrics,
    /** Accounts that must be reconnected to read statistics (missing permission, token). */
    needsReconnect: z.array(EntityId),
  })
  .meta({ id: "ContentPerformance" });
export type ContentPerformance = z.infer<typeof ContentPerformance>;

// --- per-brand performance page ---------------------------------------------------------------

export const PerformanceQuery = z.object({
  days: z.coerce.number().int().min(7).max(365).default(90),
  platform: Platform.optional(),
});
export type PerformanceQuery = z.input<typeof PerformanceQuery>;

export const PerformancePost = z
  .object({
    scheduleId: EntityId,
    contentId: EntityId,
    title: z.string(),
    platform: Platform,
    contentType: ContentType,
    pillar: z.string().nullable(),
    hook: z.string().nullable(),
    publishedAt: Timestamp.nullable(),
    permalink: z.string().nullable(),
    metrics: InsightMetrics,
    engagementRate: z.number().nullable(),
    /** Relative to the brand's median engagement in the period (1 = typical). */
    score: z.number(),
  })
  .meta({ id: "PerformancePost" });
export type PerformancePost = z.infer<typeof PerformancePost>;

/** A group (pillar, format, weekday, hour): its posts and average numbers. */
export const PerformanceGroup = z
  .object({
    key: z.string(),
    label: z.string(),
    posts: z.number().int().min(0),
    avgReach: z.number().nullable(),
    avgEngagementRate: z.number().nullable(),
    /** Average score (1 = the brand's typical post). */
    index: z.number().nullable(),
  })
  .meta({ id: "PerformanceGroup" });
export type PerformanceGroup = z.infer<typeof PerformanceGroup>;

export const BestTimeSlot = z
  .object({
    /** 0 = Monday … 6 = Sunday (Türkiye time). */
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    /** Relative score (1 = typical); null for the general suggestions. */
    score: z.number().nullable(),
    /** Posts behind it (weighted). */
    posts: z.number().min(0),
  })
  .meta({ id: "BestTimeSlot" });
export type BestTimeSlot = z.infer<typeof BestTimeSlot>;

export const BestTimes = z
  .object({
    /** `own`: from the brand's posts; `general`: too few posts yet, common good times. */
    basis: z.enum(["own", "general"]),
    /** Posts with numbers behind the grid. */
    sampleSize: z.number().int().min(0),
    /** [weekday][hour] average relative score, null where no post was published. */
    grid: z.array(z.array(z.number().nullable()).length(24)).length(7),
    /** [weekday][hour] weighted post counts. */
    counts: z.array(z.array(z.number().min(0)).length(24)).length(7),
    suggestions: z.array(BestTimeSlot),
    /** Turkish one-liner for the UI ("Son 90 günün 24 postuna göre"). */
    note: z.string(),
  })
  .meta({ id: "BestTimes" });
export type BestTimes = z.infer<typeof BestTimes>;

export const BestTimesQuery = z.object({
  platform: Platform.optional(),
  days: z.coerce.number().int().min(14).max(365).default(180),
});
export type BestTimesQuery = z.input<typeof BestTimesQuery>;

export const FollowerSeries = z
  .object({
    socialAccountId: EntityId,
    platform: Platform,
    handle: z.string(),
    points: z.array(z.object({ day: z.iso.date(), followers: z.number().int().min(0) })),
  })
  .meta({ id: "FollowerSeries" });
export type FollowerSeries = z.infer<typeof FollowerSeries>;

export const PerformanceTrendPoint = z
  .object({
    /** Monday of the week (Türkiye time). */
    week: z.iso.date(),
    posts: z.number().int().min(0),
    reach: z.number().min(0),
    interactions: z.number().min(0),
    avgEngagementRate: z.number().nullable(),
  })
  .meta({ id: "PerformanceTrendPoint" });
export type PerformanceTrendPoint = z.infer<typeof PerformanceTrendPoint>;

export const EngagementSyncState = z
  .object({
    socialAccountId: EntityId,
    platform: Platform,
    handle: z.string(),
    insightsSyncedAt: Timestamp.nullable(),
    commentsSyncedAt: Timestamp.nullable(),
    /** Last problem (Turkish), null when the last reads worked. */
    error: z.string().nullable(),
    /** Missing permission or invalid token: the owner must reconnect the account. */
    needsReconnect: z.boolean(),
    /** Meta's rate limit: nothing is read before this. */
    retryAt: Timestamp.nullable(),
  })
  .meta({ id: "EngagementSyncState" });
export type EngagementSyncState = z.infer<typeof EngagementSyncState>;

/** `GET /api/brands/{id}/performance`. */
export const BrandPerformance = z
  .object({
    brandId: EntityId,
    from: Timestamp,
    to: Timestamp,
    posts: z.number().int().min(0),
    totals: InsightMetrics,
    avgReach: z.number().nullable(),
    avgEngagementRate: z.number().nullable(),
    topPosts: z.array(PerformancePost),
    byPillar: z.array(PerformanceGroup),
    byFormat: z.array(PerformanceGroup),
    byWeekday: z.array(PerformanceGroup),
    byHour: z.array(PerformanceGroup),
    trend: z.array(PerformanceTrendPoint),
    followers: z.array(FollowerSeries),
    bestTimes: BestTimes,
    accounts: z.array(EngagementSyncState),
  })
  .meta({ id: "BrandPerformance" });
export type BrandPerformance = z.infer<typeof BrandPerformance>;

/** Body of `POST /api/insights/sync`: read now (one post, one brand, or everything due). */
export const InsightsSyncInput = z
  .object({
    brandId: EntityId.optional(),
    contentId: EntityId.optional(),
  })
  .meta({ id: "InsightsSyncInput" });
export type InsightsSyncInput = z.input<typeof InsightsSyncInput>;

// --- planning feedback ---------------------------------------------------------------------------

/**
 * What worked, in a few lines: the plan agent (`<gecmis_ozeti>`) and the brand analysis read it.
 * `index` is relative engagement (1 = the brand's typical post, 1.4 = 40 % better).
 */
export const PerformanceSummary = z
  .object({
    from: z.iso.date(),
    to: z.iso.date(),
    posts: z.number().int().min(0),
    avgReach: z.number().nullable(),
    avgEngagementRate: z.number().nullable(),
    pillars: z.array(z.object({ name: z.string(), posts: z.number().int(), index: z.number() })),
    formats: z.array(z.object({ type: ContentType, posts: z.number().int(), index: z.number() })),
    /** Best posts: title, opening line, relative engagement. */
    top: z.array(
      z.object({
        title: z.string(),
        hook: z.string().nullable(),
        pillar: z.string().nullable(),
        type: ContentType,
        index: z.number(),
      }),
    ),
    /** Weakest posts, so their angle is not repeated. */
    weak: z.array(
      z.object({
        title: z.string(),
        hook: z.string().nullable(),
        pillar: z.string().nullable(),
        type: ContentType,
        index: z.number(),
      }),
    ),
    bestSlots: z.array(BestTimeSlot),
  })
  .meta({ id: "PerformanceSummary" });
export type PerformanceSummary = z.infer<typeof PerformanceSummary>;

export const WEEKDAY_TR = [
  "Pazartesi",
  "Salı",
  "Çarşamba",
  "Perşembe",
  "Cuma",
  "Cumartesi",
  "Pazar",
] as const;

/** Weekday (0 = Monday) and hour of a moment in Türkiye time. */
export function localSlot(at: Date | string | number): { weekday: number; hour: number } {
  const t = new Date(at).getTime() + STUDIO_UTC_OFFSET_HOURS * 3_600_000;
  const d = new Date(t);
  return { weekday: (d.getUTCDay() + 6) % 7, hour: d.getUTCHours() };
}

/** Median of the positive numbers (null when there are none). */
export function median(values: readonly number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
}

/**
 * A post's relative score: its engagement rate over the brand's median (1 = typical). Without
 * reach (counts only) the interaction score over its median is used.
 */
export function relativeScores(posts: readonly { metrics: InsightMetrics }[]): number[] {
  const rates = posts.map((p) => engagementRate(p.metrics));
  const rateMedian = median(rates.filter((r): r is number => r !== null && r > 0));
  const scores = posts.map((p) => interactionScore(p.metrics));
  const scoreMedian = median(scores.filter((s) => s > 0));
  return posts.map((_, i) => {
    const rate = rates[i];
    if (rate !== null && rate !== undefined && rateMedian) return rate / rateMedian;
    const s = scores[i] ?? 0;
    return scoreMedian ? s / scoreMedian : 1;
  });
}

/** Posts needed before the brand's own data drives the suggestions. */
export const BEST_TIME_MIN_POSTS = 8;

/**
 * General good times when there is too little data (Türkiye, social feeds): weekday lunch and
 * evening, weekend late morning and evening.
 */
export const GENERAL_BEST_SLOTS: readonly { weekday: number; hour: number }[] = [
  { weekday: 1, hour: 19 },
  { weekday: 3, hour: 12 },
  { weekday: 3, hour: 20 },
  { weekday: 4, hour: 19 },
  { weekday: 5, hour: 11 },
  { weekday: 6, hour: 20 },
];

/**
 * The hour × weekday grid and suggested slots from published posts and their relative scores.
 * A post counts fully in its hour and half in the hours next to it (few posts per cell). A slot is
 * suggested only where something was really published (and about two posts stand behind it),
 * ranked by its score pulled towards "typical" by one post's weight, so a lucky single post does
 * not win. Up to `max` slots, best first, at least two hours apart on the same day.
 */
export function computeBestTimes(
  posts: readonly { publishedAt: string; score: number }[],
  opts: { max?: number; minWeight?: number; days?: number } = {},
): BestTimes {
  const max = opts.max ?? 5;
  const minWeight = opts.minWeight ?? 1.5;
  const sum = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const weight = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const direct = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  for (const p of posts) {
    if (!Number.isFinite(p.score)) continue;
    const { weekday, hour } = localSlot(p.publishedAt);
    (direct[weekday] as number[])[hour] = ((direct[weekday] as number[])[hour] as number) + 1;
    for (const [dh, w] of [
      [0, 1],
      [-1, 0.5],
      [1, 0.5],
    ] as const) {
      const h = (hour + dh + 24) % 24;
      (sum[weekday] as number[])[h] = ((sum[weekday] as number[])[h] as number) + p.score * w;
      (weight[weekday] as number[])[h] = ((weight[weekday] as number[])[h] as number) + w;
    }
  }
  const grid = sum.map((row, d) =>
    row.map((s, h) => {
      const w = (weight[d] as number[])[h] as number;
      return w > 0 ? Math.round((s / w) * 100) / 100 : null;
    }),
  );
  const counts = weight.map((row) => row.map((w) => Math.round(w * 10) / 10));
  const sample = posts.filter((p) => Number.isFinite(p.score)).length;
  const daysText = opts.days ? `Son ${opts.days} günün` : "Yayınlanan";

  if (sample < BEST_TIME_MIN_POSTS) {
    return {
      basis: "general",
      sampleSize: sample,
      grid,
      counts,
      suggestions: GENERAL_BEST_SLOTS.slice(0, max).map((s) => ({ ...s, score: null, posts: 0 })),
      note:
        sample === 0
          ? "Henüz istatistiği okunmuş post yok; genel olarak iyi giden saatler öneriliyor."
          : `Yalnızca ${sample} postun istatistiği var; en az ${BEST_TIME_MIN_POSTS} post olunca markanın kendi saatleri önerilecek. Şimdilik genel saatler.`,
    };
  }
  const cells: (BestTimeSlot & { rank: number })[] = [];
  for (let d = 0; d < 7; d++)
    for (let h = 0; h < 24; h++) {
      const w = (weight[d] as number[])[h] as number;
      const v = (grid[d] as (number | null)[])[h];
      if (v === null || v === undefined || w < minWeight) continue;
      if (((direct[d] as number[])[h] as number) < 1) continue;
      const s = (sum[d] as number[])[h] as number;
      cells.push({
        weekday: d,
        hour: h,
        score: v,
        posts: Math.round(w * 10) / 10,
        rank: (s + 1) / (w + 1),
      });
    }
  cells.sort((a, b) => b.rank - a.rank || b.posts - a.posts);
  const picked: BestTimeSlot[] = [];
  for (const c of cells) {
    if (picked.length >= max) break;
    if (picked.some((p) => p.weekday === c.weekday && Math.abs(p.hour - c.hour) < 2)) continue;
    picked.push({ weekday: c.weekday, hour: c.hour, score: c.score, posts: c.posts });
  }
  return {
    basis: "own",
    sampleSize: sample,
    grid,
    counts,
    suggestions: picked,
    note: `${daysText} ${sample} postuna göre (Türkiye saati).`,
  };
}

/** "Salı 19:00". */
export function slotLabel(slot: { weekday: number; hour: number }): string {
  return `${WEEKDAY_TR[slot.weekday] ?? ""} ${String(slot.hour).padStart(2, "0")}:00`;
}

/** The next moment (UTC ISO) at a slot after `from`, at least `minLeadMs` ahead. */
export function nextSlotTime(
  slot: { weekday: number; hour: number },
  from: Date = new Date(),
  minLeadMs = 15 * 60_000,
): string {
  const offset = STUDIO_UTC_OFFSET_HOURS * 3_600_000;
  const local = new Date(from.getTime() + offset);
  const base = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), slot.hour);
  const today = (local.getUTCDay() + 6) % 7;
  for (let i = 0; i < 15; i++) {
    const day = (today + i) % 7;
    if (day !== slot.weekday) continue;
    const t = base + i * 86_400_000 - offset;
    if (t - from.getTime() >= minLeadMs) return new Date(t).toISOString();
  }
  return new Date(base + 7 * 86_400_000 - offset).toISOString();
}
