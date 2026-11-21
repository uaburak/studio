import { z } from "zod";
import { ClaudeAccount, GeminiAccount } from "./agent.ts";
import { AiProviderStatus } from "./ai.ts";
import { MediaAnalyzePayload } from "./asset-analysis.ts";
import { BrandSkillDraftPayload } from "./brand-skill.ts";
import {
  AgentEffort,
  AgentModel,
  EntityId,
  jsonWithin,
  PageQuery,
  pageOf,
  Timestamp,
} from "./common.ts";
import { ContentVersionOrigin, MAX_ARTBOARD_PX, SLIDE_LIMITS } from "./content.ts";
import { ContentCheckPayload } from "./content-check.ts";
import { CommentsSuggestPayload, CommentsSyncPayload, InsightsSyncPayload } from "./engagement.ts";
import { ApprovalTarget, MAX_GENERATION_VARIANTS } from "./generation.ts";
import { ReelSpecPatch } from "./reel.ts";
import { ToolInstallPayload, ToolStatus, ToolUninstallPayload } from "./tools.ts";

export const JobId = z.string().min(1).max(128);
export type JobId = z.infer<typeof JobId>;

/**
 * Known job types. Extend this enum as the worker learns new work.
 * - `demo.echo` exists only to prove the hub <-> worker round trip.
 * - `content.generate`, `content.render`, `brand.analyze` are reserved for
 *   the generation pipeline (F1-3) and brand profiling (F1-4); their payload
 *   schemas are defined by those tasks. Until then the payload is free-form.
 *   (`ContentGeneratePayload` in plan.ts describes what plan generation sends.)
 * - `image.generate` generates visual assets via Gemini image models.
 * - `schedule.publish` publishes a due schedule from the local worker.
 * - `chat.turn` runs one agent turn of a conversation (A2). Only the API
 *   creates it (when a user message or answer arrives); `POST /api/jobs`
 *   refuses it. Payload: `ChatTurnPayload`.
 * - `brand.skill_draft` drafts a brand skill with AI (`BrandSkillDraftPayload`).
 * - `content.check` runs the generation checks on a version and fixes the fixable findings on
 *   request (`ContentCheckPayload`, roadmap 13).
 * - `canvas.read` / `canvas.apply` read and edit a canvas version's Wecra document (S1) with
 *   Wecra's own design operations. They run in the Mac app's hidden canvas runner (Wecra's
 *   engine, in an Electron page), not in the worker: `CANVAS_JOB_TYPES`. `canvas.create` makes a
 *   post's version from a blank Wecra document (one frame per slide), optionally designed at once
 *   with the same operations (the Wecra engine's first pass, "Boş tuvalden yeni post").
 * - `content.details` ("Bilgileri üret") writes a post's caption, hashtags, title and publish
 *   details from its rendered design, never touching the design (no version).
 * - `media.analyze` tags uploaded pictures on the Mac with Apple's Vision (N12,
 *   `MediaAnalyzePayload`); the API queues it after an upload and for the backfill.
 * - `insights.sync` reads published posts' statistics and follower counts (N15),
 *   `comments.sync` sends queued replies and reads new comments (N16) — the Hub queues both
 *   while the worker is connected; `comments.suggest` drafts a reply with AI (never sent).
 * - `tool.install` / `tool.uninstall` install or remove one of the tools Studio uses (ffmpeg,
 *   Claude Code, Python …) on the Mac from its official source (tools.ts, `ToolInstallPayload`).
 */
export const JobType = z
  .enum([
    "demo.echo",
    "content.generate",
    "content.render",
    "brand.analyze",
    "image.generate",
    "schedule.publish",
    "chat.turn",
    "brand.skill_draft",
    "content.check",
    "canvas.read",
    "canvas.apply",
    "canvas.create",
    "media.analyze",
    "insights.sync",
    "comments.sync",
    "comments.suggest",
    "content.details",
    "tool.install",
    "tool.uninstall",
  ])
  .meta({ id: "JobType" });
export type JobType = z.infer<typeof JobType>;

export const JobStatus = z
  .enum(["queued", "running", "succeeded", "failed", "cancelled"])
  .meta({ id: "JobStatus" });
export type JobStatus = z.infer<typeof JobStatus>;

/** Which references a job type needs at creation time. */
export const JOB_TYPE_REQUIREMENTS = {
  "demo.echo": { brand: false, content: false },
  "content.generate": { brand: true, content: true },
  "content.render": { brand: true, content: true },
  "brand.analyze": { brand: true, content: false },
  "image.generate": { brand: true, content: false },
  "schedule.publish": { brand: true, content: true },
  "chat.turn": { brand: false, content: false },
  "brand.skill_draft": { brand: true, content: false },
  "content.check": { brand: true, content: true },
  "canvas.read": { brand: true, content: true },
  "canvas.apply": { brand: true, content: true },
  "canvas.create": { brand: true, content: true },
  "media.analyze": { brand: false, content: false },
  "insights.sync": { brand: false, content: false },
  "comments.sync": { brand: false, content: false },
  "comments.suggest": { brand: true, content: false },
  "content.details": { brand: true, content: true },
  "tool.install": { brand: false, content: false },
  "tool.uninstall": { brand: false, content: false },
} as const satisfies Record<JobType, { brand: boolean; content: boolean }>;

export const MAX_JOB_PAYLOAD_BYTES = 100_000;
export const JOB_PRIORITY_MIN = -100;
export const JOB_PRIORITY_MAX = 100;
export const DEFAULT_JOB_MAX_ATTEMPTS = 3;
export const MAX_JOB_ATTEMPTS = 10;

/** Statuses a job never leaves. */
export const TERMINAL_JOB_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly JobStatus[];
export function isTerminalJobStatus(status: JobStatus): boolean {
  return (TERMINAL_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

export const Job = z
  .object({
    id: JobId,
    type: JobType,
    status: JobStatus,
    /** Type-specific input. Validate with the per-type payload schema. */
    payload: z.record(z.string(), z.unknown()),
    /** Brand the job works for (absent for brand-less jobs such as `demo.echo`). */
    brandId: EntityId.optional(),
    /** Content item the job works on, when relevant. */
    contentId: EntityId.optional(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    startedAt: Timestamp.optional(),
    finishedAt: Timestamp.optional(),
    /** 0..1, last reported progress. */
    progress: z.number().min(0).max(1).optional(),
    /** Type-specific output (the job result) when status is `succeeded`. */
    output: z.record(z.string(), z.unknown()).optional(),
    /** Human-readable error when status is `failed`. */
    error: z.string().optional(),
    // --- queue fields (F1-6); optional so older producers stay valid ---
    /** Higher runs first; FIFO within the same priority. Default 0. */
    priority: z.number().int().optional(),
    /** Dispatch attempts so far (an attempt counts once the worker acknowledged it). */
    attempts: z.number().int().min(0).optional(),
    /** After this many lost attempts the job fails. */
    maxAttempts: z.number().int().min(1).optional(),
    /** Worker that runs (or last ran) the job. */
    workerId: z.string().optional(),
    /** Message attached to the last progress report. */
    progressMessage: z.string().optional(),
    /** Set while a cancel is pending on the worker (status is still `running`). */
    cancelRequestedAt: Timestamp.optional(),
  })
  .meta({ id: "Job" });
export type Job = z.infer<typeof Job>;

export const JobCreate = z
  .object({
    type: JobType,
    payload: z
      .record(z.string(), z.unknown())
      .refine(jsonWithin(MAX_JOB_PAYLOAD_BYTES), "payload is too large")
      .default({}),
    /** Required for brand/content jobs; derived from `contentId` when omitted. */
    brandId: EntityId.optional(),
    contentId: EntityId.optional(),
    /** Higher runs first (default 0); FIFO within the same priority. */
    priority: z.number().int().min(JOB_PRIORITY_MIN).max(JOB_PRIORITY_MAX).optional(),
    /** Attempts before the job fails when its worker keeps disappearing (default 3). */
    maxAttempts: z.number().int().min(1).max(MAX_JOB_ATTEMPTS).optional(),
  })
  .meta({ id: "JobCreate" });
export type JobCreate = z.input<typeof JobCreate>;

export const JobListQuery = PageQuery.extend({
  brandId: EntityId.optional(),
  contentId: EntityId.optional(),
  status: JobStatus.optional(),
  type: JobType.optional(),
});
export type JobListQuery = z.input<typeof JobListQuery>;

export const JobList = pageOf(Job, "JobList");
export type JobList = z.infer<typeof JobList>;

// --- demo.echo -------------------------------------------------------------

export const DemoEchoPayload = z.object({
  text: z.string().max(10_000),
  /** Optional artificial duration, to exercise progress, cancel and requeue. */
  delayMs: z.number().int().min(0).max(600_000).optional(),
  /** Progress reports spread over `delayMs` (default 4). */
  steps: z.number().int().min(1).max(100).optional(),
});
export type DemoEchoPayload = z.infer<typeof DemoEchoPayload>;

export const DemoEchoOutput = z.object({
  text: z.string(),
  reversed: z.string(),
  workerId: z.string(),
});
export type DemoEchoOutput = z.infer<typeof DemoEchoOutput>;

// --- chat.turn (A2) ------------------------------------------------------------

/**
 * One agent turn. The worker reads everything else through the turn API
 * (`POST /api/worker/runs/{runId}/start` returns the full context).
 */
export const ChatTurnPayload = z
  .object({
    conversationId: EntityId,
    runId: EntityId,
  })
  .meta({ id: "ChatTurnPayload" });
export type ChatTurnPayload = z.infer<typeof ChatTurnPayload>;

// --- content.render / image.generate / brand.analyze / schedule.publish --------

/**
 * `content.render`:
 * - with `slotAssignments` / `patches` (design-kit patch ops, each with a `slide`
 *   index): a new `manual_edit` version based on `version` (default: current) is
 *   stored and rendered; unchanged slides keep their renders;
 * - `jpeg` without edits: renders slides that have no render or no measured
 *   layout yet (`force` re-renders all) and stores them on that version;
 * - `png`: lossless exports (`pngAssetIds`, one per slide, `null` for slides not
 *   in `slides`); the version is not changed;
 * - `pdf` / `both`: one multi-page PDF (`pdfAssetId`).
 */
export const ContentRenderPayload = z
  .object({
    version: z.number().int().min(1).optional(),
    format: z.enum(["jpeg", "png", "pdf", "both", "mp4"]).default("jpeg"),
    slotAssignments: z.record(z.string(), EntityId).optional(),
    patches: z.array(z.record(z.string(), z.unknown())).optional(),
    /** Slide indexes (0-based) to export as PNG; default all. */
    slides: z.array(z.number().int().min(0).max(19)).max(20).optional(),
    /** Re-render every slide even when renders exist. */
    force: z.boolean().optional(),
    /** Note stored on the new version (edits only). */
    note: z.string().max(2_000).optional(),
    /**
     * Reels: edits to the version's `ReelSpec` (texts, timings, duration). The video is
     * re-rendered without AI and stored as a new `manual_edit` version.
     */
    reel: ReelSpecPatch.optional(),
  })
  .meta({ id: "ContentRenderPayload" });
export type ContentRenderPayload = z.infer<typeof ContentRenderPayload>;
export type ContentRenderPayloadInput = z.input<typeof ContentRenderPayload>;

/**
 * Where the real product goes in a label-preserving composite (U9). `auto`: the emptiest of the
 * usual spots in the generated scene (Vision saliency), lower centre when that cannot be read.
 */
export const ProductPosition = z
  .enum(["auto", "center", "bottom-center", "bottom-left", "bottom-right", "left", "right"])
  .meta({ id: "ProductPosition" });
export type ProductPosition = z.infer<typeof ProductPosition>;

export const ImageGeneratePayload = z
  .object({
    prompt: z.string().trim().min(1).max(4000),
    aspectRatio: z.enum(["4:5", "9:16", "1:1"]).default("4:5"),
    imageSize: z.enum(["1K", "2K"]).default("2K"),
    referenceAssetIds: z.array(EntityId).max(10).default([]),
    preserveProductLabel: z.boolean().default(false),
    targetContentId: EntityId.optional(),
    targetSlotId: z.string().max(128).optional(),
    model: z.string().max(128).optional(),
    /** Label preservation (U9): where the product is placed in the scene. */
    productPosition: ProductPosition.optional(),
    /** Label preservation (U9): the product's height as a share of the picture's (0.2…0.9). */
    productScale: z.number().min(0.2).max(0.9).optional(),
    /**
     * Label preservation (U9): the label's exact text when the owner has it (more reliable than
     * reading the photo); checked against the final picture.
     */
    labelText: z.string().trim().max(4000).optional(),
    /**
     * Ask the owner before the picture is used: the result becomes an approval request of this
     * kind (`POST /api/worker/approvals`) instead of filling `targetSlotId` right away.
     */
    approval: ApprovalTarget.optional(),
    /**
     * The products the picture shows (docs/URETIM-RESIM.md §8–9): their reference photos are
     * read and described exactly (label text verbatim, colours, shape…) into the prompt — the
     * model may change only framing, setting, ambience, light and quality — and the result is
     * checked against them by the AI (`checkReport`).
     */
    productIds: z.array(EntityId).max(4).optional(),
    /**
     * This picture's style ("vintage", "retro"). Absent: the brand's `imageStylePreset`; "" = no
     * style at all.
     */
    style: z.string().trim().max(500).optional(),
    /** One of N variants asked for at once (each its own job and approval request). */
    variant: z
      .object({
        index: z.number().int().min(1).max(MAX_GENERATION_VARIANTS),
        count: z.number().int().min(1).max(MAX_GENERATION_VARIANTS),
      })
      .optional(),
  })
  .meta({ id: "ImageGeneratePayload" });
export type ImageGeneratePayload = z.infer<typeof ImageGeneratePayload>;
export type ImageGeneratePayloadInput = z.input<typeof ImageGeneratePayload>;

export const BrandAnalyzePayload = z
  .object({
    notes: z.string().max(10_000).optional(),
    samplePosts: z
      .array(
        z.object({
          caption: z.string().max(4000),
          imageAssetId: EntityId.optional(),
          likes: z.number().int().nonnegative().optional(),
          comments: z.number().int().nonnegative().optional(),
        }),
      )
      .max(30)
      .default([]),
    includeApprovedContentFeedback: z.boolean().default(true),
    autoApprove: z.boolean().default(false),
    model: AgentModel.optional(),
    effort: AgentEffort.optional(),
  })
  .meta({ id: "BrandAnalyzePayload" });
export type BrandAnalyzePayload = z.infer<typeof BrandAnalyzePayload>;
export type BrandAnalyzePayloadInput = z.input<typeof BrandAnalyzePayload>;

export const SchedulePublishPayload = z
  .object({
    scheduleId: EntityId,
  })
  .meta({ id: "SchedulePublishPayload" });
export type SchedulePublishPayload = z.infer<typeof SchedulePublishPayload>;

// --- canvas.read / canvas.apply (S1) ------------------------------------------------------
//
// A version saved from the post editor's canvas has a Wecra document (`editorDocument`): that
// document is the design. The chat agent reads it (`canvas.read`, or the facts its slide HTML
// carries) and edits it with Wecra's own design operations (`canvas.apply`): each operation is
// one of Wecra's MCP write tools with its arguments, as Wecra's agents call them (Figma's Plugin
// API vocabulary: `update_nodes {updates: [{nodeId, characters, fills, fontSize …}]}` …). The
// Mac app's canvas runner (a hidden Electron page with Wecra's engine) loads the version's
// document, applies them, exports the slides and stores a new `ai_edit` version whose document is
// the edited one — the hand edits made on the canvas stay.

/** Job types the Mac app's canvas runner executes (Wecra's engine), never the worker. */
export const CANVAS_JOB_TYPES = [
  "canvas.read",
  "canvas.apply",
  "canvas.create",
] as const satisfies readonly JobType[];

/**
 * A connected worker that only runs canvas jobs: the Mac app's canvas runner. It is not "the Mac
 * worker" (presence `online`, Claude / Gemini commands): only the jobs it announces go to it.
 */
export function isCanvasRunner(capabilities: readonly string[]): boolean {
  return (
    capabilities.length > 0 &&
    capabilities.every((c) => (CANVAS_JOB_TYPES as readonly string[]).includes(c))
  );
}

/** Wecra's MCP write tools a `canvas.apply` operation may name. */
export const CANVAS_EDIT_TOOLS = [
  "update_nodes",
  "create_nodes",
  "set_properties",
  "delete_nodes",
  "duplicate_nodes",
  "reparent_nodes",
  "set_auto_layout",
  "place_image",
] as const;
export type CanvasEditTool = (typeof CANVAS_EDIT_TOOLS)[number];

export const MAX_CANVAS_OPERATIONS = 60;

export const CanvasOperation = z
  .object({
    tool: z.enum(CANVAS_EDIT_TOOLS),
    /**
     * The tool's arguments as Wecra's MCP server takes them. `place_image` takes `assetId` (a
     * picture of the brand's media) instead of a file path or the bytes.
     */
    args: z.record(z.string(), z.unknown()).default({}),
  })
  .meta({ id: "CanvasOperation" });
export type CanvasOperation = z.infer<typeof CanvasOperation>;

export const CanvasApplyPayload = z
  .object({
    /**
     * The version the operations were written against. It must still be the post's current
     * version, else the job fails without a change (the post was edited meanwhile: read again).
     */
    version: z.number().int().min(1),
    operations: z.array(CanvasOperation).min(1).max(MAX_CANVAS_OPERATIONS),
    /** The new version's note (default "AI tuvalde düzenledi."). */
    note: z.string().trim().max(500).optional(),
    /** The conversation that asked for it. */
    conversationId: EntityId.optional(),
  })
  .meta({ id: "CanvasApplyPayload" });
export type CanvasApplyPayload = z.infer<typeof CanvasApplyPayload>;
export type CanvasApplyPayloadInput = z.input<typeof CanvasApplyPayload>;

/** What one operation did (Wecra's own read back: what was applied, refused, did not take). */
export const CanvasOperationResult = z
  .object({
    tool: z.enum(CANVAS_EDIT_TOOLS),
    ok: z.boolean(),
    /** Wecra's summary line ("update_nodes: everything applied." …), or the error. */
    summary: z.string().max(2_000),
    /** Layers it changed or made. */
    touched: z.array(z.string()).max(200).default([]),
  })
  .meta({ id: "CanvasOperationResult" });
export type CanvasOperationResult = z.infer<typeof CanvasOperationResult>;

export const CanvasApplyOutput = z
  .object({
    contentId: EntityId,
    /** The new version (the edited document, its renders). */
    version: z.number().int().min(1),
    baseVersion: z.number().int().min(1),
    results: z.array(CanvasOperationResult).max(MAX_CANVAS_OPERATIONS),
    slides: z.number().int().min(1),
    /** The `content.check` job over the new version (null: it could not be queued). */
    checkJobId: JobId.nullable(),
  })
  .meta({ id: "CanvasApplyOutput" });
export type CanvasApplyOutput = z.infer<typeof CanvasApplyOutput>;

export const CanvasReadPayload = z
  .object({
    /** Default: the post's current version. */
    version: z.number().int().min(1).optional(),
    /** Layers to read in full (Wecra's `get_design_context`: layout, effects, constraints …). */
    nodeIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  })
  .meta({ id: "CanvasReadPayload" });
export type CanvasReadPayload = z.infer<typeof CanvasReadPayload>;

// --- canvas.create (Faz 2: the Wecra engine, "Boş tuvalden yeni post") ----------------------
//
// A post's version from a blank Wecra document: one top-level frame per slide ("Kare 1", "Kare 2"
// …, the slide size, white, side by side), then — optionally — Wecra's design operations as in
// `canvas.apply`. Frames are not known by id before they exist, so an operation names the N-th
// frame as `"frame:N"` (1-based) in `parentId`, `nodeId` or `nodeIds`; the runner puts the frame's
// id there. The version is stored exactly as the canvas saves one (renders, facts, the bundle as
// `editorDocument`, checks), so the post opens on the canvas and is editable there.

/** `"frame:N"`: the N-th slide frame (1-based) of a `canvas.create` document. */
export const CANVAS_FRAME_REF = /^frame:(\d{1,2})$/;

export function canvasFrameRef(slide: number): string {
  return `frame:${slide}`;
}

const FRAME_REF_KEYS = new Set(["parentId", "nodeId", "nodeIds"]);

/**
 * `args` with every `"frame:N"` in `parentId` / `nodeId` / `nodeIds` (at any depth: nested
 * `nodes`, `updates`) replaced by the N-th frame's id. Unknown frames stay as they are (Wecra then
 * says the layer does not exist).
 */
export function resolveCanvasFrameRefs(
  args: Record<string, unknown>,
  frameIds: readonly string[],
): Record<string, unknown> {
  const swap = (v: unknown): unknown => {
    if (typeof v !== "string") return v;
    const m = CANVAS_FRAME_REF.exec(v);
    return m ? (frameIds[Number(m[1]) - 1] ?? v) : v;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!FRAME_REF_KEYS.has(k)) out[k] = walk(v);
        else out[k] = Array.isArray(v) ? v.map(swap) : swap(v);
      }
      return out;
    }
    return value;
  };
  return walk(args) as Record<string, unknown>;
}

const CanvasPx = z.number().int().min(1).max(MAX_ARTBOARD_PX);

export const CanvasCreatePayload = z
  .object({
    /**
     * The post's current version the blank document replaces (null / absent: the post has no
     * version yet). A different current version fails the job without a change.
     */
    baseVersion: z.number().int().min(1).nullable().optional(),
    slides: z.number().int().min(1).max(SLIDE_LIMITS.carousel.max),
    width: CanvasPx,
    height: CanvasPx,
    /** Design operations on the blank frames (`"frame:N"` names a frame); none: a blank post. */
    operations: z.array(CanvasOperation).max(MAX_CANVAS_OPERATIONS).default([]),
    /** The version's origin: `generated` (the Wecra engine) or `manual_edit` (the owner's blank). */
    origin: ContentVersionOrigin.exclude(["ai_edit"]).default("generated"),
    note: z.string().trim().max(500).optional(),
    conversationId: EntityId.optional(),
    /** The `content.generate` job this is part of (logs). */
    generateJobId: JobId.optional(),
  })
  .meta({ id: "CanvasCreatePayload" });
export type CanvasCreatePayload = z.infer<typeof CanvasCreatePayload>;
export type CanvasCreatePayloadInput = z.input<typeof CanvasCreatePayload>;

export const CanvasCreateOutput = z
  .object({
    contentId: EntityId,
    version: z.number().int().min(1),
    /** The slide frames' ids, in reading order (what `"frame:N"` became). */
    frameIds: z.array(z.string()).max(SLIDE_LIMITS.carousel.max),
    results: z.array(CanvasOperationResult).max(MAX_CANVAS_OPERATIONS),
    slides: z.number().int().min(1),
    checkJobId: JobId.nullable(),
  })
  .meta({ id: "CanvasCreateOutput" });
export type CanvasCreateOutput = z.infer<typeof CanvasCreateOutput>;

// --- content.details ("Bilgileri üret", Faz 2) ------------------------------------------------

/** What "Bilgileri üret" may write. */
export const CONTENT_DETAIL_FIELDS = ["title", "caption", "altText", "firstComment"] as const;
export type ContentDetailField = (typeof CONTENT_DETAIL_FIELDS)[number];

export const ContentDetailsPayload = z
  .object({
    /** The version whose design is read (default: the current one). */
    version: z.number().int().min(1).optional(),
    /** Default: all of them. */
    fields: z.array(z.enum(CONTENT_DETAIL_FIELDS)).min(1).max(4).optional(),
    /** The owner's note for this round ("daha kısa", "soru ile bitsin"). */
    instructions: z.string().trim().max(2_000).optional(),
    model: AgentModel.optional(),
    effort: AgentEffort.optional(),
  })
  .meta({ id: "ContentDetailsPayload" });
export type ContentDetailsPayload = z.infer<typeof ContentDetailsPayload>;
export type ContentDetailsPayloadInput = z.input<typeof ContentDetailsPayload>;

export const ContentDetailsOutput = z
  .object({
    contentId: EntityId,
    /** The version that was read; the design is never changed (no new version). */
    version: z.number().int().min(1),
    written: z.array(z.enum(CONTENT_DETAIL_FIELDS)),
    title: z.string().nullable(),
    caption: z.string().nullable(),
    hashtags: z.array(z.string()),
    altTexts: z.array(z.string().nullable()),
    firstComment: z.string().nullable(),
    /** What was left as it was, and why ("onaylı post: açıklama değişmedi"). */
    notes: z.array(z.string()).max(10),
  })
  .meta({ id: "ContentDetailsOutput" });
export type ContentDetailsOutput = z.infer<typeof ContentDetailsOutput>;

/** Job types only the API itself creates; `POST /api/jobs` refuses them. */
export const INTERNAL_JOB_TYPES = ["chat.turn"] as const satisfies readonly JobType[];

/**
 * Job types `POST /api/jobs/{id}/retry` queues again (a new job: same type, brand, content and
 * payload; a plan item's generation goes through the plan, so the item follows the new job).
 * Not `chat.turn` (the conversation retries itself) nor `schedule.publish` (publishing has its
 * own safe retry: a second job could post twice).
 */
export const RETRYABLE_JOB_TYPES = [
  "demo.echo",
  "content.generate",
  "content.render",
  "brand.analyze",
  "image.generate",
  "brand.skill_draft",
  "content.check",
  "canvas.read",
  "canvas.apply",
  "canvas.create",
  "content.details",
  "tool.install",
] as const satisfies readonly JobType[];

/** A finished job the user may queue again ("Yeniden dene"): failed or cancelled, of a retryable type. */
export function isRetryableJob(job: Pick<Job, "type" | "status">): boolean {
  return (
    (RETRYABLE_JOB_TYPES as readonly string[]).includes(job.type) &&
    (job.status === "failed" || job.status === "cancelled")
  );
}

/** Per-type payload schemas known so far; other types accept any object. */
export const JOB_PAYLOAD_SCHEMAS: Partial<Record<JobType, z.ZodType>> = {
  "demo.echo": DemoEchoPayload,
  "chat.turn": ChatTurnPayload,
  "content.render": ContentRenderPayload,
  "image.generate": ImageGeneratePayload,
  "schedule.publish": SchedulePublishPayload,
  "brand.skill_draft": BrandSkillDraftPayload,
  "content.check": ContentCheckPayload,
  "canvas.read": CanvasReadPayload,
  "canvas.apply": CanvasApplyPayload,
  "media.analyze": MediaAnalyzePayload,
  "insights.sync": InsightsSyncPayload,
  "comments.sync": CommentsSyncPayload,
  "comments.suggest": CommentsSuggestPayload,
  "canvas.create": CanvasCreatePayload,
  "content.details": ContentDetailsPayload,
  "tool.install": ToolInstallPayload,
  "tool.uninstall": ToolUninstallPayload,
};

// --- Live updates and worker presence (F1-6) --------------------------------

/** Filter for `GET /api/jobs/stream`: one job, one brand, or (neither) all jobs. */
export const JobStreamQuery = z
  .object({ jobId: JobId.optional(), brandId: EntityId.optional() })
  .refine((q) => !(q.jobId && q.brandId), "pass jobId or brandId, not both");
export type JobStreamQuery = z.input<typeof JobStreamQuery>;

export const ConnectedWorker = z
  .object({
    workerId: z.string(),
    workerVersion: z.string().optional(),
    capabilities: z.array(z.string()),
    /** Jobs the worker runs at the same time. */
    concurrency: z.number().int().min(1),
    connectedAt: Timestamp,
    lastSeenAt: Timestamp,
    /** True after the worker announced a graceful shutdown. */
    draining: z.boolean(),
  })
  .meta({ id: "ConnectedWorker" });
export type ConnectedWorker = z.infer<typeof ConnectedWorker>;

export const PresenceJob = z
  .object({
    id: JobId,
    type: JobType,
    brandId: EntityId.optional(),
    workerId: z.string().optional(),
    progress: z.number().min(0).max(1).optional(),
    progressMessage: z.string().optional(),
    startedAt: Timestamp.optional(),
  })
  .meta({ id: "PresenceJob" });
export type PresenceJob = z.infer<typeof PresenceJob>;

/** One subscription limit window as the worker observed it. */
export const UsageWindow = z
  .object({
    kind: z.enum(["five_hour", "weekly", "other"]),
    /** 0..100 */
    usedPercent: z.number().min(0).max(100).optional(),
    resetsAt: Timestamp.optional(),
    /** True when the window's limit is reached. */
    limited: z.boolean(),
  })
  .meta({ id: "UsageWindow" });
export type UsageWindow = z.infer<typeof UsageWindow>;

/** Remaining subscription usage, last reported by a worker (`worker.usage`). */
export const WorkerUsage = z
  .object({
    windows: z.array(UsageWindow).max(16),
    /** Where the worker read it (free-form, e.g. "claude-cli"). */
    source: z.string().min(1).max(200),
    observedAt: Timestamp,
  })
  .meta({ id: "WorkerUsage" });
export type WorkerUsage = z.infer<typeof WorkerUsage>;

/** "Is the Mac online?" — `GET /api/workers/presence` and the job stream. */
export const WorkerPresence = z
  .object({
    online: z.boolean(),
    /** Last message from any worker; null if no worker ever connected. */
    lastSeenAt: Timestamp.nullable(),
    workers: z.array(ConnectedWorker),
    /** Jobs currently `running`. */
    currentJobs: z.array(PresenceJob),
    /** Jobs waiting in `queued`. */
    queueLength: z.number().int().min(0),
    /** Latest `worker.usage` report (kept across hub restarts); absent until a worker sent one. */
    usage: WorkerUsage.optional(),
    /**
     * The Mac's Claude sign-in as the worker last reported it (`worker.claude`,
     * kept across hub restarts); absent until a worker sent one.
     */
    claude: ClaudeAccount.optional(),
    /**
     * The Mac's Gemini API / CLI readiness as the worker last reported it
     * (`worker.gemini`, kept across hub restarts); absent until a worker sent one.
     */
    gemini: GeminiAccount.optional(),
    /**
     * The Mac's other AI providers (Codex CLI, OpenAI API, Antigravity CLI) as the worker last
     * reported them (`worker.providers`); absent until a worker sent them.
     */
    providers: z.array(AiProviderStatus).optional(),
    /**
     * The tools Studio uses on the Mac (ffmpeg, Claude Code …) as the worker last reported them
     * (`worker.tools`, tools.ts); absent until a worker sent them.
     */
    tools: z.array(ToolStatus).optional(),
  })
  .meta({ id: "WorkerPresence" });
export type WorkerPresence = z.infer<typeof WorkerPresence>;
