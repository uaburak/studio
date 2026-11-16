import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Asset, Content, ContentVersion, Job, SlideLayout } from "@studio/contract";
import type { LintReport } from "@studio/design-kit/lint";
import { createRenderer, isChromiumAvailable } from "@studio/design-kit/render";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { buildBrandContext } from "../src/generate/brand.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import {
  applySlotAssignmentToSlide,
  type ContentRenderDeps,
  createContentRenderHandler,
  normalizePatchOp,
  type RenderCapable,
} from "../src/render/handler.ts";
import { layoutFromReport } from "../src/render/layout.ts";
import { buildReelVersionSlideHtml } from "../src/video/recipes.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const KIT_FIXTURES = fileURLToPath(
  new URL("../../../packages/design-kit/test/fixtures/", import.meta.url),
);
const slotSlideHtml = readFileSync(path.join(KIT_FIXTURES, "slides/image-slot.html"), "utf8");
const typographicHtml = readFileSync(path.join(KIT_FIXTURES, "slides/typographic.html"), "utf8");

function renderJobCtx(contentId: string, payload: Record<string, unknown>): JobContext {
  const job: Job = {
    id: "job_render_1",
    type: "content.render",
    status: "running",
    brandId: "brand_1",
    contentId,
    payload,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    jobId: job.id,
    job,
    attempt: 1,
    workerId: "mac",
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
  };
}

async function samplePng(width = 1080, height = 1350, color = "#3E9B3A"): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: color } })
      .png()
      .toBuffer(),
  );
}

function fakeRenderer(
  onRender?: (html: string, width: number, height: number) => Promise<void>,
): RenderCapable {
  return {
    async render(req) {
      await onRender?.(req.html, req.width, req.height);
      const png = await samplePng(req.width, req.height);
      return {
        png,
        pixelWidth: req.width,
        pixelHeight: req.height,
        deviceScaleFactor: 1,
        network: { blocked: [], missing: [] },
        served: [],
        timings: {
          contextMs: 1,
          loadMs: 1,
          assetsMs: 1,
          screenshotMs: 1,
          encodeMs: 1,
          totalMs: 5,
        },
      };
    },
    async renderAndLint() {
      throw new Error("not used");
    },
  };
}

function makeDeps(
  api: ContentRenderDeps["api"],
  renderer: RenderCapable,
  extra: Partial<ContentRenderDeps> = {},
): ContentRenderDeps {
  return {
    api,
    gate: new ClaudeGate({
      runner: async () => {
        throw new Error("claude unused");
      },
    }),
    settings: loadAgentSettings({}),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-render-")),
    renderer: () => renderer,
    ...extra,
  };
}

function seedContentWithSlides(
  state: ReturnType<typeof createFakeApi>["state"],
  slides: { html: string; width: number; height: number }[],
  type: Content["type"] = "post",
  targetPlatforms: Content["targetPlatforms"] = ["instagram"],
) {
  const version: ContentVersion = {
    id: "ver_1",
    contentId: "cnt_1",
    version: 1,
    origin: "generated",
    contentHash: "a".repeat(64),
    slideCount: slides.length,
    note: "İlk sürüm",
    jobId: null,
    createdAt: NOW,
    updatedAt: NOW,
    slides: slides.map((s) => ({ ...s, renderedAssetId: null })),
  };
  state.versions.push(version);
  const content: Content = {
    id: "cnt_1",
    brandId: "brand_1",
    type,
    title: "Bahar Uygulaması",
    brief: "Tarla fotoğrafı ile paylaşım",
    status: "draft",
    targetPlatforms,
    caption: "Bahar hazırlığı",
    currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) },
    approval: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.contents.set("cnt_1", content);
}

function assetRecord(id: string, mimeType: string): Asset {
  return {
    id,
    brandId: "brand_1",
    kind: "image",
    source: "upload",
    objectKey: `brands/brand_1/${id}`,
    mimeType,
    bytes: 10,
    sha256: "0".repeat(64),
    width: 1200,
    height: 900,
    durationMs: null,
    originalFilename: null,
    createdAt: NOW,
  };
}

/** A renderer whose lint pass measures one box per `data-layer` id found in the HTML. */
function measuringRenderer(log: string[] = []): RenderCapable {
  const raster = async (req: { html: string; width: number; height: number }) => {
    log.push(req.html);
    const png = await samplePng(req.width, req.height);
    return {
      png,
      pixelWidth: req.width,
      pixelHeight: req.height,
      deviceScaleFactor: 1,
      network: { blocked: [], missing: [] },
      served: [],
      timings: { contextMs: 1, loadMs: 1, assetsMs: 1, screenshotMs: 1, encodeMs: 1, totalMs: 5 },
    };
  };
  return {
    render: raster,
    async renderAndLint(req) {
      const ids = [...req.html.matchAll(/data-layer="([^"]+)"/g)].map((m) => m[1] as string);
      const report = {
        schema: "studio.lint/1",
        kit: "test",
        contract: "v1",
        artboard: { width: req.width, height: req.height },
        ok: true,
        summary: { errors: 0, warnings: 0, info: 0 },
        stages: { static: true, layout: true, pixel: false, render: false },
        issues: [],
        layers: ids.map((id, i) => ({
          id,
          type: "text",
          role: null,
          parent: null,
          rect: { x: 10 * i, y: 20, w: 100, h: 50 },
          visible: true,
        })),
      } as unknown as LintReport;
      return { ...(await raster(req)), report };
    },
  };
}

function seedVersion(
  state: ReturnType<typeof createFakeApi>["state"],
  slides: { html: string; renderedAssetId: string | null; layers: SlideLayout | null }[],
  type: Content["type"] = "carousel",
) {
  seedContentWithSlides(
    state,
    slides.map((s) => ({ html: s.html, width: 1080, height: 1350 })),
    type,
  );
  const v = state.versions[0] as ContentVersion;
  v.slides = slides.map((s) => ({ ...s, width: 1080, height: 1350 }));
}

describe("content.render handler", () => {
  it("fills image slots to /media/{id}.{ext}, applies layer patches, creates a new version, renders sRGB JPEG, and moves draft -> in_review", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedContentWithSlides(state, [{ html: slotSlideHtml, width: 1080, height: 1350 }]);
    const userPhoto = await samplePng(1200, 900, "#2255AA");
    state.assets.set("asset_user_photo", { bytes: userPhoto, contentType: "image/png" });
    state.assetRecords.push(assetRecord("asset_user_photo", "image/png"));

    let renderedHtml = "";
    const renderer = fakeRenderer(async (html) => {
      renderedHtml = html;
    });

    const handler = createContentRenderHandler(makeDeps(api, renderer));
    const payload = {
      format: "jpeg" as const,
      slotAssignments: { "field-photo": "asset_user_photo" },
      patches: [{ op: "setText", layer: "headline", text: "Yeni Başlık" }],
    };
    const out = await handler.run(payload, renderJobCtx("cnt_1", payload));

    expect(out).toMatchObject({
      contentId: "cnt_1",
      version: 2,
      renderedAssetIds: ["asset_gen_1"],
    });
    expect(renderedHtml).toContain('data-slot-state="filled"');
    expect(renderedHtml).toContain('src="/media/asset_user_photo.png"');
    expect(renderedHtml).toContain("Yeni Başlık");

    expect(state.versionCreates).toHaveLength(1);
    expect(state.versionCreates[0]?.origin).toBe("manual_edit");
    expect(state.versionUpdates).toEqual([
      {
        contentId: "cnt_1",
        version: 2,
        input: { renderedAssetIds: ["asset_gen_1"], layouts: [null] },
      },
    ]);
    expect(state.contentTransitions).toEqual([{ id: "cnt_1", to: "in_review" }]);
    expect(state.contents.get("cnt_1")?.status).toBe("in_review");
  });

  it("clamps oversized Instagram slides (>1440px wide) to 1440px sRGB JPEG and exports LinkedIn PDF when format=both", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedContentWithSlides(
      state,
      [
        { html: typographicHtml, width: 1800, height: 2250 },
        { html: typographicHtml, width: 1800, height: 2250 },
      ],
      "carousel",
      ["instagram", "linkedin"],
    );

    const handler = createContentRenderHandler(makeDeps(api, fakeRenderer()));
    const payload = { format: "both" as const };
    const out = await handler.run(payload, renderJobCtx("cnt_1", payload));

    expect(out).toMatchObject({
      contentId: "cnt_1",
      version: 1,
      renderedAssetIds: ["asset_gen_1", "asset_gen_2"],
      pdfAssetId: "asset_gen_3",
    });

    const firstJpeg = state.assets.get("asset_gen_1")?.bytes;
    const meta = await sharp(firstJpeg).metadata();
    expect(meta.width).toBe(1440);
    expect(meta.height).toBe(1800);

    const pdfBytes = state.assets.get("asset_gen_3")?.bytes ?? new Uint8Array();
    const pdfHeader = new TextDecoder().decode(pdfBytes.subarray(0, 8));
    expect(pdfHeader.startsWith("%PDF-")).toBe(true);
    expect(state.uploads[2]).toMatchObject({ kind: "document", source: "generated" });
  });

  it("delegates reel content / format=mp4 to the Reels video engine", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const brandCtx = buildBrandContext({
      brand: fakeBrand(),
      profile: null,
      api,
      cacheDir: tmpdir(),
    });
    const reelSlide = buildReelVersionSlideHtml({
      brand: brandCtx,
      hook: "Kanca",
      cta: "MTM Agro",
      videoAssetId: "old_vid",
      coverAssetId: "old_cov",
      recipe: "motion_graphics",
      durationMs: 2000,
      compositionHtml:
        "<!doctype html><html><body><script>window.__seek = () => {};</script></body></html>",
    });
    seedContentWithSlides(state, [{ html: reelSlide, width: 1080, height: 1920 }], "reel");

    const coverPng = await samplePng(1080, 1920);
    const handler = createContentRenderHandler(
      makeDeps(api, fakeRenderer(), {
        reelSeams: {
          frameCapturer: async () => ({ frames: [coverPng], coverPng }),
          ffmpeg: async () => ({ stdout: new TextEncoder().encode("MP4"), stderr: "" }),
        },
      }),
    );

    const out = await handler.run({ format: "mp4" }, renderJobCtx("cnt_1", { format: "mp4" }));
    expect(out).toMatchObject({
      contentId: "cnt_1",
      version: 2,
      videoAssetId: "asset_gen_1",
      coverAssetId: "asset_gen_2",
      renderedAssetIds: ["asset_gen_2"],
    });
  });

  it("accepts the apps' older patch spellings", () => {
    expect(normalizePatchOp({ op: "set_text", layer: "a", text: "x" })).toEqual({
      op: "setText",
      layer: "a",
      text: "x",
    });
    expect(normalizePatchOp({ op: "set_visible", layer: "a", visible: false })).toEqual({
      op: "setVisibility",
      layer: "a",
      hidden: true,
    });
    expect(normalizePatchOp({ op: "setVisibility", layer: "a", visible: true })).toEqual({
      op: "setVisibility",
      layer: "a",
      hidden: false,
    });
    expect(normalizePatchOp({ op: "transform", layer: "a", translate: { x: 1, y: 2 } })).toEqual({
      op: "transform",
      layer: "a",
      translate: { x: 1, y: 2 },
    });
  });

  it("re-renders only the edited slide of a carousel and keeps the others' renders and layouts", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const keptLayout: SlideLayout = [
      {
        id: "headline",
        type: "text",
        role: null,
        parent: null,
        x: 1,
        y: 2,
        w: 3,
        h: 4,
        visible: true,
      },
    ];
    seedVersion(state, [
      { html: typographicHtml, renderedAssetId: "asset_old_1", layers: keptLayout },
      { html: slotSlideHtml, renderedAssetId: "asset_old_2", layers: keptLayout },
    ]);
    const rendered: string[] = [];
    const handler = createContentRenderHandler(makeDeps(api, measuringRenderer(rendered)));
    const payload = {
      format: "jpeg" as const,
      version: 1,
      patches: [
        { slide: 1, op: "set_text", layer: "headline", text: "Sadece ikinci" },
        { slide: 1, op: "transform", layer: "headline", translate: { x: 12, y: -8 }, scale: 1.1 },
      ],
    };
    const out = await handler.run(payload, renderJobCtx("cnt_1", payload));
    expect(out).toMatchObject({ version: 2, renderedSlides: [1] });
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("Sadece ikinci");
    expect(rendered[0]).toMatch(/translate:\s*12px -8px/);

    const v2 = state.versions.find((v) => v.version === 2) as ContentVersion;
    expect(v2.slides[0]?.renderedAssetId).toBe("asset_old_1");
    expect(v2.slides[0]?.layers).toEqual(keptLayout);
    expect(v2.slides[1]?.renderedAssetId).toBe("asset_gen_1");
    expect(v2.slides[1]?.layers?.map((l) => l.id)).toContain("headline");
    expect(v2.slides[0]?.html).toBe(typographicHtml);
    expect(state.versionCreates[0]).toMatchObject({
      origin: "manual_edit",
      renderedAssetIds: ["asset_old_1", null],
    });
  });

  it("returns the base version unchanged when the edits change nothing", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedVersion(
      state,
      [{ html: typographicHtml, renderedAssetId: "asset_old_1", layers: [] }],
      "post",
    );
    const handler = createContentRenderHandler(makeDeps(api, measuringRenderer()));
    const visible = {
      format: "jpeg" as const,
      patches: [{ slide: 0, op: "setVisibility", layer: "headline", hidden: false }],
    };
    const out = await handler.run(visible, renderJobCtx("cnt_1", visible));
    expect(out).toMatchObject({ version: 1, unchanged: true, renderedSlides: [] });
    expect(state.versionCreates).toHaveLength(0);
  });

  it("measures layer boxes for a version that has renders but no layout", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedVersion(
      state,
      [{ html: typographicHtml, renderedAssetId: "asset_old_1", layers: null }],
      "post",
    );
    const handler = createContentRenderHandler(makeDeps(api, measuringRenderer()));
    const out = await handler.run({ format: "jpeg" }, renderJobCtx("cnt_1", { format: "jpeg" }));
    expect(out).toMatchObject({
      version: 1,
      renderedSlides: [0],
      renderedAssetIds: ["asset_gen_1"],
    });
    expect(state.versionCreates).toHaveLength(0);
    expect(state.versionUpdates[0]?.input.layouts?.[0]?.length).toBeGreaterThan(0);

    // A second plain render is a no-op: everything is rendered and measured.
    const again = await handler.run({ format: "jpeg" }, renderJobCtx("cnt_1", { format: "jpeg" }));
    expect(again).toMatchObject({ renderedSlides: [] });
    expect(state.uploads).toHaveLength(1);
  });

  it("exports lossless PNGs for the requested slides without changing the version", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedVersion(state, [
      { html: typographicHtml, renderedAssetId: "asset_old_1", layers: [] },
      { html: typographicHtml, renderedAssetId: "asset_old_2", layers: [] },
    ]);
    const handler = createContentRenderHandler(makeDeps(api, measuringRenderer()));
    const payload = { format: "png" as const, slides: [1] };
    const out = await handler.run(payload, renderJobCtx("cnt_1", payload));
    expect(out).toMatchObject({
      version: 1,
      pngAssetIds: [null, "asset_gen_1"],
      renderedSlides: [],
    });
    expect(state.assets.get("asset_gen_1")?.contentType).toBe("image/png");
    expect(state.versionUpdates).toHaveLength(0);
    expect(state.versionCreates).toHaveLength(0);
  });

  it("strips empty-slot placeholder attributes on raw fallback slot tags", () => {
    const raw =
      '<!doctype html><html><body><main data-artboard><div data-slot="hero" data-slot-empty="true" class="card empty-slot"></div></main></body></html>';
    const res = applySlotAssignmentToSlide(raw, "hero", "asset_99", {
      assetPrefixes: ["/brand/", "/media/", "/api/assets/"],
    });
    expect(res.matched).toBe(true);
    expect(res.html).not.toContain("data-slot-empty");
    expect(res.html).toContain('data-slot-state="filled"');
    expect(res.html).toContain('src="/media/asset_99.jpg"');
  });
});

const chromiumAvailable = await isChromiumAvailable();

describe.skipIf(!chromiumAvailable || process.env.STUDIO_SKIP_RENDER === "1")(
  "content.render LinkedIn multi-page Chromium PDF",
  () => {
    const renderer = createRenderer({ timeoutMs: 30_000 });
    afterAll(() => renderer.close());

    it("stores the measured layer boxes of a real Chromium render", async () => {
      const { api, state } = createFakeApi({ brands: [fakeBrand()] });
      seedContentWithSlides(state, [{ html: typographicHtml, width: 1080, height: 1350 }]);
      const handler = createContentRenderHandler(makeDeps(api, renderer));
      const out = await handler.run({ format: "jpeg" }, renderJobCtx("cnt_1", { format: "jpeg" }));
      expect(out.renderedSlides).toEqual([0]);
      const layout = state.versions[0]?.slides[0]?.layers ?? [];
      expect(layout.length).toBeGreaterThan(2);
      for (const box of layout) {
        expect(box.w).toBeGreaterThanOrEqual(0);
        expect(box.x).toBeGreaterThan(-1080);
      }
      expect(layoutFromReport(null)).toBeNull();
    });

    it("generates a real multi-page vector PDF via Chromium page.pdf in one pass", async () => {
      const { api, state } = createFakeApi({ brands: [fakeBrand()] });
      seedContentWithSlides(
        state,
        [
          { html: typographicHtml, width: 1080, height: 1350 },
          { html: typographicHtml, width: 1080, height: 1350 },
        ],
        "carousel",
        ["linkedin"],
      );

      const handler = createContentRenderHandler(makeDeps(api, renderer));
      const out = await handler.run({ format: "pdf" }, renderJobCtx("cnt_1", { format: "pdf" }));

      expect(out.pdfAssetId).toBeDefined();
      const pdfBytes = state.assets.get(out.pdfAssetId as string)?.bytes ?? new Uint8Array();
      const text = new TextDecoder("latin1").decode(pdfBytes);
      expect(text.startsWith("%PDF-1.")).toBe(true);
      const pageCountMatches = text.match(/\/Type\s*\/Page\b/g) ?? [];
      expect(pageCountMatches.length).toBe(2);
    });
  },
);
