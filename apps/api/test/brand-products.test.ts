import { Asset, BrandProduct, BrandProductList } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { api, BASE, createBrand, expectError, localFetch } from "./helpers.ts";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function upload(
  brandId: string,
  kind: string,
  file: { bytes: Uint8Array<ArrayBuffer> | string; type: string; name: string } = {
    bytes: PNG,
    type: "image/png",
    name: "photo.png",
  },
) {
  const form = new FormData();
  form.set("brandId", brandId);
  form.set("kind", kind);
  form.set("file", new File([file.bytes], file.name, { type: file.type }));
  const res = await localFetch(`${BASE}/api/assets`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return Asset.parse(await res.json());
}

const productsPath = (brandId: string) => `/api/brands/${brandId}/products`;
const productPath = (brandId: string, productId: string) =>
  `/api/brands/${brandId}/products/${productId}`;

describe("brand products", () => {
  it("creates, reads, edits and deletes a product", async () => {
    const brand = await createBrand();
    const [front, back] = await Promise.all([upload(brand.id, "image"), upload(brand.id, "image")]);

    const created = await api("POST", productsPath(brand.id), {
      name: "  Organik Gübre 25 kg ",
      description: "Toz form, tüm bitkiler için.",
      category: "Gübre",
      tags: ["organik", "toz"],
      notes: "Etiketteki yazı değişmesin.",
      imageAssetIds: [front.id, back.id],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const product = BrandProduct.parse(created.body);
    expect(product).toMatchObject({
      brandId: brand.id,
      name: "Organik Gübre 25 kg",
      category: "Gübre",
      tags: ["organik", "toz"],
      imageAssetIds: [front.id, back.id],
    });

    // Defaults for an add with just a name.
    const bare = BrandProduct.parse(
      (await api("POST", productsPath(brand.id), { name: "Tohum" })).body,
    );
    expect(bare).toMatchObject({
      description: "",
      category: "",
      tags: [],
      notes: "",
      imageAssetIds: [],
    });

    const got = await api("GET", productPath(brand.id, product.id));
    expect(BrandProduct.parse(got.body)).toEqual(product);

    const patched = await api("PATCH", productPath(brand.id, product.id), {
      name: "Organik Gübre 50 kg",
      tags: ["organik"],
      imageAssetIds: [back.id],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const updated = BrandProduct.parse(patched.body);
    expect(updated).toMatchObject({
      name: "Organik Gübre 50 kg",
      description: "Toz form, tüm bitkiler için.",
      tags: ["organik"],
      imageAssetIds: [back.id],
    });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(product.updatedAt));

    const removed = await api("DELETE", productPath(brand.id, product.id));
    expect(removed.status).toBe(204);
    expectError(await api("GET", productPath(brand.id, product.id)), 404, "not_found");
    expectError(await api("DELETE", productPath(brand.id, product.id)), 404, "not_found");

    const list = BrandProductList.parse((await api("GET", productsPath(brand.id))).body);
    expect(list.items.map((p) => p.id)).toEqual([bare.id]);
  });

  it("lists oldest first, per brand, in pages", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const ids: string[] = [];
    for (const name of ["A", "B", "C"]) {
      const res = await api("POST", productsPath(brand.id), { name });
      ids.push(BrandProduct.parse(res.body).id);
    }
    await api("POST", productsPath(other.id), { name: "Başka" });

    const first = BrandProductList.parse(
      (await api("GET", `${productsPath(brand.id)}?limit=2`)).body,
    );
    expect(first.items.map((p) => p.name)).toEqual(["A", "B"]);
    expect(first.nextCursor).not.toBeNull();
    const second = BrandProductList.parse(
      (
        await api(
          "GET",
          `${productsPath(brand.id)}?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
        )
      ).body,
    );
    expect(second.items.map((p) => p.name)).toEqual(["C"]);
    expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map((p) => p.id)).toEqual(ids);
  });

  it("only takes image assets of the same brand as photos", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const foreign = await upload(other.id, "image");
    const logo = await upload(brand.id, "logo");
    const image = await upload(brand.id, "image");

    const wrongBrand = expectError(
      await api("POST", productsPath(brand.id), {
        name: "X",
        imageAssetIds: [image.id, foreign.id],
      }),
      400,
      "validation_error",
    );
    expect(wrongBrand.issues).toEqual([
      { path: "imageAssetIds.1", message: "not an asset of this brand" },
    ]);

    const wrongKind = expectError(
      await api("POST", productsPath(brand.id), { name: "X", imageAssetIds: [logo.id] }),
      400,
      "validation_error",
    );
    expect(wrongKind.issues?.[0]).toMatchObject({ path: "imageAssetIds.0" });
    expect(wrongKind.issues?.[0]?.message).toContain("logo");

    const product = BrandProduct.parse(
      (await api("POST", productsPath(brand.id), { name: "X", imageAssetIds: [image.id] })).body,
    );
    expectError(
      await api("PATCH", productPath(brand.id, product.id), { imageAssetIds: [foreign.id] }),
      400,
      "validation_error",
    );
    // Nothing was stored by the refused calls.
    const list = BrandProductList.parse((await api("GET", productsPath(brand.id))).body);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.imageAssetIds).toEqual([image.id]);
  });

  it("validates input and refuses unknown brands and other brands' products", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    expectError(await api("POST", productsPath(brand.id), { name: "  " }), 400, "validation_error");
    expectError(
      await api("POST", productsPath(brand.id), { name: "X", tags: ["Organik", "organik"] }),
      400,
      "validation_error",
    );
    const product = BrandProduct.parse(
      (await api("POST", productsPath(brand.id), { name: "X" })).body,
    );
    expectError(await api("PATCH", productPath(brand.id, product.id), {}), 400, "validation_error");

    expectError(await api("GET", productsPath("missing-brand")), 404, "not_found");
    expectError(await api("POST", productsPath("missing-brand"), { name: "X" }), 404, "not_found");
    expectError(await api("GET", productPath(other.id, product.id)), 404, "not_found");
    expectError(
      await api("PATCH", productPath(other.id, product.id), { name: "Y" }),
      404,
      "not_found",
    );
    expectError(await api("DELETE", productPath(other.id, product.id)), 404, "not_found");
    expectError(await api("GET", productPath(brand.id, "missing-product")), 404, "not_found");
  });
});
