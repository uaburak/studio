import { Brand, BrandList, SocialAccount, SocialAccountList } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { api, createAccount, createBrand, expectError, localFetch, uniq } from "./helpers.ts";

describe("brands", () => {
  it("creates, reads, updates and archives a brand", async () => {
    const slug = uniq("mtm");
    const created = await api("POST", "/api/brands", { name: "MTM Agro", slug });
    expect(created.status).toBe(201);
    const brand = Brand.parse(created.body);
    expect(brand).toMatchObject({
      name: "MTM Agro",
      slug,
      defaultLanguage: "tr",
      status: "active",
    });

    const got = await api("GET", `/api/brands/${brand.id}`);
    expect(Brand.parse(got.body)).toEqual(brand);

    const patched = await api("PATCH", `/api/brands/${brand.id}`, {
      defaultLanguage: "en",
      status: "archived",
    });
    expect(patched.status).toBe(200);
    expect(Brand.parse(patched.body)).toMatchObject({ defaultLanguage: "en", status: "archived" });
  });

  it("derives a Turkish-folded slug from the name", async () => {
    const name = `Çiğdem Şükrü ${uniq()}`;
    const res = await api("POST", "/api/brands", { name });
    expect(res.status).toBe(201);
    expect(Brand.parse(res.body).slug).toMatch(/^cigdem-sukru-/);
  });

  it("rejects invalid input with the validation error shape", async () => {
    const err = expectError(
      await api("POST", "/api/brands", { name: "", slug: "Bad Slug", defaultLanguage: "turkish" }),
      400,
      "validation_error",
    );
    const paths = err.issues?.map((i) => i.path) ?? [];
    expect(paths).toEqual(expect.arrayContaining(["name", "slug", "defaultLanguage"]));
  });

  it("rejects malformed JSON and empty updates with 400", async () => {
    const res = await fetchRaw("/api/brands", "{not json");
    expect(res.status).toBe(400);
    const brand = await createBrand();
    expectError(await api("PATCH", `/api/brands/${brand.id}`, {}), 400, "validation_error");
  });

  it("returns 409 for a duplicate slug, on create and on rename", async () => {
    const a = await createBrand();
    const b = await createBrand();
    expectError(await api("POST", "/api/brands", { name: "x", slug: a.slug }), 409, "conflict");
    expectError(await api("PATCH", `/api/brands/${b.id}`, { slug: a.slug }), 409, "conflict");
  });

  it("returns 404 for unknown brands and routes", async () => {
    expectError(await api("GET", "/api/brands/nope"), 404, "not_found");
    expectError(await api("PATCH", "/api/brands/nope", { name: "x" }), 404, "not_found");
    expectError(await api("GET", "/api/definitely-not-a-route"), 404, "not_found");
  });

  it("paginates with an opaque cursor, newest first, without gaps or repeats", async () => {
    const made = [await createBrand(), await createBrand(), await createBrand()];
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const page = BrandList.parse((await api("GET", `/api/brands?limit=2${query}`)).body);
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...page.items.map((b) => b.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    const positions = made.map((b) => seen.indexOf(b.id));
    expect(positions.every((p) => p >= 0)).toBe(true);
    // Newest first: later brands appear earlier.
    expect(positions).toEqual([...positions].sort((a, b) => b - a));
    expectError(await api("GET", "/api/brands?limit=1000"), 400, "validation_error");
  });
});

describe("social accounts", () => {
  it("registers an account without any credentials and updates it", async () => {
    const brand = await createBrand();
    const account = await createAccount(brand.id, { externalId: uniq("ig") });
    expect(SocialAccount.parse(account)).toMatchObject({
      brandId: brand.id,
      platform: "instagram",
      status: "pending",
    });
    expect(Object.keys(account).some((k) => /token|secret/i.test(k))).toBe(false);

    const patched = await api("PATCH", `/api/social-accounts/${account.id}`, {
      status: "connected",
      handle: "@mtmagro",
    });
    expect(SocialAccount.parse(patched.body)).toMatchObject({
      status: "connected",
      handle: "@mtmagro",
    });

    const list = SocialAccountList.parse(
      (await api("GET", `/api/social-accounts?brandId=${brand.id}`)).body,
    );
    expect(list.items.map((a) => a.id)).toEqual([account.id]);
  });

  it("validates platform, brand and external id uniqueness", async () => {
    const brand = await createBrand();
    expectError(
      await api("POST", "/api/social-accounts", {
        brandId: brand.id,
        platform: "tiktok",
        handle: "x",
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", "/api/social-accounts", {
        brandId: "nope",
        platform: "facebook",
        handle: "x",
      }),
      404,
      "not_found",
    );
    const externalId = uniq("page");
    await createAccount(brand.id, { platform: "facebook", externalId });
    expectError(
      await api("POST", "/api/social-accounts", {
        brandId: brand.id,
        platform: "facebook",
        handle: "dupe",
        externalId,
      }),
      409,
      "conflict",
    );
    expectError(await api("GET", "/api/social-accounts/nope"), 404, "not_found");
  });
});

async function fetchRaw(path: string, body: string) {
  return localFetch(`http://studio.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}
