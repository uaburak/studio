import {
  Asset,
  Content,
  ContentVersion,
  ContentVersionList,
  type SlideLayout,
  WECRA_DOCUMENT_MIME,
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

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
]);

async function uploadImage(brandId: string): Promise<Asset> {
  const form = new FormData();
  form.set("brandId", brandId);
  form.set("file", new File([PNG], "render.png", { type: "image/png" }));
  const res = await localFetch(`${BASE}/api/assets`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return Asset.parse(await res.json());
}

/** A Wecra document bundle (a zip: what the post editor saves its canvas as). */
async function uploadWecraDocument(brandId: string, type = WECRA_DOCUMENT_MIME): Promise<Response> {
  const form = new FormData();
  form.set("brandId", brandId);
  form.set("kind", "document");
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 1, 2, 3, 4]);
  form.set("file", new File([zip], "post.wecra", { type }));
  return localFetch(`${BASE}/api/assets`, { method: "POST", body: form });
}

const layout = (id: string, x = 72): SlideLayout => [
  { id, type: "text", role: "headline", parent: null, x, y: 120, w: 600, h: 140, visible: true },
  {
    id: "photo",
    type: "slot",
    role: null,
    parent: null,
    x: 72,
    y: 400,
    w: 560,
    h: 700,
    visible: true,
  },
];

describe("contents editor endpoints", () => {
  it("stores layer layouts with a version and updates them with new renders", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    const render = await uploadImage(brand.id);

    const created = await addVersion(content.id, {
      slides: [slide("<html><body>a</body></html>")],
      renderedAssetIds: [render.id],
      layouts: [layout("headline")],
    });
    expect(ContentVersion.parse(created).slides[0]?.layers).toEqual(layout("headline"));

    // Versions without measured layouts report null.
    const bare = await addVersion(content.id, { slides: [slide("<html><body>b</body></html>")] });
    expect(bare.slides[0]?.layers).toBeNull();
    expect(bare.slides[0]?.renderedAssetId).toBeNull();

    // A later render stores both, without changing the hash.
    const second = await uploadImage(brand.id);
    const patched = await api<ContentVersion>(
      "PATCH",
      `/api/contents/${content.id}/versions/${bare.version}`,
      { renderedAssetIds: [second.id], layouts: [layout("title", 90)] },
    );
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.contentHash).toBe(bare.contentHash);
    expect(patched.body.slides[0]).toMatchObject({
      renderedAssetId: second.id,
      layers: layout("title", 90),
    });

    // Layouts alone keep the render; a wrong count is refused.
    const onlyLayouts = await api<ContentVersion>(
      "PATCH",
      `/api/contents/${content.id}/versions/${bare.version}`,
      { layouts: [null] },
    );
    expect(onlyLayouts.body.slides[0]).toMatchObject({ renderedAssetId: second.id, layers: null });
    expectError(
      await api("PATCH", `/api/contents/${content.id}/versions/${bare.version}`, {
        layouts: [null, null],
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", `/api/contents/${content.id}/versions`, {
        origin: "generated",
        slides: [slide()],
        layouts: [
          [
            {
              id: "x",
              type: "text",
              role: null,
              parent: null,
              x: 0,
              y: 0,
              w: -1,
              h: 0,
              visible: true,
            },
          ],
        ],
      }),
      400,
      "validation_error",
    );
  });

  it("restores an older version as a new draft version with the same hash and renders", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    const render = await uploadImage(brand.id);
    const v1 = await addVersion(content.id, {
      slides: [slide("<html><body>ilk</body></html>")],
      renderedAssetIds: [render.id],
      layouts: [layout("headline")],
    });
    const v2 = await addVersion(content.id, {
      slides: [slide("<html><body>ikinci</body></html>")],
    });
    const approved = await api<Content>("POST", `/api/contents/${content.id}/approve`, {
      hash: v2.contentHash,
    });
    expect(approved.body.status).toBe("approved");

    const restored = await api<ContentVersion>(
      "POST",
      `/api/contents/${content.id}/versions/${v1.version}/restore`,
      {},
    );
    expect(restored.status, JSON.stringify(restored.body)).toBe(201);
    expect(restored.body).toMatchObject({
      version: 3,
      origin: "manual_edit",
      contentHash: v1.contentHash,
      note: "v1 geri yüklendi.",
    });
    expect(restored.body.slides[0]).toMatchObject({
      html: "<html><body>ilk</body></html>",
      renderedAssetId: render.id,
      layers: layout("headline"),
    });
    const after = await getContent(content.id);
    expect(after.status).toBe("draft");
    expect(after.approval).toBeNull();
    expect(after.currentVersion).toMatchObject({ version: 3, contentHash: v1.contentHash });

    const list = ContentVersionList.parse(
      (await api("GET", `/api/contents/${content.id}/versions`)).body,
    );
    expect(list.items.map((v) => v.version)).toEqual([3, 2, 1]);

    expectError(
      await api("POST", `/api/contents/${content.id}/versions/9/restore`, {}),
      404,
      "not_found",
    );
  });

  it("duplicates a content item with its current version as a new draft", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id, {
      type: "carousel",
      brief: "Bor ve çinko",
      caption: "Açıklama #etiket",
      targetPlatforms: ["instagram", "linkedin"],
    });
    const render = await uploadImage(brand.id);
    await addVersion(content.id, { slides: [slide("<html>1</html>"), slide("<html>2</html>")] });
    const v2 = await addVersion(content.id, {
      slides: [slide("<html>a</html>"), slide("<html>b</html>")],
      renderedAssetIds: [render.id, null],
      layouts: [layout("headline"), null],
    });
    await api("POST", `/api/contents/${content.id}/approve`, { hash: v2.contentHash });

    const copy = await api<Content>("POST", `/api/contents/${content.id}/duplicate`, {});
    expect(copy.status, JSON.stringify(copy.body)).toBe(201);
    expect(Content.parse(copy.body)).toMatchObject({
      brandId: brand.id,
      type: "carousel",
      title: "Hasat duyurusu (kopya)",
      brief: "Bor ve çinko",
      caption: "Açıklama #etiket",
      targetPlatforms: ["instagram", "linkedin"],
      status: "draft",
      approval: null,
      currentVersion: { version: 1, contentHash: v2.contentHash },
    });
    expect(copy.body.id).not.toBe(content.id);
    const copied = ContentVersion.parse(
      (await api("GET", `/api/contents/${copy.body.id}/versions/1`)).body,
    );
    expect(copied.slides.map((s) => s.renderedAssetId)).toEqual([render.id, null]);
    expect(copied.slides.map((s) => s.layers)).toEqual([layout("headline"), null]);

    // The original is untouched; a copy without versions stays without one.
    expect((await getContent(content.id)).status).toBe("approved");
    const empty = await createContent(brand.id);
    const emptyCopy = await api<Content>("POST", `/api/contents/${empty.id}/duplicate`, {
      title: "Boş kopya",
    });
    expect(emptyCopy.body).toMatchObject({ title: "Boş kopya", currentVersion: null });
    expectError(await api("POST", "/api/contents/nope/duplicate", {}), 404, "not_found");
  });

  it("validates content.render payloads when the job is created", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    expectError(
      await api("POST", "/api/jobs", {
        type: "content.render",
        contentId: content.id,
        payload: { format: "gif" },
      }),
      400,
      "validation_error",
    );
    const ok = await api("POST", "/api/jobs", {
      type: "content.render",
      contentId: content.id,
      payload: {
        format: "png",
        slides: [0],
        patches: [{ slide: 0, op: "setText", layer: "headline", text: "Yeni" }],
      },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it("keeps a version's editor document (the canvas's Wecra bundle) and copies it on restore and duplicate", async () => {
    const brand = await createBrand();
    const content = await createContent(brand.id);
    const render = await uploadImage(brand.id);
    const docRes = await uploadWecraDocument(brand.id);
    expect(docRes.status).toBe(201);
    const doc = Asset.parse(await docRes.json());
    expect(doc).toMatchObject({ kind: "document", mimeType: WECRA_DOCUMENT_MIME });

    const plain = await addVersion(content.id);
    expect(plain.editorDocument).toBeNull();
    const canvas = await addVersion(content.id, {
      origin: "manual_edit",
      slides: [slide('<html><body><img data-layer="canvas" src="/media/r.png"></body></html>')],
      renderedAssetIds: [render.id],
      editorDocument: { kind: "wecra", assetId: doc.id, format: 1 },
    });
    expect(canvas.editorDocument).toEqual({ kind: "wecra", assetId: doc.id, format: 1 });
    expect(canvas.slides[0]?.renderedAssetId).toBe(render.id);
    const got = await api<ContentVersion>(
      "GET",
      `/api/contents/${content.id}/versions/${canvas.version}`,
    );
    expect(got.body.editorDocument).toEqual({ kind: "wecra", assetId: doc.id, format: 1 });

    // Restoring the canvas version (or an older plain one) carries its own document, or none.
    const restored = await api<ContentVersion>(
      "POST",
      `/api/contents/${content.id}/versions/${canvas.version}/restore`,
      {},
    );
    expect(restored.status).toBe(201);
    expect(restored.body.editorDocument).toEqual({ kind: "wecra", assetId: doc.id, format: 1 });
    expect(restored.body.contentHash).toBe(canvas.contentHash);
    const back = await api<ContentVersion>(
      "POST",
      `/api/contents/${content.id}/versions/${plain.version}/restore`,
      {},
    );
    expect(back.body.editorDocument).toBeNull();

    // A duplicate's version 1 is the current version, its document included.
    await api("POST", `/api/contents/${content.id}/versions/${canvas.version}/restore`, {});
    const copy = await api<Content>("POST", `/api/contents/${content.id}/duplicate`, {});
    expect(copy.status).toBe(201);
    const copied = await api<ContentVersion>("GET", `/api/contents/${copy.body.id}/versions/1`);
    expect(copied.body.editorDocument).toEqual({ kind: "wecra", assetId: doc.id, format: 1 });
  });

  it("refuses an editor document that isn't a Wecra bundle of the brand", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const content = await createContent(brand.id);
    const image = await uploadImage(brand.id);
    const foreign = Asset.parse(await (await uploadWecraDocument(other.id)).json());
    const create = (assetId: string) =>
      api("POST", `/api/contents/${content.id}/versions`, {
        origin: "manual_edit",
        slides: [slide()],
        editorDocument: { kind: "wecra", assetId, format: 1 },
      });
    expectError(await create(image.id), 400, "validation_error");
    expectError(await create(foreign.id), 400, "validation_error");
    expectError(await create("missing-asset"), 404, "not_found");
    // Not a zip: refused at upload.
    const fake = new FormData();
    fake.set("brandId", brand.id);
    fake.set(
      "file",
      new File([new Uint8Array([1, 2, 3, 4])], "x.wecra", { type: WECRA_DOCUMENT_MIME }),
    );
    const res = await localFetch(`${BASE}/api/assets`, { method: "POST", body: fake });
    expect(res.status).toBe(415);
  });
});
