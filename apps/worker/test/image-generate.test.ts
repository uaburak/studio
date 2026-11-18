import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, type Content, type ContentVersion, type Job } from "@studio/contract";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { compositeProduct, extractProductCutout } from "../src/image/compose.ts";
import { createImageGenerateHandler, type ImageGenerateDeps } from "../src/image/handler.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import type { RenderCapable } from "../src/render/handler.ts";
import type { VisionHelper } from "../src/vision/helper.ts";
import { createFakeApi, type FakeApiState, fakeBrand, NOW } from "./fake-api.ts";
import { fakeVision, line } from "./fake-vision.ts";

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
 * A synthetic 400x400 white studio packshot with a crisp dark-green product box in the center
 * (`x: 100..299, y: 80..319`) and a bright `#FF2200` "label" stripe inside it.
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

/** A product on a busy, non-uniform "lifestyle" backdrop (seeded noise): no flat corners. */
async function createLifestyleFixture(): Promise<Uint8Array> {
  const w = 400;
  const h = 500;
  const raw = Buffer.alloc(w * h * 3);
  let seed = 1234;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < w * h; i++) {
    raw[i * 3] = 90 + Math.floor(rnd() * 120);
    raw[i * 3 + 1] = 60 + Math.floor(rnd() * 100);
    raw[i * 3 + 2] = 30 + Math.floor(rnd() * 80);
  }
  // The product: x 100..300, y 100..400 (box 0.25,0.2,0.5,0.6), label stripe inside.
  for (let y = 100; y < 400; y++) {
    for (let x = 100; x < 300; x++) {
      const i = (y * w + x) * 3;
      const label = y >= 200 && y < 300 && x >= 120 && x < 280;
      raw[i] = label ? 250 : 20;
      raw[i + 1] = label ? 250 : 90;
      raw[i + 2] = label ? 245 : 40;
    }
  }
  const buf = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
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
  vision?: VisionHelper,
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
    ...(vision ? { vision } : {}),
  };
}

/** Gemini answering with one scene picture; records the requests. */
function geminiScene(scene: Uint8Array) {
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    seen.push({
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
                    data: Buffer.from(scene).toString("base64"),
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
  return { seen, fetchFn };
}

function promptOf(seen: { body: Record<string, unknown> }[]): string {
  const contents = (seen[0]?.body.contents ?? []) as { parts: { text?: string }[] }[];
  return contents[0]?.parts[0]?.text ?? "";
}

/** A draft post with an empty `field-photo` slot. */
function seedTargetPost(state: FakeApiState) {
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
}

/** OCR lines of the label as Vision would read them on the lifestyle fixture's reference. */
const REFERENCE_LABEL = [
  line("VENTA BORİNÇ", { x: 0.32, y: 0.42, width: 0.36, height: 0.05 }),
  line("GÜBRE 25 KG", { x: 0.34, y: 0.5, width: 0.32, height: 0.05 }),
  // Fine print on the product and a sign in the background (not part of the label).
  line("Üretim tarihi ambalajdadır", { x: 0.35, y: 0.7, width: 0.3, height: 0.008 }, 0.4),
  line("KAFE", { x: 0.02, y: 0.02, width: 0.1, height: 0.04 }),
];

describe("label-preserving composites: cutout and compositing", () => {
  it("cuts a plain-backdrop packshot out and keeps the label pixels exactly", async () => {
    const packshot = await createPackshotFixture();
    const cutout = await extractProductCutout(packshot);
    expect(cutout.width).toBe(200);
    expect(cutout.height).toBe(240);
    expect(cutout.removedBackground).toBe(true);

    const scene = await createScenePng(1080, 1350);
    const rect = { left: 340, top: 400, width: 400, height: 480 };
    const composited = await compositeProduct(scene, cutout, rect, { matchLight: false });
    expect(composited.width).toBe(1080);
    expect(composited.height).toBe(1350);

    const raw = await sharp(composited.bytes).raw().toBuffer({ resolveWithObject: true });
    let crisp = 0;
    for (let i = 0; i < raw.data.length; i += raw.info.channels) {
      if (
        (raw.data[i] ?? 0) > 235 &&
        (raw.data[i + 1] ?? 255) < 55 &&
        (raw.data[i + 2] ?? 255) < 25
      ) {
        crisp++;
      }
    }
    expect(crisp).toBeGreaterThan(500);
    // A shadow darkens the scene just under the product.
    const under = await sharp(composited.bytes)
      .extract({ left: 520, top: rect.top + rect.height + 4, width: 40, height: 6 })
      .stats();
    expect(under.channels[1]?.mean ?? 255).toBeLessThan(0xb5 - 5);
  });

  it("keeps a lifestyle photo whole when there is no plain backdrop and no Vision", async () => {
    const cutout = await extractProductCutout(await createLifestyleFixture());
    expect(cutout.removedBackground).toBe(false);
    expect([cutout.width, cutout.height]).toEqual([400, 500]);
  });

  it("matches light only gently", async () => {
    const scene = await sharp({
      create: { width: 600, height: 600, channels: 3, background: "#202838" },
    })
      .png()
      .toBuffer();
    const cutout = await extractProductCutout(await createPackshotFixture());
    const out = await compositeProduct(new Uint8Array(scene), cutout, {
      left: 200,
      top: 150,
      width: 200,
      height: 240,
    });
    expect(out.light.brightness).toBeGreaterThanOrEqual(0.9);
    expect(out.light.brightness).toBeLessThan(1);
    for (const g of [out.light.red, out.light.green, out.light.blue]) {
      expect(g).toBeGreaterThanOrEqual(0.95);
      expect(g).toBeLessThanOrEqual(1.05);
    }
  });
});

describe("image.generate handler & product label preservation (U9)", () => {
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

  it("without the Vision helper: flat-backdrop cutout, fills the slot and says the label was not verified", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.assets.set("asset_ref_pack", {
      bytes: await createPackshotFixture(),
      contentType: "image/png",
    });
    seedTargetPost(state);
    const gemini = geminiScene(await createScenePng(1080, 1350));
    const handler = createImageGenerateHandler(
      makeDeps(api, { GEMINI_API_KEY: "secret-img-key" }, gemini.fetchFn),
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

    expect(gemini.seen).toHaveLength(1);
    expect(gemini.seen[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent",
    );
    expect(gemini.seen[0]?.headers.get("x-goog-api-key")).toBe("secret-img-key");
    expect(gemini.seen[0]?.body.generationConfig).toEqual({
      responseModalities: ["IMAGE"],
      imageConfig: { aspectRatio: "4:5", imageSize: "2K" },
    });
    const reqParts = (
      (gemini.seen[0]?.body.contents ?? []) as {
        parts: { text?: string; inlineData?: unknown }[];
      }[]
    )[0]?.parts;
    expect(reqParts).toHaveLength(2);
    expect(reqParts?.[0]?.text).toContain("Do NOT draw any product pouch");
    expect(reqParts?.[0]?.text).toContain("lower center of the frame");
    expect(reqParts?.[1]?.inlineData).toBeDefined();

    expect(out).toMatchObject({
      assetId: "asset_gen_1",
      mimeType: "image/png",
      width: 1080,
      height: 1350,
      model: "gemini-nano-banana-2.1",
      preserveProductLabel: true,
      cutout: "flat_background",
      labelCheck: { status: "skipped" },
      placement: { position: "bottom-center", auto: true },
      filledContentId: "cnt_target",
      filledVersion: 2,
    });
    expect(String((out.labelCheck as { message: string }).message)).toMatch(/doğrulanamadı/);
    expect((out.notes as string[]).join(" ")).toMatch(/studio-vision/);
    expect(state.contents.get("cnt_target")?.status).toBe("in_review");
    expect(state.versions.at(-1)?.slides[0]?.html).toMatch(
      /src="\/media\/asset_gen_1\.(png|jpg|webp)"/,
    );
    // The new picture is tagged for the library too (colours and shape without Vision).
    expect(state.analyses.get("asset_gen_1")).toMatchObject({ status: "partial" });
  });

  it("with Vision: cuts the product off a busy photo, places it by saliency, verifies the label and fills the slot", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.assets.set("asset_ref", {
      bytes: await createLifestyleFixture(),
      contentType: "image/png",
    });
    seedTargetPost(state);
    const vision = fakeVision({
      productBox: { x: 0.25, y: 0.2, width: 0.5, height: 0.6 },
      ocr: {
        reference: REFERENCE_LABEL,
        // The final picture reads the same label (OCR noise: a lost cedilla, a glued unit).
        "final-product": [
          line("VENTA BORINÇ", { x: 0.2, y: 0.4, width: 0.6, height: 0.08 }),
          line("GÜBRE 25KG", { x: 0.2, y: 0.5, width: 0.6, height: 0.08 }),
        ],
        scene: [line("SALE", { x: 0.05, y: 0.05, width: 0.1, height: 0.05 })],
      },
      // Top half busy, bottom half empty.
      saliency: { objects: [], columns: 2, rows: 2, grid: [1, 1, 0.05, 0.05] },
      analyze: {
        classify: { labels: [{ identifier: "agriculture", confidence: 0.7 }] },
        errors: {},
      },
    });
    const gemini = geminiScene(await createScenePng(1080, 1350));
    const handler = createImageGenerateHandler(
      makeDeps(api, { GEMINI_API_KEY: "secret-img-key" }, gemini.fetchFn, vision),
    );
    const payload = {
      prompt: "Hasat sonrası tarla, sabah ışığı",
      aspectRatio: "4:5" as const,
      imageSize: "2K" as const,
      referenceAssetIds: ["asset_ref"],
      preserveProductLabel: true,
      targetContentId: "cnt_target",
      targetSlotId: "field-photo",
    };
    const out = await handler.run(payload, imageJobCtx(payload));

    // Label read first and handed to the model verbatim (context only).
    const prompt = promptOf(gemini.seen);
    expect(prompt).toContain('"VENTA BORİNÇ" / "GÜBRE 25 KG"');
    expect(prompt).not.toContain("KAFE");
    expect(out).toMatchObject({
      cutout: "vision",
      labelCheck: {
        status: "ok",
        source: "ocr",
        expected: ["VENTA BORİNÇ", "GÜBRE 25 KG"],
        missing: [],
      },
      placement: { position: "bottom-center", auto: true, scale: 0.62 },
      filledContentId: "cnt_target",
    });
    expect((out.notes as string[]).join(" ")).toContain("SALE");
    const commands = vision.calls.map((c) => c.command);
    expect(commands).toContain("foreground-mask");
    expect(commands).toContain("saliency");
    expect(commands.filter((c) => c === "ocr").length).toBeGreaterThanOrEqual(3);
    // Tagged with Turkish labels.
    expect(state.analyses.get("asset_gen_1")?.tags?.[0]).toMatchObject({ label: "tarım" });
  });

  it("does not put a picture with a changed label into the post, and says why", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.assets.set("asset_ref", {
      bytes: await createLifestyleFixture(),
      contentType: "image/png",
    });
    seedTargetPost(state);
    const vision = fakeVision({
      ocr: {
        reference: REFERENCE_LABEL,
        "final-product": [
          line("VENTA BORİNÇ", { x: 0.2, y: 0.4, width: 0.6, height: 0.08 }),
          line("GÜBRE 50 KG", { x: 0.2, y: 0.5, width: 0.6, height: 0.08 }),
        ],
      },
    });
    const gemini = geminiScene(await createScenePng(1080, 1350));
    const handler = createImageGenerateHandler(
      makeDeps(api, { GEMINI_API_KEY: "k-123456" }, gemini.fetchFn, vision),
    );
    const payload = {
      prompt: "Depo rafı",
      aspectRatio: "4:5" as const,
      imageSize: "1K" as const,
      referenceAssetIds: ["asset_ref"],
      preserveProductLabel: true,
      productPosition: "bottom-left" as const,
      productScale: 0.4,
      targetContentId: "cnt_target",
      targetSlotId: "field-photo",
    };
    const out = await handler.run(payload, imageJobCtx(payload));
    expect(out).toMatchObject({
      labelCheck: { status: "mismatch", missing: ["GÜBRE 25 KG"] },
      placement: { position: "bottom-left", auto: false, scale: 0.4, height: 540 },
      slotSkipped: true,
    });
    expect(out).not.toHaveProperty("filledContentId");
    expect((out.labelCheck as { message: string }).message).toContain("GÜBRE 25 KG");
    expect((out.notes as string[]).join(" ")).toContain("posta yerleştirilmedi");
    expect(state.versions).toHaveLength(1);
    // A requested spot needs no saliency; the prompt asks for that spot.
    expect(vision.calls.map((c) => c.command)).not.toContain("saliency");
    expect(promptOf(gemini.seen)).toContain("lower left third");
  });

  it("checks against the owner's own label text when given", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.assets.set("asset_ref", {
      bytes: await createLifestyleFixture(),
      contentType: "image/png",
    });
    const vision = fakeVision({
      ocr: { "final-product": [line("VENTA BORİNÇ", { x: 0, y: 0, width: 1, height: 0.1 })] },
    });
    const gemini = geminiScene(await createScenePng(800, 1000));
    const handler = createImageGenerateHandler(
      makeDeps(api, { GEMINI_API_KEY: "k-123456" }, gemini.fetchFn, vision),
    );
    const payload = {
      prompt: "Mutfak tezgâhı",
      aspectRatio: "4:5" as const,
      imageSize: "1K" as const,
      referenceAssetIds: ["asset_ref"],
      preserveProductLabel: true,
      labelText: "VENTA BORİNÇ\nNet 25 kg",
    };
    const out = await handler.run(payload, imageJobCtx(payload));
    expect(out).toMatchObject({
      labelCheck: { status: "mismatch", source: "owner", missing: ["Net 25 kg"] },
    });
    // The reference was not OCR'd: the owner's text is the truth.
    expect(
      vision.calls
        .filter((c) => path.basename(c.file).startsWith("reference"))
        .map((c) => c.command),
    ).toEqual(["foreground-mask"]);
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
