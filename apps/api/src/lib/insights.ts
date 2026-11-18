/**
 * Statistics (N15): what the worker reads next, what it reported, and everything computed from
 * it — a post's numbers and history, the brand's performance page, best times and the short
 * summary the plan agent and the brand analysis read. Also when the Hub queues `insights.sync`
 * and `comments.sync` (only while the worker is connected: the Mac is on).
 */
import {
  type BestTimes,
  type BrandPerformance,
  COMMENTS_MAX_AGE_DAYS,
  COMMENTS_SYNC_MINUTES,
  type ContentPerformance,
  computeBestTimes,
  type EngagementSyncState,
  engagementRate,
  hookOf,
  INSIGHTS_MAX_AGE_DAYS,
  type InsightMetrics,
  localSlot,
  METRIC_LABEL,
  nextInsightsSyncAt,
  type PerformanceGroup,
  type PerformancePost,
  type PerformanceSummary,
  type PostInsight,
  relativeScores,
  STUDIO_UTC_OFFSET_HOURS,
  WEEKDAY_TR,
  type WorkerEngagementAccount,
  type WorkerEngagementPost,
  type WorkerInsightsReport,
} from "@studio/contract";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  ne,
  notInArray,
  type SQL,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../db/client.ts";
import {
  accountInsights,
  commentActions,
  contents,
  engagementSync,
  insightSnapshots,
  jobs,
  planItems,
  postInsights,
  schedules,
  socialAccounts,
  socialAccountTokens,
} from "../db/schema.ts";
import { readAccountToken } from "../routes/social-accounts.ts";
import { newId } from "./ids.ts";
import { rememberLocation } from "./publish-details.ts";
import type { VaultEnv } from "./token-vault.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
type Platform = "instagram" | "facebook" | "linkedin";

/** YYYY-MM-DD in Türkiye time. */
export function trDay(ms: number): string {
  return new Date(ms + STUDIO_UTC_OFFSET_HOURS * HOUR).toISOString().slice(0, 10);
}

/** Run statements in batches D1 accepts. */
export async function runBatches(db: Db, stmts: BatchItem<"sqlite">[], size = 50): Promise<void> {
  for (let i = 0; i < stmts.length; i += size) {
    const part = stmts.slice(i, i + size);
    if (part.length) await db.batch(part as Batch);
  }
}

// --- rows --------------------------------------------------------------------------------------

/** A published Instagram / Facebook schedule's statistics row (pending; first read after 1 h). */
export function insightRowFor(
  db: Db,
  args: {
    scheduleId: string;
    brandId: string;
    contentId: string;
    socialAccountId: string;
    platform: Platform;
    externalPostId: string;
    publishedAt: Date;
    now: Date;
  },
) {
  return db
    .insert(postInsights)
    .values({
      scheduleId: args.scheduleId,
      brandId: args.brandId,
      contentId: args.contentId,
      socialAccountId: args.socialAccountId,
      platform: args.platform,
      externalPostId: args.externalPostId,
      status: "pending",
      metrics: {},
      nextSyncAt: new Date(
        nextInsightsSyncAt(args.publishedAt.getTime(), null) ?? args.now.getTime(),
      ),
      updatedAt: args.now,
    })
    .onConflictDoUpdate({
      target: postInsights.scheduleId,
      set: { externalPostId: args.externalPostId, updatedAt: args.now },
    });
}

type InsightRow = typeof postInsights.$inferSelect;

export function toPostInsight(
  r: InsightRow,
  s: {
    contentType: PostInsight["contentType"];
    publishedAt: Date | null;
    permalink: string | null;
  },
): PostInsight {
  const metrics = (r.metrics ?? {}) as InsightMetrics;
  return {
    scheduleId: r.scheduleId,
    contentId: r.contentId,
    brandId: r.brandId,
    socialAccountId: r.socialAccountId,
    platform: r.platform,
    externalPostId: r.externalPostId,
    contentType: s.contentType,
    publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
    permalink: s.permalink,
    status: r.status,
    metrics,
    engagementRate: engagementRate(metrics),
    note: r.note ?? r.error ?? null,
    syncedAt: r.syncedAt ? r.syncedAt.toISOString() : null,
    nextSyncAt: r.nextSyncAt ? r.nextSyncAt.toISOString() : null,
  };
}

// --- what the worker reads -----------------------------------------------------------------

/** Accounts paused by a rate limit (until their `retry_at`). */
async function pausedAccounts(db: Db, now: Date): Promise<Set<string>> {
  const rows = await db
    .select({ id: engagementSync.socialAccountId })
    .from(engagementSync)
    .where(gte(engagementSync.retryAt, now));
  return new Set(rows.map((r) => r.id));
}

/** Connected Instagram / Facebook accounts with their tokens (null token: cannot be read). */
export async function engagementAccounts(
  db: Db,
  env: VaultEnv,
  where: SQL | undefined,
  followersDay: string | null,
): Promise<WorkerEngagementAccount[]> {
  const rows = await db
    .select({ account: socialAccounts, token: socialAccountTokens })
    .from(socialAccounts)
    .leftJoin(socialAccountTokens, eq(socialAccounts.id, socialAccountTokens.socialAccountId))
    .where(
      and(
        inArray(socialAccounts.platform, ["instagram", "facebook"]),
        ne(socialAccounts.status, "disabled"),
        isNotNull(socialAccounts.externalId),
        where,
      ),
    );
  const read = followersDay
    ? new Set(
        (
          await db
            .select({ id: accountInsights.socialAccountId })
            .from(accountInsights)
            .where(eq(accountInsights.day, followersDay))
        ).map((r) => r.id),
      )
    : new Set<string>();
  const out: WorkerEngagementAccount[] = [];
  for (const { account, token } of rows) {
    let accessToken: string | null = null;
    if (token) {
      try {
        accessToken = await readAccountToken(db, env, token);
      } catch {
        accessToken = null;
      }
    }
    out.push({
      socialAccountId: account.id,
      brandId: account.brandId,
      platform: account.platform,
      externalId: account.externalId ?? "",
      handle: account.handle,
      accessToken,
      followersDue: followersDay !== null && !read.has(account.id),
    });
  }
  return out;
}

/**
 * Posts whose statistics are due (or every live one of a brand / post with `force`), oldest due
 * first, and the accounts behind them plus every account whose follower count of today is not
 * read yet. Accounts paused by a rate limit are left out.
 */
export async function insightsTargets(
  db: Db,
  env: VaultEnv,
  q: {
    brandId?: string | undefined;
    contentId?: string | undefined;
    force?: boolean | undefined;
    limit: number;
  },
  now: Date,
): Promise<{ accounts: WorkerEngagementAccount[]; posts: WorkerEngagementPost[] }> {
  const paused = await pausedAccounts(db, now);
  const filters: SQL[] = [ne(postInsights.status, "deleted")];
  if (q.brandId) filters.push(eq(postInsights.brandId, q.brandId));
  if (q.contentId) filters.push(eq(postInsights.contentId, q.contentId));
  if (q.force) {
    filters.push(gte(schedules.publishedAt, new Date(now.getTime() - INSIGHTS_MAX_AGE_DAYS * DAY)));
  } else {
    filters.push(lte(postInsights.nextSyncAt, now));
  }
  if (paused.size) filters.push(notInArray(postInsights.socialAccountId, [...paused]));
  const rows = await db
    .select({ pi: postInsights, s: schedules, type: contents.type })
    .from(postInsights)
    .innerJoin(schedules, eq(schedules.id, postInsights.scheduleId))
    .innerJoin(contents, eq(contents.id, postInsights.contentId))
    .where(and(...filters))
    .orderBy(asc(postInsights.nextSyncAt))
    .limit(q.limit);
  const posts: WorkerEngagementPost[] = rows.map(({ pi, s, type }) => ({
    scheduleId: pi.scheduleId,
    contentId: pi.contentId,
    brandId: pi.brandId,
    socialAccountId: pi.socialAccountId,
    platform: pi.platform,
    externalPostId: pi.externalPostId,
    contentType: type,
    publishedAt: s.publishedAt ? s.publishedAt.toISOString() : null,
    commentCount: pi.commentCount,
    missCount: pi.missCount,
  }));
  const accountWhere: SQL[] = [];
  if (q.brandId) accountWhere.push(eq(socialAccounts.brandId, q.brandId));
  if (q.contentId) {
    const ids = [...new Set(posts.map((p) => p.socialAccountId))];
    accountWhere.push(inArray(socialAccounts.id, ids.length ? ids : ["-"]));
  }
  const accounts = (
    await engagementAccounts(
      db,
      env,
      accountWhere.length ? and(...accountWhere) : undefined,
      trDay(now.getTime()),
    )
  ).filter(
    (a) =>
      !paused.has(a.socialAccountId) &&
      (a.followersDue || posts.some((p) => p.socialAccountId === a.socialAccountId)),
  );
  return { accounts, posts };
}

// --- what the worker reported --------------------------------------------------------------------

/** Account report → sync state (and a broken token → reconnect, like a failed publish). */
export function accountReportStatements(
  db: Db,
  report: NonNullable<WorkerInsightsReport["accounts"]>[number],
  kind: "insights" | "comments",
  now: Date,
  brandOf: Map<string, string>,
): BatchItem<"sqlite">[] {
  const ok = report.status === "ok";
  const retryAt = report.retryAt ? new Date(report.retryAt) : null;
  const synced = kind === "insights" ? { insightsSyncedAt: now } : { commentsSyncedAt: now };
  const stmts: BatchItem<"sqlite">[] = [
    db
      .insert(engagementSync)
      .values({
        socialAccountId: report.socialAccountId,
        ...(ok ? synced : {}),
        status: report.status,
        error: ok ? null : (report.error ?? null),
        retryAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: engagementSync.socialAccountId,
        set: {
          ...(ok ? synced : {}),
          status: report.status,
          error: ok ? null : (report.error ?? null),
          retryAt,
          updatedAt: now,
        },
      }),
  ];
  if (report.status === "auth") {
    stmts.push(
      db
        .update(socialAccounts)
        .set({ status: "needs_reauth", updatedAt: now })
        .where(
          and(eq(socialAccounts.id, report.socialAccountId), ne(socialAccounts.status, "disabled")),
        ),
      db
        .update(socialAccountTokens)
        .set({ health: "invalid", checkedAt: now, updatedAt: now })
        .where(eq(socialAccountTokens.socialAccountId, report.socialAccountId)),
    );
  }
  if (typeof report.followers === "number") {
    stmts.push(
      db
        .insert(accountInsights)
        .values({
          socialAccountId: report.socialAccountId,
          day: trDay(now.getTime()),
          followers: report.followers,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [accountInsights.socialAccountId, accountInsights.day],
          set: { followers: report.followers, updatedAt: now },
        }),
    );
  }
  const brandId = brandOf.get(report.socialAccountId);
  if (report.pageLocation && brandId) {
    stmts.push(rememberLocation(db, brandId, report.pageLocation, "page", now));
  }
  return stmts;
}

/** Retry a failed read in 3 hours; a post not found once is looked at again in 6. */
const ERROR_RETRY_MS = 3 * HOUR;
const MISSING_RETRY_MS = 6 * HOUR;

export async function applyInsightsReport(
  db: Db,
  report: WorkerInsightsReport,
  now: Date,
): Promise<{ posts: number; snapshots: number }> {
  const ids = report.posts.map((p) => p.scheduleId);
  const rows = ids.length
    ? await db
        .select({ pi: postInsights, publishedAt: schedules.publishedAt })
        .from(postInsights)
        .innerJoin(schedules, eq(schedules.id, postInsights.scheduleId))
        .where(inArray(postInsights.scheduleId, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.pi.scheduleId, r]));
  const stmts: BatchItem<"sqlite">[] = [];
  let posts = 0;
  let snapshots = 0;
  for (const p of report.posts) {
    const row = byId.get(p.scheduleId);
    if (!row) continue;
    posts++;
    const published = (row.publishedAt ?? now).getTime();
    const where = eq(postInsights.scheduleId, p.scheduleId);
    if (p.status === "ok" || p.status === "partial") {
      const metrics = clean(p.metrics ?? {});
      const next = nextInsightsSyncAt(published, now.getTime());
      stmts.push(
        db
          .update(postInsights)
          .set({
            status: p.status,
            metrics,
            note: p.note ?? null,
            error: null,
            missCount: 0,
            syncedAt: now,
            nextSyncAt: next === null ? null : new Date(next),
            updatedAt: now,
          })
          .where(where),
        db.insert(insightSnapshots).values({
          id: newId(),
          scheduleId: p.scheduleId,
          at: now,
          hoursAfter: row.publishedAt
            ? Math.max(0, Math.round(((now.getTime() - published) / HOUR) * 10) / 10)
            : null,
          metrics,
        }),
      );
      snapshots++;
    } else if (p.status === "deleted" || (p.status === "missing" && row.pi.missCount >= 1)) {
      stmts.push(
        db
          .update(postInsights)
          .set({
            status: "deleted",
            note: "Gönderi platformda bulunamadı; silinmiş görünüyor.",
            nextSyncAt: null,
            missCount: row.pi.missCount + 1,
            syncedAt: now,
            updatedAt: now,
          })
          .where(where),
      );
    } else if (p.status === "missing") {
      stmts.push(
        db
          .update(postInsights)
          .set({
            missCount: row.pi.missCount + 1,
            error: "Gönderi bulunamadı; bir kez daha bakılacak.",
            nextSyncAt: new Date(now.getTime() + MISSING_RETRY_MS),
            updatedAt: now,
          })
          .where(where),
      );
    } else {
      stmts.push(
        db
          .update(postInsights)
          .set({
            status: row.pi.status === "pending" ? "error" : row.pi.status,
            error: p.error ?? "İstatistikler okunamadı.",
            nextSyncAt: new Date(now.getTime() + ERROR_RETRY_MS),
            updatedAt: now,
          })
          .where(where),
      );
    }
  }
  const accounts = report.accounts ?? [];
  if (accounts.length) {
    const brandRows = await db
      .select({ id: socialAccounts.id, brandId: socialAccounts.brandId })
      .from(socialAccounts)
      .where(
        inArray(
          socialAccounts.id,
          accounts.map((a) => a.socialAccountId),
        ),
      );
    const brandOf = new Map(brandRows.map((r) => [r.id, r.brandId]));
    for (const a of accounts) {
      if (!brandOf.has(a.socialAccountId)) continue;
      stmts.push(...accountReportStatements(db, a, "insights", now, brandOf));
    }
  }
  await runBatches(db, stmts);
  return { posts, snapshots };
}

/** Only finite, non-negative numbers of known keys. */
function clean(m: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(METRIC_LABEL)) {
    const v = m[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[key] = v;
  }
  return out;
}

// --- one post --------------------------------------------------------------------------------

export async function contentPerformance(db: Db, contentId: string): Promise<ContentPerformance> {
  const rows = await db
    .select({ pi: postInsights, s: schedules, type: contents.type, handle: socialAccounts.handle })
    .from(postInsights)
    .innerJoin(schedules, eq(schedules.id, postInsights.scheduleId))
    .innerJoin(contents, eq(contents.id, postInsights.contentId))
    .innerJoin(socialAccounts, eq(socialAccounts.id, postInsights.socialAccountId))
    .where(eq(postInsights.contentId, contentId))
    .orderBy(asc(schedules.publishedAt));
  const ids = rows.map((r) => r.pi.scheduleId);
  const snaps = ids.length
    ? await db
        .select()
        .from(insightSnapshots)
        .where(inArray(insightSnapshots.scheduleId, ids))
        .orderBy(asc(insightSnapshots.at))
    : [];
  const accountIds = [...new Set(rows.map((r) => r.pi.socialAccountId))];
  const sync = accountIds.length
    ? await db
        .select()
        .from(engagementSync)
        .where(inArray(engagementSync.socialAccountId, accountIds))
    : [];
  const totals: Record<string, number> = {};
  for (const { pi } of rows) {
    for (const [k, v] of Object.entries(pi.metrics ?? {})) {
      if (k === "avgWatchMs") continue;
      totals[k] = (totals[k] ?? 0) + v;
    }
  }
  return {
    contentId,
    posts: rows.map(({ pi, s, type, handle }) => ({
      ...toPostInsight(pi, {
        contentType: type,
        publishedAt: s.publishedAt,
        permalink: s.permalink,
      }),
      accountHandle: handle,
      snapshots: snaps
        .filter((x) => x.scheduleId === pi.scheduleId)
        .map((x) => ({
          at: x.at.toISOString(),
          hoursAfterPublish: x.hoursAfter,
          metrics: x.metrics as InsightMetrics,
        })),
    })),
    totals,
    needsReconnect: sync
      .filter((r) => r.status === "permission" || r.status === "auth")
      .map((r) => r.socialAccountId),
  };
}

// --- brand -------------------------------------------------------------------------------------

interface ScoredPost {
  scheduleId: string;
  contentId: string;
  title: string;
  platform: Platform;
  contentType: PostInsight["contentType"];
  pillar: string | null;
  hook: string | null;
  publishedAt: Date | null;
  permalink: string | null;
  metrics: InsightMetrics;
  rate: number | null;
  score: number;
}

/** The brand's posts with statistics published since `from`, scored relative to each other. */
export async function scoredPosts(
  db: Db,
  brandId: string,
  from: Date,
  platform?: Platform,
): Promise<ScoredPost[]> {
  const filters: SQL[] = [
    eq(postInsights.brandId, brandId),
    inArray(postInsights.status, ["ok", "partial"]),
    gte(schedules.publishedAt, from),
  ];
  if (platform) filters.push(eq(postInsights.platform, platform));
  const rows = await db
    .select({
      pi: postInsights,
      publishedAt: schedules.publishedAt,
      permalink: schedules.permalink,
      title: contents.title,
      caption: contents.caption,
      type: contents.type,
    })
    .from(postInsights)
    .innerJoin(schedules, eq(schedules.id, postInsights.scheduleId))
    .innerJoin(contents, eq(contents.id, postInsights.contentId))
    .where(and(...filters))
    .orderBy(desc(schedules.publishedAt))
    .limit(1000);
  const contentIds = [...new Set(rows.map((r) => r.pi.contentId))];
  const items = new Map<string, { pillar: string | null; hook: string | null }>();
  for (let i = 0; i < contentIds.length; i += 90) {
    const part = contentIds.slice(i, i + 90);
    const found = await db
      .select({ contentId: planItems.contentId, pillar: planItems.pillar, hook: planItems.hook })
      .from(planItems)
      .where(inArray(planItems.contentId, part));
    for (const f of found) if (f.contentId) items.set(f.contentId, f);
  }
  const scores = relativeScores(rows.map((r) => ({ metrics: r.pi.metrics as InsightMetrics })));
  return rows.map((r, i) => {
    const metrics = r.pi.metrics as InsightMetrics;
    const item = items.get(r.pi.contentId);
    return {
      scheduleId: r.pi.scheduleId,
      contentId: r.pi.contentId,
      title: r.title,
      platform: r.pi.platform,
      contentType: r.type,
      pillar: item?.pillar?.trim() || null,
      hook: hookOf(r.caption) ?? item?.hook ?? null,
      publishedAt: r.publishedAt,
      permalink: r.permalink,
      metrics,
      rate: engagementRate(metrics),
      score: Math.round((scores[i] ?? 1) * 100) / 100,
    };
  });
}

const avg = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const round = (v: number | null, digits = 4) =>
  v === null ? null : Math.round(v * 10 ** digits) / 10 ** digits;

function groupBy(
  posts: ScoredPost[],
  keyOf: (p: ScoredPost) => string,
  labelOf: (key: string) => string,
  order?: (a: string, b: string) => number,
): PerformanceGroup[] {
  const groups = new Map<string, ScoredPost[]>();
  for (const p of posts) {
    const key = keyOf(p);
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const out = [...groups.entries()].map(([key, list]) => ({
    key,
    label: labelOf(key),
    posts: list.length,
    avgReach: round(
      avg(list.map((p) => p.metrics.reach).filter((v): v is number => typeof v === "number")),
      0,
    ),
    avgEngagementRate: round(avg(list.map((p) => p.rate).filter((v): v is number => v !== null))),
    index: round(avg(list.map((p) => p.score)), 2),
  }));
  return order
    ? out.sort((a, b) => order(a.key, b.key))
    : out.sort((a, b) => (b.index ?? 0) - (a.index ?? 0) || b.posts - a.posts);
}

const FORMAT_LABEL: Record<string, string> = {
  post: "Tek görsel",
  carousel: "Carousel",
  story: "Story",
  reel: "Reels",
};

/** Monday (Türkiye time) of the week a moment falls in. */
function weekOf(at: Date): string {
  const { weekday } = localSlot(at);
  return trDay(at.getTime() - weekday * DAY);
}

export async function engagementStates(db: Db, brandId: string): Promise<EngagementSyncState[]> {
  const rows = await db
    .select({ a: socialAccounts, s: engagementSync })
    .from(socialAccounts)
    .leftJoin(engagementSync, eq(engagementSync.socialAccountId, socialAccounts.id))
    .where(
      and(
        eq(socialAccounts.brandId, brandId),
        inArray(socialAccounts.platform, ["instagram", "facebook"]),
        ne(socialAccounts.status, "disabled"),
      ),
    );
  return rows.map(({ a, s }) => ({
    socialAccountId: a.id,
    platform: a.platform,
    handle: a.handle,
    insightsSyncedAt: s?.insightsSyncedAt ? s.insightsSyncedAt.toISOString() : null,
    commentsSyncedAt: s?.commentsSyncedAt ? s.commentsSyncedAt.toISOString() : null,
    error: s?.error ?? null,
    needsReconnect:
      s?.status === "permission" || s?.status === "auth" || a.status === "needs_reauth",
    retryAt: s?.retryAt && s.retryAt.getTime() > Date.now() ? s.retryAt.toISOString() : null,
  }));
}

export async function bestTimesFor(
  db: Db,
  brandId: string,
  q: { days: number; platform?: Platform | undefined },
  now: Date,
): Promise<BestTimes> {
  const posts = await scoredPosts(db, brandId, new Date(now.getTime() - q.days * DAY), q.platform);
  return computeBestTimes(
    posts
      .filter((p) => p.publishedAt)
      .map((p) => ({ publishedAt: (p.publishedAt as Date).toISOString(), score: p.score })),
    { days: q.days },
  );
}

export async function brandPerformance(
  db: Db,
  brandId: string,
  q: { days: number; platform?: Platform | undefined },
  now: Date,
): Promise<BrandPerformance> {
  const from = new Date(now.getTime() - q.days * DAY);
  const posts = await scoredPosts(db, brandId, from, q.platform);
  const totals: Record<string, number> = {};
  for (const p of posts)
    for (const [k, v] of Object.entries(p.metrics)) {
      if (k === "avgWatchMs" || typeof v !== "number") continue;
      totals[k] = (totals[k] ?? 0) + v;
    }
  const dated = posts.filter((p) => p.publishedAt);
  const trend = new Map<string, ScoredPost[]>();
  for (const p of dated) {
    const w = weekOf(p.publishedAt as Date);
    trend.set(w, [...(trend.get(w) ?? []), p]);
  }
  const accounts = await engagementStates(db, brandId);
  const followerRows = accounts.length
    ? await db
        .select()
        .from(accountInsights)
        .where(
          and(
            inArray(
              accountInsights.socialAccountId,
              accounts.map((a) => a.socialAccountId),
            ),
            gte(accountInsights.day, trDay(from.getTime())),
          ),
        )
        .orderBy(asc(accountInsights.day))
    : [];
  return {
    brandId,
    from: from.toISOString(),
    to: now.toISOString(),
    posts: posts.length,
    totals,
    avgReach: round(
      avg(posts.map((p) => p.metrics.reach).filter((v): v is number => typeof v === "number")),
      0,
    ),
    avgEngagementRate: round(avg(posts.map((p) => p.rate).filter((v): v is number => v !== null))),
    topPosts: [...posts]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map(
        (p): PerformancePost => ({
          scheduleId: p.scheduleId,
          contentId: p.contentId,
          title: p.title,
          platform: p.platform,
          contentType: p.contentType,
          pillar: p.pillar,
          hook: p.hook,
          publishedAt: p.publishedAt ? p.publishedAt.toISOString() : null,
          permalink: p.permalink,
          metrics: p.metrics,
          engagementRate: round(p.rate),
          score: p.score,
        }),
      ),
    byPillar: groupBy(
      posts,
      (p) => p.pillar ?? "",
      (k) => k || "Sütun belirtilmemiş",
    ),
    byFormat: groupBy(
      posts,
      (p) => p.contentType,
      (k) => FORMAT_LABEL[k] ?? k,
    ),
    byWeekday: groupBy(
      dated,
      (p) => String(localSlot(p.publishedAt as Date).weekday),
      (k) => WEEKDAY_TR[Number(k)] ?? k,
      (a, b) => Number(a) - Number(b),
    ),
    byHour: groupBy(
      dated,
      (p) => String(localSlot(p.publishedAt as Date).hour),
      (k) => `${k.padStart(2, "0")}:00`,
      (a, b) => Number(a) - Number(b),
    ),
    trend: [...trend.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, list]) => ({
        week,
        posts: list.length,
        reach: list.reduce((n, p) => n + (p.metrics.reach ?? 0), 0),
        interactions: list.reduce(
          (n, p) =>
            n +
            (p.metrics.interactions ??
              (p.metrics.likes ?? 0) +
                (p.metrics.comments ?? 0) +
                (p.metrics.saves ?? 0) +
                (p.metrics.shares ?? 0)),
          0,
        ),
        avgEngagementRate: round(
          avg(list.map((p) => p.rate).filter((v): v is number => v !== null)),
        ),
      })),
    followers: accounts.map((a) => ({
      socialAccountId: a.socialAccountId,
      platform: a.platform,
      handle: a.handle,
      points: followerRows
        .filter((r) => r.socialAccountId === a.socialAccountId)
        .map((r) => ({ day: r.day, followers: r.followers })),
    })),
    bestTimes: computeBestTimes(
      dated.map((p) => ({ publishedAt: (p.publishedAt as Date).toISOString(), score: p.score })),
      { days: q.days },
    ),
    accounts,
  };
}

/**
 * The short "what worked" for planning and the brand analysis; null without statistics. Groups
 * need two posts to count, so one lucky post does not steer the plan.
 */
export async function performanceSummary(
  db: Db,
  brandId: string,
  days: number,
  now: Date,
): Promise<PerformanceSummary | null> {
  const from = new Date(now.getTime() - days * DAY);
  const posts = await scoredPosts(db, brandId, from);
  if (posts.length === 0) return null;
  const groupIndex = (keyOf: (p: ScoredPost) => string | null) => {
    const groups = new Map<string, number[]>();
    for (const p of posts) {
      const key = keyOf(p);
      if (!key) continue;
      groups.set(key, [...(groups.get(key) ?? []), p.score]);
    }
    return [...groups.entries()]
      .filter(([, s]) => s.length >= 2)
      .map(([key, s]) => ({ key, posts: s.length, index: round(avg(s), 2) ?? 1 }))
      .sort((a, b) => b.index - a.index);
  };
  const ranked = [...posts].sort((a, b) => b.score - a.score);
  const line = (p: ScoredPost) => ({
    title: p.title,
    hook: p.hook,
    pillar: p.pillar,
    type: p.contentType,
    index: p.score,
  });
  const best = computeBestTimes(
    posts
      .filter((p) => p.publishedAt)
      .map((p) => ({ publishedAt: (p.publishedAt as Date).toISOString(), score: p.score })),
    { max: 3 },
  );
  return {
    from: trDay(from.getTime()),
    to: trDay(now.getTime()),
    posts: posts.length,
    avgReach: round(
      avg(posts.map((p) => p.metrics.reach).filter((v): v is number => typeof v === "number")),
      0,
    ),
    avgEngagementRate: round(avg(posts.map((p) => p.rate).filter((v): v is number => v !== null))),
    pillars: groupIndex((p) => p.pillar).map((g) => ({
      name: g.key,
      posts: g.posts,
      index: g.index,
    })),
    formats: groupIndex((p) => p.contentType).map((g) => ({
      type: g.key as PostInsight["contentType"],
      posts: g.posts,
      index: g.index,
    })),
    top: ranked.slice(0, 5).map(line),
    weak: posts.length >= 6 ? ranked.slice(-3).reverse().map(line) : [],
    bestSlots: best.basis === "own" ? best.suggestions : [],
  };
}

/** Per post (content): its best relative score, reach and rate (planning history lines). */
export async function contentScores(
  db: Db,
  brandId: string,
  from: Date,
): Promise<Map<string, { index: number; reach: number | null; engagementRate: number | null }>> {
  const out = new Map<
    string,
    { index: number; reach: number | null; engagementRate: number | null }
  >();
  for (const p of await scoredPosts(db, brandId, from)) {
    const prev = out.get(p.contentId);
    if (prev && prev.index >= p.score) continue;
    out.set(p.contentId, {
      index: p.score,
      reach: p.metrics.reach ?? null,
      engagementRate: round(p.rate),
    });
  }
  return out;
}

// --- when to sync ---------------------------------------------------------------------------------

/** True while a job of `type` waits or runs (one at a time). */
async function jobActive(db: Db, type: string): Promise<boolean> {
  const row = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, type), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  return row.length > 0;
}

/**
 * Which engagement jobs the Hub should queue now: `insights.sync` when a post's read is due or
 * an account's follower count of today is missing; `comments.sync` every 15 minutes while there
 * are posts of the last 30 days, or at once when replies wait. Never a second one of a type.
 */
export async function dueEngagementJobs(
  db: Db,
  now: Date,
  lastCommentsAt: number,
): Promise<{ insights: boolean; comments: boolean }> {
  const paused = await pausedAccounts(db, now);
  const pausedFilter = paused.size
    ? notInArray(postInsights.socialAccountId, [...paused])
    : undefined;

  let insights = false;
  if (!(await jobActive(db, "insights.sync"))) {
    const due = await db
      .select({ id: postInsights.scheduleId })
      .from(postInsights)
      .where(
        and(lte(postInsights.nextSyncAt, now), ne(postInsights.status, "deleted"), pausedFilter),
      )
      .limit(1);
    insights = due.length > 0;
    if (!insights) {
      const today = trDay(now.getTime());
      const accounts = await db
        .select({ id: socialAccounts.id })
        .from(socialAccounts)
        .innerJoin(socialAccountTokens, eq(socialAccountTokens.socialAccountId, socialAccounts.id))
        .where(
          and(
            inArray(socialAccounts.platform, ["instagram", "facebook"]),
            eq(socialAccounts.status, "connected"),
          ),
        );
      const read = new Set(
        (
          await db
            .select({ id: accountInsights.socialAccountId })
            .from(accountInsights)
            .where(eq(accountInsights.day, today))
        ).map((r) => r.id),
      );
      insights = accounts.some((a) => !read.has(a.id) && !paused.has(a.id));
    }
  }

  let comments = false;
  if (!(await jobActive(db, "comments.sync"))) {
    const waiting = await db
      .select({ id: commentActions.id })
      .from(commentActions)
      .where(eq(commentActions.status, "pending"))
      .limit(1);
    if (waiting.length) comments = true;
    else if (now.getTime() - lastCommentsAt >= COMMENTS_SYNC_MINUTES * 60_000) {
      const recent = await db
        .select({ id: postInsights.scheduleId })
        .from(postInsights)
        .innerJoin(schedules, eq(schedules.id, postInsights.scheduleId))
        .where(
          and(
            ne(postInsights.status, "deleted"),
            gte(schedules.publishedAt, new Date(now.getTime() - COMMENTS_MAX_AGE_DAYS * DAY)),
            pausedFilter,
          ),
        )
        .limit(1);
      comments = recent.length > 0;
    }
  }
  return { insights, comments };
}

/** Insert a queued job (inside the Hub, which dispatches it right after). */
export async function insertQueuedJob(
  db: Db,
  type: "insights.sync" | "comments.sync",
  payload: Record<string, unknown>,
  now: Date,
): Promise<string> {
  const id = newId();
  await db.insert(jobs).values({
    id,
    type,
    status: "queued",
    brandId: null,
    contentId: null,
    payload,
    priority: -10,
    maxAttempts: 2,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}
