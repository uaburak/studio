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
  assetKind: ["image", "video", "audio", "document", "font", "logo", "other"],
  assetSource: ["upload", "generated", "ingested"],
  tokenHealth: ["valid", "expiring_soon", "invalid", "missing_scopes", "unchecked"],
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
  // --- chat (A2) ---
  conversationStatus: ["active", "archived"],
  messageRole: ["user", "assistant", "system"],
  messageStatus: ["streaming", "complete", "failed", "cancelled"],
  agentRunStatus: ["queued", "running", "completed", "failed", "cancelled"],
  agentEffort: ["low", "medium", "high", "xhigh"],
  planStatus: ["draft", "proposed", "accepted", "rejected", "superseded"],
  planItemStatus: ["planned", "accepted", "skipped"],
  imageSlot: ["none", "user_upload", "ai_generate"],
  // --- devices (L1) ---
  devicePlatform: ["ios", "ipados", "macos", "other"],
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

// --- social_account_tokens (Faz 3 token vault) ----------------------------------

export const socialAccountTokens = sqliteTable(
  "social_account_tokens",
  {
    socialAccountId: text("social_account_id")
      .primaryKey()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull().default([]),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    health: text("health", { enum: ENUMS.tokenHealth }).notNull().default("valid"),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("social_account_tokens_health_check", oneOf(t.health, ENUMS.tokenHealth))],
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
// The single source of truth for jobs (F1-6). The API inserts rows as
// `queued`; the Hub Durable Object is the only writer after that (dispatch,
// lease, progress, result, cancel) and always uses conditional updates, so a
// restarted Hub can neither lose nor double-dispatch a job.
// Columns added in 0002 have no CHECK constraints on purpose: SQLite cannot
// add a CHECK without rebuilding the table; the API validates the ranges.

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
    // --- queue / dispatch (0002) ---
    /** Higher runs first; FIFO (by id) within the same priority. */
    priority: integer("priority").notNull().default(0),
    /** Dispatches that the worker acknowledged or that ended abnormally. */
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    /** Worker that holds (or last held) the job. */
    workerId: text("worker_id"),
    /** While running: the Hub requeues the job when this passes without a heartbeat. */
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }),
    /** Current assignment was sent at / acknowledged at (null until acked). */
    dispatchedAt: integer("dispatched_at", { mode: "timestamp_ms" }),
    ackedAt: integer("acked_at", { mode: "timestamp_ms" }),
    cancelRequestedAt: integer("cancel_requested_at", { mode: "timestamp_ms" }),
    progressMessage: text("progress_message"),
  },
  (t) => [
    index("jobs_status_idx").on(t.status, t.id),
    index("jobs_queue_idx").on(t.status, t.priority, t.id),
    index("jobs_lease_idx").on(t.status, t.leaseExpiresAt),
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
    permalink: text("permalink"),
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
    permalink: text("permalink"),
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

// --- chat (task A2): conversations, messages, agent runs, stream events ---------------
// All writes to these tables happen inside the Hub Durable Object's serial
// queue (src/chat/service.ts), so check-then-write sequences cannot race and
// stream sequence numbers are assigned without gaps. Every change is written
// together with its stream event(s) in one D1 batch (a transaction).

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id").references(() => brands.id),
    title: text("title").notNull().default(""),
    status: text("status", { enum: ENUMS.conversationStatus }).notNull().default("active"),
    /** Seq of the last event in conversation_events (0 = none). */
    lastSeq: integer("last_seq").notNull().default(0),
    lastActivityAt: integer("last_activity_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /**
     * Claude Code session of the last completed agent turn (A5): its id, the
     * number of messages it had seen, the run and when. All null = none.
     */
    agentSessionId: text("agent_session_id"),
    agentSessionMessages: integer("agent_session_messages"),
    agentSessionRunId: text("agent_session_run_id"),
    agentSessionAt: integer("agent_session_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("conversations_activity_idx").on(t.lastActivityAt, t.id),
    index("conversations_brand_activity_idx").on(t.brandId, t.lastActivityAt, t.id),
    check("conversations_status_check", oneOf(t.status, ENUMS.conversationStatus)),
    check("conversations_last_seq_check", sql`${t.lastSeq} >= 0`),
  ],
);

/**
 * Parts are one JSON array per message (typed by the contract's MessagePart
 * union): a message is always read and written as a whole, and the Hub
 * serialises writes, so appending a text delta is a read-modify-write of one
 * row. `delta_seqs[i]` is the last applied text-delta seq of part i.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ENUMS.messageRole }).notNull(),
    status: text("status", { enum: ENUMS.messageStatus }).notNull(),
    runId: text("run_id").references((): AnySQLiteColumn => agentRuns.id, {
      onDelete: "set null",
    }),
    parts: text("parts", { mode: "json" }).$type<unknown[]>().notNull(),
    deltaSeqs: text("delta_seqs", { mode: "json" }).$type<number[]>().notNull(),
    /** Resolved `@alias` mentions of a user message (contract MessageMention[]); null = none. */
    mentions: text("mentions", { mode: "json" }).$type<unknown[]>(),
    /** Idempotency key of a user message (unique per conversation). */
    clientMessageId: text("client_message_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.id),
    uniqueIndex("messages_client_id_unique").on(t.conversationId, t.clientMessageId),
    // One assistant message per run.
    uniqueIndex("messages_run_assistant_unique").on(t.runId).where(sql`${t.role} = 'assistant'`),
    check("messages_role_check", oneOf(t.role, ENUMS.messageRole)),
    check("messages_status_check", oneOf(t.status, ENUMS.messageStatus)),
  ],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    triggerMessageId: text("trigger_message_id")
      .notNull()
      .references((): AnySQLiteColumn => messages.id, { onDelete: "cascade" }),
    jobId: text("job_id").references(() => jobs.id, { onDelete: "set null" }),
    status: text("status", { enum: ENUMS.agentRunStatus }).notNull().default("queued"),
    /** Worker attempt that currently writes (0 until started). */
    attempt: integer("attempt").notNull().default(0),
    /** Requested model (opus / sonnet / haiku) until the worker reports the one it used. */
    model: text("model"),
    /** Requested reasoning effort (low / medium / high / xhigh); null = worker default. */
    effort: text("effort", { enum: ENUMS.agentEffort }),
    usage: text("usage", { mode: "json" }).$type<Record<string, unknown>>(),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("agent_runs_conversation_idx").on(t.conversationId, t.id),
    index("agent_runs_job_idx").on(t.jobId),
    // At most one queued/running run per conversation.
    uniqueIndex("agent_runs_active_unique")
      .on(t.conversationId)
      .where(sql`${t.status} in ('queued', 'running')`),
    check("agent_runs_status_check", oneOf(t.status, ENUMS.agentRunStatus)),
    check("agent_runs_attempt_check", sql`${t.attempt} >= 0`),
  ],
);

/** The conversation stream's durable log: replayed on resume (`?after=`). */
export const conversationEvents = sqliteTable(
  "conversation_events",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    /** The stream frame without `seq`. */
    data: text("data", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.seq] }),
    check("conversation_events_seq_check", sql`${t.seq} >= 1`),
  ],
);

/**
 * Attachment aliases (task A2b): one row per (conversation, asset), holding
 * the current name. Written only in the Hub's serial queue, like messages.
 */
export const conversationAliases = sqliteTable(
  "conversation_aliases",
  {
    /** Stable alias id (survives renames). */
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id),
    /** Current name: lower-case, unique in the conversation. */
    alias: text("alias").notNull(),
    /** Message whose attachment introduced the alias. */
    messageId: text("message_id").references((): AnySQLiteColumn => messages.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversation_aliases_name_unique").on(t.conversationId, t.alias),
    uniqueIndex("conversation_aliases_asset_unique").on(t.conversationId, t.assetId),
    check(
      "conversation_aliases_alias_check",
      sql`length(${t.alias}) between 1 and 40 and ${t.alias} = lower(${t.alias})`,
    ),
  ],
);

/**
 * Every name ever given to an alias of a conversation (current and earlier).
 * The primary key makes a name unusable for any other asset, forever.
 */
export const conversationAliasNames = sqliteTable(
  "conversation_alias_names",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    aliasId: text("alias_id")
      .notNull()
      .references(() => conversationAliases.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.name] }),
    index("conversation_alias_names_alias_idx").on(t.aliasId),
  ],
);

// --- content plans ---------------------------------------------------------------------

export const contentPlans = sqliteTable(
  "content_plans",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    runId: text("run_id").references(() => agentRuns.id, { onDelete: "set null" }),
    title: text("title").notNull().default(""),
    /** Inclusive `YYYY-MM-DD` dates. */
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    status: text("status", { enum: ENUMS.planStatus }).notNull(),
    summary: text("summary").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("content_plans_conversation_idx").on(t.conversationId, t.id),
    index("content_plans_brand_idx").on(t.brandId, t.id),
    index("content_plans_status_idx").on(t.status, t.id),
    check("content_plans_status_check", oneOf(t.status, ENUMS.planStatus)),
    check("content_plans_period_check", sql`${t.periodStart} <= ${t.periodEnd}`),
    check("content_plans_revision_check", sql`${t.revision} >= 1`),
  ],
);

export const planItems = sqliteTable(
  "plan_items",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => contentPlans.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    date: text("date"),
    platforms: text("platforms", { mode: "json" })
      .$type<Array<(typeof ENUMS.platform)[number]>>()
      .notNull(),
    contentType: text("content_type", { enum: ENUMS.contentType }).notNull(),
    title: text("title").notNull(),
    brief: text("brief").notNull().default(""),
    pillar: text("pillar"),
    imageSlot: text("image_slot", { enum: ENUMS.imageSlot }).notNull().default("none"),
    imageBrief: text("image_brief"),
    status: text("status", { enum: ENUMS.planItemStatus }).notNull().default("planned"),
    contentId: text("content_id").references(() => contents.id, { onDelete: "set null" }),
    /** Latest content.generate job; its live status is read through a join. */
    generationJobId: text("generation_job_id").references(() => jobs.id, {
      onDelete: "set null",
    }),
    /** Last job status pushed to the stream (change detection only). */
    generationStatus: text("generation_status"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("plan_items_plan_idx").on(t.planId, t.position),
    index("plan_items_content_idx").on(t.contentId),
    index("plan_items_job_idx").on(t.generationJobId),
    check("plan_items_type_check", oneOf(t.contentType, ENUMS.contentType)),
    check("plan_items_slot_check", oneOf(t.imageSlot, ENUMS.imageSlot)),
    check("plan_items_status_check", oneOf(t.status, ENUMS.planItemStatus)),
    check("plan_items_position_check", sql`${t.position} >= 0`),
  ],
);

// --- devices and pairing (L1) ------------------------------------------------------
// The API runs on the owner's Mac. Phones pair once with a short code shown in
// the Mac app and then send a long random bearer token; only its SHA-256 hash
// is stored. See src/middleware/access.ts and src/routes/devices.ts.

export const devices = sqliteTable(
  "devices",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    platform: text("platform", { enum: ENUMS.devicePlatform }).notNull().default("other"),
    /** Hex SHA-256 of the bearer token. */
    tokenHash: text("token_hash").notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("devices_token_hash_idx").on(t.tokenHash),
    check("devices_platform_check", oneOf(t.platform, ENUMS.devicePlatform)),
  ],
);

/** Single-use codes; creating a new one invalidates the unused ones. */
export const pairingCodes = sqliteTable(
  "pairing_codes",
  {
    id: text("id").primaryKey(),
    /** Hex SHA-256 of the 6-digit code. */
    codeHash: text("code_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    /** Set when claimed or superseded; a used code never works again. */
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    deviceId: text("device_id").references(() => devices.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("pairing_codes_hash_idx").on(t.codeHash)],
);

/** Failed claims, for rate limiting (per client address and in total). */
export const pairingFailures = sqliteTable(
  "pairing_failures",
  {
    id: text("id").primaryKey(),
    clientIp: text("client_ip").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("pairing_failures_time_idx").on(t.createdAt),
    index("pairing_failures_client_idx").on(t.clientIp, t.createdAt),
  ],
);
