/**
 * Publish details (N13): `PUT /api/contents/{id}/publish-details` and the brand's known
 * Instagram locations (`/api/brands/{id}/publish-locations`).
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  Content,
  EntityId,
  KnownLocationCreate,
  KnownLocationList,
  PublishDetailsPut,
} from "@studio/contract";
import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { createDb } from "../db/client.ts";
import { toContent } from "../db/mappers.ts";
import { assets, contents, publishLocations } from "../db/schema.ts";
import { badRequest, conflict } from "../lib/errors.ts";
import {
  bumpDetailsRevision,
  compactDetails,
  knownLocations,
  rememberLocation,
} from "../lib/publish-details.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";
import { assertNotTrashed, loadContent } from "./contents.ts";

const tags = ["Publish details"];
type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

export const publishDetailRoutes = createRouter()
  .openapi(
    createRoute({
      method: "put",
      path: "/api/contents/{id}/publish-details",
      tags,
      summary: "Replace the post's publish details (first comment, alt texts, location …)",
      description:
        "N13. Does not revoke the approval. Pending schedules get a new details revision so a " +
        "cloud order is pushed again. 409 while the post is publishing or published, or in the " +
        "trash. A Reels cover picture must be an image of the post's brand.",
      request: { params: IdParams, body: jsonBody(PublishDetailsPut) },
      responses: {
        200: json(Content, "The post with its new details."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const loaded = await loadContent(db, id);
      assertNotTrashed(loaded.row);
      if (loaded.row.status === "publishing" || loaded.row.status === "published") {
        throw conflict(
          "Post yayınlanıyor ya da yayınlandı; yayın ayrıntıları artık değiştirilemez.",
        );
      }
      const cover = input.reelCover;
      if (cover?.kind === "image") {
        const asset = await db.query.assets.findFirst({ where: eq(assets.id, cover.assetId) });
        if (!asset || asset.brandId !== loaded.row.brandId || asset.deletedAt) {
          throw badRequest("cover picture not found in this brand", [
            { path: "reelCover.assetId", message: "markanın görsellerinden biri olmalı" },
          ]);
        }
        if (asset.kind !== "image" && asset.kind !== "logo") {
          throw badRequest("the cover must be a picture", [
            { path: "reelCover.assetId", message: "görsel olmalı" },
          ]);
        }
      }
      if (input.reelCover && loaded.row.type !== "reel") {
        throw badRequest("only Reels have a cover", [
          { path: "reelCover", message: "yalnızca Reels için" },
        ]);
      }
      const details = compactDetails(input);
      const now = new Date();
      const stmts: BatchItem<"sqlite">[] = [
        db
          .update(contents)
          .set({ publishDetails: details, updatedAt: now })
          .where(eq(contents.id, id)),
        bumpDetailsRevision(db, id, now),
      ];
      if (details?.location) {
        stmts.push(rememberLocation(db, loaded.row.brandId, details.location, "used", now));
      }
      await db.batch(stmts as Batch);
      const fresh = await loadContent(db, id);
      return c.json(toContent(fresh.row, fresh.current), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{id}/publish-locations",
      tags,
      summary: "Known Instagram locations of a brand (its Pages with an address, entered, used)",
      request: { params: IdParams },
      responses: { 200: json(KnownLocationList, "Locations."), 404: errors[404] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      await requireBrand(db, id);
      return c.json({ items: await knownLocations(db, id) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/brands/{id}/publish-locations",
      tags,
      summary: "Add a location by its Facebook Page id",
      description:
        "Searching every place needs Meta's Page Public Metadata Access; a location is a " +
        "Facebook Page id with an address (from the place's Facebook page) and a name.",
      request: { params: IdParams, body: jsonBody(KnownLocationCreate) },
      responses: {
        200: json(KnownLocationList, "Locations."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, id);
      await rememberLocation(db, id, input, "manual", new Date());
      return c.json({ items: await knownLocations(db, id) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/api/brands/{id}/publish-locations/{locationId}",
      tags,
      summary: "Forget a location",
      request: { params: z.object({ id: EntityId, locationId: z.string().min(1).max(30) }) },
      responses: { 200: json(KnownLocationList, "Locations."), 404: errors[404] },
    }),
    async (c) => {
      const { id, locationId } = c.req.valid("param");
      const db = createDb(c.env.DB);
      await requireBrand(db, id);
      await db
        .delete(publishLocations)
        .where(and(eq(publishLocations.brandId, id), eq(publishLocations.locationId, locationId)));
      return c.json({ items: await knownLocations(db, id) }, 200);
    },
  );
