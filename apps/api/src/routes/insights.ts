/**
 * Statistics (N15): a post's numbers and history, the brand's performance page, best times,
 * the short summary for planning, and "read now".
 */
import { createRoute } from "@hono/zod-openapi";
import {
  BestTimes,
  BestTimesQuery,
  BrandPerformance,
  ContentPerformance,
  InsightsSyncInput,
  Job,
  PerformanceQuery,
  PerformanceSummary,
} from "@studio/contract";
import { createDb } from "../db/client.ts";
import {
  bestTimesFor,
  brandPerformance,
  contentPerformance,
  performanceSummary,
} from "../lib/insights.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";
import { loadContent } from "./contents.ts";
import { createJob } from "./jobs.ts";

const tags = ["Insights"];

/** Empty summary when the brand has no statistics yet (the route always answers). */
function emptySummary(days: number, now: Date): PerformanceSummary {
  const day = (ms: number) => new Date(ms + 3 * 3_600_000).toISOString().slice(0, 10);
  return {
    from: day(now.getTime() - days * 86_400_000),
    to: day(now.getTime()),
    posts: 0,
    avgReach: null,
    avgEngagementRate: null,
    pillars: [],
    formats: [],
    top: [],
    weak: [],
    bestSlots: [],
  };
}

export const insightRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/contents/{id}/performance",
      tags,
      summary: "A post's statistics on every account it went to, with their history",
      request: { params: IdParams },
      responses: { 200: json(ContentPerformance, "Statistics."), 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      await loadContent(db, id);
      return c.json(await contentPerformance(db, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{id}/performance",
      tags,
      summary: "The brand's performance page: top posts, pillars, formats, weekday / hour, trend",
      request: { params: IdParams, query: PerformanceQuery },
      responses: {
        200: json(BrandPerformance, "Performance."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireBrand(db, id);
      return c.json(await brandPerformance(db, id, q, new Date()), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{id}/best-times",
      tags,
      summary: "Hour × weekday engagement grid and suggested publish slots (Türkiye time)",
      description:
        "From the brand's published posts with statistics (relative engagement). With fewer " +
        "than 8 such posts the suggestions are general good times (`basis: general`).",
      request: { params: IdParams, query: BestTimesQuery },
      responses: { 200: json(BestTimes, "Best times."), 400: errors[400], 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireBrand(db, id);
      return c.json(await bestTimesFor(db, id, q, new Date()), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{id}/performance-summary",
      tags,
      summary: "What worked lately, in short (the plan agent and the brand analysis read it)",
      request: { params: IdParams, query: PerformanceQuery },
      responses: { 200: json(PerformanceSummary, "Summary."), 400: errors[400], 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireBrand(db, id);
      const now = new Date();
      return c.json(
        (await performanceSummary(db, id, q.days, now)) ?? emptySummary(q.days, now),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/insights/sync",
      tags,
      summary: "Read statistics now (a brand, a post, or everything due)",
      request: { body: jsonBody(InsightsSyncInput) },
      responses: { 202: json(Job, "Queued `insights.sync`."), 400: errors[400], 404: errors[404] },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      let brandId = input.brandId;
      if (input.contentId) brandId = (await loadContent(db, input.contentId)).row.brandId;
      else if (brandId) await requireBrand(db, brandId);
      const job = await createJob(c.env, {
        type: "insights.sync",
        payload: {
          ...(brandId ? { brandId } : {}),
          ...(input.contentId ? { contentId: input.contentId } : {}),
          force: true,
        },
        ...(brandId ? { brandId } : {}),
      });
      return c.json(job, 202);
    },
  );
