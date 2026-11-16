import { z } from "zod";
import { EntityId, PageQuery, Platform, pageOf, Timestamp } from "./common.ts";
import { ContentHash } from "./content.ts";

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
