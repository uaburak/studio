import {
  AssetUsageList,
  type Content,
  ContentGeneratePayload,
  ContentList,
  ContentRepurposeManyResult,
  ContentRepurposeResult,
  ContentTemplate,
  ContentTemplateDetail,
  ContentTemplateList,
  Plan,
  TemplateUseResult,
  WECRA_DOCUMENT_MIME,
} from "@studio/contract";
import { type CanvasFacts, canvasSlideHtml } from "@studio/design-kit/canvas";
import { describe, expect, it } from "vitest";
import { addVersion, api, createBrand, createContent, expectError, getContent } from "./helpers.ts";
import { seedPlan, solidPng, uploadFile } from "./lifecycle-helpers.ts";

/*
 * Brand templates (N9) and repurposing (N10) over the API: saving an approved post (HTML and
 * canvas versions) as a template, its fields, using it (the job's payload), and converting
 * posts into stories and Reels linked to their source.
 */

const htmlSlide = (photo: string) => `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><meta name="studio:contract" content="v1"><meta name="studio:format" content="1080x1350"><link rel="stylesheet" href="/brand/brand.css"></head>
<body>
  <main data-artboard style="width:1080px;height:1350px">
    <figure data-layer="photo" data-type="slot" data-slot-ratio="4:5" data-slot-state="filled" data-slot-label="Ürün" data-slot-fit="cover" style="position:absolute;left:72px;top:72px;width:560px;height:700px"><img data-slot-image src="/media/${photo}.png" alt=""></figure>
    <h1 data-layer="headline" data-type="text" data-role="headline" style="position:absolute;left:72px;top:820px;width:936px;font-size:88px">Hasat bitti</h1>
    <p data-layer="body" data-type="text" data-role="body" style="position:absolute;left:72px;top:1000px;width:936px">Toprağınızı kışa hazırlayın.</p>
    <p data-layer="cta" data-type="text" data-role="cta" style="position:absolute;left:72px;top:1120px;width:600px">Şimdi incele</p>
    <img data-layer="logo" data-type="logo" src="/brand/logos/logo.png" alt="" style="position:absolute;left:72px;top:1230px;height:48px">
  </main>
</body>
</html>`;

const canvasFacts = (): CanvasFacts => ({
  v: 1,
  editor: "wecra",
  frame: {
    id: "7:1",
    name: "Kare 1",
    width: 1080,
    height: 1350,
    background: "#F4EFE4",
    fills: [{ type: "solid", color: "#F4EFE4", opacity: 1 }],
  },
  nodes: [
    {
      id: "7:2",
      name: "headline",
      type: "text",
      wecraType: "TEXT",
      parent: null,
      bounds: { x: 80, y: 200, w: 600, h: 96 },
      rotation: 0,
      opacity: 1,
      effectiveOpacity: 1,
      visible: true,
      clips: false,
      clip: null,
      fills: [],
      strokes: [],
      strokeWeight: 0,
      text: {
        characters: "Hasat bitti",
        family: "Archivo",
        style: "Bold",
        weight: 700,
        italic: false,
        size: 80,
        lineHeight: 96,
        letterSpacing: 0,
        align: "left",
        verticalAlign: "top",
        autoResize: "height",
        color: "#1D2A1B",
        colors: ["#1D2A1B"],
        fills: [{ type: "solid", color: "#1D2A1B", opacity: 1 }],
        runs: [],
        lines: [{ x: 80, y: 200, w: 420, h: 96, from: 0, to: 11 }],
        overflow: false,
        truncated: false,
        missingFont: false,
      },
      mark: {
        layer: "headline",
        type: "text",
        role: "headline",
        src: null,
        image: null,
        allowOverlap: false,
        slot: null,
      },
    },
  ],
  fonts: [{ family: "Archivo", style: "Bold", uses: 1, missing: false }],
});

async function uploadImage(brandId: string, source: "upload" | "generated" = "upload") {
  return uploadFile(brandId, await solidPng(8, 10), "image/png", "foto.png", source);
}

/** A post with an HTML version (filled slot, render) approved by hash. */
async function approvedHtmlPost(brandId: string, title = "Hasat duyurusu") {
  const photo = await uploadImage(brandId);
  const render = await uploadImage(brandId, "generated");
  const content = await createContent(brandId, { title, targetPlatforms: ["instagram"] });
  const version = await addVersion(content.id, {
    slides: [{ html: htmlSlide(photo.id), width: 1080, height: 1350 }],
    renderedAssetIds: [render.id],
  });
  const res = await api<Content>("POST", `/api/contents/${content.id}/approve`, {
    hash: version.contentHash,
    acknowledgeChecks: true,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { content: res.body, version, photo, render };
}

async function createTemplate(contentId: string, extra: Record<string, unknown> = {}) {
  const res = await api("POST", "/api/templates", { contentId, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ContentTemplate.parse(res.body);
}

describe("brand templates (N9)", () => {
  it("saves an approved HTML post as a template with role-named fields", async () => {
    const brand = await createBrand();
    const { content, version, photo, render } = await approvedHtmlPost(brand.id);
    const template = await createTemplate(content.id, { name: "Ürün duyurusu" });
    expect(template).toMatchObject({
      brandId: brand.id,
      name: "Ürün duyurusu",
      kind: "html",
      contentType: "post",
      width: 1080,
      height: 1350,
      slideCount: 1,
      previewAssetIds: [render.id],
      source: { contentId: content.id, version: version.version, title: "Hasat duyurusu" },
      editorDocument: null,
      useCount: 0,
    });
    expect(template.fields.map((f) => `${f.key}:${f.kind}:${f.layer}`)).toEqual([
      "slot:image:photo",
      "headline:text:headline",
      "body:text:body",
      "cta:text:cta",
    ]);
    const headline = template.fields.find((f) => f.key === "headline");
    expect(headline).toMatchObject({ label: "Başlık", example: "Hasat bitti", minFontSize: 53 });

    // The template keeps its own copy of the slides.
    const detail = await api("GET", `/api/templates/${template.id}`);
    expect(detail.status).toBe(200);
    const parsed = ContentTemplateDetail.parse(detail.body);
    expect(parsed.slides[0]?.html).toContain(`/media/${photo.id}.png`);
    expect(parsed.slides[0]?.renderedAssetId).toBe(render.id);

    // Listed under its brand; the render is now held by the template.
    const list = ContentTemplateList.parse(
      (await api("GET", `/api/brands/${brand.id}/templates`)).body,
    );
    expect(list.items.map((t) => t.id)).toEqual([template.id]);
    const usage = AssetUsageList.parse((await api("GET", `/api/assets/${render.id}/usage`)).body);
    expect(usage.usages.some((u) => u.kind === "template" && u.blocking)).toBe(true);
  });

  it("refuses posts that were never approved, Reels and posts with nothing to fill", async () => {
    const brand = await createBrand();
    const draft = await createContent(brand.id);
    await addVersion(draft.id);
    expectError(await api("POST", "/api/templates", { contentId: draft.id }), 409, "conflict");

    const reel = await createContent(brand.id, { type: "reel" });
    expectError(await api("POST", "/api/templates", { contentId: reel.id }), 409, "conflict");

    const empty = await createContent(brand.id);
    const v = await addVersion(empty.id);
    await api("POST", `/api/contents/${empty.id}/approve`, {
      hash: v.contentHash,
      acknowledgeChecks: true,
    });
    const res = await api("POST", "/api/templates", { contentId: empty.id });
    const error = expectError(res, 409, "conflict");
    expect(error.message).toContain("doldurulacak");
  });

  it("saves a canvas version with its Wecra document; fields name the Wecra layers", async () => {
    const brand = await createBrand();
    const bundle = await uploadFile(
      brand.id,
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 1, 2, 3, 4]),
      WECRA_DOCUMENT_MIME,
      "post.wecra",
    );
    const render = await uploadImage(brand.id, "generated");
    const content = await createContent(brand.id);
    const version = await addVersion(content.id, {
      origin: "manual_edit",
      slides: [
        {
          html: canvasSlideHtml({
            facts: canvasFacts(),
            src: `/media/${render.id}.png`,
            sha256: "c".repeat(64),
          }),
          width: 1080,
          height: 1350,
        },
      ],
      renderedAssetIds: [render.id],
      editorDocument: { kind: "wecra", assetId: bundle.id, format: 2 },
    });
    await api("POST", `/api/contents/${content.id}/approve`, {
      hash: version.contentHash,
      acknowledgeChecks: true,
    });
    const template = await createTemplate(content.id);
    expect(template.kind).toBe("canvas");
    expect(template.editorDocument).toEqual({ kind: "wecra", assetId: bundle.id, format: 2 });
    expect(template.fields).toHaveLength(1);
    expect(template.fields[0]).toMatchObject({
      key: "headline",
      nodeId: "7:2",
      layerType: "text",
      metrics: { fontSize: 80, lineHeight: 96, lines: 1, autoResize: "height" },
    });
    const usage = AssetUsageList.parse((await api("GET", `/api/assets/${bundle.id}/usage`)).body);
    expect(usage.usages.map((u) => u.kind)).toContain("template");
  });

  it("renames, locks fields and deletes; posts made from it keep their design", async () => {
    const brand = await createBrand();
    const { content } = await approvedHtmlPost(brand.id);
    const template = await createTemplate(content.id);
    const patched = await api("PATCH", `/api/templates/${template.id}`, {
      name: "Kampanya",
      fields: [{ key: "cta", locked: true, label: "Buton" }],
    });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const updated = ContentTemplate.parse(patched.body);
    expect(updated.name).toBe("Kampanya");
    expect(updated.fields.find((f) => f.key === "cta")).toMatchObject({
      locked: true,
      label: "Buton",
    });
    expectError(
      await api("PATCH", `/api/templates/${template.id}`, { fields: [{ key: "nope" }] }),
      400,
      "validation_error",
    );

    const used = TemplateUseResult.parse(
      (await api("POST", `/api/templates/${template.id}/use`, { values: { headline: "Yeni" } }))
        .body,
    );
    expect((await api("DELETE", `/api/templates/${template.id}`)).status).toBe(204);
    expectError(await api("GET", `/api/templates/${template.id}`), 404, "not_found");
    const after = await getContent(used.content.id);
    expect(after.templateId).toBeNull();
  });

  it("makes a new post from a template and queues its fill job", async () => {
    const brand = await createBrand();
    const { content } = await approvedHtmlPost(brand.id);
    const template = await createTemplate(content.id);
    const photo = await uploadImage(brand.id);

    const res = await api("POST", `/api/templates/${template.id}/use`, {
      title: "Kış bakımı",
      values: { headline: "Kışa hazır mısınız?", body: "Bor ve çinko ile." },
      images: { slot: photo.id },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const made = TemplateUseResult.parse(res.body);
    expect(made.content).toMatchObject({
      brandId: brand.id,
      type: "post",
      title: "Kış bakımı",
      status: "draft",
      templateId: template.id,
      currentVersion: null,
      targetPlatforms: ["instagram"],
    });
    expect(made.job).toMatchObject({ type: "content.generate", contentId: made.content.id });
    const payload = ContentGeneratePayload.parse(made.job.payload);
    expect(payload.template).toEqual({
      templateId: template.id,
      values: { headline: "Kışa hazır mısınız?", body: "Bor ve çinko ile." },
      images: { slot: photo.id },
      fill: "manual",
      autoFit: true,
    });
    expect(payload.type).toBe("post");

    // A brief means the AI fills the fields.
    const ai = TemplateUseResult.parse(
      (
        await api("POST", `/api/templates/${template.id}/use`, {
          brief: "Kışlık gübreleme hatırlatması",
        })
      ).body,
    );
    expect(ContentGeneratePayload.parse(ai.job.payload).template?.fill).toBe("ai");

    const listed = ContentList.parse(
      (await api("GET", `/api/contents?templateId=${template.id}`)).body,
    );
    expect(listed.items.map((c) => c.id).sort()).toEqual([made.content.id, ai.content.id].sort());
    const again = ContentTemplate.parse((await api("GET", `/api/templates/${template.id}`)).body);
    expect(again.useCount).toBe(2);
  });

  it("refuses unknown fields, AI without a brief and pictures of another brand", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const { content } = await approvedHtmlPost(brand.id);
    const template = await createTemplate(content.id);
    const foreign = await uploadImage(other.id);
    expectError(
      await api("POST", `/api/templates/${template.id}/use`, { values: { nope: "x" } }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", `/api/templates/${template.id}/use`, { fill: "ai" }),
      400,
      "validation_error",
    );
    expectError(
      await api("POST", `/api/templates/${template.id}/use`, { images: { slot: foreign.id } }),
      400,
      "validation_error",
    );
    // Nothing was created by the refusals.
    const listed = ContentList.parse(
      (await api("GET", `/api/contents?templateId=${template.id}`)).body,
    );
    expect(listed.items).toEqual([]);
  });

  it("lets a plan item name a template of its brand and type; generation fills it", async () => {
    const brand = await createBrand();
    const other = await createBrand();
    const { content } = await approvedHtmlPost(brand.id);
    const template = await createTemplate(content.id);
    const { content: foreignPost } = await approvedHtmlPost(other.id);
    const foreign = await createTemplate(foreignPost.id);

    const planId = await seedPlan(brand.id, [{}, { contentType: "carousel" }]);
    const plan = Plan.parse((await api("GET", `/api/plans/${planId}`)).body);
    const [postItem, carouselItem] = plan.items;
    expectError(
      await api("PATCH", `/api/plans/${planId}/items/${postItem?.id}`, {
        templateId: foreign.id,
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("PATCH", `/api/plans/${planId}/items/${carouselItem?.id}`, {
        templateId: template.id,
      }),
      400,
      "validation_error",
    );
    const ok = await api("PATCH", `/api/plans/${planId}/items/${postItem?.id}`, {
      templateId: template.id,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const edited = Plan.parse(ok.body);
    expect(edited.items[0]?.templateId).toBe(template.id);

    const accepted = await api("POST", `/api/plans/${planId}/accept`, {
      revision: edited.revision,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const gen = await api<{ jobs: { contentId: string; payload: Record<string, unknown> }[] }>(
      "POST",
      `/api/plans/${planId}/generate`,
      {},
    );
    expect(gen.status, JSON.stringify(gen.body)).toBe(200);
    const acceptedPlan = Plan.parse(accepted.body);
    const job = gen.body.jobs.find((j) => j.contentId === acceptedPlan.items[0]?.contentId);
    expect(ContentGeneratePayload.parse(job?.payload).template).toMatchObject({
      templateId: template.id,
      fill: "ai",
    });
    const other2 = gen.body.jobs.find((j) => j.contentId === acceptedPlan.items[1]?.contentId);
    expect(ContentGeneratePayload.parse(other2?.payload).template).toBeUndefined();
  });
});

describe("repurposing (N10)", () => {
  it("turns a post into a story linked to its source", async () => {
    const brand = await createBrand();
    const { content, version } = await approvedHtmlPost(brand.id, "Hasat");
    const res = await api("POST", `/api/contents/${content.id}/repurpose`, { target: "story" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const made = ContentRepurposeResult.parse(res.body);
    expect(made.content).toMatchObject({
      type: "story",
      title: "Hasat · Story",
      status: "draft",
      source: { contentId: content.id, version: version.version, kind: "story" },
    });
    const payload = ContentGeneratePayload.parse(made.job.payload);
    expect(payload.repurpose).toEqual({
      sourceContentId: content.id,
      sourceVersion: version.version,
      target: "story",
    });
    expect(payload.type).toBe("story");
    expect(payload.reel).toBeUndefined();

    const derived = ContentList.parse(
      (await api("GET", `/api/contents?sourceContentId=${content.id}`)).body,
    );
    expect(derived.items.map((c) => c.id)).toEqual([made.content.id]);
  });

  it("turns a post into a motion-graphics Reels; a Reels cannot be converted", async () => {
    const brand = await createBrand();
    const { content } = await approvedHtmlPost(brand.id);
    const made = ContentRepurposeResult.parse(
      (
        await api("POST", `/api/contents/${content.id}/repurpose`, {
          target: "reel",
          instructions: "Daha hızlı olsun",
        })
      ).body,
    );
    expect(made.content.type).toBe("reel");
    const payload = ContentGeneratePayload.parse(made.job.payload);
    expect(payload.reel).toEqual({ recipe: "motion_graphics" });
    expect(payload.repurpose?.target).toBe("reel");
    expect(payload.instructions).toBe("Daha hızlı olsun");

    expectError(
      await api("POST", `/api/contents/${made.content.id}/repurpose`, { target: "story" }),
      409,
      "conflict",
    );
    const story = await createContent(brand.id, { type: "story" });
    await addVersion(story.id, { slides: [{ html: "<p>s</p>", width: 1080, height: 1920 }] });
    expectError(
      await api("POST", `/api/contents/${story.id}/repurpose`, { target: "story" }),
      409,
      "conflict",
    );
  });

  it("converts many posts at once and says which were left out", async () => {
    const brand = await createBrand();
    const a = await approvedHtmlPost(brand.id, "A");
    const b = await approvedHtmlPost(brand.id, "B");
    const empty = await createContent(brand.id, { title: "Boş" });
    const res = await api("POST", "/api/contents/repurpose", {
      contentIds: [a.content.id, empty.id, b.content.id, "missing-id"],
      target: "reel",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const out = ContentRepurposeManyResult.parse(res.body);
    expect(out.created.map((c) => c.sourceContentId)).toEqual([a.content.id, b.content.id]);
    expect(out.created.every((c) => c.content.type === "reel")).toBe(true);
    expect(out.skipped).toEqual([
      { contentId: empty.id, reason: "no_version", message: expect.any(String) },
      { contentId: "missing-id", reason: "not_found", message: "Post bulunamadı." },
    ]);
  });
});
