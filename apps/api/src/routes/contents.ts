import { createRoute, z } from "@hono/zod-openapi";
import {
  APPROVABLE_STATUSES,
  Content,
  ContentApprove,
  ContentCreate,
  ContentDeleteQuery,
  ContentDuplicate,
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
  type ContentVersionOrigin,
  ContentVersionRestore,
  ContentVersionUpdate,
  canTransitionContent,
  computeContentHash,
  type EditorDocument,
  EntityId,
  isManualContentTransition,
  SLIDE_LIMITS,
  type SlideLayout,
  statusIn,
  UNDELETABLE_STATUSES,
  VERSIONABLE_STATUSES,
  WECRA_DOCUMENT_MIME,
} from "@studio/contract";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, max, or, type SQL } from "drizzle-orm";
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
  contentVersionDocuments,
  contentVersionSlides,
  contentVersions,
  jobs,
  schedules,
} from "../db/schema.ts";
import { assertChecksAllowApproval } from "../lib/approval-checks.ts";
import { pendingCounts } from "../lib/approvals.ts";
import { ApiProblem, badRequest, conflict, invalidTransition, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { toPage } from "../lib/pagination.ts";
import { requestSyncStatement } from "../lib/publishing.ts";
import { purgeContent } from "../lib/purge.ts";
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

/** User-facing refusal for changes to a post in the trash. */
export const TRASHED_CONTENT_MESSAGE = "Post silinmiş; önce geri al.";

/** A post in the trash takes no changes (approve, edit, schedule, new work) until restored. */
export function assertNotTrashed(row: Pick<ContentRow, "deletedAt">): void {
  if (row.deletedAt) throw conflict(TRASHED_CONTENT_MESSAGE);
}

/** Job types stopped when their post goes to the trash. */
const STOPPED_ON_DELETE = [
  "content.generate",
  "content.render",
  "content.check",
  "canvas.read",
  "canvas.apply",
];

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

/**
 * Statements cancelling the content's pending schedules (used when approval is lost), and
 * asking the worker for an immediate sync so orders at the cloud publisher are cancelled
 * there now.
 */
function cancelPendingSchedules(db: Db, contentId: string, now: Date): BatchItem<"sqlite">[] {
  return [
    db
      .update(schedules)
      .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
      .where(and(eq(schedules.contentId, contentId), eq(schedules.status, "pending"))),
    requestSyncStatement(db, now),
  ];
}

async function respondContent(db: Db, id: string) {
  const loaded = await loadContent(db, id);
  const pending = await pendingCounts(db, [id]);
  return toContent(loaded.row, loaded.current, pending.get(id) ?? 0);
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
  const document = await db.query.contentVersionDocuments.findFirst({
    where: eq(contentVersionDocuments.versionId, versionRow.id),
  });
  return toVersion(versionRow, slides, document ?? null);
}

/** An editor document must be a Wecra bundle of the content's brand. */
async function checkEditorDocument(
  db: Db,
  brandId: string,
  doc: EditorDocument | undefined,
): Promise<EditorDocument | null> {
  if (!doc) return null;
  const asset = await db.query.assets.findFirst({ where: eq(assets.id, doc.assetId) });
  if (!asset) throw notFound("asset", doc.assetId);
  if (asset.brandId !== brandId) {
    throw badRequest(`asset ${doc.assetId} belongs to another brand`, [
      { path: "editorDocument.assetId", message: "asset must belong to the content's brand" },
    ]);
  }
  if (asset.mimeType !== WECRA_DOCUMENT_MIME) {
    throw badRequest(`asset ${doc.assetId} is not a ${doc.kind} document`, [
      { path: "editorDocument.assetId", message: `expected ${WECRA_DOCUMENT_MIME}` },
    ]);
  }
  return { kind: doc.kind, assetId: doc.assetId, format: doc.format };
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

/** Layer layouts: empty, or one per slide (`null` = not measured). */
function checkLayouts(
  layouts: ReadonlyArray<SlideLayout | null> | undefined,
  slideCount: number,
): Array<SlideLayout | null> {
  if (!layouts || layouts.length === 0) return Array.from({ length: slideCount }, () => null);
  if (layouts.length !== slideCount) {
    throw badRequest("layouts must be empty or have one entry per slide", [
      { path: "layouts", message: `expected ${slideCount} entries, got ${layouts.length}` },
    ]);
  }
  return [...layouts];
}

/** Next version number and the statements that insert a version with its slides. */
async function insertVersionStatements(
  db: Db,
  input: {
    contentId: string;
    origin: ContentVersionOrigin;
    slides: ReadonlyArray<{ html: string; width: number; height: number }>;
    note: string | null;
    jobId: string | null;
    renders: ReadonlyArray<string | null>;
    layouts: ReadonlyArray<SlideLayout | null>;
    /** The editor's document the slides come from (copied as it is). */
    editorDocument?: EditorDocument | null;
    now: Date;
  },
) {
  const contentHash = await computeContentHash(input.slides);
  const [last] = await db
    .select({ version: max(contentVersions.version) })
    .from(contentVersions)
    .where(eq(contentVersions.contentId, input.contentId));
  const versionId = newId();
  const stmts: BatchItem<"sqlite">[] = [
    db.insert(contentVersions).values({
      id: versionId,
      contentId: input.contentId,
      version: (last?.version ?? 0) + 1,
      origin: input.origin,
      contentHash,
      slideCount: input.slides.length,
      note: input.note,
      jobId: input.jobId,
      createdAt: input.now,
      updatedAt: input.now,
    }),
    // One statement per slide: D1 caps bound parameters per query at 100.
    ...input.slides.map((slide, position) =>
      db.insert(contentVersionSlides).values({
        versionId,
        position,
        html: slide.html,
        width: slide.width,
        height: slide.height,
        renderedAssetId: input.renders[position] ?? null,
        layers: input.layouts[position] ?? null,
      }),
    ),
  ];
  if (input.editorDocument) {
    stmts.push(
      db.insert(contentVersionDocuments).values({
        versionId,
        kind: input.editorDocument.kind,
        assetId: input.editorDocument.assetId,
        format: input.editorDocument.format,
        createdAt: input.now,
      }),
    );
  }
  return { versionId, stmts };
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
      description: "Posts in the trash are left out unless `deleted` is `only` or `include`.",
      request: { query: ContentListQuery },
      responses: { 200: json(ContentList, "A page of content items."), 400: errors[400] },
    }),
    async (c) => {
      const { limit, cursor, brandId, status, type, deleted, sourceContentId, templateId } =
        c.req.valid("query");
      const where: SQL[] = [];
      if (brandId) where.push(eq(contents.brandId, brandId));
      if (sourceContentId) where.push(eq(contents.sourceContentId, sourceContentId));
      if (templateId) where.push(eq(contents.templateId, templateId));
      if (status) where.push(eq(contents.status, status));
      if (type) where.push(eq(contents.type, type));
      if (deleted === "only") where.push(isNotNull(contents.deletedAt));
      else if (deleted !== "include") where.push(isNull(contents.deletedAt));
      if (cursor) where.push(lt(contents.id, cursor));
      const db = createDb(c.env.DB);
      const rows = await db
        .select({ row: contents, current: currentVersionColumns })
        .from(contents)
        .leftJoin(contentVersions, eq(contents.currentVersionId, contentVersions.id))
        .where(and(...where))
        .orderBy(desc(contents.id))
        .limit(limit + 1);
      const pending = await pendingCounts(
        db,
        rows.map((r) => r.row.id),
      );
      return c.json(
        toPage(
          rows,
          limit,
          (r) => toContent(r.row, r.current, pending.get(r.row.id) ?? 0),
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
      assertNotTrashed(row);

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
        if (row.status === "scheduled") stmts.push(...cancelPendingSchedules(db, id, now));
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
      summary: "Move a content item to the trash (or remove a trashed one for good)",
      description:
        "Moves the post to the trash (`deletedAt`; restore with `POST /api/contents/{id}/restore`) " +
        "and stops its queued or running work (generation, render, checks, canvas jobs). It is " +
        "purged with its generated files TRASH_RETENTION_DAYS later. Refused (409) while " +
        "scheduled, publishing or published, and while a cancelled schedule's order is still at " +
        "the cloud publisher (the worker cancels it there within seconds; an immediate sync is " +
        "requested). `?permanent=true` removes a post that is already in the trash now. " +
        "Deleting a trashed post again is a no-op.",
      request: { params: IdParams, query: ContentDeleteQuery },
      responses: { 204: { description: "Deleted." }, 404: errors[404], 409: errors[409] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { permanent } = c.req.valid("query");
      const db = createDb(c.env.DB);
      const { row } = await loadContent(db, id);
      if (permanent) {
        if (!row.deletedAt) {
          throw conflict("Kalıcı silmek için post önce Silinenler'de olmalı.");
        }
        await purgeContent(db, c.env.MEDIA, id);
        return c.body(null, 204);
      }
      if (row.deletedAt) return c.body(null, 204);
      if (statusIn(row.status, UNDELETABLE_STATUSES)) {
        throw invalidTransition(`content is ${row.status} and cannot be deleted`);
      }
      // A trashed post is purged with its schedules. One cancelled here whose order is still at
      // the cloud publisher (the worker has not cancelled it there yet) would then never be
      // cancelled and would still publish: wait for that first.
      const [held] = await db
        .select({ id: schedules.id, status: schedules.status })
        .from(schedules)
        .where(
          and(
            eq(schedules.contentId, id),
            or(
              inArray(schedules.status, ["pending", "publishing"]),
              and(
                eq(schedules.status, "cancelled"),
                eq(schedules.delivery, "cloud"),
                isNotNull(schedules.cloudSyncedAt),
              ),
            ),
          ),
        )
        .limit(1);
      if (held) {
        await requestSyncStatement(db, new Date());
        throw conflict(
          held.status === "cancelled"
            ? "Zamanlamanın iptali bulut yayıncıya henüz iletilmedi; birkaç saniye sonra yeniden deneyin."
            : `content has a ${held.status} schedule and cannot be deleted`,
        );
      }
      const now = new Date();
      await db
        .update(contents)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(contents.id, id), isNull(contents.deletedAt)));
      // Its work stops: a generation finishing later would only fill a post in the trash.
      const active = await db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.contentId, id),
            inArray(jobs.status, ["queued", "running"]),
            inArray(jobs.type, STOPPED_ON_DELETE),
          ),
        );
      for (const job of active) {
        try {
          await c.env.HUB.getByName("main").cancelJob(job.id);
        } catch (error) {
          console.warn(`api: could not cancel job ${job.id} of deleted content ${id}`, error);
        }
      }
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/contents/{id}/restore",
      tags,
      summary: "Take a content item back out of the trash",
      description:
        "Clears `deletedAt`; the post is back on the board as it was (work stopped by the delete " +
        "is not restarted). Restoring a post that is not in the trash is a no-op.",
      request: { params: IdParams },
      responses: { 200: json(Content, "Restored."), 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const { row } = await loadContent(db, id);
      if (row.deletedAt) {
        await db
          .update(contents)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(eq(contents.id, id));
      }
      return c.json(await respondContent(db, id), 200);
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
        "the same hash is a no-op. The generation checks gate it: while the latest check " +
        "run of that version has blocking results under the brand's check settings, or no " +
        "run of it has finished yet (and the brand has checks on), it is refused with 409 " +
        "`conflict` (a Turkish message about the checks; `issues` lists the blocking " +
        "results) unless the body says `acknowledgeChecks: true`.",
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
      const { hash, acknowledgeChecks } = c.req.valid("json");
      const db = createDb(c.env.DB);
      const loaded = await loadContent(db, id);
      const { row, current } = loaded;
      assertNotTrashed(row);

      if (!current) throw conflict("content has no version to approve");
      if (
        row.status === "approved" &&
        approvalMatchesCurrent(loaded) &&
        row.approvedHash === hash
      ) {
        return c.json(await respondContent(db, id), 200);
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
      // The checks of this exact version (E7): failures, or none finished yet, need the user's
      // explicit "approve anyway".
      if (acknowledgeChecks !== true) await assertChecksAllowApproval(db, row, current);
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
      assertNotTrashed(row);

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
      assertNotTrashed(row);

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
      const layouts = checkLayouts(input.layouts, input.slides.length);
      const editorDocument = await checkEditorDocument(db, row.brandId, input.editorDocument);
      if (input.jobId) {
        const job = await db.query.jobs.findFirst({ where: eq(jobs.id, input.jobId) });
        if (!job) throw notFound("job", input.jobId);
      }

      const now = new Date();
      const { versionId, stmts } = await insertVersionStatements(db, {
        contentId: id,
        origin: input.origin,
        slides: input.slides,
        note: input.note ?? null,
        jobId: input.jobId ?? null,
        renders,
        layouts,
        editorDocument,
        now,
      });
      if (row.status === "scheduled") stmts.push(...cancelPendingSchedules(db, id, now));
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
      summary: "Update version metadata (note, rendered assets, layer layouts)",
      description:
        "Slides are immutable; no field changes the content hash. On the version the content's " +
        "approval covers, rendered images are frozen too (they are what gets published): a " +
        "missing render may be filled in (it is rendered from the approved slide), but one " +
        "that is set cannot be replaced or removed (409 `invalid_transition`) — add a new " +
        "version instead, which needs a new approval.",
      request: { params: VersionParams, body: jsonBody(ContentVersionUpdate) },
      responses: {
        200: json(ContentVersion, "Updated."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
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
      const renders =
        input.renderedAssetIds !== undefined
          ? await checkRenderedAssets(
              db,
              row.brandId,
              input.renderedAssetIds,
              versionRow.slideCount,
            )
          : undefined;
      if (renders && row.approvedVersionId === versionRow.id) {
        const stored = await db
          .select({
            position: contentVersionSlides.position,
            renderedAssetId: contentVersionSlides.renderedAssetId,
          })
          .from(contentVersionSlides)
          .where(eq(contentVersionSlides.versionId, versionRow.id));
        const replaced = stored.filter(
          (slide) =>
            slide.renderedAssetId !== null &&
            slide.renderedAssetId !== (renders[slide.position] ?? null),
        );
        if (replaced.length > 0) {
          throw invalidTransition(
            `version ${version} is approved; its rendered image of slide ` +
              `${(replaced[0]?.position ?? 0) + 1} is what gets published and cannot be ` +
              "replaced (add a new version and approve it)",
          );
        }
      }
      const layouts =
        input.layouts !== undefined
          ? checkLayouts(input.layouts, versionRow.slideCount)
          : undefined;
      for (let position = 0; position < versionRow.slideCount; position++) {
        const set: Partial<typeof contentVersionSlides.$inferInsert> = {};
        if (renders) set.renderedAssetId = renders[position] ?? null;
        if (layouts) set.layers = layouts[position] ?? null;
        if (Object.keys(set).length === 0) continue;
        stmts.push(
          db
            .update(contentVersionSlides)
            .set(set)
            .where(
              and(
                eq(contentVersionSlides.versionId, versionRow.id),
                eq(contentVersionSlides.position, position),
              ),
            ),
        );
      }
      await db.batch(stmts as Batch);
      return c.json(await versionWithSlides(db, await requireVersion(db, id, version)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/contents/{id}/versions/{version}/restore",
      tags,
      summary: "Restore an older version as a new version",
      description:
        "Adds a new `manual_edit` version that copies the slides of `version` exactly (so the " +
        "hash equals that version's hash); its renders, layer layouts and editor document are reused. Like any " +
        "new version it clears the approval and cancels pending schedules. Refused (409) while " +
        "publishing or published.",
      request: { params: VersionParams, body: jsonBody(ContentVersionRestore) },
      responses: {
        201: json(ContentVersion, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id, version } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const { row } = await loadContent(db, id);
      assertNotTrashed(row);
      if (!statusIn(row.status, VERSIONABLE_STATUSES)) {
        throw invalidTransition(`content is ${row.status}; no new versions can be added`);
      }
      assertTransition(row.status, "draft", "restored version");
      const source = await versionWithSlides(db, await requireVersion(db, id, version));
      const now = new Date();
      const { versionId, stmts } = await insertVersionStatements(db, {
        contentId: id,
        origin: "manual_edit",
        slides: source.slides,
        note: input.note ?? `v${source.version} geri yüklendi.`,
        jobId: null,
        renders: source.slides.map((s) => s.renderedAssetId),
        layouts: source.slides.map((s) => s.layers ?? null),
        editorDocument: source.editorDocument ?? null,
        now,
      });
      if (row.status === "scheduled") stmts.push(...cancelPendingSchedules(db, id, now));
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
      method: "post",
      path: "/api/contents/{id}/duplicate",
      tags,
      summary: "Duplicate a content item as a new draft",
      description:
        "Copies type, brief, caption and platforms, and the current version (slides, renders, " +
        "layer layouts and the editor document) as version 1 of the copy. Approval, schedules and older versions " +
        "are not copied.",
      request: { params: IdParams, body: jsonBody(ContentDuplicate) },
      responses: {
        201: json(Content, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const { row, current } = await loadContent(db, id);
      assertNotTrashed(row);
      const brand = await requireBrand(db, row.brandId);
      if (brand.status !== "active") throw conflict(`brand ${brand.id} is archived`);
      const now = new Date();
      const copyId = newId();
      const title = (input.title ?? `${row.title} (kopya)`).slice(0, 200);
      const stmts: BatchItem<"sqlite">[] = [
        db.insert(contents).values({
          id: copyId,
          brandId: row.brandId,
          type: row.type,
          title,
          brief: row.brief,
          status: "draft",
          targetPlatforms: row.targetPlatforms,
          caption: row.caption,
          createdAt: now,
          updatedAt: now,
        }),
      ];
      if (current) {
        const source = await versionWithSlides(db, await requireVersion(db, id, current.version));
        const inserted = await insertVersionStatements(db, {
          contentId: copyId,
          origin: source.origin,
          slides: source.slides,
          note: `"${row.title}" v${source.version} kopyası.`.slice(0, 2000),
          jobId: null,
          renders: source.slides.map((s) => s.renderedAssetId),
          layouts: source.slides.map((s) => s.layers ?? null),
          editorDocument: source.editorDocument ?? null,
          now,
        });
        stmts.push(
          ...inserted.stmts,
          db
            .update(contents)
            .set({ currentVersionId: inserted.versionId })
            .where(eq(contents.id, copyId)),
        );
      }
      await db.batch(stmts as Batch);
      return c.json(await respondContent(db, copyId), 201);
    },
  );
