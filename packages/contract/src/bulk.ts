import { z } from "zod";
import { AgentEffort, AgentModel, EntityId } from "./common.ts";
import { Job } from "./job.ts";

/*
 * Work over many posts at once (N1–N4): one instruction applied to N posts, the time / cost
 * estimate shown before big jobs, and the trash purge.
 */

/** Most posts one bulk request takes (a month plan's worth). */
export const MAX_BULK_CONTENTS = 60;

// --- "Talimat uygula": one instruction, N posts (N3) ------------------------------------------

/**
 * `POST /api/contents/revise`. HTML posts get one `content.generate` job each, starting from
 * their current version with the instruction (what the chat's `revise_post` queues). Canvas
 * posts (a Wecra document is the design) cannot be regenerated without losing the hand edits:
 * they go to the chat agent instead — one new conversation of the brand whose first message asks
 * it to apply the instruction to them with its canvas tools (`canvas_outline` / `canvas_edit`).
 */
export const ContentReviseRequest = z
  .object({
    contentIds: z
      .array(EntityId)
      .min(1)
      .max(MAX_BULK_CONTENTS)
      .refine((ids) => new Set(ids).size === ids.length, "contentIds must be unique"),
    instruction: z.string().trim().min(1).max(4_000),
    model: AgentModel.optional(),
    effort: AgentEffort.optional(),
    /**
     * Approved or scheduled posts lose their approval (pending schedules are cancelled) when a
     * new version arrives; without this they are skipped (`approved`).
     */
    confirmApprovalLoss: z.boolean().optional(),
  })
  .meta({ id: "ContentReviseRequest" });
export type ContentReviseRequest = z.input<typeof ContentReviseRequest>;

/**
 * Why a post was left out: `not_found` / `deleted` (in the trash), `no_version` (nothing to
 * revise: generate it first), `busy` (a generation or render is running), `published`
 * (publishing / published), `approved` (approved or scheduled, without `confirmApprovalLoss`),
 * `brand` (posts of more than one brand: canvas posts of other brands than the first).
 */
export const ContentReviseSkipReason = z
  .enum(["not_found", "deleted", "no_version", "busy", "published", "approved", "brand"])
  .meta({ id: "ContentReviseSkipReason" });
export type ContentReviseSkipReason = z.infer<typeof ContentReviseSkipReason>;

export const ContentReviseResult = z
  .object({
    /** The `content.generate` jobs queued (HTML posts). */
    jobs: z.array(Job),
    /** Canvas posts handed to the chat agent (null: none). */
    canvas: z.object({ conversationId: EntityId, contentIds: z.array(EntityId).min(1) }).nullable(),
    skipped: z.array(
      z.object({
        contentId: EntityId,
        reason: ContentReviseSkipReason,
        /** Turkish, for the user. */
        message: z.string(),
      }),
    ),
  })
  .meta({ id: "ContentReviseResult" });
export type ContentReviseResult = z.infer<typeof ContentReviseResult>;

// --- estimate before big jobs (N4) ------------------------------------------------------------

/** Above this many posts the apps show the estimate and ask before starting. */
export const ESTIMATE_CONFIRM_THRESHOLD = 5;

/**
 * `GET /api/estimates/generation`: how long and how much `count` post generations (or
 * revisions) will take, from what the last ones took on this Mac.
 */
export const GenerationEstimateQuery = z.object({
  count: z.coerce.number().int().min(1).max(200),
  brandId: EntityId.optional(),
  /** Items whose plan asks for an AI picture ("ai_generate" slots). */
  imageSlots: z.coerce.number().int().min(0).max(200).default(0),
});
export type GenerationEstimateQuery = z.input<typeof GenerationEstimateQuery>;

export const GenerationEstimate = z
  .object({
    count: z.number().int().min(1),
    /** Time one post adds when they run back to back (seconds). */
    perItemSeconds: z.number().min(0),
    totalSeconds: z.number().min(0),
    /** `history`: measured from the last finished generations; `default`: no history yet. */
    basis: z.enum(["history", "default"]),
    /** Finished generations the figures come from (0 with `default`). */
    sampleSize: z.number().int().min(0),
    /** When the default figures were set (YYYY-MM-DD). */
    defaultsAsOf: z.string(),
    /**
     * Paid AI spend per post (USD), averaged over the spend records of the measured generations.
     * Claude runs on the subscription: 0 while the posts are made with Claude.
     */
    perItemUsd: z.number().min(0),
    textUsd: z.number().min(0),
    imageSlots: z.number().int().min(0),
    /** Price of one Gemini picture (measured, else the dated default). */
    perImageUsd: z.number().min(0),
    /**
     * Whether the pictures are made with the posts. Today the plan's "AI görsel" slots stay empty
     * (the picture is made separately), so this is false and `imageUsd` is what they would cost.
     */
    imagesIncluded: z.boolean(),
    imageUsd: z.number().min(0),
    /** What this run spends (text, plus pictures when they are included). */
    totalUsd: z.number().min(0),
    /** This month's Gemini budget left (USD); null without a budget. */
    budgetRemainingUsd: z.number().nullable(),
  })
  .meta({ id: "GenerationEstimate" });
export type GenerationEstimate = z.infer<typeof GenerationEstimate>;

// --- trash purge (P7) ----------------------------------------------------------------------------

/** `POST /api/maintenance/purge`: what the purge removed for good. */
export const PurgeResult = z
  .object({
    contents: z.number().int().min(0),
    assets: z.number().int().min(0),
    /** Stored objects deleted (files, their thumbnails, renders of purged posts). */
    objects: z.number().int().min(0),
  })
  .meta({ id: "PurgeResult" });
export type PurgeResult = z.infer<typeof PurgeResult>;
