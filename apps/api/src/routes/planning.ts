import { createRoute, z } from "@hono/zod-openapi";
import {
  BrandPlanningSettings,
  BrandPlanningSettingsPut,
  EntityId,
  PlanningContext,
  PlanningContextQuery,
  SpecialDayList,
  SpecialDayOverrides,
  SpecialDayOverridesPut,
  SpecialDaysQuery,
} from "@studio/contract";
import { createDb } from "../db/client.ts";
import {
  loadOverrides,
  loadPlanningSettings,
  planningContext,
  saveOverrides,
  savePlanningSettings,
  specialDayList,
} from "../lib/planning.ts";
import { createRouter, errors, json, jsonBody } from "../lib/router.ts";
import { requireBrand } from "./brands.ts";

/**
 * Planning context (N5, N6): Türkiye's special days (per brand: its sector tags and switched-off
 * categories), the owner's bayram date corrections, and what the plan agent reads before planning
 * a period (special days + the brand's history of the last three months).
 */

const tags = ["Planning"];
const BrandParams = z.object({ brandId: EntityId });

export const planningRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/planning-settings",
      tags: ["Brands"],
      summary: "The brand's special-day settings",
      description:
        "Sector tags and switched-off categories; defaults (`updatedAt: null`) with tags " +
        "suggested from the profile and products until saved once.",
      request: { params: BrandParams },
      responses: { 200: json(BrandPlanningSettings, "The settings."), 404: errors[404] },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      return c.json(await loadPlanningSettings(db, brandId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/brands/{brandId}/planning-settings",
      tags: ["Brands"],
      summary: "Replace the brand's special-day settings",
      request: { params: BrandParams, body: jsonBody(BrandPlanningSettingsPut) },
      responses: {
        200: json(BrandPlanningSettings, "Saved."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      return c.json(await savePlanningSettings(db, brandId, input), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/brands/{brandId}/planning-context",
      tags,
      summary: "What the plan agent reads before planning a period",
      description:
        "The period's special days for this brand, its settings, and its history from the " +
        "first day of the month three months before the period to the period's end.",
      request: { params: BrandParams, query: PlanningContextQuery },
      responses: {
        200: json(PlanningContext, "The context."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { brandId } = c.req.valid("param");
      const query = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireBrand(db, brandId);
      return c.json(await planningContext(db, brandId, query), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/special-days",
      tags,
      summary: "Special days between two dates",
      description:
        "Türkiye's public holidays, religious, remembrance, commercial and social days; with " +
        "`brandId` the brand's sector days and settings apply (otherwise no sector days).",
      request: { query: SpecialDaysQuery },
      responses: { 200: json(SpecialDayList, "The days."), 400: errors[400], 404: errors[404] },
    }),
    async (c) => {
      const { from, to, brandId } = c.req.valid("query");
      const db = createDb(c.env.DB);
      if (brandId) await requireBrand(db, brandId);
      return c.json(await specialDayList(db, from, to, brandId), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/special-days/overrides",
      tags,
      summary: "Bayram date corrections",
      description: "Per year, the first day of Ramazan / Kurban Bayramı where it differs.",
      responses: { 200: json(SpecialDayOverrides, "The corrections.") },
    }),
    async (c) => c.json(await loadOverrides(createDb(c.env.DB)), 200),
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/special-days/overrides",
      tags,
      summary: "Replace the bayram date corrections",
      request: { body: jsonBody(SpecialDayOverridesPut) },
      responses: { 200: json(SpecialDayOverrides, "Saved."), 400: errors[400] },
    }),
    async (c) => {
      const { overrides } = c.req.valid("json");
      return c.json(await saveOverrides(createDb(c.env.DB), overrides), 200);
    },
  );
