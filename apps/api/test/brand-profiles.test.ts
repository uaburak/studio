import { BrandProfile, BrandProfileList } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { api, createBrand, expectError } from "./helpers.ts";

const base = (brandId: string) => `/api/brands/${brandId}/profiles`;

describe("brand profiles", () => {
  it("creates numbered drafts, approves one and exposes it as current", async () => {
    const brand = await createBrand();
    expectError(await api("GET", `${base(brand.id)}/current`), 404, "not_found");

    const v1 = BrandProfile.parse(
      (
        await api("POST", base(brand.id), {
          tokens: { colors: { primary: "#0a7f3f" } },
          designRules: "# DESIGN",
          voice: "# VOICE",
        })
      ).body,
    );
    expect(v1).toMatchObject({ version: 1, status: "draft", isCurrent: false, approvedAt: null });

    const edited = await api("PATCH", `${base(brand.id)}/1`, { voice: "samimi, kısa" });
    expect(BrandProfile.parse(edited.body).voice).toBe("samimi, kısa");

    const approved = BrandProfile.parse((await api("POST", `${base(brand.id)}/1/approve`)).body);
    expect(approved).toMatchObject({ status: "approved", isCurrent: true });
    expect(approved.approvedAt).not.toBeNull();

    const current = BrandProfile.parse((await api("GET", `${base(brand.id)}/current`)).body);
    expect(current.id).toBe(v1.id);
  });

  it("keeps exactly one current version and allows rollback", async () => {
    const brand = await createBrand();
    await api("POST", base(brand.id), {});
    await api("POST", base(brand.id), { voice: "v2" });
    await api("POST", `${base(brand.id)}/1/approve`);
    await api("POST", `${base(brand.id)}/2/approve`);

    const list = BrandProfileList.parse((await api("GET", base(brand.id))).body);
    expect(list.items.map((p) => [p.version, p.status, p.isCurrent])).toEqual([
      [2, "approved", true],
      [1, "approved", false],
    ]);

    // Rollback: re-approving v1 makes it current again.
    await api("POST", `${base(brand.id)}/1/approve`);
    const current = BrandProfile.parse((await api("GET", `${base(brand.id)}/current`)).body);
    expect(current.version).toBe(1);
    const approvedOnly = BrandProfileList.parse(
      (await api("GET", `${base(brand.id)}?status=approved`)).body,
    );
    expect(approvedOnly.items.filter((p) => p.isCurrent)).toHaveLength(1);
  });

  it("refuses to edit an approved version and validates input", async () => {
    const brand = await createBrand();
    await api("POST", base(brand.id), {});
    await api("POST", `${base(brand.id)}/1/approve`);
    expectError(
      await api("PATCH", `${base(brand.id)}/1`, { voice: "late edit" }),
      409,
      "invalid_transition",
    );
    expectError(await api("POST", base(brand.id), { tokens: "nope" }), 400, "validation_error");
    expectError(await api("GET", `${base(brand.id)}/abc`), 400, "validation_error");
    expectError(await api("GET", `${base(brand.id)}/99`), 404, "not_found");
    expectError(await api("POST", base("missing-brand"), {}), 404, "not_found");
  });
});
