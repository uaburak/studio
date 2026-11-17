import { z } from "zod";
import { EntityId, Platform, Timestamp } from "./common.ts";
import { Job } from "./job.ts";
import { PublishLog, Schedule } from "./schedule.ts";

/**
 * Publishing path settings and status (P3).
 *
 * Everything lives on the Mac; only approved + scheduled posts go to the cloud
 * publisher (`apps/cloud-publisher`) so they publish while the Mac is off.
 * Without a cloud publisher the Mac worker publishes at the time itself.
 */

export const PublishingMode = z.enum(["cloud", "local"]).meta({ id: "PublishingMode" });
export type PublishingMode = z.infer<typeof PublishingMode>;

/** Body of `PUT /api/publishing/cloud` (Mac only). The token is vaulted, never returned. */
export const PublishingCloudPut = z
  .object({
    url: z
      .string()
      .trim()
      .url()
      .max(500)
      .refine((v) => /^https?:\/\//i.test(v), "must be http(s)"),
    token: z.string().trim().min(16).max(512),
  })
  .meta({ id: "PublishingCloudPut" });
export type PublishingCloudPut = z.input<typeof PublishingCloudPut>;

export const PublishingStatus = z
  .object({
    mode: PublishingMode,
    cloud: z.object({
      configured: z.boolean(),
      /** Base URL (no token). */
      url: z.string().nullable(),
      lastSyncAt: Timestamp.nullable(),
      lastSyncOk: z.boolean().nullable(),
      lastSyncError: z.string().nullable(),
      syncRequestedAt: Timestamp.nullable(),
    }),
    /** False when the token vault key is missing (tokens cannot be stored). */
    vaultReady: z.boolean(),
  })
  .meta({ id: "PublishingStatus" });
export type PublishingStatus = z.infer<typeof PublishingStatus>;

// --- Worker side ------------------------------------------------------------------

export const WorkerPublishingConfig = z
  .object({
    cloud: z.object({ url: z.string(), token: z.string() }).nullable(),
    /** The app asked for an immediate sync (on focus) at this time. */
    syncRequestedAt: Timestamp.nullable(),
  })
  .meta({ id: "WorkerPublishingConfig" });
export type WorkerPublishingConfig = z.infer<typeof WorkerPublishingConfig>;

export const WorkerPublishingSyncReport = z
  .object({
    ok: z.boolean(),
    error: z.string().max(2000).nullable().optional(),
  })
  .meta({ id: "WorkerPublishingSyncReport" });
export type WorkerPublishingSyncReport = z.input<typeof WorkerPublishingSyncReport>;

// --- Preflight (platform rules before scheduling) ----------------------------------

export const PreflightIssue = z
  .object({
    code: z.string(),
    path: z.string(),
    /** Turkish, user-presentable. */
    message: z.string(),
  })
  .meta({ id: "PreflightIssue" });
export type PreflightIssue = z.infer<typeof PreflightIssue>;

export const SchedulePreflightInput = z
  .object({
    contentId: EntityId,
    /** Accounts to check; omitted = every connected account of the brand on a target platform. */
    socialAccountIds: z.array(EntityId).max(10).optional(),
    /** Planned publish time, for per-day limits (Facebook Reels); omitted = now. */
    scheduledAt: Timestamp.optional(),
  })
  .meta({ id: "SchedulePreflightInput" });
export type SchedulePreflightInput = z.input<typeof SchedulePreflightInput>;

export const SchedulePreflightTarget = z
  .object({
    socialAccountId: EntityId,
    platform: Platform,
    handle: z.string(),
    /** Publish kind the worker will use, e.g. `instagram.carousel`. */
    kind: z.string(),
    ok: z.boolean(),
    errors: z.array(PreflightIssue),
    warnings: z.array(PreflightIssue),
  })
  .meta({ id: "SchedulePreflightTarget" });
export type SchedulePreflightTarget = z.infer<typeof SchedulePreflightTarget>;

export const SchedulePreflight = z
  .object({
    mode: PublishingMode,
    ok: z.boolean(),
    /** Content-level problems (not approved, no version …). */
    errors: z.array(PreflightIssue),
    targets: z.array(SchedulePreflightTarget),
  })
  .meta({ id: "SchedulePreflight" });
export type SchedulePreflight = z.infer<typeof SchedulePreflight>;

// --- Publish now ---------------------------------------------------------------------

export const PublishNowInput = z
  .object({
    contentId: EntityId,
    socialAccountIds: z.array(EntityId).min(1).max(10),
  })
  .meta({ id: "PublishNowInput" });
export type PublishNowInput = z.input<typeof PublishNowInput>;

export const PublishNowResult = z
  .object({
    schedules: z.array(Schedule),
    jobs: z.array(Job),
  })
  .meta({ id: "PublishNowResult" });
export type PublishNowResult = z.infer<typeof PublishNowResult>;

// --- Publish log feed (log screen + notifications) ----------------------------------

export const PublishLogFeedQuery = z.object({
  brandId: EntityId.optional(),
  /** Only finished attempts whose `finishedAt` is after this, oldest first (notifications). */
  finishedAfter: Timestamp.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type PublishLogFeedQuery = z.input<typeof PublishLogFeedQuery>;

export const PublishLogFeedItem = z
  .object({
    log: PublishLog,
    schedule: Schedule,
    contentTitle: z.string(),
    accountHandle: z.string(),
  })
  .meta({ id: "PublishLogFeedItem" });
export type PublishLogFeedItem = z.infer<typeof PublishLogFeedItem>;

export const PublishLogFeed = z
  .object({
    items: z.array(PublishLogFeedItem),
  })
  .meta({ id: "PublishLogFeed" });
export type PublishLogFeed = z.infer<typeof PublishLogFeed>;

// --- Publish kind (shared by the API preflight and the worker) ------------------------

export type PublishKindName =
  | "instagram.image"
  | "instagram.carousel"
  | "instagram.reel"
  | "instagram.story"
  | "facebook.photo"
  | "facebook.multi_photo"
  | "facebook.video"
  | "facebook.reel"
  | "facebook.story"
  | "linkedin.text"
  | "linkedin.image"
  | "linkedin.multi_image"
  | "linkedin.document"
  | "linkedin.video";

/** Which publisher flow a content item uses on a platform. */
export function selectPublishKind(
  platform: "instagram" | "facebook" | "linkedin",
  contentType: "post" | "carousel" | "story" | "reel",
  slideCount: number,
): PublishKindName {
  if (platform === "instagram") {
    if (contentType === "reel") return "instagram.reel";
    if (contentType === "story") return "instagram.story";
    if (contentType === "carousel" || slideCount > 1) return "instagram.carousel";
    return "instagram.image";
  }
  if (platform === "facebook") {
    if (contentType === "reel") return "facebook.reel";
    if (contentType === "story") return "facebook.story";
    if (contentType === "carousel" || slideCount > 1) return "facebook.multi_photo";
    return "facebook.photo";
  }
  if (contentType === "reel") return "linkedin.video";
  if (contentType === "carousel" || slideCount > 1) return "linkedin.document";
  return slideCount >= 1 ? "linkedin.image" : "linkedin.text";
}

/**
 * Kinds where Meta downloads the media from a public URL. The Mac's own API is
 * not reachable from Meta, so these need the cloud publisher (signed public URLs).
 */
export const PUBLIC_URL_PUBLISH_KINDS: readonly PublishKindName[] = [
  "instagram.image",
  "instagram.carousel",
  "instagram.story",
  "facebook.photo",
  "facebook.multi_photo",
  "facebook.story",
];
