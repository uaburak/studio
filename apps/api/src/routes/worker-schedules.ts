import { createRoute } from "@hono/zod-openapi";
import {
  type ContentStatus,
  Schedule,
  WorkerDueSchedules,
  WorkerDueSchedulesQuery,
  WorkerScheduleCredentials,
  WorkerScheduleDelivery,
  WorkerScheduleOutcome,
} from "@studio/contract";
import { and, asc, eq, gte, isNotNull, lte, ne, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";
import { createDb, type Db } from "../db/client.ts";
import { toContent, toSchedule, toSocialAccount, toVersion } from "../db/mappers.ts";
import {
  contents,
  contentVersionSlides,
  contentVersions,
  publishLogs,
  schedules,
  socialAccounts,
  socialAccountTokens,
} from "../db/schema.ts";
import { ApiProblem, invalidTransition, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireWorkerToken } from "../middleware/worker-auth.ts";
import { approvalMatchesCurrent, loadContent } from "./contents.ts";
import { loadSocialAccountWithToken, readAccountToken } from "./social-accounts.ts";

const tags = ["Worker schedules"];
const security = [{ workerToken: [] }];
const unauthorized = { description: "Missing or wrong worker token (plain text)." };

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

async function requireSchedule(db: Db, id: string) {
  const row = await db.query.schedules.findFirst({ where: eq(schedules.id, id) });
  if (!row) throw notFound("schedule", id);
  return row;
}

export function deriveContentStatusAfterOutcome(
  currentStatus: ContentStatus,
  outcomeStatus: "publishing" | "published" | "failed",
  otherSchedules: ReadonlyArray<{ status: string }>,
): ContentStatus {
  if (outcomeStatus === "publishing") {
    return currentStatus === "published" ? "published" : "publishing";
  }
  const activeOthers = otherSchedules.filter((s) => s.status !== "cancelled");
  if (activeOthers.some((s) => s.status === "publishing")) return "publishing";
  if (activeOthers.some((s) => s.status === "pending")) return "scheduled";
  if (outcomeStatus === "failed" || activeOthers.some((s) => s.status === "failed")) {
    return "failed";
  }
  return "published";
}

/**
 * The publish log row an outcome belongs to. A retried schedule (failed, then scheduled
 * again: same id) starts counting from 1 again on the worker, but its earlier attempts are
 * already in the log: while the schedule is back in `pending`/`publishing`, a reported attempt
 * number that already finished belongs to the earlier round, so the outcome goes to the
 * newest unfinished attempt, or to a new one after the last.
 */
export async function logAttempt(
  db: Db,
  schedule: { id: string; status: string },
  reported: number,
): Promise<number> {
  if (schedule.status !== "pending" && schedule.status !== "publishing") return reported;
  const logs = await db
    .select({ attempt: publishLogs.attempt, finishedAt: publishLogs.finishedAt })
    .from(publishLogs)
    .where(eq(publishLogs.scheduleId, schedule.id));
  const same = logs.find((l) => l.attempt === reported);
  if (!same?.finishedAt) return reported;
  const latest = logs.reduce((a, b) => (b.attempt > a.attempt ? b : a));
  return latest.finishedAt ? latest.attempt + 1 : latest.attempt;
}

export const workerScheduleRoutes = createRouter();

workerScheduleRoutes.use("/api/worker/*", requireWorkerToken);

workerScheduleRoutes
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/schedules/due",
      tags,
      security,
      summary: "List pending schedules (optionally due at or before `before`)",
      request: { query: WorkerDueSchedulesQuery },
      responses: {
        200: json(WorkerDueSchedules, "Pending schedules ordered by scheduled time."),
        400: errors[400],
        401: unauthorized,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const where: SQL[] = [eq(schedules.status, "pending")];
      if (q.before) {
        where.push(lte(schedules.scheduledAt, new Date(q.before)));
      }
      const rows = await createDb(c.env.DB)
        .select()
        .from(schedules)
        .where(and(...where))
        .orderBy(asc(schedules.scheduledAt), asc(schedules.id))
        .limit(q.limit);
      return c.json({ items: rows.map(toSchedule) }, 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/schedules/{id}/credentials",
      tags,
      security,
      summary: "Load schedule, content, version slides and decrypted token for publishing",
      request: { params: IdParams },
      responses: {
        200: json(WorkerScheduleCredentials, "Full publishing bundle with decrypted access token."),
        401: unauthorized,
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const db = createDb(c.env.DB);
      const schedule = await requireSchedule(db, id);
      const { account, token } = await loadSocialAccountWithToken(db, schedule.socialAccountId);
      const loadedContent = await loadContent(db, schedule.contentId);

      if (
        !approvalMatchesCurrent(loadedContent) ||
        loadedContent.row.approvedVersionId !== schedule.versionId ||
        loadedContent.row.approvedHash !== schedule.contentHash
      ) {
        throw new ApiProblem(
          "hash_mismatch",
          "content approval no longer matches the frozen schedule version",
        );
      }

      const versionRow = await db.query.contentVersions.findFirst({
        where: eq(contentVersions.id, schedule.versionId),
      });
      if (!versionRow) throw notFound("content version", schedule.versionId);

      const slides = await db
        .select()
        .from(contentVersionSlides)
        .where(eq(contentVersionSlides.versionId, versionRow.id))
        .orderBy(asc(contentVersionSlides.position));

      const accessToken = token ? await readAccountToken(db, c.env, token) : null;

      return c.json(
        {
          schedule: toSchedule(schedule),
          account: toSocialAccount(account, token),
          content: toContent(loadedContent.row, loadedContent.current),
          version: toVersion(versionRow, slides),
          accessToken,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/schedules/{id}/outcome",
      tags,
      security,
      summary: "Record publishing progress or final outcome for a schedule",
      request: { params: IdParams, body: jsonBody(WorkerScheduleOutcome) },
      responses: {
        200: json(Schedule, "Updated schedule."),
        400: errors[400],
        401: unauthorized,
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const schedule = await requireSchedule(db, id);

      if (schedule.status === "cancelled") {
        throw invalidTransition("schedule was cancelled");
      }
      if (schedule.status === "published") {
        if (input.status === "published") return c.json(toSchedule(schedule), 200);
        throw invalidTransition("schedule is already published");
      }

      const loadedContent = await loadContent(db, schedule.contentId);
      const siblingSchedules = await db
        .select({ status: schedules.status })
        .from(schedules)
        .where(and(eq(schedules.contentId, schedule.contentId), ne(schedules.id, id)));

      const nextContentStatus = deriveContentStatusAfterOutcome(
        loadedContent.row.status,
        input.status,
        siblingSchedules,
      );

      const attempt = await logAttempt(db, schedule, input.attempt);
      const now = new Date();
      const logStatus =
        input.status === "publishing"
          ? "started"
          : input.status === "published"
            ? "succeeded"
            : "failed";
      const finishedAt = input.status === "publishing" ? null : now;

      const stmts: BatchItem<"sqlite">[] = [
        db
          .update(schedules)
          .set({
            status: input.status,
            ...(input.permalink !== undefined ? { permalink: input.permalink } : {}),
            ...(input.status === "failed"
              ? { lastError: input.error ?? "Yayın başarısız oldu." }
              : input.status === "published"
                ? { lastError: null }
                : {}),
            updatedAt: now,
          })
          .where(eq(schedules.id, id)),
        db
          .insert(publishLogs)
          .values({
            id: newId(),
            scheduleId: id,
            attempt,
            status: logStatus,
            externalPostId: input.externalPostId ?? null,
            permalink: input.permalink ?? null,
            error: input.error ?? null,
            startedAt: now,
            finishedAt,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: [publishLogs.scheduleId, publishLogs.attempt],
            set: {
              status: logStatus,
              ...(input.externalPostId !== undefined
                ? { externalPostId: input.externalPostId }
                : {}),
              ...(input.permalink !== undefined ? { permalink: input.permalink } : {}),
              ...(input.error !== undefined ? { error: input.error } : {}),
              finishedAt,
            },
          }),
        db
          .update(contents)
          .set({ status: nextContentStatus, updatedAt: now })
          .where(eq(contents.id, schedule.contentId)),
      ];

      if (input.accountNeedsReauth) {
        stmts.push(
          db
            .update(socialAccounts)
            .set({ status: "needs_reauth", updatedAt: now })
            .where(
              and(
                eq(socialAccounts.id, schedule.socialAccountId),
                ne(socialAccounts.status, "disabled"),
              ),
            ),
          db
            .update(socialAccountTokens)
            .set({ health: "invalid", checkedAt: now, updatedAt: now })
            .where(eq(socialAccountTokens.socialAccountId, schedule.socialAccountId)),
        );
      }

      await db.batch(stmts as Batch);
      return c.json(toSchedule(await requireSchedule(db, id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/schedules/{id}/delivery",
      tags,
      security,
      summary: "Record who publishes a schedule (cloud push result, or local)",
      request: { params: IdParams, body: jsonBody(WorkerScheduleDelivery) },
      responses: {
        200: json(Schedule, "Updated schedule."),
        400: errors[400],
        401: unauthorized,
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireSchedule(db, id);
      await db
        .update(schedules)
        .set({
          delivery: input.delivery,
          ...(input.cloudSyncedAt !== undefined
            ? { cloudSyncedAt: input.cloudSyncedAt ? new Date(input.cloudSyncedAt) : null }
            : {}),
          ...(input.error !== undefined ? { lastError: input.error } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schedules.id, id));
      return c.json(toSchedule(await requireSchedule(db, id)), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/schedules/cancelled",
      tags,
      security,
      summary: "Cancelled schedules whose order is still at the cloud publisher",
      description:
        "`delivery = cloud` and `cloudSyncedAt` set: the worker cancels the order there and " +
        "reports `cloudSyncedAt: null`.",
      request: {
        query: z.object({
          since: z.string().datetime({ offset: true }).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        }),
      },
      responses: {
        200: json(WorkerDueSchedules, "Schedules to cancel at the cloud."),
        400: errors[400],
        401: unauthorized,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const where: SQL[] = [
        eq(schedules.status, "cancelled"),
        eq(schedules.delivery, "cloud"),
        isNotNull(schedules.cloudSyncedAt),
      ];
      if (q.since) where.push(gte(schedules.updatedAt, new Date(q.since)));
      const rows = await createDb(c.env.DB)
        .select()
        .from(schedules)
        .where(and(...where))
        .orderBy(asc(schedules.updatedAt))
        .limit(q.limit);
      return c.json({ items: rows.map(toSchedule) }, 200);
    },
  );
