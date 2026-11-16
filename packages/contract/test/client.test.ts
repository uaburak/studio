import { describe, expect, it } from "vitest";
import { ApiError, createApiClient, type HealthResponse } from "../src/index.ts";

const healthy: HealthResponse = {
  status: "ok",
  service: "studio-api",
  version: "0.0.0",
  time: "2026-11-16T10:00:00.000Z",
  checks: { db: "ok" },
};

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("api client", () => {
  it("returns a validated health response", async () => {
    const client = createApiClient({ fetch: fakeFetch(healthy) });
    await expect(client.health()).resolves.toEqual(healthy);
  });

  it("rejects a response that breaks the contract", async () => {
    const client = createApiClient({ fetch: fakeFetch({ status: "ok" }) });
    await expect(client.health()).rejects.toBeInstanceOf(ApiError);
  });

  it("surfaces HTTP errors", async () => {
    const client = createApiClient({ fetch: fakeFetch({}, 503) });
    await expect(client.health()).rejects.toMatchObject({ status: 503 });
  });
});

describe("api client: core resources", () => {
  const brand = {
    id: "b1",
    name: "Venta",
    slug: "venta",
    defaultLanguage: "tr",
    status: "active",
    createdAt: "2026-11-16T10:00:00.000Z",
    updatedAt: "2026-11-16T10:00:00.000Z",
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

  it("sends JSON bodies and validates the response", async () => {
    const { calls, fetchImpl } = recordingFetch(brand, 201);
    const client = createApiClient({ baseUrl: "http://api.test/", fetch: fetchImpl });
    await expect(client.brands.create({ name: "Venta" })).resolves.toEqual(brand);
    expect(calls[0]?.url).toBe("http://api.test/api/brands");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ name: "Venta" });
  });

  it("builds query strings, skipping undefined values", async () => {
    const { calls, fetchImpl } = recordingFetch({ items: [brand], nextCursor: null });
    const client = createApiClient({ fetch: fetchImpl });
    const page = await client.brands.list({ limit: 5, status: undefined, cursor: "c1" });
    expect(page.items).toHaveLength(1);
    expect(calls[0]?.url).toBe("/api/brands?limit=5&cursor=c1");
  });

  it("surfaces the contract error code and issues", async () => {
    const { fetchImpl } = recordingFetch(
      { error: { code: "hash_mismatch", message: "stale", issues: [] } },
      409,
    );
    const client = createApiClient({ fetch: fetchImpl });
    const err = await client.contents.approve("c1", "a".repeat(64)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, code: "hash_mismatch" });
  });

  it("handles 204 deletes and multipart uploads", async () => {
    const del = recordingFetch(null, 204);
    await expect(
      createApiClient({ fetch: del.fetchImpl }).contents.delete("c1"),
    ).resolves.toBeUndefined();
    expect(del.calls[0]?.init?.method).toBe("DELETE");

    const asset = {
      id: "a1",
      brandId: "b1",
      kind: "image",
      source: "upload",
      objectKey: "brands/b1/assets/a1.png",
      mimeType: "image/png",
      bytes: 3,
      sha256: "0".repeat(64),
      width: null,
      height: null,
      durationMs: null,
      originalFilename: "x.png",
      createdAt: "2026-11-16T10:00:00.000Z",
    };
    const up = recordingFetch(asset, 201);
    const client = createApiClient({ fetch: up.fetchImpl });
    await client.assets.upload({
      brandId: "b1",
      width: 10,
      file: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      filename: "x.png",
    });
    const form = up.calls[0]?.init?.body as FormData;
    expect(form.get("brandId")).toBe("b1");
    expect(form.get("width")).toBe("10");
    expect((form.get("file") as File).name).toBe("x.png");
    expect(client.assets.contentUrl("a 1")).toBe("/api/assets/a%201/content");
  });
});
