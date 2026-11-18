import { describe, expect, it } from "vitest";
import {
  BrandProduct,
  BrandProductCreate,
  BrandProductUpdate,
  createApiClient,
  MAX_PRODUCT_IMAGES,
  MAX_PRODUCT_TAGS,
} from "../src/index.ts";

const product = {
  id: "p1",
  brandId: "b1",
  name: "Organik Gübre",
  description: "Toz form",
  category: "Gübre",
  tags: ["organik"],
  notes: "",
  imageAssetIds: ["a1", "a2"],
  createdAt: "2026-11-18T10:00:00.000Z",
  updatedAt: "2026-11-18T10:00:00.000Z",
};

function recordingFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("brand products", () => {
  it("fills defaults and trims text", () => {
    expect(BrandProductCreate.parse({ name: "  Tohum " })).toEqual({
      name: "Tohum",
      description: "",
      category: "",
      tags: [],
      notes: "",
      imageAssetIds: [],
    });
    expect(BrandProduct.parse(product)).toEqual(product);
  });

  it("rejects empty names, duplicate tags (any case), duplicate or too many photos", () => {
    expect(BrandProductCreate.safeParse({ name: " " }).success).toBe(false);
    expect(BrandProductCreate.safeParse({ name: "X", tags: ["Organik", "organik"] }).success).toBe(
      false,
    );
    expect(BrandProductCreate.safeParse({ name: "X", tags: ["İlaç", "ilaç"] }).success).toBe(false);
    expect(
      BrandProductCreate.safeParse({
        name: "X",
        tags: Array.from({ length: MAX_PRODUCT_TAGS + 1 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
    expect(BrandProductCreate.safeParse({ name: "X", imageAssetIds: ["a", "a"] }).success).toBe(
      false,
    );
    expect(
      BrandProductCreate.safeParse({
        name: "X",
        imageAssetIds: Array.from({ length: MAX_PRODUCT_IMAGES + 1 }, (_, i) => `a${i}`),
      }).success,
    ).toBe(false);
  });

  it("needs at least one field to update", () => {
    expect(BrandProductUpdate.safeParse({}).success).toBe(false);
    expect(BrandProductUpdate.safeParse({ notes: "" }).success).toBe(true);
    expect(BrandProductUpdate.safeParse({ name: "" }).success).toBe(false);
  });

  it("calls the product routes", async () => {
    const list = recordingFetch({ items: [product], nextCursor: null });
    const page = await createApiClient({ fetch: list.fetchImpl }).brandProducts.list("b1", {
      limit: 50,
    });
    expect(page.items).toEqual([product]);
    expect(list.calls[0]?.url).toBe("/api/brands/b1/products?limit=50");

    const create = recordingFetch(product, 201);
    await createApiClient({ fetch: create.fetchImpl }).brandProducts.create("b1", {
      name: "Organik Gübre",
    });
    expect(create.calls[0]?.url).toBe("/api/brands/b1/products");
    expect(create.calls[0]?.init?.method).toBe("POST");

    const update = recordingFetch(product);
    await createApiClient({ fetch: update.fetchImpl }).brandProducts.update("b1", "p1", {
      tags: ["organik"],
    });
    expect(update.calls[0]?.url).toBe("/api/brands/b1/products/p1");
    expect(update.calls[0]?.init?.method).toBe("PATCH");

    const get = recordingFetch(product);
    await createApiClient({ fetch: get.fetchImpl }).brandProducts.get("b1", "p1");
    expect(get.calls[0]?.url).toBe("/api/brands/b1/products/p1");

    const del = recordingFetch(null, 204);
    await expect(
      createApiClient({ fetch: del.fetchImpl }).brandProducts.delete("b1", "p1"),
    ).resolves.toBeUndefined();
    expect(del.calls[0]?.url).toBe("/api/brands/b1/products/p1");
    expect(del.calls[0]?.init?.method).toBe("DELETE");
  });
});
