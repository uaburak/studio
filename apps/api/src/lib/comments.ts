/**
 * Comment inbox (N16): storing what the worker read, the threads and counts the apps show, and
 * the replies / hides / deletes the worker sends.
 *
 * - A comment is identified by `(platform, external_id)`; a re-read updates it in place.
 * - Comments written by the account itself (our replies, the first comment) are `own`: they are
 *   read at once and never counted as unread.
 * - A complete read of a post marks the comments that disappeared as deleted.
 */
import {
  COMMENTS_MAX_AGE_DAYS,
  type CommentAction,
  type CommentListQuery,
  type CommentSummary,
  type CommentThread,
  type PostComment,
  type WorkerCommentActionItem,
  type WorkerCommentsReport,
  type WorkerEngagementAccount,
  type WorkerEngagementPost,
} from "@studio/contract";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  commentActions,
  contents,
  engagementSync,
  postComments,
  postInsights,
  schedules,
  socialAccounts,
} from "../db/schema.ts";
import { notFound } from "./errors.ts";
import { newId } from "./ids.ts";
import { accountReportStatements, engagementAccounts, runBatches } from "./insights.ts";
import { decodeTimeCursor, encodeTimeCursor } from "./pagination.ts";
import type { VaultEnv } from "./token-vault.ts";

const DAY = 86_400_000;
/** A `sending` action older than this was interrupted (the worker stopped): offer it again. */
const SENDING_STALE_MS = 2 * 60_000;

type CommentRow = typeof postComments.$inferSelect;
type ActionRow = typeof commentActions.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

function toAction(r: ActionRow): CommentAction {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    text: r.text,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toComment(
  r: CommentRow,
  extra: { answered: boolean; action: ActionRow | null },
): PostComment {
  return {
    id: r.id,
    brandId: r.brandId,
    socialAccountId: r.socialAccountId,
    platform: r.platform,
    contentId: r.contentId,
    scheduleId: r.scheduleId,
    externalPostId: r.externalPostId,
    externalId: r.externalId,
    parentId: r.parentId,
    author: r.author,
    text: r.text,
    likeCount: r.likeCount,
    hidden: r.hidden,
    own: r.own,
    createdAt: r.createdAt.toISOString(),
    readAt: iso(r.readAt),
    deletedAt: iso(r.deletedAt),
    answered: extra.answered,
    pendingAction: extra.action ? toAction(extra.action) : null,
    suggestion: r.suggestion,
    suggestionAt: iso(r.suggestionAt),
  };
}

// --- threads ---------------------------------------------------------------------------------

/** Build threads for top-level rows: replies, the latest unfinished action, titles, links. */
async function threadsOf(
  db: Db,
  tops: CommentRow[],
  includeDeleted: boolean,
): Promise<CommentThread[]> {
  if (tops.length === 0) return [];
  const ids = tops.map((t) => t.id);
  const replyRows = await db
    .select()
    .from(postComments)
    .where(
      and(
        inArray(postComments.parentId, ids),
        includeDeleted ? undefined : isNull(postComments.deletedAt),
      ),
    )
    .orderBy(asc(postComments.createdAt), asc(postComments.id));
  const allIds = [...ids, ...replyRows.map((r) => r.id)];
  const actionRows = await db
    .select()
    .from(commentActions)
    .where(inArray(commentActions.commentId, allIds))
    .orderBy(desc(commentActions.createdAt));
  const openAction = new Map<string, ActionRow>();
  const replying = new Set<string>();
  for (const a of actionRows) {
    if (a.kind === "reply" && a.status !== "failed") replying.add(a.commentId);
    if (a.status === "done") continue;
    if (!openAction.has(a.commentId)) openAction.set(a.commentId, a);
  }
  const contentIds = [...new Set(tops.map((t) => t.contentId).filter((x): x is string => !!x))];
  const titles = new Map(
    contentIds.length
      ? (
          await db
            .select({ id: contents.id, title: contents.title })
            .from(contents)
            .where(inArray(contents.id, contentIds))
        ).map((r) => [r.id, r.title])
      : [],
  );
  const scheduleIds = [...new Set(tops.map((t) => t.scheduleId).filter((x): x is string => !!x))];
  const links = new Map(
    scheduleIds.length
      ? (
          await db
            .select({ id: schedules.id, permalink: schedules.permalink })
            .from(schedules)
            .where(inArray(schedules.id, scheduleIds))
        ).map((r) => [r.id, r.permalink])
      : [],
  );
  return tops.map((top) => {
    const replies = replyRows.filter((r) => r.parentId === top.id);
    const answered = top.own || replying.has(top.id) || replies.some((r) => r.own && !r.deletedAt);
    return {
      ...toComment(top, { answered, action: openAction.get(top.id) ?? null }),
      replies: replies.map((r) =>
        toComment(r, { answered: r.own, action: openAction.get(r.id) ?? null }),
      ),
      contentTitle: top.contentId ? (titles.get(top.contentId) ?? null) : null,
      permalink: top.scheduleId ? (links.get(top.scheduleId) ?? null) : null,
    };
  });
}

/** Someone else's comment that nobody read yet (top or reply). */
const unreadSql = and(
  isNull(postComments.readAt),
  eq(postComments.own, false),
  isNull(postComments.deletedAt),
);

export async function listThreads(
  db: Db,
  q: z.output<typeof CommentListQuery>,
): Promise<{ items: CommentThread[]; nextCursor: string | null }> {
  const filters: (SQL | undefined)[] = [isNull(postComments.parentId)];
  if (q.brandId) filters.push(eq(postComments.brandId, q.brandId));
  if (q.contentId) filters.push(eq(postComments.contentId, q.contentId));
  if (q.socialAccountId) filters.push(eq(postComments.socialAccountId, q.socialAccountId));
  if (!q.includeDeleted) filters.push(isNull(postComments.deletedAt));
  const reply = sql.raw('"post_comments_r"');
  if (q.filter === "unread") {
    filters.push(
      or(
        unreadSql,
        sql`exists (select 1 from ${postComments} as ${reply} where ${reply}.parent_id = ${postComments.id} and ${reply}.read_at is null and ${reply}.own = 0 and ${reply}.deleted_at is null)`,
      ),
    );
  } else if (q.filter === "unanswered") {
    filters.push(eq(postComments.own, false));
    filters.push(
      sql`not exists (select 1 from ${postComments} as ${reply} where ${reply}.parent_id = ${postComments.id} and ${reply}.own = 1 and ${reply}.deleted_at is null)`,
    );
    filters.push(
      sql`not exists (select 1 from ${commentActions} where ${commentActions.commentId} = ${postComments.id} and ${commentActions.kind} = 'reply' and ${commentActions.status} != 'failed')`,
    );
  }
  if (q.cursor) {
    const c = decodeTimeCursor(q.cursor);
    if (c) {
      filters.push(
        or(
          lt(postComments.createdAt, new Date(c.ms)),
          and(eq(postComments.createdAt, new Date(c.ms)), lt(postComments.id, c.id)),
        ),
      );
    }
  }
  const rows = await db
    .select()
    .from(postComments)
    .where(and(...filters))
    .orderBy(desc(postComments.createdAt), desc(postComments.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page.at(-1);
  return {
    items: await threadsOf(db, page, Boolean(q.includeDeleted)),
    nextCursor:
      rows.length > q.limit && last ? encodeTimeCursor(last.createdAt.getTime(), last.id) : null,
  };
}

/** The thread a comment belongs to (its top-level comment's). */
export async function threadOf(db: Db, id: string): Promise<CommentThread> {
  const row = await db.query.postComments.findFirst({ where: eq(postComments.id, id) });
  if (!row) throw notFound("comment", id);
  const top = row.parentId
    ? await db.query.postComments.findFirst({ where: eq(postComments.id, row.parentId) })
    : row;
  // Deleted replies are left out (the thread's own top-level comment is returned either way).
  const [thread] = await threadsOf(db, [top ?? row], false);
  if (!thread) throw notFound("comment", id);
  return thread;
}

export async function requireComment(db: Db, id: string): Promise<CommentRow> {
  const row = await db.query.postComments.findFirst({ where: eq(postComments.id, id) });
  if (!row) throw notFound("comment", id);
  return row;
}

export async function commentSummary(db: Db, brandId: string | undefined): Promise<CommentSummary> {
  const brandFilter = brandId ? eq(postComments.brandId, brandId) : undefined;
  const unreadRows = await db
    .select({ brandId: postComments.brandId, contentId: postComments.contentId, n: count() })
    .from(postComments)
    .where(and(unreadSql, brandFilter))
    .groupBy(postComments.brandId, postComments.contentId);
  const reply = sql.raw('"post_comments_r"');
  const unansweredRows = await db
    .select({ brandId: postComments.brandId, n: count() })
    .from(postComments)
    .where(
      and(
        brandFilter,
        isNull(postComments.parentId),
        isNull(postComments.deletedAt),
        eq(postComments.own, false),
        sql`not exists (select 1 from ${postComments} as ${reply} where ${reply}.parent_id = ${postComments.id} and ${reply}.own = 1 and ${reply}.deleted_at is null)`,
        sql`not exists (select 1 from ${commentActions} where ${commentActions.commentId} = ${postComments.id} and ${commentActions.kind} = 'reply' and ${commentActions.status} != 'failed')`,
      ),
    )
    .groupBy(postComments.brandId);
  const brands = new Map<string, { brandId: string; unread: number; unanswered: number }>();
  const contents = new Map<string, number>();
  let unread = 0;
  for (const r of unreadRows) {
    unread += r.n;
    const b = brands.get(r.brandId) ?? { brandId: r.brandId, unread: 0, unanswered: 0 };
    b.unread += r.n;
    brands.set(r.brandId, b);
    if (r.contentId) contents.set(r.contentId, (contents.get(r.contentId) ?? 0) + r.n);
  }
  for (const r of unansweredRows) {
    const b = brands.get(r.brandId) ?? { brandId: r.brandId, unread: 0, unanswered: 0 };
    b.unanswered = r.n;
    brands.set(r.brandId, b);
  }
  const syncRows = await db
    .select({ s: engagementSync, a: socialAccounts })
    .from(engagementSync)
    .innerJoin(socialAccounts, eq(socialAccounts.id, engagementSync.socialAccountId))
    .where(brandId ? eq(socialAccounts.brandId, brandId) : undefined);
  const last = syncRows
    .map((r) => r.s.commentsSyncedAt?.getTime() ?? 0)
    .reduce((a, b) => Math.max(a, b), 0);
  return {
    unread,
    brands: [...brands.values()],
    contents: [...contents.entries()].map(([contentId, n]) => ({ contentId, unread: n })),
    lastSyncAt: last ? new Date(last).toISOString() : null,
    needsReconnect: syncRows
      .filter((r) => r.s.status === "permission" || r.s.status === "auth")
      .map((r) => ({ socialAccountId: r.a.id, handle: r.a.handle })),
  };
}

// --- what the worker reads -----------------------------------------------------------------

export async function commentsTargets(
  db: Db,
  env: VaultEnv,
  q: { brandId?: string | undefined; limit: number },
  now: Date,
  opts: { actionsOnly?: boolean } = {},
): Promise<{
  accounts: WorkerEngagementAccount[];
  posts: WorkerEngagementPost[];
  actions: WorkerCommentActionItem[];
}> {
  const paused = new Set(
    (
      await db
        .select({ id: engagementSync.socialAccountId })
        .from(engagementSync)
        .where(gte(engagementSync.retryAt, now))
    ).map((r) => r.id),
  );
  const actionRows = await db
    .select({ a: commentActions, c: postComments })
    .from(commentActions)
    .innerJoin(postComments, eq(postComments.id, commentActions.commentId))
    .where(
      and(
        or(
          eq(commentActions.status, "pending"),
          and(
            eq(commentActions.status, "sending"),
            lt(commentActions.updatedAt, new Date(now.getTime() - SENDING_STALE_MS)),
          ),
        ),
        q.brandId ? eq(postComments.brandId, q.brandId) : undefined,
      ),
    )
    .orderBy(asc(commentActions.createdAt))
    .limit(50);
  const actions = actionRows
    .filter(({ c }) => !paused.has(c.socialAccountId))
    .map(({ a, c }) => ({
      id: a.id,
      commentId: a.commentId,
      socialAccountId: c.socialAccountId,
      platform: c.platform,
      kind: a.kind,
      text: a.text,
      externalCommentId: c.externalId,
      status: a.status,
      attempts: a.attempts,
    }));

  let posts: WorkerEngagementPost[] = [];
  if (!opts.actionsOnly) {
    const filters: SQL[] = [
      ne(postInsights.status, "deleted"),
      gte(schedules.publishedAt, new Date(now.getTime() - COMMENTS_MAX_AGE_DAYS * DAY)),
    ];
    if (q.brandId) filters.push(eq(postInsights.brandId, q.brandId));
    if (paused.size) filters.push(notInArray(postInsights.socialAccountId, [...paused]));
    const rows = await db
      .select({ pi: postInsights, s: schedules, type: contents.type })
      .from(postInsights)
      .innerJoin(schedules, eq(schedules.id, postInsights.scheduleId))
      .innerJoin(contents, eq(contents.id, postInsights.contentId))
      .where(and(...filters))
      .orderBy(desc(schedules.publishedAt))
      .limit(q.limit);
    posts = rows.map(({ pi, s, type }) => ({
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
  }
  const ids = [...new Set([...posts, ...actions].map((x) => x.socialAccountId))];
  const accounts = ids.length
    ? await engagementAccounts(db, env, inArray(socialAccounts.id, ids), null)
    : [];
  return { accounts, posts, actions };
}

// --- what the worker reported --------------------------------------------------------------

/** IG handle without `@`, lower case: own comments carry the account's username. */
const plainHandle = (h: string) => h.replace(/^@/, "").toLowerCase();

export async function applyCommentsReport(
  db: Db,
  report: z.output<typeof WorkerCommentsReport>,
  now: Date,
): Promise<{
  created: number;
  updated: number;
  newUnread: number;
  sample: { author: string | null; text: string } | null;
}> {
  let created = 0;
  let updated = 0;
  let newUnread = 0;
  let sample: { author: string | null; text: string } | null = null;
  const stmts: BatchItem<"sqlite">[] = [];
  const scheduleIds = report.posts.map((p) => p.scheduleId);
  const targets = scheduleIds.length
    ? await db
        .select({ pi: postInsights, a: socialAccounts })
        .from(postInsights)
        .innerJoin(socialAccounts, eq(socialAccounts.id, postInsights.socialAccountId))
        .where(inArray(postInsights.scheduleId, scheduleIds))
    : [];
  const byId = new Map(targets.map((t) => [t.pi.scheduleId, t]));

  for (const post of report.posts) {
    const target = byId.get(post.scheduleId);
    if (!target) continue;
    const { pi, a } = target;
    if (post.status !== "ok") {
      if (post.status === "deleted") {
        stmts.push(
          db
            .update(postInsights)
            .set({ commentsSyncedAt: now, updatedAt: now })
            .where(eq(postInsights.scheduleId, pi.scheduleId)),
        );
      }
      continue;
    }
    const existing = await db
      .select()
      .from(postComments)
      .where(
        and(
          eq(postComments.platform, pi.platform),
          eq(postComments.externalPostId, pi.externalPostId),
        ),
      );
    const byExternal = new Map(existing.map((c) => [c.externalId, c]));
    // Replies we sent ourselves (their ids came back with the action).
    const ourReplies = new Set(
      (
        await db
          .select({ id: commentActions.externalId })
          .from(commentActions)
          .innerJoin(postComments, eq(postComments.id, commentActions.commentId))
          .where(
            and(
              eq(postComments.externalPostId, pi.externalPostId),
              isNotNull(commentActions.externalId),
            ),
          )
      ).map((r) => r.id),
    );
    const handle = plainHandle(a.handle);
    const ownerId = a.externalId;
    const seen = new Set<string>();
    // Parents before replies so a reply finds its parent's Studio id.
    const ordered = [...post.comments].sort(
      (x, y) => Number(x.parentExternalId !== null) - Number(y.parentExternalId !== null),
    );
    const idOf = new Map(existing.map((c) => [c.externalId, c.id]));
    for (const c of ordered) {
      seen.add(c.externalId);
      const own =
        ourReplies.has(c.externalId) ||
        (c.author !== null && plainHandle(c.author) === handle) ||
        (c.authorId !== null && ownerId !== null && c.authorId === ownerId);
      const parentId = c.parentExternalId ? (idOf.get(c.parentExternalId) ?? null) : null;
      const prev = byExternal.get(c.externalId);
      if (!prev) {
        const id = newId();
        idOf.set(c.externalId, id);
        stmts.push(
          db
            .insert(postComments)
            .values({
              id,
              brandId: pi.brandId,
              socialAccountId: pi.socialAccountId,
              platform: pi.platform,
              scheduleId: pi.scheduleId,
              contentId: pi.contentId,
              externalPostId: pi.externalPostId,
              externalId: c.externalId,
              parentId,
              parentExternalId: c.parentExternalId,
              author: c.author,
              authorId: c.authorId,
              text: c.text,
              likeCount: c.likeCount,
              hidden: c.hidden ?? false,
              own,
              createdAt: c.createdAt ? new Date(c.createdAt) : now,
              firstSeenAt: now,
              readAt: own ? now : null,
              updatedAt: now,
            })
            .onConflictDoNothing(),
        );
        created++;
        if (!own) {
          newUnread++;
          sample ??= { author: c.author, text: c.text };
        }
      } else {
        const changed =
          prev.text !== c.text ||
          prev.likeCount !== c.likeCount ||
          (c.hidden !== null && prev.hidden !== c.hidden) ||
          prev.deletedAt !== null ||
          (own && !prev.own) ||
          (parentId !== null && prev.parentId === null);
        if (changed) {
          stmts.push(
            db
              .update(postComments)
              .set({
                text: c.text,
                likeCount: c.likeCount,
                ...(c.hidden !== null ? { hidden: c.hidden } : {}),
                ...(own ? { own: true, readAt: prev.readAt ?? now } : {}),
                ...(parentId !== null && prev.parentId === null ? { parentId } : {}),
                deletedAt: null,
                updatedAt: now,
              })
              .where(eq(postComments.id, prev.id)),
          );
          updated++;
        }
      }
    }
    if (post.complete) {
      const gone = existing.filter((c) => !seen.has(c.externalId) && c.deletedAt === null);
      if (gone.length) {
        stmts.push(
          db
            .update(postComments)
            .set({ deletedAt: now, updatedAt: now })
            .where(
              inArray(
                postComments.id,
                gone.map((g) => g.id),
              ),
            ),
        );
        updated += gone.length;
      }
    }
    stmts.push(
      db
        .update(postInsights)
        .set({
          commentsSyncedAt: now,
          ...(typeof post.commentCount === "number" ? { commentCount: post.commentCount } : {}),
          updatedAt: now,
        })
        .where(eq(postInsights.scheduleId, pi.scheduleId)),
    );
    // Write each post before the next one reads (a reply's parent may come from this batch).
    await runBatches(db, stmts.splice(0));
  }

  const accounts = report.accounts ?? [];
  if (accounts.length) {
    const rows = await db
      .select({ id: socialAccounts.id, brandId: socialAccounts.brandId })
      .from(socialAccounts)
      .where(
        inArray(
          socialAccounts.id,
          accounts.map((x) => x.socialAccountId),
        ),
      );
    const brandOf = new Map(rows.map((r) => [r.id, r.brandId]));
    for (const acc of accounts) {
      if (!brandOf.has(acc.socialAccountId)) continue;
      stmts.push(...accountReportStatements(db, acc, "comments", now, brandOf));
    }
  }
  await runBatches(db, stmts);
  return { created, updated, newUnread, sample };
}

/** An action's progress from the worker. A sent reply appears in the thread at once. */
export async function applyActionUpdate(
  db: Db,
  id: string,
  input: {
    status: "sending" | "done" | "failed";
    externalId?: string | null | undefined;
    error?: string | null | undefined;
    commentDeleted?: boolean | undefined;
  },
  now: Date,
): Promise<void> {
  const action = await db.query.commentActions.findFirst({ where: eq(commentActions.id, id) });
  if (!action) throw notFound("comment action", id);
  const comment = await requireComment(db, action.commentId);
  const stmts: BatchItem<"sqlite">[] = [];
  if (input.commentDeleted) {
    stmts.push(
      db
        .update(postComments)
        .set({ deletedAt: comment.deletedAt ?? now, updatedAt: now })
        .where(eq(postComments.id, comment.id)),
      db
        .update(commentActions)
        .set(
          action.kind === "delete"
            ? { status: "done", error: null, updatedAt: now }
            : {
                status: "failed",
                error: "Yorum platformda silinmiş; işlem yapılamadı.",
                updatedAt: now,
              },
        )
        .where(eq(commentActions.id, id)),
    );
    await runBatches(db, stmts);
    return;
  }
  if (input.status === "sending") {
    stmts.push(
      db
        .update(commentActions)
        .set({ status: "sending", attempts: action.attempts + 1, error: null, updatedAt: now })
        .where(eq(commentActions.id, id)),
    );
  } else if (input.status === "failed") {
    stmts.push(
      db
        .update(commentActions)
        .set({ status: "failed", error: input.error ?? "Gönderilemedi.", updatedAt: now })
        .where(eq(commentActions.id, id)),
    );
  } else {
    stmts.push(
      db
        .update(commentActions)
        .set({
          status: "done",
          error: null,
          externalId: input.externalId ?? action.externalId,
          updatedAt: now,
        })
        .where(eq(commentActions.id, id)),
    );
    if (action.kind === "reply" && input.externalId) {
      stmts.push(
        db
          .insert(postComments)
          .values({
            id: newId(),
            brandId: comment.brandId,
            socialAccountId: comment.socialAccountId,
            platform: comment.platform,
            scheduleId: comment.scheduleId,
            contentId: comment.contentId,
            externalPostId: comment.externalPostId,
            externalId: input.externalId,
            parentId: comment.parentId ?? comment.id,
            parentExternalId: comment.parentExternalId ?? comment.externalId,
            author: null,
            authorId: null,
            text: action.text ?? "",
            likeCount: 0,
            hidden: false,
            own: true,
            createdAt: now,
            firstSeenAt: now,
            readAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing(),
      );
    } else if (action.kind === "hide" || action.kind === "unhide") {
      stmts.push(
        db
          .update(postComments)
          .set({ hidden: action.kind === "hide", updatedAt: now })
          .where(eq(postComments.id, comment.id)),
      );
    } else if (action.kind === "delete") {
      stmts.push(
        db
          .update(postComments)
          .set({ deletedAt: now, updatedAt: now })
          .where(or(eq(postComments.id, comment.id), eq(postComments.parentId, comment.id))),
      );
    }
  }
  await runBatches(db, stmts);
}

/** Recent replies of an account (style examples for "Yanıt öner"). */
export async function recentOwnReplies(
  db: Db,
  socialAccountId: string,
  limit = 5,
): Promise<string[]> {
  const rows = await db
    .select({ text: postComments.text })
    .from(postComments)
    .where(
      and(
        eq(postComments.socialAccountId, socialAccountId),
        eq(postComments.own, true),
        isNotNull(postComments.parentId),
        isNull(postComments.deletedAt),
        ne(postComments.text, ""),
      ),
    )
    .orderBy(desc(postComments.createdAt))
    .limit(limit);
  return rows.map((r) => r.text);
}
