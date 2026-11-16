import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Content, ContentVersion, Job } from "@studio/contract";
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
  type RenderCapable,
} from "../src/render/handler.ts";
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

describe("content.render handler", () => {
  it("fills image slots to /api/assets/{id}/content, applies layer patches, creates a new version, renders sRGB JPEG, and moves draft -> in_review", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedContentWithSlides(state, [{ html: slotSlideHtml, width: 1080, height: 1350 }]);
    const userPhoto = await samplePng(1200, 900, "#2255AA");
    state.assets.set("asset_user_photo", { bytes: userPhoto, contentType: "image/png" });

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
    expect(renderedHtml).toContain('src="/api/assets/asset_user_photo/content"');
    expect(renderedHtml).toContain("Yeni Başlık");

    expect(state.versionCreates).toHaveLength(1);
    expect(state.versionCreates[0]?.origin).toBe("manual_edit");
    expect(state.versionUpdates).toEqual([
      { contentId: "cnt_1", version: 2, input: { renderedAssetIds: ["asset_gen_1"] } },
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

  it("strips empty-slot placeholder attributes on raw fallback slot tags", () => {
    const raw =
      '<!doctype html><html><body><main data-artboard><div data-slot="hero" data-slot-empty="true" class="card empty-slot"></div></main></body></html>';
    const res = applySlotAssignmentToSlide(raw, "hero", "asset_99", {
      assetPrefixes: ["/brand/", "/media/", "/api/assets/"],
    });
    expect(res.matched).toBe(true);
    expect(res.html).not.toContain("data-slot-empty");
    expect(res.html).toContain('data-slot-state="filled"');
    expect(res.html).toContain('src="/api/assets/asset_99/content"');
  });
});

const chromiumAvailable = await isChromiumAvailable();

describe.skipIf(!chromiumAvailable || process.env.STUDIO_SKIP_RENDER === "1")(
  "content.render LinkedIn multi-page Chromium PDF",
  () => {
    const renderer = createRenderer({ timeoutMs: 30_000 });
    afterAll(() => renderer.close());

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
