import { createRoute } from "@hono/zod-openapi";
import {
  type ContentStatus,
  missedScheduleMessage,
  Schedule,
  type ScheduleStatus,
  WorkerDueSchedules,
  WorkerDueSchedulesQuery,
  WorkerScheduleClaim,
  type WorkerScheduleClaimRefusal,
  WorkerScheduleClaimResult,
  WorkerScheduleCredentials,
  WorkerScheduleDelivery,
  WorkerScheduleOutcome,
  WorkerSchedulePublishState,
  WorkerStaleSchedulesQuery,
} from "@studio/contract";
import { and, asc, eq, gte, isNotNull, isNull, lte, ne, or, type SQL } from "drizzle-orm";
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
import { ApiProblem, conflict, invalidTransition, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { loadPublishingSettings, maxLatenessMinutes } from "../lib/publishing.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { requireWorkerToken } from "../middleware/worker-auth.ts";
import { approvalMatchesCurrent, type LoadedContent, loadContent } from "./contents.ts";
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

/** A local `publishing` claim not refreshed for this long belongs to a worker that stopped. */
export const DEFAULT_STALE_CLAIM_MS = 20 * 60_000;

type ScheduleRow = typeof schedules.$inferSelect;
type OutcomeStatus = "publishing" | "published" | "failed";

/**
 * Which reported outcomes may change a schedule (compare-and-set rules):
 * - `pending`/`publishing` accept every outcome (the cloud may report `published` or `failed`
 *   without a `publishing` in between);
 * - `failed` accepts `published` (a late truth: the post is live) and a repeated `failed`;
 * - `published` is final (a repeated `published` is answered unchanged);
 * - `cancelled` accepts outcomes only when the order had reached the cloud publisher: the
 *   cancel came too late there (it was already publishing), so what it reports is the truth.
 */
export function outcomeAllowed(
  current: Pick<ScheduleRow, "status" | "delivery">,
  next: OutcomeStatus,
): "apply" | "unchanged" | "refuse" {
  switch (current.status) {
    case "pending":
    case "publishing":
      return "apply";
    case "failed":
      return next === "publishing" ? "refuse" : "apply";
    case "published":
      return next === "published" ? "unchanged" : "refuse";
    case "cancelled":
      return current.delivery === "cloud" ? "apply" : "refuse";
  }
}

/** True when the content's approval still covers the schedule's frozen version and hash. */
function approvalCovers(loaded: LoadedContent, schedule: ScheduleRow): boolean {
  return (
    approvalMatchesCurrent(loaded) &&
    loaded.row.approvedVersionId === schedule.versionId &&
    loaded.row.approvedHash === schedule.contentHash
  );
}

/**
 * Statements recording an outcome after the schedule row itself moved: the publish log
 * attempt, the content status and (on a token error) the account state.
 */
async function outcomeSideEffects(
  db: Db,
  schedule: ScheduleRow,
  input: {
    status: OutcomeStatus;
    attempt: number;
    externalPostId?: string | null | undefined;
    permalink?: string | null | undefined;
    error?: string | null | undefined;
    accountNeedsReauth?: boolean | undefined;
  },
  now: Date,
): Promise<BatchItem<"sqlite">[]> {
  const loadedContent = await loadContent(db, schedule.contentId);
  const siblingSchedules = await db
    .select({ status: schedules.status })
    .from(schedules)
    .where(and(eq(schedules.contentId, schedule.contentId), ne(schedules.id, schedule.id)));
  const attempt = await logAttempt(db, schedule, input.attempt);
  const logStatus =
    input.status === "publishing"
      ? "started"
      : input.status === "published"
        ? "succeeded"
        : "failed";
  const finishedAt = input.status === "publishing" ? null : now;

  const stmts: BatchItem<"sqlite">[] = [
    db
      .insert(publishLogs)
      .values({
        id: newId(),
        scheduleId: schedule.id,
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
          ...(input.externalPostId !== undefined ? { externalPostId: input.externalPostId } : {}),
          ...(input.permalink !== undefined ? { permalink: input.permalink } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
          finishedAt,
        },
      }),
  ];

  // A cancelled schedule whose content moved on (approval revoked, a new version) leaves the
  // content alone: the post that went out is an older version.
  if (schedule.status !== "cancelled" || approvalCovers(loadedContent, schedule)) {
    stmts.push(
      db
        .update(contents)
        .set({
          status: deriveContentStatusAfterOutcome(
            loadedContent.row.status,
            input.status,
            siblingSchedules,
          ),
          updatedAt: now,
        })
        .where(eq(contents.id, schedule.contentId)),
    );
  }

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
  return stmts;
}

/**
 * Move a schedule to `status` only if it is still in `expected` (compare-and-set), then write
 * the side effects. False when someone else changed it first.
 */
async function applyOutcome(
  db: Db,
  schedule: ScheduleRow,
  expected: ScheduleStatus,
  input: Parameters<typeof outcomeSideEffects>[2],
  now: Date,
  extra: Partial<typeof schedules.$inferInsert> = {},
): Promise<boolean> {
  const moved = await db
    .update(schedules)
    .set({
      status: input.status,
      ...(input.permalink !== undefined ? { permalink: input.permalink } : {}),
      ...(input.status === "failed"
        ? { lastError: input.error ?? "Yayın başarısız oldu.", claimedAt: null }
        : input.status === "published"
          ? { lastError: null, publishState: null, claimedAt: null }
          : {}),
      ...extra,
      updatedAt: now,
    })
    .where(and(eq(schedules.id, schedule.id), eq(schedules.status, expected)))
    .returning({ id: schedules.id });
  if (moved.length === 0) return false;
  const stmts = await outcomeSideEffects(db, schedule, input, now);
  await db.batch(stmts as Batch);
  return true;
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
      description:
        "With `mode=local` schedules handed to the cloud publisher (`delivery = cloud`) are " +
        "left out: the cloud publishes them, the Mac must not publish them as well.",
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
      if (q.mode === "local") {
        const notCloud = or(isNull(schedules.delivery), ne(schedules.delivery, "cloud"));
        if (notCloud) where.push(notCloud);
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
      description:
        "Only for a `pending` or `publishing` schedule (409 `invalid_transition` otherwise: a " +
        "cancelled, published or failed schedule is never published) whose content approval " +
        "still matches its frozen version (409 `hash_mismatch`).",
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
      if (schedule.status !== "pending" && schedule.status !== "publishing") {
        throw invalidTransition(`schedule is ${schedule.status}; it is not published`);
      }
      const { account, token } = await loadSocialAccountWithToken(db, schedule.socialAccountId);
      const loadedContent = await loadContent(db, schedule.contentId);

      if (!approvalCovers(loadedContent, schedule)) {
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
      description:
        "Compare-and-set: `published` is final, a `cancelled` schedule takes outcomes only " +
        "when its order had reached the cloud publisher (the cancel came too late there), a " +
        "`failed` one takes a later `published`. Anything else is 409 `invalid_transition`.",
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
      const now = new Date();
      // Compare-and-set: a report that lost a race is re-judged against the new status once.
      for (let round = 0; round < 2; round++) {
        const schedule = await requireSchedule(db, id);
        const verdict = outcomeAllowed(schedule, input.status);
        if (verdict === "unchanged") return c.json(toSchedule(schedule), 200);
        if (verdict === "refuse") {
          throw invalidTransition(
            `schedule is ${schedule.status}; a ${input.status} outcome does not apply`,
          );
        }
        if (await applyOutcome(db, schedule, schedule.status, input, now)) {
          return c.json(toSchedule(await requireSchedule(db, id)), 200);
        }
      }
      throw conflict("schedule changed while recording the outcome; report again");
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
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/schedules/{id}/claim",
      tags,
      security,
      summary: "Take a schedule to publish it on this Mac (atomic)",
      description:
        "A `pending` schedule moves to `publishing` (delivery `local`) only when it was not " +
        "handed to the cloud publisher, its approval still matches and its time passed less " +
        "than the maximum lateness ago; a later one is marked `failed` as missed instead. A " +
        "local `publishing` claim older than `staleAfterMs` (its worker stopped) is taken over " +
        "with the saved publisher state. Anything else is refused with a `reason` (200).",
      request: { params: IdParams, body: jsonBody(WorkerScheduleClaim) },
      responses: {
        200: json(WorkerScheduleClaimResult, "Claimed, or why not."),
        400: errors[400],
        401: unauthorized,
        404: errors[404],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const now = new Date();
      const schedule = await requireSchedule(db, id);
      const refuse = async (reason: WorkerScheduleClaimRefusal) =>
        c.json(
          {
            claimed: false,
            reason,
            resumed: false,
            schedule: toSchedule(await requireSchedule(db, id)),
            publishState: null,
            attempt: input.attempt,
          },
          200,
        );

      switch (schedule.status) {
        case "cancelled":
        case "published":
        case "failed":
          return refuse(schedule.status);
        case "publishing": {
          if (schedule.delivery === "cloud") return refuse("cloud");
          if (!schedule.claimedAt) {
            // Left `publishing` by a worker from before claims existed: nothing tells how far
            // it got, so starting again could post twice. The owner checks the platform.
            await applyOutcome(
              db,
              schedule,
              "publishing",
              {
                status: "failed",
                attempt: input.attempt,
                error:
                  "Yayın önceki bir sürümde yarıda kalmış; paylaşılıp paylaşılmadığını platformda kontrol edin, gerekirse yeniden zamanlayın.",
              },
              now,
            );
            return refuse("failed");
          }
          const staleBefore = now.getTime() - (input.staleAfterMs ?? DEFAULT_STALE_CLAIM_MS);
          if (schedule.claimedAt.getTime() > staleBefore) return refuse("in_progress");
          const taken = await db
            .update(schedules)
            .set({ claimedAt: now, delivery: "local", updatedAt: now })
            .where(
              and(
                eq(schedules.id, id),
                eq(schedules.status, "publishing"),
                eq(schedules.claimedAt, schedule.claimedAt),
              ),
            )
            .returning();
          const row = taken[0];
          if (!row) return refuse("in_progress");
          return c.json(
            {
              claimed: true,
              reason: null,
              resumed: true,
              schedule: toSchedule(row),
              publishState: row.publishState ?? null,
              attempt: await logAttempt(db, row, input.attempt),
            },
            200,
          );
        }
        case "pending": {
          if (schedule.delivery === "cloud") return refuse("cloud");
          if (!approvalCovers(await loadContent(db, schedule.contentId), schedule)) {
            return refuse("approval_changed");
          }
          const limitMinutes = maxLatenessMinutes(await loadPublishingSettings(db));
          if (now.getTime() - schedule.scheduledAt.getTime() > limitMinutes * 60_000) {
            await applyOutcome(
              db,
              schedule,
              "pending",
              {
                status: "failed",
                attempt: input.attempt,
                error: missedScheduleMessage(limitMinutes),
              },
              now,
              { delivery: "local" },
            );
            return refuse("missed");
          }
          const attempt = await logAttempt(db, schedule, input.attempt);
          const claimed = await applyOutcome(
            db,
            schedule,
            "pending",
            { status: "publishing", attempt },
            now,
            { delivery: "local", claimedAt: now, lastError: null },
          );
          if (!claimed) return refuse("in_progress");
          const row = await requireSchedule(db, id);
          return c.json(
            {
              claimed: true,
              reason: null,
              resumed: false,
              schedule: toSchedule(row),
              publishState: row.publishState ?? null,
              attempt,
            },
            200,
          );
        }
      }
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/worker/schedules/{id}/publish-state",
      tags,
      security,
      summary: "Save the local publisher's state before acting on it (and refresh the claim)",
      request: { params: IdParams, body: jsonBody(WorkerSchedulePublishState) },
      responses: {
        200: json(Schedule, "Saved."),
        400: errors[400],
        401: unauthorized,
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { state } = c.req.valid("json");
      const db = createDb(c.env.DB);
      await requireSchedule(db, id);
      const now = new Date();
      const [row] = await db
        .update(schedules)
        .set({ publishState: state, claimedAt: now, updatedAt: now })
        .where(
          and(
            eq(schedules.id, id),
            eq(schedules.status, "publishing"),
            eq(schedules.delivery, "local"),
          ),
        )
        .returning();
      if (!row) throw invalidTransition("schedule is not being published on this Mac");
      return c.json(toSchedule(row), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/schedules/stale",
      tags,
      security,
      summary: "Local publishing claims whose worker stopped (resume them)",
      request: { query: WorkerStaleSchedulesQuery },
      responses: {
        200: json(WorkerDueSchedules, "Stale local claims, oldest first."),
        400: errors[400],
        401: unauthorized,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const staleBefore = new Date(Date.now() - (q.staleAfterMs ?? DEFAULT_STALE_CLAIM_MS));
      // Same rule as the claim: stale when not refreshed after `staleBefore`.
      const stale = or(isNull(schedules.claimedAt), lte(schedules.claimedAt, staleBefore));
      // Delivery `local`, or unset (a worker from before claims existed left it `publishing`).
      const notCloud = or(isNull(schedules.delivery), eq(schedules.delivery, "local"));
      const where: SQL[] = [eq(schedules.status, "publishing")];
      if (notCloud) where.push(notCloud);
      if (stale) where.push(stale);
      const rows = await createDb(c.env.DB)
        .select()
        .from(schedules)
        .where(and(...where))
        .orderBy(asc(schedules.updatedAt))
        .limit(q.limit);
      return c.json({ items: rows.map(toSchedule) }, 200);
    },
  );
