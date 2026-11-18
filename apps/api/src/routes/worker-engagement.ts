/**
 * The worker's statistics and comment API (N15, N16): what to read (with tokens), what was read,
 * comment action progress, and what "Yanıt öner" writes from. Worker token only.
 */
import { createRoute } from "@hono/zod-openapi";
import {
  COMMENT_REPLY_MAX,
  CommentThread,
  WorkerCommentActionUpdate,
  WorkerCommentContext,
  WorkerCommentSuggestion,
  WorkerCommentsAck,
  WorkerCommentsReport,
  WorkerEngagementTargets,
  WorkerEngagementTargetsQuery,
  WorkerInsightsAck,
  WorkerInsightsReport,
} from "@studio/contract";
import { and, desc, eq } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { brandProfiles, brands, contents, postComments } from "../db/schema.ts";
import {
  applyActionUpdate,
  applyCommentsReport,
  commentsTargets,
  recentOwnReplies,
  requireComment,
  threadOf,
} from "../lib/comments.ts";
import { applyInsightsReport, insightsTargets } from "../lib/insights.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireWorkerToken } from "../middleware/worker-auth.ts";

const tags = ["Worker engagement"];
const security = [{ workerToken: [] }];
const unauthorized = { description: "Missing or wrong worker token (plain text)." };

export const workerEngagementRoutes = createRouter();
workerEngagementRoutes.use("/api/worker/*", requireWorkerToken);

workerEngagementRoutes
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/engagement/targets",
      tags,
      security,
      summary: "Posts and accounts to read (with tokens), and queued comment actions",
      description:
        "`kind=insights`: posts whose statistics are due (or every live post of a brand / post " +
        "with `force`) and accounts whose follower count of today is missing. `kind=comments`: " +
        "posts of the last 30 days and the queued replies / hides / deletes. Accounts paused " +
        "by Meta's rate limit are left out.",
      request: { query: WorkerEngagementTargetsQuery },
      responses: {
        200: json(WorkerEngagementTargets, "Targets."),
        400: errors[400],
        401: unauthorized,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const db = createDb(c.env.DB);
      const now = new Date();
      if (q.kind === "insights") {
        const t = await insightsTargets(db, c.env, q, now);
        return c.json({ ...t, actions: [] }, 200);
      }
      return c.json(await commentsTargets(db, c.env, q, now), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/engagement/insights",
      tags,
      security,
      summary: "Report statistics read (posts and accounts)",
      request: { body: jsonBody(WorkerInsightsReport) },
      responses: { 200: json(WorkerInsightsAck, "Stored."), 400: errors[400], 401: unauthorized },
    }),
    async (c) => {
      const input = c.req.valid("json");
      return c.json(await applyInsightsReport(createDb(c.env.DB), input, new Date()), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/engagement/comments",
      tags,
      security,
      summary: "Report comments read (posts and accounts)",
      request: { body: jsonBody(WorkerCommentsReport) },
      responses: { 200: json(WorkerCommentsAck, "Stored."), 400: errors[400], 401: unauthorized },
    }),
    async (c) => {
      const input = c.req.valid("json");
      return c.json(await applyCommentsReport(createDb(c.env.DB), input, new Date()), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/engagement/actions/{id}",
      tags,
      security,
      summary: "A comment action's progress (sending, done with the reply id, failed)",
      request: { params: IdParams, body: jsonBody(WorkerCommentActionUpdate) },
      responses: {
        204: { description: "Stored." },
        400: errors[400],
        401: unauthorized,
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      await applyActionUpdate(createDb(c.env.DB), id, input, new Date());
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/comments/{id}/context",
      tags,
      security,
      summary: 'What "Yanıt öner" writes from: the thread, the post, the brand\'s voice',
      request: { params: IdParams },
      responses: {
        200: json(WorkerCommentContext, "Context."),
        401: unauthorized,
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const comment = await requireComment(db, id);
      const thread = await threadOf(db, id);
      const brand = await db.query.brands.findFirst({ where: eq(brands.id, comment.brandId) });
      const content = comment.contentId
        ? await db.query.contents.findFirst({ where: eq(contents.id, comment.contentId) })
        : undefined;
      const [profile] = await db
        .select({ voice: brandProfiles.voice })
        .from(brandProfiles)
        .where(
          and(eq(brandProfiles.brandId, comment.brandId), eq(brandProfiles.status, "approved")),
        )
        .orderBy(desc(brandProfiles.version))
        .limit(1);
      return c.json(
        {
          thread,
          brandId: comment.brandId,
          brandName: brand?.name ?? "",
          platform: comment.platform,
          caption: content?.caption ?? "",
          contentTitle: content?.title ?? null,
          voice: profile?.voice ?? null,
          recentReplies: await recentOwnReplies(db, comment.socialAccountId),
          maxChars:
            comment.platform === "instagram"
              ? COMMENT_REPLY_MAX.instagram
              : COMMENT_REPLY_MAX.facebook,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/worker/comments/{id}/suggestion",
      tags,
      security,
      summary: 'Store a "Yanıt öner" draft on the comment (never sent by itself)',
      request: { params: IdParams, body: jsonBody(WorkerCommentSuggestion) },
      responses: { 200: json(CommentThread, "Thread."), 401: unauthorized, 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { text } = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireComment(db, id);
      const now = new Date();
      await db
        .update(postComments)
        .set({ suggestion: text, suggestionAt: now, updatedAt: now })
        .where(eq(postComments.id, id));
      return c.json(await threadOf(db, id), 200);
    },
  );
