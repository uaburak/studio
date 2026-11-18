import { env } from "cloudflare:workers";
import {
  type Asset,
  Content,
  ContentList,
  ContentVersion,
  ContentVersionList,
  computeContentHash,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  addVersion,
  api,
  BASE,
  createBrand,
  createContent,
  expectError,
  getContent,
  localFetch,
  slide,
} from "./helpers.ts";

describe("contents", () => {
  it("creates a draft without a version, lists, updates and deletes it", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id, { brief: "Yeni hasat", caption: "Merhaba" });
    expect(Content.parse(content)).toMatchObject({
      status: "draft",
      type: "post",
      currentVersion: null,
      approval: null,
      targetPlatforms: ["instagram"],
    });

    const list = ContentList.parse((await api("GET", `/api/contents?brandId=${brand.id}`)).body);
    expect(list.items.map((c) => c.id)).toEqual([content.id]);
    const filtered = ContentList.parse(
      (await api("GET", `/api/contents?brandId=${brand.id}&status=approved`)).body,
    );
    expect(filtered.items).toEqual([]);

    const patched = await api("PATCH", `/api/contents/${content.id}`, { title: "Yeni başlık" });
    expect(Content.parse(patched.body).title).toBe("Yeni başlık");

    expect((await api("DELETE", `/api/contents/${content.id}`)).status).toBe(204);
    expectError(await api("GET", `/api/contents/${content.id}`), 404, "not_found");
  });

  it("validates input and references", async () => {
    const brand = await createBrand();
    expectError(
      await api("POST", "/api/contents", { brandId: brand.id, type: "tweet", title: "x" }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", "/api/contents", {
        brandId: brand.id,
        type: "post",
        title: "x",
        targetPlatforms: ["instagram", "instagram"],
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", "/api/contents", { brandId: "missing", type: "post", title: "x" }),
      404,
      "not_found",
    );
    const archived = await createBrand();
    await api("PATCH", `/api/brands/${archived.id}`, { status: "archived" });
    expectError(
      await api("POST", "/api/contents", { brandId: archived.id, type: "post", title: "x" }),
      409,
      "conflict",
    );
  });
});

describe("content versions", () => {
  it("numbers versions, computes the hash server-side and stores slides in order", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id, { type: "carousel" });
    const slides = [slide("<p>1</p>"), { ...slide("<p>2</p>"), width: 1080, height: 1080 }];
    const v1 = ContentVersion.parse(
      (
        await api("POST", `/api/contents/${content.id}/versions`, {
          origin: "generated",
          slides,
          note: "ilk deneme",
        })
      ).body,
    );
    expect(v1).toMatchObject({
      version: 1,
      slideCount: 2,
      origin: "generated",
      note: "ilk deneme",
    });
    expect(v1.contentHash).toBe(await computeContentHash(slides));
    expect(v1.slides.map((s) => [s.html, s.width, s.height, s.renderedAssetId])).toEqual([
      ["<p>1</p>", 1080, 1350, null],
      ["<p>2</p>", 1080, 1080, null],
    ]);

    const v2 = await addVersion(content.id, {
      origin: "manual_edit",
      slides: [slide("<p>1b</p>"), slide("<p>2</p>")],
    });
    expect(v2.version).toBe(2);
    expect(v2.contentHash).not.toBe(v1.contentHash);

    const after = await getContent(content.id);
    expect(after.currentVersion).toEqual({ id: v2.id, version: 2, contentHash: v2.contentHash });

    const list = ContentVersionList.parse(
      (await api("GET", `/api/contents/${content.id}/versions`)).body,
    );
    expect(list.items.map((v) => v.version)).toEqual([2, 1]);
    expect(list.items[0]).not.toHaveProperty("slides");

    const got = ContentVersion.parse(
      (await api("GET", `/api/contents/${content.id}/versions/1`)).body,
    );
    expect(got).toEqual(v1);
  });

  it("enforces slide counts per type and validates slides", async () => {
    const brand = await createBrand();
    const post = await createContent(brand.id, { type: "post" });
    const carousel = await createContent(brand.id, { type: "carousel" });
    expectError(
      await api("POST", `/api/contents/${post.id}/versions`, {
        origin: "generated",
        slides: [slide(), slide()],
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", `/api/contents/${carousel.id}/versions`, {
        origin: "generated",
        slides: [slide()],
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", `/api/contents/${post.id}/versions`, {
        origin: "generated",
        slides: [{ html: "", width: 0, height: 99999 }],
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", `/api/contents/${post.id}/versions`, {
        origin: "magic",
        slides: [slide()],
      }),
      400,
      "validation_error",
    );
    expectError(await api("GET", `/api/contents/${post.id}/versions/7`), 404, "not_found");
    expectError(
      await api("POST", "/api/contents/missing/versions", {
        origin: "generated",
        slides: [slide()],
      }),
      404,
      "not_found",
    );
  });

  it("attaches rendered assets later without changing the hash", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const content = await createContent(brand.id);
    const v1 = await addVersion(content.id);
    const asset = await uploadPng(brand.id);
    const foreign = await uploadPng(other.id);

    const patched = ContentVersion.parse(
      (
        await api("PATCH", `/api/contents/${content.id}/versions/1`, {
          renderedAssetIds: [asset.id],
          note: "render hazır",
        })
      ).body,
    );
    expect(patched.slides[0]?.renderedAssetId).toBe(asset.id);
    expect(patched.note).toBe("render hazır");
    expect(patched.contentHash).toBe(v1.contentHash);

    expectError(
      await api("PATCH", `/api/contents/${content.id}/versions/1`, {
        renderedAssetIds: [foreign.id],
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("PATCH", `/api/contents/${content.id}/versions/1`, {
        renderedAssetIds: [asset.id, asset.id],
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("PATCH", `/api/contents/${content.id}/versions/1`, {
        renderedAssetIds: ["missing"],
      }),
      404,
      "not_found",
    );
  });
});

describe("approval by hash", () => {
  it("approves the current version by hash; a newer version returns the content to draft", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);

    // Nothing to approve yet.
    expectError(
      await api("POST", `/api/contents/${content.id}/approve`, { hash: "0".repeat(64) }),
      409,
      "conflict",
    );

    const v1 = await addVersion(content.id);
    const submitted = await api("POST", `/api/contents/${content.id}/transition`, {
      to: "in_review",
    });
    expect(Content.parse(submitted.body).status).toBe("in_review");

    // Wrong hash: refused, nothing changes.
    expectError(
      await api("POST", `/api/contents/${content.id}/approve`, { hash: "f".repeat(64) }),
      409,
      "hash_mismatch",
    );
    expectError(
      await api("POST", `/api/contents/${content.id}/approve`, { hash: "not-a-hash" }),
      400,
      "validation_error",
    );
    expect((await getContent(content.id)).status).toBe("in_review");

    const approved = Content.parse(
      (
        await api("POST", `/api/contents/${content.id}/approve`, {
          hash: v1.contentHash,
          acknowledgeChecks: true,
        })
      ).body,
    );
    expect(approved.status).toBe("approved");
    expect(approved.approval).toMatchObject({ versionId: v1.id, contentHash: v1.contentHash });

    // Idempotent with the same hash.
    const again = await api("POST", `/api/contents/${content.id}/approve`, {
      hash: v1.contentHash,
    });
    expect(again.status).toBe(200);

    // A newer version invalidates the approval.
    const v2 = await addVersion(content.id, {
      origin: "ai_edit",
      slides: [slide("<html><body>v2</body></html>")],
    });
    const afterEdit = await getContent(content.id);
    expect(afterEdit.status).toBe("draft");
    expect(afterEdit.approval).toBeNull();
    expect(afterEdit.currentVersion?.id).toBe(v2.id);

    // The old hash no longer approves anything.
    expectError(
      await api("POST", `/api/contents/${content.id}/approve`, { hash: v1.contentHash }),
      409,
      "hash_mismatch",
    );
    const reapproved = await api("POST", `/api/contents/${content.id}/approve`, {
      hash: v2.contentHash,
      acknowledgeChecks: true,
    });
    expect(Content.parse(reapproved.body).approval?.versionId).toBe(v2.id);
  });

  it("revokes approval when the caption changes, keeps it for title edits", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id, { caption: "ilk" });
    const v1 = await addVersion(content.id);
    await api("POST", `/api/contents/${content.id}/approve`, {
      hash: v1.contentHash,
      acknowledgeChecks: true,
    });

    const titled = Content.parse(
      (await api("PATCH", `/api/contents/${content.id}`, { title: "Sadece başlık" })).body,
    );
    expect(titled.status).toBe("approved");

    const captioned = Content.parse(
      (await api("PATCH", `/api/contents/${content.id}`, { caption: "yeni metin" })).body,
    );
    expect(captioned.status).toBe("draft");
    expect(captioned.approval).toBeNull();
  });

  it("validates manual transitions server-side", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    // in_review needs a version.
    expectError(
      await api("POST", `/api/contents/${content.id}/transition`, { to: "in_review" }),
      409,
      "conflict",
    );
    // draft -> approved must go through /approve.
    expectError(
      await api("POST", `/api/contents/${content.id}/transition`, { to: "approved" }),
      409,
      "invalid_transition",
    );
    expectError(
      await api("POST", `/api/contents/${content.id}/transition`, { to: "published" }),
      400,
      "validation_error",
    );

    const v1 = await addVersion(content.id);
    await api("POST", `/api/contents/${content.id}/approve`, {
      hash: v1.contentHash,
      acknowledgeChecks: true,
    });
    // Revoke.
    const revoked = Content.parse(
      (await api("POST", `/api/contents/${content.id}/transition`, { to: "draft" })).body,
    );
    expect(revoked).toMatchObject({ status: "draft", approval: null });
  });

  it("freezes published content: no versions, no caption edits, no delete", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    const v1 = await addVersion(content.id);
    await api("POST", `/api/contents/${content.id}/approve`, {
      hash: v1.contentHash,
      acknowledgeChecks: true,
    });
    // Simulate the (future) publishing engine.
    await env.DB.prepare("update contents set status = 'published' where id = ?")
      .bind(content.id)
      .run();

    expectError(
      await api("POST", `/api/contents/${content.id}/versions`, {
        origin: "manual_edit",
        slides: [slide("x")],
      }),
      409,
      "invalid_transition",
    );
    expectError(
      await api("PATCH", `/api/contents/${content.id}`, { caption: "late" }),
      409,
      "invalid_transition",
    );
    expectError(await api("DELETE", `/api/contents/${content.id}`), 409, "invalid_transition");
    expectError(
      await api("POST", `/api/contents/${content.id}/transition`, { to: "draft" }),
      409,
      "invalid_transition",
    );
  });

  it("cascades version and slide rows on delete", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id, { type: "carousel" });
    await addVersion(content.id, { slides: [slide("a"), slide("b")] });
    expect((await api("DELETE", `/api/contents/${content.id}`)).status).toBe(204);
    const left = await env.DB.prepare(
      "select count(*) as n from content_versions where content_id = ?",
    )
      .bind(content.id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

async function uploadPng(brandId: string): Promise<Asset> {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const form = new FormData();
  form.set("brandId", brandId);
  form.set("kind", "image");
  form.set("source", "generated");
  form.set("file", new File([png], "render.png", { type: "image/png" }));
  const res = await localFetch(`${BASE}/api/assets`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return (await res.json()) as Asset;
}
