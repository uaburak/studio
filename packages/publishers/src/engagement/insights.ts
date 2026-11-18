/**
 * Post and account statistics (N15), read with the same Graph client and version as publishing.
 *
 * Instagram media (`instagram_basic` + `instagram_manage_insights`):
 *   GET /{ig-media-id}?fields=like_count,comments_count,media_product_type   counts (basic)
 *   GET /{ig-media-id}/insights?metric=reach,saved,shares,views,total_interactions[,ig_reels_avg_watch_time]
 *   `impressions` and `plays` were retired by Meta (v22, 2025): `views` replaces both; for Reels
 *   `plays` is reported as the views. A metric Meta refuses falls back to a smaller set.
 * Facebook Page posts (`pages_read_engagement` + `read_insights`):
 *   GET /{post-id}?fields=shares,comments.limit(0).summary(true),reactions.limit(0).summary(true)
 *   GET /{post-id}/insights?metric=post_media_view,post_total_media_view_unique,post_clicks
 *       (fallback: post_impressions,post_impressions_unique,post_clicks)
 *   Reels and videos: GET /{video-id}/video_insights?metric=blue_reels_play_count,post_impressions_unique
 *       (videos: total_video_views,total_video_impressions_unique)
 * Accounts: GET /{ig-user-id}?fields=followers_count,media_count, GET /{page-id}?fields=followers_count,fan_count
 *
 * Docs: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights ,
 * https://developers.facebook.com/docs/graph-api/reference/insights ,
 * https://developers.facebook.com/docs/video-api/guides/insights
 */

import { GraphError } from "../errors.ts";
import type { GraphClient } from "../graph/client.ts";
import { classifyEngagementError, EngagementCallError, type EngagementError } from "./errors.ts";

/** What Studio keeps per post. Missing keys: not available for that post / platform. */
export type InsightMetric =
  | "reach"
  | "views"
  | "likes"
  | "comments"
  | "saves"
  | "shares"
  | "interactions"
  | "plays"
  | "clicks"
  | "avgWatchMs";

export type InsightMetrics = Partial<Record<InsightMetric, number>>;

export type InsightReadStatus =
  /** Counts and statistics were read. */
  | "ok"
  /** Counts only: the statistics call failed (permission, unsupported metric). */
  | "partial"
  /** The post is gone (deleted on the platform). */
  | "deleted";

export interface InsightRead {
  status: InsightReadStatus;
  metrics: InsightMetrics;
  /** Why it is partial (Turkish), when it is. */
  note: string | null;
  /** The statistics call's error, when there was one (permission → reconnect hint). */
  error: EngagementError | null;
}

interface InsightRow {
  name?: string;
  values?: { value?: unknown }[];
  total_value?: { value?: unknown };
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  // Breakdown objects ({ like: 3, love: 1 }): their sum.
  if (v && typeof v === "object") {
    const parts = Object.values(v as Record<string, unknown>).map(num);
    if (parts.length && parts.every((p) => p !== undefined))
      return parts.reduce<number>((a, b) => a + (b as number), 0);
  }
  return undefined;
}

/** `{ data: [{ name, values: [{ value }] | total_value: { value } }] }` → name → number. */
export function parseInsightRows(rows: InsightRow[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows ?? []) {
    if (!row.name) continue;
    const value = num(row.total_value?.value) ?? num(row.values?.at(-1)?.value);
    if (value !== undefined) out[row.name] = value;
  }
  return out;
}

const IG_METRICS: Record<string, InsightMetric> = {
  reach: "reach",
  views: "views",
  saved: "saves",
  shares: "shares",
  total_interactions: "interactions",
  ig_reels_avg_watch_time: "avgWatchMs",
};

const FB_METRICS: Record<string, InsightMetric> = {
  post_media_view: "views",
  post_total_media_view_unique: "reach",
  post_impressions: "views",
  post_impressions_unique: "reach",
  post_clicks: "clicks",
  blue_reels_play_count: "plays",
  total_video_views: "views",
  total_video_impressions_unique: "reach",
};

function mapRows(parsed: Record<string, number>, map: Record<string, InsightMetric>) {
  const out: InsightMetrics = {};
  for (const [name, value] of Object.entries(parsed)) {
    const key = map[name];
    if (key && out[key] === undefined) out[key] = value;
  }
  return out;
}

/** Try metric sets in order; the first Meta accepts wins. Permission errors stop at once. */
async function readMetricSets(
  graph: GraphClient,
  path: string,
  sets: string[][],
  token: string,
): Promise<{ rows: Record<string, number>; error: EngagementError | null }> {
  let last: EngagementError | null = null;
  for (const set of sets) {
    try {
      const res = await graph.get<{ data?: InsightRow[] }>(path, { metric: set.join(",") }, token);
      return { rows: parseInsightRows(res?.data), error: null };
    } catch (err) {
      if (!(err instanceof GraphError)) throw err;
      last = classifyEngagementError(err, [token]);
      // Only a refused metric is worth another set; anything else ends here.
      if (last.kind !== "invalid") break;
    }
  }
  return { rows: {}, error: last };
}

const PARTIAL_NOTE: Record<string, string> = {
  permission:
    "Yalnızca beğeni ve yorum sayıları okundu; erişim ve görüntülenme için hesabı yeniden bağlayıp istatistik iznini verin.",
  invalid: "Yalnızca beğeni ve yorum sayıları okundu; Meta bu gönderinin istatistiklerini vermedi.",
};

function partialNote(error: EngagementError | null): string {
  return (
    (error && PARTIAL_NOTE[error.kind]) ??
    "Yalnızca beğeni ve yorum sayıları okundu; istatistikler bir sonraki eşitlemede yeniden denenecek."
  );
}

/**
 * One Instagram media's counts and statistics. Throws for account-level problems (token,
 * rate limit, network) so the caller can stop for the account; a deleted media is a status.
 */
export async function readInstagramMediaInsights(
  graph: GraphClient,
  mediaId: string,
  token: string,
): Promise<InsightRead & { productType: string | null }> {
  let base: { like_count?: number; comments_count?: number; media_product_type?: string };
  try {
    base = await graph.get(
      `/${mediaId}`,
      { fields: "id,like_count,comments_count,media_product_type,media_type" },
      token,
    );
  } catch (err) {
    if (err instanceof GraphError && classifyEngagementError(err).kind === "deleted") {
      return { status: "deleted", metrics: {}, note: null, error: null, productType: null };
    }
    throw err;
  }
  const productType = base.media_product_type ?? null;
  const metrics: InsightMetrics = {};
  if (typeof base.like_count === "number") metrics.likes = base.like_count;
  if (typeof base.comments_count === "number") metrics.comments = base.comments_count;

  const reels = productType === "REELS";
  const story = productType === "STORY";
  const full = story
    ? ["reach", "views", "shares"]
    : ["reach", "saved", "shares", "views", "total_interactions"];
  if (reels) full.push("ig_reels_avg_watch_time");
  const { rows, error } = await readMetricSets(
    graph,
    `/${mediaId}/insights`,
    [full, ["reach", "saved", "shares"], ["reach"]],
    token,
  );
  if (error && (error.kind === "auth" || error.kind === "rate_limit" || error.kind === "transient"))
    throw new EngagementCallError(error);
  Object.assign(metrics, mapRows(rows, IG_METRICS));
  if (reels && metrics.views !== undefined) metrics.plays = metrics.views;
  const ok = Object.keys(rows).length > 0;
  return {
    status: ok ? "ok" : "partial",
    metrics,
    note: ok ? null : partialNote(error),
    error,
    productType,
  };
}

/**
 * One Facebook Page post (`{page-id}_{post-id}`) or Reel / video (`kind`) — counts and
 * statistics. Throws for account-level problems like `readInstagramMediaInsights`.
 */
export async function readFacebookPostInsights(
  graph: GraphClient,
  objectId: string,
  token: string,
  kind: "post" | "reel" | "video",
): Promise<InsightRead> {
  const video = kind !== "post";
  let base: {
    shares?: { count?: number };
    comments?: { summary?: { total_count?: number } };
    reactions?: { summary?: { total_count?: number } };
    likes?: { summary?: { total_count?: number } };
  };
  try {
    base = await graph.get(
      `/${objectId}`,
      {
        fields: video
          ? "id,comments.limit(0).summary(true),likes.limit(0).summary(true)"
          : "id,shares,comments.limit(0).summary(true),reactions.limit(0).summary(true)",
      },
      token,
    );
  } catch (err) {
    if (err instanceof GraphError && classifyEngagementError(err).kind === "deleted") {
      return { status: "deleted", metrics: {}, note: null, error: null };
    }
    throw err;
  }
  const metrics: InsightMetrics = {};
  const likes = base.reactions?.summary?.total_count ?? base.likes?.summary?.total_count;
  if (typeof likes === "number") metrics.likes = likes;
  const comments = base.comments?.summary?.total_count;
  if (typeof comments === "number") metrics.comments = comments;
  if (typeof base.shares?.count === "number") metrics.shares = base.shares.count;
  else if (!video) metrics.shares = 0;

  const sets = video
    ? kind === "reel"
      ? [["blue_reels_play_count", "post_impressions_unique"], ["blue_reels_play_count"]]
      : [["total_video_views", "total_video_impressions_unique"], ["total_video_views"]]
    : [
        ["post_media_view", "post_total_media_view_unique", "post_clicks"],
        ["post_impressions", "post_impressions_unique", "post_clicks"],
      ];
  const { rows, error } = await readMetricSets(
    graph,
    video ? `/${objectId}/video_insights` : `/${objectId}/insights`,
    sets,
    token,
  );
  if (error && (error.kind === "auth" || error.kind === "rate_limit" || error.kind === "transient"))
    throw new EngagementCallError(error);
  Object.assign(metrics, mapRows(rows, FB_METRICS));
  if (kind === "reel" && metrics.plays !== undefined && metrics.views === undefined)
    metrics.views = metrics.plays;
  const interactions = (metrics.likes ?? 0) + (metrics.comments ?? 0) + (metrics.shares ?? 0);
  metrics.interactions = interactions;
  const ok = Object.keys(rows).length > 0;
  return { status: ok ? "ok" : "partial", metrics, note: ok ? null : partialNote(error), error };
}

/** Follower count of an Instagram professional account or a Facebook Page. */
export async function readFollowerCount(
  graph: GraphClient,
  platform: "instagram" | "facebook",
  accountId: string,
  token: string,
): Promise<number | null> {
  const res = await graph.get<{
    followers_count?: number;
    fan_count?: number;
  }>(
    `/${accountId}`,
    {
      fields:
        platform === "instagram" ? "followers_count,media_count" : "followers_count,fan_count",
    },
    token,
  );
  const value = res?.followers_count ?? res?.fan_count;
  return typeof value === "number" ? value : null;
}
