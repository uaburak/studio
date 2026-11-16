import { describe, expect, it } from "vitest";
import {
  ApiErrorBody,
  ASSET_MIME_RULES,
  AssetUploadFields,
  assetMimeRule,
  BrandCreate,
  BrandProfileCreate,
  BrandUpdate,
  ERROR_STATUS,
  ErrorCode,
  JOB_TYPE_REQUIREMENTS,
  Job,
  JobCreate,
  JobType,
  MAX_ASSET_BYTES,
  PageQuery,
  ScheduleCreate,
  SocialAccountCreate,
  slugify,
} from "../src/index.ts";

describe("errors", () => {
  it("maps every error code to one status", () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ErrorCode.options].sort());
    expect(ERROR_STATUS.validation_error).toBe(400);
    expect(ERROR_STATUS.not_found).toBe(404);
    expect(ERROR_STATUS.invalid_transition).toBe(409);
    expect(ERROR_STATUS.hash_mismatch).toBe(409);
  });

  it("parses the error body shape", () => {
    expect(
      ApiErrorBody.safeParse({
        error: { code: "validation_error", message: "bad", issues: [{ path: "a", message: "b" }] },
      }).success,
    ).toBe(true);
    expect(ApiErrorBody.safeParse({ error: "bad" }).success).toBe(false);
  });
});

describe("pagination", () => {
  it("coerces query strings and bounds the limit", () => {
    expect(PageQuery.parse({})).toEqual({ limit: 20 });
    expect(PageQuery.parse({ limit: "5", cursor: "abc" })).toEqual({ limit: 5, cursor: "abc" });
    expect(PageQuery.safeParse({ limit: "0" }).success).toBe(false);
    expect(PageQuery.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("brands", () => {
  it("folds Turkish letters into slugs", () => {
    expect(slugify("MTM Agro / Venta")).toBe("mtm-agro-venta");
    expect(slugify("Çiğ Köfte Şöleni İzmir")).toBe("cig-kofte-soleni-izmir");
    expect(slugify("  --  ")).toBe("");
  });

  it("validates create and update", () => {
    expect(BrandCreate.parse({ name: "Venta" })).toEqual({ name: "Venta", defaultLanguage: "tr" });
    expect(BrandCreate.safeParse({ name: "x", slug: "Not Valid" }).success).toBe(false);
    expect(BrandCreate.safeParse({ name: "x", defaultLanguage: "Turkish" }).success).toBe(false);
    expect(BrandCreate.safeParse({ name: "x", defaultLanguage: "en-US" }).success).toBe(true);
    expect(BrandUpdate.safeParse({}).success).toBe(false);
    expect(BrandUpdate.safeParse({ status: "archived" }).success).toBe(true);
  });
});

describe("social accounts", () => {
  it("defaults to pending and has no credential fields", () => {
    const parsed = SocialAccountCreate.parse({
      brandId: "b",
      platform: "linkedin",
      handle: "Burak",
    });
    expect(parsed.status).toBe("pending");
    expect(
      SocialAccountCreate.safeParse({ brandId: "b", platform: "x", handle: "h" }).success,
    ).toBe(false);
  });
});

describe("brand profiles", () => {
  it("defaults to an empty draft body and rejects non-object tokens", () => {
    expect(BrandProfileCreate.parse({})).toEqual({ tokens: {}, designRules: "", voice: "" });
    expect(BrandProfileCreate.safeParse({ tokens: [] }).success).toBe(false);
  });
});

describe("assets", () => {
  it("resolves mime rules case- and parameter-insensitively", () => {
    expect(assetMimeRule("image/PNG")?.defaultKind).toBe("image");
    expect(assetMimeRule("image/svg+xml; charset=utf-8")?.defaultKind).toBe("logo");
    expect(assetMimeRule("application/x-sh")).toBeUndefined();
    expect(MAX_ASSET_BYTES).toBe(
      Math.max(...Object.values(ASSET_MIME_RULES).map((r) => r.maxBytes)),
    );
  });

  it("coerces form fields", () => {
    expect(AssetUploadFields.parse({ brandId: "b", width: "1080", height: "1350" })).toEqual({
      brandId: "b",
      source: "upload",
      width: 1080,
      height: 1350,
    });
    expect(AssetUploadFields.safeParse({ brandId: "b", width: "-1" }).success).toBe(false);
    expect(AssetUploadFields.safeParse({ brandId: "b", kind: "spreadsheet" }).success).toBe(false);
  });
});

describe("jobs", () => {
  it("stays compatible with existing demo jobs", () => {
    const legacy = {
      id: "job_1",
      type: "demo.echo",
      status: "queued",
      payload: { text: "merhaba" },
      createdAt: "2026-11-16T10:00:00.000Z",
      updatedAt: "2026-11-16T10:00:00.000Z",
    };
    expect(Job.parse(legacy)).toEqual(legacy);
    expect(Job.safeParse({ ...legacy, brandId: "b", contentId: "c" }).success).toBe(true);
  });

  it("declares requirements for every job type", () => {
    expect(Object.keys(JOB_TYPE_REQUIREMENTS).sort()).toEqual([...JobType.options].sort());
    expect(JobCreate.parse({ type: "demo.echo" })).toEqual({ type: "demo.echo", payload: {} });
    expect(JobCreate.safeParse({ type: "unknown" }).success).toBe(false);
  });
});

describe("schedules", () => {
  it("requires an ISO timestamp", () => {
    const base = { contentId: "c", socialAccountId: "a" };
    expect(ScheduleCreate.safeParse({ ...base, scheduledAt: "2026-12-01T09:00:00Z" }).success).toBe(
      true,
    );
    expect(ScheduleCreate.safeParse({ ...base, scheduledAt: "tomorrow" }).success).toBe(false);
  });
});
