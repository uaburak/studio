import { createRoute, z } from "@hono/zod-openapi";
import {
  type Content,
  ContentGeneratePayload,
  ContentRepurpose,
  ContentRepurposeMany,
  ContentRepurposeManyResult,
  ContentRepurposeResult,
  ContentTemplate,
  ContentTemplateCreate,
  ContentTemplateDetail,
  ContentTemplateList,
  ContentTemplateListQuery,
  ContentTemplateUpdate,
  EntityId,
  fillableFields,
  type Platform,
  REPURPOSE_LABEL,
  type RepurposeTarget,
  repurposeBlocker,
  TEMPLATE_CONTENT_TYPES,
  TEMPLATE_SOURCE_STATUSES,
  type TemplateField,
  TemplateUse,
  TemplateUseResult,
  templateFillMode,
  unknownFieldKeys,
} from "@studio/contract";
import { templateFields } from "@studio/design-kit/template";
import { and, asc, desc, eq, inArray, isNull, lt, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { createDb, type Db } from "../db/client.ts";
import { toContent } from "../db/mappers.ts";
import {
  assets,
  brandProfiles,
  contents,
  contentTemplateSlides,
  contentTemplates,
  contentVersionDocuments,
  contentVersionSlides,
  contentVersions,
  type TemplateFieldJson,
} from "../db/schema.ts";
import { assetHeld } from "../lib/asset-usage.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { toPage } from "../lib/pagination.ts";
import { deleteAssetForGood } from "../lib/purge.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import {
  existingProducts,
  findTemplate,
  type TemplateRow,
  templateUseCounts,
  toTemplate,
} from "../lib/templates.ts";
import { requireBrand } from "./brands.ts";
import { assertNotTrashed, loadContent } from "./contents.ts";
import { createJob } from "./jobs.ts";

/*
 * Brand templates (N9) and repurposing (N10).
 *
 * - `POST /api/templates`: an approved / published post's version becomes a template of its
 *   brand: a copy of its slides (and its Wecra document for a canvas version) whose text layers
 *   and image slots are fields (`@studio/design-kit/template templateFields`).
 * - `POST /api/templates/{id}/use`: a new draft post (type, brand from the template) and its
 *   `content.generate` job with `template` in the payload; the worker fills the layout (HTML:
 *   layer patches; canvas: a `canvas.apply` job on a copy of the document) and checks it.
 * - `POST /api/contents/{id}/repurpose` (and `/api/contents/repurpose` for many): a story or a
 *   Reels made from a post — a new draft linked to it (`Content.source`) and its
 *   `content.generate` job with `repurpose` in the payload.
 */

const tags = ["Templates"];
type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

const BrandParams = z.object({ brandId: EntityId });

async function requireTemplate(db: Db, id: string): Promise<TemplateRow> {
  const row = await findTemplate(db, id);
  if (!row) throw notFound("template", id);
  return row;
}

async function templateSlides(db: Db, id: string) {
  return db
    .select()
    .from(contentTemplateSlides)
    .where(eq(contentTemplateSlides.templateId, id))
    .orderBy(asc(contentTemplateSlides.position));
}

async function respondTemplate(db: Db, row: TemplateRow): Promise<ContentTemplate> {
  const slides = await templateSlides(db, row.id);
  const uses = await templateUseCounts(db, [row.id]);
  return toTemplate(
    row,
    slides.map((s) => s.renderedAssetId),
    uses.get(row.id) ?? 0,
  );
}

async function currentProfileVersion(db: Db, brandId: string): Promise<number | undefined> {
  const profile = await db.query.brandProfiles.findFirst({
    where: and(eq(brandProfiles.brandId, brandId), eq(brandProfiles.isCurrent, true)),
  });
  return profile?.version;
}

/** Insert a draft post (no version yet) and return its id. */
async function insertDraft(
  db: Db,
  values: {
    brandId: string;
    type: Content["type"];
    title: string;
    brief: string;
    targetPlatforms: Platform[];
    caption: string;
    templateId?: string | null;
    source?: { contentId: string; version: number; kind: RepurposeTarget } | null;
  },
): Promise<string> {
  const now = new Date();
  const id = newId();
  await db.insert(contents).values({
    id,
    brandId: values.brandId,
    type: values.type,
    title: values.title.slice(0, 200),
    brief: values.brief.slice(0, 20_000),
    status: "draft",
    targetPlatforms: values.targetPlatforms,
    caption: values.caption.slice(0, 10_000),
    templateId: values.templateId ?? null,
    sourceContentId: values.source?.contentId ?? null,
    sourceVersion: values.source?.version ?? null,
    sourceKind: values.source?.kind ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

/** The job for a new draft; the draft goes again when the job cannot be queued. */
async function queueFor(
  env: Env,
  db: Db,
  contentId: string,
  brandId: string,
  payload: Record<string, unknown>,
) {
  try {
    return await createJob(env, {
      type: "content.generate",
      brandId,
      contentId,
      payload,
      priority: 0,
    });
  } catch (error) {
    await db.delete(contents).where(eq(contents.id, contentId));
    throw error;
  }
}

async function contentView(db: Db, id: string): Promise<Content> {
  const { row, current } = await loadContent(db, id);
  return toContent(row, current);
}

// --- repurposing ------------------------------------------------------------------------------

interface RepurposeInput {
  target: RepurposeTarget;
  title?: string | undefined;
  instructions?: string | undefined;
  targetPlatforms?: Platform[] | undefined;
  conversationId?: string | undefined;
  model?: string | undefined;
  effort?: string | undefined;
}

async function repurposeOne(
  env: Env,
  db: Db,
  sourceId: string,
  input: RepurposeInput,
): Promise<{ content: Content; job: Awaited<ReturnType<typeof createJob>> }> {
  const loaded = await loadContent(db, sourceId);
  const source = toContent(loaded.row, loaded.current);
  const blocked = repurposeBlocker(source, input.target);
  if (blocked) throw conflict(blocked.message);
  const brand = await requireBrand(db, loaded.row.brandId);
  if (brand.status !== "active") throw conflict(`brand ${brand.id} is archived`);
  const version = loaded.current?.version as number;
  const title = input.title ?? `${loaded.row.title} · ${REPURPOSE_LABEL[input.target]}`;
  const targetPlatforms = input.targetPlatforms ?? loaded.row.targetPlatforms;
  const contentId = await insertDraft(db, {
    brandId: loaded.row.brandId,
    type: input.target,
    title,
    brief: loaded.row.brief,
    targetPlatforms,
    caption: loaded.row.caption,
    source: { contentId: sourceId, version, kind: input.target },
  });
  const profileVersion = await currentProfileVersion(db, loaded.row.brandId);
  const payload = ContentGeneratePayload.parse({
    brandId: loaded.row.brandId,
    contentId,
    title: title.slice(0, 200),
    brief: (loaded.row.brief || loaded.row.title).slice(0, 20_000),
    type: input.target,
    targetPlatforms,
    repurpose: { sourceContentId: sourceId, sourceVersion: version, target: input.target },
    ...(input.target === "reel" ? { reel: { recipe: "motion_graphics" } } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(profileVersion ? { brandProfileVersion: profileVersion } : {}),
  });
  const job = await queueFor(env, db, contentId, loaded.row.brandId, payload);
  return { content: await contentView(db, contentId), job };
}

// --- routes ------------------------------------------------------------------------------------

export const templateRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/templates",
      tags,
      summary: "List a brand's templates (newest first)",
      request: { params: BrandParams, query: ContentTemplateListQuery },
      responses: {
        200: json(ContentTemplateList, "A page of templates."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const { limit, cursor, kind, contentType } = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      const where: SQL[] = [eq(contentTemplates.brandId, brandId)];
      if (kind) where.push(eq(contentTemplates.kind, kind));
      if (contentType) where.push(eq(contentTemplates.contentType, contentType));
      if (cursor) where.push(lt(contentTemplates.id, cursor));
      const rows = await db
        .select()
        .from(contentTemplates)
        .where(and(...where))
        .orderBy(desc(contentTemplates.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const ids = page.map((r) => r.id);
      const previews = ids.length
        ? await db
            .select({
              templateId: contentTemplateSlides.templateId,
              position: contentTemplateSlides.position,
              renderedAssetId: contentTemplateSlides.renderedAssetId,
            })
            .from(contentTemplateSlides)
            .where(inArray(contentTemplateSlides.templateId, ids))
        : [];
      const uses = await templateUseCounts(db, ids);
      const view = (r: TemplateRow) =>
        toTemplate(
          r,
          previews
            .filter((p) => p.templateId === r.id)
            .sort((a, b) => a.position - b.position)
            .map((p) => p.renderedAssetId),
          uses.get(r.id) ?? 0,
        );
      return c.json(
        toPage(
          rows,
          limit,
          (r) => view(r),
          (r) => r.id,
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/templates",
      tags,
      summary: "Save an approved or published post as a brand template",
      description:
        "Copies the version (default: the approved one) — slides, renders and, for a canvas " +
        "version, its Wecra document — and makes its text layers and image slots fillable " +
        "fields named from their roles. 409 when the post was never approved, is a Reels, or " +
        "has nothing to fill.",
      request: { body: jsonBody(ContentTemplateCreate) },
      responses: {
        201: json(ContentTemplate, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const { row, current } = await loadContent(db, input.contentId);
      assertNotTrashed(row);
      if (!(TEMPLATE_CONTENT_TYPES as readonly string[]).includes(row.type))
        throw conflict("Reels şablon olamaz; yalnızca post, carousel ve story.");
      if (!(TEMPLATE_SOURCE_STATUSES as readonly string[]).includes(row.status))
        throw conflict("Yalnızca onaylı, zamanlanmış ya da yayınlanmış bir post şablon olabilir.");
      const brand = await requireBrand(db, row.brandId);
      if (brand.status !== "active") throw conflict(`brand ${brand.id} is archived`);

      // The approved version unless another one is named.
      let versionRow = input.version
        ? await db.query.contentVersions.findFirst({
            where: and(
              eq(contentVersions.contentId, row.id),
              eq(contentVersions.version, input.version),
            ),
          })
        : row.approvedVersionId
          ? await db.query.contentVersions.findFirst({
              where: eq(contentVersions.id, row.approvedVersionId),
            })
          : undefined;
      if (!versionRow && !input.version && current)
        versionRow = await db.query.contentVersions.findFirst({
          where: eq(contentVersions.id, current.id),
        });
      if (!versionRow) throw notFound(`content ${row.id} version`, input.version ?? "approved");
      const slides = await db
        .select()
        .from(contentVersionSlides)
        .where(eq(contentVersionSlides.versionId, versionRow.id))
        .orderBy(asc(contentVersionSlides.position));
      const document = await db.query.contentVersionDocuments.findFirst({
        where: eq(contentVersionDocuments.versionId, versionRow.id),
      });

      const extracted = templateFields(
        slides.map((s) => ({ html: s.html, width: s.width, height: s.height, layers: s.layers })),
      );
      if (!extracted.ok) throw conflict(extracted.reason);
      if (extracted.kind === "canvas" && !document)
        throw conflict("Tuval sürümünün belgesi yok; postu tuvalde açıp yeniden kaydedin.");
      if (!extracted.fields.some((f) => !f.locked))
        throw conflict("Bu postta doldurulacak metin ya da görsel yok; şablon olamaz.");
      const first = slides[0];
      if (!first) throw conflict("Sürümde kare yok.");

      const now = new Date();
      const id = newId();
      const stmts: BatchItem<"sqlite">[] = [
        db.insert(contentTemplates).values({
          id,
          brandId: row.brandId,
          name: (input.name ?? row.title).slice(0, 120),
          description: input.description ?? "",
          kind: extracted.kind,
          contentType: row.type,
          width: first.width,
          height: first.height,
          slideCount: slides.length,
          fields: extracted.fields as TemplateFieldJson[],
          sourceContentId: row.id,
          sourceVersion: versionRow.version,
          sourceTitle: row.title.slice(0, 200),
          documentAssetId: extracted.kind === "canvas" ? (document?.assetId ?? null) : null,
          documentFormat: extracted.kind === "canvas" ? (document?.format ?? null) : null,
          createdAt: now,
          updatedAt: now,
        }),
        // One statement per slide: D1 caps bound parameters per query at 100.
        ...slides.map((s) =>
          db.insert(contentTemplateSlides).values({
            templateId: id,
            position: s.position,
            html: s.html,
            width: s.width,
            height: s.height,
            renderedAssetId: s.renderedAssetId,
            layers: s.layers,
          }),
        ),
      ];
      await db.batch(stmts as Batch);
      return c.json(await respondTemplate(db, await requireTemplate(db, id)), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/templates/{id}",
      tags,
      summary: "Get a template with its slides",
      request: { params: IdParams },
      responses: { 200: json(ContentTemplateDetail, "The template."), 404: errors[404] },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      const row = await requireTemplate(db, c.req.valid("param").id);
      const slides = await templateSlides(db, row.id);
      const uses = await templateUseCounts(db, [row.id]);
      return c.json(
        {
          ...toTemplate(
            row,
            slides.map((s) => s.renderedAssetId),
            uses.get(row.id) ?? 0,
          ),
          slides: slides.map((s) => ({
            html: s.html,
            width: s.width,
            height: s.height,
            renderedAssetId: s.renderedAssetId,
            layers: s.layers ?? null,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/templates/{id}",
      tags,
      summary: "Rename a template or change its fields (label, auto-fit, locked)",
      request: { params: IdParams, body: jsonBody(ContentTemplateUpdate) },
      responses: {
        200: json(ContentTemplate, "Updated."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const row = await requireTemplate(db, id);
      let fields = row.fields;
      if (input.fields) {
        const keys = new Set(row.fields.map((f) => f.key));
        const unknown = input.fields.filter((f) => !keys.has(f.key));
        if (unknown.length)
          throw badRequest(
            `unknown field ${unknown.map((f) => f.key).join(", ")}`,
            unknown.map((f) => ({ path: "fields", message: `no field ${f.key}` })),
          );
        fields = row.fields.map((f) => {
          const change = input.fields?.find((x) => x.key === f.key);
          if (!change) return f;
          return {
            ...f,
            ...(change.label !== undefined ? { label: change.label } : {}),
            ...(change.autoFit !== undefined ? { autoFit: change.autoFit } : {}),
            ...(change.locked !== undefined ? { locked: change.locked } : {}),
            ...(change.minFontSize !== undefined ? { minFontSize: change.minFontSize } : {}),
          };
        });
      }
      await db
        .update(contentTemplates)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          fields,
          updatedAt: new Date(),
        })
        .where(eq(contentTemplates.id, id));
      return c.json(await respondTemplate(db, await requireTemplate(db, id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/api/templates/{id}",
      tags,
      summary: "Delete a template",
      description:
        "Posts and plan items made from it keep their designs and forget the template. Files " +
        "only the template still held (renders of a post deleted since) go with it.",
      request: { params: IdParams },
      responses: { 204: { description: "Deleted." }, 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const row = await requireTemplate(db, id);
      const slides = await templateSlides(db, id);
      const candidates = [
        ...slides.flatMap((s) => (s.renderedAssetId ? [s.renderedAssetId] : [])),
        ...(row.documentAssetId ? [row.documentAssetId] : []),
      ];
      await db.delete(contentTemplates).where(eq(contentTemplates.id, id));
      // Files nothing else uses any more (made for a post that is gone): removed now, as the
      // post's purge would have done had the template not held them.
      const sourceGone =
        row.sourceContentId === null ||
        !(await db.query.contents.findFirst({ where: eq(contents.id, row.sourceContentId) }));
      if (candidates.length && sourceGone) {
        const made = await db
          .select()
          .from(assets)
          .where(
            and(
              inArray(assets.id, [...new Set(candidates)]),
              eq(assets.brandId, row.brandId),
              isNull(assets.deletedAt),
            ),
          );
        for (const asset of made) {
          if (asset.source !== "generated") continue;
          if (await assetHeld(db, c.env.MEDIA, asset)) continue;
          await deleteAssetForGood(db, c.env.MEDIA, asset);
        }
      }
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/templates/{id}/use",
      tags,
      summary: "Make a new post from a template",
      description:
        "Creates a draft post of the template's brand and type (linked to the template) and " +
        "queues its `content.generate` job with `template` in the payload: the layout stays " +
        "exactly, the fields get the given texts and pictures (`manual`) or the AI writes them " +
        "from the brief (`ai`). Pictures must be images of the brand.",
      request: { params: IdParams, body: jsonBody(TemplateUse) },
      responses: {
        201: json(TemplateUseResult, "The new post and its job."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const row = await requireTemplate(db, id);
      const brand = await requireBrand(db, row.brandId);
      if (brand.status !== "active") throw conflict(`brand ${brand.id} is archived`);
      const template = { fields: row.fields as TemplateField[] };
      const values = input.values ?? {};
      const images = input.images ?? {};
      const unknown = unknownFieldKeys(template, { values, images });
      if (unknown.length)
        throw badRequest(
          `no unlocked field ${unknown.join(", ")}`,
          unknown.map((k) => ({ path: `values.${k}`, message: "unknown or locked field" })),
        );
      const fill = templateFillMode(input);
      if (fill === "ai" && !input.brief?.trim())
        throw badRequest("AI ile doldurmak için ne anlatılacağını (brief) yaz.", [
          { path: "brief", message: "required with fill: ai" },
        ]);
      if (fill === "manual" && fillableFields(template).length === 0)
        throw conflict("Şablonun doldurulacak alanı yok.");
      const assetIds = [...new Set(Object.values(images))];
      if (assetIds.length) {
        const found = await db
          .select({
            id: assets.id,
            brandId: assets.brandId,
            kind: assets.kind,
            mimeType: assets.mimeType,
            deletedAt: assets.deletedAt,
          })
          .from(assets)
          .where(inArray(assets.id, assetIds));
        for (const [key, assetId] of Object.entries(images)) {
          const a = found.find((x) => x.id === assetId);
          const ok =
            a &&
            a.brandId === row.brandId &&
            !a.deletedAt &&
            /^image\/(jpeg|png|webp|gif)$/.test(a.mimeType);
          if (!ok)
            throw badRequest(`images.${key}: not an image of the brand`, [
              { path: `images.${key}`, message: "must be a JPEG, PNG, WebP or GIF of the brand" },
            ]);
        }
      }
      const slotProducts = input.slotImage?.productIds ?? [];
      if (slotProducts.length) {
        const found = await existingProducts(db, row.brandId, slotProducts);
        slotProducts.forEach((id, i) => {
          if (!found.has(id))
            throw badRequest(`slotImage.productIds.${i}: not a product of the brand`, [
              { path: `slotImage.productIds.${i}`, message: "unknown product of this brand" },
            ]);
        });
      }
      const source = row.sourceContentId
        ? await db.query.contents.findFirst({ where: eq(contents.id, row.sourceContentId) })
        : undefined;
      const targetPlatforms: Platform[] = input.targetPlatforms ??
        source?.targetPlatforms ?? ["instagram"];
      const title = input.title ?? row.name;
      const brief = input.brief ?? "";
      const contentId = await insertDraft(db, {
        brandId: row.brandId,
        type: row.contentType,
        title,
        brief,
        targetPlatforms,
        caption: "",
        templateId: row.id,
      });
      const profileVersion = await currentProfileVersion(db, row.brandId);
      const payload = ContentGeneratePayload.parse({
        brandId: row.brandId,
        contentId,
        title: title.slice(0, 200),
        brief: (brief || title).slice(0, 20_000),
        type: row.contentType,
        targetPlatforms,
        template: {
          templateId: row.id,
          values,
          images,
          fill,
          autoFit: input.autoFit ?? true,
        },
        ...(input.instructions ? { instructions: input.instructions } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.effort ? { effort: input.effort } : {}),
        ...(profileVersion ? { brandProfileVersion: profileVersion } : {}),
        ...(input.imageBrief?.trim() ? { imageBrief: input.imageBrief.trim() } : {}),
        // The owner's consented AI picture for the template's empty image slots (never implied).
        ...(input.slotImage
          ? {
              imageSlot: "ai_generate",
              slotImage: {
                ...input.slotImage,
                ...(!input.slotImage.conversationId && input.conversationId
                  ? { conversationId: input.conversationId }
                  : {}),
              },
            }
          : {}),
      });
      const job = await queueFor(c.env, db, contentId, row.brandId, payload);
      return c.json({ content: await contentView(db, contentId), job }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/contents/repurpose",
      tags,
      summary: "Convert many posts into stories or Reels",
      description:
        "One linked draft and one `content.generate` job per post; posts that cannot be " +
        "converted (a Reels, a story to a story, no design, in the trash) are listed in `skipped`.",
      request: { body: jsonBody(ContentRepurposeMany) },
      responses: {
        200: json(ContentRepurposeManyResult, "What was queued and what was left out."),
        400: errors[400],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const created: z.output<typeof ContentRepurposeManyResult>["created"] = [];
      const skipped: z.output<typeof ContentRepurposeManyResult>["skipped"] = [];
      for (const id of input.contentIds) {
        const found = await db.query.contents.findFirst({ where: eq(contents.id, id) });
        if (!found) {
          skipped.push({ contentId: id, reason: "not_found", message: "Post bulunamadı." });
          continue;
        }
        const loaded = await loadContent(db, id);
        const blocked = repurposeBlocker(toContent(loaded.row, loaded.current), input.target);
        if (blocked) {
          skipped.push({ contentId: id, ...blocked });
          continue;
        }
        const made = await repurposeOne(c.env, db, id, input);
        created.push({ sourceContentId: id, ...made });
      }
      return c.json({ created, skipped }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/contents/{id}/repurpose",
      tags,
      summary: "Convert a post into a story or a Reels",
      description:
        "A new draft of the same brand linked to the post (`source`) and its " +
        "`content.generate` job: a story (1080×1920, the brand's design, the post's texts " +
        "adapted, safe areas kept) or a Reels (motion graphics from the post's slides and " +
        "texts, its pictures as scenes).",
      request: { params: IdParams, body: jsonBody(ContentRepurpose) },
      responses: {
        201: json(ContentRepurposeResult, "The new post and its job."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      return c.json(await repurposeOne(c.env, db, id, input), 201);
    },
  );
