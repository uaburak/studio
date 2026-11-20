import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Asset,
  type BrandProduct,
  type Content,
  ContentGeneratePayload,
  ImageGeneratePayload,
  type Job,
} from "@studio/contract";
import type { LintReport } from "@studio/design-kit/lint";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { StudioToolExecutor } from "../src/chat/tools.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeCallResult, ClaudeRunner } from "../src/claude/runner.ts";
import { type ContentGenerateDeps, createContentGenerateHandler } from "../src/generate/handler.ts";
import type { SlideRenderer } from "../src/generate/pipeline.ts";
import {
  aspectRatioForSlot,
  emptyImageSlots,
  slotImagePrompt,
} from "../src/generate/slot-images.ts";
import { buildApprovalCreate } from "../src/image/approval.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, type FakeApiState, fakeBrand, NOW } from "./fake-api.ts";

/*
 * The HTML design's "AI görsel" slot through the product-image line (docs/URETIM-RESIM.md):
 * consent in the chat, one `image.generate` job per post after its design version, approval
 * placement. The design and the picture models are fakes: nothing here calls a paid API.
 */

const KIT_FIXTURES = fileURLToPath(
  new URL("../../../packages/design-kit/test/fixtures/", import.meta.url),
);
const slotHtml = readFileSync(path.join(KIT_FIXTURES, "slides/image-slot.html"), "utf8");
const filledHtml = readFileSync(path.join(KIT_FIXTURES, "slides/image-slot.filled.html"), "utf8");
const typographic = readFileSync(path.join(KIT_FIXTURES, "slides/typographic.html"), "utf8");

function product(overrides: Partial<BrandProduct> = {}): BrandProduct {
  return {
    id: "prod_boro",
    brandId: "brand_1",
    name: "Boro",
    slug: "boro",
    description: "Sıvı bor gübresi",
    category: "Gübre",
    tags: [],
    notes: "",
    imageAssetIds: ["asset_front", "asset_left", "asset_back"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function assetRecord(id: string, filename: string): Asset {
  return {
    id,
    brandId: "brand_1",
    kind: "image",
    source: "upload",
    objectKey: `brands/brand_1/${id}`,
    mimeType: "image/png",
    bytes: 1000,
    sha256: "0".repeat(64),
    width: 1600,
    height: 1600,
    durationMs: null,
    originalFilename: filename,
    createdAt: NOW,
  };
}

function seedProduct(state: FakeApiState) {
  state.products.push(product());
  for (const [id, name] of [
    ["asset_front", "boro-on.png"],
    ["asset_left", "boro-sol.png"],
    ["asset_back", "boro-arka.png"],
  ] as const) {
    state.assetRecords.push(assetRecord(id, name));
  }
}

function content(id: string): Content {
  return {
    id,
    brandId: "brand_1",
    type: "post",
    title: "Boro tanıtım",
    brief: "Boro'yu tarlada tanıt.",
    status: "draft",
    targetPlatforms: ["instagram"],
    caption: "",
    currentVersion: null,
    approval: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function designResult(html: string): ClaudeCallResult {
  return {
    output: {
      slides: [{ id: "slide-1", html }],
      caption: "Boro tarlada. #boro",
      rationale: "Tek fikir.",
      critique: [],
      changes: [],
    },
    text: "",
    model: "claude-opus-5-5",
    cliVersion: "2.1.292",
    usage: {
      inputTokens: 5,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
      durationMs: 10,
      durationApiMs: 10,
      wallMs: 10,
    },
    rateLimit: undefined,
  };
}

function cleanReport(): LintReport {
  return {
    schema: "studio.lint/1",
    kit: "0",
    contract: "v1",
    artboard: { width: 1080, height: 1350 },
    ok: true,
    summary: { errors: 0, warnings: 0, info: 0 },
    stages: { static: true, layout: true, pixel: true, render: true },
    issues: [],
    layers: [],
  } as LintReport;
}

async function jpeg(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toBuffer(),
  );
}

function generateDeps(api: ContentGenerateDeps["api"], html: string): ContentGenerateDeps {
  const runner: ClaudeRunner = async () => designResult(html);
  const renderer: SlideRenderer = {
    async renderAndLint() {
      return {
        jpeg: await jpeg(),
        pixelWidth: 1080,
        pixelHeight: 1350,
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
        report: cleanReport(),
      };
    },
  };
  return {
    api,
    gate: new ClaudeGate({ runner }),
    settings: loadAgentSettings({}),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-slot-")),
    renderer: () => renderer,
    checkModelCaller: null,
  };
}

function jobFor(id: string, contentId: string, payload: Record<string, unknown>): Job {
  return {
    id,
    type: "content.generate",
    status: "running",
    payload,
    brandId: "brand_1",
    contentId,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function ctxFor(job: Job): JobContext {
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

const imageJobs = (state: FakeApiState) => state.jobs.filter((j) => j.type === "image.generate");

describe("slot helpers", () => {
  it("finds the design's empty image slots and the picture's ratio", () => {
    expect(emptyImageSlots([{ html: slotHtml }])).toEqual([
      { slide: 0, slotId: "field-photo", ratio: { w: 4, h: 3 }, label: "Saha fotoğrafı" },
    ]);
    expect(emptyImageSlots([{ html: filledHtml }, { html: typographic }])).toEqual([]);
    expect(aspectRatioForSlot({ w: 4, h: 5 })).toBe("4:5");
    expect(aspectRatioForSlot({ w: 9, h: 16 })).toBe("9:16");
    expect(aspectRatioForSlot({ w: 4, h: 3 })).toBe("1:1");
    expect(aspectRatioForSlot(null)).toBe("4:5");
  });

  it("writes a scene without a product when none is named", () => {
    const prompt = slotImagePrompt({
      request: { consented: true },
      imageBrief: "Gün doğumunda buğday tarlası, illüstrasyon",
      productNames: [],
    });
    expect(prompt).toContain("Gün doğumunda buğday tarlası");
    expect(prompt).toContain("Ürün yok");
    expect(prompt).toContain("görsele yazı, logo ya da metin ekleme");
  });
});

describe("content.generate → slot picture", () => {
  it("queues one image.generate job for the AI slot after the design version, once", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedProduct(state);
    state.contents.set("content_1", content("content_1"));
    const deps = generateDeps(api, slotHtml);
    const handler = createContentGenerateHandler(deps);
    const job = jobFor("job_gen", "content_1", {
      brief: "Boro'yu tarlada tanıt.",
      type: "post",
      imageSlot: "ai_generate",
      imageBrief: "Sola bakan Boro şişesi, gün doğumunda tarlada",
      conversationId: "conv_1",
      productIds: ["prod_boro"],
      slotImage: { consented: true, productIds: ["prod_boro"], view: "sol", style: "retro" },
    });
    const out = await handler.run(job.payload as never, ctxFor(job));

    expect(state.versionCreates).toHaveLength(1);
    const jobs = imageJobs(state);
    expect(jobs).toHaveLength(1);
    const payload = ImageGeneratePayload.parse(jobs[0]?.payload);
    expect(payload).toMatchObject({
      aspectRatio: "1:1",
      imageSize: "2K",
      referenceAssetIds: ["asset_left"],
      preserveProductLabel: false,
      productIds: ["prod_boro"],
      style: "retro",
      approval: {
        kind: "product_image",
        contentId: "content_1",
        slotId: "field-photo",
        conversationId: "conv_1",
        productId: "prod_boro",
      },
    });
    expect(payload.prompt).toContain("Sola bakan Boro şişesi");
    expect(payload.prompt).toContain("Ürün: Boro");
    // The slot is never filled directly: only through the approval.
    expect(payload.targetContentId).toBeUndefined();
    expect(payload.variant).toBeUndefined();
    expect(out).toMatchObject({
      slotImages: { jobs: [{ slotId: "field-photo", jobId: jobs[0]?.id }] },
    });

    // A retried attempt reuses the version and does not pay for the slot again.
    const again = await handler.run(job.payload as never, ctxFor(job));
    expect(again).toMatchObject({
      reused: true,
      slotImages: { jobs: [{ slotId: "field-photo", jobId: jobs[0]?.id }] },
    });
    expect(imageJobs(state)).toHaveLength(1);
  });

  it("queues nothing without the owner's consent", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedProduct(state);
    state.contents.set("content_1", content("content_1"));
    const handler = createContentGenerateHandler(generateDeps(api, slotHtml));
    const job = jobFor("job_gen", "content_1", {
      brief: "Boro'yu tarlada tanıt.",
      imageSlot: "ai_generate",
      conversationId: "conv_1",
      productIds: ["prod_boro"],
    });
    const out = await handler.run(job.payload as never, ctxFor(job));
    expect(state.versionCreates).toHaveLength(1);
    expect(imageJobs(state)).toEqual([]);
    expect(out.slotImages).toBeUndefined();
    // `consented` must be literally true.
    expect(
      ContentGeneratePayload.safeParse({ brief: "x", slotImage: { consented: false } }).success,
    ).toBe(false);
  });

  it("makes a scene without product references when the post names no product", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set("content_1", content("content_1"));
    const handler = createContentGenerateHandler(generateDeps(api, slotHtml));
    const job = jobFor("job_gen", "content_1", {
      brief: "Hasat mevsimi",
      title: "Hasat",
      imageSlot: "ai_generate",
      imageBrief: "Altın renkli buğday tarlasında hasat, sıcak ışık",
      conversationId: "conv_1",
      slotImage: { consented: true },
    });
    await handler.run(job.payload as never, ctxFor(job));
    const jobs = imageJobs(state);
    expect(jobs).toHaveLength(1);
    const payload = ImageGeneratePayload.parse(jobs[0]?.payload);
    expect(payload.productIds).toBeUndefined();
    expect(payload.referenceAssetIds).toEqual([]);
    // No style asked: the image job takes the brand's preset.
    expect(payload.style).toBeUndefined();
    expect(payload.approval).toEqual({
      kind: "product_image",
      contentId: "content_1",
      slotId: "field-photo",
      conversationId: "conv_1",
    });
    expect(payload.prompt).toContain("Altın renkli buğday tarlasında hasat");
    expect(payload.prompt).toContain("Ürün yok");
  });

  it("says so and pays nothing when the design has no empty slot", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set("content_1", content("content_1"));
    const handler = createContentGenerateHandler(generateDeps(api, typographic));
    const job = jobFor("job_gen", "content_1", {
      brief: "Hasat",
      imageSlot: "ai_generate",
      conversationId: "conv_1",
      slotImage: { consented: true },
    });
    const out = await handler.run(job.payload as never, ctxFor(job));
    expect(imageJobs(state)).toEqual([]);
    expect(out).toMatchObject({ slotImages: { jobs: [] } });
    expect(String((out.slotImages as { note: string }).note)).toContain("boş görsel yuvası");
  });

  it("gives every variant post its own slot job, and the approval targets that post's slot", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedProduct(state);
    for (const id of ["content_1", "content_2"]) state.contents.set(id, content(id));
    for (const [index, contentId] of ["content_1", "content_2"].entries()) {
      const handler = createContentGenerateHandler(generateDeps(api, slotHtml));
      const job = jobFor(`job_gen_${index + 1}`, contentId, {
        brief: "Boro'yu tarlada tanıt.",
        imageSlot: "ai_generate",
        conversationId: "conv_1",
        variants: 2,
        variantIndex: index + 1,
        slotImage: { consented: true, productIds: ["prod_boro"] },
      });
      await handler.run(job.payload as never, ctxFor(job));
    }
    const jobs = imageJobs(state);
    expect(jobs).toHaveLength(2);
    const payloads = jobs.map((j) => ImageGeneratePayload.parse(j.payload));
    expect(payloads.map((p) => [p.approval?.contentId, p.approval?.slotId, p.variant])).toEqual([
      ["content_1", "field-photo", { index: 1, count: 2 }],
      ["content_2", "field-photo", { index: 2, count: 2 }],
    ]);
    // No side asked: the first photos (the cover first).
    expect(payloads[0]?.referenceAssetIds).toEqual(["asset_front", "asset_left", "asset_back"]);

    // The picture's approval request names the post and its slot, with the card in the chat:
    // approving it renders the slot (`POST /api/approvals/{id}/approve` → content.render).
    const approval = buildApprovalCreate({
      brandId: "brand_1",
      jobId: jobs[1]?.id ?? "",
      payload: payloads[1] as ImageGeneratePayload,
      assetId: "asset_gen_9",
      checkReport: null,
    });
    expect(approval).toMatchObject({
      kind: "product_image",
      contentId: "content_2",
      slotId: "field-photo",
      productId: "prod_boro",
      conversationId: "conv_1",
      assetIds: ["asset_gen_9"],
      request: { jobType: "image.generate" },
    });
    expect(approval.chatMessage?.text).toContain("Görsel geldi (2/2)");
    expect(approval.request?.payload).not.toHaveProperty("approval");
  });
});

// --- chat: consent with the post request ---------------------------------------------------------

function chat(allow: boolean) {
  const { api, state } = createFakeApi({ brands: [fakeBrand()] });
  const signal = new AbortController().signal;
  const writer = new TurnWriter({ api, runId: "run_1", attempt: 1, signal, flushIntervalMs: 5 });
  const ex = new StudioToolExecutor({
    api,
    writer,
    runId: "run_1",
    conversationId: "conv_1",
    initialBrandId: "brand_1",
    initialOpenPlan: null,
    aliases: [],
    signal,
    consentPollIntervalMs: 5,
  });
  const decide = setInterval(() => {
    for (const p of state.parts) {
      if (p.type === "consent" && p.state === "pending") state.decideConsent(p.consentId, allow);
    }
  }, 5);
  return { state, ex, writer, stop: () => clearInterval(decide) };
}

const generated = (state: FakeApiState) =>
  state.jobs
    .filter((j) => j.type === "content.generate")
    .map((j) => ContentGeneratePayload.parse(j.payload));

describe("generate_post: the paid slot picture", () => {
  it("asks once for every variant and sends the consent with each post", async () => {
    const c = chat(true);
    try {
      seedProduct(c.state);
      const res = await c.ex.execute("generate_post", {
        brief: "Boro'yu tarlada tanıt.",
        title: "Boro tarlada",
        imageSlot: "ai_generate",
        imageBrief: "Gün doğumunda tarlada Boro şişesi",
        products: ["@boro"],
        imageView: "sol",
        variants: 2,
      });
      expect(res.isError, JSON.stringify(res.data)).toBe(false);
      await c.writer.flush();
      const cards = c.state.parts.filter((p) => p.type === "consent");
      expect(cards).toHaveLength(1);
      const card = cards[0];
      expect(card?.type === "consent" ? card.title : "").toBe(
        "Ürün görseli de üreteyim mi? (ücretli)",
      );
      expect(card?.type === "consent" ? card.detail : "").toContain("2 görsel (her varyanta bir)");
      expect(card?.type === "consent" ? card.detail : "").toContain("ürün: Boro");
      const payloads = generated(c.state);
      expect(payloads).toHaveLength(2);
      for (const p of payloads) {
        expect(p.slotImage).toEqual({
          consented: true,
          productIds: ["prod_boro"],
          view: "sol",
          conversationId: "conv_1",
        });
      }
      expect(payloads.map((p) => p.variantIndex)).toEqual([1, 2]);
      expect(res.data).toMatchObject({ slotImage: { consented: true, products: ["Boro"] } });
      // No picture is generated in the chat itself: it waits for each design.
      expect(imageJobs(c.state)).toEqual([]);
    } finally {
      c.stop();
    }
  });

  it("still makes the post, with the slot left empty, when the owner says no", async () => {
    const c = chat(false);
    try {
      const res = await c.ex.execute("generate_post", {
        brief: "Hasat mevsimi",
        imageSlot: "ai_generate",
        imageBrief: "Buğday tarlası",
      });
      expect(res.isError, JSON.stringify(res.data)).toBe(false);
      const payloads = generated(c.state);
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.imageSlot).toBe("ai_generate");
      expect(payloads[0]?.slotImage).toBeUndefined();
      expect(res.data).toMatchObject({ slotImage: { consented: false } });
      expect(String((res.data.slotImage as { note: string }).note)).toContain("fill_post_slot");
      await c.writer.flush();
      const card = c.state.parts.find((p) => p.type === "consent");
      expect(card?.type === "consent" ? card.title : "").toBe(
        "Post için AI görsel de üreteyim mi? (ücretli)",
      );
    } finally {
      c.stop();
    }
  });

  it("asks nothing for a post without an AI slot or when the owner already said no", async () => {
    const c = chat(true);
    try {
      await c.ex.execute("generate_post", { brief: "Tipografik post", imageSlot: "none" });
      await c.ex.execute("generate_post", {
        brief: "Görselsiz istendi",
        imageSlot: "ai_generate",
        aiImage: false,
      });
      await c.writer.flush();
      expect(c.state.parts.filter((p) => p.type === "consent")).toEqual([]);
      expect(generated(c.state).map((p) => p.slotImage)).toEqual([undefined, undefined]);
    } finally {
      c.stop();
    }
  });
});
