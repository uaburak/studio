import { z } from "zod";
import { BrandProduct } from "./brand-product.ts";
import { EntityId, PageQuery, pageOf, Timestamp } from "./common.ts";
import { Content } from "./content.ts";
import { ApprovalKind } from "./generation.ts";
import { Job, JobType } from "./job.ts";

/*
 * Approval requests ("Onay bekleyenler", docs/URETIM-RESIM.md §11–13).
 *
 * A generated picture that needs the owner's word before it is used: a product picture for a
 * post, one variant of a post's picture, or a better photo of a product. The chat shows it with
 * the AI check's report and three buttons (Onayla / Reddet / Yeniden üret); the Mac's details
 * panel and the iPhone's "Onay bekleyenler" screen list the same records. A post with a pending
 * request shows as "Onay bekliyor" (`Content.pendingApprovals`).
 *
 * - `approve`: `product_image` / `variant` go into the post's picture slot (a new rendered
 *   version, like `image.generate` with `targetSlotId`); `product_photo_upgrade` replaces the
 *   product's photo, the old one goes to the trash (TRASH_RETENTION_DAYS, restorable).
 * - `reject`: nothing is used; the pictures stay in the media library.
 * - `regenerate`: the owner's explicit consent to run the same generation again (paid). The
 *   request becomes `superseded` and a new job is queued; its result is a new request.
 *
 * The worker creates requests with `POST /api/worker/approvals` when a generation finishes.
 */

export const ApprovalStatus = z
  .enum(["pending", "approved", "rejected", "superseded"])
  .meta({ id: "ApprovalStatus" });
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/** One aspect the AI compared with the product's own photos and facts ("Etiket yazısı"). */
export const ApprovalCheckItem = z
  .object({
    aspect: z.string().trim().min(1).max(120),
    ok: z.boolean(),
    /** What is wrong (or "" when fine): "Kapak rengi beyaz yerine gri". */
    note: z.string().max(1_000).default(""),
  })
  .meta({ id: "ApprovalCheckItem" });
export type ApprovalCheckItem = z.infer<typeof ApprovalCheckItem>;

/** The AI check's report on the candidate pictures. */
export const ApprovalCheckReport = z
  .object({
    passed: z.boolean(),
    items: z.array(ApprovalCheckItem).max(40).default([]),
    /** One or two sentences for the chat ("Şu kısımlar hatalı geldi: …"). */
    summary: z.string().max(2_000).default(""),
  })
  .meta({ id: "ApprovalCheckReport" });
export type ApprovalCheckReport = z.infer<typeof ApprovalCheckReport>;

/** What "Yeniden üret" queues again: the original job's type and payload. */
export const ApprovalRegenerateRequest = z
  .object({
    jobType: JobType,
    payload: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "ApprovalRegenerateRequest" });
export type ApprovalRegenerateRequest = z.infer<typeof ApprovalRegenerateRequest>;

export const ApprovalRequest = z
  .object({
    id: EntityId,
    brandId: EntityId,
    /** The post the picture is for (null: none, e.g. a product photo upgrade). */
    contentId: EntityId.nullable(),
    /** The product the picture shows / replaces a photo of (null: none). */
    productId: EntityId.nullable(),
    /** The chat the request was made in and the message that shows it (null: outside a chat). */
    conversationId: EntityId.nullable(),
    messageId: EntityId.nullable(),
    kind: ApprovalKind,
    /** The candidate pictures (`image` assets of the brand), 1–4. */
    assetIds: z.array(EntityId),
    /** Null when no check ran. */
    checkReport: ApprovalCheckReport.nullable(),
    status: ApprovalStatus,
    /** Picture slot (`data-layer`) of the post the approved picture fills (null: none). */
    slotId: z.string().nullable(),
    /** `product_photo_upgrade`: the product photo the new one replaces (null: added first). */
    replacesAssetId: EntityId.nullable(),
    /** The candidate that was approved (null until approved). */
    approvedAssetId: EntityId.nullable(),
    /** The job that made the pictures (null: unknown). */
    sourceJobId: EntityId.nullable(),
    /** Queued by "Yeniden üret" (null until then). */
    regenerateJobId: EntityId.nullable(),
    /** True when "Yeniden üret" can run (the original request is known). */
    canRegenerate: z.boolean(),
    /** The owner's note with a rejection (null: none). */
    decisionNote: z.string().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    decidedAt: Timestamp.nullable(),
  })
  .meta({ id: "ApprovalRequest" });
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** `status=all` lists every status. */
export const ApprovalStatusFilter = z
  .enum(["pending", "approved", "rejected", "superseded", "all"])
  .meta({ id: "ApprovalStatusFilter" });

export const ApprovalListQuery = PageQuery.extend({
  brandId: EntityId.optional(),
  contentId: EntityId.optional(),
  conversationId: EntityId.optional(),
  /** Default `pending`. */
  status: ApprovalStatusFilter.default("pending"),
});
export type ApprovalListQuery = z.input<typeof ApprovalListQuery>;

/** Newest first. */
export const ApprovalList = pageOf(ApprovalRequest, "ApprovalList");
export type ApprovalList = z.infer<typeof ApprovalList>;

/** Worker: a finished generation asks for the owner's word. */
export const ApprovalCreate = z
  .object({
    brandId: EntityId,
    kind: ApprovalKind,
    assetIds: z
      .array(EntityId)
      .min(1)
      .max(4)
      .refine((ids) => new Set(ids).size === ids.length, "a picture is listed twice"),
    contentId: EntityId.optional(),
    productId: EntityId.optional(),
    conversationId: EntityId.optional(),
    messageId: EntityId.optional(),
    checkReport: ApprovalCheckReport.optional(),
    slotId: z.string().trim().min(1).max(128).optional(),
    replacesAssetId: EntityId.optional(),
    sourceJobId: EntityId.optional(),
    request: ApprovalRegenerateRequest.optional(),
    /** An earlier request this one replaces (it becomes `superseded` if still pending). */
    supersedesId: EntityId.optional(),
  })
  .meta({ id: "ApprovalCreate" });
export type ApprovalCreate = z.input<typeof ApprovalCreate>;

export const ApprovalApprove = z
  .object({
    /** Which candidate to use (default: the first). */
    assetId: EntityId.optional(),
  })
  .meta({ id: "ApprovalApprove" });
export type ApprovalApprove = z.input<typeof ApprovalApprove>;

export const ApprovalReject = z
  .object({ note: z.string().trim().max(2_000).optional() })
  .meta({ id: "ApprovalReject" });
export type ApprovalReject = z.input<typeof ApprovalReject>;

export const ApprovalRegenerate = z
  .object({
    /**
     * "Etiketi birebir koruyarak yerleştir": cut the real product photo out and place it into
     * the generated scene (`preserveProductLabel`) instead of letting the model redraw it.
     */
    preserveLabelComposite: z.boolean().default(false),
    /** Extra words for this round ("daha sıcak ışık"). */
    instructions: z.string().trim().max(2_000).optional(),
  })
  .meta({ id: "ApprovalRegenerate" });
export type ApprovalRegenerate = z.input<typeof ApprovalRegenerate>;

/** What a decision changed. */
export const ApprovalActionResult = z
  .object({
    approval: ApprovalRequest,
    /** The post after an approval placed the picture (null: no post changed). */
    content: Content.nullable(),
    /** The product after a photo upgrade (null: no product changed). */
    product: BrandProduct.nullable(),
    /** The job queued: the post's render (approve) or the new generation (regenerate). */
    job: Job.nullable(),
  })
  .meta({ id: "ApprovalActionResult" });
export type ApprovalActionResult = z.infer<typeof ApprovalActionResult>;
