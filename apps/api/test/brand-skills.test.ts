import {
  BrandSkill,
  BrandSkillList,
  BrandSkillVersion,
  BrandSkillVersionList,
  MAX_BRAND_SKILLS,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import { api, createBrand, expectError } from "./helpers.ts";

const skillsPath = (brandId: string) => `/api/brands/${brandId}/skills`;
const skillPath = (brandId: string, skillId: string) => `/api/brands/${brandId}/skills/${skillId}`;

const MTM = `# MTM Agro post formatı

## Ölçüler
- 1080×1350, kenar boşluğu 72 px.
- Başlık sol üstte, 96 px.

## Yapma
- Ürün adını kısaltma.`;

async function createSkill(brandId: string, body: Record<string, unknown> = {}) {
  const res = await api("POST", skillsPath(brandId), {
    name: "mtm",
    description: "MTM Agro tek görsel post formatı",
    body: MTM,
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return BrandSkill.parse(res.body);
}

describe("brand skills", () => {
  it("creates, versions, toggles, restores and deletes a skill", async () => {
    const brand = await createBrand();
    const skill = await createSkill(brand.id);
    expect(skill).toMatchObject({
      brandId: brand.id,
      name: "mtm",
      enabled: true,
      version: 1,
      origin: "manual",
    });

    // Switching it off is not a new version.
    const off = BrandSkill.parse(
      (await api("PATCH", skillPath(brand.id, skill.id), { enabled: false })).body,
    );
    expect(off).toMatchObject({ enabled: false, version: 1 });

    // A body change is version 2 (with its note); the same text again changes nothing.
    const edited = await api("PATCH", skillPath(brand.id, skill.id), {
      body: `${MTM}\n- Logoyu sağ alta koy.`,
      note: "logo kuralı",
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const v2 = BrandSkill.parse(edited.body);
    expect(v2).toMatchObject({ version: 2, enabled: false, origin: "manual" });
    expect(v2.body).toContain("sağ alta");
    const same = BrandSkill.parse(
      (await api("PATCH", skillPath(brand.id, skill.id), { body: v2.body })).body,
    );
    expect(same.version).toBe(2);

    // Rename + enable in one edit.
    const v3 = BrandSkill.parse(
      (
        await api("PATCH", skillPath(brand.id, skill.id), {
          name: "mtm-post",
          enabled: true,
        })
      ).body,
    );
    expect(v3).toMatchObject({ name: "mtm-post", version: 3, enabled: true });

    const versions = BrandSkillVersionList.parse(
      (await api("GET", `${skillPath(brand.id, skill.id)}/versions`)).body,
    );
    expect(versions.items.map((v) => v.version)).toEqual([3, 2, 1]);
    expect(versions.items[1]?.note).toBe("logo kuralı");
    const page = BrandSkillVersionList.parse(
      (await api("GET", `${skillPath(brand.id, skill.id)}/versions?limit=2`)).body,
    );
    expect(page.items.map((v) => v.version)).toEqual([3, 2]);
    const rest = BrandSkillVersionList.parse(
      (
        await api(
          "GET",
          `${skillPath(brand.id, skill.id)}/versions?limit=2&cursor=${page.nextCursor}`,
        )
      ).body,
    );
    expect(rest.items.map((v) => v.version)).toEqual([1]);

    const v1 = BrandSkillVersion.parse(
      (await api("GET", `${skillPath(brand.id, skill.id)}/versions/1`)).body,
    );
    expect(v1).toMatchObject({ name: "mtm", body: MTM, origin: "manual" });

    // Restoring v1 is version 4 with v1's text and name.
    const restored = await api("POST", `${skillPath(brand.id, skill.id)}/versions/1/restore`);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(BrandSkill.parse(restored.body)).toMatchObject({
      name: "mtm",
      body: MTM,
      version: 4,
      origin: "restore",
      enabled: true,
    });

    const list = BrandSkillList.parse((await api("GET", skillsPath(brand.id))).body);
    expect(list.items.map((s) => s.id)).toEqual([skill.id]);

    expect((await api("DELETE", skillPath(brand.id, skill.id))).status).toBe(204);
    expectError(await api("GET", skillPath(brand.id, skill.id)), 404, "not_found");
    expectError(await api("GET", `${skillPath(brand.id, skill.id)}/versions`), 404, "not_found");
  });

  it("keeps names unique per brand and refuses bad input", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const first = await createSkill(brand.id);
    expectError(
      await api("POST", skillsPath(brand.id), { name: "mtm", body: "x" }),
      409,
      "conflict",
    );
    // Another brand may use the same name.
    await createSkill(other.id);
    const second = await createSkill(brand.id, { name: "partner", body: "Partner postları" });
    expectError(
      await api("PATCH", skillPath(brand.id, second.id), { name: "mtm" }),
      409,
      "conflict",
    );
    expectError(
      await api("POST", skillsPath(brand.id), { name: "Büyük Harf", body: "x" }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", skillsPath(brand.id), { name: "uzun", body: "x".repeat(40_001) }),
      400,
      "validation_error",
    );
    expectError(await api("PATCH", skillPath(brand.id, first.id), {}), 400, "validation_error");
    // A skill of another brand is not found under this one.
    expectError(await api("GET", skillPath(other.id, first.id)), 404, "not_found");
    expectError(
      await api("POST", `${skillPath(brand.id, first.id)}/versions/9/restore`),
      404,
      "not_found",
    );
  });

  it(`allows at most ${MAX_BRAND_SKILLS} skills per brand`, async () => {
    const brand = await createBrand();
    for (let i = 0; i < MAX_BRAND_SKILLS; i++) {
      await createSkill(brand.id, { name: `s-${i}`, body: "x" });
    }
    expectError(
      await api("POST", skillsPath(brand.id), { name: "one-more", body: "x" }),
      400,
      "validation_error",
    );
  });

  it("stores AI drafts disabled, with their origin and job", async () => {
    const brand = await createBrand();
    const draft = await createSkill(brand.id, {
      name: "taslak",
      enabled: false,
      origin: "ai_draft",
      jobId: "job-1",
      note: "AI taslağı",
    });
    expect(draft).toMatchObject({ enabled: false, origin: "ai_draft" });
    const [v1] = BrandSkillVersionList.parse(
      (await api("GET", `${skillPath(brand.id, draft.id)}/versions`)).body,
    ).items;
    expect(v1).toMatchObject({ origin: "ai_draft", jobId: "job-1", note: "AI taslağı" });
  });
});
