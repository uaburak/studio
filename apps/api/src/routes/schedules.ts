import { createRoute } from "@hono/zod-openapi";
import {
  ACTIVE_SCHEDULE_STATUSES,
  PublishLogList,
  PublishLogListQuery,
  SCHEDULABLE_STATUSES,
  Schedule,
  ScheduleCreate,
  ScheduleList,
  ScheduleListQuery,
  statusIn,
} from "@studio/contract";
import { and, asc, eq, gt, gte, inArray, lt, ne, notExists, or, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { createDb, type Db } from "../db/client.ts";
import { toPublishLog, toSchedule } from "../db/mappers.ts";
import { contents, publishLogs, schedules } from "../db/schema.ts";
import { ApiProblem, badRequest, conflict, invalidTransition, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { decodeTimeCursor, encodeTimeCursor, toPage } from "../lib/pagination.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { approvalMatchesCurrent, loadContent } from "./contents.ts";
import { requireSocialAccount } from "./social-accounts.ts";

const tags = ["Schedules"];

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

async function requireSchedule(db: Db, id: string) {
  const row = await db.query.schedules.findFirst({ where: eq(schedules.id, id) });
  if (!row) throw notFound("schedule", id);
  return row;
}

export const scheduleRoutes = createRouter()
  .openapi(
    createRoute({
      method: "get",
      path: "/api/schedules",
      tags,
      summary: "List schedules (by scheduled time, earliest first)",
      request: { query: ScheduleListQuery },
      responses: { 200: json(ScheduleList, "A page of schedules."), 400: errors[400] },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const where: SQL[] = [];
      if (q.brandId) where.push(eq(schedules.brandId, q.brandId));
      if (q.contentId) where.push(eq(schedules.contentId, q.contentId));
      if (q.socialAccountId) where.push(eq(schedules.socialAccountId, q.socialAccountId));
      if (q.status) where.push(eq(schedules.status, q.status));
      if (q.from) where.push(gte(schedules.scheduledAt, new Date(q.from)));
      if (q.to) where.push(lt(schedules.scheduledAt, new Date(q.to)));
      if (q.cursor) {
        const cur = decodeTimeCursor(q.cursor);
        if (!cur) throw badRequest("invalid cursor", [{ path: "cursor", message: "malformed" }]);
        const at = new Date(cur.ms);
        const after = or(
          gt(schedules.scheduledAt, at),
          and(eq(schedules.scheduledAt, at), gt(schedules.id, cur.id)),
        );
        if (after) where.push(after);
      }
      const rows = await createDb(c.env.DB)
        .select()
        .from(schedules)
        .where(and(...where))
        .orderBy(asc(schedules.scheduledAt), asc(schedules.id))
        .limit(q.limit + 1);
      return c.json(
        toPage(rows, q.limit, toSchedule, (r) => encodeTimeCursor(r.scheduledAt.getTime(), r.id)),
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/schedules",
      tags,
      summary: "Schedule approved content on one social account",
      description:
        "The content must be approved (or already scheduled / failed) and its approval must " +
        "still match the current version; the schedule freezes that version and hash. The " +
        "account must belong to the content's brand, not be disabled, and its platform must " +
        "be one of the content's target platforms. Moves the content to `scheduled`.",
      request: { body: jsonBody(ScheduleCreate) },
      responses: {
        201: json(Schedule, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const loaded = await loadContent(db, input.contentId);
      const { row: content } = loaded;
      const account = await requireSocialAccount(db, input.socialAccountId);

      const platform = input.platform ?? account.platform;
      if (platform !== account.platform) {
        throw badRequest(`account ${account.id} is a ${account.platform} account`, [
          { path: "platform", message: `must be ${account.platform}` },
        ]);
      }
      const scheduledAt = new Date(input.scheduledAt);
      if (scheduledAt.getTime() <= Date.now()) {
        throw badRequest("scheduledAt must be in the future", [
          { path: "scheduledAt", message: "in the past" },
        ]);
      }
      if (account.brandId !== content.brandId) {
        throw conflict("the social account belongs to a different brand");
      }
      if (account.status === "disabled") throw conflict(`social account ${account.id} is disabled`);
      if (!content.targetPlatforms.includes(platform)) {
        throw conflict(`${platform} is not one of the content's target platforms`);
      }
      if (!statusIn(content.status, SCHEDULABLE_STATUSES)) {
        throw invalidTransition(
          `content is ${content.status}; only approved content can be scheduled`,
        );
      }
      if (!approvalMatchesCurrent(loaded) || !loaded.current) {
        throw new ApiProblem("hash_mismatch", "the approval does not match the current version");
      }

      const now = new Date();
      const id = newId();
      await db.batch([
        db.insert(schedules).values({
          id,
          contentId: content.id,
          brandId: content.brandId,
          platform,
          socialAccountId: account.id,
          versionId: loaded.current.id,
          contentHash: loaded.current.contentHash,
          scheduledAt,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        }),
        db
          .update(contents)
          .set({ status: "scheduled", updatedAt: now })
          .where(and(eq(contents.id, content.id), eq(contents.status, content.status))),
      ]);
      return c.json(toSchedule(await requireSchedule(db, id)), 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/schedules/{id}",
      tags,
      summary: "Get a schedule",
      request: { params: IdParams },
      responses: { 200: json(Schedule, "The schedule."), 404: errors[404] },
    }),
    async (c) => {
      const row = await requireSchedule(createDb(c.env.DB), c.req.valid("param").id);
      return c.json(toSchedule(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/schedules/{id}/cancel",
      tags,
      summary: "Cancel a pending schedule",
      description:
        "Only `pending` schedules can be cancelled. When the content has no other active " +
        "schedule it returns from `scheduled` to `approved`.",
      request: { params: IdParams },
      responses: { 200: json(Schedule, "Cancelled."), 404: errors[404], 409: errors[409] },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const schedule = await requireSchedule(db, id);
      if (schedule.status !== "pending") {
        throw invalidTransition(
          `schedule is ${schedule.status}; only pending schedules can be cancelled`,
        );
      }
      const now = new Date();
      const stmts: Batch = [
        db
          .update(schedules)
          .set({ status: "cancelled", cancelledAt: now, updatedAt: now })
          .where(and(eq(schedules.id, id), eq(schedules.status, "pending"))),
        db
          .update(contents)
          .set({ status: "approved", updatedAt: now })
          .where(
            and(
              eq(contents.id, schedule.contentId),
              eq(contents.status, "scheduled"),
              notExists(
                db
                  .select({ id: schedules.id })
                  .from(schedules)
                  .where(
                    and(
                      eq(schedules.contentId, schedule.contentId),
                      ne(schedules.id, id),
                      inArray(schedules.status, [...ACTIVE_SCHEDULE_STATUSES]),
                    ),
                  ),
              ),
            ),
          ),
      ];
      await db.batch(stmts);
      return c.json(toSchedule(await requireSchedule(db, id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/schedules/{id}/logs",
      tags,
      summary: "List publish attempts for a schedule (oldest first)",
      request: { params: IdParams, query: PublishLogListQuery },
      responses: {
        200: json(PublishLogList, "A page of publish log entries."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { limit, cursor } = c.req.valid("query");
      const db = createDb(c.env.DB);
      await requireSchedule(db, id);
      const where: SQL[] = [eq(publishLogs.scheduleId, id)];
      if (cursor) where.push(gt(publishLogs.id, cursor));
      const rows = await db
        .select()
        .from(publishLogs)
        .where(and(...where))
        .orderBy(asc(publishLogs.id))
        .limit(limit + 1);
      return c.json(
        toPage(rows, limit, toPublishLog, (r) => r.id),
        200,
      );
    },
  );
