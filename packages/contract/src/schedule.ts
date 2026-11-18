import { z } from "zod";
import { EntityId, PageQuery, Platform, pageOf, Timestamp } from "./common.ts";
import { Content, ContentHash, ContentVersion } from "./content.ts";
import { SocialAccount } from "./social-account.ts";

/**
 * Schedule lifecycle. This task only creates and cancels schedules; the
 * publishing engine (Faz 3) moves them through publishing -> published/failed.
 */
export const ScheduleStatus = z
  .enum(["pending", "publishing", "published", "failed", "cancelled"])
  .meta({ id: "ScheduleStatus" });
export type ScheduleStatus = z.infer<typeof ScheduleStatus>;

/** Statuses that hold a slot (one active schedule per content + account). */
export const ACTIVE_SCHEDULE_STATUSES = [
  "pending",
  "publishing",
] as const satisfies ScheduleStatus[];

export const ScheduleDelivery = z.enum(["local", "cloud"]).meta({ id: "ScheduleDelivery" });
export type ScheduleDelivery = z.infer<typeof ScheduleDelivery>;

export const Schedule = z
  .object({
    id: EntityId,
    contentId: EntityId,
    brandId: EntityId,
    platform: Platform,
    socialAccountId: EntityId,
    /**
     * Approved version this schedule will publish, frozen at scheduling time.
     * The publisher must refuse if the content's approval no longer matches.
     */
    versionId: EntityId,
    contentHash: ContentHash,
    /** Publish time, UTC. */
    scheduledAt: Timestamp,
    status: ScheduleStatus,
    permalink: z.string().nullable().optional(),
    /**
     * Who will publish it: `cloud` once the order reached the cloud publisher
     * (`cloudSyncedAt`), `local` when the Mac worker publishes it itself (the
     * Mac must be on at that time). `null`: not decided yet.
     */
    delivery: ScheduleDelivery.nullable().optional(),
    cloudSyncedAt: Timestamp.nullable().optional(),
    /** Last error of the publishing path (failed outcome, cloud push error), Turkish. */
    lastError: z.string().nullable().optional(),
    cancelledAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Schedule" });
export type Schedule = z.infer<typeof Schedule>;

export const ScheduleCreate = z
  .object({
    contentId: EntityId,
    socialAccountId: EntityId,
    /** Defaults to the account's platform; must match it when given. */
    platform: Platform.optional(),
    /** Must be in the future. Use UTC (`...Z`). */
    scheduledAt: Timestamp,
  })
  .meta({ id: "ScheduleCreate" });
export type ScheduleCreate = z.input<typeof ScheduleCreate>;

/** Move a pending schedule (calendar drag). Must stay in the future. */
export const ScheduleUpdate = z
  .object({
    scheduledAt: Timestamp,
  })
  .meta({ id: "ScheduleUpdate" });
export type ScheduleUpdate = z.input<typeof ScheduleUpdate>;

/** Ordered by `scheduledAt` ascending (calendar order). */
export const ScheduleListQuery = PageQuery.extend({
  brandId: EntityId.optional(),
  contentId: EntityId.optional(),
  socialAccountId: EntityId.optional(),
  status: ScheduleStatus.optional(),
  /** Inclusive lower bound on `scheduledAt`. */
  from: Timestamp.optional(),
  /** Exclusive upper bound on `scheduledAt`. */
  to: Timestamp.optional(),
});
export type ScheduleListQuery = z.input<typeof ScheduleListQuery>;

export const ScheduleList = pageOf(Schedule, "ScheduleList");
export type ScheduleList = z.infer<typeof ScheduleList>;

// --- Publish logs (written by the publishing engine, read-only here) ---------

export const PublishLogStatus = z
  .enum(["started", "succeeded", "failed"])
  .meta({ id: "PublishLogStatus" });
export type PublishLogStatus = z.infer<typeof PublishLogStatus>;

export const PublishLog = z
  .object({
    id: EntityId,
    scheduleId: EntityId,
    /** 1, 2, 3, ... per schedule. */
    attempt: z.number().int().min(1),
    status: PublishLogStatus,
    externalPostId: z.string().nullable(),
    permalink: z.string().nullable().optional(),
    error: z.string().nullable(),
    startedAt: Timestamp,
    finishedAt: Timestamp.nullable(),
    createdAt: Timestamp,
  })
  .meta({ id: "PublishLog" });
export type PublishLog = z.infer<typeof PublishLog>;

export const PublishLogListQuery = PageQuery;
export type PublishLogListQuery = z.input<typeof PublishLogListQuery>;

export const PublishLogList = pageOf(PublishLog, "PublishLogList");
export type PublishLogList = z.infer<typeof PublishLogList>;

// --- Missed schedules (S6: maximum lateness) ----------------------------------

/**
 * `lastError` of a schedule that was not published because its time had passed by more than
 * the maximum lateness (Ayarlar → Yayın, default 2 hours): the Mac was asleep or off, or the
 * cloud publisher could not run on time. The schedule is `failed`; the owner reschedules it.
 * UIs can recognise it by this prefix.
 */
export const SCHEDULE_MISSED_PREFIX = "Mac kapalıyken kaçtı";

/** Turkish "2 saatten" / "90 dakikadan" for a lateness limit in minutes. */
function latenessText(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60} saatten` : `${minutes} dakikadan`;
}

export function missedScheduleMessage(maxLatenessMinutes: number): string {
  return (
    `${SCHEDULE_MISSED_PREFIX}: paylaşım saatinden ${latenessText(maxLatenessMinutes)} fazla ` +
    "geçtiği için paylaşılmadı. Yeniden zamanlayın ya da şimdi paylaşın."
  );
}

// --- Worker schedule execution -----------------------------------------------

export const WorkerDueSchedulesQuery = z
  .object({
    before: Timestamp.optional(),
    /**
     * `local`: the Mac publishes them itself, so schedules already handed to the cloud
     * publisher (`delivery = cloud`) are left out — the cloud publishes those. Omitted: every
     * pending schedule (the cloud push loop).
     */
    mode: z.enum(["cloud", "local"]).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .meta({ id: "WorkerDueSchedulesQuery" });
export type WorkerDueSchedulesQuery = z.input<typeof WorkerDueSchedulesQuery>;

export const WorkerDueSchedules = z
  .object({
    items: z.array(Schedule),
  })
  .meta({ id: "WorkerDueSchedules" });
export type WorkerDueSchedules = z.infer<typeof WorkerDueSchedules>;

export const WorkerScheduleCredentials = z
  .object({
    schedule: Schedule,
    account: SocialAccount,
    content: Content,
    version: ContentVersion,
    accessToken: z.string().nullable(),
  })
  .meta({ id: "WorkerScheduleCredentials" });
export type WorkerScheduleCredentials = z.infer<typeof WorkerScheduleCredentials>;

export const WorkerScheduleOutcome = z
  .object({
    status: z.enum(["publishing", "published", "failed"]),
    attempt: z.number().int().min(1).default(1),
    externalPostId: z.string().max(256).nullable().optional(),
    permalink: z.string().max(2000).nullable().optional(),
    error: z.string().max(4000).nullable().optional(),
    accountNeedsReauth: z.boolean().default(false),
  })
  .meta({ id: "WorkerScheduleOutcome" });
export type WorkerScheduleOutcome = z.input<typeof WorkerScheduleOutcome>;

export const WorkerScheduleDelivery = z
  .object({
    delivery: ScheduleDelivery,
    /** Set when the order (with all media) reached the cloud publisher. */
    cloudSyncedAt: Timestamp.nullable().optional(),
    /** Push/sync error (Turkish), `null` clears it. */
    error: z.string().max(4000).nullable().optional(),
  })
  .meta({ id: "WorkerScheduleDelivery" });
export type WorkerScheduleDelivery = z.input<typeof WorkerScheduleDelivery>;

/**
 * Body of `POST /api/worker/schedules/{id}/claim`: the Mac worker takes a schedule to publish it
 * itself. Atomic: only a `pending` schedule that was not handed to the cloud publisher, whose
 * approval still matches and whose time is within the maximum lateness, moves to `publishing`;
 * or a `publishing` one claimed locally longer than `staleAfterMs` ago (its worker died) is
 * taken over with its saved publisher state, so the publish resumes instead of starting again.
 */
export const WorkerScheduleClaim = z
  .object({
    attempt: z.number().int().min(1).default(1),
    /** Takeover age for a local `publishing` claim; the server default is 20 minutes. */
    staleAfterMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 3600_000)
      .optional(),
  })
  .meta({ id: "WorkerScheduleClaim" });
export type WorkerScheduleClaim = z.input<typeof WorkerScheduleClaim>;

export const WorkerScheduleClaimRefusal = z
  .enum([
    "cancelled",
    "published",
    "failed",
    /** Handed to the cloud publisher: it publishes it. */
    "cloud",
    /** Another worker is publishing it (claim not stale yet). */
    "in_progress",
    /** The content's approval no longer covers the schedule's version. */
    "approval_changed",
    /** Too late (maximum lateness): marked `failed` with the missed message. */
    "missed",
  ])
  .meta({ id: "WorkerScheduleClaimRefusal" });
export type WorkerScheduleClaimRefusal = z.infer<typeof WorkerScheduleClaimRefusal>;

export const WorkerScheduleClaimResult = z
  .object({
    claimed: z.boolean(),
    /** Why not (only when `claimed` is false). */
    reason: WorkerScheduleClaimRefusal.nullable(),
    /** A stale local claim was taken over: continue from `publishState`. */
    resumed: z.boolean(),
    schedule: Schedule,
    /** The publisher state saved by the previous claim (`null`: start from scratch). */
    publishState: z.record(z.string(), z.unknown()).nullable(),
    /** Publish log attempt number of this claim. */
    attempt: z.number().int().min(1),
  })
  .meta({ id: "WorkerScheduleClaimResult" });
export type WorkerScheduleClaimResult = z.infer<typeof WorkerScheduleClaimResult>;

/**
 * Body of `PUT /api/worker/schedules/{id}/publish-state`: the publisher's state machine state,
 * saved before the worker acts on it (and as the claim's heartbeat). No tokens inside.
 */
export const WorkerSchedulePublishState = z
  .object({ state: z.record(z.string(), z.unknown()) })
  .meta({ id: "WorkerSchedulePublishState" });
export type WorkerSchedulePublishState = z.input<typeof WorkerSchedulePublishState>;

/** `GET /api/worker/schedules/stale`: local `publishing` claims older than `staleAfterMs`. */
export const WorkerStaleSchedulesQuery = z
  .object({
    staleAfterMs: z.coerce
      .number()
      .int()
      .min(0)
      .max(24 * 3600_000)
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .meta({ id: "WorkerStaleSchedulesQuery" });
export type WorkerStaleSchedulesQuery = z.input<typeof WorkerStaleSchedulesQuery>;
