import { exports } from "cloudflare:workers";
import { Asset, AssetList } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { parseRange } from "../src/routes/assets.ts";
import { api, BASE, createBrand, expectError } from "./helpers.ts";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
]);

async function upload(
  fields: Record<string, string>,
  file?: { bytes: string | Uint8Array<ArrayBuffer>; type: string; name: string },
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  if (file) form.set("file", new File([file.bytes], file.name, { type: file.type }));
  const res = await exports.default.fetch(`${BASE}/api/assets`, { method: "POST", body: form });
  return { status: res.status, body: (await res.json()) as unknown, headers: res.headers };
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

describe("assets", () => {
  it("stores an upload in R2, records metadata and streams it back", async () => {
    const brand = await createBrand();
    const res = await upload(
      { brandId: brand.id, width: "1", height: "1" },
      { bytes: PNG, type: "image/png", name: "logo-ç.png" },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const asset = Asset.parse(res.body);
    expect(asset).toMatchObject({
      brandId: brand.id,
      kind: "image",
      source: "upload",
      mimeType: "image/png",
      bytes: PNG.byteLength,
      width: 1,
      height: 1,
      originalFilename: "logo-ç.png",
    });
    expect(asset.sha256).toBe(await sha256(PNG));
    expect(asset.objectKey).toBe(`brands/${brand.id}/assets/${asset.id}.png`);

    const got = Asset.parse((await api("GET", `/api/assets/${asset.id}`)).body);
    expect(got).toEqual(asset);

    const content = await exports.default.fetch(`${BASE}/api/assets/${asset.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get("content-type")).toBe("image/png");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await content.arrayBuffer())).toEqual(PNG);

    const partial = await exports.default.fetch(`${BASE}/api/assets/${asset.id}/content`, {
      headers: { range: "bytes=0-3" },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe(`bytes 0-3/${PNG.byteLength}`);
    expect(new Uint8Array(await partial.arrayBuffer())).toEqual(PNG.subarray(0, 4));

    const tail = await exports.default.fetch(`${BASE}/api/assets/${asset.id}/content`, {
      headers: { range: "bytes=-2" },
    });
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(PNG.subarray(-2));
    const beyond = await exports.default.fetch(`${BASE}/api/assets/${asset.id}/content`, {
      headers: { range: "bytes=999-" },
    });
    expect(beyond.status).toBe(416);
    const cached = await exports.default.fetch(`${BASE}/api/assets/${asset.id}/content`, {
      headers: { "if-none-match": content.headers.get("etag") ?? "" },
    });
    expect(cached.status).toBe(304);

    const list = AssetList.parse((await api("GET", `/api/assets?brandId=${brand.id}`)).body);
    expect(list.items.map((a) => a.id)).toEqual([asset.id]);
  });

  it("accepts an explicit compatible kind and source", async () => {
    const brand = await createBrand();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
    const res = await upload(
      { brandId: brand.id, source: "ingested" },
      { bytes: svg, type: "image/svg+xml", name: "logo.svg" },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(Asset.parse(res.body)).toMatchObject({ kind: "logo", source: "ingested" });
  });

  it("rejects disallowed types (415), spoofed content (415) and oversize files (413)", async () => {
    const brand = await createBrand();
    expectError(
      await upload(
        { brandId: brand.id },
        { bytes: "#!/bin/sh", type: "application/x-sh", name: "a.sh" },
      ),
      415,
      "unsupported_media_type",
    );
    expectError(
      await upload({ brandId: brand.id }, { bytes: "not a png", type: "image/png", name: "a.png" }),
      415,
      "unsupported_media_type",
    );
    // Fonts are capped at 5 MiB.
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    expectError(
      await upload({ brandId: brand.id }, { bytes: big, type: "font/woff2", name: "big.woff2" }),
      413,
      "payload_too_large",
    );
  });

  it("rejects missing file, bad fields, incompatible kind and unknown brand", async () => {
    const brand = await createBrand();
    const png = { bytes: PNG, type: "image/png", name: "a.png" };
    expectError(await upload({ brandId: brand.id }), 400, "validation_error");
    expectError(await upload({ brandId: brand.id, width: "-3" }, png), 400, "validation_error");
    expectError(await upload({ brandId: brand.id, kind: "font" }, png), 400, "validation_error");
    expectError(await upload({ brandId: "missing" }, png), 404, "not_found");
    expectError(await api("GET", "/api/assets/missing"), 404, "not_found");
    expectError(await api("GET", "/api/assets/missing/content"), 404, "not_found");
  });
});

describe("parseRange", () => {
  it("handles single ranges and rejects unsatisfiable ones", () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange("bytes=0-3", 10)).toEqual({ offset: 0, length: 4 });
    expect(parseRange("bytes=5-", 10)).toEqual({ offset: 5, length: 5 });
    expect(parseRange("bytes=-3", 10)).toEqual({ offset: 7, length: 3 });
    expect(parseRange("bytes=8-100", 10)).toEqual({ offset: 8, length: 2 });
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-2", 10)).toBe("unsatisfiable");
  });
});
