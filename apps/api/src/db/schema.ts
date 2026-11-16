import { type SQL, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/*
 * Studio data model (task F1-1). Conventions:
 * - ids are text UUIDv7 (time-ordered, see src/lib/ids.ts),
 * - timestamps are integer milliseconds since epoch, UTC,
 * - JSON columns are text,
 * - enum columns carry CHECK constraints with the values below, which must
 *   stay in sync with the zod enums in @studio/contract (a test asserts it).
 */

export const ENUMS = {
  brandStatus: ["active", "archived"],
  platform: ["instagram", "facebook", "linkedin"],
  socialAccountStatus: ["pending", "connected", "needs_reauth", "disabled"],
  brandProfileStatus: ["draft", "approved"],
  assetKind: ["image", "video", "audio", "font", "logo", "other"],
  assetSource: ["upload", "generated", "ingested"],
  contentType: ["post", "carousel", "story", "reel"],
  contentStatus: [
    "draft",
    "in_review",
    "approved",
    "scheduled",
    "publishing",
    "published",
    "failed",
  ],
  versionOrigin: ["generated", "manual_edit", "ai_edit"],
  jobStatus: ["queued", "running", "succeeded", "failed", "cancelled"],
  scheduleStatus: ["pending", "publishing", "published", "failed", "cancelled"],
  publishLogStatus: ["started", "succeeded", "failed"],
} as const;

/** `col in ('a', 'b')` for CHECK constraints (values are constants above, never input). */
function oneOf(column: AnySQLiteColumn, values: readonly string[]): SQL {
  return sql`${column} in (${sql.raw(values.map((v) => `'${v}'`).join(", "))})`;
}

const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull();
const updatedAt = () => integer("updated_at", { mode: "timestamp_ms" }).notNull();

/** Trivial bootstrap table from the skeleton (migration 0000). */
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

// --- brands -------------------------------------------------------------------

export const brands = sqliteTable(
  "brands",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    defaultLanguage: text("default_language").notNull(),
    status: text("status", { enum: ENUMS.brandStatus }).notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("brands_slug_unique").on(t.slug),
    index("brands_status_idx").on(t.status, t.id),
    check("brands_status_check", oneOf(t.status, ENUMS.brandStatus)),
  ],
);

// --- social_accounts ------------------------------------------------------------
// No credentials here. The token vault (Faz 3) gets its own table keyed by
// social_accounts.id so secrets never sit next to ordinary metadata.

export const socialAccounts = sqliteTable(
  "social_accounts",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    platform: text("platform", { enum: ENUMS.platform }).notNull(),
    handle: text("handle").notNull(),
    externalId: text("external_id"),
    status: text("status", { enum: ENUMS.socialAccountStatus }).notNull().default("pending"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("social_accounts_brand_idx").on(t.brandId, t.id),
    // One Studio record per platform-side account (NULL external ids are distinct).
    uniqueIndex("social_accounts_external_unique").on(t.platform, t.externalId),
    check("social_accounts_platform_check", oneOf(t.platform, ENUMS.platform)),
    check("social_accounts_status_check", oneOf(t.status, ENUMS.socialAccountStatus)),
  ],
);

// --- brand_profiles -------------------------------------------------------------

export const brandProfiles = sqliteTable(
  "brand_profiles",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    version: integer("version").notNull(),
    status: text("status", { enum: ENUMS.brandProfileStatus }).notNull().default("draft"),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(false),
    tokens: text("tokens", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    designRules: text("design_rules").notNull().default(""),
    voice: text("voice").notNull().default(""),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("brand_profiles_brand_version_unique").on(t.brandId, t.version),
    // At most one current profile per brand.
    uniqueIndex("brand_profiles_current_unique").on(t.brandId).where(sql`${t.isCurrent} = 1`),
    check("brand_profiles_status_check", oneOf(t.status, ENUMS.brandProfileStatus)),
    check(
      "brand_profiles_current_is_approved",
      sql`${t.isCurrent} = 0 or ${t.status} = 'approved'`,
    ),
    check("brand_profiles_version_positive", sql`${t.version} >= 1`),
  ],
);

// --- assets ---------------------------------------------------------------------

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    kind: text("kind", { enum: ENUMS.assetKind }).notNull(),
    source: text("source", { enum: ENUMS.assetSource }).notNull(),
    objectKey: text("object_key").notNull(),
    mimeType: text("mime_type").notNull(),
    bytes: integer("bytes").notNull(),
    sha256: text("sha256").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    originalFilename: text("original_filename"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("assets_object_key_unique").on(t.objectKey),
    index("assets_brand_idx").on(t.brandId, t.id),
    index("assets_brand_kind_idx").on(t.brandId, t.kind, t.id),
    index("assets_sha256_idx").on(t.sha256),
    check("assets_kind_check", oneOf(t.kind, ENUMS.assetKind)),
    check("assets_source_check", oneOf(t.source, ENUMS.assetSource)),
    check("assets_bytes_check", sql`${t.bytes} >= 0`),
  ],
);

// --- jobs -----------------------------------------------------------------------
// Persistent job records. The Hub DO still keeps its own copy for the demo
// path; F1-6 decides how the two are unified.

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    // No CHECK on type: new job types must not require a table rebuild.
    type: text("type").notNull(),
    status: text("status", { enum: ENUMS.jobStatus }).notNull().default("queued"),
    brandId: text("brand_id").references(() => brands.id),
    contentId: text("content_id").references((): AnySQLiteColumn => contents.id, {
      onDelete: "set null",
    }),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    output: text("output", { mode: "json" }).$type<Record<string, unknown>>(),
    error: text("error"),
    progress: real("progress"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("jobs_status_idx").on(t.status, t.id),
    index("jobs_brand_idx").on(t.brandId, t.id),
    index("jobs_content_idx").on(t.contentId, t.id),
    check("jobs_status_check", oneOf(t.status, ENUMS.jobStatus)),
    check(
      "jobs_progress_range",
      sql`${t.progress} is null or (${t.progress} >= 0 and ${t.progress} <= 1)`,
    ),
  ],
);

// --- contents -------------------------------------------------------------------

export const contents = sqliteTable(
  "contents",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    type: text("type", { enum: ENUMS.contentType }).notNull(),
    title: text("title").notNull(),
    brief: text("brief").notNull().default(""),
    status: text("status", { enum: ENUMS.contentStatus }).notNull().default("draft"),
    targetPlatforms: text("target_platforms", { mode: "json" })
      .$type<Array<(typeof ENUMS.platform)[number]>>()
      .notNull(),
    caption: text("caption").notNull().default(""),
    currentVersionId: text("current_version_id").references(
      (): AnySQLiteColumn => contentVersions.id,
      { onDelete: "set null" },
    ),
    // Approval is bound to a version AND its hash (PLAN.md §8).
    approvedVersionId: text("approved_version_id").references(
      (): AnySQLiteColumn => contentVersions.id,
      { onDelete: "set null" },
    ),
    approvedHash: text("approved_hash"),
    approvedAt: integer("approved_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("contents_brand_idx").on(t.brandId, t.id),
    index("contents_brand_status_idx").on(t.brandId, t.status, t.id),
    index("contents_status_idx").on(t.status, t.id),
    check("contents_type_check", oneOf(t.type, ENUMS.contentType)),
    check("contents_status_check", oneOf(t.status, ENUMS.contentStatus)),
    check(
      "contents_approval_complete",
      sql`(${t.approvedVersionId} is null) = (${t.approvedHash} is null)`,
    ),
  ],
);

// --- content_versions + slides ----------------------------------------------------

export const contentVersions = sqliteTable(
  "content_versions",
  {
    id: text("id").primaryKey(),
    contentId: text("content_id")
      .notNull()
      .references((): AnySQLiteColumn => contents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    origin: text("origin", { enum: ENUMS.versionOrigin }).notNull(),
    contentHash: text("content_hash").notNull(),
    slideCount: integer("slide_count").notNull(),
    note: text("note"),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("content_versions_content_version_unique").on(t.contentId, t.version),
    check("content_versions_origin_check", oneOf(t.origin, ENUMS.versionOrigin)),
    check("content_versions_version_positive", sql`${t.version} >= 1`),
  ],
);

/**
 * One row per slide (rather than a JSON array on the version) so a 20-slide
 * carousel never approaches D1's 2 MB row limit, and so rendered assets are
 * real foreign keys.
 */
export const contentVersionSlides = sqliteTable(
  "content_version_slides",
  {
    versionId: text("version_id")
      .notNull()
      .references(() => contentVersions.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    html: text("html").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    renderedAssetId: text("rendered_asset_id").references(() => assets.id),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.position] }),
    index("content_version_slides_asset_idx").on(t.renderedAssetId),
    check("content_version_slides_size_check", sql`${t.width} > 0 and ${t.height} > 0`),
  ],
);

// --- schedules + publish_logs (tables and reads only; engine is Faz 3) ------------

export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    contentId: text("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    platform: text("platform", { enum: ENUMS.platform }).notNull(),
    socialAccountId: text("social_account_id")
      .notNull()
      .references(() => socialAccounts.id),
    versionId: text("version_id")
      .notNull()
      .references(() => contentVersions.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    scheduledAt: integer("scheduled_at", { mode: "timestamp_ms" }).notNull(),
    status: text("status", { enum: ENUMS.scheduleStatus }).notNull().default("pending"),
    cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // The scheduler's scan: due pending schedules in time order.
    index("schedules_status_time_idx").on(t.status, t.scheduledAt),
    index("schedules_brand_time_idx").on(t.brandId, t.scheduledAt),
    index("schedules_content_idx").on(t.contentId),
    index("schedules_account_idx").on(t.socialAccountId),
    // One active schedule per content item and account.
    uniqueIndex("schedules_active_unique")
      .on(t.contentId, t.socialAccountId)
      .where(sql`${t.status} in ('pending', 'publishing')`),
    check("schedules_platform_check", oneOf(t.platform, ENUMS.platform)),
    check("schedules_status_check", oneOf(t.status, ENUMS.scheduleStatus)),
  ],
);

export const publishLogs = sqliteTable(
  "publish_logs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull(),
    status: text("status", { enum: ENUMS.publishLogStatus }).notNull(),
    externalPostId: text("external_post_id"),
    error: text("error"),
    startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("publish_logs_schedule_attempt_unique").on(t.scheduleId, t.attempt),
    check("publish_logs_status_check", oneOf(t.status, ENUMS.publishLogStatus)),
  ],
);
