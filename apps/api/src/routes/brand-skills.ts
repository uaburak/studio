import { createRoute, z } from "@hono/zod-openapi";
import {
  BrandSkill,
  BrandSkillCreate,
  BrandSkillList,
  BrandSkillListQuery,
  type BrandSkillOrigin,
  BrandSkillUpdate,
  BrandSkillVersion,
  BrandSkillVersionList,
  BrandSkillVersionListQuery,
  EntityId,
  MAX_BRAND_SKILLS,
  SkillVersionNumber,
} from "@studio/contract";
import { and, asc, count, desc, eq, gt, lt, ne, type SQL } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { brandSkills, brandSkillVersions } from "../db/schema.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { toPage } from "../lib/pagination.ts";
import { createRouter, errors, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";

/**
 * Brand skills (Marka Kiti → Skill'ler): Markdown instructions the agent follows for one brand
 * (formats with pixel layouts, tone, do / don't). Versioned: a change of name, description or
 * body appends a version and copies it to the skill row; `enabled` alone does not. Restoring an
 * old version appends a copy of it (origin `restore`). Deleting a skill deletes its versions.
 * Chat turns get the enabled ones in their context (`TurnContext.brandSkills`), generations
 * read them through this API.
 */

const tags = ["Brands"];

const BrandParams = z.object({ brandId: EntityId });
const SkillParams = z.object({ brandId: EntityId, skillId: EntityId });
const VersionParams = z.object({
  brandId: EntityId,
  skillId: EntityId,
  version: SkillVersionNumber,
});

type SkillRow = typeof brandSkills.$inferSelect;
type SkillVersionRow = typeof brandSkillVersions.$inferSelect;

const iso = (d: Date) => d.toISOString();

export function toBrandSkill(r: SkillRow): BrandSkill {
  return {
    id: r.id,
    brandId: r.brandId,
    name: r.name,
    description: r.description,
    body: r.body,
    enabled: r.enabled,
    version: r.version,
    origin: r.origin,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
  };
}

export function toBrandSkillVersion(r: SkillVersionRow): BrandSkillVersion {
  return {
    id: r.id,
    skillId: r.skillId,
    brandId: r.brandId,
    version: r.version,
    name: r.name,
    description: r.description,
    body: r.body,
    origin: r.origin,
    note: r.note,
    jobId: r.jobId,
    createdAt: iso(r.createdAt),
  };
}

/**
 * The brand's enabled skills (current versions), by name: what a chat turn of the brand gets.
 * Skills are extra context, never a reason to fail a turn: a database without the skills
 * tables yet (migration pending until the next app start) or any other read error gives none.
 */
export async function enabledBrandSkills(db: Db, brandId: string): Promise<BrandSkill[]> {
  try {
    const rows = await db
      .select()
      .from(brandSkills)
      .where(and(eq(brandSkills.brandId, brandId), eq(brandSkills.enabled, true)))
      .orderBy(asc(brandSkills.name));
    return rows.map(toBrandSkill);
  } catch (error) {
    const cause = (error as { cause?: { message?: string } })?.cause?.message ?? "";
    console.warn(`brand skills unavailable: ${(error as Error)?.message ?? error} ${cause}`.trim());
    return [];
  }
}

async function requireSkill(db: Db, brandId: string, skillId: string): Promise<SkillRow> {
  const row = await db.query.brandSkills.findFirst({
    where: and(eq(brandSkills.id, skillId), eq(brandSkills.brandId, brandId)),
  });
  if (!row) throw notFound(`brand ${brandId} skill`, skillId);
  return row;
}

async function assertNameFree(db: Db, brandId: string, name: string, exceptId?: string) {
  const where: SQL[] = [eq(brandSkills.brandId, brandId), eq(brandSkills.name, name)];
  if (exceptId) where.push(ne(brandSkills.id, exceptId));
  const row = await db
    .select({ id: brandSkills.id })
    .from(brandSkills)
    .where(and(...where))
    .get();
  if (row) throw conflict(`a skill named "${name}" already exists for this brand`);
}

/** Append a version with this text and make it the skill's current one (one transaction). */
async function appendVersion(
  db: Db,
  current: SkillRow,
  next: {
    name: string;
    description: string;
    body: string;
    origin: BrandSkillOrigin;
    note: string;
    enabled?: boolean;
  },
): Promise<SkillRow> {
  const now = new Date();
  const version = current.version + 1;
  const [, rows] = await db.batch([
    db.insert(brandSkillVersions).values({
      id: newId(),
      skillId: current.id,
      brandId: current.brandId,
      version,
      name: next.name,
      description: next.description,
      body: next.body,
      origin: next.origin,
      note: next.note,
      createdAt: now,
    }),
    db
      .update(brandSkills)
      .set({
        name: next.name,
        description: next.description,
        body: next.body,
        origin: next.origin,
        version,
        ...(next.enabled !== undefined ? { enabled: next.enabled } : {}),
        updatedAt: now,
      })
      .where(and(eq(brandSkills.id, current.id), eq(brandSkills.version, current.version)))
      .returning(),
  ]);
  const row = rows[0];
  // Another edit stored this version number first.
  if (!row) throw conflict("the skill was changed meanwhile; reload and try again");
  return row;
}

export const brandSkillRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/skills",
      tags,
      summary: "List the brand's skills (oldest first)",
      request: { params: BrandParams, query: BrandSkillListQuery },
      responses: {
        200: json(BrandSkillList, "A page of skills."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const { limit, cursor } = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      const where: SQL[] = [eq(brandSkills.brandId, brandId)];
      if (cursor) where.push(gt(brandSkills.id, cursor));
      const rows = await db
        .select()
        .from(brandSkills)
        .where(and(...where))
        .orderBy(asc(brandSkills.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toBrandSkill, (r) => r.id),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/brands/{brandId}/skills",
      tags,
      summary: "Add a skill (version 1)",
      description: `Names are unique per brand (409); at most ${MAX_BRAND_SKILLS} skills per brand.`,
      request: { params: BrandParams, body: jsonBody(BrandSkillCreate) },
      responses: {
        201: json(BrandSkill, "Created."),
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
      const [counted] = await db
        .select({ n: count() })
        .from(brandSkills)
        .where(eq(brandSkills.brandId, brandId));
      if ((counted?.n ?? 0) >= MAX_BRAND_SKILLS) {
        throw badRequest(`a brand can have at most ${MAX_BRAND_SKILLS} skills`);
      }
      await assertNameFree(db, brandId, input.name);
      const now = new Date();
      const id = newId();
      const [rows] = await db.batch([
        db
          .insert(brandSkills)
          .values({
            id,
            brandId,
            name: input.name,
            description: input.description,
            body: input.body,
            enabled: input.enabled,
            version: 1,
            origin: input.origin,
            createdAt: now,
            updatedAt: now,
          })
          .returning(),
        db.insert(brandSkillVersions).values({
          id: newId(),
          skillId: id,
          brandId,
          version: 1,
          name: input.name,
          description: input.description,
          body: input.body,
          origin: input.origin,
          note: input.note,
          jobId: input.jobId ?? null,
          createdAt: now,
        }),
      ]);
      const row = rows[0];
      if (!row) throw new Error("insert returned no row");
      return c.json(toBrandSkill(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/skills/{skillId}",
      tags,
      summary: "Get one skill (current version)",
      request: { params: SkillParams },
      responses: { 200: json(BrandSkill, "The skill."), 404: errors[404] },
    }),
    async (c) => {
      const { brandId, skillId } = c.req.valid("param");
      const row = await requireSkill(createDb(c.env.DB), brandId, skillId);
      return c.json(toBrandSkill(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/brands/{brandId}/skills/{skillId}",
      tags,
      summary: "Edit a skill",
      description:
        "A changed name, description or body stores a new version (`note` is kept with it); " +
        "`enabled` alone only switches the skill on or off.",
      request: { params: SkillParams, body: jsonBody(BrandSkillUpdate) },
      responses: {
        200: json(BrandSkill, "Updated."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { brandId, skillId } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const current = await requireSkill(db, brandId, skillId);
      const next = {
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        body: input.body ?? current.body,
      };
      const textChanged =
        next.name !== current.name ||
        next.description !== current.description ||
        next.body !== current.body;
      if (next.name !== current.name) await assertNameFree(db, brandId, next.name, current.id);
      if (textChanged) {
        const row = await appendVersion(db, current, {
          ...next,
          origin: "manual",
          note: input.note ?? "",
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        });
        return c.json(toBrandSkill(row), 200);
      }
      if (input.enabled !== undefined && input.enabled !== current.enabled) {
        const [row] = await db
          .update(brandSkills)
          .set({ enabled: input.enabled, updatedAt: new Date() })
          .where(eq(brandSkills.id, current.id))
          .returning();
        if (!row) throw notFound(`brand ${brandId} skill`, skillId);
        return c.json(toBrandSkill(row), 200);
      }
      return c.json(toBrandSkill(current), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/api/brands/{brandId}/skills/{skillId}",
      tags,
      summary: "Delete a skill and its versions",
      request: { params: SkillParams },
      responses: { 204: { description: "Deleted." }, 404: errors[404] },
    }),
    async (c) => {
      const { brandId, skillId } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const current = await requireSkill(db, brandId, skillId);
      await db.batch([
        db.delete(brandSkillVersions).where(eq(brandSkillVersions.skillId, current.id)),
        db.delete(brandSkills).where(eq(brandSkills.id, current.id)),
      ]);
      return c.body(null, 204);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/skills/{skillId}/versions",
      tags,
      summary: "The skill's versions (newest first)",
      request: { params: SkillParams, query: BrandSkillVersionListQuery },
      responses: {
        200: json(BrandSkillVersionList, "A page of versions."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId, skillId } = c.req.valid("param");
      const { limit, cursor } = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireSkill(db, brandId, skillId);
      const where: SQL[] = [eq(brandSkillVersions.skillId, skillId)];
      const before = cursor ? Number.parseInt(cursor, 10) : Number.NaN;
      if (Number.isFinite(before)) where.push(lt(brandSkillVersions.version, before));
      const rows = await db
        .select()
        .from(brandSkillVersions)
        .where(and(...where))
        .orderBy(desc(brandSkillVersions.version))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toBrandSkillVersion, (r) => String(r.version)),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/skills/{skillId}/versions/{version}",
      tags,
      summary: "One version of a skill",
      request: { params: VersionParams },
      responses: { 200: json(BrandSkillVersion, "The version."), 404: errors[404] },
    }),
    async (c) => {
      const { brandId, skillId, version } = c.req.valid("param");
      const db = createDb(c.env.DB);
      await requireSkill(db, brandId, skillId);
      const row = await db.query.brandSkillVersions.findFirst({
        where: and(
          eq(brandSkillVersions.skillId, skillId),
          eq(brandSkillVersions.version, version),
        ),
      });
      if (!row) throw notFound(`skill ${skillId} version`, version);
      return c.json(toBrandSkillVersion(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/brands/{brandId}/skills/{skillId}/versions/{version}/restore",
      tags,
      summary: "Bring an older version back",
      description:
        "Stores that version's name, description and body as a new current version " +
        "(origin `restore`). Restoring the current version changes nothing.",
      request: { params: VersionParams },
      responses: {
        200: json(BrandSkill, "Restored."),
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { brandId, skillId, version } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const current = await requireSkill(db, brandId, skillId);
      const old = await db.query.brandSkillVersions.findFirst({
        where: and(
          eq(brandSkillVersions.skillId, skillId),
          eq(brandSkillVersions.version, version),
        ),
      });
      if (!old) throw notFound(`skill ${skillId} version`, version);
      if (version === current.version) return c.json(toBrandSkill(current), 200);
      if (old.name !== current.name) await assertNameFree(db, brandId, old.name, current.id);
      const row = await appendVersion(db, current, {
        name: old.name,
        description: old.description,
        body: old.body,
        origin: "restore",
        note: `v${old.version} geri yüklendi`,
      });
      return c.json(toBrandSkill(row), 200);
    },
  );
