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
  scheduleDelivery: ["local", "cloud"],
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
  // --- brand skills ---
  brandSkillOrigin: ["manual", "ai_draft", "restore"],
  // --- generation checks (roadmap 13) ---
  checkTrigger: ["generate", "render", "manual", "fix"],
  checkStrictness: ["relaxed", "standard", "strict"],
  // --- editor documents (the post editor's canvas, 0016) ---
  editorDocumentKind: ["wecra"],
  // --- brand templates and repurposing (N9, N10; 0020) ---
  templateKind: ["html", "canvas"],
  contentSourceKind: ["story", "reel"],
  // --- media tagging (N12, 0022) ---
  assetAnalysisStatus: ["complete", "partial", "failed"],
  // --- statistics and comment inbox (N15, N16; 0023) ---
  postInsightStatus: ["pending", "ok", "partial", "deleted", "error"],
  commentActionKind: ["reply", "hide", "unhide", "delete"],
  commentActionStatus: ["pending", "sending", "done", "failed"],
  knownLocationSource: ["page", "manual", "used"],
  // --- post production (docs/URETIM-RESIM.md Faz 0; 0024) ---
  generationEngine: ["wecra", "html", "svg", "code"],
  approvalKind: ["product_image", "variant", "product_photo_upgrade"],
  approvalStatus: ["pending", "approved", "rejected", "superseded"],
  // --- Mac host settings bridge (iOS Ayarlar; 0027) ---
  hostSettingsChangeStatus: ["pending", "applied", "failed"],
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
    /**
     * Engine the agent uses without asking (0024; null = ask). `ENUMS.generationEngine`; no
     * CHECK (an added column), the API validates it.
     */
    defaultEngine: text("default_engine", { enum: ENUMS.generationEngine }),
    /** Style preset for generated pictures (0024; "" = none). */
    imageStylePreset: text("image_style_preset").notNull().default(""),
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
    /** 1 = legacy (pre-P3 derived secret), 2 = per-install vault key. See lib/token-vault.ts. */
    keyVersion: integer("key_version").notNull().default(1),
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

// --- brand_products ---------------------------------------------------------------
// The brand's products ("Ürünler"): name, short description, category, tags,
// notes and photos (image assets of the same brand, first = cover). Hard-deleted.

export const brandProducts = sqliteTable(
  "brand_products",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    category: text("category").notNull().default(""),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
    notes: text("notes").notNull().default(""),
    imageAssetIds: text("image_asset_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("brand_products_brand_idx").on(t.brandId, t.id)],
);

// --- brand skills (Marka Kiti → Skill'ler) ---------------------------------------
// Markdown instructions the agent follows for one brand. `brand_skills` holds the current
// text (copied from its newest version); every text change appends a `brand_skill_versions`
// row. Names are unique per brand. Deleting a skill deletes its versions.

export const brandSkills = sqliteTable(
  "brand_skills",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    body: text("body").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    version: integer("version").notNull().default(1),
    origin: text("origin", { enum: ENUMS.brandSkillOrigin }).notNull().default("manual"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("brand_skills_brand_name_idx").on(t.brandId, t.name),
    index("brand_skills_brand_idx").on(t.brandId, t.id),
    check("brand_skills_origin_check", oneOf(t.origin, ENUMS.brandSkillOrigin)),
  ],
);

export const brandSkillVersions = sqliteTable(
  "brand_skill_versions",
  {
    id: text("id").primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => brandSkills.id, { onDelete: "cascade" }),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    body: text("body").notNull(),
    origin: text("origin", { enum: ENUMS.brandSkillOrigin }).notNull().default("manual"),
    note: text("note").notNull().default(""),
    jobId: text("job_id"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("brand_skill_versions_skill_version_idx").on(t.skillId, t.version),
    check("brand_skill_versions_origin_check", oneOf(t.origin, ENUMS.brandSkillOrigin)),
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
    /** In the trash since (0019); purged TRASH_RETENTION_DAYS later. Null = not deleted. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("assets_object_key_unique").on(t.objectKey),
    index("assets_brand_idx").on(t.brandId, t.id),
    index("assets_brand_kind_idx").on(t.brandId, t.kind, t.id),
    index("assets_sha256_idx").on(t.sha256),
    index("assets_deleted_idx").on(t.deletedAt),
    check("assets_kind_check", oneOf(t.kind, ENUMS.assetKind)),
    check("assets_source_check", oneOf(t.source, ENUMS.assetSource)),
    check("assets_bytes_check", sql`${t.bytes} >= 0`),
  ],
);

// --- asset analyses (N12, 0022) ------------------------------------------------------
// What Apple's Vision read in a picture on the Mac (the worker's `studio-vision` helper): Turkish
// tags, OCR text, main colours, shape, cutout / logo-like flags, a feature print for "Benzerleri"
// and an optional AI caption. One row per picture; it goes with the asset (cascade on purge).

export const assetAnalyses = sqliteTable(
  "asset_analyses",
  {
    assetId: text("asset_id")
      .primaryKey()
      .references(() => assets.id, { onDelete: "cascade" }),
    status: text("status", { enum: ENUMS.assetAnalysisStatus }).notNull(),
    /** ASSET_ANALYSIS_VERSION the worker used; older ones are redone by the backfill. */
    version: integer("version").notNull(),
    /** AssetTag[] */
    tags: text("tags", { mode: "json" })
      .$type<{ id: string; label: string; confidence: number }[]>()
      .notNull(),
    text: text("text").notNull().default(""),
    /** AssetColor[] */
    colors: text("colors", { mode: "json" })
      .$type<{ hex: string; share: number; name: string }[]>()
      .notNull(),
    /** AssetOrientation; the API validates it. */
    orientation: text("orientation"),
    aspectRatio: real("aspect_ratio"),
    isCutout: integer("is_cutout", { mode: "boolean" }).notNull().default(false),
    isLogoLike: integer("is_logo_like", { mode: "boolean" }).notNull().default(false),
    caption: text("caption"),
    /** Little-endian Float32 values, base64 (Vision feature print). */
    featurePrint: text("feature_print"),
    featureRevision: integer("feature_revision"),
    note: text("note"),
    helperVersion: text("helper_version"),
    analyzedAt: integer("analyzed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    index("asset_analyses_status_idx").on(t.status, t.version),
    check("asset_analyses_status_check", oneOf(t.status, ENUMS.assetAnalysisStatus)),
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
    /** In the trash ("Silinenler") since (0019); purged TRASH_RETENTION_DAYS later. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    /** The brand template the post was made from (N9, 0020). */
    templateId: text("template_id").references((): AnySQLiteColumn => contentTemplates.id, {
      onDelete: "set null",
    }),
    /** The post this one was converted from (N10, 0020), its version and what it became. */
    sourceContentId: text("source_content_id").references((): AnySQLiteColumn => contents.id, {
      onDelete: "set null",
    }),
    sourceVersion: integer("source_version"),
    /** `ENUMS.contentSourceKind`; no CHECK (an added column), the API validates it. */
    sourceKind: text("source_kind", { enum: ENUMS.contentSourceKind }),
    /**
     * Publish details (N13, 0023): first comment, alt texts, location, collaborators, people tags,
     * Reels cover (`PublishDetails` JSON). Not part of the approval.
     */
    publishDetails: text("publish_details", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [
    index("contents_brand_idx").on(t.brandId, t.id),
    index("contents_source_idx").on(t.sourceContentId),
    index("contents_template_idx").on(t.templateId),
    index("contents_brand_status_idx").on(t.brandId, t.status, t.id),
    index("contents_status_idx").on(t.status, t.id),
    index("contents_deleted_idx").on(t.deletedAt),
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
/** Stored shape of `content_version_slides.layers` (mirrors `SlideLayout` in @studio/contract). */
export type SlideLayoutJson = Array<{
  id: string;
  type: string;
  role: string | null;
  parent: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  visible: boolean;
}>;

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
    /** Layer boxes measured in that render (`SlideLayout` JSON); null until measured. */
    layers: text("layers", { mode: "json" }).$type<SlideLayoutJson>(),
  },
  (t) => [
    primaryKey({ columns: [t.versionId, t.position] }),
    index("content_version_slides_asset_idx").on(t.renderedAssetId),
    check("content_version_slides_size_check", sql`${t.width} > 0 and ${t.height} > 0`),
  ],
);

/**
 * The editor's own document of a version (`EditorDocument` in @studio/contract): the post
 * editor's canvas (a Wecra document bundle, an asset of the brand). One per version at most;
 * goes with the version. Not part of the content hash (the slides are rendered from it).
 */
export const contentVersionDocuments = sqliteTable(
  "content_version_documents",
  {
    versionId: text("version_id")
      .primaryKey()
      .references(() => contentVersions.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ENUMS.editorDocumentKind }).notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id),
    format: integer("format").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("content_version_documents_asset_idx").on(t.assetId),
    check("content_version_documents_kind_check", oneOf(t.kind, ENUMS.editorDocumentKind)),
    check("content_version_documents_format_check", sql`${t.format} >= 1`),
  ],
);

// --- brand templates (N9, 0020) ---------------------------------------------------
// An approved post saved as a layout of its brand: a copy of its slides (and, for a canvas
// version, its Wecra document) whose text layers and image slots are fillable fields
// (`TemplateField` JSON). The copy is the template's own: it outlives the post it came from.

/** Stored shape of `content_templates.fields` (mirrors `TemplateField` in @studio/contract). */
export type TemplateFieldJson = {
  key: string;
  label: string;
  kind: "text" | "image";
  role: string | null;
  slide: number;
  layer: string;
  nodeId: string | null;
  layerType: "text" | "slot" | "image";
  example: string;
  maxChars: number | null;
  minFontSize: number | null;
  multiline: boolean;
  ratio: string | null;
  metrics: {
    box: { x: number; y: number; w: number; h: number };
    fontSize: number | null;
    lineHeight: number | null;
    charWidth: number | null;
    lines: number;
    autoResize: "none" | "height" | "width-and-height" | null;
  } | null;
  autoFit: boolean;
  locked: boolean;
};

export const contentTemplates = sqliteTable(
  "content_templates",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    kind: text("kind", { enum: ENUMS.templateKind }).notNull(),
    contentType: text("content_type", { enum: ENUMS.contentType }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    slideCount: integer("slide_count").notNull(),
    fields: text("fields", { mode: "json" }).$type<TemplateFieldJson[]>().notNull(),
    sourceContentId: text("source_content_id").references((): AnySQLiteColumn => contents.id, {
      onDelete: "set null",
    }),
    sourceVersion: integer("source_version").notNull(),
    sourceTitle: text("source_title").notNull().default(""),
    /** Canvas templates: the Wecra bundle (an asset of the brand) and its format. */
    documentAssetId: text("document_asset_id").references(() => assets.id),
    documentFormat: integer("document_format"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("content_templates_brand_idx").on(t.brandId, t.id),
    index("content_templates_document_idx").on(t.documentAssetId),
    check("content_templates_kind_check", oneOf(t.kind, ENUMS.templateKind)),
    check("content_templates_type_check", oneOf(t.contentType, ENUMS.contentType)),
    check("content_templates_slides_check", sql`${t.slideCount} >= 1`),
  ],
);

/** The template's slides (one row each, like a version's). */
export const contentTemplateSlides = sqliteTable(
  "content_template_slides",
  {
    templateId: text("template_id")
      .notNull()
      .references(() => contentTemplates.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
    html: text("html").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    renderedAssetId: text("rendered_asset_id").references(() => assets.id),
    layers: text("layers", { mode: "json" }).$type<SlideLayoutJson>(),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.position] }),
    index("content_template_slides_asset_idx").on(t.renderedAssetId),
    check("content_template_slides_size_check", sql`${t.width} > 0 and ${t.height} > 0`),
  ],
);

// --- generation checks (roadmap 13) ---------------------------------------------
// One row per check run over one content version: the results are a JSON array (at most
// 200 small entries, far below D1's row limit). Summary and blocking count are stored for
// lists. Runs go with their content / version.

/** Stored shape of `content_check_runs.results` (mirrors `ContentCheckResult`). */
export type CheckResultJson = Array<{
  checkId: string;
  category: string;
  status: string;
  message: string;
  refs: Array<{ slide: number | null; layer: string | null }>;
  evidence: Record<string, unknown> | null;
  source: string;
  fixable: boolean;
}>;

export const contentCheckRuns = sqliteTable(
  "content_check_runs",
  {
    id: text("id").primaryKey(),
    contentId: text("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    version: integer("version").notNull(),
    versionId: text("version_id").references(() => contentVersions.id, { onDelete: "cascade" }),
    trigger: text("trigger", { enum: ENUMS.checkTrigger }).notNull(),
    jobId: text("job_id"),
    strictness: text("strictness", { enum: ENUMS.checkStrictness }).notNull().default("standard"),
    summary: text("summary", { mode: "json" })
      .$type<{ pass: number; warn: number; fail: number; fixed: number; skipped: number }>()
      .notNull(),
    blocking: integer("blocking").notNull().default(0),
    results: text("results", { mode: "json" }).$type<CheckResultJson>().notNull(),
    model: text("model"),
    fromVersion: integer("from_version"),
    fixedVersion: integer("fixed_version"),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [
    index("content_check_runs_content_idx").on(t.contentId, t.version, t.id),
    check("content_check_runs_trigger_check", oneOf(t.trigger, ENUMS.checkTrigger)),
    check("content_check_runs_strictness_check", oneOf(t.strictness, ENUMS.checkStrictness)),
    check("content_check_runs_version_positive", sql`${t.version} >= 1`),
  ],
);

/** Per-brand check settings; a brand without a row uses the defaults. */
export const brandCheckSettings = sqliteTable(
  "brand_check_settings",
  {
    brandId: text("brand_id")
      .primaryKey()
      .references(() => brands.id),
    disabledChecks: text("disabled_checks", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default([]),
    bannedWords: text("banned_words", { mode: "json" }).$type<string[]>().notNull().default([]),
    strictness: text("strictness", { enum: ENUMS.checkStrictness }).notNull().default("standard"),
    autoFix: integer("auto_fix", { mode: "boolean" }).notNull().default(true),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("brand_check_settings_strictness_check", oneOf(t.strictness, ENUMS.checkStrictness)),
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
    /** Who publishes it: `cloud` (order pushed) or `local` (Mac worker). Null until decided. */
    delivery: text("delivery", { enum: ENUMS.scheduleDelivery }),
    /** When the order and all its media reached the cloud publisher; null = not (or no longer) there. */
    cloudSyncedAt: integer("cloud_synced_at", { mode: "timestamp_ms" }),
    /** Last publishing-path error (Turkish). */
    lastError: text("last_error"),
    /**
     * Local publishing (Mac worker): the publisher state machine's state, saved before the
     * worker acts on it, so a crashed or retried publish resumes (and reconciles with the
     * platform) instead of posting again. No tokens inside. Null for cloud delivery.
     */
    publishState: text("publish_state", { mode: "json" }).$type<Record<string, unknown>>(),
    /** When the local worker claimed the schedule (or last saved its state): a stale claim is taken over. */
    claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
    /** Platform id of the published post (0023; the statistics and comments are read with it). */
    externalPostId: text("external_post_id"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    /** Warnings of the publish (0023, JSON `[{ code, message }]`; the first comment failed …). */
    publishWarnings: text("publish_warnings", { mode: "json" }).$type<
      { code: string; message: string }[]
    >(),
    /** Bumped when the post's publish details change while pending (0023): re-push the order. */
    detailsRev: integer("details_rev").notNull().default(0),
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
    index("schedules_published_idx").on(t.status, t.publishedAt),
    // One active schedule per content item and account.
    uniqueIndex("schedules_active_unique")
      .on(t.contentId, t.socialAccountId)
      .where(sql`${t.status} in ('pending', 'publishing')`),
    check("schedules_platform_check", oneOf(t.platform, ENUMS.platform)),
    check("schedules_status_check", oneOf(t.status, ENUMS.scheduleStatus)),
  ],
);

/**
 * Publishing path settings (single row, id `main`): the cloud publisher URL and its
 * bearer token (sealed with the token vault), plus the worker's last sync report.
 */
export const publishingSettings = sqliteTable("publishing_settings", {
  id: text("id").primaryKey(),
  cloudUrl: text("cloud_url"),
  cloudTokenCiphertext: text("cloud_token_ciphertext"),
  cloudTokenIv: text("cloud_token_iv"),
  cloudTokenKeyVersion: integer("cloud_token_key_version"),
  syncRequestedAt: integer("sync_requested_at", { mode: "timestamp_ms" }),
  lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
  lastSyncOk: integer("last_sync_ok", { mode: "boolean" }),
  lastSyncError: text("last_sync_error"),
  /** Maximum lateness (S6) in minutes; null = the default (2 hours). */
  maxLatenessMinutes: integer("max_lateness_minutes"),
  updatedAt: updatedAt(),
});

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
    /** Resolved `@product` / `@post` mentions (contract MessageEntityMention[], 0024); null = none. */
    entityMentions: text("entity_mentions", { mode: "json" }).$type<unknown[]>(),
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

/** Stored shape of `plan_items.similar` (mirrors `PlanItemSimilar` in @studio/contract). */
export type PlanItemSimilarJson = {
  kind: "post" | "planned" | "rejected" | "skipped" | "deleted" | "same_plan";
  contentId: string | null;
  planItemId: string | null;
  title: string;
  date: string | null;
  field: "title" | "hook" | "topic";
  score: number;
};

/**
 * Per-brand planning settings (0021, N5): the sector tags whose special days the plan agent and
 * the calendar show, and the special-day categories switched off. A brand without a row uses
 * tags guessed from its profile and products.
 */
export const brandPlanningSettings = sqliteTable("brand_planning_settings", {
  brandId: text("brand_id")
    .primaryKey()
    .references(() => brands.id),
  sectorTags: text("sector_tags", { mode: "json" }).$type<string[]>().notNull().default([]),
  disabledCategories: text("disabled_categories", { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default([]),
  updatedAt: updatedAt(),
});

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
    /** Planned opening line of the post (0021, N6). */
    hook: text("hook"),
    imageSlot: text("image_slot", { enum: ENUMS.imageSlot }).notNull().default("none"),
    imageBrief: text("image_brief"),
    /** A brand template the post is made from (N9, 0020). */
    templateId: text("template_id").references((): AnySQLiteColumn => contentTemplates.id, {
      onDelete: "set null",
    }),
    /** Products the post is about (`string[]` JSON; 0025); null = none (older items). */
    productIds: text("product_ids", { mode: "json" }).$type<string[]>(),
    /** The products' side the AI picture shows (0025); null = any. */
    imageView: text("image_view"),
    /** false: the user makes the post by hand; generation skips it by default (0026). */
    generate: integer("generate", { mode: "boolean" }).notNull().default(true),
    status: text("status", { enum: ENUMS.planItemStatus }).notNull().default("planned"),
    contentId: text("content_id").references(() => contents.id, { onDelete: "set null" }),
    /** Latest content.generate job; its live status is read through a join. */
    generationJobId: text("generation_job_id").references(() => jobs.id, {
      onDelete: "set null",
    }),
    /** Last job status pushed to the stream (change detection only). */
    generationStatus: text("generation_status"),
    /**
     * Near-duplicates found when the item was written (`PlanItemSimilar[]` JSON; 0021, N6);
     * null = none / not checked.
     */
    similar: text("similar", { mode: "json" }).$type<PlanItemSimilarJson[]>(),
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

/**
 * Single-use pairing offers: a 6-digit code and (since QR pairing) a long QR secret that
 * unlock the same claim. Creating a new offer invalidates the unused ones.
 */
export const pairingCodes = sqliteTable(
  "pairing_codes",
  {
    id: text("id").primaryKey(),
    /** Hex SHA-256 of the 6-digit code. */
    codeHash: text("code_hash").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    /** Hex SHA-256 of the QR secret (null for offers made before QR pairing). */
    secretHash: text("secret_hash"),
    secretExpiresAt: integer("secret_expires_at", { mode: "timestamp_ms" }),
    /** Set when claimed or superseded; a used offer never works again (code or secret). */
    usedAt: integer("used_at", { mode: "timestamp_ms" }),
    deviceId: text("device_id").references(() => devices.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    index("pairing_codes_hash_idx").on(t.codeHash),
    index("pairing_codes_secret_idx").on(t.secretHash),
  ],
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

// --- AI providers (roadmap 7 + 11) ------------------------------------------------------------

/**
 * API keys the owner entered in Ayarlar → Yapay zekâ (Gemini, OpenAI), sealed with the token
 * vault (AES-GCM, `TOKEN_ENCRYPTION_KEY`) and bound to the provider name. Only the worker reads
 * the plaintext (`GET /api/worker/ai/credentials`); the apps see `hint` (last 4 characters).
 */
export const aiKeys = sqliteTable("ai_keys", {
  provider: text("provider").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  iv: text("iv").notNull(),
  keyVersion: integer("key_version").notNull(),
  hint: text("hint"),
  /** Result of the last models.list check; null = not checked (or not reachable). */
  valid: integer("valid", { mode: "boolean" }),
  checkedAt: integer("checked_at", { mode: "timestamp_ms" }),
  detail: text("detail"),
  /** JSON array of model ids the key can use (from the last check). */
  models: text("models").notNull().default("[]"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * One row per paid AI call the worker made (today: Gemini API calls), with its token counts
 * and the cost the worker computed from its pricing table. `cost_usd` null = model not priced.
 */
export const aiUsage = sqliteTable(
  "ai_usage",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** chat | generate | brand | image | transcribe | reel | other */
    kind: text("kind").notNull(),
    jobId: text("job_id"),
    runId: text("run_id"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    thoughtsTokens: integer("thoughts_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costUsd: real("cost_usd"),
    /** Date the worker's pricing table was checked (YYYY-MM-DD). */
    pricingVersion: text("pricing_version"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ai_usage_provider_time_idx").on(t.provider, t.occurredAt),
    index("ai_usage_job_idx").on(t.jobId),
  ],
);

// --- statistics (N15, 0023) ------------------------------------------------------------------

/**
 * The latest statistics of one published post on one account (a published schedule), and when
 * they are read next. `comment_count` / `comments_synced_at` belong to the comment inbox (N16):
 * the count Meta reported last time, so unchanged posts are not read again.
 */
export const postInsights = sqliteTable(
  "post_insights",
  {
    scheduleId: text("schedule_id")
      .primaryKey()
      .references(() => schedules.id, { onDelete: "cascade" }),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    contentId: text("content_id")
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    socialAccountId: text("social_account_id")
      .notNull()
      .references(() => socialAccounts.id),
    platform: text("platform", { enum: ENUMS.platform }).notNull(),
    externalPostId: text("external_post_id").notNull(),
    status: text("status", { enum: ENUMS.postInsightStatus }).notNull().default("pending"),
    /** `InsightMetrics` JSON. */
    metrics: text("metrics", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    note: text("note"),
    error: text("error"),
    /** Reads in a row that did not find the post (deleted after two). */
    missCount: integer("miss_count").notNull().default(0),
    syncedAt: integer("synced_at", { mode: "timestamp_ms" }),
    /** Null: no more reads (90 days passed, or deleted). */
    nextSyncAt: integer("next_sync_at", { mode: "timestamp_ms" }),
    commentCount: integer("comment_count"),
    commentsSyncedAt: integer("comments_synced_at", { mode: "timestamp_ms" }),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("post_insights_brand_idx").on(t.brandId),
    index("post_insights_next_idx").on(t.nextSyncAt),
    index("post_insights_content_idx").on(t.contentId),
    check("post_insights_status_check", oneOf(t.status, ENUMS.postInsightStatus)),
  ],
);

/** Every read of a post's statistics (history; the 1 h / 24 h / 72 h / daily points). */
export const insightSnapshots = sqliteTable(
  "insight_snapshots",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    /** Hours after publishing (null when the publish time is unknown). */
    hoursAfter: real("hours_after"),
    metrics: text("metrics", { mode: "json" }).$type<Record<string, number>>().notNull(),
  },
  (t) => [index("insight_snapshots_schedule_idx").on(t.scheduleId, t.at)],
);

/** Follower count of an account per day (Türkiye time). */
export const accountInsights = sqliteTable(
  "account_insights",
  {
    socialAccountId: text("social_account_id")
      .notNull()
      .references(() => socialAccounts.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD. */
    day: text("day").notNull(),
    followers: integer("followers").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.socialAccountId, t.day] })],
);

/**
 * Per account: how the last statistics and comment reads went. A rate limit (`retry_at`) pauses
 * the account; a missing permission or invalid token asks the owner to reconnect it.
 */
export const engagementSync = sqliteTable("engagement_sync", {
  socialAccountId: text("social_account_id")
    .primaryKey()
    .references(() => socialAccounts.id, { onDelete: "cascade" }),
  insightsSyncedAt: integer("insights_synced_at", { mode: "timestamp_ms" }),
  commentsSyncedAt: integer("comments_synced_at", { mode: "timestamp_ms" }),
  /** `ok` | `permission` | `auth` | `rate_limited` | `error` (the last report). */
  status: text("status"),
  error: text("error"),
  retryAt: integer("retry_at", { mode: "timestamp_ms" }),
  updatedAt: updatedAt(),
});

// --- comment inbox (N16, 0023) ----------------------------------------------------------------

export const postComments = sqliteTable(
  "post_comments",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    socialAccountId: text("social_account_id")
      .notNull()
      .references(() => socialAccounts.id),
    platform: text("platform", { enum: ENUMS.platform }).notNull(),
    scheduleId: text("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    contentId: text("content_id").references(() => contents.id, { onDelete: "set null" }),
    externalPostId: text("external_post_id").notNull(),
    externalId: text("external_id").notNull(),
    parentId: text("parent_id"),
    parentExternalId: text("parent_external_id"),
    author: text("author"),
    authorId: text("author_id"),
    text: text("text").notNull(),
    likeCount: integer("like_count"),
    hidden: integer("hidden", { mode: "boolean" }).notNull().default(false),
    /** Written by the account itself (our replies, the first comment). */
    own: integer("own", { mode: "boolean" }).notNull().default(false),
    /** Platform time (or first seen when Meta does not say). */
    createdAt: createdAt(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    readAt: integer("read_at", { mode: "timestamp_ms" }),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    /** "Yanıt öner" draft (never sent by itself). */
    suggestion: text("suggestion"),
    suggestionAt: integer("suggestion_at", { mode: "timestamp_ms" }),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("post_comments_external_unique").on(t.platform, t.externalId),
    index("post_comments_brand_idx").on(t.brandId, t.createdAt),
    index("post_comments_schedule_idx").on(t.scheduleId),
    index("post_comments_content_idx").on(t.contentId),
    index("post_comments_parent_idx").on(t.parentId),
    index("post_comments_unread_idx").on(t.brandId, t.readAt),
    check("post_comments_platform_check", oneOf(t.platform, ENUMS.platform)),
  ],
);

/** Replies, hides and deletes waiting for the worker (it holds the tokens). */
export const commentActions = sqliteTable(
  "comment_actions",
  {
    id: text("id").primaryKey(),
    commentId: text("comment_id")
      .notNull()
      .references(() => postComments.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ENUMS.commentActionKind }).notNull(),
    text: text("text"),
    status: text("status", { enum: ENUMS.commentActionStatus }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    externalId: text("external_id"),
    error: text("error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("comment_actions_status_idx").on(t.status, t.createdAt),
    index("comment_actions_comment_idx").on(t.commentId),
    check("comment_actions_kind_check", oneOf(t.kind, ENUMS.commentActionKind)),
    check("comment_actions_status_check", oneOf(t.status, ENUMS.commentActionStatus)),
  ],
);

/** Known Instagram locations of a brand (N13): its Pages with an address, entered, used. */
export const publishLocations = sqliteTable(
  "publish_locations",
  {
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    locationId: text("location_id").notNull(),
    name: text("name").notNull(),
    source: text("source", { enum: ENUMS.knownLocationSource }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.brandId, t.locationId] }),
    check("publish_locations_source_check", oneOf(t.source, ENUMS.knownLocationSource)),
  ],
);

/**
 * AI settings (single row, id `main`): the owner's monthly budget of every paid AI service (the
 * column keeps its old Gemini name) and the S7 preferences.
 */
export const aiSettings = sqliteTable("ai_settings", {
  id: text("id").primaryKey(),
  geminiMonthlyBudgetUsd: real("gemini_monthly_budget_usd"),
  /** ClaudeLimitMode (`ask` | `gemini` | `wait`); null = `ask`. */
  claudeLimitMode: text("claude_limit_mode"),
  /** Refuse paid calls once this month's spend reached the budget. */
  stopAtBudget: integer("stop_at_budget", { mode: "boolean" }).notNull().default(false),
  /** The owner's answer for the current Claude limit window (ClaudeLimitChoice); null = none. */
  limitChoice: text("limit_choice"),
  limitUntil: integer("limit_until", { mode: "timestamp_ms" }),
  limitDecidedAt: integer("limit_decided_at", { mode: "timestamp_ms" }),
  /** N12 (0022): describe new pictures with the AI (paid, within the budget); off by default. */
  mediaCaptions: integer("media_captions", { mode: "boolean" }).notNull().default(false),
  updatedAt: updatedAt(),
});

// --- approval requests ("Onay bekleyenler", docs/URETIM-RESIM.md; 0024) ----------------------
// A generated picture waiting for the owner's word (contract approval.ts). Rows are kept after
// the decision (history); a post's pending rows make it "Onay bekliyor".

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    brandId: text("brand_id")
      .notNull()
      .references(() => brands.id),
    contentId: text("content_id").references(() => contents.id, { onDelete: "cascade" }),
    /** No foreign key: products are hard-deleted and the history stays. */
    productId: text("product_id"),
    conversationId: text("conversation_id").references(() => conversations.id, {
      onDelete: "set null",
    }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    kind: text("kind", { enum: ENUMS.approvalKind }).notNull(),
    assetIds: text("asset_ids", { mode: "json" }).$type<string[]>().notNull(),
    /** ApprovalCheckReport JSON; null = no check ran. */
    checkReport: text("check_report", { mode: "json" }).$type<Record<string, unknown>>(),
    status: text("status", { enum: ENUMS.approvalStatus }).notNull().default("pending"),
    slotId: text("slot_id"),
    replacesAssetId: text("replaces_asset_id"),
    approvedAssetId: text("approved_asset_id"),
    sourceJobId: text("source_job_id"),
    regenerateJobId: text("regenerate_job_id"),
    /** ApprovalRegenerateRequest JSON (`{ jobType, payload }`); null = cannot regenerate. */
    request: text("request", { mode: "json" }).$type<Record<string, unknown>>(),
    decisionNote: text("decision_note"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("approval_requests_brand_status_idx").on(t.brandId, t.status, t.id),
    index("approval_requests_content_status_idx").on(t.contentId, t.status),
    index("approval_requests_conversation_idx").on(t.conversationId, t.id),
    index("approval_requests_status_idx").on(t.status, t.id),
    check("approval_requests_kind_check", oneOf(t.kind, ENUMS.approvalKind)),
    check("approval_requests_status_check", oneOf(t.status, ENUMS.approvalStatus)),
  ],
);

// --- Mac host settings bridge (iOS Ayarlar; 0027) --------------------------------------------

/** One key change inside a queued host settings change; `sealed` is erased once finished. */
export interface HostKeyChangeRow {
  name: string;
  action: "set" | "remove";
  sealed: { ciphertext: string; iv: string; keyVersion: number } | null;
}

/**
 * Changes a paired phone queued for the Mac app's own settings (routes/host-settings.ts). The Mac
 * app picks pending rows up on its sync and reports each result; secret values are sealed in the
 * token vault and dropped when the row is finished.
 */
export const hostSettingsChanges = sqliteTable(
  "host_settings_changes",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id"),
    /** HostSettingsPatch JSON. */
    values: text("values", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    keys: text("keys", { mode: "json" }).$type<HostKeyChangeRow[]>().notNull(),
    status: text("status", { enum: ENUMS.hostSettingsChangeStatus }).notNull().default("pending"),
    message: text("message"),
    createdAt: createdAt(),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    index("host_settings_changes_status_idx").on(t.status, t.createdAt),
    check("host_settings_changes_status_check", oneOf(t.status, ENUMS.hostSettingsChangeStatus)),
  ],
);
