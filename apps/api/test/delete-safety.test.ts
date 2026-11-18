import { env } from "cloudflare:workers";
import {
  AssetList,
  AssetUsageList,
  Content,
  ContentList,
  Job,
  PurgeResult,
  TRASH_RETENTION_DAYS,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  addVersion,
  api,
  approvedContent,
  BASE,
  createBrand,
  createContent,
  expectError,
  localFetch,
  slide,
} from "./helpers.ts";
import { solidPng, stored, uploadFile } from "./lifecycle-helpers.ts";

const DAY = 86_400_000;
const PDF = new Uint8Array(new TextEncoder().encode("%PDF-1.4\n%test\n"));

/** Move a trashed row's `deleted_at` back past the retention. */
async function age(table: "contents" | "assets", id: string) {
  const past = Date.now() - (TRASH_RETENTION_DAYS + 1) * DAY;
  await env.DB.prepare(`update ${table} set deleted_at = ? where id = ?`).bind(past, id).run();
}

describe("posts in the trash", () => {
  it("soft-deletes, lists the trash, refuses changes and restores", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    const version = await addVersion(content.id);

    expect((await api("DELETE", `/api/contents/${content.id}`)).status).toBe(204);
    // Again: a no-op.
    expect((await api("DELETE", `/api/contents/${content.id}`)).status).toBe(204);

    const trashed = Content.parse((await api("GET", `/api/contents/${content.id}`)).body);
    expect(trashed.deletedAt).not.toBeNull();
    const live = ContentList.parse((await api("GET", `/api/contents?brandId=${brand.id}`)).body);
    expect(live.items).toEqual([]);
    const trash = ContentList.parse(
      (await api("GET", `/api/contents?brandId=${brand.id}&deleted=only`)).body,
    );
    expect(trash.items.map((c) => c.id)).toEqual([content.id]);
    const both = ContentList.parse(
      (await api("GET", `/api/contents?brandId=${brand.id}&deleted=include`)).body,
    );
    expect(both.items).toHaveLength(1);

    // Every change waits for a restore.
    const refusals = [
      await api("PATCH", `/api/contents/${content.id}`, { title: "x" }),
      await api("POST", `/api/contents/${content.id}/approve`, {
        hash: version.contentHash,
        acknowledgeChecks: true,
      }),
      await api("POST", `/api/contents/${content.id}/transition`, { to: "in_review" }),
      await api("POST", `/api/contents/${content.id}/versions`, {
        origin: "manual_edit",
        slides: [slide("<html><body>v2</body></html>")],
      }),
      await api("POST", `/api/contents/${content.id}/versions/1/restore`, {}),
      await api("POST", `/api/contents/${content.id}/duplicate`, {}),
      await api("POST", "/api/jobs", {
        type: "content.render",
        contentId: content.id,
        payload: {},
      }),
    ];
    for (const res of refusals) {
      const error = expectError(res, 409, "conflict");
      expect(error.message).toBe("Post silinmiş; önce geri al.");
    }

    const restored = await api("POST", `/api/contents/${content.id}/restore`);
    expect(restored.status).toBe(200);
    expect(Content.parse(restored.body).deletedAt).toBeNull();
    expect(
      ContentList.parse((await api("GET", `/api/contents?brandId=${brand.id}`)).body).items,
    ).toHaveLength(1);
    expect((await api("PATCH", `/api/contents/${content.id}`, { title: "x" })).status).toBe(200);
  });

  it("stops the post's queued work and keeps the old blockers", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    await addVersion(content.id);
    const job = Job.parse(
      (
        await api("POST", "/api/jobs", {
          type: "content.render",
          contentId: content.id,
          payload: {},
        })
      ).body,
    );
    expect((await api("DELETE", `/api/contents/${content.id}`)).status).toBe(204);
    expect(Job.parse((await api("GET", `/api/jobs/${job.id}`)).body).status).toBe("cancelled");

    const { content: approved } = await approvedContent(brand.id);
    // Approved posts may go to the trash; published / scheduled ones may not (unchanged).
    expect((await api("DELETE", `/api/contents/${approved.id}`)).status).toBe(204);
    await env.DB.prepare("update contents set status = 'published', deleted_at = null where id = ?")
      .bind(approved.id)
      .run();
    expectError(await api("DELETE", `/api/contents/${approved.id}`), 409, "invalid_transition");
  });

  it("removes a trashed post for good only from the trash", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    expectError(await api("DELETE", `/api/contents/${content.id}?permanent=true`), 409, "conflict");
    expect((await api("DELETE", `/api/contents/${content.id}`)).status).toBe(204);
    expect((await api("DELETE", `/api/contents/${content.id}?permanent=true`)).status).toBe(204);
    expectError(await api("GET", `/api/contents/${content.id}`), 404, "not_found");
  });
});

describe("media delete", () => {
  it("lists where a file is used and refuses to delete it while a post needs it", async () => {
    const brand = await createBrand();
    const png = await solidPng(8, 8);
    const render = await uploadFile(brand.id, png, "image/png", "render.png", "generated");
    const photo = await uploadFile(brand.id, png, "image/png", "tarla.png");
    const content = await createContent(brand.id, { title: "Kış bakımı" });
    await addVersion(content.id, {
      slides: [slide(`<html><body><img src="/media/${photo.id}.png"></body></html>`)],
      renderedAssetIds: [render.id],
    });

    const usage = AssetUsageList.parse((await api("GET", `/api/assets/${render.id}/usage`)).body);
    expect(usage.deletable).toBe(false);
    expect(usage.usages).toEqual([
      expect.objectContaining({
        kind: "version",
        blocking: true,
        contentId: content.id,
        version: 1,
        label: "“Kış bakımı” v1, 1. kare",
      }),
    ]);
    const pictured = AssetUsageList.parse((await api("GET", `/api/assets/${photo.id}/usage`)).body);
    expect(pictured.usages.map((u) => [u.kind, u.blocking])).toEqual([["slide", true]]);

    const refused = expectError(await api("DELETE", `/api/assets/${photo.id}`), 409, "conflict");
    expect(refused.issues?.[0]).toMatchObject({ path: "usage.slide" });

    // Once the post is in the trash the use no longer blocks (it is only listed).
    expect((await api("DELETE", `/api/contents/${content.id}`)).status).toBe(204);
    const later = AssetUsageList.parse((await api("GET", `/api/assets/${photo.id}/usage`)).body);
    expect(later.deletable).toBe(true);
    expect(later.usages[0]?.label).toContain("silinmiş post");

    expect((await api("DELETE", `/api/assets/${photo.id}`)).status).toBe(204);
    const list = AssetList.parse((await api("GET", `/api/assets?brandId=${brand.id}`)).body);
    expect(list.items.map((a) => a.id)).toEqual([render.id]);
    const trash = AssetList.parse(
      (await api("GET", `/api/assets?brandId=${brand.id}&deleted=only`)).body,
    );
    expect(trash.items.map((a) => a.id)).toEqual([photo.id]);
    // Still served while in the trash.
    expect((await localFetch(`${BASE}/api/assets/${photo.id}/content`)).status).toBe(200);

    const restored = await api("POST", `/api/assets/${photo.id}/restore`);
    expect(restored.status).toBe(200);
    expect(
      AssetList.parse((await api("GET", `/api/assets?brandId=${brand.id}`)).body).items,
    ).toHaveLength(2);
  });

  it("names products and the brand kit as blocking uses", async () => {
    const brand = await createBrand();
    const photo = await uploadFile(brand.id, await solidPng(4, 4));
    const product = await api("POST", `/api/brands/${brand.id}/products`, {
      name: "Gübre",
      imageAssetIds: [photo.id],
    });
    expect(product.status, JSON.stringify(product.body)).toBe(201);
    const usage = AssetUsageList.parse((await api("GET", `/api/assets/${photo.id}/usage`)).body);
    expect(usage.usages.map((u) => [u.kind, u.label])).toEqual([
      ["product", "“Gübre” ürün fotoğrafı"],
    ]);
    expectError(await api("DELETE", `/api/assets/${photo.id}`), 409, "conflict");
  });
});

describe("thumbnails", () => {
  it("resizes a picture to WebP once and serves the stored copy after", async () => {
    const brand = await createBrand();
    const photo = await uploadFile(brand.id, await solidPng(600, 400));
    const first = await localFetch(`${BASE}/api/assets/${photo.id}/thumbnail?w=200`);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-studio-thumbnail")).toBeNull();
    expect(first.headers.get("content-type")).toBe("image/webp");
    expect(first.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await first.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe("WEBP");
    // Rounded up to 240 px.
    const info = await env.IMAGES.info(new Blob([bytes]).stream());
    expect(info).toMatchObject({ format: "image/webp", width: 240, height: 160 });
    expect(await stored(`thumbs/${photo.id}/w240.webp`)).toBe(true);

    const second = await localFetch(`${BASE}/api/assets/${photo.id}/thumbnail?w=240`);
    expect(second.status).toBe(200);
    const etag = second.headers.get("etag");
    expect(etag).toBe(first.headers.get("etag"));
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(bytes);
    const again = await localFetch(`${BASE}/api/assets/${photo.id}/thumbnail?w=240`, {
      headers: { "if-none-match": etag ?? "" },
    });
    expect(again.status).toBe(304);
  });

  it("never enlarges, and refuses files that are not pictures", async () => {
    const brand = await createBrand();
    const small = await uploadFile(brand.id, await solidPng(40, 30));
    const res = await localFetch(`${BASE}/api/assets/${small.id}/thumbnail?w=640`);
    expect(res.status).toBe(200);
    const info = await env.IMAGES.info(new Blob([await res.arrayBuffer()]).stream());
    expect(info).toMatchObject({ width: 40, height: 30 });

    const pdf = await uploadFile(brand.id, PDF, "application/pdf", "brosur.pdf");
    expectError(
      await api("GET", `/api/assets/${pdf.id}/thumbnail?w=200`),
      415,
      "unsupported_media_type",
    );
  });

  it("serves the original when the picture cannot be resized", async () => {
    const brand = await createBrand();
    // A PNG signature with nothing after it: stored (magic bytes match), not decodable.
    const broken = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const asset = await uploadFile(brand.id, broken);
    const res = await localFetch(`${BASE}/api/assets/${asset.id}/thumbnail?w=200`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-studio-thumbnail")).toBe("original");
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(broken);
  });
});

describe("purge", () => {
  it("removes old trashed posts with the generated files only they used", async () => {
    const brand = await createBrand();
    const png = await solidPng(16, 16);
    const render = await uploadFile(brand.id, png, "image/png", "r1.png", "generated");
    const shared = await uploadFile(brand.id, png, "image/png", "r2.png", "generated");
    const photo = await uploadFile(brand.id, png, "image/png", "foto.png");
    const post = await createContent(brand.id, { type: "carousel" });
    await addVersion(post.id, {
      slides: [
        slide(`<html><body><img src="/media/${photo.id}.png"></body></html>`),
        slide("<html><body>b</body></html>"),
      ],
      renderedAssetIds: [render.id, shared.id],
    });
    // Another post shows the second render too (a duplicate shares renders).
    const other = await createContent(brand.id);
    await addVersion(other.id, { renderedAssetIds: [shared.id] });
    // A cached thumbnail goes with its picture.
    expect((await localFetch(`${BASE}/api/assets/${render.id}/thumbnail?w=160`)).status).toBe(200);

    expect((await api("DELETE", `/api/contents/${post.id}`)).status).toBe(204);
    // Not old enough yet: nothing happens.
    expect(PurgeResult.parse((await api("POST", "/api/maintenance/purge")).body).contents).toBe(0);

    await age("contents", post.id);
    const result = PurgeResult.parse((await api("POST", "/api/maintenance/purge")).body);
    expect(result.contents).toBe(1);
    expect(result.assets).toBe(1);
    expectError(await api("GET", `/api/contents/${post.id}`), 404, "not_found");
    expectError(await api("GET", `/api/assets/${render.id}`), 404, "not_found");
    expect(await stored(render.objectKey)).toBe(false);
    expect(await stored(`thumbs/${render.id}/w160.webp`)).toBe(false);
    // Still used elsewhere / an upload of the library: kept.
    expect((await api("GET", `/api/assets/${shared.id}`)).status).toBe(200);
    expect((await api("GET", `/api/assets/${photo.id}`)).status).toBe(200);
    expect(await stored(photo.objectKey)).toBe(true);
  });

  it("removes an old trashed file with its chat aliases, unless it is used again", async () => {
    const brand = await createBrand();
    const png = await solidPng(8, 8);
    const photo = await uploadFile(brand.id, png);
    const conv = await api<{ id: string }>("POST", "/api/conversations", { brandId: brand.id });
    const now = Date.now();
    await env.DB.prepare(
      "insert into conversation_aliases (id, conversation_id, asset_id, alias, created_at, updated_at) values (?, ?, ?, 'tarla', ?, ?)",
    )
      .bind(crypto.randomUUID(), conv.body.id, photo.id, now, now)
      .run();
    const usage = AssetUsageList.parse((await api("GET", `/api/assets/${photo.id}/usage`)).body);
    expect(usage).toMatchObject({ deletable: true });
    expect(usage.usages.map((u) => [u.kind, u.blocking])).toEqual([["conversation", false]]);

    expect((await api("DELETE", `/api/assets/${photo.id}`)).status).toBe(204);
    await age("assets", photo.id);

    // Used again meanwhile (a product photo): it waits.
    const kept = await uploadFile(brand.id, png, "image/png", "kept.png");
    await api("POST", `/api/brands/${brand.id}/products`, {
      name: "Tohum",
      imageAssetIds: [kept.id],
    });
    await env.DB.prepare("update assets set deleted_at = ? where id = ?")
      .bind(now - (TRASH_RETENTION_DAYS + 1) * DAY, kept.id)
      .run();

    const result = PurgeResult.parse((await api("POST", "/api/maintenance/purge")).body);
    expect(result.assets).toBe(1);
    expectError(await api("GET", `/api/assets/${photo.id}`), 404, "not_found");
    expect(await stored(photo.objectKey)).toBe(false);
    const aliases = await env.DB.prepare(
      "select count(*) as n from conversation_aliases where asset_id = ?",
    )
      .bind(photo.id)
      .first<{ n: number }>();
    expect(aliases?.n).toBe(0);
    expect((await api("GET", `/api/assets/${kept.id}`)).status).toBe(200);
  });
});
