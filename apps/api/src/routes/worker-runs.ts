import { createRoute, z } from "@hono/zod-openapi";
import {
  AgentRun,
  ApiErrorBody,
  EntityId,
  PlanProposalPut,
  PlanProposalResult,
  RunComplete,
  RunFail,
  RunStart,
  TurnContext,
  TurnMessageResult,
  TurnOps,
  TurnWriteResult,
} from "@studio/contract";
import { runChat } from "../chat/command.ts";
import { turnContext, turnMessage, withBrandNotes } from "../chat/read.ts";
import { createDb } from "../db/client.ts";
import { createRouter, errors, json, jsonBody } from "../lib/router.ts";
import { requireWorkerToken } from "../middleware/worker-auth.ts";

/*
 * The agent's side of a `chat.turn` job (the Mac worker, task A4):
 *
 *   start (attempt) -> context
 *   ops   (text.delta / part.set, batched)     -- any number of times
 *   plan  (create / replace the run's plan)    -- optional
 *   complete | fail
 *
 * Every write is refused once the run is cancelled or finished (409
 * `invalid_transition`), before `start` (409 `conflict`) and from a stale
 * attempt (409 `conflict`). Retrying any call is safe: deltas carry a
 * per-part seq, part.set / plan with the same content are no-ops, and
 * complete / fail on an already completed / failed run return it unchanged.
 */

const tags = ["Worker turn"];
const RunParams = z.object({ runId: EntityId });
const security = [{ workerToken: [] }];
const unauthorized = { description: "Missing or wrong worker token (plain text)." };

export const workerRunRoutes = createRouter();

workerRunRoutes.openAPIRegistry.registerComponent("securitySchemes", "workerToken", {
  type: "http",
  scheme: "bearer",
  description: "The WORKER_TOKEN shared secret (same as /api/hub).",
});

workerRunRoutes.use("/api/worker/*", requireWorkerToken);

workerRunRoutes
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/runs/{runId}/start",
      tags,
      security,
      summary: "Start (or restart) a run and get the turn context",
      description:
        "`attempt` is the attempt number from `job.dispatch`. Queued -> running. Repeating it with " +
        "the same attempt only returns the context. A higher attempt (the job was retried) clears " +
        "the assistant message written by the previous attempt.",
      request: { params: RunParams, body: jsonBody(RunStart) },
      responses: {
        200: json(TurnContext, "The context for this turn."),
        400: errors[400],
        401: unauthorized,
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const context = await runChat(c.env, {
        kind: "startRun",
        runId: c.req.valid("param").runId,
        attempt: c.req.valid("json").attempt,
      });
      return c.json(TurnContext.parse(await withBrandNotes(c.env.MEDIA, context)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/runs/{runId}/context",
      tags,
      security,
      summary: "Read the turn context again (no state change)",
      description: "Use it to pick up a question's answer while the run waits for it.",
      request: { params: RunParams },
      responses: {
        200: json(TurnContext, "The context."),
        401: unauthorized,
        404: errors[404],
      },
    }),
    async (c) => {
      const context = await turnContext(createDb(c.env.DB), c.req.valid("param").runId);
      return c.json(await withBrandNotes(c.env.MEDIA, context), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/runs/{runId}/message",
      tags,
      security,
      summary: "Read the run and its assistant message (no state change)",
      description:
        "Cheaper than `context`: what the worker polls while a question or a consent card waits " +
        "for the owner. `message` is null before the first write.",
      request: { params: RunParams },
      responses: {
        200: json(TurnMessageResult, "The run and its message."),
        401: unauthorized,
        404: errors[404],
      },
    }),
    async (c) => {
      const result = await turnMessage(createDb(c.env.DB), c.req.valid("param").runId);
      return c.json(TurnMessageResult.parse(result), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/runs/{runId}/ops",
      tags,
      security,
      summary: "Write to the run's assistant message (text deltas, parts)",
      description:
        "Ops apply in order, all or nothing. The assistant message is created by the first write. " +
        "`text.delta` appends to a text part (seq per part from 1; an applied seq is skipped, a gap " +
        "is 409). `part.set` appends at the next index or replaces a part of the same type. " +
        "Deltas are at most 16 KiB, a text part 100 KB, a message 512 KB (413 beyond).",
      request: { params: RunParams, body: jsonBody(TurnOps) },
      responses: {
        200: json(TurnWriteResult, "The run and the message after the ops."),
        400: errors[400],
        401: unauthorized,
        404: errors[404],
        409: errors[409],
        413: json(ApiErrorBody, "Too large (`payload_too_large`)."),
      },
    }),
    async (c) => {
      const result = await runChat(c.env, {
        kind: "applyOps",
        runId: c.req.valid("param").runId,
        input: c.req.valid("json"),
      });
      return c.json(TurnWriteResult.parse(result), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/worker/runs/{runId}/plan",
      tags,
      security,
      summary: "Create or replace the run's plan proposal",
      description:
        "First call: a new plan (other open plans of the conversation become `superseded`) and a " +
        "`plan_proposal` part on the assistant message. Later calls replace the same plan while it " +
        "is draft/proposed (revision + 1); an identical body changes nothing. Sets the " +
        "conversation's brand from `brandId` when it has none.",
      request: { params: RunParams, body: jsonBody(PlanProposalPut) },
      responses: {
        200: json(PlanProposalResult, "The plan and the assistant message."),
        400: errors[400],
        401: unauthorized,
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const result = await runChat(c.env, {
        kind: "putPlan",
        runId: c.req.valid("param").runId,
        input: c.req.valid("json"),
      });
      return c.json(PlanProposalResult.parse(result), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/runs/{runId}/complete",
      tags,
      security,
      summary: "Finish the run successfully (with model / usage)",
      request: { params: RunParams, body: jsonBody(RunComplete) },
      responses: {
        200: json(AgentRun, "Completed."),
        400: errors[400],
        401: unauthorized,
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const run = await runChat(c.env, {
        kind: "completeRun",
        runId: c.req.valid("param").runId,
        input: c.req.valid("json"),
      });
      return c.json(AgentRun.parse(run), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/runs/{runId}/fail",
      tags,
      security,
      summary: "Finish the run with an error",
      description: "The error is also appended to the assistant message as an `error` part.",
      request: { params: RunParams, body: jsonBody(RunFail) },
      responses: {
        200: json(AgentRun, "Failed."),
        400: errors[400],
        401: unauthorized,
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const run = await runChat(c.env, {
        kind: "failRun",
        runId: c.req.valid("param").runId,
        input: c.req.valid("json"),
      });
      return c.json(AgentRun.parse(run), 200);
    },
  );
