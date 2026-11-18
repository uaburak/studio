import { env } from "cloudflare:workers";
import {
  BrandPlanningSettings,
  ContentGeneratePayload,
  Conversation,
  Plan,
  PlanGenerateResult,
  PlanningContext,
  type PlanProposalPut,
  PlanProposalResult,
  SpecialDayList,
  SpecialDayOverrides,
  TurnContext,
  UserMessageResult,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import { api, BASE, createBrand, createContent, expectError, localFetch } from "./helpers.ts";
import { seedPlan } from "./lifecycle-helpers.ts";

/*
 * Special days, planning settings and history (N5, N6): the routes, the history the plan agent
 * reads, the near-duplicate marks on plan items, and the planning context of a chat turn.
 * Dates are fixed (posts are moved to a known day in D1) so the tests do not depend on today.
 */

async function worker<T = unknown>(method: string, path: string, body?: unknown) {
  const res = await localFetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.WORKER_TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = res.headers.get("content-type")?.includes("application/json")
    ? JSON.parse(text)
    : text;
  return { status: res.status, body: parsed as T };
}

/** A post of the brand dated `day` (its creation moved there; no schedule). */
async function postOn(brandId: string, day: string, title: string, caption = "") {
  const content = await createContent(brandId, { title, caption });
  await env.DB.prepare("update contents set created_at = ? where id = ?")
    .bind(Date.parse(`${day}T09:00:00Z`), content.id)
    .run();
  return content;
}

async function context(brandId: string, periodStart = "2026-12-01", periodEnd = "2026-12-31") {
  const res = await api(
    "GET",
    `/api/brands/${brandId}/planning-context?periodStart=${periodStart}&periodEnd=${periodEnd}`,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return PlanningContext.parse(res.body);
}

async function planOf(id: string): Promise<Plan> {
  const res = await api("GET", `/api/plans/${id}`);
  expect(res.status).toBe(200);
  return Plan.parse(res.body);
}

describe("planning settings (N5)", () => {
  it("suggests tags from the brand until the owner saves them", async () => {
    const brand = await createBrand({ name: "MTM Agro" });
    await api("POST", `/api/brands/${brand.id}/products`, {
      name: "Sıvı Gübre",
      category: "Gübre",
    });
    const first = BrandPlanningSettings.parse(
      (await api("GET", `/api/brands/${brand.id}/planning-settings`)).body,
    );
    expect(first).toMatchObject({ sectorTags: [], disabledCategories: [], updatedAt: null });
    expect(first.suggestedTags).toContain("tarim");

    const put = await api("PUT", `/api/brands/${brand.id}/planning-settings`, {
      sectorTags: ["gida", "tarim"],
      disabledCategories: ["ticari"],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const saved = BrandPlanningSettings.parse(put.body);
    expect(saved).toMatchObject({ sectorTags: ["gida", "tarim"], disabledCategories: ["ticari"] });
    expect(saved.updatedAt).not.toBeNull();

    expectError(
      await api("PUT", `/api/brands/${brand.id}/planning-settings`, { sectorTags: ["uzay"] }),
      400,
      "validation_error",
    );
    expectError(await api("GET", "/api/brands/missing/planning-settings"), 404, "not_found");
  });

  it("lists special days with the brand's tags and categories", async () => {
    const brand = await createBrand({ name: "Kahve Durağı" });
    await api("PUT", `/api/brands/${brand.id}/planning-settings`, {
      sectorTags: ["tarim"],
      disabledCategories: ["dini"],
    });
    const res = await api(
      "GET",
      `/api/special-days?from=2026-12-01&to=2026-12-31&brandId=${brand.id}`,
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = SpecialDayList.parse(res.body);
    expect(list.tags).toEqual(["tarim"]);
    expect(list.days.map((d) => d.ruleId)).toContain("dunya-toprak-gunu");
    expect(list.days.some((d) => d.category === "dini")).toBe(false);

    const plain = SpecialDayList.parse(
      (await api("GET", "/api/special-days?from=2026-12-01&to=2026-12-31")).body,
    );
    expect(plain.days.map((d) => d.ruleId)).not.toContain("dunya-toprak-gunu");
    expect(plain.days.map((d) => d.ruleId)).toContain("regaip-kandili");
    expectError(
      await api("GET", "/api/special-days?from=2026-12-31&to=2026-12-01"),
      400,
      "validation_error",
    );
  });

  it("applies the owner's bayram date corrections", async () => {
    const computed = SpecialDayList.parse(
      (await api("GET", "/api/special-days?from=2031-01-01&to=2031-12-31")).body,
    ).days.find((d) => d.ruleId === "kurban-bayrami");
    expect(computed?.approximate).toBe(true);
    const moved = "2031-04-03";
    const put = await api("PUT", "/api/special-days/overrides", {
      overrides: [{ year: 2031, kurbanBayrami: moved }],
    });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(SpecialDayOverrides.parse(put.body).overrides).toEqual([
      { year: 2031, ramazanBayrami: null, kurbanBayrami: moved },
    ]);
    const after = SpecialDayList.parse(
      (await api("GET", "/api/special-days?from=2031-01-01&to=2031-12-31")).body,
    ).days.find((d) => d.ruleId === "kurban-bayrami");
    expect(after).toMatchObject({ date: moved, approximate: false });
    expectError(
      await api("PUT", "/api/special-days/overrides", {
        overrides: [{ year: 2031, kurbanBayrami: "2032-04-03" }],
      }),
      400,
      "validation_error",
    );
    await api("PUT", "/api/special-days/overrides", { overrides: [] });
    expect(
      SpecialDayOverrides.parse((await api("GET", "/api/special-days/overrides")).body).overrides,
    ).toEqual([]);
  });
});

describe("planning history (N6)", () => {
  it("summarises posts, rejected and left-out items and the trash", async () => {
    const brand = await createBrand();
    const post = await postOn(
      brand.id,
      "2026-10-12",
      "Kış öncesi toprak analizi",
      "🌱 Toprağın kışa hazır mı?\nDetaylar…\n#tarim",
    );
    const trashed = await postOn(brand.id, "2026-10-20", "Eski kampanya");
    expect((await api("DELETE", `/api/contents/${trashed.id}`)).status).toBe(204);
    await postOn(brand.id, "2026-05-01", "Çok eski post");

    const rejected = await seedPlan(brand.id, [{ title: "Black Friday indirim duyurusu" }]);
    await api("POST", `/api/plans/${rejected}/reject`, { reason: "kampanyamız yok" });
    const acceptedId = await seedPlan(brand.id, [{ title: "Kalan" }, { title: "Çıkarılan" }]);
    const accepted = await planOf(acceptedId);
    await api("POST", `/api/plans/${acceptedId}/accept`, {
      revision: 1,
      skipItemIds: [accepted.items[1]?.id],
    });

    const ctx = await context(brand.id);
    expect(ctx.history.from).toBe("2026-09-01");
    const byTitle = new Map(ctx.history.entries.map((e) => [e.title, e]));
    expect(byTitle.get("Kış öncesi toprak analizi")).toMatchObject({
      kind: "post",
      contentId: post.id,
      date: "2026-10-12",
      hook: "Toprağın kışa hazır mı?",
      status: "draft",
    });
    expect(byTitle.get("Eski kampanya")).toMatchObject({ kind: "deleted", date: "2026-10-20" });
    expect(byTitle.has("Çok eski post")).toBe(false);
    expect(byTitle.get("Black Friday indirim duyurusu")).toMatchObject({
      kind: "rejected",
      reason: "kampanyamız yok",
    });
    expect(byTitle.get("Çıkarılan")).toMatchObject({ kind: "skipped" });
    // The accepted item is its post, dated by the plan.
    expect(byTitle.get("Kalan")).toMatchObject({ kind: "post", date: "2026-12-01" });
    // Newest first.
    const dates = ctx.history.entries.map((e) => e.date ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(ctx.specialDays.map((d) => d.ruleId)).toContain("yilbasi-gecesi");
  });
});

describe("near-duplicate marks (N6)", () => {
  it("marks plan items that repeat the brand's posts and each other", async () => {
    const brand = await createBrand();
    const post = await postOn(brand.id, "2026-10-12", "Kış öncesi toprak analizi");
    const planId = await seedPlan(brand.id, [{ title: "Yılbaşı mesajı" }, { title: "Post 2" }]);
    const plan = await planOf(planId);
    const [first, second] = plan.items;

    const edited = await api("PATCH", `/api/plans/${planId}/items/${second?.id}`, {
      title: "Kışa hazırlık: toprak analizi",
      hook: "Toprağın kışa hazır mı?",
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const item = Plan.parse(edited.body).items[1];
    expect(item?.hook).toBe("Toprağın kışa hazır mı?");
    expect(item?.similar[0]).toMatchObject({
      kind: "post",
      contentId: post.id,
      date: "2026-10-12",
      field: "title",
    });
    expect(Plan.parse(edited.body).items[0]?.similar).toEqual([]);

    // A new item repeating the first one.
    const added = await api("POST", `/api/plans/${planId}/items`, {
      date: "2026-12-30",
      platforms: ["instagram"],
      contentType: "post",
      title: "Yılbaşı mesajımız",
    });
    expect(added.status, JSON.stringify(added.body)).toBe(200);
    expect(Plan.parse(added.body).items[2]?.similar[0]).toMatchObject({
      kind: "same_plan",
      planItemId: first?.id,
    });

    // A new topic clears the mark; removing the first item clears the one pointing at it.
    const cleared = await api("PATCH", `/api/plans/${planId}/items/${second?.id}`, {
      title: "Damla sulama ile su tasarrufu",
    });
    expect(Plan.parse(cleared.body).items[1]?.similar).toEqual([]);
    const removed = await api("DELETE", `/api/plans/${planId}/items/${first?.id}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await planOf(planId)).items.every((i) => i.similar.length === 0)).toBe(true);
  });

  it("sends the planned hook with the generation brief", async () => {
    const brand = await createBrand();
    const planId = await seedPlan(brand.id, [{ title: "Kış bakımı" }]);
    const plan = await planOf(planId);
    await api("PATCH", `/api/plans/${planId}/items/${plan.items[0]?.id}`, {
      hook: "Bahçen kışa hazır mı?",
    });
    const accepted = await api("POST", `/api/plans/${planId}/accept`, { revision: 2 });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const gen = PlanGenerateResult.parse(
      (await api("POST", `/api/plans/${planId}/generate`, {})).body,
    );
    const payload = ContentGeneratePayload.parse(gen.jobs[0]?.payload);
    expect(payload.brief).toContain("Açılış cümlesi (kanca): Bahçen kışa hazır mı?");
  });
});

describe("planning turns", () => {
  async function conversationWith(brandId: string, text: string) {
    const conv = Conversation.parse((await api("POST", "/api/conversations", { brandId })).body);
    const sent = await api("POST", `/api/conversations/${conv.id}/messages`, { text });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    return UserMessageResult.parse(sent.body);
  }

  it("gives a planning turn its period's special days and the brand's history", async () => {
    const brand = await createBrand();
    await postOn(brand.id, "2026-10-12", "Kış öncesi toprak analizi");
    const sent = await conversationWith(brand.id, "Aralık 2026 planını hazırla");
    const res = await worker("GET", `/api/worker/runs/${sent.run.id}/context`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const planning = TurnContext.parse(res.body).planning;
    expect(planning).toMatchObject({ periodStart: "2026-12-01", periodEnd: "2026-12-31" });
    expect(planning?.specialDays.map((d) => d.ruleId)).toContain("yilbasi-gecesi");
    expect(planning?.history.entries.map((e) => e.title)).toContain("Kış öncesi toprak analizi");

    const other = await conversationWith(brand.id, "Bu postun rengini değiştir");
    const plain = TurnContext.parse(
      (await worker("GET", `/api/worker/runs/${other.run.id}/context`)).body,
    );
    expect(plain.planning ?? null).toBeNull();
  });

  it("marks the agent's plan when it is written", async () => {
    const brand = await createBrand();
    const post = await postOn(brand.id, "2026-10-12", "Kış öncesi toprak analizi");
    const sent = await conversationWith(brand.id, "Aralık 2026 planı");
    expect(
      (await worker("POST", `/api/worker/runs/${sent.run.id}/start`, { attempt: 1 })).status,
    ).toBe(200);
    const body: PlanProposalPut = {
      title: "Aralık",
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
      summary: "",
      items: [
        {
          date: "2026-12-03",
          platforms: ["instagram"],
          contentType: "post",
          title: "Kışa hazırlık: toprak analizi",
          hook: "Toprak analizi yaptırdın mı?",
        },
        { date: "2026-12-31", platforms: ["instagram"], contentType: "post", title: "Yeni yıl" },
      ],
    };
    const res = await worker("PUT", `/api/worker/runs/${sent.run.id}/plan`, body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { plan } = PlanProposalResult.parse(res.body);
    expect(plan.items[0]).toMatchObject({ hook: "Toprak analizi yaptırdın mı?" });
    expect(plan.items[0]?.similar[0]).toMatchObject({ kind: "post", contentId: post.id });
    expect(plan.items[1]?.similar).toEqual([]);
  });
});
