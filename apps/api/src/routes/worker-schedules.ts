import { createRoute } from "@hono/zod-openapi";
import {
  type ContentStatus,
  Schedule,
  WorkerDueSchedules,
  WorkerDueSchedulesQuery,
  WorkerScheduleCredentials,
  WorkerScheduleOutcome,
} from "@studio/contract";
import { and, asc, eq, lte, ne, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
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
import { decryptAccountToken } from "../lib/token-vault.ts";
import { requireWorkerToken } from "../middleware/worker-auth.ts";
import { approvalMatchesCurrent, loadContent } from "./contents.ts";
import { loadSocialAccountWithToken } from "./social-accounts.ts";

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

      const accessToken = token
        ? await decryptAccountToken(c.env, account.id, token.ciphertext, token.iv)
        : null;

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
            updatedAt: now,
          })
          .where(eq(schedules.id, id)),
        db
          .insert(publishLogs)
          .values({
            id: newId(),
            scheduleId: id,
            attempt: input.attempt,
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
  );
