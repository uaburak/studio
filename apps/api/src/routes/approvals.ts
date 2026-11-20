import { createRoute } from "@hono/zod-openapi";
import {
  ApprovalActionResult,
  ApprovalApprove,
  ApprovalCreate,
  ApprovalList,
  ApprovalListQuery,
  ApprovalRegenerate,
  ApprovalReject,
  ApprovalRequest,
} from "@studio/contract";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { runChat } from "../chat/command.ts";
import { createDb } from "../db/client.ts";
import { toApproval, toContent } from "../db/mappers.ts";
import { approvalRequests } from "../db/schema.ts";
import {
  type ApprovalEnv,
  approveRequest,
  createApproval,
  pendingCounts,
  regenerateRequest,
  rejectRequest,
  requireApproval,
} from "../lib/approvals.ts";
import { toPage } from "../lib/pagination.ts";
import { type AppEnv, createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireWorkerToken } from "../middleware/worker-auth.ts";
import { loadContent } from "./contents.ts";
import { createJob, hubStub } from "./jobs.ts";

/*
 * Approval requests ("Onay bekleyenler", contract approval.ts). The owner decides from the chat
 * card, the Mac's details panel or the iPhone; the worker creates them
 * (`POST /api/worker/approvals`). Every change goes out as `approval.updated` on the job stream.
 */

const tags = ["Approvals"];

function approvalEnv(c: Context<AppEnv>): ApprovalEnv {
  return {
    env: c.env,
    createJob: (input) => createJob(c.env, input),
    announce: async (approval) => {
      try {
        await hubStub(c.env).approvalChanged(approval);
      } catch (error) {
        console.warn(`api: could not announce approval ${approval.id}`, error);
      }
    },
    loadContent: async (contentId) => {
      const db = createDb(c.env.DB);
      const loaded = await loadContent(db, contentId);
      const pending = await pendingCounts(db, [contentId]);
      return toContent(loaded.row, loaded.current, pending.get(contentId) ?? 0);
    },
    postMessage: async (input) => {
      const message = await runChat(c.env, { kind: "postApprovalMessage", ...input });
      return message.id;
    },
  };
}

export const approvalRoutes = createRouter();

approvalRoutes.use("/api/worker/approvals", requireWorkerToken);

approvalRoutes
  .openapi(
    createRoute({
      method: "get",
      path: "/api/approvals",
      tags,
      summary: "List approval requests (newest first; pending by default)",
      description:
        "Filter by `brandId`, `contentId` or `conversationId`; `status` defaults to `pending` " +
        "(`all` lists every status).",
      request: { query: ApprovalListQuery },
      responses: { 200: json(ApprovalList, "A page of approval requests."), 400: errors[400] },
    }),
    async (c) => {
      const { limit, cursor, brandId, contentId, conversationId, status } = c.req.valid("query");
      const where: SQL[] = [];
      if (brandId) where.push(eq(approvalRequests.brandId, brandId));
      if (contentId) where.push(eq(approvalRequests.contentId, contentId));
      if (conversationId) where.push(eq(approvalRequests.conversationId, conversationId));
      if (status !== "all") where.push(eq(approvalRequests.status, status));
      if (cursor) where.push(lt(approvalRequests.id, cursor));
      const rows = await createDb(c.env.DB)
        .select()
        .from(approvalRequests)
        .where(and(...where))
        .orderBy(desc(approvalRequests.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toApproval, (r) => r.id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/approvals/{id}",
      tags,
      summary: "Get an approval request",
      request: { params: IdParams },
      responses: { 200: json(ApprovalRequest, "The request."), 404: errors[404] },
    }),
    async (c) => {
      const row = await requireApproval(createDb(c.env.DB), c.req.valid("param").id);
      return c.json(toApproval(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/approvals/{id}/approve",
      tags,
      summary: "Approve: use the picture",
      description:
        "`product_image` / `variant`: the picture fills the post's slot (`slotId`) in a new " +
        "rendered version (`job` is the `content.render`; no slot = nothing placed, `job` null). " +
        "`product_photo_upgrade`: the picture replaces the product's photo; the old photo goes " +
        "to the trash for TRASH_RETENTION_DAYS. The pictures not chosen go to the trash too " +
        "(unless something else uses them). 409 unless pending.",
      request: { params: IdParams, body: jsonBody(ApprovalApprove) },
      responses: {
        200: json(ApprovalActionResult, "Approved."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const result = await approveRequest(
        approvalEnv(c),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/approvals/{id}/reject",
      tags,
      summary: "Reject: do not use the pictures",
      description:
        "The request's pictures go to the trash (restorable for TRASH_RETENTION_DAYS) unless " +
        "something else uses them (a post version, a product, another pending request…). " +
        "409 unless pending.",
      request: { params: IdParams, body: jsonBody(ApprovalReject) },
      responses: {
        200: json(ApprovalActionResult, "Rejected."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const result = await rejectRequest(
        approvalEnv(c),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/approvals/{id}/regenerate",
      tags,
      summary: "Generate again (the owner's consent; paid)",
      description:
        "Queues the request's generation again (`job`) and marks the request `superseded`; the " +
        'new pictures arrive as a new request. `preserveLabelComposite: true` ("Etiketi birebir ' +
        'koruyarak yerleştir") places the real product photo into the scene instead of letting ' +
        "the model redraw it (picture generations only). The old request's pictures go to the " +
        "trash unless something else uses them. 409 for decided requests or when the original " +
        "request is unknown.",
      request: { params: IdParams, body: jsonBody(ApprovalRegenerate) },
      responses: {
        200: json(ApprovalActionResult, "Queued."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const result = await regenerateRequest(
        approvalEnv(c),
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return c.json(result, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/approvals",
      tags,
      security: [{ workerToken: [] }],
      summary: "Worker: a finished generation asks for the owner's word",
      description:
        "Pictures must be `image` assets of the brand; the post, product, conversation and " +
        "message must belong to it. `supersedesId` marks that pending request `superseded`. " +
        "`chatMessage` (with `conversationId`, without `messageId`) posts an assistant message " +
        "with the text and the request's card into the conversation.",
      request: { body: jsonBody(ApprovalCreate) },
      responses: {
        201: json(ApprovalRequest, "Created."),
        400: errors[400],
        401: { description: "Missing or wrong worker token (plain text)." },
        404: errors[404],
      },
    }),
    async (c) => {
      const view = await createApproval(approvalEnv(c), c.req.valid("json"));
      return c.json(view, 201);
    },
  );
