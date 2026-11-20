import {
  type ApprovalActionResult,
  type ApprovalApprove,
  type ApprovalCreate,
  type ApprovalRegenerate,
  ApprovalRegenerateRequest,
  type ApprovalReject,
  type ApprovalRequest,
  type ApprovalTarget,
  type BrandProduct,
  isSvgSlideHtml,
  type Job,
  MAX_PRODUCT_IMAGES,
} from "@studio/contract";
// The slide HTML reader only (the canvas index also brings the in-page linter, DOM types).
import { readCanvas } from "@studio/design-kit/canvas/html";
import { and, asc, count, eq, inArray, isNull, ne } from "drizzle-orm";
import type { z } from "zod";
import { createDb, type Db } from "../db/client.ts";
import { type ApprovalRow, toApproval, toBrandProduct } from "../db/mappers.ts";
import {
  approvalRequests,
  assets,
  brandProducts,
  contents,
  contentVersionDocuments,
  contentVersionSlides,
  contentVersions,
  conversations,
  messages,
} from "../db/schema.ts";
import { badRequest, conflict, notFound } from "./errors.ts";
import { newId } from "./ids.ts";
import { productSlugs } from "./mentions.ts";

/*
 * Approval requests (contract approval.ts): the worker creates them when a generation finishes;
 * the owner approves, rejects or asks for a new one. Every change is announced on the job stream
 * (`approval.updated`) so the Mac's and the iPhone's lists refresh.
 */

const CHUNK = 50;

/** content id -> pending approval requests (ids without any are left out). */
export async function pendingCounts(
  db: Db,
  contentIds: readonly string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const ids = [...new Set(contentIds)];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await db
      .select({ contentId: approvalRequests.contentId, n: count() })
      .from(approvalRequests)
      .where(
        and(
          inArray(approvalRequests.contentId, ids.slice(i, i + CHUNK)),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .groupBy(approvalRequests.contentId);
    for (const r of rows) if (r.contentId) out.set(r.contentId, r.n);
  }
  return out;
}

export async function requireApproval(db: Db, id: string): Promise<ApprovalRow> {
  const row = await db.query.approvalRequests.findFirst({ where: eq(approvalRequests.id, id) });
  if (!row) throw notFound("approval request", id);
  return row;
}

/** What the routes need from the environment (the job queue and the Hub's broadcast). */
export interface ApprovalEnv {
  env: Env;
  createJob: (input: {
    type: Job["type"];
    brandId?: string;
    contentId?: string;
    payload: Record<string, unknown>;
  }) => Promise<Job>;
  announce: (approval: ApprovalRequest) => Promise<void>;
  loadContent: (contentId: string) => Promise<ApprovalActionResult["content"]>;
  /** Post the request's card in its chat (`ApprovalCreate.chatMessage`); returns the message id. */
  postMessage?: (input: {
    conversationId: string;
    approvalId: string;
    text: string;
  }) => Promise<string>;
}

/** Validate and store a request from the worker; an earlier pending one it replaces is superseded. */
export async function createApproval(
  ctx: ApprovalEnv,
  input: z.output<typeof ApprovalCreate>,
): Promise<ApprovalRequest> {
  const db = createDb(ctx.env.DB);
  const brand = await db.query.brands.findFirst({
    where: (b, { eq: is }) => is(b.id, input.brandId),
  });
  if (!brand) throw notFound("brand", input.brandId);

  const issues: { path: string; message: string }[] = [];
  const found = await db
    .select({ id: assets.id, kind: assets.kind, deletedAt: assets.deletedAt })
    .from(assets)
    .where(and(eq(assets.brandId, input.brandId), inArray(assets.id, input.assetIds)));
  input.assetIds.forEach((id, i) => {
    const hit = found.find((f) => f.id === id);
    if (!hit) issues.push({ path: `assetIds.${i}`, message: "not an asset of this brand" });
    else if (hit.kind !== "image") issues.push({ path: `assetIds.${i}`, message: "not an image" });
    else if (hit.deletedAt) issues.push({ path: `assetIds.${i}`, message: "in the trash" });
  });
  if (input.contentId) {
    const content = await db.query.contents.findFirst({ where: eq(contents.id, input.contentId) });
    if (!content || content.brandId !== input.brandId) {
      issues.push({ path: "contentId", message: "not a post of this brand" });
    }
  }
  if (input.productId) {
    const product = await db.query.brandProducts.findFirst({
      where: and(eq(brandProducts.id, input.productId), eq(brandProducts.brandId, input.brandId)),
    });
    if (!product) issues.push({ path: "productId", message: "not a product of this brand" });
  }
  if (input.kind === "product_photo_upgrade" && !input.productId) {
    issues.push({ path: "productId", message: "required for product_photo_upgrade" });
  }
  if (input.conversationId) {
    const conv = await db.query.conversations.findFirst({
      where: eq(conversations.id, input.conversationId),
    });
    if (!conv) issues.push({ path: "conversationId", message: "no such conversation" });
    else if (conv.brandId && conv.brandId !== input.brandId) {
      issues.push({ path: "conversationId", message: "the conversation has another brand" });
    }
  }
  if (input.messageId) {
    const msg = await db.query.messages.findFirst({ where: eq(messages.id, input.messageId) });
    if (!msg || (input.conversationId && msg.conversationId !== input.conversationId)) {
      issues.push({ path: "messageId", message: "not a message of the conversation" });
    }
  }
  if (issues.length > 0)
    throw badRequest("the approval request references unusable things", issues);

  const now = new Date();
  const row: ApprovalRow = {
    id: newId(),
    brandId: input.brandId,
    contentId: input.contentId ?? null,
    productId: input.productId ?? null,
    conversationId: input.conversationId ?? null,
    messageId: input.messageId ?? null,
    kind: input.kind,
    assetIds: input.assetIds,
    checkReport: input.checkReport ?? null,
    status: "pending",
    slotId: input.slotId ?? null,
    replacesAssetId: input.replacesAssetId ?? null,
    approvedAssetId: null,
    sourceJobId: input.sourceJobId ?? null,
    regenerateJobId: null,
    request: input.request ?? null,
    decisionNote: null,
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
  };
  await db.insert(approvalRequests).values(row);
  if (input.chatMessage && input.conversationId && !input.messageId && ctx.postMessage) {
    // The card in the chat it came from; a failure leaves the request (listed elsewhere too).
    try {
      const messageId = await ctx.postMessage({
        conversationId: input.conversationId,
        approvalId: row.id,
        text: input.chatMessage.text,
      });
      await db.update(approvalRequests).set({ messageId }).where(eq(approvalRequests.id, row.id));
      row.messageId = messageId;
    } catch (error) {
      console.warn(`api: could not post approval ${row.id} in its chat`, error);
    }
  }
  if (input.supersedesId) {
    const [old] = await db
      .update(approvalRequests)
      .set({ status: "superseded", updatedAt: now, decidedAt: now })
      .where(
        and(
          eq(approvalRequests.id, input.supersedesId),
          eq(approvalRequests.brandId, input.brandId),
          eq(approvalRequests.status, "pending"),
        ),
      )
      .returning();
    if (old) await ctx.announce(toApproval(old));
  }
  const view = toApproval(row);
  await ctx.announce(view);
  return view;
}

function assertPending(row: ApprovalRow): void {
  if (row.status !== "pending") {
    throw conflict(
      `approval request ${row.id} is ${row.status}; only pending requests can be decided`,
    );
  }
}

/** Store a decision only if the request is still pending (a parallel decision loses). */
async function decide(
  db: Db,
  row: ApprovalRow,
  set: Partial<ApprovalRow>,
  from: readonly ApprovalRow["status"][] = ["pending"],
): Promise<ApprovalRow> {
  const now = new Date();
  const [updated] = await db
    .update(approvalRequests)
    .set({ ...set, updatedAt: now, decidedAt: now })
    .where(and(eq(approvalRequests.id, row.id), inArray(approvalRequests.status, [...from])))
    .returning();
  if (!updated) throw conflict(`approval request ${row.id} was decided meanwhile`);
  return updated;
}

export async function approveRequest(
  ctx: ApprovalEnv,
  id: string,
  input: z.output<typeof ApprovalApprove>,
): Promise<ApprovalActionResult> {
  const db = createDb(ctx.env.DB);
  const row = await requireApproval(db, id);
  assertPending(row);
  const chosen = input.assetId ?? row.assetIds[0];
  if (!chosen || !row.assetIds.includes(chosen)) {
    throw badRequest("pick one of the request's pictures", [
      { path: "assetId", message: "not a candidate of this request" },
    ]);
  }

  if (row.kind === "product_photo_upgrade") {
    const product = await upgradeProductPhoto(db, row, chosen);
    const updated = await decide(db, row, { status: "approved", approvedAssetId: chosen });
    const view = toApproval(updated);
    await ctx.announce(view);
    return { approval: view, content: null, product, job: null };
  }

  // A post's picture: fill its slot with a new rendered version (like image.generate's target).
  // A canvas post (its current version is a Wecra document) gets the picture on the canvas:
  // Wecra's `place_image` on the slot's layer, so the document and the hand edits stay.
  let job: Job | null = null;
  const canvas =
    row.contentId && row.slotId ? await canvasSlot(db, row.contentId, row.slotId) : null;
  if (canvas && row.contentId) {
    job = await ctx.createJob({
      type: "canvas.apply",
      brandId: row.brandId,
      contentId: row.contentId,
      payload: {
        version: canvas.version,
        operations: [
          {
            tool: "place_image",
            args: { nodeId: canvas.nodeId, assetId: chosen, scaleMode: "FILL" },
          },
        ],
        note: "Onaylanan görsel yerleştirildi",
        ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      },
    });
  } else if (row.contentId && row.slotId) {
    // An SVG engine version (Faz 3): the worker turns the SVG's slot marker into an <image> of
    // the picture and renders a new version of exactly that version. An HTML version: the slot
    // is filled by rendering the current version.
    const svg = await svgSlot(db, row.contentId, row.slotId);
    job = await ctx.createJob({
      type: "content.render",
      brandId: row.brandId,
      contentId: row.contentId,
      payload: {
        format: "jpeg",
        slotAssignments: { [row.slotId]: chosen },
        ...(svg
          ? { version: svg.version, note: "Onaylanan görsel SVG yuvasına yerleştirildi" }
          : { note: "Onaylanan görsel yerleştirildi" }),
      },
    });
  }
  const updated = await decide(db, row, { status: "approved", approvedAssetId: chosen });
  const view = toApproval(updated);
  await ctx.announce(view);
  const content = row.contentId ? await ctx.loadContent(row.contentId) : null;
  return { approval: view, content, product: null, job };
}

/**
 * The slot's Wecra layer when the post's current version was saved on the canvas (null: an HTML
 * version — its slot is filled by rendering). `slotId` is the Wecra layer id (the Wecra engine's
 * picture area) or the design-contract layer an imported slot kept (its canvas mark).
 */
export async function canvasSlot(
  db: Db,
  contentId: string,
  slotId: string,
): Promise<{ version: number; nodeId: string } | null> {
  const [current] = await db
    .select({ id: contentVersions.id, version: contentVersions.version })
    .from(contents)
    .innerJoin(contentVersions, eq(contents.currentVersionId, contentVersions.id))
    .innerJoin(contentVersionDocuments, eq(contentVersionDocuments.versionId, contentVersions.id))
    .where(eq(contents.id, contentId));
  if (!current) return null;
  const slides = await db
    .select({ html: contentVersionSlides.html })
    .from(contentVersionSlides)
    .where(eq(contentVersionSlides.versionId, current.id))
    .orderBy(asc(contentVersionSlides.position));
  for (const s of slides) {
    const c = readCanvas(s.html);
    if (c.kind !== "facts") continue;
    const node =
      c.facts.nodes.find((n) => n.id === slotId) ??
      c.facts.nodes.find((n) => n.mark?.layer === slotId);
    if (node) return { version: current.version, nodeId: node.id };
  }
  // A Wecra id the facts left out (a busy slide): Wecra itself says if it is not there.
  return /^\d+:\d+$/.test(slotId) ? { version: current.version, nodeId: slotId } : null;
}

/**
 * The current version when it was made by the SVG engine and has the slot marker
 * (`data-slot="<slotId>"` in its SVG); null otherwise.
 */
export async function svgSlot(
  db: Db,
  contentId: string,
  slotId: string,
): Promise<{ version: number } | null> {
  const [current] = await db
    .select({ id: contentVersions.id, version: contentVersions.version })
    .from(contents)
    .innerJoin(contentVersions, eq(contents.currentVersionId, contentVersions.id))
    .where(eq(contents.id, contentId));
  if (!current) return null;
  const slides = await db
    .select({ html: contentVersionSlides.html })
    .from(contentVersionSlides)
    .where(eq(contentVersionSlides.versionId, current.id));
  const marker = `data-slot="${slotId.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
  return slides.some((s) => isSvgSlideHtml(s.html) && s.html.includes(marker))
    ? { version: current.version }
    : null;
}

/**
 * The product's photo becomes the approved picture: it takes the replaced photo's place (the
 * cover stays the cover), or comes first when none is replaced. The old photo goes to the trash
 * (restorable for TRASH_RETENTION_DAYS) unless another product still uses it.
 */
async function upgradeProductPhoto(
  db: Db,
  row: ApprovalRow,
  chosen: string,
): Promise<BrandProduct> {
  if (!row.productId) throw conflict("this request names no product");
  const product = await db.query.brandProducts.findFirst({
    where: and(eq(brandProducts.id, row.productId), eq(brandProducts.brandId, row.brandId)),
  });
  if (!product) throw conflict("Ürün bulunamadı; silinmiş olabilir.");
  const photos = product.imageAssetIds.filter((a) => a !== chosen);
  const old = row.replacesAssetId;
  const at = old ? photos.indexOf(old) : -1;
  if (at >= 0) photos[at] = chosen;
  else photos.unshift(chosen);
  const next = photos.slice(0, MAX_PRODUCT_IMAGES);
  const now = new Date();
  const [updated] = await db
    .update(brandProducts)
    .set({ imageAssetIds: next, updatedAt: now })
    .where(eq(brandProducts.id, product.id))
    .returning();
  if (!updated) throw conflict("Ürün bulunamadı; silinmiş olabilir.");
  // A picture back from the trash if it was put there meanwhile.
  await db.update(assets).set({ deletedAt: null }).where(eq(assets.id, chosen));
  if (old && at >= 0) {
    const others = await db
      .select({ id: brandProducts.id, photos: brandProducts.imageAssetIds })
      .from(brandProducts)
      .where(and(eq(brandProducts.brandId, row.brandId), ne(brandProducts.id, product.id)));
    if (!others.some((p) => p.photos.includes(old))) {
      await db
        .update(assets)
        .set({ deletedAt: now })
        .where(and(eq(assets.id, old), eq(assets.brandId, row.brandId), isNull(assets.deletedAt)));
    }
  }
  const slugs = await productSlugs(db, row.brandId);
  return toBrandProduct(updated, slugs.get(updated.id));
}

export async function rejectRequest(
  ctx: ApprovalEnv,
  id: string,
  input: z.output<typeof ApprovalReject>,
): Promise<ApprovalActionResult> {
  const db = createDb(ctx.env.DB);
  const row = await requireApproval(db, id);
  assertPending(row);
  const updated = await decide(db, row, {
    status: "rejected",
    decisionNote: input.note ? input.note : null,
  });
  const view = toApproval(updated);
  await ctx.announce(view);
  return { approval: view, content: null, product: null, job: null };
}

/**
 * "Yeniden üret": the owner's consent to run the request's generation again. The request is
 * superseded (pending or rejected ones only) and the same job is queued; its result becomes a new
 * request that names this one in `supersedesId`.
 */
export async function regenerateRequest(
  ctx: ApprovalEnv,
  id: string,
  input: z.output<typeof ApprovalRegenerate>,
): Promise<ApprovalActionResult> {
  const db = createDb(ctx.env.DB);
  const row = await requireApproval(db, id);
  if (row.status !== "pending" && row.status !== "rejected") {
    throw conflict(`approval request ${row.id} is ${row.status}; it cannot be generated again`);
  }
  const parsed = ApprovalRegenerateRequest.safeParse(row.request);
  if (!row.request || !parsed.success) {
    throw conflict("Bu kayıt yeniden üretilemez: ilk isteğin bilgisi yok.");
  }
  const { jobType } = parsed.data;
  const payload: Record<string, unknown> = structuredClone(parsed.data.payload);
  if (input.preserveLabelComposite) {
    if (jobType !== "image.generate") {
      throw badRequest("preserveLabelComposite is for picture generations only", [
        { path: "preserveLabelComposite", message: `the request is a ${jobType} job` },
      ]);
    }
    payload.preserveProductLabel = true;
  }
  if (input.instructions) {
    if (jobType === "image.generate") {
      const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
      payload.prompt = `${prompt}\n\nEk istek: ${input.instructions}`.trim().slice(0, 4_000);
    } else {
      const earlier = typeof payload.instructions === "string" ? payload.instructions : "";
      payload.instructions = [earlier, input.instructions]
        .filter(Boolean)
        .join("\n")
        .slice(0, 4_000);
    }
  }
  if (jobType === "image.generate") {
    const target: ApprovalTarget = {
      kind: row.kind,
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      ...(row.contentId ? { contentId: row.contentId } : {}),
      ...(row.productId ? { productId: row.productId } : {}),
      ...(row.slotId ? { slotId: row.slotId } : {}),
      ...(row.replacesAssetId ? { replacesAssetId: row.replacesAssetId } : {}),
      supersedesId: row.id,
    };
    payload.approval = target;
  }
  const job = await ctx.createJob({
    type: jobType,
    brandId: row.brandId,
    ...(row.contentId && jobType !== "image.generate" ? { contentId: row.contentId } : {}),
    payload,
  });
  const updated = await decide(db, row, { status: "superseded", regenerateJobId: job.id }, [
    "pending",
    "rejected",
  ]);
  const view = toApproval(updated);
  await ctx.announce(view);
  return { approval: view, content: null, product: null, job };
}
