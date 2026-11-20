import { env } from "cloudflare:workers";
import {
  Content,
  ContentGeneratePayload,
  ContentReviseResult,
  Job,
  MessageList,
  Plan,
  PlanGenerateResult,
  PlanItemRemoveResult,
  WECRA_DOCUMENT_MIME,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  addVersion,
  api,
  createBrand,
  createContent,
  expectError,
  getContent,
  slide,
} from "./helpers.ts";
import { finishJob, type SeedItem, seedPlan, uploadFile } from "./lifecycle-helpers.ts";

async function acceptedPlan(brandId: string, items: SeedItem[]): Promise<Plan> {
  const planId = await seedPlan(brandId, items);
  const res = await api("POST", `/api/plans/${planId}/accept`, { revision: 1 });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return Plan.parse(res.body);
}

async function generate(planId: string, body: Record<string, unknown> = {}) {
  return api("POST", `/api/plans/${planId}/generate`, body);
}

async function generateOk(planId: string, body: Record<string, unknown> = {}) {
  const res = await generate(planId, body);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return PlanGenerateResult.parse(res.body);
}

const contentOf = (plan: Plan, index: number) => plan.items[index]?.contentId ?? "";
const itemOf = (plan: Plan, index: number) => plan.items[index]?.id ?? "";

describe("plan generation (U2)", () => {
  it("queues only what still needs a design and says why the rest was left", async () => {
    const brand = await createBrand();
    const plan = await acceptedPlan(brand.id, [{}, {}, {}, {}]);

    const first = await generateOk(plan.id);
    expect(first.jobs).toHaveLength(4);
    const again = await generateOk(plan.id);
    expect(again.jobs).toEqual([]);
    expect(again.skipped.map((s) => s.reason)).toEqual(Array(4).fill("generating"));

    const jobOf = (i: number) =>
      first.jobs.find((j) => j.contentId === contentOf(plan, i))?.id ?? "";
    // 0: generated; 1: failed; 2: stopped; 3: generated, then edited by hand.
    await addVersion(contentOf(plan, 0), { jobId: jobOf(0) });
    await finishJob(jobOf(0), "succeeded");
    await finishJob(jobOf(1), "failed");
    await finishJob(jobOf(2), "cancelled");
    await addVersion(contentOf(plan, 3), { jobId: jobOf(3) });
    await finishJob(jobOf(3), "succeeded");
    await addVersion(contentOf(plan, 3), {
      origin: "manual_edit",
      slides: [slide("<html><body>elle</body></html>")],
    });

    const retry = await generateOk(plan.id);
    expect(retry.jobs.map((j) => j.contentId).sort()).toEqual(
      [contentOf(plan, 1), contentOf(plan, 2)].sort(),
    );
    expect(retry.skipped).toEqual([
      { itemId: itemOf(plan, 0), reason: "generated" },
      { itemId: itemOf(plan, 3), reason: "edited" },
    ]);
  });

  it("accepts without generating and never designs hand-made or uploaded posts by default", async () => {
    const brand = await createBrand();
    // 0: Studio designs it; 1: the user brings it (generate: false); 2: designed, but the user
    // uploaded a finished post to its draft before anything was generated.
    const plan = await acceptedPlan(brand.id, [{}, { generate: false }, {}]);
    expect(plan.items.map((i) => i.generate)).toEqual([true, false, true]);
    // Accepting alone queued nothing.
    expect(plan.items.every((i) => i.generation === null)).toBe(true);
    const jobs = await api("GET", `/api/jobs?brandId=${brand.id}`);
    expect(jobs.status).toBe(200);
    expect((jobs.body as { items: unknown[] }).items).toEqual([]);

    await addVersion(contentOf(plan, 2), {
      origin: "manual_edit",
      slides: [slide("<html><body>yüklendi</body></html>")],
    });
    const gen = await generateOk(plan.id);
    expect(gen.jobs.map((j) => j.contentId)).toEqual([contentOf(plan, 0)]);
    expect(gen.skipped).toEqual([
      { itemId: itemOf(plan, 1), reason: "manual" },
      { itemId: itemOf(plan, 2), reason: "edited" },
    ]);

    // Named: a hand-made item needs force; an uploaded post also overwriteEdits.
    const manual = expectError(
      await generate(plan.id, { itemIds: [itemOf(plan, 1)] }),
      409,
      "conflict",
    );
    expect(manual.message).toContain("force");
    const uploaded = expectError(
      await generate(plan.id, { itemIds: [itemOf(plan, 2)], force: true }),
      409,
      "conflict",
    );
    expect(uploaded.message).toContain("overwriteEdits");
    const forced = await generateOk(plan.id, { itemIds: [itemOf(plan, 1)], force: true });
    expect(forced.jobs.map((j) => j.contentId)).toEqual([contentOf(plan, 1)]);
  });

  it("keeps an item's hand-made flag through edits that do not mention it", async () => {
    const brand = await createBrand();
    const planId = await seedPlan(brand.id, [{ generate: false }, {}]);
    const before = Plan.parse((await api("GET", `/api/plans/${planId}`)).body);
    const res = await api("PATCH", `/api/plans/${planId}`, {
      revision: before.revision,
      items: before.items.map((i) => ({
        id: i.id,
        date: i.date,
        platforms: i.platforms,
        contentType: i.contentType,
        title: `${i.title} (yeni)`,
      })),
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Plan.parse(res.body).items.map((i) => i.generate)).toEqual([false, true]);
    const patched = await api("PATCH", `/api/plans/${planId}/items/${before.items[1]?.id}`, {
      generate: false,
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(Plan.parse(patched.body).items.map((i) => i.generate)).toEqual([false, false]);
  });

  it("regenerates a made post only with force, an edited one only with overwriteEdits", async () => {
    const brand = await createBrand();
    const plan = await acceptedPlan(brand.id, [{}, {}]);
    const gen = await generateOk(plan.id);
    for (const job of gen.jobs) {
      await addVersion(job.contentId ?? "", { jobId: job.id });
      await finishJob(job.id, "succeeded");
    }
    const item = itemOf(plan, 0);

    expectError(await generate(plan.id, { force: true }), 400, "validation_error");
    const needsForce = expectError(await generate(plan.id, { itemIds: [item] }), 409, "conflict");
    expect(needsForce.issues?.[0]).toMatchObject({ path: "itemIds.0" });
    expect(needsForce.message).toContain("force");

    const forced = await generateOk(plan.id, { itemIds: [item], force: true });
    expect(forced.jobs).toHaveLength(1);
    expect(ContentGeneratePayload.parse(forced.jobs[0]?.payload).baseVersion).toBe(1);
    await finishJob(forced.jobs[0]?.id ?? "", "succeeded");

    // Edited by hand: force alone is not enough.
    await addVersion(contentOf(plan, 0), {
      origin: "manual_edit",
      slides: [slide("<html><body>elle</body></html>")],
    });
    const edited = expectError(
      await generate(plan.id, { itemIds: [item], force: true }),
      409,
      "conflict",
    );
    expect(edited.message).toContain("overwriteEdits");
    const confirmed = await generateOk(plan.id, {
      itemIds: [item],
      force: true,
      overwriteEdits: true,
    });
    expect(ContentGeneratePayload.parse(confirmed.jobs[0]?.payload).baseVersion).toBe(2);
  });

  it("protects approved and published posts and skips trashed ones", async () => {
    const brand = await createBrand();
    const plan = await acceptedPlan(brand.id, [{}, {}, {}]);
    const gen = await generateOk(plan.id);
    for (const job of gen.jobs) await finishJob(job.id, "failed");

    // 0: approved (a version made elsewhere, then approved).
    const approvedId = contentOf(plan, 0);
    const version = await addVersion(approvedId);
    const approve = await api("POST", `/api/contents/${approvedId}/approve`, {
      hash: version.contentHash,
      acknowledgeChecks: true,
    });
    expect(approve.status).toBe(200);
    // 1: published.
    await addVersion(contentOf(plan, 1));
    await env.DB.prepare("update contents set status = 'published' where id = ?")
      .bind(contentOf(plan, 1))
      .run();
    // 2: in the trash.
    expect((await api("DELETE", `/api/contents/${contentOf(plan, 2)}`)).status).toBe(204);

    const result = await generateOk(plan.id);
    expect(result.jobs).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toEqual(["approved", "published", "no_content"]);

    const approvedRefusal = expectError(
      await generate(plan.id, { itemIds: [itemOf(plan, 0)] }),
      409,
      "conflict",
    );
    expect(approvedRefusal.message).toContain("onaylı");
    expect(
      (await generate(plan.id, { itemIds: [itemOf(plan, 0)], overwriteEdits: true })).status,
    ).toBe(200);
    const published = expectError(
      await generate(plan.id, {
        itemIds: [itemOf(plan, 1), itemOf(plan, 2)],
        force: true,
        overwriteEdits: true,
      }),
      409,
      "conflict",
    );
    expect(published.issues?.map((i) => i.path)).toEqual(["itemIds.0", "itemIds.1"]);
  });
});

describe("plan items (N2)", () => {
  it("adds, edits and removes items of an open plan (revision goes up)", async () => {
    const brand = await createBrand();
    const planId = await seedPlan(brand.id, [{ title: "Bir" }]);

    const added = await api("POST", `/api/plans/${planId}/items`, {
      date: "2026-12-10",
      platforms: ["instagram"],
      contentType: "carousel",
      title: "İki",
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    const two = Plan.parse(added.body);
    expect(two.revision).toBe(2);
    expect(two.items.map((i) => [i.position, i.title, i.status])).toEqual([
      [0, "Bir", "planned"],
      [1, "İki", "planned"],
    ]);

    const second = two.items[1]?.id ?? "";
    const edited = Plan.parse(
      (await api("PATCH", `/api/plans/${planId}/items/${second}`, { title: "İki (yeni)" })).body,
    );
    expect(edited.revision).toBe(3);
    expect(edited.items[1]?.title).toBe("İki (yeni)");
    expectError(
      await api("PATCH", `/api/plans/${planId}/items/${second}`, { date: "2027-01-02" }),
      400,
      "validation_error",
    );

    const removed = PlanItemRemoveResult.parse(
      (await api("DELETE", `/api/plans/${planId}/items/${two.items[0]?.id}`)).body,
    );
    expect(removed.trashedContentId).toBeNull();
    expect(removed.plan.revision).toBe(4);
    expect(removed.plan.items.map((i) => [i.position, i.title])).toEqual([[0, "İki (yeni)"]]);
    expectError(
      await api("DELETE", `/api/plans/${planId}/items/${second}`),
      400,
      "validation_error",
    );
    // Accepting needs the revision the user saw.
    expectError(await api("POST", `/api/plans/${planId}/accept`, { revision: 1 }), 409, "conflict");
    expect((await api("POST", `/api/plans/${planId}/accept`, { revision: 4 })).status).toBe(200);
  });

  it("keeps an accepted plan's posts in step", async () => {
    const brand = await createBrand();
    const plan = await acceptedPlan(brand.id, [{ title: "Bir" }, { title: "İki" }]);

    const added = Plan.parse(
      (
        await api("POST", `/api/plans/${plan.id}/items`, {
          date: "2026-12-20",
          platforms: ["instagram", "facebook"],
          contentType: "story",
          title: "Üç",
          brief: "Yeni yıl",
        })
      ).body,
    );
    expect(added.revision).toBe(1);
    const third = added.items[2];
    expect(third).toMatchObject({ status: "accepted", title: "Üç" });
    const post = await getContent(third?.contentId ?? "");
    expect(post).toMatchObject({
      title: "Üç",
      brief: "Yeni yıl",
      type: "story",
      status: "draft",
      targetPlatforms: ["instagram", "facebook"],
    });

    // Title, brief, type and platforms follow while the post has no design.
    await api("PATCH", `/api/plans/${plan.id}/items/${itemOf(plan, 0)}`, {
      title: "Bir (yeni)",
      brief: "Kısa",
      contentType: "carousel",
      platforms: ["linkedin"],
      date: "2026-12-05",
    });
    expect(await getContent(contentOf(plan, 0))).toMatchObject({
      title: "Bir (yeni)",
      brief: "Kısa",
      type: "carousel",
      targetPlatforms: ["linkedin"],
    });
    // Once designed, the type stays.
    await addVersion(contentOf(plan, 1));
    expectError(
      await api("PATCH", `/api/plans/${plan.id}/items/${itemOf(plan, 1)}`, {
        contentType: "story",
      }),
      409,
      "conflict",
    );
    // Approved: the platforms stay too.
    const v = await addVersion(contentOf(plan, 0), {
      slides: [slide("a"), slide("b")],
    });
    await api("POST", `/api/contents/${contentOf(plan, 0)}/approve`, {
      hash: v.contentHash,
      acknowledgeChecks: true,
    });
    expectError(
      await api("PATCH", `/api/plans/${plan.id}/items/${itemOf(plan, 0)}`, {
        platforms: ["instagram"],
      }),
      409,
      "conflict",
    );

    // Removing: an empty draft goes to the trash, a designed post stays.
    const gone = PlanItemRemoveResult.parse(
      (await api("DELETE", `/api/plans/${plan.id}/items/${third?.id}`)).body,
    );
    expect(gone.trashedContentId).toBe(third?.contentId);
    expect((await getContent(third?.contentId ?? "")).deletedAt).not.toBeNull();
    const kept = PlanItemRemoveResult.parse(
      (await api("DELETE", `/api/plans/${plan.id}/items/${itemOf(plan, 1)}`)).body,
    );
    expect(kept.trashedContentId).toBeNull();
    expect((await getContent(contentOf(plan, 1))).deletedAt).toBeNull();
    expect(kept.plan.items).toHaveLength(1);
  });

  it("refuses edits to final plans", async () => {
    const brand = await createBrand();
    const planId = await seedPlan(brand.id, [{}]);
    expect((await api("POST", `/api/plans/${planId}/reject`, {})).status).toBe(200);
    const plan = Plan.parse((await api("GET", `/api/plans/${planId}`)).body);
    expectError(
      await api("PATCH", `/api/plans/${planId}/items/${plan.items[0]?.id}`, { title: "x" }),
      409,
      "invalid_transition",
    );
  });
});

describe("job retry (A3)", () => {
  it("queues a stopped job again with the same payload", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    await addVersion(content.id);
    const job = Job.parse(
      (
        await api("POST", "/api/jobs", {
          type: "content.render",
          contentId: content.id,
          payload: { format: "png" },
        })
      ).body,
    );
    expectError(await api("POST", `/api/jobs/${job.id}/retry`), 409, "invalid_transition");
    expect((await api("POST", `/api/jobs/${job.id}/cancel`)).status).toBe(200);
    const res = await api("POST", `/api/jobs/${job.id}/retry`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const retried = Job.parse(res.body);
    expect(retried).toMatchObject({
      type: "content.render",
      status: "queued",
      contentId: content.id,
      brandId: brand.id,
      payload: { format: "png" },
    });
    expect(retried.id).not.toBe(job.id);

    // Not for publishing, and not for a post in the trash.
    const publishId = crypto.randomUUID();
    await env.DB.prepare(
      "insert into jobs (id, type, status, brand_id, payload, created_at, updated_at) values (?, 'schedule.publish', 'failed', ?, '{}', ?, ?)",
    )
      .bind(publishId, brand.id, Date.now(), Date.now())
      .run();
    expectError(await api("POST", `/api/jobs/${publishId}/retry`), 400, "validation_error");
    expect((await api("POST", `/api/jobs/${retried.id}/cancel`)).status).toBe(200);
    expect((await api("DELETE", `/api/contents/${content.id}`)).status).toBe(204);
    expectError(await api("POST", `/api/jobs/${retried.id}/retry`), 409, "conflict");
  });

  it("retries a plan item's generation through its plan", async () => {
    const brand = await createBrand();
    const plan = await acceptedPlan(brand.id, [{}]);
    const gen = await generateOk(plan.id, { instructions: "sade" });
    const failed = gen.jobs[0]?.id ?? "";
    await finishJob(failed, "failed");
    const res = await api("POST", `/api/jobs/${failed}/retry`);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const retried = Job.parse(res.body);
    expect(ContentGeneratePayload.parse(retried.payload)).toMatchObject({
      instructions: "sade",
      planItem: { planId: plan.id, itemId: itemOf(plan, 0) },
    });
    const now = Plan.parse((await api("GET", `/api/plans/${plan.id}`)).body);
    expect(now.items[0]?.generation).toMatchObject({ jobId: retried.id, status: "queued" });
  });
});

describe("one instruction on many posts (N3)", () => {
  it("queues HTML posts, hands canvas posts to the chat and explains the rest", async () => {
    const brand = await createBrand();
    const otherBrand = await createBrand();
    const html = await createContent(brand.id, { title: "Hasat" });
    await addVersion(html.id);
    const empty = await createContent(brand.id, { title: "Boş" });
    const trashed = await createContent(brand.id);
    await addVersion(trashed.id);
    await api("DELETE", `/api/contents/${trashed.id}`);
    const approved = await createContent(brand.id, { title: "Onaylı" });
    const av = await addVersion(approved.id);
    await api("POST", `/api/contents/${approved.id}/approve`, {
      hash: av.contentHash,
      acknowledgeChecks: true,
    });
    const busy = await createContent(brand.id);
    await addVersion(busy.id);
    await api("POST", "/api/jobs", { type: "content.render", contentId: busy.id, payload: {} });

    const canvasPost = async (brandId: string, title: string) => {
      const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 1, 2, 3, 4]);
      const doc = await uploadFile(brandId, zip, WECRA_DOCUMENT_MIME, "post.wecra");
      const content = await createContent(brandId, { title });
      await addVersion(content.id, {
        origin: "manual_edit",
        editorDocument: { kind: "wecra", assetId: doc.id, format: 1 },
      });
      return content;
    };
    const canvas = await canvasPost(brand.id, "Tuval postu");
    const foreign = await canvasPost(otherBrand.id, "Başka marka");

    const res = await api("POST", "/api/contents/revise", {
      contentIds: [html.id, empty.id, trashed.id, approved.id, busy.id, canvas.id, foreign.id],
      instruction: "Başlıkları kısalt",
      model: "sonnet",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const result = ContentReviseResult.parse(res.body);
    expect(result.jobs.map((j) => j.contentId)).toEqual([html.id]);
    expect(ContentGeneratePayload.parse(result.jobs[0]?.payload)).toMatchObject({
      contentId: html.id,
      baseVersion: 1,
      instructions: "Başlıkları kısalt",
      model: "sonnet",
    });
    expect(result.skipped.map((s) => [s.contentId, s.reason])).toEqual([
      [empty.id, "no_version"],
      [trashed.id, "deleted"],
      [approved.id, "approved"],
      [busy.id, "busy"],
      [foreign.id, "brand"],
    ]);
    expect(result.canvas?.contentIds).toEqual([canvas.id]);
    const messages = MessageList.parse(
      (await api("GET", `/api/conversations/${result.canvas?.conversationId}/messages`)).body,
    );
    const text = messages.items
      .flatMap((m) => m.parts)
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n");
    expect(text).toContain("Başlıkları kısalt");
    expect(text).toContain(`contentId: ${canvas.id}`);
    expect(text).toContain("canvas_edit");

    // Approval loss confirmed: the approved post is revised too.
    const confirmed = ContentReviseResult.parse(
      (
        await api("POST", "/api/contents/revise", {
          contentIds: [approved.id],
          instruction: "Kısalt",
          confirmApprovalLoss: true,
        })
      ).body,
    );
    expect(confirmed.jobs.map((j) => j.contentId)).toEqual([approved.id]);
    expect(Content.parse((await api("GET", `/api/contents/${approved.id}`)).body).status).toBe(
      "approved",
    );
  });
});
