import { z } from "zod";
import { EntityId, PageQuery, Platform, pageOf, Timestamp } from "./common.ts";

/**
 * Comment inbox (N16): comments under the brand's published Instagram media and Facebook Page
 * posts, read by the Mac's worker every 15 minutes while it runs (`comments.sync`; webhooks would
 * need a public address — possible later through the Cloudflare tunnel). The owner reads, filters
 * (by post, unread, unanswered), replies, hides or deletes; "Yanıt öner" drafts a reply in the
 * brand's voice that the owner edits and sends — nothing is ever sent automatically.
 *
 * Replies, hiding and deleting are queued as actions the worker sends (it holds the tokens); a
 * reply interrupted after Meta accepted it is found again instead of being sent twice.
 */

export const CommentActionKind = z
  .enum(["reply", "hide", "unhide", "delete"])
  .meta({ id: "CommentActionKind" });
export type CommentActionKind = z.infer<typeof CommentActionKind>;

export const CommentActionStatus = z
  .enum(["pending", "sending", "done", "failed"])
  .meta({ id: "CommentActionStatus" });
export type CommentActionStatus = z.infer<typeof CommentActionStatus>;

export const CommentAction = z
  .object({
    id: EntityId,
    kind: CommentActionKind,
    status: CommentActionStatus,
    /** The reply's text. */
    text: z.string().nullable(),
    error: z.string().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "CommentAction" });
export type CommentAction = z.infer<typeof CommentAction>;

const CommentBase = z.object({
  id: EntityId,
  brandId: EntityId,
  socialAccountId: EntityId,
  platform: Platform,
  /** The Studio post and schedule it is under (null: not a Studio post). */
  contentId: EntityId.nullable(),
  scheduleId: EntityId.nullable(),
  externalPostId: z.string(),
  externalId: z.string(),
  /** Parent comment (Studio id) for replies. */
  parentId: EntityId.nullable(),
  /** Instagram username / Facebook name; null when Meta does not say. */
  author: z.string().nullable(),
  text: z.string(),
  likeCount: z.number().int().min(0).nullable(),
  hidden: z.boolean(),
  /** Written by the account itself (our replies, the first comment). */
  own: z.boolean(),
  /** When it was written (platform time) or first seen. */
  createdAt: Timestamp,
  readAt: Timestamp.nullable(),
  /** Deleted (by us or on the platform). */
  deletedAt: Timestamp.nullable(),
});

export const PostComment = CommentBase.extend({
  /** The account replied under it (a reply of ours exists or is being sent). */
  answered: z.boolean(),
  /** Last action on it that is not done yet, or failed (shown with "Yeniden dene"). */
  pendingAction: CommentAction.nullable(),
  /** "Yanıt öner" draft (never sent by itself). */
  suggestion: z.string().nullable(),
  suggestionAt: Timestamp.nullable(),
}).meta({ id: "PostComment" });
export type PostComment = z.infer<typeof PostComment>;

/** A top-level comment with its replies (oldest first). */
export const CommentThread = PostComment.extend({
  replies: z.array(PostComment),
  /** The post's title, for lists over several posts. */
  contentTitle: z.string().nullable(),
  permalink: z.string().nullable(),
}).meta({ id: "CommentThread" });
export type CommentThread = z.infer<typeof CommentThread>;

export const CommentFilter = z.enum(["all", "unread", "unanswered"]).meta({ id: "CommentFilter" });
export type CommentFilter = z.infer<typeof CommentFilter>;

/** `GET /api/comments`: newest threads first. */
export const CommentListQuery = PageQuery.extend({
  brandId: EntityId.optional(),
  contentId: EntityId.optional(),
  socialAccountId: EntityId.optional(),
  filter: CommentFilter.default("all"),
  /** Include hidden and deleted comments (default: hidden yes, deleted no). */
  includeDeleted: z.stringbool().optional(),
});
export type CommentListQuery = z.input<typeof CommentListQuery>;

export const CommentList = pageOf(CommentThread, "CommentList");
export type CommentList = z.infer<typeof CommentList>;

/** `GET /api/comments/summary`: unread counts for the sidebar and the posts. */
export const CommentSummary = z
  .object({
    unread: z.number().int().min(0),
    brands: z.array(
      z.object({
        brandId: EntityId,
        unread: z.number().int().min(0),
        unanswered: z.number().int().min(0),
      }),
    ),
    /** Unread per post (only posts with unread comments). */
    contents: z.array(z.object({ contentId: EntityId, unread: z.number().int().min(0) })),
    lastSyncAt: Timestamp.nullable(),
    /** Accounts whose comments cannot be read: missing permission or invalid token. */
    needsReconnect: z.array(z.object({ socialAccountId: EntityId, handle: z.string() })),
  })
  .meta({ id: "CommentSummary" });
export type CommentSummary = z.infer<typeof CommentSummary>;

export const CommentSummaryQuery = z.object({ brandId: EntityId.optional() });
export type CommentSummaryQuery = z.input<typeof CommentSummaryQuery>;

/** Reply text limits: Instagram comments 2,200, Facebook 8,000 characters. */
export const COMMENT_REPLY_MAX = { instagram: 2200, facebook: 8000 } as const;

export const CommentReplyCreate = z
  .object({ text: z.string().trim().min(1).max(COMMENT_REPLY_MAX.facebook) })
  .meta({ id: "CommentReplyCreate" });
export type CommentReplyCreate = z.input<typeof CommentReplyCreate>;

export const CommentModerate = z
  .object({ action: z.enum(["hide", "unhide", "delete"]) })
  .meta({ id: "CommentModerate" });
export type CommentModerate = z.input<typeof CommentModerate>;

/** Body of `POST /api/comments/read`: the given comments, or all of a brand / post. */
export const CommentReadInput = z
  .object({
    ids: z.array(EntityId).max(500).optional(),
    brandId: EntityId.optional(),
    contentId: EntityId.optional(),
    /** Mark unread again (only with `ids`). */
    unread: z.boolean().optional(),
  })
  .refine((v) => v.ids?.length || v.brandId || v.contentId, "ids, brandId or contentId is required")
  .meta({ id: "CommentReadInput" });
export type CommentReadInput = z.input<typeof CommentReadInput>;

export const CommentReadResult = z
  .object({ updated: z.number().int().min(0) })
  .meta({ id: "CommentReadResult" });
export type CommentReadResult = z.infer<typeof CommentReadResult>;

/** Body of `POST /api/comments/{id}/suggest` (queues `comments.suggest`). */
export const CommentSuggestInput = z
  .object({
    /** A hint from the owner ("kısa olsun", "DM'e yönlendir"). */
    instruction: z.string().trim().max(500).optional(),
  })
  .meta({ id: "CommentSuggestInput" });
export type CommentSuggestInput = z.input<typeof CommentSuggestInput>;

export const CommentsSyncInput = z
  .object({ brandId: EntityId.optional() })
  .meta({ id: "CommentsSyncInput" });
export type CommentsSyncInput = z.input<typeof CommentsSyncInput>;

/** Notice text for new comments: "3 yeni yorum" / "Yeni yorum: …". */
export function newCommentsNotice(
  count: number,
  sample?: { author: string | null; text: string },
): { title: string; body: string } {
  if (count === 1 && sample) {
    const who = sample.author ? `${sample.author}: ` : "";
    const text = sample.text.length > 120 ? `${sample.text.slice(0, 117)}…` : sample.text;
    return { title: "Yeni yorum", body: `${who}${text}` };
  }
  return { title: `${count} yeni yorum`, body: "Yorumlar sayfasında yanıtlayabilirsiniz." };
}
