import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorBody,
  Asset,
  AssetAnalysisBackfillInput,
  AssetAnalysisBackfillResult,
  AssetAnalysisPendingList,
  AssetAnalysisPendingQuery,
  AssetAnalysisPut,
  AssetSimilarList,
  AssetSimilarQuery,
} from "@studio/contract";
import { createDb } from "../db/client.ts";
import { assetAnalyses } from "../db/schema.ts";
import {
  assetWithAnalysis,
  countPending,
  isAnalyzable,
  pendingAssets,
  queueMediaAnalysis,
  similarAssets,
  withAnalyses,
} from "../lib/asset-analysis.ts";
import { ApiProblem } from "../lib/errors.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireWorkerToken } from "../middleware/worker-auth.ts";
import { requireAsset } from "./assets.ts";
import { requireBrand } from "./brands.ts";

/*
 * Media tagging and search (N12): "Benzerleri", the backfill, and the worker's side (which
 * pictures to read, storing what Vision read). The search itself is `GET /api/assets?q=`.
 */

const tags = ["Assets"];
const security = [{ workerToken: [] }];

const router = createRouter();
router.use("/api/worker/assets/*", requireWorkerToken);

export const assetAnalysisRoutes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/api/assets/{id}/similar",
      tags,
      summary: "Pictures of the same brand that look like this one (Benzerleri)",
      description:
        "Nearest first by Vision feature-print distance (0 = same picture). Empty with a " +
        "Turkish `note` while the picture has no feature print yet. Trashed files are left out.",
      request: { params: IdParams, query: AssetSimilarQuery },
      responses: { 200: json(AssetSimilarList, "Similar pictures."), 404: errors[404] },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      const row = await requireAsset(db, c.req.valid("param").id);
      const { limit } = c.req.valid("query");
      const { items, note } = await similarAssets(db, row, limit);
      return c.json({ assetId: row.id, items, note }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/assets/analysis/backfill",
      tags,
      summary: "Queue tagging of every picture not read yet",
      description:
        "Counts the pictures waiting (no analysis, an older version, or `partial` when " +
        "`includePartial`) and queues one `media.analyze` job unless one is already waiting. " +
        "The worker calls it once it starts with the Vision helper.",
      request: { body: jsonBody(AssetAnalysisBackfillInput) },
      responses: {
        200: json(AssetAnalysisBackfillResult, "What waits and whether a job was queued."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      if (input.brandId) await requireBrand(db, input.brandId);
      const pending = await countPending(db, input);
      if (pending === 0) return c.json({ pending, queued: false, jobId: null }, 200);
      const jobId = await queueMediaAnalysis(c.env, {
        brandId: input.brandId,
        reason: "backfill",
        includePartial: input.includePartial,
      });
      return c.json({ pending, queued: jobId !== null, jobId }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/assets/analysis/pending",
      tags,
      security,
      summary: "Pictures the worker should read (worker only)",
      description:
        "Uploads, ingested files and AI pictures that have no analysis (or an older version, " +
        "or a `partial` one with `includePartial=true`), newest first.",
      request: { query: AssetAnalysisPendingQuery },
      responses: { 200: json(AssetAnalysisPendingList, "Waiting pictures."), 400: errors[400] },
    }),
    async (c) => {
      const { brandId, limit, includePartial } = c.req.valid("query");
      const db = createDb(c.env.DB);
      const rows = await pendingAssets(db, {
        brandId,
        includePartial: includePartial === "true",
        limit,
      });
      return c.json({ items: await withAnalyses(db, rows) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/worker/assets/{id}/analysis",
      tags,
      security,
      summary: "Store what Vision read in a picture (worker only)",
      description:
        "Replaces the picture's analysis (tags, text, colours, shape, flags, feature print, " +
        "caption). 415 for files that are not pictures.",
      request: { params: IdParams, body: jsonBody(AssetAnalysisPut) },
      responses: {
        200: json(Asset, "The asset with its analysis."),
        400: errors[400],
        404: errors[404],
        415: json(ApiErrorBody, "Not a picture (`unsupported_media_type`)."),
      },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      const row = await requireAsset(db, c.req.valid("param").id);
      if (!isAnalyzable(row)) {
        throw new ApiProblem(
          "unsupported_media_type",
          `asset ${row.id} is not a picture Vision can read (${row.mimeType})`,
        );
      }
      const input = c.req.valid("json");
      const values = {
        status: input.status,
        version: input.version,
        tags: input.tags,
        text: input.text,
        colors: input.colors,
        orientation: input.orientation,
        aspectRatio: input.aspectRatio,
        isCutout: input.isCutout,
        isLogoLike: input.isLogoLike,
        caption: input.caption,
        featurePrint: input.featurePrint?.data ?? null,
        featureRevision: input.featurePrint?.revision ?? null,
        note: input.note,
        helperVersion: input.helperVersion,
        analyzedAt: new Date(),
      };
      await db
        .insert(assetAnalyses)
        .values({ assetId: row.id, ...values })
        .onConflictDoUpdate({ target: assetAnalyses.assetId, set: values });
      return c.json(await assetWithAnalysis(db, row), 200);
    },
  );
