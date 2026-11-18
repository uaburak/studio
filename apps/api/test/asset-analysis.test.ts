import { env } from "cloudflare:workers";
import {
  AiPreferences,
  Asset,
  AssetAnalysisBackfillResult,
  AssetAnalysisPendingList,
  type AssetAnalysisPut,
  AssetAnalysisStatus,
  AssetList,
  AssetSimilarList,
  JobList,
  PurgeResult,
  TRASH_RETENTION_DAYS,
  WorkerAiSettings,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import { ENUMS } from "../src/db/schema.ts";
import { api, BASE, createBrand, expectError, localFetch } from "./helpers.ts";
import { solidPng, uploadFile } from "./lifecycle-helpers.ts";

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

/** A unit vector of `count` Float32 values pointing mostly along `axis`, base64 little-endian. */
function print(axis: number, tilt = 0, count = 8): string {
  const values = new Float32Array(count);
  values[axis] = Math.cos(tilt);
  values[(axis + 1) % count] = Math.sin(tilt);
  const bytes = new Uint8Array(values.buffer);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function analysis(overrides: Partial<AssetAnalysisPut> = {}): AssetAnalysisPut {
  return {
    status: "complete",
    version: 1,
    tags: [
      { id: "wheat", label: "buğday", confidence: 0.82 },
      { id: "agriculture", label: "tarım", confidence: 0.6 },
    ],
    text: "VENTA BORİNÇ\nGÜBRE 25 KG",
    colors: [{ hex: "#d4a017", share: 0.55, name: "sarı" }],
    orientation: "portrait",
    aspectRatio: 0.8,
    isCutout: false,
    isLogoLike: false,
    featurePrint: { revision: 2, count: 8, data: print(0) },
    helperVersion: "1.0.0",
    ...overrides,
  };
}

async function queuedAnalyzeJobs(brandId?: string) {
  const res = await api(
    "GET",
    `/api/jobs?type=media.analyze&status=queued${brandId ? `&brandId=${brandId}` : ""}`,
  );
  return JobList.parse(res.body).items;
}

describe("media tagging (N12)", () => {
  it("keeps the schema's status values in step with the contract", () => {
    expect([...ENUMS.assetAnalysisStatus]).toEqual([...AssetAnalysisStatus.options]);
  });

  it("queues one waiting media.analyze job per brand for uploaded pictures", async () => {
    const brand = await createBrand();
    const png = await solidPng(8, 8);
    const first = await uploadFile(brand.id, png, "image/png", "tarla.png");
    expect(first.analysis).toBeNull();
    await uploadFile(brand.id, png, "image/png", "tarla-2.png");
    const jobs = await queuedAnalyzeJobs(brand.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "media.analyze",
      brandId: brand.id,
      payload: { reason: "upload", includePartial: false },
    });
    // A rendered slide (generated) is not tagged; a PDF is not a picture.
    const other = await createBrand();
    await uploadFile(other.id, png, "image/png", "post-v1-1.png", "generated");
    await uploadFile(
      other.id,
      new Uint8Array(new TextEncoder().encode("%PDF-1.4\n")),
      "application/pdf",
      "katalog.pdf",
    );
    expect(await queuedAnalyzeJobs(other.id)).toHaveLength(0);
  });

  it("lets the worker list waiting pictures and store what Vision read", async () => {
    const brand = await createBrand();
    const png = await solidPng(8, 8);
    const a = await uploadFile(brand.id, png, "image/png", "Çiçek tarlası.png");
    const b = await uploadFile(brand.id, png, "image/png", "çuval.png");
    const ai = await uploadFile(brand.id, png, "image/png", "ai-image-1.png", "generated");
    const render = await uploadFile(brand.id, png, "image/png", "post-v2-1.png", "generated");

    // Worker token only.
    const anonymous = await localFetch(`${BASE}/api/worker/assets/analysis/pending`);
    expect(anonymous.status).toBe(401);

    const pending = AssetAnalysisPendingList.parse(
      (await worker("GET", `/api/worker/assets/analysis/pending?brandId=${brand.id}&limit=10`))
        .body,
    );
    expect(pending.items.map((x) => x.id).sort()).toEqual([a.id, ai.id, b.id].sort());
    expect(pending.items.map((x) => x.id)).not.toContain(render.id);

    const put = await worker("PUT", `/api/worker/assets/${a.id}/analysis`, analysis());
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const stored = Asset.parse(put.body);
    expect(stored.analysis).toMatchObject({
      status: "complete",
      tags: [
        { id: "wheat", label: "buğday" },
        { id: "agriculture", label: "tarım" },
      ],
      text: "VENTA BORİNÇ\nGÜBRE 25 KG",
      orientation: "portrait",
      hasFeaturePrint: true,
    });
    // The feature print stays on the server.
    expect(JSON.stringify(put.body)).not.toContain(print(0));
    const got = Asset.parse((await api("GET", `/api/assets/${a.id}`)).body);
    expect(got.analysis?.tags[0]?.label).toBe("buğday");

    const after = AssetAnalysisPendingList.parse(
      (await worker("GET", `/api/worker/assets/analysis/pending?brandId=${brand.id}`)).body,
    );
    expect(after.items.map((x) => x.id)).not.toContain(a.id);

    // A partial analysis (no Vision helper) is redone only when asked for.
    await worker(
      "PUT",
      `/api/worker/assets/${b.id}/analysis`,
      analysis({ status: "partial", tags: [], text: "", featurePrint: null, note: "yok" }),
    );
    const without = AssetAnalysisPendingList.parse(
      (await worker("GET", `/api/worker/assets/analysis/pending?brandId=${brand.id}`)).body,
    );
    expect(without.items.map((x) => x.id)).not.toContain(b.id);
    const withPartial = AssetAnalysisPendingList.parse(
      (
        await worker(
          "GET",
          `/api/worker/assets/analysis/pending?brandId=${brand.id}&includePartial=true`,
        )
      ).body,
    );
    expect(withPartial.items.map((x) => x.id)).toContain(b.id);

    // Not a picture: refused.
    const pdf = await uploadFile(
      brand.id,
      new Uint8Array(new TextEncoder().encode("%PDF-1.4\n")),
      "application/pdf",
      "katalog.pdf",
    );
    expectError(
      await worker("PUT", `/api/worker/assets/${pdf.id}/analysis`, analysis()),
      415,
      "unsupported_media_type",
    );
    expectError(
      await worker("PUT", `/api/worker/assets/${a.id}/analysis`, { status: "complete" }),
      400,
      "validation_error",
    );
  });

  it("searches names, Turkish tags, English identifiers, text and colours", async () => {
    const brand = await createBrand();
    const png = await solidPng(8, 8);
    const wheat = await uploadFile(brand.id, png, "image/png", "IMG_0001.png");
    const flower = await uploadFile(brand.id, png, "image/png", "Çiçek.png");
    const logo = await uploadFile(brand.id, png, "image/png", "marka.png");
    await worker("PUT", `/api/worker/assets/${wheat.id}/analysis`, analysis());
    await worker(
      "PUT",
      `/api/worker/assets/${logo.id}/analysis`,
      analysis({
        tags: [],
        text: "MTM AGRO",
        colors: [{ hex: "#1a7f37", share: 0.7, name: "yeşil" }],
        orientation: "square",
        isLogoLike: true,
        isCutout: true,
      }),
    );
    const search = async (q: string) =>
      AssetList.parse(
        (await api("GET", `/api/assets?brandId=${brand.id}&q=${encodeURIComponent(q)}`)).body,
      ).items.map((a) => a.id);

    expect(await search("buğday")).toEqual([wheat.id]);
    expect(await search("BUGDAY")).toEqual([wheat.id]);
    expect(await search("wheat")).toEqual([wheat.id]);
    expect(await search("borinç gübre")).toEqual([wheat.id]);
    expect(await search("cicek")).toEqual([flower.id]);
    expect(await search("yeşil logo")).toEqual([logo.id]);
    expect(await search("dekupe")).toEqual([logo.id]);
    expect(await search("kare")).toEqual([logo.id]);
    expect(await search("buğday logo")).toEqual([]);
    expect((await search("görsel")).sort()).toEqual([flower.id, logo.id, wheat.id].sort());

    // Pages keep working with a query.
    const page = AssetList.parse(
      (await api("GET", `/api/assets?brandId=${brand.id}&q=görsel&limit=2`)).body,
    );
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    const rest = AssetList.parse(
      (
        await api(
          "GET",
          `/api/assets?brandId=${brand.id}&q=görsel&limit=2&cursor=${page.nextCursor}`,
        )
      ).body,
    );
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeNull();

    // A plain list carries the analysis too.
    const all = AssetList.parse((await api("GET", `/api/assets?brandId=${brand.id}`)).body);
    expect(all.items.find((a) => a.id === wheat.id)?.analysis?.tags).toHaveLength(2);
    expect(all.items.find((a) => a.id === flower.id)?.analysis).toBeNull();
  });

  it("finds similar pictures of the same brand by feature print", async () => {
    const brand = await createBrand();
    const png = await solidPng(8, 8);
    const [a, near, far, plain] = [
      await uploadFile(brand.id, png, "image/png", "a.png"),
      await uploadFile(brand.id, png, "image/png", "near.png"),
      await uploadFile(brand.id, png, "image/png", "far.png"),
      await uploadFile(brand.id, png, "image/png", "plain.png"),
    ];
    const elsewhere = await uploadFile((await createBrand()).id, png, "image/png", "x.png");
    await worker("PUT", `/api/worker/assets/${a.id}/analysis`, analysis());
    await worker(
      "PUT",
      `/api/worker/assets/${near.id}/analysis`,
      analysis({ featurePrint: { revision: 2, count: 8, data: print(0, 0.2) } }),
    );
    await worker(
      "PUT",
      `/api/worker/assets/${far.id}/analysis`,
      analysis({ featurePrint: { revision: 2, count: 8, data: print(3) } }),
    );
    await worker("PUT", `/api/worker/assets/${elsewhere.id}/analysis`, analysis());

    const similar = AssetSimilarList.parse(
      (await api("GET", `/api/assets/${a.id}/similar?limit=5`)).body,
    );
    expect(similar.note).toBeNull();
    expect(similar.items.map((i) => i.asset.id)).toEqual([near.id, far.id]);
    expect(similar.items[0]?.distance).toBeCloseTo(2 * Math.sin(0.1), 3);
    expect(similar.items[1]?.distance).toBeCloseTo(Math.SQRT2, 3);
    expect(similar.items[0]?.similarity).toBeGreaterThan(similar.items[1]?.similarity ?? 1);

    const none = AssetSimilarList.parse((await api("GET", `/api/assets/${plain.id}/similar`)).body);
    expect(none.items).toEqual([]);
    expect(none.note).toMatch(/henüz okunmadı/);

    // A trashed picture is not suggested.
    expect((await api("DELETE", `/api/assets/${near.id}`)).status).toBe(204);
    const afterDelete = AssetSimilarList.parse(
      (await api("GET", `/api/assets/${a.id}/similar`)).body,
    );
    expect(afterDelete.items.map((i) => i.asset.id)).toEqual([far.id]);
  });

  it("backfill queues one job for the pictures not read yet", async () => {
    const brand = await createBrand();
    const png = await solidPng(8, 8);
    const one = await uploadFile(brand.id, png, "image/png", "eski.png");
    // The upload already queued a job; the backfill reports that one.
    const first = AssetAnalysisBackfillResult.parse(
      (await api("POST", "/api/assets/analysis/backfill", { brandId: brand.id })).body,
    );
    expect(first.pending).toBe(1);
    expect(first.queued).toBe(true);
    expect(first.jobId).toBe((await queuedAnalyzeJobs(brand.id))[0]?.id);

    await worker("PUT", `/api/worker/assets/${one.id}/analysis`, analysis());
    const none = AssetAnalysisBackfillResult.parse(
      (await api("POST", "/api/assets/analysis/backfill", { brandId: brand.id })).body,
    );
    expect(none).toEqual({ pending: 0, queued: false, jobId: null });

    // Worker-started backfill of partial analyses gets its own job.
    await worker(
      "PUT",
      `/api/worker/assets/${one.id}/analysis`,
      analysis({ status: "partial", featurePrint: null }),
    );
    const partial = await worker("POST", "/api/assets/analysis/backfill", {
      brandId: brand.id,
      includePartial: true,
    });
    const parsed = AssetAnalysisBackfillResult.parse(partial.body);
    expect(parsed).toMatchObject({ pending: 1, queued: true });
    const jobs = await queuedAnalyzeJobs(brand.id);
    expect(jobs.find((j) => j.id === parsed.jobId)?.payload).toMatchObject({
      reason: "backfill",
      includePartial: true,
    });
    expectError(
      await api("POST", "/api/assets/analysis/backfill", { brandId: "missing-brand" }),
      404,
      "not_found",
    );
  });

  it("purges a trashed picture together with its analysis", async () => {
    const brand = await createBrand();
    const photo = await uploadFile(brand.id, await solidPng(8, 8), "image/png", "eski.png");
    await worker("PUT", `/api/worker/assets/${photo.id}/analysis`, analysis());
    expect((await api("DELETE", `/api/assets/${photo.id}`)).status).toBe(204);
    const past = Date.now() - (TRASH_RETENTION_DAYS + 1) * 86_400_000;
    await env.DB.prepare("update assets set deleted_at = ? where id = ?")
      .bind(past, photo.id)
      .run();
    const result = PurgeResult.parse((await api("POST", "/api/maintenance/purge")).body);
    expect(result.assets).toBeGreaterThanOrEqual(1);
    expectError(await api("GET", `/api/assets/${photo.id}`), 404, "not_found");
    const left = await env.DB.prepare("select count(*) as n from asset_analyses where asset_id = ?")
      .bind(photo.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("keeps the AI caption switch off by default and hands it to the worker", async () => {
    const before = AiPreferences.parse((await api("GET", "/api/ai/preferences")).body);
    expect(before.mediaCaptions).toBe(false);
    const on = AiPreferences.parse(
      (await api("PUT", "/api/ai/preferences", { mediaCaptions: true })).body,
    );
    expect(on.mediaCaptions).toBe(true);
    const settings = WorkerAiSettings.parse(
      (await worker("GET", "/api/worker/ai/settings?tzOffset=180")).body,
    );
    expect(settings.mediaCaptions).toBe(true);
    await api("PUT", "/api/ai/preferences", { mediaCaptions: false });
  });
});
