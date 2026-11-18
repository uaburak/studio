import {
  BrandCheckSettings,
  CHECK_IDS,
  CheckStrictness,
  Content,
  type ContentCheckResultInput,
  ContentCheckRun,
  type ContentCheckRunCreate,
  ContentCheckRunList,
  JobType,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import { ENUMS } from "../src/db/schema.ts";
import { addVersion, api, createBrand, createContent, expectError, slide } from "./helpers.ts";

const result = (
  checkId: string,
  status: ContentCheckResultInput["status"],
  overrides: Partial<ContentCheckResultInput> = {},
): ContentCheckResultInput => ({
  checkId,
  category: checkId.split(".")[0] as ContentCheckResultInput["category"],
  status,
  message: `${checkId} ${status}`,
  refs: [],
  evidence: null,
  source: "deterministic",
  fixable: false,
  ...overrides,
});

describe("check settings", () => {
  it("returns defaults, saves and validates", async () => {
    const brand = await createBrand();
    const path = `/api/brands/${brand.id}/check-settings`;

    const initial = await api("GET", path);
    expect(initial.status).toBe(200);
    expect(BrandCheckSettings.parse(initial.body)).toEqual({
      brandId: brand.id,
      disabledChecks: [],
      bannedWords: [],
      strictness: "standard",
      autoFix: true,
      updatedAt: null,
    });

    const saved = await api("PUT", path, {
      disabledChecks: ["text.language", "brand.voice"],
      bannedWords: [" ücretsiz ", "garanti"],
      strictness: "strict",
      autoFix: false,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const body = BrandCheckSettings.parse(saved.body);
    expect(body).toMatchObject({
      disabledChecks: ["text.language", "brand.voice"],
      bannedWords: ["ücretsiz", "garanti"],
      strictness: "strict",
      autoFix: false,
    });
    expect(body.updatedAt).not.toBeNull();

    // A second PUT replaces the row (defaults for omitted fields).
    const replaced = await api("PUT", path, { bannedWords: ["bedava"] });
    expect(BrandCheckSettings.parse(replaced.body)).toMatchObject({
      disabledChecks: [],
      bannedWords: ["bedava"],
      strictness: "standard",
      autoFix: true,
    });
    expect((await api("GET", path)).body).toMatchObject({ bannedWords: ["bedava"] });

    expectError(await api("PUT", path, { disabledChecks: ["nope"] }), 400, "validation_error");
    expectError(
      await api("PUT", path, { bannedWords: ["Garanti", "garanti"] }),
      400,
      "validation_error",
    );
    expectError(await api("GET", "/api/brands/missing-brand/check-settings"), 404, "not_found");
  });

  it("keeps the strictness enum in sync with the contract", () => {
    expect([...ENUMS.checkStrictness]).toEqual(CheckStrictness.options);
    expect(JobType.options).toContain("content.check");
  });
});

describe("content check runs", () => {
  it("stores runs per version, sorted, with summary and blocking", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    await addVersion(content.id);
    await addVersion(content.id, { slides: [slide("<html><body>v2</body></html>")] });
    const path = `/api/contents/${content.id}/checks`;

    const empty = await api("GET", path);
    expect(ContentCheckRunList.parse(empty.body).items).toEqual([]);

    const v1: ContentCheckRunCreate = {
      version: 1,
      trigger: "generate",
      jobId: "job_1",
      results: [
        result("layout.overflow", "pass"),
        result("text.hashtags", "warn"),
        result("layout.safe-area", "fail", {
          refs: [{ slide: 0, layer: "headline" }],
          evidence: { overflow: 24 },
          fixable: true,
        }),
      ],
      fixedVersion: 2,
      note: "ilk",
    };
    const created = await api("POST", path, v1);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const run1 = ContentCheckRun.parse(created.body);
    expect(run1).toMatchObject({
      contentId: content.id,
      brandId: brand.id,
      version: 1,
      trigger: "generate",
      strictness: "standard",
      summary: { pass: 1, warn: 1, fail: 1, fixed: 0, skipped: 0 },
      blocking: 1,
      fixedVersion: 2,
      fromVersion: null,
      model: null,
    });
    expect(run1.results.map((r) => r.status)).toEqual(["fail", "warn", "pass"]);
    expect(run1.results[0]).toMatchObject({ refs: [{ slide: 0, layer: "headline" }] });

    // Strict: warnings block too.
    const strict = await api("POST", path, {
      version: 2,
      trigger: "fix",
      strictness: "strict",
      fromVersion: 1,
      model: "gemini-2.5-flash-lite",
      results: [result("layout.safe-area", "fixed"), result("text.hashtags", "warn")],
    });
    expect(strict.status).toBe(201);
    expect(ContentCheckRun.parse(strict.body)).toMatchObject({
      version: 2,
      blocking: 1,
      summary: { fixed: 1, warn: 1 },
      fromVersion: 1,
      model: "gemini-2.5-flash-lite",
    });

    const all = ContentCheckRunList.parse((await api("GET", path)).body);
    expect(all.items.map((r) => r.version)).toEqual([2, 1]);
    const latestV1 = ContentCheckRunList.parse(
      (await api("GET", `${path}?version=1&limit=1`)).body,
    );
    expect(latestV1.items.map((r) => r.id)).toEqual([run1.id]);

    expectError(await api("POST", path, { ...v1, version: 9 }), 404, "not_found");
    expectError(
      await api("POST", path, { ...v1, results: [{ ...result("x.y", "pass"), status: "ok" }] }),
      400,
      "validation_error",
    );
    expectError(await api("GET", "/api/contents/missing/checks"), 404, "not_found");

    // Runs go with their content.
    expect((await api("DELETE", `/api/contents/${content.id}`)).status).toBe(204);
  });
});

describe("approval gate (E7)", () => {
  const approve = (id: string, hash: string, acknowledgeChecks?: boolean) =>
    api("POST", `/api/contents/${id}/approve`, {
      hash,
      ...(acknowledgeChecks === undefined ? {} : { acknowledgeChecks }),
    });
  const storeRun = async (
    contentId: string,
    version: number,
    results: ContentCheckResultInput[],
    strictness?: "relaxed" | "standard" | "strict",
  ) => {
    const res = await api("POST", `/api/contents/${contentId}/checks`, {
      version,
      trigger: "render",
      ...(strictness ? { strictness } : {}),
      results,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };

  it("refuses a version with no finished run, unless the checks are acknowledged", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    const v1 = await addVersion(content.id);

    const refused = expectError(await approve(content.id, v1.contentHash), 409, "conflict");
    expect(refused.message).toContain("kontrol");
    expect(refused.message).toContain("v1");
    // Still a draft.
    expect(Content.parse((await api("GET", `/api/contents/${content.id}`)).body).status).toBe(
      "draft",
    );

    const ok = await approve(content.id, v1.contentHash, true);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(Content.parse(ok.body).status).toBe("approved");
  });

  it("refuses failures of the latest run of that exact version, with the results as issues", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    await addVersion(content.id);
    const v2 = await addVersion(content.id, { slides: [slide("<html><body>v2</body></html>")] });

    // Only v1 was checked: v2 has no run of its own.
    await storeRun(content.id, 1, [result("layout.overflow", "pass")]);
    expectError(await approve(content.id, v2.contentHash), 409, "conflict");

    await storeRun(content.id, 2, [
      result("layout.overflow", "fail", { message: "Başlık taşıyor." }),
      result("text.hashtags", "warn"),
      result("layout.contrast", "pass"),
    ]);
    const refused = expectError(await approve(content.id, v2.contentHash), 409, "conflict");
    expect(refused.message).toMatch(/v2 için 1 kontrol geçmedi/);
    expect(refused.message).toContain("Metin taşması");
    expect(refused.issues).toEqual([
      { path: "checks.layout.overflow", message: "Metin taşması: Başlık taşıyor." },
    ]);
    // An explicit `false` is no acknowledgement.
    expectError(await approve(content.id, v2.contentHash, false), 409, "conflict");

    // A newer run of the same version decides (the fix went in, re-checked).
    await storeRun(content.id, 2, [
      result("layout.overflow", "pass"),
      result("text.hashtags", "warn"),
    ]);
    const ok = await approve(content.id, v2.contentHash);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("follows the brand's current settings: switched-off checks and strictness", async () => {
    const brand = await createBrand();
    const settings = `/api/brands/${brand.id}/check-settings`;
    const content = await createContent(brand.id);
    const v1 = await addVersion(content.id);
    await storeRun(content.id, 1, [
      result("layout.contrast", "fail"),
      result("text.hashtags", "warn"),
    ]);
    expectError(await approve(content.id, v1.contentHash), 409, "conflict");

    // Contrast switched off: its failure no longer holds approval back …
    await api("PUT", settings, { disabledChecks: ["layout.contrast"] });
    // … but strict makes the warning block.
    await api("PUT", settings, { disabledChecks: ["layout.contrast"], strictness: "strict" });
    const strict = expectError(await approve(content.id, v1.contentHash), 409, "conflict");
    expect(strict.issues?.map((i) => i.path)).toEqual(["checks.text.hashtags"]);

    await api("PUT", settings, { disabledChecks: ["layout.contrast"], strictness: "standard" });
    expect((await approve(content.id, v1.contentHash)).status).toBe(200);
  });

  it("does not wait for runs when the brand switched every check off", async () => {
    const brand = await createBrand();
    await api("PUT", `/api/brands/${brand.id}/check-settings`, { disabledChecks: [...CHECK_IDS] });
    const content = await createContent(brand.id);
    const v1 = await addVersion(content.id);
    expect((await approve(content.id, v1.contentHash)).status).toBe(200);
  });

  it("keeps the earlier refusals first (no version, wrong hash, wrong status)", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    expectError(await approve(content.id, "0".repeat(64)), 409, "conflict");
    await addVersion(content.id);
    expectError(await approve(content.id, "f".repeat(64)), 409, "hash_mismatch");
  });
});
