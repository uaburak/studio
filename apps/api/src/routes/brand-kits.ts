import { createRoute, z } from "@hono/zod-openapi";
import { type AssetKind, BrandKit, BrandKitPut, EntityId, emptyBrandKit } from "@studio/contract";
import { and, eq, inArray } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { assets } from "../db/schema.ts";
import { badRequest } from "../lib/errors.ts";
import { createRouter, errors, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";

/**
 * The brand kit (P2): the user's logos (with the background they are made for),
 * fonts (family + licence note), palette, sample posts and notes. `brand.analyze`
 * reads it to extract a draft profile.
 *
 * Stored as one small JSON document per brand in the MEDIA bucket next to the
 * brand's files (`brands/{brandId}/kit.json`): it is read and replaced as a
 * whole, never queried, and keeping it out of D1 needs no migration. Every
 * referenced file must be an asset of the same brand with a fitting kind.
 */

const tags = ["Brands"];

const BrandIdParams = z.object({ brandId: EntityId });

export function brandKitKey(brandId: string): string {
  return `brands/${brandId}/kit.json`;
}

/** Kinds each kit list may reference. */
const KIT_KINDS: Record<"logos" | "fonts" | "samples", readonly AssetKind[]> = {
  logos: ["logo", "image"],
  fonts: ["font"],
  samples: ["image"],
};

export async function readBrandKit(bucket: R2Bucket, brandId: string): Promise<BrandKit> {
  const object = await bucket.get(brandKitKey(brandId));
  if (!object) return emptyBrandKit(brandId);
  const parsed = BrandKit.safeParse({ ...(await object.json<object>()), brandId });
  // A stored kit that no longer parses (schema moved on) is treated as empty
  // rather than failing every read; the next PUT replaces it.
  return parsed.success ? parsed.data : emptyBrandKit(brandId);
}

export const brandKitRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/kit",
      tags,
      summary: "The brand kit (logos, fonts, palette, sample posts, notes)",
      description: "An empty kit with `updatedAt: null` until it was saved once.",
      request: { params: BrandIdParams },
      responses: { 200: json(BrandKit, "The kit."), 404: errors[404] },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      await requireBrand(createDb(c.env.DB), brandId);
      return c.json(await readBrandKit(c.env.MEDIA, brandId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/brands/{brandId}/kit",
      tags,
      summary: "Replace the brand kit",
      description:
        "Every referenced file must be an asset of this brand: logos `logo`/`image`, fonts `font`, " +
        "samples `image`. Order is kept (the first logo is the primary one).",
      request: { params: BrandIdParams, body: jsonBody(BrandKitPut) },
      responses: { 200: json(BrandKit, "Saved."), 400: errors[400], 404: errors[404] },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);

      const refs: { list: keyof typeof KIT_KINDS; index: number; assetId: string }[] = [
        ...input.logos.map((l, index) => ({ list: "logos" as const, index, assetId: l.assetId })),
        ...input.fonts.map((f, index) => ({ list: "fonts" as const, index, assetId: f.assetId })),
        ...input.samples.map((s, index) => ({
          list: "samples" as const,
          index,
          assetId: s.assetId,
        })),
      ];
      const ids = [...new Set(refs.map((r) => r.assetId))];
      const rows = ids.length
        ? await db
            .select({ id: assets.id, kind: assets.kind })
            .from(assets)
            .where(and(eq(assets.brandId, brandId), inArray(assets.id, ids)))
        : [];
      const kindById = new Map(rows.map((r) => [r.id, r.kind as AssetKind]));
      const issues = refs.flatMap((r) => {
        const kind = kindById.get(r.assetId);
        const path = `${r.list}.${r.index}.assetId`;
        if (!kind) return [{ path, message: "not an asset of this brand" }];
        if (!KIT_KINDS[r.list].includes(kind)) {
          return [{ path, message: `asset kind ${kind} is not allowed here` }];
        }
        return [];
      });
      if (issues.length > 0) throw badRequest("the kit references unusable files", issues);

      const kit: BrandKit = {
        brandId,
        logos: input.logos,
        fonts: input.fonts,
        palette: input.palette.map((p) => ({ ...p, hex: p.hex.toUpperCase() })),
        samples: input.samples,
        notes: input.notes,
        updatedAt: new Date().toISOString(),
      };
      await c.env.MEDIA.put(brandKitKey(brandId), JSON.stringify(kit), {
        httpMetadata: { contentType: "application/json" },
      });
      return c.json(kit, 200);
    },
  );
