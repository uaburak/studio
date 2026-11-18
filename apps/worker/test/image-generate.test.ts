import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, type Content, type ContentVersion, type Job } from "@studio/contract";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import {
  compositeProductOntoScene,
  createImageGenerateHandler,
  extractProductCutout,
  type ImageGenerateDeps,
} from "../src/image/handler.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import type { RenderCapable } from "../src/render/handler.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const KIT_FIXTURES = fileURLToPath(
  new URL("../../../packages/design-kit/test/fixtures/", import.meta.url),
);
const slotSlideHtml = readFileSync(path.join(KIT_FIXTURES, "slides/image-slot.html"), "utf8");

function imageJobCtx(payload: Record<string, unknown>): JobContext {
  const job: Job = {
    id: "job_img_1",
    type: "image.generate",
    status: "running",
    brandId: "brand_1",
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

/**
 * Create a synthetic 400x400 white studio packshot with a crisp dark-green product box
 * in the center (`x: 100..299, y: 80..319`) and a bright `#FF2200` "label" stripe inside it.
 */
async function createPackshotFixture(): Promise<Uint8Array> {
  const w = 400;
  const h = 400;
  const raw = Buffer.alloc(w * h * 4, 255); // #FFFFFF studio backdrop
  for (let y = 80; y < 320; y++) {
    for (let x = 100; x < 300; x++) {
      const idx = (y * w + x) * 4;
      const isLabelStripe = y >= 170 && y < 210 && x >= 130 && x < 270;
      raw[idx] = isLabelStripe ? 255 : 22;
      raw[idx + 1] = isLabelStripe ? 34 : 78;
      raw[idx + 2] = isLabelStripe ? 0 : 38;
      raw[idx + 3] = 255;
    }
  }
  const buf = await sharp(raw, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function createScenePng(width = 1080, height = 1350): Promise<Uint8Array> {
  const buf = await sharp({
    create: { width, height, channels: 3, background: "#8BB59E" },
  })
    .png()
    .toBuffer();
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

const dummyRenderer: RenderCapable = {
  async render(req) {
    const png = await createScenePng(req.width, req.height);
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
    throw new Error("unused");
  },
};

function makeDeps(
  api: ImageGenerateDeps["api"],
  env: Record<string, string>,
  imageFetch?: typeof fetch,
): ImageGenerateDeps {
  return {
    api,
    gate: new ClaudeGate({
      runner: async () => {
        throw new Error("unused");
      },
    }),
    settings: loadAgentSettings(env),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-img-")),
    renderer: () => dummyRenderer,
    ...(imageFetch ? { imageFetch } : {}),
  };
}

describe("image.generate handler & product label preservation", () => {
  it("fails with a clear Turkish message when GEMINI_API_KEY is missing", async () => {
    const { api } = createFakeApi({ brands: [fakeBrand()] });
    const handler = createImageGenerateHandler(makeDeps(api, {}));
    const payload = {
      prompt: "Sabah güneşinde tarla sahnesi",
      aspectRatio: "4:5" as const,
      imageSize: "2K" as const,
      referenceAssetIds: [],
      preserveProductLabel: false,
    };
    await expect(handler.run(payload, imageJobCtx(payload))).rejects.toThrow(/GEMINI_API_KEY/);
  });

  it("extracts studio packshot cutout removing white margins while keeping interior label pixels intact", async () => {
    const packshot = await createPackshotFixture();
    const cutout = await extractProductCutout(packshot);
    expect(cutout.width).toBe(200);
    expect(cutout.height).toBe(240);

    const scene = await createScenePng(1080, 1350);
    const composited = await compositeProductOntoScene(scene, packshot);
    expect(composited.width).toBe(1080);
    expect(composited.height).toBe(1350);

    // Sample center pixel where the crisp #FF2200 label stripe lands -> red channel stays crisp!
    const raw = await sharp(composited.bytes).raw().toBuffer({ resolveWithObject: true });
    let foundCrispLabelPixels = 0;
    for (let i = 0; i < raw.data.length; i += raw.info.channels) {
      if (
        (raw.data[i] ?? 0) > 235 &&
        (raw.data[i + 1] ?? 255) < 55 &&
        (raw.data[i + 2] ?? 255) < 25
      ) {
        foundCrispLabelPixels++;
      }
    }
    expect(foundCrispLabelPixels).toBeGreaterThan(500);
  });

  it("calls Gemini image model with inlineData references, composites crisp product label, and auto-fills targetContentId + targetSlotId", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const packshot = await createPackshotFixture();
    state.assets.set("asset_ref_pack", { bytes: packshot, contentType: "image/png" });

    // Seed draft content with empty `field-photo` slot
    const v1: ContentVersion = {
      id: "ver_1",
      contentId: "cnt_target",
      version: 1,
      origin: "generated",
      contentHash: "a".repeat(64),
      slideCount: 1,
      note: null,
      jobId: null,
      createdAt: NOW,
      updatedAt: NOW,
      slides: [{ html: slotSlideHtml, width: 1080, height: 1350, renderedAssetId: null }],
    };
    state.versions.push(v1);
    const targetContent: Content = {
      id: "cnt_target",
      brandId: "brand_1",
      type: "post",
      title: "Ürün Sahnesi",
      brief: "Ürün tanıtımı",
      status: "draft",
      targetPlatforms: ["instagram"],
      caption: "",
      currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) },
      approval: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    state.contents.set("cnt_target", targetContent);

    const seenRequests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
    const scenePng = await createScenePng(1080, 1350);

    const fakeFetch: typeof fetch = async (input, init) => {
      seenRequests.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "image/png",
                      data: Buffer.from(scenePng).toString("base64"),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const handler = createImageGenerateHandler(
      makeDeps(api, { GEMINI_API_KEY: "secret-img-key" }, fakeFetch),
    );
    const payload = {
      prompt: "Sabah ışığında sürülü tarla",
      aspectRatio: "4:5" as const,
      imageSize: "2K" as const,
      referenceAssetIds: ["asset_ref_pack"],
      preserveProductLabel: true,
      targetContentId: "cnt_target",
      targetSlotId: "field-photo",
    };

    const out = await handler.run(payload, imageJobCtx(payload));

    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent",
    );
    expect(seenRequests[0]?.headers.get("x-goog-api-key")).toBe("secret-img-key");
    expect(seenRequests[0]?.body.generationConfig).toEqual({
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "4:5", imageSize: "2K" },
    });
    const reqContents = (seenRequests[0]?.body.contents ?? []) as {
      parts: { text?: string; inlineData?: unknown }[];
    }[];
    const reqParts = reqContents[0]?.parts;
    expect(reqParts).toHaveLength(2);
    expect(reqParts?.[0]?.text).toContain("Do NOT draw any product pouch");
    expect(reqParts?.[1]?.inlineData).toBeDefined();

    expect(out).toMatchObject({
      assetId: "asset_gen_1",
      mimeType: "image/png",
      width: 1080,
      height: 1350,
      model: "gemini-nano-banana-2.1",
      preserveProductLabel: true,
      filledContentId: "cnt_target",
      filledVersion: 2,
    });
    expect(state.contents.get("cnt_target")?.status).toBe("in_review");
    expect(state.versions.at(-1)?.slides[0]?.html).toMatch(
      /src="\/media\/asset_gen_1\.(png|jpg|webp)"/,
    );
  });
});

describe("image.generate retries (U7, U4)", () => {
  const sceneResponse = async () =>
    new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from(await createScenePng(400, 500)).toString("base64"),
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1290 },
      }),
      { status: 200 },
    );
  const payload = {
    prompt: "Sabah güneşinde tarla",
    aspectRatio: "4:5" as const,
    imageSize: "1K" as const,
    referenceAssetIds: [],
    preserveProductLabel: false,
  };

  it("a retried job reuses the picture it paid for instead of calling Gemini again", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    let geminiCalls = 0;
    const deps = makeDeps(api, { GEMINI_API_KEY: "secret-img-key" }, async () => {
      geminiCalls++;
      return sceneResponse();
    });
    // The first upload fails (API down): the job is retried.
    const upload = api.client.assets.upload;
    let uploads = 0;
    api.client.assets.upload = (async (...args: Parameters<typeof upload>) => {
      uploads++;
      if (uploads === 1) throw new ApiError("service unavailable", 503, "internal_error");
      return upload(...args);
    }) as typeof upload;
    const handler = createImageGenerateHandler(deps);
    await expect(handler.run(payload, imageJobCtx(payload))).rejects.toMatchObject({
      name: "RetryableError",
    });
    const out = await handler.run(payload, imageJobCtx(payload));
    expect(geminiCalls).toBe(1);
    expect(out).toMatchObject({ assetId: "asset_gen_1", reusedGeneration: true });
    expect(state.uploads).toHaveLength(1);
    // Done: the kept picture is gone.
    const third = await handler.run(payload, imageJobCtx(payload));
    expect(geminiCalls).toBe(2);
    expect(third).not.toHaveProperty("reusedGeneration");
  });

  it("waits out a 429 and asks again instead of failing", async () => {
    const { api } = createFakeApi({ brands: [fakeBrand()] });
    const responses: (() => Promise<Response>)[] = [
      async () =>
        new Response(JSON.stringify({ error: { code: 429, message: "quota" } }), {
          status: 429,
          headers: { "retry-after": "2" },
        }),
      sceneResponse,
    ];
    const sleeps: number[] = [];
    const deps: ImageGenerateDeps = {
      ...makeDeps(api, { GEMINI_API_KEY: "secret-img-key" }, async () =>
        (responses.shift() as () => Promise<Response>)(),
      ),
      imageSleep: async (ms) => void sleeps.push(ms),
    };
    const out = await createImageGenerateHandler(deps).run(payload, imageJobCtx(payload));
    expect(out).toMatchObject({ assetId: "asset_gen_1" });
    expect(sleeps).toEqual([2_250]);
  });
});
