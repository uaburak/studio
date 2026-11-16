import {
  Asset,
  Content,
  ContentVersion,
  ContentVersionList,
  type SlideLayout,
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
});
