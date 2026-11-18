import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorBody,
  PublishingCloudPut,
  PublishingSettingsPatch,
  PublishingStatus,
  PublishLogFeed,
  PublishLogFeedQuery,
  WorkerPublishingConfig,
  WorkerPublishingSyncReport,
} from "@studio/contract";
import { and, asc, count, desc, eq, gt, inArray, isNotNull, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { createDb, type Db } from "../db/client.ts";
import { toPublishLog, toSchedule } from "../db/mappers.ts";
import { contents, publishLogs, schedules, socialAccounts } from "../db/schema.ts";
import { badRequest, conflict } from "../lib/errors.ts";
import {
  CLOUD_TOKEN_SETTING,
  cloudCredentials,
  loadPublishingSettings,
  maxLatenessMinutes,
  type PublishingSettingsRow,
  savePublishingSettings,
  toPublishingStatus,
} from "../lib/publishing.ts";
import { createRouter, errors, json, jsonBody } from "../lib/router.ts";
import { encryptSetting } from "../lib/token-vault.ts";
import { requireLocal } from "../middleware/access.ts";
import { requireWorkerToken } from "../middleware/worker-auth.ts";
import { migrateLegacyTokens } from "./social-accounts.ts";

const tags = ["Publishing"];
const forbidden = json(ApiErrorBody, "Not called from the Mac itself (`forbidden`).");
const security = [{ workerToken: [] }];
const unauthorized = { description: "Missing or wrong worker token (plain text)." };

/** Outbound calls to the cloud publisher give up after this long. */
const PROBE_TIMEOUT_MS = 15_000;

/** Check that a cloud publisher answers and accepts the token before saving it. */
async function probeCloudPublisher(url: string, token: string): Promise<string | null> {
  const base = url.replace(/\/+$/, "");
  try {
    const health = await fetch(`${base}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!health.ok) return `Bulut yayıncı yanıt vermedi (${base}/health → HTTP ${health.status}).`;
    const list = await fetch(`${base}/v1/orders?limit=1`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (list.status === 401)
      return "Bulut yayıncı anahtarı kabul etmedi (PUBLISHER_TOKEN ile aynı olmalı).";
    if (!list.ok) return `Bulut yayıncı siparişleri okunamadı (HTTP ${list.status}).`;
    return null;
  } catch {
    return `Bulut yayıncıya ulaşılamadı: ${base}. Adresi ve dağıtımı kontrol edin.`;
  }
}

/** Schedules the cloud publisher holds: pending/publishing there, or cancelled here but not there yet. */
async function cloudHeldSchedules(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schedules)
    .where(
      and(
        eq(schedules.delivery, "cloud"),
        or(
          inArray(schedules.status, ["pending", "publishing"]),
          and(eq(schedules.status, "cancelled"), isNotNull(schedules.cloudSyncedAt)),
        ),
      ),
    );
  return row?.n ?? 0;
}

/** Worker config: the cloud publisher (throws 409 when it is set but unreadable) and the limits. */
async function workerConfig(row: PublishingSettingsRow | null, env: Env) {
  return {
    cloud: await cloudCredentials(row, env),
    syncRequestedAt: row?.syncRequestedAt ? row.syncRequestedAt.toISOString() : null,
    maxLatenessMs: maxLatenessMinutes(row) * 60_000,
  };
}

const router = createRouter();

router.use("/api/publishing/cloud", requireLocal);
router.use("/api/publishing/settings", requireLocal);
router.use("/api/worker/publishing/*", requireWorkerToken);

export const publishingRoutes = router
  .openapi(
    createRoute({
      method: "get",
      path: "/api/publishing/status",
      tags,
      summary: "Publishing path: cloud publisher or this Mac, last cloud sync, vault state",
      responses: { 200: json(PublishingStatus, "Status.") },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      await migrateLegacyTokens(db, c.env);
      return c.json(toPublishingStatus(await loadPublishingSettings(db), c.env), 200);
    },
  )
  .openapi(
    createRoute({
      method: "put",
      path: "/api/publishing/cloud",
      tags,
      summary: "Set the cloud publisher URL and bearer token (Mac only)",
      description:
        "Probes `{url}/health` and `{url}/v1/orders` with the token first; the token is sealed " +
        "with the token vault and only handed to the worker.",
      request: { body: jsonBody(PublishingCloudPut) },
      responses: {
        200: json(PublishingStatus, "Saved."),
        400: errors[400],
        403: forbidden,
        409: errors[409],
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const url = input.url.replace(/\/+$/, "");
      const problem = await probeCloudPublisher(url, input.token);
      if (problem) throw badRequest(problem, [{ path: "url", message: problem }]);
      const sealed = await encryptSetting(c.env, CLOUD_TOKEN_SETTING, input.token);
      const db = createDb(c.env.DB);
      await savePublishingSettings(db, {
        cloudUrl: url,
        cloudTokenCiphertext: sealed.ciphertext,
        cloudTokenIv: sealed.iv,
        cloudTokenKeyVersion: sealed.keyVersion,
        syncRequestedAt: new Date(),
        lastSyncError: null,
      });
      return c.json(toPublishingStatus(await loadPublishingSettings(db), c.env), 200);
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/api/publishing/cloud",
      tags,
      summary: "Forget the cloud publisher; this Mac publishes again (Mac only)",
      description:
        "Refused (409) while schedules handed to the cloud publisher are pending or publishing " +
        "there, or cancelled here but not yet cancelled there: without the cloud publisher the " +
        "Mac could neither cancel nor follow them. With `force=true` it is cleared anyway; those " +
        "orders stay at the cloud publisher and still publish (the Mac never publishes them).",
      request: {
        query: z.object({ force: z.enum(["true", "false"]).optional() }),
      },
      responses: {
        200: json(PublishingStatus, "Cleared."),
        403: forbidden,
        409: errors[409],
      },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      if (c.req.valid("query").force !== "true") {
        const held = await cloudHeldSchedules(db);
        if (held > 0) {
          throw conflict(
            `Bulut yayıncıda ${held} zamanlama var (bekleyen ya da iptali henüz iletilmemiş). ` +
              "Önce Takvim'den iptal edip eşitlenmesini bekleyin; yoksa bunlar bulutta kalır ve yine paylaşılır.",
          );
        }
      }
      await savePublishingSettings(db, {
        cloudUrl: null,
        cloudTokenCiphertext: null,
        cloudTokenIv: null,
        cloudTokenKeyVersion: null,
        lastSyncAt: null,
        lastSyncOk: null,
        lastSyncError: null,
      });
      return c.json(toPublishingStatus(await loadPublishingSettings(db), c.env), 200);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/api/publishing/settings",
      tags,
      summary: "Change publishing settings: maximum lateness (Mac only)",
      description:
        "`maxLatenessMinutes` (default 120): a schedule whose time passed more than this long " +
        "ago (the Mac was asleep, the cloud publisher was down) is not published; it fails as " +
        "missed and the owner reschedules it.",
      request: { body: jsonBody(PublishingSettingsPatch) },
      responses: {
        200: json(PublishingStatus, "Saved."),
        400: errors[400],
        403: forbidden,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      if (input.maxLatenessMinutes !== undefined) {
        await savePublishingSettings(db, { maxLatenessMinutes: input.maxLatenessMinutes });
      }
      return c.json(toPublishingStatus(await loadPublishingSettings(db), c.env), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/publishing/sync",
      tags,
      summary: "Ask the worker to push and pull cloud orders now (app focus)",
      responses: { 200: json(PublishingStatus, "Requested.") },
    }),
    async (c) => {
      const db = createDb(c.env.DB);
      await savePublishingSettings(db, { syncRequestedAt: new Date() });
      return c.json(toPublishingStatus(await loadPublishingSettings(db), c.env), 200);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/publish-logs",
      tags,
      summary: "Publish attempts with their schedule, title and account",
      description:
        "Without `finishedAfter`: newest first (log screen). With it: only finished attempts " +
        "(succeeded/failed) finished after that time, oldest first (notifications).",
      request: { query: PublishLogFeedQuery },
      responses: { 200: json(PublishLogFeed, "Log entries."), 400: errors[400] },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const db = createDb(c.env.DB);
      const where: SQL[] = [];
      if (q.brandId) where.push(eq(schedules.brandId, q.brandId));
      if (q.finishedAfter) {
        where.push(isNotNull(publishLogs.finishedAt));
        where.push(gt(publishLogs.finishedAt, new Date(q.finishedAfter)));
        where.push(inArray(publishLogs.status, ["succeeded", "failed"]));
      }
      const rows = await db
        .select({
          log: publishLogs,
          schedule: schedules,
          title: contents.title,
          handle: socialAccounts.handle,
        })
        .from(publishLogs)
        .innerJoin(schedules, eq(publishLogs.scheduleId, schedules.id))
        .innerJoin(contents, eq(schedules.contentId, contents.id))
        .innerJoin(socialAccounts, eq(schedules.socialAccountId, socialAccounts.id))
        .where(and(...where))
        .orderBy(
          ...(q.finishedAfter
            ? [asc(publishLogs.finishedAt), asc(publishLogs.id)]
            : [desc(publishLogs.startedAt), desc(publishLogs.id)]),
        )
        .limit(q.limit);
      return c.json(
        {
          items: rows.map((r) => ({
            log: toPublishLog(r.log),
            schedule: toSchedule(r.schedule),
            contentTitle: r.title,
            accountHandle: r.handle,
          })),
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/api/worker/publishing/config",
      tags,
      security,
      summary: "Cloud publisher URL + token (or null), the last sync request, the maximum lateness",
      description:
        "409 when a cloud publisher is set but its token cannot be read: the worker must not " +
        "fall back to publishing locally what the cloud publisher holds.",
      responses: {
        200: json(WorkerPublishingConfig, "Config."),
        401: unauthorized,
        409: errors[409],
      },
    }),
    async (c) => {
      const row = await loadPublishingSettings(createDb(c.env.DB));
      return c.json(await workerConfig(row, c.env), 200);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/api/worker/publishing/report",
      tags,
      security,
      summary: "Record the result of a cloud sync round",
      request: { body: jsonBody(WorkerPublishingSyncReport) },
      responses: {
        200: json(WorkerPublishingConfig, "Config after the report."),
        400: errors[400],
        401: unauthorized,
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const db = createDb(c.env.DB);
      await savePublishingSettings(db, {
        lastSyncAt: new Date(),
        lastSyncOk: input.ok,
        lastSyncError: input.ok ? null : (input.error ?? "Bilinmeyen hata"),
      });
      const row = await loadPublishingSettings(db);
      // The report must land even when the token is unreadable (that is what it reports).
      const config = await workerConfig(row, c.env).catch(() => ({
        cloud: null,
        syncRequestedAt: row?.syncRequestedAt ? row.syncRequestedAt.toISOString() : null,
        maxLatenessMs: maxLatenessMinutes(row) * 60_000,
      }));
      return c.json(config, 200);
    },
  );
