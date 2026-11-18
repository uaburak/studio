import { z } from "zod";
import {
  COMMENT_REPLY_MAX,
  CommentActionKind,
  CommentActionStatus,
  CommentThread,
} from "./comments.ts";
import { EntityId, Platform, Timestamp } from "./common.ts";
import { ContentType } from "./content.ts";
import { InsightMetrics } from "./insights.ts";
import { PublishLocation } from "./publish-details.ts";

/**
 * The worker's side of statistics and comments (N15, N16): the jobs, what the API hands the
 * worker to read (accounts with tokens, published posts, queued comment actions) and what the
 * worker reports back. Only the worker token reaches `/api/worker/*`.
 */

// --- jobs -------------------------------------------------------------------------------------

/**
 * `insights.sync`: read the statistics that are due (1 h / 24 h / 72 h after publishing, then
 * daily) and every account's follower count once a day. The Hub queues it while the worker is
 * connected; `POST /api/insights/sync` queues one with `force` for a brand or a post.
 */
export const InsightsSyncPayload = z
  .object({
    brandId: EntityId.optional(),
    contentId: EntityId.optional(),
    /** Read even what is not due yet. */
    force: z.boolean().optional(),
  })
  .meta({ id: "InsightsSyncPayload" });
export type InsightsSyncPayload = z.infer<typeof InsightsSyncPayload>;

/**
 * `comments.sync`: send queued replies / hides / deletes, then read new comments (every 15
 * minutes while the worker runs; at once after a reply is written, with `actionsOnly`).
 */
export const CommentsSyncPayload = z
  .object({
    brandId: EntityId.optional(),
    /** Only send the queued actions (a reply was just written). */
    actionsOnly: z.boolean().optional(),
  })
  .meta({ id: "CommentsSyncPayload" });
export type CommentsSyncPayload = z.infer<typeof CommentsSyncPayload>;

/** `comments.suggest`: draft a reply in the brand's voice (the owner edits and sends it). */
export const CommentsSuggestPayload = z
  .object({
    commentId: EntityId,
    instruction: z.string().max(500).optional(),
  })
  .meta({ id: "CommentsSuggestPayload" });
export type CommentsSuggestPayload = z.infer<typeof CommentsSuggestPayload>;

/** What a finished `comments.sync` reports (the Mac's notice reads `newComments`). */
export const CommentsSyncOutput = z
  .object({
    newComments: z.number().int().min(0),
    sample: z.object({ author: z.string().nullable(), text: z.string() }).nullable(),
    actionsSent: z.number().int().min(0),
    brandId: EntityId.nullable(),
  })
  .meta({ id: "CommentsSyncOutput" });
export type CommentsSyncOutput = z.infer<typeof CommentsSyncOutput>;

// --- what the worker reads --------------------------------------------------------------------

export const WorkerEngagementTargetsQuery = z
  .object({
    kind: z.enum(["insights", "comments"]),
    brandId: EntityId.optional(),
    contentId: EntityId.optional(),
    force: z.stringbool().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .meta({ id: "WorkerEngagementTargetsQuery" });
export type WorkerEngagementTargetsQuery = z.input<typeof WorkerEngagementTargetsQuery>;

export const WorkerEngagementAccount = z
  .object({
    socialAccountId: EntityId,
    brandId: EntityId,
    platform: Platform,
    externalId: z.string(),
    handle: z.string(),
    /** Null when the token cannot be read (the account is reported as needing reconnect). */
    accessToken: z.string().nullable(),
    /** Insights: today's follower count is not read yet. */
    followersDue: z.boolean(),
  })
  .meta({ id: "WorkerEngagementAccount" });
export type WorkerEngagementAccount = z.infer<typeof WorkerEngagementAccount>;

export const WorkerEngagementPost = z
  .object({
    scheduleId: EntityId,
    contentId: EntityId,
    brandId: EntityId,
    socialAccountId: EntityId,
    platform: Platform,
    externalPostId: z.string(),
    contentType: ContentType,
    publishedAt: Timestamp.nullable(),
    /** Comments: the count seen last time (null: never read). */
    commentCount: z.number().int().min(0).nullable(),
    /** Reads in a row that found nothing (deleted after two). */
    missCount: z.number().int().min(0),
  })
  .meta({ id: "WorkerEngagementPost" });
export type WorkerEngagementPost = z.infer<typeof WorkerEngagementPost>;

export const WorkerCommentActionItem = z
  .object({
    id: EntityId,
    commentId: EntityId,
    socialAccountId: EntityId,
    platform: Platform,
    kind: CommentActionKind,
    text: z.string().nullable(),
    /** The comment the action is on (platform id). */
    externalCommentId: z.string(),
    status: CommentActionStatus,
    attempts: z.number().int().min(0),
  })
  .meta({ id: "WorkerCommentActionItem" });
export type WorkerCommentActionItem = z.infer<typeof WorkerCommentActionItem>;

export const WorkerEngagementTargets = z
  .object({
    accounts: z.array(WorkerEngagementAccount),
    posts: z.array(WorkerEngagementPost),
    /** Comments only: queued and interrupted actions, oldest first. */
    actions: z.array(WorkerCommentActionItem),
  })
  .meta({ id: "WorkerEngagementTargets" });
export type WorkerEngagementTargets = z.infer<typeof WorkerEngagementTargets>;

// --- what the worker reports ------------------------------------------------------------------

export const WorkerAccountReport = z
  .object({
    socialAccountId: EntityId,
    status: z.enum(["ok", "permission", "auth", "rate_limited", "error"]),
    error: z.string().max(1000).nullable().optional(),
    /** Rate limit: read nothing for this account before this. */
    retryAt: Timestamp.nullable().optional(),
    /** Insights: the follower count read now. */
    followers: z.number().int().min(0).nullable().optional(),
    /** A Facebook Page with an address: usable as an Instagram location (N13). */
    pageLocation: PublishLocation.nullable().optional(),
  })
  .meta({ id: "WorkerAccountReport" });
export type WorkerAccountReport = z.input<typeof WorkerAccountReport>;

export const WorkerInsightsReport = z
  .object({
    posts: z
      .array(
        z.object({
          scheduleId: EntityId,
          /** `missing`: not found this time (deleted after two in a row). */
          status: z.enum(["ok", "partial", "deleted", "missing", "error"]),
          metrics: InsightMetrics.default({}),
          note: z.string().max(1000).nullable().optional(),
          error: z.string().max(1000).nullable().optional(),
        }),
      )
      .max(200),
    accounts: z.array(WorkerAccountReport).max(50).default([]),
  })
  .meta({ id: "WorkerInsightsReport" });
export type WorkerInsightsReport = z.input<typeof WorkerInsightsReport>;

export const WorkerInsightsAck = z
  .object({
    posts: z.number().int().min(0),
    snapshots: z.number().int().min(0),
  })
  .meta({ id: "WorkerInsightsAck" });
export type WorkerInsightsAck = z.infer<typeof WorkerInsightsAck>;

export const WorkerComment = z
  .object({
    externalId: z.string().min(1).max(128),
    parentExternalId: z.string().max(128).nullable(),
    text: z.string().max(10_000),
    author: z.string().max(200).nullable(),
    authorId: z.string().max(128).nullable(),
    createdAt: Timestamp.nullable(),
    likeCount: z.number().int().min(0).nullable(),
    hidden: z.boolean().nullable(),
  })
  .meta({ id: "WorkerComment" });
export type WorkerComment = z.infer<typeof WorkerComment>;

export const WorkerCommentsReport = z
  .object({
    posts: z
      .array(
        z.object({
          scheduleId: EntityId,
          status: z.enum(["ok", "deleted", "missing", "error"]).default("ok"),
          /** Meta's count for the post (stored to skip unchanged posts next time). */
          commentCount: z.number().int().min(0).nullable().optional(),
          /** The whole list was read: comments not in it were deleted on the platform. */
          complete: z.boolean().default(false),
          comments: z.array(WorkerComment).max(1000).default([]),
          error: z.string().max(1000).nullable().optional(),
        }),
      )
      .max(200),
    accounts: z.array(WorkerAccountReport).max(50).default([]),
  })
  .meta({ id: "WorkerCommentsReport" });
export type WorkerCommentsReport = z.input<typeof WorkerCommentsReport>;

export const WorkerCommentsAck = z
  .object({
    created: z.number().int().min(0),
    updated: z.number().int().min(0),
    /** New comments from others (unread), for the notice. */
    newUnread: z.number().int().min(0),
    sample: z.object({ author: z.string().nullable(), text: z.string() }).nullable(),
  })
  .meta({ id: "WorkerCommentsAck" });
export type WorkerCommentsAck = z.infer<typeof WorkerCommentsAck>;

/** `POST /api/worker/engagement/actions/{id}`: an action's progress. */
export const WorkerCommentActionUpdate = z
  .object({
    status: z.enum(["sending", "done", "failed"]),
    /** A reply's comment id. */
    externalId: z.string().max(128).nullable().optional(),
    error: z.string().max(1000).nullable().optional(),
    /** The comment is gone on the platform (a delete is then done). */
    commentDeleted: z.boolean().optional(),
  })
  .meta({ id: "WorkerCommentActionUpdate" });
export type WorkerCommentActionUpdate = z.input<typeof WorkerCommentActionUpdate>;

/** `GET /api/worker/comments/{id}/context`: what "Yanıt öner" writes from. */
export const WorkerCommentContext = z
  .object({
    thread: CommentThread,
    brandId: EntityId,
    brandName: z.string(),
    platform: Platform,
    /** The post's caption and title (data, not instructions). */
    caption: z.string(),
    contentTitle: z.string().nullable(),
    /** The approved brand profile's voice (VOICE.md), when there is one. */
    voice: z.string().nullable(),
    /** The account's own recent replies (style examples). */
    recentReplies: z.array(z.string()),
    maxChars: z.number().int(),
  })
  .meta({ id: "WorkerCommentContext" });
export type WorkerCommentContext = z.infer<typeof WorkerCommentContext>;

export const WorkerCommentSuggestion = z
  .object({ text: z.string().trim().min(1).max(COMMENT_REPLY_MAX.facebook) })
  .meta({ id: "WorkerCommentSuggestion" });
export type WorkerCommentSuggestion = z.input<typeof WorkerCommentSuggestion>;

// --- scheduling (shared by the API and its tests) -------------------------------------------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * When a published post's statistics should be read next: at 1 h, 24 h and 72 h after
 * publishing, then a day after the last read, for 90 days. Null: no more reads.
 */
export function nextInsightsSyncAt(
  publishedAt: number,
  lastSyncAt: number | null,
  maxAgeDays = 90,
): number | null {
  const end = publishedAt + maxAgeDays * DAY;
  const last = lastSyncAt ?? Number.NEGATIVE_INFINITY;
  for (const h of [1, 24, 72]) {
    const at = publishedAt + h * HOUR;
    if (last < at) return at;
  }
  const next = Math.max(publishedAt + 72 * HOUR, last) + DAY;
  return next > end ? null : next;
}
