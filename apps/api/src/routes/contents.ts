import { createRoute, z } from "@hono/zod-openapi";
import {
  APPROVABLE_STATUSES,
  Content,
  ContentApprove,
  ContentCreate,
  ContentList,
  ContentListQuery,
  type ContentStatus,
  ContentTransition,
  ContentUpdate,
  ContentVersion,
  ContentVersionCreate,
  ContentVersionList,
  ContentVersionListQuery,
  ContentVersionNumber,
  ContentVersionUpdate,
  canTransitionContent,
  computeContentHash,
  EntityId,
  isManualContentTransition,
  SLIDE_LIMITS,
  statusIn,
  UNDELETABLE_STATUSES,
  VERSIONABLE_STATUSES,
} from "@studio/contract";
import { and, asc, desc, eq, inArray, lt, max, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { createDb, type Db } from "../db/client.ts";
import {
  type ContentRow,
  type CurrentVersionRef,
  toContent,
  toVersion,
  toVersionSummary,
} from "../db/mappers.ts";
import {
  assets,
  contents,
  contentVersionSlides,
  contentVersions,
  jobs,
  schedules,
} from "../db/schema.ts";
import { ApiProblem, badRequest, conflict, invalidTransition, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";

const tags = ["Contents"];

const VersionParams = z.object({ id: EntityId, version: ContentVersionNumber });

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

const currentVersionColumns = {
  id: contentVersions.id,
  version: contentVersions.version,
  contentHash: contentVersions.contentHash,
};

export interface LoadedContent {
  row: ContentRow;
  current: CurrentVersionRef | null;
}

export async function loadContent(db: Db, id: string): Promise<LoadedContent> {
  const [found] = await db
    .select({ row: contents, current: currentVersionColumns })
    .from(contents)
    .leftJoin(contentVersions, eq(contents.currentVersionId, contentVersions.id))
    .where(eq(contents.id, id));
  if (!found) throw notFound("content", id);
  return found;
}

/** True when the stored approval still covers the current version. */
export function approvalMatchesCurrent({ row, current }: LoadedContent): boolean {
  return (
    current !== null &&
    row.approvedVersionId === current.id &&
    row.approvedHash === current.contentHash
  );
}

const clearedApproval = { approvedVersionId: null, approvedHash: null, approvedAt: null } as const;

function assertTransition(from: ContentStatus, to: ContentStatus, why: string) {
  if (from !== to && !canTransitionContent(from, to)) {
    throw invalidTransition(`cannot move content from ${from} to ${to} (${why})`);
  }
}

/** Statement cancelling the content's pending schedules (used when approval is lost). */
function cancelPendingSchedules(db: Db, contentId: string, now: Date) {
  return db
    .update(schedules)
    .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
    .where(and(eq(schedules.contentId, contentId), eq(schedules.status, "pending")));
}

async function respondContent(db: Db, id: string) {
  const loaded = await loadContent(db, id);
  return toContent(loaded.row, loaded.current);
}

async function requireVersion(db: Db, contentId: string, version: number) {
  const row = await db.query.contentVersions.findFirst({
    where: and(eq(contentVersions.contentId, contentId), eq(contentVersions.version, version)),
  });
  if (!row) throw notFound(`content ${contentId} version`, version);
  return row;
}

async function versionWithSlides(db: Db, versionRow: typeof contentVersions.$inferSelect) {
  const slides = await db
    .select()
    .from(contentVersionSlides)
    .where(eq(contentVersionSlides.versionId, versionRow.id))
    .orderBy(asc(contentVersionSlides.position));
  return toVersion(versionRow, slides);
}

/** Rendered asset refs: empty, or one per slide; each must belong to the brand. */
async function checkRenderedAssets(
  db: Db,
  brandId: string,
  ids: ReadonlyArray<string | null> | undefined,
  slideCount: number,
): Promise<Array<string | null>> {
  if (!ids || ids.length === 0) return Array.from({ length: slideCount }, () => null);
  if (ids.length !== slideCount) {
    throw badRequest("renderedAssetIds must be empty or have one entry per slide", [
      { path: "renderedAssetIds", message: `expected ${slideCount} entries, got ${ids.length}` },
    ]);
  }
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length > 0) {
    const found = await db
      .select({ id: assets.id, brandId: assets.brandId })
      .from(assets)
      .where(inArray(assets.id, wanted));
    for (const id of wanted) {
      const asset = found.find((a) => a.id === id);
      if (!asset) throw notFound("asset", id);
      if (asset.brandId !== brandId) {
        throw badRequest(`asset ${id} belongs to another brand`, [
          { path: "renderedAssetIds", message: "asset must belong to the content's brand" },
        ]);
      }
    }
  }
  return [...ids];
}

function sameSet(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((v) => b.includes(v));
}

export const contentRoutes = createRouter()
  // --- contents -----------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/api/contents",
      tags,
      summary: "List content items (newest first)",
      request: { query: ContentListQuery },
      responses: { 200: json(ContentList, "A page of content items."), 400: errors[400] },
    }),
    async (c) => {
      const { limit, cursor, brandId, status, type } = c.req.valid("query");
      const where: SQL[] = [];
      if (brandId) where.push(eq(contents.brandId, brandId));
      if (status) where.push(eq(contents.status, status));
      if (type) where.push(eq(contents.type, type));
      if (cursor) where.push(lt(contents.id, cursor));
      const rows = await createDb(c.env.DB)
        .select({ row: contents, current: currentVersionColumns })
        .from(contents)
        .leftJoin(contentVersions, eq(contents.currentVersionId, contentVersions.id))
        .where(and(...where))
        .orderBy(desc(contents.id))
        .limit(limit + 1);
      return c.json(
        toPage(
          rows,
          limit,
          (r) => toContent(r.row, r.current),
          (r) => r.row.id,
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/contents",
      tags,
      summary: "Create a content item (draft, no version yet)",
      request: { body: jsonBody(ContentCreate) },
      responses: {
        201: json(Content, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const brand = await requireBrand(db, input.brandId);
      if (brand.status !== "active") throw conflict(`brand ${brand.id} is archived`);
      const now = new Date();
      const id = newId();
      await db.insert(contents).values({
        id,
        brandId: input.brandId,
        type: input.type,
        title: input.title,
        brief: input.brief,
        status: "draft",
        targetPlatforms: input.targetPlatforms,
        caption: input.caption,
        createdAt: now,
        updatedAt: now,
      });
      return c.json(await respondContent(db, id), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/contents/{id}",
      tags,
      summary: "Get a content item",
      request: { params: IdParams },
      responses: { 200: json(Content, "The content item."), 404: errors[404] },
    }),
    async (c) => {
      return c.json(await respondContent(createDb(c.env.DB), c.req.valid("param").id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/contents/{id}",
      tags,
      summary: "Update a content item",
      description:
        "`title`/`brief` change freely. Changing `caption` or `targetPlatforms` on approved, " +
        "scheduled or failed content revokes the approval (back to draft, pending schedules " +
        "cancelled); it is refused (409) while publishing or published.",
      request: { params: IdParams, body: jsonBody(ContentUpdate) },
      responses: {
        200: json(Content, "Updated."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const { row } = await loadContent(db, id);

      const publishedFieldsChange =
        (input.caption !== undefined && input.caption !== row.caption) ||
        (input.targetPlatforms !== undefined &&
          !sameSet(input.targetPlatforms, row.targetPlatforms));

      const now = new Date();
      let set: Partial<typeof contents.$inferInsert> = { ...input, updatedAt: now };
      const stmts: BatchItem<"sqlite">[] = [];

      if (publishedFieldsChange && row.approvedVersionId !== null) {
        assertTransition(row.status, "draft", "caption or platforms changed after approval");
        set = { ...set, ...clearedApproval, status: "draft" };
        if (row.status === "scheduled") stmts.push(cancelPendingSchedules(db, id, now));
      } else if (publishedFieldsChange && statusIn(row.status, ["publishing", "published"])) {
        throw invalidTransition(`content is ${row.status}; caption and platforms are frozen`);
      }

      stmts.push(
        db
          .update(contents)
          .set(set)
          .where(and(eq(contents.id, id), eq(contents.status, row.status))),
      );
      await db.batch(stmts as Batch);
      return c.json(await respondContent(db, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/api/contents/{id}",
      tags,
      summary: "Delete a content item with its versions",
      description: "Refused (409) while scheduled, publishing or published.",
      request: { params: IdParams },
      responses: { 204: { description: "Deleted." }, 404: errors[404], 409: errors[409] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const { row } = await loadContent(db, id);
      if (statusIn(row.status, UNDELETABLE_STATUSES)) {
        throw invalidTransition(`content is ${row.status} and cannot be deleted`);
      }
      await db.delete(contents).where(eq(contents.id, id));
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/contents/{id}/approve",
      tags,
      summary: "Approve the current version by its hash",
      description:
        "The body carries the hash of the version the user looked at. It must equal the " +
        "current version's hash, otherwise 409 `hash_mismatch` (someone added a newer " +
        "version). Allowed from draft or in_review; repeating it on approved content with " +
        "the same hash is a no-op.",
      request: { params: IdParams, body: jsonBody(ContentApprove) },
      responses: {
        200: json(Content, "Approved."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { hash } = c.req.valid("json");
      const db = createDb(c.env.DB);
      const loaded = await loadContent(db, id);
      const { row, current } = loaded;

      if (!current) throw conflict("content has no version to approve");
      if (
        row.status === "approved" &&
        approvalMatchesCurrent(loaded) &&
        row.approvedHash === hash
      ) {
        return c.json(toContent(row, current), 200);
      }
      if (!statusIn(row.status, APPROVABLE_STATUSES)) {
        throw invalidTransition(
          `content is ${row.status}; only draft or in_review can be approved`,
        );
      }
      if (hash !== current.contentHash) {
        throw new ApiProblem(
          "hash_mismatch",
          `hash does not match the current version (v${current.version}); reload and review again`,
        );
      }
      const now = new Date();
      const updated = await db
        .update(contents)
        .set({
          status: "approved",
          approvedVersionId: current.id,
          approvedHash: current.contentHash,
          approvedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(contents.id, id),
            eq(contents.status, row.status),
            eq(contents.currentVersionId, current.id),
          ),
        )
        .returning({ id: contents.id });
      if (updated.length === 0) throw conflict("content changed while approving; reload and retry");
      return c.json(await respondContent(db, id), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/contents/{id}/transition",
      tags,
      summary: "Request a manual status change",
      description:
        "Allowed: draft -> in_review, in_review -> draft, approved -> draft (revoke), " +
        "failed -> draft, failed -> approved (only if the approval still matches). " +
        "Approval itself uses /approve; scheduling uses /api/schedules.",
      request: { params: IdParams, body: jsonBody(ContentTransition) },
      responses: {
        200: json(Content, "Transitioned."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { to } = c.req.valid("json");
      const db = createDb(c.env.DB);
      const loaded = await loadContent(db, id);
      const { row, current } = loaded;

      if (!isManualContentTransition(row.status, to)) {
        throw invalidTransition(`cannot move content from ${row.status} to ${to} manually`);
      }
      if (to === "in_review" && !current) throw conflict("content has no version to review");
      if (to === "approved" && !approvalMatchesCurrent(loaded)) {
        throw new ApiProblem(
          "hash_mismatch",
          "the stored approval does not match the current version",
        );
      }

      const now = new Date();
      const set: Partial<typeof contents.$inferInsert> = { status: to, updatedAt: now };
      const updated = await db
        .update(contents)
        .set(to === "draft" ? { ...set, ...clearedApproval } : set)
        .where(and(eq(contents.id, id), eq(contents.status, row.status)))
        .returning({ id: contents.id });
      if (updated.length === 0) throw conflict("content changed concurrently; reload and retry");
      return c.json(await respondContent(db, id), 200);
    },
  )
  // --- versions -------------------------------------------------------------------
  .openapi(
    createRoute({
      method: "get",
      path: "/api/contents/{id}/versions",
      tags,
      summary: "List versions (newest first, without slide HTML)",
      request: { params: IdParams, query: ContentVersionListQuery },
      responses: {
        200: json(ContentVersionList, "A page of version summaries."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { limit, cursor } = c.req.valid("query");
      const db = createDb(c.env.DB);
      await loadContent(db, id);
      const where: SQL[] = [eq(contentVersions.contentId, id)];
      if (cursor) where.push(lt(contentVersions.id, cursor));
      const rows = await db
        .select()
        .from(contentVersions)
        .where(and(...where))
        .orderBy(desc(contentVersions.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toVersionSummary, (r) => r.id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/contents/{id}/versions",
      tags,
      summary: "Add a version (becomes current; content returns to draft)",
      description:
        "The server computes the content hash. Any approval is cleared and pending " +
        "schedules are cancelled, because approval is bound to a specific hash. " +
        "Refused (409) while publishing or published.",
      request: { params: IdParams, body: jsonBody(ContentVersionCreate) },
      responses: {
        201: json(ContentVersion, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const { row } = await loadContent(db, id);

      if (!statusIn(row.status, VERSIONABLE_STATUSES)) {
        throw invalidTransition(`content is ${row.status}; no new versions can be added`);
      }
      assertTransition(row.status, "draft", "new version");

      const limits = SLIDE_LIMITS[row.type];
      if (input.slides.length < limits.min || input.slides.length > limits.max) {
        throw badRequest(`a ${row.type} needs ${limits.min}-${limits.max} slides`, [
          { path: "slides", message: `got ${input.slides.length}` },
        ]);
      }
      const renders = await checkRenderedAssets(
        db,
        row.brandId,
        input.renderedAssetIds,
        input.slides.length,
      );
      if (input.jobId) {
        const job = await db.query.jobs.findFirst({ where: eq(jobs.id, input.jobId) });
        if (!job) throw notFound("job", input.jobId);
      }

      const contentHash = await computeContentHash(input.slides);
      const [last] = await db
        .select({ version: max(contentVersions.version) })
        .from(contentVersions)
        .where(eq(contentVersions.contentId, id));
      const versionId = newId();
      const now = new Date();

      const stmts: BatchItem<"sqlite">[] = [
        db.insert(contentVersions).values({
          id: versionId,
          contentId: id,
          version: (last?.version ?? 0) + 1,
          origin: input.origin,
          contentHash,
          slideCount: input.slides.length,
          note: input.note ?? null,
          jobId: input.jobId ?? null,
          createdAt: now,
          updatedAt: now,
        }),
        // One statement per slide: D1 caps bound parameters per query at 100.
        ...input.slides.map((slide, position) =>
          db.insert(contentVersionSlides).values({
            versionId,
            position,
            html: slide.html,
            width: slide.width,
            height: slide.height,
            renderedAssetId: renders[position] ?? null,
          }),
        ),
      ];
      if (row.status === "scheduled") stmts.push(cancelPendingSchedules(db, id, now));
      stmts.push(
        db
          .update(contents)
          .set({ currentVersionId: versionId, status: "draft", ...clearedApproval, updatedAt: now })
          .where(eq(contents.id, id)),
      );
      await db.batch(stmts as Batch);

      const created = await db.query.contentVersions.findFirst({
        where: eq(contentVersions.id, versionId),
      });
      if (!created) throw new Error("version vanished after insert");
      return c.json(await versionWithSlides(db, created), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/contents/{id}/versions/{version}",
      tags,
      summary: "Get one version with its slides",
      request: { params: VersionParams },
      responses: { 200: json(ContentVersion, "The version."), 404: errors[404] },
    }),
    async (c) => {
      const { id, version } = c.req.valid("param");
      const db = createDb(c.env.DB);
      return c.json(await versionWithSlides(db, await requireVersion(db, id, version)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/contents/{id}/versions/{version}",
      tags,
      summary: "Update version metadata (note, rendered assets)",
      description: "Slides are immutable; neither field changes the content hash.",
      request: { params: VersionParams, body: jsonBody(ContentVersionUpdate) },
      responses: {
        200: json(ContentVersion, "Updated."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id, version } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const { row } = await loadContent(db, id);
      const versionRow = await requireVersion(db, id, version);
      const now = new Date();

      const stmts: BatchItem<"sqlite">[] = [
        db
          .update(contentVersions)
          .set({ ...(input.note !== undefined ? { note: input.note } : {}), updatedAt: now })
          .where(eq(contentVersions.id, versionRow.id)),
      ];
      if (input.renderedAssetIds !== undefined) {
        const renders = await checkRenderedAssets(
          db,
          row.brandId,
          input.renderedAssetIds,
          versionRow.slideCount,
        );
        renders.forEach((assetId, position) => {
          stmts.push(
            db
              .update(contentVersionSlides)
              .set({ renderedAssetId: assetId })
              .where(
                and(
                  eq(contentVersionSlides.versionId, versionRow.id),
                  eq(contentVersionSlides.position, position),
                ),
              ),
          );
        });
      }
      await db.batch(stmts as Batch);
      return c.json(await versionWithSlides(db, await requireVersion(db, id, version)), 200);
    },
  );
