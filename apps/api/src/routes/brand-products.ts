import { createRoute, z } from "@hono/zod-openapi";
import {
  BrandProduct,
  BrandProductCreate,
  BrandProductList,
  BrandProductListQuery,
  BrandProductUpdate,
  EntityId,
} from "@studio/contract";
import { and, asc, eq, gt, inArray, type SQL } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { type BrandProductRow, toBrandProduct } from "../db/mappers.ts";
import { assets, brandProducts } from "../db/schema.ts";
import { badRequest, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { productSlugs } from "../lib/mentions.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";

/**
 * The brand's products ("Ürünler" on the brand profile): name, short
 * description, category, tags, notes and photos. Photos are ordinary `image`
 * assets of the same brand (`POST /api/assets`); the product only references
 * them, the first one is the cover. Products are deleted for good.
 */

const tags = ["Brands"];

const BrandParams = z.object({ brandId: EntityId });
const ProductParams = z.object({ brandId: EntityId, productId: EntityId });

async function requireProduct(db: Db, brandId: string, productId: string) {
  const row = await db.query.brandProducts.findFirst({
    where: and(eq(brandProducts.id, productId), eq(brandProducts.brandId, brandId)),
  });
  if (!row) throw notFound(`brand ${brandId} product`, productId);
  return row;
}

/** Every photo must be an `image` asset of this brand (400 with one issue per bad entry). */
async function assertImages(db: Db, brandId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const rows = await db
    .select({ id: assets.id, kind: assets.kind })
    .from(assets)
    .where(and(eq(assets.brandId, brandId), inArray(assets.id, [...new Set(ids)])));
  const kindById = new Map(rows.map((r) => [r.id, r.kind]));
  const issues = ids.flatMap((id, index) => {
    const kind = kindById.get(id);
    const path = `imageAssetIds.${index}`;
    if (!kind) return [{ path, message: "not an asset of this brand" }];
    if (kind !== "image") return [{ path, message: `asset kind ${kind} is not allowed here` }];
    return [];
  });
  if (issues.length > 0) throw badRequest("the product references unusable files", issues);
}

/** The product with its mention name (`@boro`). */
async function withSlug(db: Db, row: BrandProductRow) {
  const slugs = await productSlugs(db, row.brandId);
  return toBrandProduct(row, slugs.get(row.id));
}

export const brandProductRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/products",
      tags,
      summary: "List the brand's products (oldest first)",
      request: { params: BrandParams, query: BrandProductListQuery },
      responses: {
        200: json(BrandProductList, "A page of products."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const { limit, cursor } = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      const where: SQL[] = [eq(brandProducts.brandId, brandId)];
      if (cursor) where.push(gt(brandProducts.id, cursor));
      const rows = await db
        .select()
        .from(brandProducts)
        .where(and(...where))
        .orderBy(asc(brandProducts.id))
        .limit(limit + 1);
      const slugs = await productSlugs(db, brandId);
      return c.json(
        toPage(
          rows,
          limit,
          (r) => toBrandProduct(r, slugs.get(r.id)),
          (r) => r.id,
        ),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/brands/{brandId}/products",
      tags,
      summary: "Add a product",
      description: "Photos must be `image` assets of this brand; the first one is the cover.",
      request: { params: BrandParams, body: jsonBody(BrandProductCreate) },
      responses: {
        201: json(BrandProduct, "Created."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      await assertImages(db, brandId, input.imageAssetIds);
      const now = new Date();
      const [row] = await db
        .insert(brandProducts)
        .values({
          id: newId(),
          brandId,
          name: input.name,
          description: input.description,
          category: input.category,
          tags: input.tags,
          notes: input.notes,
          imageAssetIds: input.imageAssetIds,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return c.json(await withSlug(db, row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/products/{productId}",
      tags,
      summary: "Get one product",
      request: { params: ProductParams },
      responses: { 200: json(BrandProduct, "The product."), 404: errors[404] },
    }),
    async (c) => {
      const { brandId, productId } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const row = await requireProduct(db, brandId, productId);
      return c.json(await withSlug(db, row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/brands/{brandId}/products/{productId}",
      tags,
      summary: "Edit a product",
      description: "Lists (`tags`, `imageAssetIds`) are replaced as a whole.",
      request: { params: ProductParams, body: jsonBody(BrandProductUpdate) },
      responses: {
        200: json(BrandProduct, "Updated."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId, productId } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const current = await requireProduct(db, brandId, productId);
      if (input.imageAssetIds) await assertImages(db, brandId, input.imageAssetIds);
      const [row] = await db
        .update(brandProducts)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(brandProducts.id, current.id))
        .returning();
      if (!row) throw notFound(`brand ${brandId} product`, productId);
      return c.json(await withSlug(db, row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/api/brands/{brandId}/products/{productId}",
      tags,
      summary: "Delete a product",
      description: "Deleted for good; its photos stay in the brand's media.",
      request: { params: ProductParams },
      responses: { 204: { description: "Deleted." }, 404: errors[404] },
    }),
    async (c) => {
      const { brandId, productId } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const current = await requireProduct(db, brandId, productId);
      await db.delete(brandProducts).where(eq(brandProducts.id, current.id));
      return c.body(null, 204);
    },
  );
