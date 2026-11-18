/**
 * `insights.sync` and `comments.sync` (N15, N16): the worker reads statistics and comments from
 * Instagram and Facebook with the accounts' tokens (handed out by the API with the targets) and
 * reports what it read. It never decides what is due: the API does (`/api/worker/engagement/*`).
 *
 * Per account: a missing permission or an invalid token is reported (the owner reconnects); a
 * rate limit stops reading for that account and tells the API when to try again; one post that
 * cannot be read does not stop the others. Comment replies, hides and deletes queued by the owner
 * are sent first; a reply interrupted after Meta accepted it is found again, not sent twice.
 */
import {
  type CommentsSyncOutput,
  CommentsSyncPayload,
  InsightsSyncPayload,
  type WorkerAccountReport,
  type WorkerComment,
  type WorkerCommentActionItem,
  type WorkerEngagementAccount,
  type WorkerEngagementPost,
} from "@studio/contract";
import {
  classifyEngagementError,
  deleteComment,
  type EngagementError,
  findReply,
  GraphClient,
  listInstagramCommentCounts,
  readComments,
  readFacebookCommentCount,
  readFacebookPostInsights,
  readFollowerCount,
  readInstagramMediaInsights,
  replyToComment,
  setCommentHidden,
} from "../../../../packages/publishers/src/index.ts";
import type { StudioApi } from "../api.ts";
import type { Logger } from "../log.ts";
import { defineHandler, type JobContext } from "../registry.ts";

export interface EngagementDeps {
  api: StudioApi;
  logger: Logger;
  /** Graph API fetch (tests: the fake Graph API). */
  publisherFetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/** Comments read per post at most (a post with more is read partly: no deletes inferred). */
const MAX_COMMENTS_PER_POST = 500;
/** Posts per comments report (keeps request bodies small). */
const COMMENT_REPORT_CHUNK = 20;

function graphFor(deps: EngagementDeps, signal: AbortSignal): GraphClient {
  const base = deps.publisherFetch ?? globalThis.fetch.bind(globalThis);
  return new GraphClient({
    fetch: (input, init) =>
      base(input, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      }),
    // Reads only: a couple of quick tries, longer waits go back to the API as `retryAt`.
    retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000, maxInlineWaitMs: 5_000 },
  });
}

const nowOf = (deps: EngagementDeps) => (deps.now ?? (() => new Date()))();

/** Account report for an account-level failure (null: a post-level problem). */
function accountFailure(
  socialAccountId: string,
  e: EngagementError,
  now: Date,
): WorkerAccountReport | null {
  if (e.kind === "rate_limit")
    return {
      socialAccountId,
      status: "rate_limited",
      error: e.message,
      retryAt: new Date(now.getTime() + (e.retryAfterMs ?? 15 * 60_000)).toISOString(),
    };
  if (e.kind === "auth") return { socialAccountId, status: "auth", error: e.message };
  if (e.kind === "permission") return { socialAccountId, status: "permission", error: e.message };
  return null;
}

const NO_TOKEN = "Hesabın erişim anahtarı okunamadı; hesabı yeniden bağlayın.";

function byAccount<T extends { socialAccountId: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items)
    out.set(item.socialAccountId, [...(out.get(item.socialAccountId) ?? []), item]);
  return out;
}

/** Facebook: which statistics call a published object needs. */
function facebookKind(post: WorkerEngagementPost): "post" | "reel" | "video" {
  if (post.externalPostId.includes("_")) return "post";
  return post.contentType === "reel" ? "reel" : "video";
}

// --- insights.sync ---------------------------------------------------------------------------

/** A Facebook Page's address as a usable Instagram location (null: it has none). */
async function pageLocation(
  graph: GraphClient,
  pageId: string,
  token: string,
): Promise<{ id: string; name: string } | null> {
  try {
    const res = await graph.get<{ name?: string; location?: { city?: string; street?: string } }>(
      `/${pageId}`,
      { fields: "name,location" },
      token,
    );
    if (!res?.location || !res.name) return null;
    return { id: pageId, name: res.name.slice(0, 200) };
  } catch {
    return null;
  }
}

export async function runInsightsSync(
  deps: EngagementDeps,
  payload: InsightsSyncPayload,
  ctx: Pick<JobContext, "signal" | "progress">,
): Promise<{ posts: number; accounts: number; failed: number }> {
  const { signal } = ctx;
  const targets = await deps.api.client.workerEngagement.targets(
    {
      kind: "insights",
      ...(payload.brandId ? { brandId: payload.brandId } : {}),
      ...(payload.contentId ? { contentId: payload.contentId } : {}),
      ...(payload.force ? { force: "true" } : {}),
      limit: 150,
    },
    { signal },
  );
  const graph = graphFor(deps, signal);
  const postsByAccount = byAccount(targets.posts);
  const postReports: {
    scheduleId: string;
    status: "ok" | "partial" | "deleted" | "missing" | "error";
    metrics?: Record<string, number>;
    note?: string | null;
    error?: string | null;
  }[] = [];
  const accountReports: WorkerAccountReport[] = [];
  let failed = 0;
  let done = 0;
  const total = Math.max(1, targets.posts.length + targets.accounts.length);

  for (const account of targets.accounts) {
    signal.throwIfAborted();
    const posts = postsByAccount.get(account.socialAccountId) ?? [];
    const token = account.accessToken;
    if (!token) {
      accountReports.push({
        socialAccountId: account.socialAccountId,
        status: "auth",
        error: NO_TOKEN,
      });
      failed += posts.length;
      continue;
    }
    const report: WorkerAccountReport = { socialAccountId: account.socialAccountId, status: "ok" };
    let stopped = false;
    try {
      if (account.followersDue) {
        const platform = account.platform === "facebook" ? "facebook" : "instagram";
        report.followers = await readFollowerCount(graph, platform, account.externalId, token);
        if (platform === "facebook") {
          const where = await pageLocation(graph, account.externalId, token);
          if (where) report.pageLocation = where;
        }
      }
    } catch (error) {
      if (signal.aborted) throw error;
      const e = classifyEngagementError(error, [token]);
      const fail = accountFailure(account.socialAccountId, e, nowOf(deps));
      if (fail && fail.status !== "permission") {
        accountReports.push(fail);
        failed += posts.length;
        continue;
      }
      if (fail) Object.assign(report, fail);
    }
    for (const post of posts) {
      if (stopped) break;
      signal.throwIfAborted();
      try {
        if (post.contentType === "story" && post.platform === "facebook") {
          postReports.push({
            scheduleId: post.scheduleId,
            status: "partial",
            metrics: {},
            note: "Facebook hikâyelerinin istatistikleri okunamıyor.",
          });
          continue;
        }
        const read =
          post.platform === "instagram"
            ? await readInstagramMediaInsights(graph, post.externalPostId, token)
            : await readFacebookPostInsights(graph, post.externalPostId, token, facebookKind(post));
        if (read.status === "deleted") {
          postReports.push({ scheduleId: post.scheduleId, status: "missing" });
        } else {
          postReports.push({
            scheduleId: post.scheduleId,
            status: read.status,
            metrics: read.metrics as Record<string, number>,
            note: read.note,
          });
          if (read.error?.kind === "permission" && report.status === "ok") {
            report.status = "permission";
            report.error = read.error.message;
          }
        }
      } catch (error) {
        if (signal.aborted) throw error;
        const e = classifyEngagementError(error, [token]);
        const fail = accountFailure(account.socialAccountId, e, nowOf(deps));
        if (fail && fail.status !== "permission") {
          Object.assign(report, fail);
          stopped = true;
          failed++;
          continue;
        }
        failed++;
        postReports.push({ scheduleId: post.scheduleId, status: "error", error: e.message });
      } finally {
        done++;
        ctx.progress(done / total, "İstatistikler okunuyor");
      }
    }
    accountReports.push(report);
  }

  for (let i = 0; i < Math.max(postReports.length, 1); i += 200) {
    await deps.api.client.workerEngagement.reportInsights(
      { posts: postReports.slice(i, i + 200), accounts: i === 0 ? accountReports : [] },
      { signal },
    );
  }
  ctx.progress(1, "İstatistikler kaydedildi");
  return { posts: postReports.length, accounts: accountReports.length, failed };
}

export function createInsightsSyncHandler(deps: EngagementDeps) {
  return defineHandler({
    payload: InsightsSyncPayload,
    run: async (payload, ctx: JobContext) => runInsightsSync(deps, payload, ctx),
  });
}

// --- comments.sync ----------------------------------------------------------------------------

async function sendAction(
  deps: EngagementDeps,
  graph: GraphClient,
  action: WorkerCommentActionItem,
  token: string | null,
  signal: AbortSignal,
): Promise<boolean> {
  const api = deps.api.client.workerEngagement;
  if (!token) {
    await api.action(action.id, { status: "failed", error: NO_TOKEN }, { signal });
    return false;
  }
  const platform = action.platform === "facebook" ? "facebook" : "instagram";
  // An action left in `sending` (or tried before) may already have reached Meta.
  const uncertain = action.status === "sending" || action.attempts > 0;
  await api.action(action.id, { status: "sending" }, { signal });
  try {
    if (action.kind === "reply") {
      const text = action.text ?? "";
      let id = uncertain
        ? await findReply(graph, platform, action.externalCommentId, text, token)
        : null;
      id ??= await replyToComment(graph, platform, action.externalCommentId, text, token);
      await api.action(action.id, { status: "done", externalId: id }, { signal });
    } else if (action.kind === "hide" || action.kind === "unhide") {
      await setCommentHidden(
        graph,
        platform,
        action.externalCommentId,
        action.kind === "hide",
        token,
      );
      await api.action(action.id, { status: "done" }, { signal });
    } else {
      await deleteComment(graph, action.externalCommentId, token);
      await api.action(action.id, { status: "done" }, { signal });
    }
    return true;
  } catch (error) {
    if (signal.aborted) throw error;
    const e = classifyEngagementError(error, [token]);
    if (e.kind === "deleted") {
      await api.action(action.id, { status: "done", commentDeleted: true }, { signal });
      return action.kind === "delete";
    }
    const reason =
      e.kind === "permission"
        ? "Yorum izni yok; hesabı yeniden bağlayıp yorum izinlerini onaylayın."
        : e.kind === "rate_limit"
          ? "Meta istek sınırına ulaşıldı; biraz sonra yeniden deneyin."
          : e.message;
    await api.action(action.id, { status: "failed", error: reason }, { signal });
    return false;
  }
}

function toWorkerComment(c: {
  id: string;
  parentId: string | null;
  text: string;
  author: string | null;
  authorId: string | null;
  createdAt: string | null;
  likeCount: number | null;
  hidden: boolean | null;
}): WorkerComment {
  return {
    externalId: c.id,
    parentExternalId: c.parentId,
    text: c.text.slice(0, 10_000),
    author: c.author ? c.author.slice(0, 200) : null,
    authorId: c.authorId ? c.authorId.slice(0, 128) : null,
    createdAt: c.createdAt,
    likeCount: c.likeCount,
    hidden: c.hidden,
  };
}

export async function runCommentsSync(
  deps: EngagementDeps,
  payload: CommentsSyncPayload,
  ctx: Pick<JobContext, "signal" | "progress">,
): Promise<CommentsSyncOutput> {
  const { signal } = ctx;
  const api = deps.api.client.workerEngagement;
  const targets = await api.targets(
    { kind: "comments", ...(payload.brandId ? { brandId: payload.brandId } : {}), limit: 150 },
    { signal },
  );
  const graph = graphFor(deps, signal);
  const accounts = new Map<string, WorkerEngagementAccount>(
    targets.accounts.map((a) => [a.socialAccountId, a]),
  );

  let actionsSent = 0;
  for (const action of targets.actions) {
    signal.throwIfAborted();
    const token = accounts.get(action.socialAccountId)?.accessToken ?? null;
    if (await sendAction(deps, graph, action, token, signal)) actionsSent++;
  }
  ctx.progress(0.2, actionsSent ? `${actionsSent} yanıt / işlem gönderildi` : "Yorumlar okunuyor");

  let newComments = 0;
  let sample: CommentsSyncOutput["sample"] = null;
  if (!payload.actionsOnly) {
    type PostReport = {
      scheduleId: string;
      status: "ok" | "deleted" | "missing" | "error";
      commentCount?: number | null;
      complete: boolean;
      comments: WorkerComment[];
      error?: string | null;
    };
    const postReports: PostReport[] = [];
    const accountReports: WorkerAccountReport[] = [];
    const total = Math.max(1, targets.posts.length);
    let done = 0;
    for (const [accountId, posts] of byAccount(targets.posts)) {
      signal.throwIfAborted();
      const account = accounts.get(accountId);
      const token = account?.accessToken ?? null;
      if (!account || !token) {
        accountReports.push({ socialAccountId: accountId, status: "auth", error: NO_TOKEN });
        continue;
      }
      const platform = account.platform === "facebook" ? "facebook" : "instagram";
      const report: WorkerAccountReport = { socialAccountId: accountId, status: "ok" };
      try {
        // Instagram: one listing says which media have new comments.
        const counts =
          platform === "instagram"
            ? new Map(
                (
                  await listInstagramCommentCounts(graph, account.externalId, token, { limit: 50 })
                ).map((m) => [m.id, m.comments]),
              )
            : null;
        for (const post of posts) {
          signal.throwIfAborted();
          try {
            const count =
              counts !== null
                ? (counts.get(post.externalPostId) ?? null)
                : await readFacebookCommentCount(graph, post.externalPostId, token);
            if (count !== null && count === post.commentCount) {
              postReports.push({
                scheduleId: post.scheduleId,
                status: "ok",
                commentCount: count,
                complete: false,
                comments: [],
              });
              continue;
            }
            const list = await readComments(graph, platform, post.externalPostId, token, {
              max: MAX_COMMENTS_PER_POST,
            });
            postReports.push({
              scheduleId: post.scheduleId,
              status: "ok",
              commentCount: count ?? list.length,
              complete: list.length < MAX_COMMENTS_PER_POST,
              comments: list.map(toWorkerComment),
            });
          } catch (error) {
            if (signal.aborted) throw error;
            const e = classifyEngagementError(error, [token]);
            if (e.kind === "deleted") {
              postReports.push({
                scheduleId: post.scheduleId,
                status: "deleted",
                complete: false,
                comments: [],
              });
              continue;
            }
            const fail = accountFailure(accountId, e, nowOf(deps));
            if (fail) throw error;
            postReports.push({
              scheduleId: post.scheduleId,
              status: "error",
              complete: false,
              comments: [],
              error: e.message,
            });
          } finally {
            done++;
            ctx.progress(0.2 + (0.7 * done) / total, "Yorumlar okunuyor");
          }
        }
      } catch (error) {
        if (signal.aborted) throw error;
        const e = classifyEngagementError(error, [token]);
        Object.assign(
          report,
          accountFailure(accountId, e, nowOf(deps)) ?? { status: "error", error: e.message },
        );
      }
      accountReports.push(report);
    }
    for (let i = 0; i < Math.max(postReports.length, 1); i += COMMENT_REPORT_CHUNK) {
      const ack = await api.reportComments(
        {
          posts: postReports.slice(i, i + COMMENT_REPORT_CHUNK),
          accounts: i === 0 ? accountReports : [],
        },
        { signal },
      );
      newComments += ack.newUnread;
      sample ??= ack.sample;
    }
  }
  ctx.progress(1, newComments ? `${newComments} yeni yorum` : "Yorumlar güncel");
  return { newComments, sample, actionsSent, brandId: payload.brandId ?? null };
}

export function createCommentsSyncHandler(deps: EngagementDeps) {
  return defineHandler({
    payload: CommentsSyncPayload,
    run: async (payload, ctx: JobContext) => runCommentsSync(deps, payload, ctx),
  });
}
