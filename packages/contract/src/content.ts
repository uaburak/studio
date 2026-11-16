import { z } from "zod";
import {
  EntityId,
  nonEmptyUpdate,
  PageQuery,
  Platform,
  pageOf,
  Timestamp,
  utf8Length,
} from "./common.ts";

export const ContentType = z
  .enum(["post", "carousel", "story", "reel"])
  .meta({ id: "ContentType" });
export type ContentType = z.infer<typeof ContentType>;

/** Lifecycle from PLAN.md §8. */
export const ContentStatus = z
  .enum(["draft", "in_review", "approved", "scheduled", "publishing", "published", "failed"])
  .meta({ id: "ContentStatus" });
export type ContentStatus = z.infer<typeof ContentStatus>;

// --- State machine -----------------------------------------------------------

/**
 * Every legal status change, whoever triggers it (user, API side effect, or
 * the publishing engine). The server refuses anything else with 409.
 *
 *   draft      -> in_review (submit) | approved (approve by hash)
 *   in_review  -> draft (send back / new version) | approved (approve by hash)
 *   approved   -> draft (revoke / new version / caption change) | scheduled (schedule created)
 *   scheduled  -> approved (last pending schedule cancelled) | draft (new version) | publishing
 *   publishing -> published | failed            (publishing engine, later phase)
 *   published  -> (terminal)
 *   failed     -> draft | approved (retry with the same approval) | scheduled
 */
export const CONTENT_TRANSITIONS = {
  draft: ["in_review", "approved"],
  in_review: ["draft", "approved"],
  approved: ["draft", "scheduled"],
  scheduled: ["approved", "draft", "publishing"],
  publishing: ["published", "failed"],
  published: [],
  failed: ["draft", "approved", "scheduled"],
} as const satisfies Record<ContentStatus, readonly ContentStatus[]>;

export function canTransitionContent(from: ContentStatus, to: ContentStatus): boolean {
  return (CONTENT_TRANSITIONS[from] as readonly ContentStatus[]).includes(to);
}

/**
 * Transitions a user may request directly via `POST /api/contents/{id}/transition`.
 * The others happen only as side effects: approve-by-hash, new version,
 * schedule create/cancel, and the publishing engine.
 */
export const MANUAL_CONTENT_TRANSITIONS = {
  draft: ["in_review"],
  in_review: ["draft"],
  approved: ["draft"],
  scheduled: [],
  publishing: [],
  published: [],
  failed: ["draft", "approved"],
} as const satisfies Record<ContentStatus, readonly ContentStatus[]>;

export function isManualContentTransition(from: ContentStatus, to: ContentStatus): boolean {
  return (MANUAL_CONTENT_TRANSITIONS[from] as readonly ContentStatus[]).includes(to);
}

/** Statuses from which `POST /api/contents/{id}/approve` is accepted. */
export const APPROVABLE_STATUSES = ["draft", "in_review"] as const satisfies ContentStatus[];

/**
 * Statuses in which a new version may be added. Adding one always moves the
 * content to `draft` (approval is tied to the previous version's hash).
 */
export const VERSIONABLE_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "failed",
] as const satisfies ContentStatus[];

/** Statuses from which a schedule may be created (approval must still match). */
export const SCHEDULABLE_STATUSES = [
  "approved",
  "scheduled",
  "failed",
] as const satisfies ContentStatus[];

/** Statuses in which a content item cannot be deleted. */
export const UNDELETABLE_STATUSES = [
  "scheduled",
  "publishing",
  "published",
] as const satisfies ContentStatus[];

export function statusIn<T extends ContentStatus>(
  status: ContentStatus,
  list: readonly T[],
): status is T {
  return (list as readonly ContentStatus[]).includes(status);
}

// --- Slides and versions -----------------------------------------------------

export const MAX_SLIDE_HTML_BYTES = 1_000_000;
export const MAX_ARTBOARD_PX = 4096;

/** Slide count per content type (Instagram allows up to 20 carousel items). */
export const SLIDE_LIMITS = {
  post: { min: 1, max: 1 },
  carousel: { min: 2, max: 20 },
  story: { min: 1, max: 1 },
  reel: { min: 1, max: 20 },
} as const satisfies Record<ContentType, { min: number; max: number }>;

/** Common artboards (PLAN.md §5). Not enforced; any size up to MAX_ARTBOARD_PX is accepted. */
export const ARTBOARDS = {
  portrait: { width: 1080, height: 1350 },
  square: { width: 1080, height: 1080 },
  vertical: { width: 1080, height: 1920 },
} as const;

const ArtboardPx = z.number().int().min(1).max(MAX_ARTBOARD_PX);

export const SlideInput = z
  .object({
    /** Full HTML document following the design contract. */
    html: z
      .string()
      .min(1)
      .refine((s) => utf8Length(s) <= MAX_SLIDE_HTML_BYTES, "slide HTML is too large"),
    width: ArtboardPx,
    height: ArtboardPx,
  })
  .meta({ id: "SlideInput" });
export type SlideInput = z.infer<typeof SlideInput>;

/**
 * Where one `[data-layer]` element sat in the rendered slide: its border box in
 * artboard px (transforms included), as the renderer measured it. Editors draw
 * selection boxes from it; it never affects the content hash.
 */
export const SlideLayerBox = z
  .object({
    /** `data-layer` id. */
    id: z.string().min(1).max(64),
    /** `data-type` (`text`, `image`, `shape`, `logo`, `slot`, `group`; empty when missing). */
    type: z.string().max(16),
    role: z.string().max(32).nullable(),
    /** Enclosing layer (a group), `null` on the artboard. */
    parent: z.string().max(64).nullable(),
    x: z.number().finite(),
    y: z.number().finite(),
    w: z.number().finite().min(0),
    h: z.number().finite().min(0),
    /** Painted (not hidden, not zero-sized). */
    visible: z.boolean(),
  })
  .meta({ id: "SlideLayerBox" });
export type SlideLayerBox = z.infer<typeof SlideLayerBox>;

export const MAX_SLIDE_LAYOUT_LAYERS = 200;

/** Layer boxes of one rendered slide, in document order. */
export const SlideLayout = z
  .array(SlideLayerBox)
  .max(MAX_SLIDE_LAYOUT_LAYERS)
  .meta({ id: "SlideLayout" });
export type SlideLayout = z.infer<typeof SlideLayout>;

export const Slide = z
  .object({
    html: z.string(),
    width: z.number().int(),
    height: z.number().int(),
    /** Rendered image of this slide, once the worker has produced it. */
    renderedAssetId: EntityId.nullable(),
    /**
     * Layer boxes measured in the render that produced `renderedAssetId`
     * (`null` until a render stored them; absent from older servers).
     */
    layers: SlideLayout.nullable().optional(),
  })
  .meta({ id: "Slide" });
export type Slide = z.infer<typeof Slide>;

/** Lowercase hex SHA-256. */
export const ContentHash = z.string().regex(/^[0-9a-f]{64}$/, "expected a hex SHA-256 hash");
export type ContentHash = z.infer<typeof ContentHash>;

/**
 * Canonical content hash of a version: SHA-256 over the ordered slides'
 * `{ width, height, html }` (fixed key order, JSON). Rendered assets and the
 * note are not part of it. The server computes it; clients can recompute it
 * to prove which exact design the user looked at before approving.
 */
export async function computeContentHash(
  slides: ReadonlyArray<Pick<SlideInput, "html" | "width" | "height">>,
): Promise<string> {
  const canonical = JSON.stringify(
    slides.map((s) => ({ width: s.width, height: s.height, html: s.html })),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const ContentVersionOrigin = z
  .enum(["generated", "manual_edit", "ai_edit"])
  .meta({ id: "ContentVersionOrigin" });
export type ContentVersionOrigin = z.infer<typeof ContentVersionOrigin>;

const VersionNote = z.string().max(2_000);
const RenderedAssetIds = z.array(EntityId.nullable()).max(SLIDE_LIMITS.carousel.max);
/** Empty, or one layout per slide (`null` = not measured). */
const SlideLayouts = z.array(SlideLayout.nullable()).max(SLIDE_LIMITS.carousel.max);

export const ContentVersionNumber = z.coerce.number().int().min(1);

/** Version without slide HTML (list responses). */
export const ContentVersionSummary = z
  .object({
    id: EntityId,
    contentId: EntityId,
    /** 1, 2, 3, ... per content item. */
    version: z.number().int().min(1),
    origin: ContentVersionOrigin,
    contentHash: ContentHash,
    slideCount: z.number().int().min(1),
    note: z.string().nullable(),
    /** Job that produced this version, when it was generated. */
    jobId: EntityId.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "ContentVersionSummary" });
export type ContentVersionSummary = z.infer<typeof ContentVersionSummary>;

export const ContentVersion = ContentVersionSummary.extend({
  slides: z.array(Slide),
}).meta({ id: "ContentVersion" });
export type ContentVersion = z.infer<typeof ContentVersion>;

export const ContentVersionCreate = z
  .object({
    origin: ContentVersionOrigin,
    /** Ordered slides; the count must fit SLIDE_LIMITS for the content type. */
    slides: z.array(SlideInput).min(1).max(SLIDE_LIMITS.carousel.max),
    note: VersionNote.optional(),
    jobId: EntityId.optional(),
    /** Empty, or exactly one entry per slide (`null` = not rendered yet). */
    renderedAssetIds: RenderedAssetIds.optional(),
    /** Empty, or exactly one layer layout per slide, measured with `renderedAssetIds`. */
    layouts: SlideLayouts.optional(),
  })
  .meta({ id: "ContentVersionCreate" });
export type ContentVersionCreate = z.input<typeof ContentVersionCreate>;

/**
 * Versions are immutable except for metadata that does not affect the hash:
 * the note, the rendered asset references and their measured layer layouts
 * (renders arrive after creation).
 */
export const ContentVersionUpdate = z
  .object({
    note: VersionNote.nullable().optional(),
    renderedAssetIds: RenderedAssetIds.optional(),
    layouts: SlideLayouts.optional(),
  })
  .refine(nonEmptyUpdate, "at least one field is required")
  .meta({ id: "ContentVersionUpdate" });
export type ContentVersionUpdate = z.input<typeof ContentVersionUpdate>;

export const ContentVersionListQuery = PageQuery;
export type ContentVersionListQuery = z.input<typeof ContentVersionListQuery>;

export const ContentVersionList = pageOf(ContentVersionSummary, "ContentVersionList");
export type ContentVersionList = z.infer<typeof ContentVersionList>;

// --- Content -----------------------------------------------------------------

const Title = z.string().trim().min(1).max(200);
const Brief = z.string().max(20_000);
const Caption = z.string().max(10_000);
const TargetPlatforms = z
  .array(Platform)
  .max(3)
  .refine((list) => new Set(list).size === list.length, "platforms must be unique");

export const ContentVersionRef = z
  .object({
    id: EntityId,
    version: z.number().int().min(1),
    contentHash: ContentHash,
  })
  .meta({ id: "ContentVersionRef" });
export type ContentVersionRef = z.infer<typeof ContentVersionRef>;

export const ContentApproval = z
  .object({
    versionId: EntityId,
    /** Hash the user approved; must equal the current version's hash. */
    contentHash: ContentHash,
    approvedAt: Timestamp,
  })
  .meta({ id: "ContentApproval" });
export type ContentApproval = z.infer<typeof ContentApproval>;

export const Content = z
  .object({
    id: EntityId,
    brandId: EntityId,
    type: ContentType,
    title: z.string(),
    /** The brief / prompt the content was (or will be) generated from. */
    brief: z.string(),
    status: ContentStatus,
    targetPlatforms: z.array(Platform),
    caption: z.string(),
    /** Latest version; `null` until the first version is added. */
    currentVersion: ContentVersionRef.nullable(),
    /** Set while the content is approved (or scheduled/publishing/published/failed). */
    approval: ContentApproval.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Content" });
export type Content = z.infer<typeof Content>;

export const ContentCreate = z
  .object({
    brandId: EntityId,
    type: ContentType,
    title: Title,
    brief: Brief.default(""),
    targetPlatforms: TargetPlatforms.default([]),
    caption: Caption.default(""),
  })
  .meta({ id: "ContentCreate" });
export type ContentCreate = z.input<typeof ContentCreate>;

/**
 * `title` and `brief` can change at any time. Changing `caption` or
 * `targetPlatforms` revokes an existing approval (back to `draft`, pending
 * schedules cancelled) and is refused while publishing or published.
 */
export const ContentUpdate = z
  .object({
    title: Title.optional(),
    brief: Brief.optional(),
    targetPlatforms: TargetPlatforms.optional(),
    caption: Caption.optional(),
  })
  .refine(nonEmptyUpdate, "at least one field is required")
  .meta({ id: "ContentUpdate" });
export type ContentUpdate = z.input<typeof ContentUpdate>;

export const ContentApprove = z.object({ hash: ContentHash }).meta({
  id: "ContentApprove",
  description: "Approve the current version, identified by its hash.",
});
export type ContentApprove = z.input<typeof ContentApprove>;

export const ContentTransition = z
  .object({ to: z.enum(["draft", "in_review", "approved"]) })
  .meta({ id: "ContentTransition" });
export type ContentTransition = z.input<typeof ContentTransition>;

/**
 * `POST /api/contents/{id}/duplicate`: a new draft with the same brief, caption,
 * platforms and a copy of the current version (slides, renders, layouts).
 * Approval and schedules are not copied.
 */
export const ContentDuplicate = z
  .object({
    /** Default: the original title with " (kopya)". */
    title: Title.optional(),
  })
  .meta({ id: "ContentDuplicate" });
export type ContentDuplicate = z.input<typeof ContentDuplicate>;

/**
 * `POST /api/contents/{id}/versions/{version}/restore`: add a new version that is
 * an exact copy of an older one (same slides, so the same hash; renders and
 * layouts are reused). Like any new version it returns the content to draft.
 */
export const ContentVersionRestore = z
  .object({
    /** Default: "vN geri yüklendi." */
    note: VersionNote.optional(),
  })
  .meta({ id: "ContentVersionRestore" });
export type ContentVersionRestore = z.input<typeof ContentVersionRestore>;

export const ContentListQuery = PageQuery.extend({
  brandId: EntityId.optional(),
  status: ContentStatus.optional(),
  type: ContentType.optional(),
});
export type ContentListQuery = z.input<typeof ContentListQuery>;

export const ContentList = pageOf(Content, "ContentList");
export type ContentList = z.infer<typeof ContentList>;
