import { z } from "zod";
import {
  AgentEffort,
  AgentModel,
  EntityId,
  PageQuery,
  Platform,
  pageOf,
  Timestamp,
} from "./common.ts";
import { ContentType } from "./content.ts";
import { Job, JobStatus } from "./job.ts";

/*
 * Content plans (task A2). The chat agent proposes a plan for a period
 * (typically a month): one item per post with date, platforms, type, title,
 * brief, pillar and what kind of image it needs. The user edits, accepts or
 * rejects it. Accepting creates one draft content item per plan item (no
 * generation yet); generation is requested separately and creates
 * `content.generate` jobs whose payload is `ContentGeneratePayload` below.
 */

/** `YYYY-MM-DD` calendar date (no time zone; the brand's local calendar). */
export const IsoDate = z.iso.date();
export type IsoDate = z.infer<typeof IsoDate>;

/** What a plan item expects for its image slot(s) (PLAN.md §5 "Görsel yuvaları"). */
export const ImageSlotExpectation = z
  .enum(["none", "user_upload", "ai_generate"])
  .meta({ id: "ImageSlotExpectation" });
export type ImageSlotExpectation = z.infer<typeof ImageSlotExpectation>;

export const PlanStatus = z
  .enum(["draft", "proposed", "accepted", "rejected", "superseded"])
  .meta({ id: "PlanStatus" });
export type PlanStatus = z.infer<typeof PlanStatus>;

/**
 * Plan lifecycle. The server refuses anything else with 409 `invalid_transition`.
 *
 *   draft     -> proposed (agent) | rejected (user) | superseded (newer plan in the conversation)
 *   proposed  -> accepted (user, by revision) | rejected (user) | superseded
 *   accepted, rejected, superseded: final
 *
 * Edits (user PATCH or the agent replacing its own proposal) are allowed only
 * in `draft` and `proposed` and bump `revision`.
 */
export const PLAN_TRANSITIONS = {
  draft: ["proposed", "rejected", "superseded"],
  proposed: ["accepted", "rejected", "superseded"],
  accepted: [],
  rejected: [],
  superseded: [],
} as const satisfies Record<PlanStatus, readonly PlanStatus[]>;

export function canTransitionPlan(from: PlanStatus, to: PlanStatus): boolean {
  return (PLAN_TRANSITIONS[from] as readonly PlanStatus[]).includes(to);
}

/** Statuses in which a plan can still be edited. */
export const EDITABLE_PLAN_STATUSES = ["draft", "proposed"] as const satisfies PlanStatus[];
export function isPlanEditable(status: PlanStatus): boolean {
  return (EDITABLE_PLAN_STATUSES as readonly PlanStatus[]).includes(status);
}

/**
 * Item status:
 * - `planned`: part of an open plan (or of a rejected / superseded one);
 * - `accepted`: the plan was accepted and a draft content item was created (`contentId`);
 * - `skipped`: left out when the plan was accepted.
 * Generation progress is reported separately in `PlanItem.generation`.
 */
export const PlanItemStatus = z
  .enum(["planned", "accepted", "skipped"])
  .meta({ id: "PlanItemStatus" });
export type PlanItemStatus = z.infer<typeof PlanItemStatus>;

export const MAX_PLAN_ITEMS = 60;
/** Longest plan period, inclusive (a quarter). */
export const MAX_PLAN_PERIOD_DAYS = 92;

const PlanTitle = z.string().trim().max(200);
const PlanSummary = z.string().max(20_000);
const ItemTitle = z.string().trim().min(1).max(200);
const ItemBrief = z.string().max(20_000);
const Pillar = z.string().trim().min(1).max(120);
const ImageBrief = z.string().max(4_000);
const ItemPlatforms = z
  .array(Platform)
  .min(1)
  .max(3)
  .refine((list) => new Set(list).size === list.length, "platforms must be unique");

/** A plan item as the agent or the user writes it. `id` only when editing an existing item. */
export const PlanItemInput = z
  .object({
    id: EntityId.optional(),
    /** Planned publication day; must fall inside the plan period. */
    date: IsoDate.nullable().default(null),
    platforms: ItemPlatforms,
    contentType: ContentType,
    title: ItemTitle,
    brief: ItemBrief.default(""),
    /** Content pillar / theme, e.g. "ürün tanıtımı", "sezon ipuçları". */
    pillar: Pillar.nullable().default(null),
    imageSlot: ImageSlotExpectation.default("none"),
    /** What the image should show (for the user's upload or the image model). */
    imageBrief: ImageBrief.nullable().default(null),
  })
  .meta({ id: "PlanItemInput" });
export type PlanItemInput = z.input<typeof PlanItemInput>;

/** Generation state of an accepted item, read from its latest `content.generate` job. */
export const PlanItemGeneration = z
  .object({
    jobId: EntityId,
    status: JobStatus,
    error: z.string().nullable(),
  })
  .meta({ id: "PlanItemGeneration" });
export type PlanItemGeneration = z.infer<typeof PlanItemGeneration>;

export const PlanItem = z
  .object({
    id: EntityId,
    planId: EntityId,
    /** 0-based order inside the plan. */
    position: z.number().int().min(0),
    date: IsoDate.nullable(),
    platforms: z.array(Platform),
    contentType: ContentType,
    title: z.string(),
    brief: z.string(),
    pillar: z.string().nullable(),
    imageSlot: ImageSlotExpectation,
    imageBrief: z.string().nullable(),
    status: PlanItemStatus,
    /** Draft content item created when the plan was accepted (null if it was deleted since). */
    contentId: EntityId.nullable(),
    /** Latest generation request for this item, if any. */
    generation: PlanItemGeneration.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "PlanItem" });
export type PlanItem = z.infer<typeof PlanItem>;

export const Plan = z
  .object({
    id: EntityId,
    brandId: EntityId,
    /** Conversation the plan was proposed in (null for plans made elsewhere). */
    conversationId: EntityId.nullable(),
    /** Agent run that proposed the plan. */
    runId: EntityId.nullable(),
    title: z.string(),
    /** Inclusive period, e.g. 2026-12-01 .. 2026-12-31 for a monthly plan. */
    periodStart: IsoDate,
    periodEnd: IsoDate,
    status: PlanStatus,
    summary: z.string(),
    /**
     * Bumped by every edit. Accepting and editing require the revision the
     * user looked at, so a concurrent change by the agent is never accepted blind.
     */
    revision: z.number().int().min(1),
    /** When the plan was accepted or rejected. */
    decidedAt: Timestamp.nullable(),
    rejectionReason: z.string().nullable(),
    items: z.array(PlanItem),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Plan" });
export type Plan = z.infer<typeof Plan>;

function daysBetween(start: string, end: string): number {
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000,
  );
}

/** Period check shared by the server and clients; returns an error message or null. */
export function checkPlanPeriod(
  periodStart: string,
  periodEnd: string,
  itemDates: ReadonlyArray<string | null | undefined> = [],
): string | null {
  const span = daysBetween(periodStart, periodEnd);
  if (span < 0) return "periodEnd must not be before periodStart";
  if (span + 1 > MAX_PLAN_PERIOD_DAYS) return `a plan covers at most ${MAX_PLAN_PERIOD_DAYS} days`;
  for (const date of itemDates) {
    if (date && (date < periodStart || date > periodEnd)) {
      return `item date ${date} is outside the plan period`;
    }
  }
  return null;
}

/** `"2026-12"` -> `{ periodStart: "2026-12-01", periodEnd: "2026-12-31" }`. */
export function monthPeriod(month: string): { periodStart: string; periodEnd: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const year = Number(match?.[1]);
  const mon = Number(match?.[2]);
  if (!match || mon < 1 || mon > 12) throw new Error(`expected YYYY-MM, got ${month}`);
  const last = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  return {
    periodStart: `${match[1]}-${match[2]}-01`,
    periodEnd: `${match[1]}-${match[2]}-${last}`,
  };
}

const PlanItems = z.array(PlanItemInput).min(1).max(MAX_PLAN_ITEMS);

/** User edit of a draft/proposed plan. `items` replaces the list: items with `id` are kept/updated, others created, missing ones removed. */
export const PlanUpdate = z
  .object({
    revision: z.number().int().min(1),
    title: PlanTitle.optional(),
    summary: PlanSummary.optional(),
    periodStart: IsoDate.optional(),
    periodEnd: IsoDate.optional(),
    items: PlanItems.optional(),
  })
  .refine(
    (v) => [v.title, v.summary, v.periodStart, v.periodEnd, v.items].some((x) => x !== undefined),
    "at least one field besides revision is required",
  )
  .meta({ id: "PlanUpdate" });
export type PlanUpdate = z.input<typeof PlanUpdate>;

export const PlanAccept = z
  .object({
    /** The revision the user reviewed; must equal the plan's current revision. */
    revision: z.number().int().min(1),
    /** Items to leave out; they become `skipped` and get no content item. */
    skipItemIds: z.array(EntityId).max(MAX_PLAN_ITEMS).default([]),
  })
  .meta({ id: "PlanAccept" });
export type PlanAccept = z.input<typeof PlanAccept>;

export const PlanReject = z
  .object({ reason: z.string().max(2_000).optional() })
  .meta({ id: "PlanReject" });
export type PlanReject = z.input<typeof PlanReject>;

export const PlanGenerate = z
  .object({
    /** Items to generate; omitted = every accepted item without a queued/running generation. */
    itemIds: z.array(EntityId).min(1).max(MAX_PLAN_ITEMS).optional(),
    /** Extra instructions for this generation round. */
    instructions: z.string().max(4_000).optional(),
    /** Model for the generation jobs; copied into each job's payload. */
    model: AgentModel.optional(),
    /** Reasoning effort for the generation jobs; copied into each job's payload. */
    effort: AgentEffort.optional(),
  })
  .meta({ id: "PlanGenerate" });
export type PlanGenerate = z.input<typeof PlanGenerate>;

export const PlanGenerateResult = z
  .object({
    plan: Plan,
    /** The `content.generate` jobs created now (empty when every item is already generating). */
    jobs: z.array(Job),
  })
  .meta({ id: "PlanGenerateResult" });
export type PlanGenerateResult = z.infer<typeof PlanGenerateResult>;

export const PlanListQuery = PageQuery.extend({
  brandId: EntityId.optional(),
  conversationId: EntityId.optional(),
  status: PlanStatus.optional(),
});
export type PlanListQuery = z.input<typeof PlanListQuery>;

export const PlanList = pageOf(Plan, "PlanList");
export type PlanList = z.infer<typeof PlanList>;

// --- content.generate payload ------------------------------------------------------

/**
 * Payload of a `content.generate` job (consumed by the worker, task A4).
 *
 * Plan generation (`POST /api/plans/{id}/generate`) always fills every field
 * it knows. `POST /api/jobs` does not enforce this schema yet (older callers
 * send a subset), so `brandId` / `contentId` are optional here: the job row's
 * `brandId` / `contentId` are authoritative. Use `parseContentGenerateJob` to
 * get a payload with both ids filled in from the job.
 */
export const ContentGeneratePayload = z
  .object({
    brandId: EntityId.optional(),
    contentId: EntityId.optional(),
    title: z.string().max(200).optional(),
    /** What to make. */
    brief: z.string().max(20_000),
    /** Content type (`post`, `carousel`, ...). */
    type: ContentType.optional(),
    targetPlatforms: z.array(Platform).max(3).optional(),
    /** Version number to start from (regeneration / edit); absent = from scratch. */
    baseVersion: z.number().int().min(1).optional(),
    /** Image slot expectation: leave a slot for the user, ask the image model, or no image. */
    imageSlot: ImageSlotExpectation.optional(),
    imageBrief: z.string().max(4_000).nullable().optional(),
    /** Present when the content comes from a plan. */
    planItem: z
      .object({
        planId: EntityId,
        itemId: EntityId,
        date: IsoDate.nullable(),
        pillar: z.string().nullable(),
      })
      .optional(),
    /** Conversation to report into (the agent may add a `content_ref` part there). */
    conversationId: EntityId.optional(),
    /** Approved brand profile version current when the job was created. */
    brandProfileVersion: z.number().int().min(1).optional(),
    /** Extra instructions from the user for this round. */
    instructions: z.string().max(4_000).optional(),
    /** Model the user picked; absent = the worker's default. */
    model: AgentModel.optional(),
    /** Reasoning effort the user picked; absent = the worker's default. */
    effort: AgentEffort.optional(),
  })
  .meta({ id: "ContentGeneratePayload" });
export type ContentGeneratePayload = z.infer<typeof ContentGeneratePayload>;

export type ContentGenerateJobInput = ContentGeneratePayload & {
  brandId: string;
  contentId: string;
};

export type ContentGenerateParseResult =
  | { ok: true; payload: ContentGenerateJobInput }
  | { ok: false; error: string };

/** Validate a `content.generate` job's payload, taking brand/content ids from the job row. */
export function parseContentGenerateJob(job: {
  payload: Record<string, unknown>;
  brandId?: string | undefined;
  contentId?: string | undefined;
}): ContentGenerateParseResult {
  const parsed = ContentGeneratePayload.safeParse(job.payload);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  const brandId = job.brandId ?? parsed.data.brandId;
  const contentId = job.contentId ?? parsed.data.contentId;
  if (!brandId || !contentId) return { ok: false, error: "brandId and contentId are required" };
  return { ok: true, payload: { ...parsed.data, brandId, contentId } };
}
