import { z } from "zod";
import { EntityId, MAX_PAGE_SIZE, pageOf, Timestamp } from "./common.ts";
import { ContentHash } from "./content.ts";
import { IG_USERNAME_RE } from "./publish-details.ts";

/**
 * Cloud publisher (`apps/cloud-publisher`): the only part of Studio that runs
 * in the cloud. The Mac sends it "publish orders" for approved, scheduled
 * posts; it publishes them on time even when the Mac is asleep, and the Mac
 * pulls statuses and the publish log back when it is online.
 *
 * Every request carries `Authorization: Bearer <PUBLISHER_TOKEN>`. Access
 * tokens go in once (create/replace) and are never returned.
 */

/** Publish flows supported by `@studio/publishers` (must stay in sync with its `PublishKind`). */
export const CloudPublishKind = z
  .enum([
    "instagram.image",
    "instagram.carousel",
    "instagram.reel",
    "instagram.story",
    "facebook.photo",
    "facebook.multi_photo",
    "facebook.video",
    "facebook.reel",
    "facebook.story",
    "linkedin.text",
    "linkedin.image",
    "linkedin.multi_image",
    "linkedin.document",
    "linkedin.video",
  ])
  .meta({ id: "CloudPublishKind" });
export type CloudPublishKind = z.infer<typeof CloudPublishKind>;

export const CloudPlatform = z
  .enum(["instagram", "facebook", "linkedin"])
  .meta({ id: "CloudPlatform" });
export type CloudPlatform = z.infer<typeof CloudPlatform>;

/** Media id: also the last URL segment Meta sees, so an extension is welcome (`slide-1.jpg`). */
export const CloudMediaId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "invalid media id");

export const CLOUD_MEDIA_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "video/mp4",
  "video/quicktime",
  "application/pdf",
] as const;

/** Upper bound for one media file (a single Worker request body is limited to 100 MB). */
export const CLOUD_MAX_MEDIA_BYTES = 95 * 1024 * 1024;

export const CloudOrderMedia = z
  .object({
    id: CloudMediaId,
    kind: z.enum(["image", "video", "document"]),
    mimeType: z.enum(CLOUD_MEDIA_MIME_TYPES),
    bytes: z.number().int().positive().max(CLOUD_MAX_MEDIA_BYTES),
    /** Hex SHA-256 of the file; the upload is verified against it. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a hex SHA-256 hash"),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    durationMs: z.number().int().positive().optional(),
    frameRate: z.number().positive().optional(),
    altText: z.string().max(1000).optional(),
    /**
     * `cover`: the Instagram Reels cover picture (N13), not one of the post's media; it is sent
     * as `cover_url`. Absent: a post medium (in display order).
     */
    role: z.enum(["cover"]).optional(),
    /** Instagram: people tagged on this picture (N13; x / y 0–1 from the top left). */
    userTags: z
      .array(
        z.object({
          username: z.string().regex(IG_USERNAME_RE),
          x: z.number().min(0).max(1).optional(),
          y: z.number().min(0).max(1).optional(),
        }),
      )
      .max(20)
      .optional(),
  })
  .meta({ id: "CloudOrderMedia" });
export type CloudOrderMedia = z.infer<typeof CloudOrderMedia>;

/**
 * Publish details of an order (N13). Each target uses what its platform supports (the builder
 * leaves the rest out): first comment (Instagram, Facebook), location, collaborators, Reels
 * people tags, cover frame and share-to-feed (Instagram). Alt texts and picture tags ride on the
 * media; the Reels cover picture is a medium with `role: "cover"`.
 */
export const CloudOrderDetails = z
  .object({
    firstComment: z.string().min(1).max(8000).optional(),
    locationId: z
      .string()
      .regex(/^\d{1,30}$/)
      .optional(),
    collaborators: z.array(z.string().regex(IG_USERNAME_RE)).max(3).optional(),
    /** Instagram Reels: people tagged on the video (no position). */
    reelUserTags: z.array(z.string().regex(IG_USERNAME_RE)).max(20).optional(),
    /** Instagram Reels cover frame (ms); a cover picture wins over it. */
    thumbOffsetMs: z.number().int().min(0).optional(),
    /** Instagram Reels: also in the feed (default true). */
    shareToFeed: z.boolean().optional(),
  })
  .meta({ id: "CloudOrderDetails" });
export type CloudOrderDetails = z.infer<typeof CloudOrderDetails>;

export const CloudOrderTargetInput = z
  .object({
    /** Mac-side id (e.g. the schedule id). Unique within the order. */
    id: EntityId,
    kind: CloudPublishKind,
    /** IG user id (Instagram), Page id (Facebook), or author URN (LinkedIn). */
    accountExternalId: z.string().min(1).max(128),
    /** Instagram: user token. Facebook: Page token. LinkedIn: OAuth bearer token. Encrypted at rest, never returned. */
    accessToken: z.string().min(10).max(4096),
  })
  .meta({ id: "CloudOrderTargetInput" });
export type CloudOrderTargetInput = z.infer<typeof CloudOrderTargetInput>;

/** Body of `PUT /v1/orders/{orderId}` (create, or replace before publishing starts). */
export const CloudOrderCreate = z
  .object({
    contentId: EntityId,
    versionId: EntityId,
    contentHash: ContentHash,
    /** Publish time, UTC (`...Z`). Must be in the future on create/replace. */
    scheduledAt: Timestamp,
    /**
     * Latest time publishing may start (the original publish time + the maximum lateness).
     * A target that could not start by then (the publisher was down, media never arrived)
     * fails with `MISSED` instead of publishing late. Omitted: no limit.
     */
    notAfter: Timestamp.optional(),
    caption: z.string().max(5000).optional(),
    /** Facebook video or LinkedIn document/video title. */
    title: z.string().max(255).optional(),
    isAiGenerated: z.boolean().optional(),
    /** In display order (carousel order). Empty only when every target is `linkedin.text`. */
    media: z.array(CloudOrderMedia).max(21),
    targets: z.array(CloudOrderTargetInput).min(1).max(4),
    /** First comment, location, collaborators … (N13). */
    details: CloudOrderDetails.optional(),
  })
  .refine(
    (o) =>
      o.media.length >= 1 ||
      (o.targets.length > 0 && o.targets.every((t) => t.kind === "linkedin.text")),
    {
      message: "media is required unless every target is linkedin.text",
      path: ["media"],
    },
  )
  .refine((o) => new Set(o.media.map((m) => m.id)).size === o.media.length, {
    message: "media ids must be unique",
    path: ["media"],
  })
  .refine((o) => o.media.filter((m) => m.role !== "cover").length <= 20, {
    message: "at most 20 post media (a cover comes on top)",
    path: ["media"],
  })
  .refine((o) => o.media.filter((m) => m.role === "cover").length <= 1, {
    message: "at most one cover",
    path: ["media"],
  })
  .refine((o) => new Set(o.targets.map((t) => t.id)).size === o.targets.length, {
    message: "target ids must be unique",
    path: ["targets"],
  })
  .meta({ id: "CloudOrderCreate" });
export type CloudOrderCreate = z.input<typeof CloudOrderCreate>;

/**
 * Order status, derived from its targets:
 * - `awaiting_media`: not every declared file is uploaded yet,
 * - `scheduled`: ready, waiting for `scheduledAt`,
 * - `publishing`: at least one target started,
 * - `published` / `failed` / `partially_published`: all targets finished,
 * - `cancelled`.
 */
export const CloudOrderStatus = z
  .enum([
    "awaiting_media",
    "scheduled",
    "publishing",
    "published",
    "partially_published",
    "failed",
    "cancelled",
  ])
  .meta({ id: "CloudOrderStatus" });
export type CloudOrderStatus = z.infer<typeof CloudOrderStatus>;

export const CloudTargetStatus = z
  .enum(["pending", "publishing", "published", "failed", "cancelled"])
  .meta({ id: "CloudTargetStatus" });
export type CloudTargetStatus = z.infer<typeof CloudTargetStatus>;

export const CloudPublishError = z
  .object({
    /** `@studio/publishers` error code (e.g. TOKEN_INVALID) or MEDIA_MISSING. */
    code: z.string(),
    /** Turkish, user-presentable, redacted. */
    message: z.string(),
    action: z.enum(["retry", "reauth", "fix_content", "wait_quota", "manual_check"]),
  })
  .meta({ id: "CloudPublishError" });
export type CloudPublishError = z.infer<typeof CloudPublishError>;

export const CloudOrderTarget = z
  .object({
    id: EntityId,
    platform: CloudPlatform,
    kind: CloudPublishKind,
    accountExternalId: z.string(),
    status: CloudTargetStatus,
    /** 0 before the first try; +1 each time publishing is (re)started. */
    attempts: z.number().int().min(0),
    /** When the scheduler will next touch this target, if it will. */
    nextRunAt: Timestamp.nullable(),
    externalId: z.string().nullable(),
    postId: z.string().nullable(),
    permalink: z.string().nullable(),
    publishedAt: Timestamp.nullable(),
    error: CloudPublishError.nullable(),
    /** Published with warnings (N13: the first comment failed …); absent from older publishers. */
    warnings: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
  })
  .meta({ id: "CloudOrderTarget" });
export type CloudOrderTarget = z.infer<typeof CloudOrderTarget>;

export const CloudOrder = z
  .object({
    id: EntityId,
    contentId: EntityId,
    versionId: EntityId,
    contentHash: ContentHash,
    scheduledAt: Timestamp,
    status: CloudOrderStatus,
    caption: z.string().nullable(),
    title: z.string().nullable(),
    isAiGenerated: z.boolean(),
    media: z.array(CloudOrderMedia.extend({ uploaded: z.boolean() })),
    targets: z.array(CloudOrderTarget),
    /** Absent from older publishers. */
    details: CloudOrderDetails.nullable().optional(),
    cancelledAt: Timestamp.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "CloudOrder" });
export type CloudOrder = z.infer<typeof CloudOrder>;

/**
 * `GET /v1/orders`: ordered by `updatedAt` ascending so the Mac can sync
 * incrementally with `updatedSince` (inclusive) and follow `nextCursor`.
 */
export const CloudOrderListQuery = z.object({
  status: CloudOrderStatus.optional(),
  updatedSince: Timestamp.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  cursor: z.string().min(1).max(512).optional(),
});
export type CloudOrderListQuery = z.input<typeof CloudOrderListQuery>;

export const CloudOrderList = pageOf(CloudOrder, "CloudOrderList");
export type CloudOrderList = z.infer<typeof CloudOrderList>;

export const CloudPublishLogEvent = z
  .enum(["started", "retry_scheduled", "succeeded", "failed", "cancelled"])
  .meta({ id: "CloudPublishLogEvent" });
export type CloudPublishLogEvent = z.infer<typeof CloudPublishLogEvent>;

export const CloudPublishLogEntry = z
  .object({
    /** Monotonic across the whole publisher. */
    seq: z.number().int().positive(),
    orderId: EntityId,
    /** `null` for order-level events (cancel). */
    targetId: EntityId.nullable(),
    attempt: z.number().int().min(0),
    event: CloudPublishLogEvent,
    externalId: z.string().nullable(),
    postId: z.string().nullable(),
    permalink: z.string().nullable(),
    error: CloudPublishError.nullable(),
    /** For `retry_scheduled`: when the next try happens. */
    retryAt: Timestamp.nullable(),
    at: Timestamp,
  })
  .meta({ id: "CloudPublishLogEntry" });
export type CloudPublishLogEntry = z.infer<typeof CloudPublishLogEntry>;

export const CloudPublishLog = z
  .object({ items: z.array(CloudPublishLogEntry) })
  .meta({ id: "CloudPublishLog" });
export type CloudPublishLog = z.infer<typeof CloudPublishLog>;

export const CloudPublisherErrorCode = z
  .enum([
    "unauthorized",
    "validation_error",
    "not_found",
    "conflict",
    "payload_too_large",
    "unsupported_media_type",
    "internal_error",
  ])
  .meta({ id: "CloudPublisherErrorCode" });
export type CloudPublisherErrorCode = z.infer<typeof CloudPublisherErrorCode>;

export const CLOUD_PUBLISHER_ERROR_STATUS = {
  unauthorized: 401,
  validation_error: 400,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  internal_error: 500,
} as const satisfies Record<CloudPublisherErrorCode, number>;

export const CloudPublisherErrorBody = z
  .object({
    error: z.object({
      code: CloudPublisherErrorCode,
      message: z.string(),
      issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    }),
  })
  .meta({ id: "CloudPublisherErrorBody" });
export type CloudPublisherErrorBody = z.infer<typeof CloudPublisherErrorBody>;

export function cloudPlatformOf(kind: CloudPublishKind): CloudPlatform {
  if (kind.startsWith("instagram.")) return "instagram";
  if (kind.startsWith("facebook.")) return "facebook";
  return "linkedin";
}
