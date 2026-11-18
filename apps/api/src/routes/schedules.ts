import { createRoute } from "@hono/zod-openapi";
import {
  ACTIVE_SCHEDULE_STATUSES,
  JobCreate,
  PublishLogList,
  PublishLogListQuery,
  PublishNowInput,
  PublishNowResult,
  SCHEDULABLE_STATUSES,
  Schedule,
  ScheduleCreate,
  ScheduleList,
  ScheduleListQuery,
  SchedulePreflight,
  SchedulePreflightInput,
  type SchedulePreflightTarget,
  ScheduleUpdate,
  statusIn,
} from "@studio/contract";
import { and, asc, desc, eq, gt, gte, inArray, lt, ne, notExists, or, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { createDb, type Db } from "../db/client.ts";
import { toPublishLog, toSchedule } from "../db/mappers.ts";
import {
  contents,
  contentVersionSlides,
  publishLogs,
  schedules,
  socialAccounts,
  socialAccountTokens,
} from "../db/schema.ts";
import { ApiProblem, badRequest, conflict, invalidTransition, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { decodeTimeCursor, encodeTimeCursor, toPage } from "../lib/pagination.ts";
import { preflightTargets } from "../lib/preflight.ts";
import { readPublishDetails } from "../lib/publish-details.ts";
import { loadPublishingSettings, publishingMode, requestSyncStatement } from "../lib/publishing.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import {
  approvalMatchesCurrent,
  assertNotTrashed,
  type LoadedContent,
  loadContent,
} from "./contents.ts";
import { createJob } from "./jobs.ts";
import { loadSocialAccountWithToken, requireSocialAccount } from "./social-accounts.ts";

const tags = ["Schedules"];

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];

async function requireSchedule(db: Db, id: string) {
  const row = await db.query.schedules.findFirst({ where: eq(schedules.id, id) });
  if (!row) throw notFound("schedule", id);
  return row;
}

/** Preflight the content on the given accounts (or every usable account of its brand). */
export async function runPreflight(
  db: Db,
  env: Env,
  loaded: LoadedContent,
  accountIds?: string[],
  scheduledAt?: Date,
): Promise<{
  mode: "cloud" | "local";
  targets: SchedulePreflightTarget[];
  contentErrors: { code: string; path: string; message: string }[];
}> {
  const { row: content, current } = loaded;
  const mode = publishingMode(await loadPublishingSettings(db));
  const contentErrors: { code: string; path: string; message: string }[] = [];
  if (!current) {
    contentErrors.push({
      code: "NO_VERSION",
      path: "",
      message: "Bu postun henüz bir tasarım sürümü yok.",
    });
    return { mode, targets: [], contentErrors };
  }
  const slides = await db
    .select({
      html: contentVersionSlides.html,
      width: contentVersionSlides.width,
      height: contentVersionSlides.height,
      renderedAssetId: contentVersionSlides.renderedAssetId,
    })
    .from(contentVersionSlides)
    .where(eq(contentVersionSlides.versionId, current.id))
    .orderBy(asc(contentVersionSlides.position));

  let accounts: {
    account: typeof socialAccounts.$inferSelect;
    token: typeof socialAccountTokens.$inferSelect | null;
  }[];
  if (accountIds?.length) {
    accounts = [];
    for (const id of accountIds) accounts.push(await loadSocialAccountWithToken(db, id));
  } else {
    accounts = await db
      .select({ account: socialAccounts, token: socialAccountTokens })
      .from(socialAccounts)
      .leftJoin(socialAccountTokens, eq(socialAccounts.id, socialAccountTokens.socialAccountId))
      .where(
        and(
          eq(socialAccounts.brandId, content.brandId),
          ne(socialAccounts.status, "disabled"),
          inArray(socialAccounts.platform, content.targetPlatforms),
        ),
      );
  }
  const targets = await preflightTargets({
    db,
    content: {
      type: content.type,
      title: content.title,
      caption: content.caption,
      slides,
      publishDetails: readPublishDetails(content.publishDetails),
    },
    accounts,
    mode,
    allowPrivateMedia: env.STUDIO_ALLOW_PRIVATE_MEDIA_URLS === "1",
    ...(scheduledAt ? { scheduledAt: scheduledAt.getTime() } : {}),
  });
  return { mode, targets, contentErrors };
}

interface ScheduleInput {
  contentId: string;
  socialAccountId: string;
  platform?: string | undefined;
  scheduledAt: Date;
}

/**
 * Every check a new schedule must pass, platform rules (preflight) included; nothing is
 * written. Throws the API's usual errors.
 */
async function checkSchedulable(
  db: Db,
  env: Env,
  input: ScheduleInput,
  opts: { immediate: boolean },
) {
  const loaded = await loadContent(db, input.contentId);
  const { row: content } = loaded;
  assertNotTrashed(content);
  const account = await requireSocialAccount(db, input.socialAccountId);

  const platform = input.platform ?? account.platform;
  if (platform !== account.platform) {
    throw badRequest(`account ${account.id} is a ${account.platform} account`, [
      { path: "platform", message: `must be ${account.platform}` },
    ]);
  }
  if (!opts.immediate && input.scheduledAt.getTime() <= Date.now()) {
    throw badRequest("scheduledAt must be in the future", [
      { path: "scheduledAt", message: "in the past" },
    ]);
  }
  if (account.brandId !== content.brandId) {
    throw conflict("the social account belongs to a different brand");
  }
  if (account.status === "disabled") throw conflict(`social account ${account.id} is disabled`);
  if (!content.targetPlatforms.includes(account.platform)) {
    throw conflict(`${platform} is not one of the content's target platforms`);
  }
  if (!statusIn(content.status, SCHEDULABLE_STATUSES)) {
    throw invalidTransition(`content is ${content.status}; only approved content can be scheduled`);
  }
  const current = loaded.current;
  if (!approvalMatchesCurrent(loaded) || !current) {
    throw new ApiProblem("hash_mismatch", "the approval does not match the current version");
  }

  // Platform rules (Turkish messages) before anything is written.
  const preflight = await runPreflight(db, env, loaded, [account.id], input.scheduledAt);
  const target = preflight.targets[0];
  if (target && !target.ok) {
    throw badRequest(
      `${account.handle}: ${target.errors.map((e) => e.message).join(" ")}`,
      target.errors.map((e) => ({ path: e.path || "content", message: e.message })),
    );
  }
  return { content, current, account };
}

/** Insert one schedule (shared by create and publish-now) after `checkSchedulable`. */
async function writeSchedule(
  db: Db,
  checked: Awaited<ReturnType<typeof checkSchedulable>>,
  scheduledAt: Date,
) {
  const { content, current, account } = checked;
  const now = new Date();
  const markScheduled = db
    .update(contents)
    .set({ status: "scheduled", updatedAt: now })
    .where(and(eq(contents.id, content.id), eq(contents.status, content.status)));

  // Retry: a failed schedule of this post on this account is reused (same id, so the same
  // cloud order is replaced) instead of leaving it next to a new one. Its publish logs stay.
  const failed = await db.query.schedules.findFirst({
    where: and(
      eq(schedules.contentId, content.id),
      eq(schedules.socialAccountId, account.id),
      eq(schedules.status, "failed"),
    ),
    orderBy: [desc(schedules.updatedAt), desc(schedules.id)],
  });
  if (failed) {
    await db.batch([
      db
        .update(schedules)
        .set({
          versionId: current.id,
          contentHash: current.contentHash,
          scheduledAt,
          status: "pending",
          permalink: null,
          delivery: null,
          cloudSyncedAt: null,
          lastError: null,
          // The same design keeps the local publisher's state, so the retry resumes and
          // reconciles with the platform (the failed try may have posted after all); a new
          // design starts from scratch.
          ...(failed.contentHash === current.contentHash ? {} : { publishState: null }),
          claimedAt: null,
          cancelledAt: null,
          updatedAt: now,
        })
        .where(and(eq(schedules.id, failed.id), eq(schedules.status, "failed"))),
      markScheduled,
    ]);
    const reused = await requireSchedule(db, failed.id);
    if (reused.status !== "pending") throw conflict("the failed schedule changed meanwhile");
    return reused;
  }

  const id = newId();
  await db.batch([
    db.insert(schedules).values({
      id,
      contentId: content.id,
      brandId: content.brandId,
      platform: account.platform,
      socialAccountId: account.id,
      versionId: current.id,
      contentHash: current.contentHash,
      scheduledAt,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    }),
    markScheduled,
  ]);
  return requireSchedule(db, id);
}

/** Insert one schedule; throws the API's usual errors. */
async function insertSchedule(
  db: Db,
  env: Env,
  input: ScheduleInput,
  opts: { immediate: boolean },
) {
  return writeSchedule(db, await checkSchedulable(db, env, input, opts), input.scheduledAt);
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
        "be one of the content's target platforms. Moves the content to `scheduled`. A " +
        "`failed` schedule of the same content and account is reused (retry): it goes back " +
        "to `pending` with the new time and keeps its id, so its cloud order is replaced " +
        "instead of duplicated.",
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
      const row = await insertSchedule(
        db,
        c.env,
        { ...input, scheduledAt: new Date(input.scheduledAt) },
        { immediate: false },
      );
      return c.json(toSchedule(row), 201);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/schedules/preflight",
      tags,
      summary: "Check platform rules for a content item on accounts before scheduling",
      description:
        "Runs the publishers' validators (JPEG for Instagram, aspect ratios, caption and " +
        "hashtag limits, carousel size, Reels duration, 30 Facebook Reels per Page in 24 hours " +
        "around `scheduledAt` …) on what the worker would publish. " +
        "Messages are Turkish. In local mode (no cloud publisher) Instagram/Facebook image " +
        "posts are refused: Meta downloads images from a public URL.",
      request: { body: jsonBody(SchedulePreflightInput) },
      responses: {
        200: json(SchedulePreflight, "Per-account result."),
        400: errors[400],
        404: errors[404],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const loaded = await loadContent(db, input.contentId);
      const { mode, targets, contentErrors } = await runPreflight(
        db,
        c.env,
        loaded,
        input.socialAccountIds,
        input.scheduledAt ? new Date(input.scheduledAt) : undefined,
      );
      return c.json(
        {
          mode,
          ok: contentErrors.length === 0 && targets.length > 0 && targets.every((t) => t.ok),
          errors: contentErrors,
          targets,
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/schedules/publish-now",
      tags,
      summary: "Publish approved content now on accounts (schedule + schedule.publish job)",
      description:
        "Creates a schedule a few seconds from now per account and queues a `schedule.publish` " +
        "job for each. With a cloud publisher the worker hands it to the cloud at once. Every " +
        "account is checked (platform rules included) before any schedule is created.",
      request: { body: jsonBody(PublishNowInput) },
      responses: {
        201: json(PublishNowResult, "Created."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const accountIds = [...new Set(input.socialAccountIds)];
      const scheduledAt = new Date(Date.now() + 5_000);
      // Every account passes every check before anything is queued: a refusal on the second
      // account must not leave the first one publishing.
      const checked = [];
      for (const accountId of accountIds) {
        checked.push(
          await checkSchedulable(
            db,
            c.env,
            { contentId: input.contentId, socialAccountId: accountId, scheduledAt },
            { immediate: true },
          ),
        );
      }
      const created = [];
      const jobs = [];
      for (const ok of checked) {
        const row = await writeSchedule(db, ok, scheduledAt);
        created.push(toSchedule(row));
        jobs.push(
          await createJob(
            c.env,
            JobCreate.parse({
              type: "schedule.publish",
              brandId: row.brandId,
              contentId: row.contentId,
              payload: { scheduleId: row.id },
              priority: 20,
            }),
          ),
        );
      }
      return c.json({ schedules: created, jobs }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/schedules/{id}",
      tags,
      summary: "Move a pending schedule to another time (calendar drag)",
      description:
        "Only `pending` schedules move, and only into the future. A schedule already at the " +
        "cloud publisher is pushed again by the worker with the new time.",
      request: { params: IdParams, body: jsonBody(ScheduleUpdate) },
      responses: {
        200: json(Schedule, "Moved."),
        400: errors[400],
        404: errors[404],
        409: errors[409],
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      const schedule = await requireSchedule(db, id);
      if (schedule.status !== "pending") {
        throw invalidTransition(
          `schedule is ${schedule.status}; only pending schedules can be moved`,
        );
      }
      const scheduledAt = new Date(input.scheduledAt);
      if (scheduledAt.getTime() <= Date.now()) {
        throw badRequest("scheduledAt must be in the future", [
          { path: "scheduledAt", message: "in the past" },
        ]);
      }
      const now = new Date();
      const [row] = await db
        .update(schedules)
        .set({
          scheduledAt,
          // The cloud copy has the old time until the worker pushes it again.
          cloudSyncedAt: null,
          updatedAt: now,
        })
        .where(and(eq(schedules.id, id), eq(schedules.status, "pending")))
        .returning();
      if (!row) throw invalidTransition("schedule is no longer pending");
      return c.json(toSchedule(row), 200);
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
        "schedule it returns from `scheduled` to `approved`. Asks the worker for an immediate " +
        "sync, so an order already at the cloud publisher is cancelled there right away.",
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
        requestSyncStatement(db, now),
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
