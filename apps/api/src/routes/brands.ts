import { createRoute, z } from "@hono/zod-openapi";
import {
  Brand,
  BrandCreate,
  BrandList,
  BrandListQuery,
  BrandUpdate,
  EntityId,
  MentionCandidateList,
  slugify,
} from "@studio/contract";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { toBrand } from "../db/mappers.ts";
import { brands } from "../db/schema.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { mentionCandidates } from "../lib/mentions.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";

const tags = ["Brands"];

export async function requireBrand(db: Db, id: string) {
  const row = await db.query.brands.findFirst({ where: eq(brands.id, id) });
  if (!row) throw notFound("brand", id);
  return row;
}

async function assertSlugFree(db: Db, slug: string, exceptId?: string) {
  const row = await db.query.brands.findFirst({ where: eq(brands.slug, slug) });
  if (row && row.id !== exceptId) throw conflict(`slug "${slug}" is already used by another brand`);
}

export const brandRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands",
      tags,
      summary: "List brands (newest first)",
      request: { query: BrandListQuery },
      responses: { 200: json(BrandList, "A page of brands."), 400: errors[400] },
    }),
    async (c) => {
      const { limit, cursor, status } = c.req.valid("query");
      const where: SQL[] = [];
      if (status) where.push(eq(brands.status, status));
      if (cursor) where.push(lt(brands.id, cursor));
      const rows = await createDb(c.env.DB)
        .select()
        .from(brands)
        .where(and(...where))
        .orderBy(desc(brands.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toBrand, (r) => r.id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/brands",
      tags,
      summary: "Create a brand",
      request: { body: jsonBody(BrandCreate) },
      responses: { 201: json(Brand, "Created."), 400: errors[400], 409: errors[409] },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const slug = input.slug ?? slugify(input.name);
      if (slug.length < 2) {
        throw badRequest("cannot derive a slug from this name; pass `slug` explicitly", [
          { path: "slug", message: "required for this name" },
        ]);
      }
      await assertSlugFree(db, slug);
      const now = new Date();
      const [row] = await db
        .insert(brands)
        .values({
          id: newId(),
          name: input.name,
          slug,
          defaultLanguage: input.defaultLanguage,
          status: "active",
          defaultEngine: input.defaultEngine ?? null,
          imageStylePreset: input.imageStylePreset ?? "",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return c.json(toBrand(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{id}",
      tags,
      summary: "Get a brand",
      request: { params: IdParams },
      responses: { 200: json(Brand, "The brand."), 404: errors[404] },
    }),
    async (c) => {
      const row = await requireBrand(createDb(c.env.DB), c.req.valid("param").id);
      return c.json(toBrand(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/brands/{id}",
      tags,
      summary: "Update or archive a brand",
      description: "Brands are never deleted; set `status: archived` instead.",
      request: { params: IdParams, body: jsonBody(BrandUpdate) },
      responses: {
        200: json(Brand, "Updated."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, id);
      if (input.slug) await assertSlugFree(db, input.slug, id);
      const [row] = await db
        .update(brands)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(brands.id, id))
        .returning();
      if (!row) throw notFound("brand", id);
      return c.json(toBrand(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/mention-candidates",
      tags,
      summary: "Products and posts the chat composer offers after `@`",
      description:
        "Products (oldest first), then the newest posts (at most MAX_MENTION_POSTS; posts in " +
        "the trash are left out), each with its mention name (`slug`, without `@`). Names are " +
        "unique in the brand; file aliases of a conversation (`@image`…) win over them.",
      request: { params: z.object({ brandId: EntityId }) },
      responses: { 200: json(MentionCandidateList, "The candidates."), 404: errors[404] },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      return c.json({ items: await mentionCandidates(db, brandId) }, 200);
    },
  );
