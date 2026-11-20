import { env } from "cloudflare:workers";
import {
  ApprovalActionResult,
  ApprovalList,
  ApprovalRequest,
  Asset,
  Brand,
  BrandProduct,
  BrandProductList,
  Content,
  ContentList,
  Conversation,
  Job,
  MentionCandidateList,
  Plan,
  TurnContext,
  UserMessageResult,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import { api, BASE, createBrand, createContent, expectError, localFetch } from "./helpers.ts";
import { seedPlan } from "./lifecycle-helpers.ts";

/*
 * Post production basics (docs/URETIM-RESIM.md, Faz 0): approval requests, `@product` / `@post`
 * mentions, the brand's engine and picture style.
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

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

let uploads = 0;
async function upload(brandId: string, name = "foto.png") {
  const form = new FormData();
  form.set("brandId", brandId);
  form.set("source", "generated");
  const bytes = new Uint8Array([...PNG, ++uploads & 0xff, (uploads >> 8) & 0xff, 7]);
  form.set("file", new File([bytes], name, { type: "image/png" }));
  const res = await localFetch(`${BASE}/api/assets`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return Asset.parse(await res.json());
}

async function createApproval(body: Record<string, unknown>) {
  const res = await worker("POST", "/api/worker/approvals", body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ApprovalRequest.parse(res.body);
}

async function product(brandId: string, body: Record<string, unknown>) {
  const res = await api("POST", `/api/brands/${brandId}/products`, body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return BrandProduct.parse(res.body);
}

describe("approval requests", () => {
  it("lists pending requests and marks the post as waiting until decided", async () => {
    const brand = await createBrand();
    const post = await createContent(brand.id);
    const [a, b] = [await upload(brand.id), await upload(brand.id)];

    const created = await createApproval({
      brandId: brand.id,
      kind: "variant",
      contentId: post.id,
      assetIds: [a.id, b.id],
      checkReport: {
        passed: false,
        items: [
          { aspect: "Etiket yazısı", ok: false, note: "“Organik” yerine “Organk” yazmış" },
          { aspect: "Kapak", ok: true },
        ],
        summary: "Etiket yazısı hatalı geldi.",
      },
      request: { jobType: "image.generate", payload: { prompt: "tarlada çuval" } },
    });
    expect(created).toMatchObject({
      status: "pending",
      kind: "variant",
      contentId: post.id,
      assetIds: [a.id, b.id],
      canRegenerate: true,
      decidedAt: null,
      checkReport: { passed: false, summary: "Etiket yazısı hatalı geldi." },
    });
    expect(created.checkReport?.items[1]).toEqual({ aspect: "Kapak", ok: true, note: "" });

    const list = ApprovalList.parse((await api("GET", `/api/approvals?brandId=${brand.id}`)).body);
    expect(list.items.map((x) => x.id)).toEqual([created.id]);

    const listed = ContentList.parse((await api("GET", `/api/contents?brandId=${brand.id}`)).body);
    expect(listed.items[0]?.pendingApprovals).toBe(1);
    const one = Content.parse((await api("GET", `/api/contents/${post.id}`)).body);
    expect(one.pendingApprovals).toBe(1);

    const rejected = ApprovalActionResult.parse(
      (await api("POST", `/api/approvals/${created.id}/reject`, { note: "Renk soluk" })).body,
    );
    expect(rejected.approval).toMatchObject({ status: "rejected", decisionNote: "Renk soluk" });
    expect(rejected.approval.decidedAt).not.toBeNull();
    expect(
      Content.parse((await api("GET", `/api/contents/${post.id}`)).body).pendingApprovals,
    ).toBe(0);
    expect(
      ApprovalList.parse((await api("GET", `/api/approvals?brandId=${brand.id}`)).body).items,
    ).toEqual([]);
    expect(
      ApprovalList.parse((await api("GET", `/api/approvals?brandId=${brand.id}&status=all`)).body)
        .items[0]?.id,
    ).toBe(created.id);

    // Decided once: approving it now is a conflict.
    expectError(await api("POST", `/api/approvals/${created.id}/approve`, {}), 409, "conflict");
  });

  it("approving a post picture fills its slot through a render job", async () => {
    const brand = await createBrand();
    const post = await createContent(brand.id);
    const [a, b] = [await upload(brand.id), await upload(brand.id)];
    const req = await createApproval({
      brandId: brand.id,
      kind: "product_image",
      contentId: post.id,
      slotId: "hero",
      assetIds: [a.id, b.id],
    });
    expectError(
      await api("POST", `/api/approvals/${req.id}/approve`, { assetId: post.id }),
      400,
      "validation_error",
    );
    const res = await api("POST", `/api/approvals/${req.id}/approve`, { assetId: b.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = ApprovalActionResult.parse(res.body);
    expect(result.approval).toMatchObject({ status: "approved", approvedAssetId: b.id });
    expect(result.job).toMatchObject({ type: "content.render", contentId: post.id });
    expect(result.job?.payload).toMatchObject({ slotAssignments: { hero: b.id } });
    expect(result.content?.id).toBe(post.id);
  });

  it("approving a product photo upgrade replaces the photo and trashes the old one", async () => {
    const brand = await createBrand();
    const [front, back, better] = [
      await upload(brand.id, "on.png"),
      await upload(brand.id, "arka.png"),
      await upload(brand.id),
    ];
    const item = await product(brand.id, { name: "Boro", imageAssetIds: [front.id, back.id] });
    const req = await createApproval({
      brandId: brand.id,
      kind: "product_photo_upgrade",
      productId: item.id,
      replacesAssetId: front.id,
      assetIds: [better.id],
    });
    const result = ApprovalActionResult.parse(
      (await api("POST", `/api/approvals/${req.id}/approve`, {})).body,
    );
    expect(result.product?.imageAssetIds).toEqual([better.id, back.id]);
    const old = Asset.parse((await api("GET", `/api/assets/${front.id}`)).body);
    expect(old.deletedAt).not.toBeNull();
    const kept = Asset.parse((await api("GET", `/api/assets/${back.id}`)).body);
    expect(kept.deletedAt ?? null).toBeNull();
  });

  it("regenerating supersedes the request and queues the same generation", async () => {
    const brand = await createBrand();
    const post = await createContent(brand.id);
    const a = await upload(brand.id);
    const req = await createApproval({
      brandId: brand.id,
      kind: "product_image",
      contentId: post.id,
      slotId: "hero",
      assetIds: [a.id],
      request: {
        jobType: "image.generate",
        payload: { prompt: "tarlada çuval", referenceAssetIds: [a.id] },
      },
    });
    const res = await api("POST", `/api/approvals/${req.id}/regenerate`, {
      preserveLabelComposite: true,
      instructions: "daha sıcak ışık",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = ApprovalActionResult.parse(res.body);
    expect(result.approval).toMatchObject({
      status: "superseded",
      regenerateJobId: result.job?.id,
    });
    const job = Job.parse(result.job);
    expect(job.type).toBe("image.generate");
    expect(job.payload).toMatchObject({
      preserveProductLabel: true,
      prompt: "tarlada çuval\n\nEk istek: daha sıcak ışık",
      approval: { kind: "product_image", contentId: post.id, slotId: "hero", supersedesId: req.id },
    });
    expectError(await api("POST", `/api/approvals/${req.id}/regenerate`, {}), 409, "conflict");

    // A new request names the old one; an old pending one is superseded by it.
    const next = await createApproval({
      brandId: brand.id,
      kind: "product_image",
      contentId: post.id,
      assetIds: [a.id],
    });
    const newer = await createApproval({
      brandId: brand.id,
      kind: "product_image",
      contentId: post.id,
      assetIds: [a.id],
      supersedesId: next.id,
    });
    expect(ApprovalRequest.parse((await api("GET", `/api/approvals/${next.id}`)).body).status).toBe(
      "superseded",
    );
    expect(newer.status).toBe("pending");
    // Without the original request there is nothing to run again.
    expectError(await api("POST", `/api/approvals/${newer.id}/regenerate`, {}), 409, "conflict");
    // The label composite is only for pictures.
    const post2 = await createApproval({
      brandId: brand.id,
      kind: "variant",
      contentId: post.id,
      assetIds: [a.id],
      request: { jobType: "content.generate", payload: { brief: "x" } },
    });
    expectError(
      await api("POST", `/api/approvals/${post2.id}/regenerate`, { preserveLabelComposite: true }),
      400,
      "validation_error",
    );
  });

  it("posts the request's card in its chat when asked to", async () => {
    const brand = await createBrand();
    const a = await upload(brand.id);
    const conv = Conversation.parse(
      (await api("POST", "/api/conversations", { brandId: brand.id })).body,
    );
    const req = await createApproval({
      brandId: brand.id,
      kind: "product_image",
      conversationId: conv.id,
      assetIds: [a.id],
      checkReport: { passed: false, items: [], summary: "Kapak rengi farklı." },
      chatMessage: { text: "Görsel geldi; kontrol: kapak rengi farklı. Onaylıyor musun?" },
    });
    expect(req.messageId).toBeTruthy();
    const list = (await api("GET", `/api/conversations/${conv.id}/messages`)).body as {
      items: { id: string; role: string; status: string; runId: string | null; parts: unknown[] }[];
    };
    const msg = list.items.find((m) => m.id === req.messageId);
    expect(msg).toMatchObject({ role: "assistant", status: "complete", runId: null });
    expect(msg?.parts).toEqual([
      { type: "text", text: "Görsel geldi; kontrol: kapak rengi farklı. Onaylıyor musun?" },
      { type: "approval_request", approvalId: req.id },
    ]);
    // Without a conversation there is nothing to post.
    const quiet = await createApproval({
      brandId: brand.id,
      kind: "product_image",
      assetIds: [a.id],
      chatMessage: { text: "x" },
    });
    expect(quiet.messageId).toBeNull();
  });

  it("refuses requests with foreign pictures and without the worker token", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const foreign = await upload(other.id);
    const bad = await worker("POST", "/api/worker/approvals", {
      brandId: brand.id,
      kind: "variant",
      assetIds: [foreign.id],
    });
    expect(bad.status).toBe(400);
    const noProduct = await worker("POST", "/api/worker/approvals", {
      brandId: brand.id,
      kind: "product_photo_upgrade",
      assetIds: [(await upload(brand.id)).id],
    });
    expect(noProduct.status).toBe(400);
    const anon = await localFetch(`${BASE}/api/worker/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brandId: brand.id, kind: "variant", assetIds: [foreign.id] }),
    });
    expect(anon.status).toBe(401);
  });
});

describe("brand engine and picture style", () => {
  it("stores the default engine and the style preset", async () => {
    const brand = await createBrand();
    expect(brand).toMatchObject({ defaultEngine: null, imageStylePreset: "" });
    const res = await api("PATCH", `/api/brands/${brand.id}`, {
      defaultEngine: "wecra",
      imageStylePreset: "  vintage, sıcak tonlar ",
    });
    expect(Brand.parse(res.body)).toMatchObject({
      defaultEngine: "wecra",
      imageStylePreset: "vintage, sıcak tonlar",
    });
    const cleared = Brand.parse(
      (await api("PATCH", `/api/brands/${brand.id}`, { defaultEngine: null })).body,
    );
    expect(cleared.defaultEngine).toBeNull();
    expectError(
      await api("PATCH", `/api/brands/${brand.id}`, { defaultEngine: "pdf" }),
      400,
      "validation_error",
    );
  });

  it("refuses a plan generation with an engine that is not ready", async () => {
    const brand = await createBrand();
    const planId = await seedPlan(brand.id, [{ title: "Hasat" }]);
    const accepted = await api("POST", `/api/plans/${planId}/accept`, { revision: 1 });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    Plan.parse(accepted.body);
    const refused = expectError(
      await api("POST", `/api/plans/${planId}/generate`, { engine: "svg" }),
      400,
      "validation_error",
    );
    expect(refused.message).toContain("Bu motor henüz hazır değil");
    const ok = await api("POST", `/api/plans/${planId}/generate`, { engine: "html" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const jobs = (ok.body as { jobs: Job[] }).jobs;
    expect(jobs[0]?.payload).toMatchObject({ engine: "html" });
  });
});

describe("@product and @post mentions", () => {
  it("names products and posts uniquely and resolves them in chat messages", async () => {
    const brand = await createBrand();
    const [front, side] = [
      await upload(brand.id, "boro-on.png"),
      await upload(brand.id, "yan.png"),
    ];
    const boro = await product(brand.id, {
      name: "Boro",
      category: "Gübre",
      imageAssetIds: [front.id, side.id],
    });
    const venta = await product(brand.id, { name: "Venta Boro" });
    const again = await product(brand.id, { name: "BORO" });
    const image = await product(brand.id, { name: "Image" });
    const digits = await product(brand.id, { name: "20-20-20 Gübre" });
    expect([boro.slug, venta.slug, again.slug, image.slug, digits.slug]).toEqual([
      "boro",
      "venta-boro",
      "boro-2",
      "image-urun",
      "urun-20-20-20-gubre",
    ]);
    const listed = BrandProductList.parse(
      (await api("GET", `/api/brands/${brand.id}/products`)).body,
    );
    expect(listed.items.map((p) => p.slug)).toEqual([
      "boro",
      "venta-boro",
      "boro-2",
      "image-urun",
      "urun-20-20-20-gubre",
    ]);

    const post = await createContent(brand.id, { title: "Hasat Bayramı" });
    const clash = await createContent(brand.id, { title: "Boro" });

    const candidates = MentionCandidateList.parse(
      (await api("GET", `/api/brands/${brand.id}/mention-candidates`)).body,
    );
    expect(candidates.items.find((c) => c.id === boro.id)).toMatchObject({
      kind: "product",
      slug: "boro",
      label: "Boro",
      imageAssetId: front.id,
      detail: "Gübre",
    });
    expect(candidates.items.find((c) => c.id === post.id)).toMatchObject({
      kind: "content",
      slug: "hasat-bayrami",
      detail: "draft",
      pendingApprovals: 0,
    });
    expect(candidates.items.find((c) => c.id === clash.id)?.slug).toBe("boro-3");

    const convRes = await api("POST", "/api/conversations", { brandId: brand.id });
    const conv = Conversation.parse(convRes.body);
    const sendRes = await api("POST", `/api/conversations/${conv.id}/messages`, {
      text: "@boro için @hasat-bayrami gibi bir post yap, @bilinmeyen değil",
    });
    expect(sendRes.status, JSON.stringify(sendRes.body)).toBe(201);
    const sent = UserMessageResult.parse(sendRes.body);
    expect(sent.message.entityMentions).toEqual([
      { kind: "product", id: boro.id, name: "boro", start: 0, end: 5 },
      { kind: "content", id: post.id, name: "hasat-bayrami", start: 11, end: 25 },
    ]);
    expect(sent.message.mentions).toEqual([]);

    const started = await worker("POST", `/api/worker/runs/${sent.run.id}/start`, { attempt: 1 });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const context = TurnContext.parse(started.body);
    expect(
      context.mentionedProducts?.map((p) => [p.mention, p.product.id, p.product.slug]),
    ).toEqual([["boro", boro.id, "boro"]]);
    expect(
      context.mentionedProducts?.[0]?.photos.map((p) => [p.assetId, p.position, p.angleHint]),
    ).toEqual([
      [front.id, 0, "ön"],
      [side.id, 1, "yan"],
    ]);
    expect(context.mentionedContents?.map((c) => [c.mention, c.content.id])).toEqual([
      ["hasat-bayrami", post.id],
    ]);
  });

  it("lets the conversation's file aliases win over product names", async () => {
    const brand = await createBrand();
    await product(brand.id, { name: "Image" }); // -> image-urun, never `image`
    const file = await upload(brand.id);
    const conv = Conversation.parse(
      (await api("POST", "/api/conversations", { brandId: brand.id })).body,
    );
    const res = await api("POST", `/api/conversations/${conv.id}/messages`, {
      text: "@image ile @image-urun",
      attachmentAssetIds: [file.id],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const sent = UserMessageResult.parse(res.body);
    expect(sent.message.mentions?.map((m) => m.alias)).toEqual(["image"]);
    expect(sent.message.entityMentions?.map((m) => m.name)).toEqual(["image-urun"]);
  });
});
