import { createRoute, type z } from "@hono/zod-openapi";
import {
  DEFAULT_JOB_MAX_ATTEMPTS,
  INTERNAL_JOB_TYPES,
  JOB_PAYLOAD_SCHEMAS,
  JOB_TYPE_REQUIREMENTS,
  Job,
  JobCreate,
  JobList,
  JobListQuery,
  JobStreamQuery,
} from "@studio/contract";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { toJob } from "../db/mappers.ts";
import { jobs } from "../db/schema.ts";
import { badRequest, invalidTransition, notFound, zodIssues } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";
import { loadContent } from "./contents.ts";

const tags = ["Jobs"];

/** The single Hub instance that dispatches jobs. */
export const hubStub = (env: Env) => env.HUB.getByName("main");

/**
 * Validate and persist a job as `queued`, then tell the Hub. The row in D1 is
 * the commitment: if the notification fails (Hub unreachable), the Hub's
 * periodic sweep or the next worker `hello` still dispatches it.
 */
export async function createJob(env: Env, input: z.output<typeof JobCreate>): Promise<Job> {
  const db = createDb(env.DB);
  const needs = JOB_TYPE_REQUIREMENTS[input.type];
  if ((INTERNAL_JOB_TYPES as readonly string[]).includes(input.type)) {
    throw badRequest(`${input.type} jobs are created by the API itself`, [
      {
        path: "type",
        message: "send a message with POST /api/conversations/{id}/messages instead",
      },
    ]);
  }

  let brandId = input.brandId;
  if (input.contentId) {
    const { row } = await loadContent(db, input.contentId);
    if (brandId && brandId !== row.brandId) {
      throw badRequest("contentId belongs to a different brand", [
        { path: "brandId", message: `content ${row.id} belongs to brand ${row.brandId}` },
      ]);
    }
    brandId = row.brandId;
  }
  if (brandId && !input.contentId) await requireBrand(db, brandId);
  if (needs.content && !input.contentId) {
    throw badRequest(`${input.type} jobs need a contentId`, [
      { path: "contentId", message: "required for this job type" },
    ]);
  }
  if (needs.brand && !brandId) {
    throw badRequest(`${input.type} jobs need a brandId`, [
      { path: "brandId", message: "required for this job type" },
    ]);
  }

  const payloadSchema = JOB_PAYLOAD_SCHEMAS[input.type];
  if (payloadSchema) {
    const parsed = payloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw badRequest(
        `invalid payload for ${input.type}`,
        zodIssues(parsed.error).map((i) => ({
          ...i,
          path: `payload.${i.path}`.replace(/\.$/, ""),
        })),
      );
    }
  }

  const now = new Date();
  const [row] = await db
    .insert(jobs)
    .values({
      id: newId(),
      type: input.type,
      status: "queued",
      brandId: brandId ?? null,
      contentId: input.contentId ?? null,
      payload: input.payload,
      priority: input.priority ?? 0,
      maxAttempts: input.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("insert returned no row");

  try {
    await hubStub(env).jobCreated(row.id);
  } catch (error) {
    console.warn(
      `api: could not notify the hub about job ${row.id}; the sweep will pick it up`,
      error,
    );
  }
  return toJob(row);
}

/** Upgrade to the Hub's client stream (see JobStreamMessage in the contract). */
async function openStream(env: Env, request: Request, query: z.output<typeof JobStreamQuery>) {
  const target = new URL("https://hub.internal/clients");
  if (query.jobId) target.searchParams.set("jobId", query.jobId);
  if (query.brandId) target.searchParams.set("brandId", query.brandId);
  return hubStub(env).fetch(target.toString(), { headers: request.headers });
}

export const jobRoutes = createRouter();

// Documented by hand: a WebSocket upgrade has no JSON response to validate.
jobRoutes.openAPIRegistry.registerPath({
  method: "get",
  path: "/api/jobs/stream",
  tags,
  summary: "Follow jobs live (WebSocket)",
  description:
    "WebSocket upgrade. Optional `jobId` (one job) or `brandId` (one brand); neither = all jobs. " +
    "The server sends `jobs.snapshot` first, then `job.updated` and `presence` frames " +
    "(schema `JobStreamMessage` in @studio/contract). Clients may send `ping`; reconnect and " +
    "use the new snapshot after a drop.",
  request: { query: JobStreamQuery },
  responses: {
    101: { description: "Switching protocols." },
    400: errors[400],
    404: errors[404],
    426: { description: "Not a WebSocket upgrade request." },
  },
});

// Registered before /api/jobs/{id} so "stream" is not taken for an id.
jobRoutes.get("/api/jobs/stream", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  const parsed = JobStreamQuery.safeParse(c.req.query());
  if (!parsed.success) throw badRequest("invalid request query", zodIssues(parsed.error));
  const query = parsed.data;
  const db = createDb(c.env.DB);
  if (query.jobId) {
    const row = await db.query.jobs.findFirst({ where: eq(jobs.id, query.jobId) });
    if (!row) throw notFound("job", query.jobId);
  }
  if (query.brandId) await requireBrand(db, query.brandId);
  return openStream(c.env, c.req.raw, query);
});

jobRoutes
  .openapi(
    createRoute({
      method: "get",
      path: "/api/jobs",
      tags,
      summary: "List jobs (newest first)",
      request: { query: JobListQuery },
      responses: { 200: json(JobList, "A page of jobs."), 400: errors[400] },
    }),
    async (c) => {
      const { limit, cursor, brandId, contentId, status, type } = c.req.valid("query");
      const where: SQL[] = [];
      if (brandId) where.push(eq(jobs.brandId, brandId));
      if (contentId) where.push(eq(jobs.contentId, contentId));
      if (status) where.push(eq(jobs.status, status));
      if (type) where.push(eq(jobs.type, type));
      if (cursor) where.push(lt(jobs.id, cursor));
      const rows = await createDb(c.env.DB)
        .select()
        .from(jobs)
        .where(and(...where))
        .orderBy(desc(jobs.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toJob, (r) => r.id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/jobs",
      tags,
      summary: "Create a job",
      description:
        "Stores the job as `queued` and notifies the Hub, which dispatches it to the Mac worker " +
        "now or as soon as one connects (priority desc, then FIFO).",
      request: { body: jsonBody(JobCreate) },
      responses: {
        201: json(Job, "Created."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const job = await createJob(c.env, c.req.valid("json"));
      return c.json(job, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/jobs/{id}",
      tags,
      summary: "Get a job",
      request: { params: IdParams },
      responses: { 200: json(Job, "The job."), 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const row = await createDb(c.env.DB).query.jobs.findFirst({ where: eq(jobs.id, id) });
      if (!row) throw notFound("job", id);
      return c.json(toJob(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/jobs/{id}/cancel",
      tags,
      summary: "Cancel a job",
      description:
        "A queued job is cancelled at once. A running job gets `cancelRequestedAt` and stays " +
        "`running` until the worker confirms (or the cancel grace period passes); follow it on " +
        "the stream. 409 `invalid_transition` when the job already finished.",
      request: { params: IdParams },
      responses: {
        200: json(Job, "The job after the cancel request."),
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const result = await hubStub(c.env).cancelJob(id);
      if ("job" in result) return c.json(Job.parse(result.job), 200);
      if (result.reason === "not_found") throw notFound("job", id);
      throw invalidTransition(`job ${id} is already ${result.status}`);
    },
  );
