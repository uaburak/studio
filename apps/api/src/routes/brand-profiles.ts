import { createRoute, z } from "@hono/zod-openapi";
import {
  BrandProfile,
  BrandProfileCreate,
  BrandProfileList,
  BrandProfileListQuery,
  BrandProfileUpdate,
  EntityId,
  ProfileVersion,
} from "@studio/contract";
import { and, desc, eq, lt, max, ne, type SQL } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { toBrandProfile } from "../db/mappers.ts";
import { brandProfiles } from "../db/schema.ts";
import { invalidTransition, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";

const tags = ["Brand profiles"];

const BrandParams = z.object({ brandId: EntityId });
const VersionParams = z.object({ brandId: EntityId, version: ProfileVersion });

async function requireProfile(db: Db, brandId: string, version: number) {
  const row = await db.query.brandProfiles.findFirst({
    where: and(eq(brandProfiles.brandId, brandId), eq(brandProfiles.version, version)),
  });
  if (!row) throw notFound(`brand ${brandId} profile version`, version);
  return row;
}

export const brandProfileRoutes = createRouter()
  // Registered before /{version} so "current" is not parsed as a version.
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/profiles/current",
      tags,
      summary: "Get the brand's current (approved) profile",
      request: { params: BrandParams },
      responses: {
        200: json(BrandProfile, "The current profile."),
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      const row = await db.query.brandProfiles.findFirst({
        where: and(eq(brandProfiles.brandId, brandId), eq(brandProfiles.isCurrent, true)),
      });
      if (!row) throw notFound("current profile for brand", brandId);
      return c.json(toBrandProfile(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/profiles",
      tags,
      summary: "List profile versions (newest first)",
      request: { params: BrandParams, query: BrandProfileListQuery },
      responses: {
        200: json(BrandProfileList, "A page of profile versions."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const { limit, cursor, status } = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      const where: SQL[] = [eq(brandProfiles.brandId, brandId)];
      if (status) where.push(eq(brandProfiles.status, status));
      if (cursor) where.push(lt(brandProfiles.id, cursor));
      const rows = await db
        .select()
        .from(brandProfiles)
        .where(and(...where))
        .orderBy(desc(brandProfiles.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toBrandProfile, (r) => r.id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/brands/{brandId}/profiles",
      tags,
      summary: "Create a new draft profile version",
      request: { params: BrandParams, body: jsonBody(BrandProfileCreate) },
      responses: {
        201: json(BrandProfile, "Created (draft)."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      const [last] = await db
        .select({ version: max(brandProfiles.version) })
        .from(brandProfiles)
        .where(eq(brandProfiles.brandId, brandId));
      const now = new Date();
      const [row] = await db
        .insert(brandProfiles)
        .values({
          id: newId(),
          brandId,
          version: (last?.version ?? 0) + 1,
          status: "draft",
          isCurrent: false,
          tokens: input.tokens,
          designRules: input.designRules,
          voice: input.voice,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return c.json(toBrandProfile(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/profiles/{version}",
      tags,
      summary: "Get one profile version",
      request: { params: VersionParams },
      responses: { 200: json(BrandProfile, "The profile version."), 404: errors[404] },
    }),
    async (c) => {
      const { brandId, version } = c.req.valid("param");
      const row = await requireProfile(createDb(c.env.DB), brandId, version);
      return c.json(toBrandProfile(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/brands/{brandId}/profiles/{version}",
      tags,
      summary: "Edit a draft profile version",
      description: "Approved versions are immutable (409); create a new version instead.",
      request: { params: VersionParams, body: jsonBody(BrandProfileUpdate) },
      responses: {
        200: json(BrandProfile, "Updated."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { brandId, version } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const current = await requireProfile(db, brandId, version);
      if (current.status !== "draft") {
        throw invalidTransition(`profile version ${version} is approved and cannot be edited`);
      }
      const [row] = await db
        .update(brandProfiles)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(brandProfiles.id, current.id), eq(brandProfiles.status, "draft")))
        .returning();
      if (!row) throw invalidTransition(`profile version ${version} changed concurrently`);
      return c.json(toBrandProfile(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/brands/{brandId}/profiles/{version}/approve",
      tags,
      summary: "Approve a profile version and make it current",
      description:
        "Freezes the version and makes it the brand's only current profile. " +
        "Approving an older approved version again makes it current (rollback).",
      request: { params: VersionParams },
      responses: { 200: json(BrandProfile, "Approved and current."), 404: errors[404] },
    }),
    async (c) => {
      const { brandId, version } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const target = await requireProfile(db, brandId, version);
      if (!target.isCurrent) {
        const now = new Date();
        // One transaction: clear the old current flag, then set the new one,
        // so the partial unique index never sees two current rows.
        await db.batch([
          db
            .update(brandProfiles)
            .set({ isCurrent: false, updatedAt: now })
            .where(
              and(
                eq(brandProfiles.brandId, brandId),
                eq(brandProfiles.isCurrent, true),
                ne(brandProfiles.id, target.id),
              ),
            ),
          db
            .update(brandProfiles)
            .set({
              status: "approved",
              isCurrent: true,
              approvedAt: target.approvedAt ?? now,
              updatedAt: now,
            })
            .where(eq(brandProfiles.id, target.id)),
        ]);
      }
      const row = await requireProfile(db, brandId, version);
      return c.json(toBrandProfile(row), 200);
    },
  );
