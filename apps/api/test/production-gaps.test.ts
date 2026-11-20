import { env } from "cloudflare:workers";
import {
  ApprovalActionResult,
  ApprovalRequest,
  Asset,
  type BrandProduct,
  type Content,
  ContentGeneratePayload,
  ContentTemplate,
  Job,
  Plan,
  PlanGenerateResult,
  TemplateUseResult,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  addVersion,
  api,
  BASE,
  createBrand,
  createContent,
  expectError,
  localFetch,
} from "./helpers.ts";
import { seedPlan, solidPng, uploadFile } from "./lifecycle-helpers.ts";

/*
 * Three gaps of the picture production (docs/URETIM-RESIM.md, "Kapanan boşluklar"): a template
 * post's empty slot through the consented slot-picture line, plan items that keep their products
 * for the generation, and rejected / superseded / unchosen candidates leaving the media library.
 */

const AUTH = () => ({ Authorization: `Bearer ${env.WORKER_TOKEN}` });

async function worker<T = unknown>(method: string, path: string, body?: unknown) {
  const res = await localFetch(`${BASE}${path}`, {
    method,
    headers: { ...AUTH(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = res.headers.get("content-type")?.includes("application/json")
    ? JSON.parse(text)
    : text;
  return { status: res.status, body: parsed as T };
}

async function picture(brandId: string, source: "upload" | "generated" = "generated") {
  return uploadFile(brandId, await solidPng(8, 10), "image/png", "foto.png", source);
}

async function product(brandId: string, body: Record<string, unknown>) {
  const res = await api<BrandProduct>("POST", `/api/brands/${brandId}/products`, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

async function createApproval(body: Record<string, unknown>) {
  const res = await worker("POST", "/api/worker/approvals", body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ApprovalRequest.parse(res.body);
}

async function trashed(id: string): Promise<boolean> {
  const res = await api("GET", `/api/assets/${id}`);
  expect(res.status).toBe(200);
  return Asset.parse(res.body).deletedAt != null;
}

// --- 1. template posts: the consented slot picture -------------------------------------------

const emptySlotSlide = `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><meta name="studio:contract" content="v1"><meta name="studio:format" content="1080x1350"><link rel="stylesheet" href="/brand/brand.css"></head>
<body>
  <main data-artboard style="width:1080px;height:1350px">
    <figure data-layer="photo" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty" data-slot-label="Ürün" data-slot-fit="cover" style="position:absolute;left:72px;top:72px;width:560px;height:700px"></figure>
    <h1 data-layer="headline" data-type="text" data-role="headline" style="position:absolute;left:72px;top:820px;width:936px;font-size:88px">Hasat bitti</h1>
    <p data-layer="body" data-type="text" data-role="body" style="position:absolute;left:72px;top:1000px;width:936px">Toprağınızı kışa hazırlayın.</p>
  </main>
</body>
</html>`;

async function emptySlotTemplate(brandId: string) {
  const render = await picture(brandId);
  const content = await createContent(brandId, { title: "Hasat", targetPlatforms: ["instagram"] });
  const version = await addVersion(content.id, {
    slides: [{ html: emptySlotSlide, width: 1080, height: 1350 }],
    renderedAssetIds: [render.id],
  });
  const approved = await api<Content>("POST", `/api/contents/${content.id}/approve`, {
    hash: version.contentHash,
    acknowledgeChecks: true,
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  const res = await api("POST", "/api/templates", { contentId: content.id });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ContentTemplate.parse(res.body);
}

describe("template posts: the consented slot picture", () => {
  it("carries an explicit slotImage into the fill job; none means no paid picture", async () => {
    const brand = await createBrand();
    const boro = await product(brand.id, { name: "Boro" });
    const template = await emptySlotTemplate(brand.id);
    const conv = await api<{ id: string }>("POST", "/api/conversations", { brandId: brand.id });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);

    const plain = TemplateUseResult.parse(
      (await api("POST", `/api/templates/${template.id}/use`, { brief: "Kış" })).body,
    );
    const p0 = ContentGeneratePayload.parse(plain.job.payload);
    expect(p0.slotImage).toBeUndefined();
    expect(p0.imageSlot).toBeUndefined();

    const res = await api("POST", `/api/templates/${template.id}/use`, {
      brief: "Boro ile kışa hazırlık",
      imageBrief: "Tarlada Boro şişesi",
      conversationId: conv.body.id,
      slotImage: { consented: true, productIds: [boro.id], view: "sol" },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const payload = ContentGeneratePayload.parse(TemplateUseResult.parse(res.body).job.payload);
    expect(payload).toMatchObject({
      imageSlot: "ai_generate",
      imageBrief: "Tarlada Boro şişesi",
      template: { templateId: template.id, fill: "ai" },
      slotImage: {
        consented: true,
        productIds: [boro.id],
        view: "sol",
        conversationId: conv.body.id,
      },
    });

    // Consent is literal, and the products must be the brand's.
    expectError(
      await api("POST", `/api/templates/${template.id}/use`, {
        brief: "x",
        slotImage: { consented: false },
      }),
      400,
      "validation_error",
    );
    const other = await createBrand();
    const foreign = await product(other.id, { name: "Yabancı" });
    expectError(
      await api("POST", `/api/templates/${template.id}/use`, {
        brief: "x",
        slotImage: { consented: true, productIds: [foreign.id] },
      }),
      400,
      "validation_error",
    );
  });
});

// --- 2. plan items keep their products --------------------------------------------------------

describe("plan items: products", () => {
  it("are stored, kept by edits and passed into each item's generation", async () => {
    const brand = await createBrand();
    const boro = await product(brand.id, { name: "Boro" });
    const venta = await product(brand.id, { name: "Venta" });
    const planId = await seedPlan(brand.id, [
      { imageSlot: "ai_generate" },
      { imageSlot: "ai_generate" },
      { imageSlot: "none" },
    ]);
    // An older plan without the field: no products, any side.
    const seeded = Plan.parse((await api("GET", `/api/plans/${planId}`)).body);
    expect(seeded.items.map((i) => [i.productIds, i.imageView])).toEqual([
      [[], null],
      [[], null],
      [[], null],
    ]);
    const [first, second, third] = seeded.items;

    // Another brand's product (or an unknown one) is refused.
    const other = await createBrand();
    const foreign = await product(other.id, { name: "Yabancı" });
    expectError(
      await api("PATCH", `/api/plans/${planId}/items/${first?.id}`, { productIds: [foreign.id] }),
      400,
      "validation_error",
    );
    const patched = await api("PATCH", `/api/plans/${planId}/items/${first?.id}`, {
      productIds: [boro.id],
      imageView: "sol",
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    let plan = Plan.parse(patched.body);
    expect(plan.items[0]).toMatchObject({ productIds: [boro.id], imageView: "sol" });

    // A whole-plan edit that does not name the products keeps them; one that does replaces them.
    const items = plan.items.map((i) => ({
      id: i.id,
      date: i.date,
      platforms: i.platforms,
      contentType: i.contentType,
      title: `${i.title}!`,
      brief: i.brief,
      imageSlot: i.imageSlot,
      ...(i.id === third?.id ? { productIds: [venta.id] } : {}),
    }));
    const edited = await api("PATCH", `/api/plans/${planId}`, { revision: plan.revision, items });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    plan = Plan.parse(edited.body);
    expect(plan.items.map((i) => i.productIds)).toEqual([[boro.id], [], [venta.id]]);
    expect(plan.items[0]?.imageView).toBe("sol");

    const accepted = await api("POST", `/api/plans/${planId}/accept`, { revision: plan.revision });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    plan = Plan.parse(accepted.body);
    const gen = await api("POST", `/api/plans/${planId}/generate`, {
      slotImage: { consented: true, style: "retro" },
    });
    expect(gen.status, JSON.stringify(gen.body)).toBe(200);
    const jobs = PlanGenerateResult.parse(gen.body).jobs;
    const payloadOf = (itemId: string | undefined) => {
      const contentId = plan.items.find((i) => i.id === itemId)?.contentId;
      return ContentGeneratePayload.parse(jobs.find((j) => j.contentId === contentId)?.payload);
    };
    const p1 = payloadOf(first?.id);
    expect(p1.productIds).toEqual([boro.id]);
    expect(p1.slotImage).toEqual({
      consented: true,
      style: "retro",
      productIds: [boro.id],
      view: "sol",
    });
    const p2 = payloadOf(second?.id);
    expect(p2.productIds).toBeUndefined();
    expect(p2.slotImage).toEqual({ consented: true, style: "retro" });
    // No AI slot: the products still reach the designer, no picture is generated.
    const p3 = payloadOf(third?.id);
    expect(p3.productIds).toEqual([venta.id]);
    expect(p3.slotImage).toBeUndefined();
  });

  it("lets the request's own products win, and leaves out a product deleted since", async () => {
    const brand = await createBrand();
    const boro = await product(brand.id, { name: "Boro" });
    const gone = await product(brand.id, { name: "Eski" });
    const venta = await product(brand.id, { name: "Venta" });
    const planId = await seedPlan(brand.id, [
      { imageSlot: "ai_generate" },
      { imageSlot: "ai_generate" },
    ]);
    let plan = Plan.parse((await api("GET", `/api/plans/${planId}`)).body);
    const [one, two] = plan.items;
    await api("PATCH", `/api/plans/${planId}/items/${one?.id}`, { productIds: [boro.id, gone.id] });
    plan = Plan.parse(
      (await api("PATCH", `/api/plans/${planId}/items/${two?.id}`, { productIds: [gone.id] })).body,
    );
    const removed = await api("DELETE", `/api/brands/${brand.id}/products/${gone.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);
    plan = Plan.parse(
      (await api("POST", `/api/plans/${planId}/accept`, { revision: plan.revision })).body,
    );
    const contentOf = (id: string | undefined) => plan.items.find((i) => i.id === id)?.contentId;

    const named = PlanGenerateResult.parse(
      (
        await api("POST", `/api/plans/${planId}/generate`, {
          itemIds: [one?.id],
          slotImage: { consented: true, productIds: [venta.id] },
        })
      ).body,
    );
    const p1 = ContentGeneratePayload.parse(named.jobs[0]?.payload);
    expect(named.jobs[0]?.contentId).toBe(contentOf(one?.id));
    expect(p1.productIds).toEqual([boro.id]);
    expect(p1.slotImage?.productIds).toEqual([venta.id]);

    const rest = PlanGenerateResult.parse(
      (await api("POST", `/api/plans/${planId}/generate`, { slotImage: { consented: true } })).body,
    );
    expect(rest.jobs.map((j) => j.contentId)).toEqual([contentOf(two?.id)]);
    const p2 = ContentGeneratePayload.parse(rest.jobs[0]?.payload);
    // Its only product is gone: a scene without one.
    expect(p2.productIds).toBeUndefined();
    expect(p2.slotImage).toEqual({ consented: true });
  });
});

// --- 3. rejected candidates leave the media library -------------------------------------------

describe("approval candidates: the trash", () => {
  it("rejecting trashes the pictures nothing else uses", async () => {
    const brand = await createBrand();
    const post = await createContent(brand.id);
    const [a, b, inVersion, inProduct, shared] = [
      await picture(brand.id),
      await picture(brand.id),
      await picture(brand.id),
      await picture(brand.id),
      await picture(brand.id),
    ];
    await addVersion(post.id, { renderedAssetIds: [inVersion.id] });
    await product(brand.id, { name: "Boro", imageAssetIds: [inProduct.id] });
    // A pending request of its own shows `shared`.
    await createApproval({
      brandId: brand.id,
      kind: "variant",
      contentId: post.id,
      assetIds: [shared.id],
    });
    const req = await createApproval({
      brandId: brand.id,
      kind: "variant",
      contentId: post.id,
      assetIds: [a.id, b.id, inVersion.id, inProduct.id],
    });
    // A second request with the same picture, rejected: the first one still needs it.
    const both = await createApproval({
      brandId: brand.id,
      kind: "variant",
      contentId: post.id,
      assetIds: [shared.id],
    });
    const res = await api("POST", `/api/approvals/${req.id}/reject`, { note: "olmamış" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await trashed(a.id)).toBe(true);
    expect(await trashed(b.id)).toBe(true);
    expect(await trashed(inVersion.id)).toBe(false);
    expect(await trashed(inProduct.id)).toBe(false);

    expect((await api("POST", `/api/approvals/${both.id}/reject`, {})).status).toBe(200);
    // Still a candidate of the first pending request.
    expect(await trashed(shared.id)).toBe(false);
  });

  it("approving keeps the chosen picture and trashes the others", async () => {
    const brand = await createBrand();
    const post = await createContent(brand.id);
    const [a, b, c] = [await picture(brand.id), await picture(brand.id), await picture(brand.id)];
    const req = await createApproval({
      brandId: brand.id,
      kind: "variant",
      contentId: post.id,
      slotId: "photo",
      assetIds: [a.id, b.id, c.id],
    });
    const res = await api("POST", `/api/approvals/${req.id}/approve`, { assetId: b.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = ApprovalActionResult.parse(res.body);
    expect(result.approval.approvedAssetId).toBe(b.id);
    expect(await trashed(b.id)).toBe(false);
    expect(await trashed(a.id)).toBe(true);
    expect(await trashed(c.id)).toBe(true);
    // The placement job takes the chosen picture (not in the trash).
    expect(Job.parse(result.job).payload).toMatchObject({ slotAssignments: { photo: b.id } });
  });

  it("superseding trashes the old pictures; regenerate still runs on the references", async () => {
    const brand = await createBrand();
    const post = await createContent(brand.id);
    const photo = await picture(brand.id, "upload");
    const boro = await product(brand.id, { name: "Boro", imageAssetIds: [photo.id] });
    const [first, second] = [await picture(brand.id), await picture(brand.id)];
    const req = await createApproval({
      brandId: brand.id,
      kind: "product_image",
      contentId: post.id,
      slotId: "photo",
      productId: boro.id,
      assetIds: [first.id],
      request: {
        jobType: "image.generate",
        payload: {
          prompt: "tarlada çuval",
          referenceAssetIds: [photo.id],
          productIds: [boro.id],
        },
      },
    });
    const res = await api("POST", `/api/approvals/${req.id}/regenerate`, {});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = ApprovalActionResult.parse(res.body);
    expect(result.approval.status).toBe("superseded");
    expect(await trashed(first.id)).toBe(true);
    // The new job runs on the product's photo, which is not a candidate and stays.
    expect(Job.parse(result.job).payload).toMatchObject({ referenceAssetIds: [photo.id] });
    expect(await trashed(photo.id)).toBe(false);

    // The new picture arrives as a request naming the old one; then another replaces it.
    const next = await createApproval({
      brandId: brand.id,
      kind: "product_image",
      contentId: post.id,
      assetIds: [second.id],
      supersedesId: req.id,
    });
    const third = await picture(brand.id);
    await createApproval({
      brandId: brand.id,
      kind: "product_image",
      contentId: post.id,
      assetIds: [third.id],
      supersedesId: next.id,
    });
    expect(ApprovalRequest.parse((await api("GET", `/api/approvals/${next.id}`)).body).status).toBe(
      "superseded",
    );
    expect(await trashed(second.id)).toBe(true);
    expect(await trashed(third.id)).toBe(false);

    // A rejected request can still be generated again: its candidates are gone, its references
    // are not.
    const fourth = await picture(brand.id);
    const rejected = await createApproval({
      brandId: brand.id,
      kind: "product_image",
      contentId: post.id,
      assetIds: [fourth.id],
      request: {
        jobType: "image.generate",
        payload: { prompt: "x", referenceAssetIds: [photo.id] },
      },
    });
    expect((await api("POST", `/api/approvals/${rejected.id}/reject`, {})).status).toBe(200);
    expect(await trashed(fourth.id)).toBe(true);
    const regen = await api("POST", `/api/approvals/${rejected.id}/regenerate`, {});
    expect(regen.status, JSON.stringify(regen.body)).toBe(200);
    expect(await trashed(photo.id)).toBe(false);
  });
});
