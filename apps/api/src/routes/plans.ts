import { createRoute } from "@hono/zod-openapi";
import {
  AgentRun,
  Plan,
  PlanAccept,
  PlanGenerate,
  PlanGenerateResult,
  PlanList,
  PlanListQuery,
  PlanReject,
  PlanUpdate,
} from "@studio/contract";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { runChat } from "../chat/command.ts";
import { loadPlan, plansWithItems, requireRun } from "../chat/read.ts";
import { createDb } from "../db/client.ts";
import { toAgentRun } from "../db/mappers.ts";
import { contentPlans } from "../db/schema.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";

// --- agent runs ---------------------------------------------------------------------

export const agentRunRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/agent-runs/{id}",
      tags: ["Conversations"],
      summary: "Get an agent run",
      request: { params: IdParams },
      responses: { 200: json(AgentRun, "The run."), 404: errors[404] },
    }),
    async (c) => {
      const row = await requireRun(createDb(c.env.DB), c.req.valid("param").id);
      return c.json(toAgentRun(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/agent-runs/{id}/cancel",
      tags: ["Conversations"],
      summary: "Cancel a queued or running agent run",
      description:
        "The run becomes `cancelled` at once (its streaming message too) and its `chat.turn` job " +
        "is cancelled (the worker gets `job.cancel`). Further worker writes are refused. " +
        "Cancelling a cancelled run is a no-op; a completed or failed run gives 409.",
      request: { params: IdParams },
      responses: { 200: json(AgentRun, "Cancelled."), 404: errors[404], 409: errors[409] },
    }),
    async (c) => {
      const run = await runChat(c.env, { kind: "cancelRun", runId: c.req.valid("param").id });
      return c.json(AgentRun.parse(run), 200);
    },
  );

// --- plans --------------------------------------------------------------------------

const tags = ["Plans"];

export const planRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/plans",
      tags,
      summary: "List content plans (newest first)",
      request: { query: PlanListQuery },
      responses: { 200: json(PlanList, "A page of plans."), 400: errors[400] },
    }),
    async (c) => {
      const { limit, cursor, brandId, conversationId, status } = c.req.valid("query");
      const where: SQL[] = [];
      if (brandId) where.push(eq(contentPlans.brandId, brandId));
      if (conversationId) where.push(eq(contentPlans.conversationId, conversationId));
      if (status) where.push(eq(contentPlans.status, status));
      if (cursor) where.push(lt(contentPlans.id, cursor));
      const db = createDb(c.env.DB);
      const rows = await db
        .select()
        .from(contentPlans)
        .where(and(...where))
        .orderBy(desc(contentPlans.id))
        .limit(limit + 1);
      const page = toPage(
        rows,
        limit,
        (r) => r,
        (r) => r.id,
      );
      return c.json(
        { items: await plansWithItems(db, page.items), nextCursor: page.nextCursor },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/plans/{id}",
      tags,
      summary: "Get a plan with its items",
      request: { params: IdParams },
      responses: { 200: json(Plan, "The plan."), 404: errors[404] },
    }),
    async (c) => c.json(await loadPlan(createDb(c.env.DB), c.req.valid("param").id), 200),
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/plans/{id}",
      tags,
      summary: "Edit a draft or proposed plan",
      description:
        "`revision` must equal the plan's current revision (409 otherwise). `items` replaces the " +
        "list: entries with `id` keep and update that item, entries without `id` are new, " +
        "missing items are removed. The revision goes up by one.",
      request: { params: IdParams, body: jsonBody(PlanUpdate) },
      responses: {
        200: json(Plan, "Updated."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const plan = await runChat(c.env, {
        kind: "updatePlan",
        planId: c.req.valid("param").id,
        input: c.req.valid("json"),
      });
      return c.json(Plan.parse(plan), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/plans/{id}/accept",
      tags,
      summary: "Accept a proposed plan (creates draft content items)",
      description:
        "Requires the revision the user reviewed. Every item not in `skipItemIds` gets a draft " +
        "content item (type, title, brief and platforms from the item; no generation yet) and " +
        "becomes `accepted`; skipped items become `skipped`.",
      request: { params: IdParams, body: jsonBody(PlanAccept) },
      responses: {
        200: json(Plan, "Accepted."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const plan = await runChat(c.env, {
        kind: "acceptPlan",
        planId: c.req.valid("param").id,
        input: c.req.valid("json"),
      });
      return c.json(Plan.parse(plan), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/plans/{id}/reject",
      tags,
      summary: "Reject a draft or proposed plan",
      request: { params: IdParams, body: jsonBody(PlanReject) },
      responses: {
        200: json(Plan, "Rejected."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const plan = await runChat(c.env, {
        kind: "rejectPlan",
        planId: c.req.valid("param").id,
        input: c.req.valid("json"),
      });
      return c.json(Plan.parse(plan), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/plans/{id}/generate",
      tags,
      summary: "Request generation for accepted plan items",
      description:
        "Creates one `content.generate` job per item (payload: `ContentGeneratePayload`). Without " +
        "`itemIds`: every accepted item that is not already queued or running. Named items must " +
        "be accepted, still have their content item, and not be generating (409 otherwise).",
      request: { params: IdParams, body: jsonBody(PlanGenerate) },
      responses: {
        200: json(PlanGenerateResult, "Jobs created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const result = await runChat(c.env, {
        kind: "generatePlan",
        planId: c.req.valid("param").id,
        input: c.req.valid("json"),
      });
      return c.json(PlanGenerateResult.parse(result), 200);
    },
  );
