import { createRoute } from "@hono/zod-openapi";
import {
  SocialAccount,
  SocialAccountCreate,
  SocialAccountList,
  SocialAccountListQuery,
  SocialAccountUpdate,
} from "@studio/contract";
import { and, desc, eq, lt, type SQL } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { toSocialAccount } from "../db/mappers.ts";
import { socialAccounts } from "../db/schema.ts";
import { notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";

const tags = ["Social accounts"];

export async function requireSocialAccount(db: Db, id: string) {
  const row = await db.query.socialAccounts.findFirst({ where: eq(socialAccounts.id, id) });
  if (!row) throw notFound("social account", id);
  return row;
}

export const socialAccountRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/social-accounts",
      tags,
      summary: "List social accounts (newest first)",
      request: { query: SocialAccountListQuery },
      responses: { 200: json(SocialAccountList, "A page of accounts."), 400: errors[400] },
    }),
    async (c) => {
      const { limit, cursor, brandId, platform, status } = c.req.valid("query");
      const where: SQL[] = [];
      if (brandId) where.push(eq(socialAccounts.brandId, brandId));
      if (platform) where.push(eq(socialAccounts.platform, platform));
      if (status) where.push(eq(socialAccounts.status, status));
      if (cursor) where.push(lt(socialAccounts.id, cursor));
      const rows = await createDb(c.env.DB)
        .select()
        .from(socialAccounts)
        .where(and(...where))
        .orderBy(desc(socialAccounts.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toSocialAccount, (r) => r.id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/social-accounts",
      tags,
      summary: "Register a social account for a brand",
      description: "Stores metadata only. Credentials arrive with the token vault (Faz 3).",
      request: { body: jsonBody(SocialAccountCreate) },
      responses: {
        201: json(SocialAccount, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, input.brandId);
      const now = new Date();
      const [row] = await db
        .insert(socialAccounts)
        .values({
          id: newId(),
          brandId: input.brandId,
          platform: input.platform,
          handle: input.handle,
          externalId: input.externalId ?? null,
          status: input.status,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new Error("insert returned no row");
      return c.json(toSocialAccount(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/social-accounts/{id}",
      tags,
      summary: "Get a social account",
      request: { params: IdParams },
      responses: { 200: json(SocialAccount, "The account."), 404: errors[404] },
    }),
    async (c) => {
      const row = await requireSocialAccount(createDb(c.env.DB), c.req.valid("param").id);
      return c.json(toSocialAccount(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/social-accounts/{id}",
      tags,
      summary: "Update a social account",
      description: "Accounts are not deleted (schedules reference them); set `status: disabled`.",
      request: { params: IdParams, body: jsonBody(SocialAccountUpdate) },
      responses: {
        200: json(SocialAccount, "Updated."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireSocialAccount(db, id);
      const [row] = await db
        .update(socialAccounts)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(socialAccounts.id, id))
        .returning();
      if (!row) throw notFound("social account", id);
      return c.json(toSocialAccount(row), 200);
    },
  );
