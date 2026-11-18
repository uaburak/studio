import { env } from "cloudflare:workers";
import { GenerationEstimate } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { perPostMs } from "../src/routes/bulk.ts";
import { api, createBrand, expectError } from "./helpers.ts";

async function estimate(query: string) {
  const res = await api("GET", `/api/estimates/generation?${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return GenerationEstimate.parse(res.body);
}

describe("generation estimate (N4)", () => {
  it("uses the dated defaults before any generation finished", async () => {
    const result = await estimate("count=10&imageSlots=2");
    expect(result).toMatchObject({
      count: 10,
      basis: "default",
      sampleSize: 0,
      perItemSeconds: 180,
      totalSeconds: 1800,
      defaultsAsOf: "2026-11-18",
      perItemUsd: 0,
      textUsd: 0,
      imageSlots: 2,
      imagesIncluded: false,
      totalUsd: 0,
      budgetRemainingUsd: null,
    });
    // A priced picture model from the shared pricing table.
    expect(result.perImageUsd).toBeGreaterThan(0);
    expect(result.imageUsd).toBeCloseTo(result.perImageUsd * 2, 6);
    expectError(await api("GET", "/api/estimates/generation?count=0"), 400, "validation_error");
  });

  it("measures time and spend from finished generations", async () => {
    const brand = await createBrand();
    const now = Date.now();
    const ids: string[] = [];
    // Four posts made back to back: each took 100 s, one finished every 60 s.
    for (let i = 0; i < 4; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      const finished = now - (4 - i) * 60_000;
      await env.DB.prepare(
        "insert into jobs (id, type, status, brand_id, payload, created_at, updated_at, started_at, finished_at) values (?, 'content.generate', 'succeeded', ?, '{}', ?, ?, ?, ?)",
      )
        .bind(id, brand.id, finished - 100_000, finished, finished - 100_000, finished)
        .run();
    }
    const usage = (jobId: string | null, kind: string, cost: number) =>
      env.DB.prepare(
        "insert into ai_usage (id, provider, model, kind, job_id, cost_usd, occurred_at, created_at) values (?, 'gemini', 'gemini-3.1-flash-image', ?, ?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), kind, jobId, cost, now, now)
        .run();
    await usage(ids[0] ?? null, "generate", 0.02);
    await usage(ids[1] ?? null, "generate", 0.02);
    await usage(null, "image", 0.05);
    await env.DB.prepare(
      "insert into ai_settings (id, gemini_monthly_budget_usd, updated_at) values ('main', 10, ?) on conflict(id) do update set gemini_monthly_budget_usd = 10",
    )
      .bind(now)
      .run();

    const result = await estimate(`count=10&imageSlots=2&brandId=${brand.id}`);
    expect(result).toMatchObject({
      basis: "history",
      sampleSize: 4,
      perItemSeconds: 60,
      totalSeconds: 600,
      perItemUsd: 0.01,
      textUsd: 0.1,
      perImageUsd: 0.05,
      imageUsd: 0.1,
      totalUsd: 0.1,
      budgetRemainingUsd: 9.91,
    });
  });

  it("falls back to the median duration without back-to-back runs", () => {
    const hour = 3_600_000;
    expect(
      perPostMs([
        { startedAt: 0, finishedAt: 50_000 },
        { startedAt: hour, finishedAt: hour + 70_000 },
        { startedAt: 3 * hour, finishedAt: 3 * hour + 90_000 },
      ]),
    ).toBe(70_000);
    expect(perPostMs([])).toBe(0);
  });
});
