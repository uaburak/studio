import { createRoute, z } from "@hono/zod-openapi";
import {
  BrandCheckSettings,
  BrandCheckSettingsPut,
  ContentCheckRun,
  ContentCheckRunCreate,
  ContentCheckRunList,
  ContentCheckRunListQuery,
  defaultCheckSettings,
  EntityId,
  sortCheckResults,
  summarizeCheckResults,
} from "@studio/contract";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { toBrandCheckSettings, toContentCheckRun } from "../db/mappers.ts";
import { brandCheckSettings, contentCheckRuns, contentVersions } from "../db/schema.ts";
import { notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";
import { loadContent } from "./contents.ts";

/**
 * Generation checks (roadmap 13): check runs per content version, written by the worker after
 * a generation, an edit render or a `content.check` job, and the brand's check settings
 * (switched-off checks, banned words, strictness, automatic fixes).
 *
 * The server stores what the worker measured; it computes the summary and the number of
 * results that hold approval back (`fail`, plus `warn` when strict). `POST …/approve` refuses
 * a version whose latest run holds approval back under the brand's current settings, or that
 * has no finished run yet, unless the user acknowledged the checks (lib/approval-checks.ts).
 */

const tags = ["Contents"];
const BrandParams = z.object({ brandId: EntityId });

export const contentCheckRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/check-settings",
      tags: ["Brands"],
      summary: "The brand's check settings",
      description: "Defaults (`updatedAt: null`) until they were saved once.",
      request: { params: BrandParams },
      responses: { 200: json(BrandCheckSettings, "The settings."), 404: errors[404] },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      const row = await db.query.brandCheckSettings.findFirst({
        where: eq(brandCheckSettings.brandId, brandId),
      });
      return c.json(row ? toBrandCheckSettings(row) : defaultCheckSettings(brandId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/brands/{brandId}/check-settings",
      tags: ["Brands"],
      summary: "Replace the brand's check settings",
      request: { params: BrandParams, body: jsonBody(BrandCheckSettingsPut) },
      responses: {
        200: json(BrandCheckSettings, "Saved."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      const values = {
        disabledChecks: input.disabledChecks,
        bannedWords: input.bannedWords,
        strictness: input.strictness,
        autoFix: input.autoFix,
        updatedAt: new Date(),
      };
      const [row] = await db
        .insert(brandCheckSettings)
        .values({ brandId, ...values })
        .onConflictDoUpdate({ target: brandCheckSettings.brandId, set: values })
        .returning();
      if (!row) throw new Error("upsert returned no row");
      return c.json(toBrandCheckSettings(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/contents/{id}/checks",
      tags,
      summary: "Check runs of a content item (newest first)",
      description: "`version` narrows the list to one version; `limit=1` gives its latest run.",
      request: { params: IdParams, query: ContentCheckRunListQuery },
      responses: {
        200: json(ContentCheckRunList, "A page of check runs."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { limit, cursor, version } = c.req.valid("query");
      const db = createDb(c.env.DB);
      await loadContent(db, id);
      const where: SQL[] = [eq(contentCheckRuns.contentId, id)];
      if (version !== undefined) where.push(eq(contentCheckRuns.version, version));
      if (cursor) where.push(lt(contentCheckRuns.id, cursor));
      const rows = await db
        .select()
        .from(contentCheckRuns)
        .where(and(...where))
        .orderBy(desc(contentCheckRuns.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toContentCheckRun, (r) => r.id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/contents/{id}/checks",
      tags,
      summary: "Store a check run of a version",
      description:
        "Written by the worker. The server sorts the results (problems first) and computes the summary and the blocking count from the strictness.",
      request: { params: IdParams, body: jsonBody(ContentCheckRunCreate) },
      responses: {
        201: json(ContentCheckRun, "Stored."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const { row: content } = await loadContent(db, id);
      const version = await db.query.contentVersions.findFirst({
        where: and(eq(contentVersions.contentId, id), eq(contentVersions.version, input.version)),
        columns: { id: true },
      });
      if (!version) throw notFound(`content ${id} version`, String(input.version));
      const results = sortCheckResults(input.results);
      const { summary, blocking } = summarizeCheckResults(results, input.strictness);
      const [row] = await db
        .insert(contentCheckRuns)
        .values({
          id: newId(),
          contentId: id,
          brandId: content.brandId,
          version: input.version,
          versionId: version.id,
          trigger: input.trigger,
          jobId: input.jobId ?? null,
          strictness: input.strictness,
          summary,
          blocking,
          results,
          model: input.model ?? null,
          fromVersion: input.fromVersion ?? null,
          fixedVersion: input.fixedVersion ?? null,
          note: input.note,
          createdAt: new Date(),
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return c.json(toContentCheckRun(row), 201);
    },
  );
