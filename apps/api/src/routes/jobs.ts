import { createRoute } from "@hono/zod-openapi";
import {
  JOB_PAYLOAD_SCHEMAS,
  JOB_TYPE_REQUIREMENTS,
  Job,
  JobCreate,
  JobList,
  JobListQuery,
} from "@studio/contract";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { toJob } from "../db/mappers.ts";
import { jobs } from "../db/schema.ts";
import { badRequest, notFound, zodIssues } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";
import { loadContent } from "./contents.ts";

const tags = ["Jobs"];

export const jobRoutes = createRouter()
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
      summary: "Create (persist) a job",
      description:
        "Stores the job as `queued`. Dispatch to the worker is not wired yet (task F1-6); " +
        "the demo path /api/dev/jobs/demo still goes through the Hub directly.",
      request: { body: jsonBody(JobCreate) },
      responses: {
        201: json(Job, "Created."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const needs = JOB_TYPE_REQUIREMENTS[input.type];

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
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return c.json(toJob(row), 201);
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
  );
