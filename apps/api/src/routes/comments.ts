/**
 * Comment inbox (N16): threads, counts, replies, hide / delete, read marks, "Yanıt öner".
 * Replies and moderation are queued; the worker sends them (`comments.sync`). Nothing is sent
 * without the owner: "Yanıt öner" only drafts.
 */
import { createRoute } from "@hono/zod-openapi";
import {
  COMMENT_REPLY_MAX,
  CommentList,
  CommentListQuery,
  CommentModerate,
  CommentReadInput,
  CommentReadResult,
  CommentReplyCreate,
  CommentSuggestInput,
  CommentSummary,
  CommentSummaryQuery,
  CommentsSyncInput,
  CommentThread,
  Job,
} from "@studio/contract";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { commentActions, postComments } from "../db/schema.ts";
import { commentSummary, listThreads, requireComment, threadOf } from "../lib/comments.ts";
import { badRequest, conflict } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";
import { createJob } from "./jobs.ts";

const tags = ["Comments"];

/** Send what was queued now (the worker may be busy; the job waits in the queue). */
async function queueSend(env: Env, brandId: string): Promise<void> {
  try {
    await createJob(env, {
      type: "comments.sync",
      payload: { brandId, actionsOnly: true },
      brandId,
    });
  } catch (error) {
    // The Hub's own schedule sends pending actions too.
    console.warn("api: could not queue comments.sync", error);
  }
}

export const commentRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/comments",
      tags,
      summary: "Comment threads under published posts, newest first",
      request: { query: CommentListQuery },
      responses: { 200: json(CommentList, "Threads."), 400: errors[400] },
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(await listThreads(createDb(c.env.DB), q), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/comments/summary",
      tags,
      summary: "Unread and unanswered counts (sidebar, posts), last read, reconnect hints",
      request: { query: CommentSummaryQuery },
      responses: { 200: json(CommentSummary, "Counts."), 400: errors[400] },
    }),
    async (c) => {
      const q = c.req.valid("query");
      return c.json(await commentSummary(createDb(c.env.DB), q.brandId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/comments/read",
      tags,
      summary: "Mark comments read (or unread again)",
      request: { body: jsonBody(CommentReadInput) },
      responses: { 200: json(CommentReadResult, "Updated."), 400: errors[400] },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const now = new Date();
      const scope = input.ids?.length
        ? or(inArray(postComments.id, input.ids), inArray(postComments.parentId, input.ids))
        : and(
            input.brandId ? eq(postComments.brandId, input.brandId) : undefined,
            input.contentId ? eq(postComments.contentId, input.contentId) : undefined,
          );
      const rows = await db
        .update(postComments)
        .set({ readAt: input.unread && input.ids?.length ? null : now, updatedAt: now })
        .where(
          and(
            scope,
            eq(postComments.own, false),
            input.unread ? undefined : isNull(postComments.readAt),
          ),
        )
        .returning({ id: postComments.id });
      return c.json({ updated: rows.length }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/comments/sync",
      tags,
      summary: "Read new comments now",
      request: { body: jsonBody(CommentsSyncInput) },
      responses: { 202: json(Job, "Queued `comments.sync`."), 404: errors[404] },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      if (input.brandId) await requireBrand(db, input.brandId);
      const job = await createJob(c.env, {
        type: "comments.sync",
        payload: input.brandId ? { brandId: input.brandId } : {},
        ...(input.brandId ? { brandId: input.brandId } : {}),
      });
      return c.json(job, 202);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/comments/{id}",
      tags,
      summary: "The thread a comment belongs to",
      request: { params: IdParams },
      responses: { 200: json(CommentThread, "Thread."), 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      return c.json(await threadOf(createDb(c.env.DB), id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/comments/{id}/reply",
      tags,
      summary: "Queue a reply (the worker sends it)",
      description:
        "Instagram replies are at most 2,200 characters, Facebook 8,000. The comment is marked " +
        "read. 409 for a deleted comment.",
      request: { params: IdParams, body: jsonBody(CommentReplyCreate) },
      responses: {
        200: json(CommentThread, "Thread with the queued reply."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { text } = c.req.valid("json");
      const db = createDb(c.env.DB);
      const comment = await requireComment(db, id);
      if (comment.deletedAt) throw conflict("Yorum silinmiş; yanıtlanamaz.");
      const max =
        comment.platform === "instagram" ? COMMENT_REPLY_MAX.instagram : COMMENT_REPLY_MAX.facebook;
      if ([...text].length > max) {
        throw badRequest("reply is too long", [
          { path: "text", message: `en fazla ${max.toLocaleString("tr-TR")} karakter` },
        ]);
      }
      const now = new Date();
      await db.batch([
        db.insert(commentActions).values({
          id: newId(),
          commentId: id,
          kind: "reply",
          text,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        }),
        db
          .update(postComments)
          .set({ readAt: comment.readAt ?? now, updatedAt: now })
          .where(eq(postComments.id, id)),
      ]);
      await queueSend(c.env, comment.brandId);
      return c.json(await threadOf(db, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/comments/{id}/moderate",
      tags,
      summary: "Hide, show or delete a comment (queued; the worker sends it)",
      description:
        "Instagram and Facebook allow hiding and deleting comments under the account's own " +
        "posts. The account's own comments cannot be hidden on Instagram (delete them instead).",
      request: { params: IdParams, body: jsonBody(CommentModerate) },
      responses: {
        200: json(CommentThread, "Thread."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { action } = c.req.valid("json");
      const db = createDb(c.env.DB);
      const comment = await requireComment(db, id);
      if (comment.deletedAt) throw conflict("Yorum zaten silinmiş.");
      if (action !== "delete" && comment.own && comment.platform === "instagram") {
        throw conflict("Hesabın kendi yorumu Instagram'da gizlenemez; silebilirsiniz.");
      }
      if ((action === "hide" && comment.hidden) || (action === "unhide" && !comment.hidden)) {
        return c.json(await threadOf(db, id), 200);
      }
      const now = new Date();
      await db.insert(commentActions).values({
        id: newId(),
        commentId: id,
        kind: action,
        text: null,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
      await queueSend(c.env, comment.brandId);
      return c.json(await threadOf(db, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/comments/{id}/retry",
      tags,
      summary: "Send a failed reply / moderation again",
      request: { params: IdParams },
      responses: { 200: json(CommentThread, "Thread."), 404: errors[404], 409: errors[409] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const comment = await requireComment(db, id);
      const [failed] = await db
        .select()
        .from(commentActions)
        .where(and(eq(commentActions.commentId, id), eq(commentActions.status, "failed")))
        .orderBy(desc(commentActions.createdAt))
        .limit(1);
      if (!failed) throw conflict("Yeniden denenecek bir işlem yok.");
      await db
        .update(commentActions)
        .set({ status: "pending", error: null, updatedAt: new Date() })
        .where(eq(commentActions.id, failed.id));
      await queueSend(c.env, comment.brandId);
      return c.json(await threadOf(db, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/comments/{id}/suggest",
      tags,
      summary: '"Yanıt öner": draft a reply in the brand\'s voice (queued `comments.suggest`)',
      description:
        "The draft lands on the comment (`suggestion`) and in the job's output; it is never " +
        "sent by itself.",
      request: { params: IdParams, body: jsonBody(CommentSuggestInput) },
      responses: { 202: json(Job, "Queued."), 404: errors[404], 409: errors[409] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const comment = await requireComment(db, id);
      if (comment.deletedAt) throw conflict("Yorum silinmiş.");
      const job = await createJob(c.env, {
        type: "comments.suggest",
        payload: {
          commentId: id,
          ...(input.instruction ? { instruction: input.instruction } : {}),
        },
        brandId: comment.brandId,
        priority: 5,
      });
      return c.json(job, 202);
    },
  );
