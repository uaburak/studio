import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Asset, type BrandProduct, ImageGeneratePayload, type Job } from "@studio/contract";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { StudioToolExecutor } from "../src/chat/tools.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { approvalMessageText, buildApprovalCreate } from "../src/image/approval.ts";
import { createImageGenerateHandler, type ImageGenerateDeps } from "../src/image/handler.ts";
import { assessPhotoQuality } from "../src/image/photo-quality.ts";
import {
  describeReference,
  mergeLabelLines,
  ocrReadingOrder,
  type ReferenceDescription,
} from "../src/image/product-description.ts";
import {
  buildProductImagePrompt,
  PRODUCT_RULE,
  resolveStyle,
} from "../src/image/product-prompt.ts";
import { requestedViews, selectProductReferences } from "../src/image/references.ts";
import {
  CHECK_ASPECTS,
  compareLabelLines,
  findingNote,
  shapeCheckReport,
} from "../src/image/verify.ts";
import type { VisionModelCaller, VisionModelRequest } from "../src/image/vision-model.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import type { RenderCapable } from "../src/render/handler.ts";
import { createFakeApi, type FakeApiState, fakeBrand, NOW } from "./fake-api.ts";
import { type FakeVisionOptions, fakeVision, line } from "./fake-vision.ts";

/*
 * Faz 1 — the product picture line (docs/URETIM-RESIM.md): reference choice, the exact
 * description (cached per photo), the prompt, the AI check's report, approval requests with
 * their chat card (variants, regenerate), and the low-quality photo upgrade. Every model call is
 * a fake: nothing here reaches Gemini or Claude.
 */

// --- fixtures -----------------------------------------------------------------------------------

async function png(width: number, height: number, color = "#2E7D32"): Promise<Uint8Array> {
  const buf = await sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

/** A crisp checkerboard (sharp, high contrast). */
async function sharpPhoto(size: number): Promise<Uint8Array> {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (Math.floor(x / 6) + Math.floor(y / 6)) % 2 === 0 ? 20 : 235;
      raw.fill(v, (y * size + x) * 3, (y * size + x) * 3 + 3);
    }
  }
  const buf = await sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

/** A small, soft photo (low resolution, blurred). */
async function blurryPhoto(): Promise<Uint8Array> {
  const buf = await sharp(await sharpPhoto(320))
    .blur(8)
    .png()
    .toBuffer();
  return new Uint8Array(buf);
}

function product(overrides: Partial<BrandProduct> = {}): BrandProduct {
  return {
    id: "prod_boro",
    brandId: "brand_1",
    name: "Boro",
    slug: "boro",
    description: "Sıvı bor gübresi",
    category: "Gübre",
    tags: [],
    notes: "Etiketteki yazı değişmesin.",
    imageAssetIds: ["asset_front", "asset_left", "asset_back"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function assetRecord(id: string, filename: string, width = 1600, height = 1600): Asset {
  return {
    id,
    brandId: "brand_1",
    kind: "image",
    source: "upload",
    objectKey: `brands/brand_1/${id}`,
    mimeType: "image/png",
    bytes: 1000,
    sha256: "0".repeat(64),
    width,
    height,
    durationMs: null,
    originalFilename: filename,
    createdAt: NOW,
  };
}

async function seedProduct(state: FakeApiState, photos?: Record<string, Uint8Array>) {
  state.products.push(product());
  const bytes = photos ?? {
    asset_front: await png(800, 1000, "#1E5631"),
    asset_left: await png(800, 1000, "#1E5632"),
    asset_back: await png(800, 1000, "#1E5633"),
  };
  const names: Record<string, string> = {
    asset_front: "boro-on.png",
    asset_left: "boro-sol.png",
    asset_back: "boro-arka.png",
  };
  for (const [id, b] of Object.entries(bytes)) {
    state.assets.set(id, { bytes: b, contentType: "image/png" });
    state.assetRecords.push(assetRecord(id, names[id] ?? `${id}.png`));
  }
}

const DESCRIBED = {
  view: "ön",
  labelLines: ["BORO", "Bor %11", "Sıvı Gübre"],
  brand: "MTM Agro",
  logo: "yeşil yaprak simgesi, sol üstte",
  colors: [{ name: "koyu yeşil", hex: "1e5631", where: "gövde" }],
  patterns: "",
  materials: "parlak plastik",
  shape: "silindirik şişe",
  proportions: "yükseklik/genişlik ≈ 2.5",
  closure: "beyaz vidalı kapak",
  transparency: "opak",
  otherDetails: "",
};

function allOk(except: Partial<Record<string, string>> = {}) {
  return {
    items: CHECK_ASPECTS.map((aspect) => ({
      aspect,
      ok: !(aspect in except),
      note: except[aspect] ?? "",
    })),
    summary: "",
  };
}

/** Vision model stand-in: answers by kind, records the requests. */
function fakeModel(answers: { describe?: unknown; verify?: unknown; fail?: boolean }) {
  const calls: { kind: "describe" | "verify"; req: VisionModelRequest }[] = [];
  const productVision = (kind: "describe" | "verify"): VisionModelCaller => {
    return async (req) => {
      calls.push({ kind, req });
      if (answers.fail) throw new Error("model down");
      return { output: kind === "describe" ? answers.describe : answers.verify, model: "fake" };
    };
  };
  return { calls, productVision };
}

/** Gemini image generation stand-in (never the real API); records the requests. */
function geminiImage(picture: Uint8Array) {
  const seen: { body: Record<string, unknown> }[] = [];
  const fetchFn: typeof fetch = async (_input, init) => {
    seen.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: "image/png",
                    data: Buffer.from(picture).toString("base64"),
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

function promptOf(seen: { body: Record<string, unknown> }[], i = 0): string {
  const contents = (seen[i]?.body.contents ?? []) as { parts: { text?: string }[] }[];
  return contents[0]?.parts[0]?.text ?? "";
}

const dummyRenderer: RenderCapable = {
  async render() {
    throw new Error("no render in these tests");
  },
  async renderAndLint() {
    throw new Error("unused");
  },
};

function handlerDeps(
  api: ImageGenerateDeps["api"],
  options: {
    fetchFn: typeof fetch;
    vision?: FakeVisionOptions;
    productVision?: ImageGenerateDeps["productVision"];
    stateDir?: string;
  },
) {
  const vision = fakeVision(options.vision ?? {});
  const deps: ImageGenerateDeps = {
    api,
    gate: new ClaudeGate({
      runner: async () => {
        throw new Error("no Claude in these tests");
      },
    }),
    settings: loadAgentSettings({ GEMINI_API_KEY: "test-key" }),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: options.stateDir ?? mkdtempSync(path.join(tmpdir(), "worker-product-")),
    renderer: () => dummyRenderer,
    imageFetch: options.fetchFn,
    vision,
    ...(options.productVision ? { productVision: options.productVision } : {}),
  };
  return { deps, vision };
}

function jobCtx(id: string, payload: Record<string, unknown>): JobContext {
  const job: Job = {
    id,
    type: "image.generate",
    status: "running",
    brandId: "brand_1",
    payload,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    jobId: id,
    job,
    attempt: 1,
    workerId: "mac",
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
  };
}

/** Run one `image.generate` job as the worker does (payload parsed with its defaults). */
function runJob(
  handler: ReturnType<typeof createImageGenerateHandler>,
  id: string,
  payload: Record<string, unknown>,
) {
  return handler.run(ImageGeneratePayload.parse(payload), jobCtx(id, payload));
}

const LABEL_BOX = { x: 0.3, y: 0.4, width: 0.4, height: 0.05 };
const REFERENCE_OCR = [
  line("BORO", { ...LABEL_BOX, y: 0.3 }),
  line("Bor %11", { ...LABEL_BOX, y: 0.4 }),
];

// --- reference choice ---------------------------------------------------------------------------

describe("reference choice", () => {
  const photos = [
    { assetId: "front", position: 0, angleHint: "ön" },
    { assetId: "back", position: 1, angleHint: "arka, etiket" },
    { assetId: "left", position: 2, angleHint: "sol" },
    { assetId: "side", position: 3, angleHint: "yan" },
    { assetId: "plain", position: 4, angleHint: null },
  ];

  it("reads the asked side from the request, not placements like 'arka planda'", () => {
    expect(requestedViews("sola bakan şişe, tarlada")).toEqual(["sol", "yan"]);
    expect(requestedViews("arka etiketi görünsün")).toEqual(["arka"]);
    expect(requestedViews("arka planda dağlar, ürün masanın üstünde")).toEqual([]);
    expect(requestedViews("ön planda ürün")).toEqual([]);
    expect(requestedViews("sağ", "tarlada")).toEqual(["sağ"]);
  });

  it("sends the photos of the asked side, else at most three", () => {
    expect(selectProductReferences(photos, { prompt: "sola bakan şişe" })).toMatchObject({
      assetIds: ["left"],
      decided: true,
    });
    expect(selectProductReferences(photos, { prompt: "yandan çekim" }).assetIds).toEqual(["side"]);
    expect(selectProductReferences(photos, { prompt: "tarla", view: "arka" }).assetIds).toEqual([
      "back",
    ]);
    // Asked right: no right photo, so a side photo.
    expect(selectProductReferences(photos, { prompt: "sağa bakan" }).assetIds).toEqual(["side"]);
    const undecided = selectProductReferences(photos, { prompt: "güneşli tarla" });
    expect(undecided).toMatchObject({ assetIds: ["front", "back", "left"], decided: false });
    expect(
      selectProductReferences([photos[4] as (typeof photos)[number]], {
        prompt: "üstten çekim",
      }),
    ).toMatchObject({ assetIds: ["plain"], decided: false, wanted: ["üst"] });
  });
});

// --- exact description --------------------------------------------------------------------------

describe("exact description", () => {
  it("keeps OCR's exact lines in reading order and adds what only the model read", () => {
    expect(
      ocrReadingOrder([
        line("Bor %11", { x: 0.1, y: 0.5, width: 0.3, height: 0.05 }),
        line("BORO", { x: 0.1, y: 0.2, width: 0.3, height: 0.05 }),
        line("sağ", { x: 0.6, y: 0.51, width: 0.1, height: 0.05 }),
        line("gürültü", { x: 0.1, y: 0.9, width: 0.1, height: 0.05 }, 0.2),
      ]),
    ).toEqual(["BORO", "Bor %11", "sağ"]);
    expect(mergeLabelLines(["BORO", "Bor %11"], ["Boro", "Bor %11", "Sıvı Gübre"])).toEqual({
      lines: ["BORO", "Bor %11", "Sıvı Gübre"],
      source: "ocr+model",
    });
    expect(mergeLabelLines([], ["Şişe"])).toEqual({ lines: ["Şişe"], source: "model" });
    expect(mergeLabelLines([], [])).toEqual({ lines: [], source: "none" });
  });

  it("reads a photo once: cached by asset id and content hash", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "worker-describe-"));
    const vision = fakeVision({ ocr: { reference: REFERENCE_OCR } });
    const model = fakeModel({ describe: DESCRIBED });
    const deps = {
      vision,
      stateDir,
      logger: silentLogger,
      model: model.productVision("describe"),
    };
    const bytes = await png(400, 500);
    const first = await describeReference(deps, { assetId: "asset_front", bytes });
    expect(first).toMatchObject({
      view: "ön",
      labelLines: ["BORO", "Bor %11", "Sıvı Gübre"],
      labelSource: "ocr+model",
      colors: [{ name: "koyu yeşil", hex: "#1E5631", where: "gövde" }],
      closure: "beyaz vidalı kapak",
      model: "fake",
    });
    // OCR's lines went to the model as the exact reading.
    const sent = model.calls[0]?.req.content[0];
    expect(sent?.type === "text" ? sent.text : "").toContain("| Bor %11");

    const again = await describeReference(deps, { assetId: "asset_front", bytes });
    expect(again).toEqual(first);
    expect(model.calls).toHaveLength(1);
    expect(vision.calls.filter((c) => c.command === "ocr")).toHaveLength(1);

    // New pixels under the same id: read again.
    await describeReference(deps, { assetId: "asset_front", bytes: await png(401, 500) });
    expect(model.calls).toHaveLength(2);
  });

  it("does not keep a reading the model failed on", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "worker-describe-"));
    const vision = fakeVision({ ocr: { reference: REFERENCE_OCR } });
    const failing = fakeModel({ fail: true });
    const bytes = await png(400, 500);
    const deps = {
      vision,
      stateDir,
      logger: silentLogger,
      model: failing.productVision("describe"),
    };
    const d = await describeReference(deps, { assetId: "a", bytes });
    expect(d).toMatchObject({ labelLines: ["BORO", "Bor %11"], labelSource: "ocr", model: null });
    expect(d.notes.join(" ")).toContain("okunamadı");
    await describeReference(deps, { assetId: "a", bytes });
    expect(failing.calls).toHaveLength(2);
  });
});

// --- prompt -------------------------------------------------------------------------------------

describe("product prompt", () => {
  const description: ReferenceDescription = {
    version: 1,
    assetId: "asset_front",
    hash: "x",
    view: "ön",
    labelLines: ["BORO", "Bor %11", "Çinko İçerir"],
    labelSource: "ocr",
    brand: "MTM Agro",
    logo: "yaprak",
    colors: [{ name: "koyu yeşil", hex: "#1E5631", where: "gövde" }],
    patterns: "",
    materials: "plastik",
    shape: "silindir",
    proportions: "2.5:1",
    closure: "beyaz kapak",
    transparency: "opak",
    otherDetails: "",
    model: "fake",
    notes: [],
  };

  it("writes the description word for word under the only-the-scene rule, with the style", () => {
    const prompt = buildProductImagePrompt({
      request: "Sabah ışığında buğday tarlasında",
      mode: "scene",
      products: [{ product: product(), descriptions: [description] }],
      style: "vintage",
      aspectRatio: "4:5",
    });
    expect(prompt).toContain(PRODUCT_RULE);
    expect(prompt).toContain("YOU MAY CHANGE ONLY");
    expect(prompt).toContain("SCENE REQUEST: Sabah ışığında buğday tarlasında");
    expect(prompt).toContain("STYLE: vintage");
    expect(prompt).toContain('PRODUCT 1: "Boro"');
    expect(prompt).toContain("    | BORO\n    | Bor %11\n    | Çinko İçerir");
    expect(prompt).toContain("koyu yeşil (#1E5631) — gövde");
    expect(prompt).toContain("Cap / closure: beyaz kapak");

    const upgrade = buildProductImagePrompt({
      request: "",
      mode: "upgrade",
      products: [{ product: product(), descriptions: [description] }],
      style: "",
      aspectRatio: "1:1",
    });
    expect(upgrade).toContain("pure white studio background");
    expect(upgrade).not.toContain("STYLE:");
  });

  it("takes the request's style, else the brand's; '' is none", () => {
    expect(resolveStyle(undefined, "retro")).toBe("retro");
    expect(resolveStyle("vintage", "retro")).toBe("vintage");
    expect(resolveStyle("", "retro")).toBe("");
    expect(resolveStyle(undefined, undefined)).toBe("");
  });
});

// --- the check's report -------------------------------------------------------------------------

describe("AI check report", () => {
  it("names a changed label line exactly and leaves unseen lines to the model", () => {
    const { ok, findings } = compareLabelLines(
      ["BORO", "Bor %11", "Sıvı Gübre"],
      ["BORO", "Bor %1"],
    );
    expect(ok).toEqual(["BORO"]);
    expect(findings).toEqual([
      { expected: "Bor %11", found: "Bor %1", kind: "changed" },
      { expected: "Sıvı Gübre", found: null, kind: "missing" },
    ]);
    expect(findingNote(findings[0] as (typeof findings)[number])).toBe(
      "'Bor %11' yazısı 'Bor %1' olmuş",
    );
    // A lost Turkish letter is a change.
    expect(compareLabelLines(["Gübre"], ["Gubre"]).findings[0]?.kind).toBe("changed");
  });

  it("a stylised line without numbers that the model sees unchanged is a note, not a fault", () => {
    const report = shapeCheckReport({
      model: allOk(),
      label: {
        findings: [
          { expected: "ITM AGRE", found: "MTW AORO", kind: "changed" },
          { expected: "Bor %11", found: "Bor %1", kind: "changed" },
        ],
        expected: 3,
        ocr: true,
      },
    });
    const label = report.items[0];
    expect(label?.ok).toBe(false);
    expect(label?.note).toContain("'Bor %11' yazısı 'Bor %1' olmuş");
    expect(label?.note).toContain("elle bak: 'ITM AGRE' yazısı 'MTW AORO' olmuş");

    const logoOnly = shapeCheckReport({
      model: allOk(),
      label: {
        findings: [{ expected: "ITM AGRE", found: "MTW AORO", kind: "changed" }],
        expected: 2,
        ocr: true,
      },
    });
    expect(logoOnly.passed).toBe(true);
    expect(logoOnly.items[0]?.note).toContain("elle bak");
  });

  it("passes only when every aspect is right", () => {
    const pass = shapeCheckReport({
      model: allOk(),
      label: { findings: [], expected: 2, ocr: true },
    });
    expect(pass.passed).toBe(true);
    expect(pass.items.map((i) => i.aspect)).toEqual([...CHECK_ASPECTS]);
    expect(pass.summary).toContain("Kontrol temiz");

    const capFail = shapeCheckReport({
      model: allOk({ Kapak: "kapak beyaz yerine gri" }),
      label: null,
    });
    expect(capFail.passed).toBe(false);
    expect(capFail.summary).toBe("Şu kısımlar hatalı geldi: kapak (kapak beyaz yerine gri).");

    // The OCR's changed line fails the label even when the model missed it.
    const label = shapeCheckReport({
      model: allOk(),
      label: {
        findings: [{ expected: "Bor %11", found: "Bor %1", kind: "changed" }],
        expected: 2,
        ocr: true,
      },
    });
    expect(label.passed).toBe(false);
    expect(label.items[0]).toEqual({
      aspect: "Etiket yazısı",
      ok: false,
      note: "'Bor %11' yazısı 'Bor %1' olmuş",
    });

    // An aspect the model did not judge is not passed.
    const partial = shapeCheckReport({
      model: { items: [{ aspect: "logo", ok: true, note: "" }] },
      label: null,
    });
    expect(partial.passed).toBe(false);
    expect(partial.items.find((i) => i.aspect === "Logo")?.ok).toBe(true);
    expect(partial.items.find((i) => i.aspect === "Kapak")?.note).toContain("değerlendirmedi");
  });

  it("never passes without a model", () => {
    const report = shapeCheckReport({
      model: null,
      modelError: "quota",
      label: { findings: [], expected: 2, ocr: true },
    });
    expect(report.passed).toBe(false);
    expect(report.items).toEqual([
      {
        aspect: "Etiket yazısı",
        ok: true,
        note: "Etiketteki bütün satırlar görselde aynen okundu.",
      },
      {
        aspect: "Görsel kontrol",
        ok: false,
        note: "Yapay zekâ kontrolü yapılamadı (quota); ürünü elle karşılaştırın.",
      },
    ]);
  });
});

// --- approval requests --------------------------------------------------------------------------

describe("approval request shaping", () => {
  it("writes the chat message for each case", () => {
    const failing = {
      passed: false,
      items: [],
      summary: "Şu kısımlar hatalı geldi: kapak (gri).",
    };
    expect(
      approvalMessageText({
        kind: "product_image",
        report: failing,
        regenerated: false,
        composite: false,
      }),
    ).toBe(
      "Görsel geldi; kontrol: şu kısımlar hatalı geldi: kapak (gri). Onaylıyor musun, yeniden üreteyim mi? İstersen yeniden üretirken etiketi birebir koruyarak yerleştirebilirim (gerçek ürün fotoğrafı sahneye yapıştırılır).",
    );
    expect(
      approvalMessageText({
        kind: "variant",
        report: { passed: true, items: [], summary: "" },
        variant: { index: 2, count: 3 },
        regenerated: true,
        composite: false,
      }),
    ).toBe(
      "Yeniden üretilen görsel geldi (2/3); kontrol: temiz, ürün referans fotoğraflarıyla birebir. Onaylıyor musun, yeniden üreteyim mi?",
    );
    expect(
      approvalMessageText({
        kind: "product_photo_upgrade",
        report: null,
        regenerated: false,
        composite: false,
      }),
    ).toContain("Olmuş mu?");
  });

  it("keeps the request to run again, without the approval and the variant", () => {
    const created = buildApprovalCreate({
      brandId: "brand_1",
      jobId: "job_9",
      assetId: "asset_new",
      checkReport: null,
      payload: {
        prompt: "tarla",
        aspectRatio: "4:5",
        imageSize: "2K",
        referenceAssetIds: ["asset_front"],
        preserveProductLabel: false,
        productIds: ["prod_boro"],
        variant: { index: 1, count: 2 },
        approval: { kind: "variant", conversationId: "conv_1", supersedesId: "apr_old" },
      },
    });
    expect(created).toMatchObject({
      kind: "variant",
      assetIds: ["asset_new"],
      productId: "prod_boro",
      conversationId: "conv_1",
      sourceJobId: "job_9",
      supersedesId: "apr_old",
      request: {
        jobType: "image.generate",
        payload: { prompt: "tarla", productIds: ["prod_boro"] },
      },
    });
    expect(created.request?.payload).not.toHaveProperty("approval");
    expect(created.request?.payload).not.toHaveProperty("variant");
    expect(created.chatMessage?.text).toMatch(/^Yeniden üretilen görsel geldi \(1\/2\)/);
  });
});

// --- the handler --------------------------------------------------------------------------------

describe("image.generate: product pictures", () => {
  it("describes, generates once, checks, and asks for approval in the chat (never retries)", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand({ imageStylePreset: "vintage" })] });
    await seedProduct(state);
    const gemini = geminiImage(await png(1080, 1350, "#88AA66"));
    const model = fakeModel({ describe: DESCRIBED, verify: allOk() });
    const { deps, vision } = handlerDeps(api, {
      fetchFn: gemini.fetchFn,
      vision: {
        ocr: {
          reference: REFERENCE_OCR,
          generated: [line("BORO", LABEL_BOX), line("Bor %1", LABEL_BOX)],
        },
      },
      productVision: model.productVision,
    });
    const handler = createImageGenerateHandler(deps);
    const payload = {
      prompt: "Sabah ışığında buğday tarlasında",
      referenceAssetIds: ["asset_front"],
      productIds: ["prod_boro"],
      approval: {
        kind: "product_image",
        conversationId: "conv_1",
        contentId: "cnt_target",
        slotId: "field-photo",
        productId: "prod_boro",
      },
    };
    const result = (await runJob(handler, "job_p1", payload)) as Record<string, unknown>;

    // One paid call, the exact description in its prompt, the brand's style.
    expect(gemini.seen).toHaveLength(1);
    const prompt = promptOf(gemini.seen);
    expect(prompt).toContain(PRODUCT_RULE);
    expect(prompt).toContain("    | BORO\n    | Bor %11\n    | Sıvı Gübre");
    expect(prompt).toContain("#1E5631");
    expect(prompt).toContain("STYLE: vintage");
    // The label composite is not the default: no cutout.
    expect(vision.calls.some((c) => c.command === "foreground-mask")).toBe(false);

    // The check saw the references and the result; the OCR caught the changed line.
    const verify = model.calls.find((c) => c.kind === "verify");
    expect(verify?.req.content.filter((b) => b.type === "image")).toHaveLength(2);
    expect(state.approvalCreates).toHaveLength(1);
    const created = state.approvalCreates[0];
    expect(created).toMatchObject({
      brandId: "brand_1",
      kind: "product_image",
      assetIds: ["asset_gen_1"],
      contentId: "cnt_target",
      slotId: "field-photo",
      productId: "prod_boro",
      conversationId: "conv_1",
      sourceJobId: "job_p1",
      request: { jobType: "image.generate" },
    });
    expect(created?.checkReport?.passed).toBe(false);
    expect(created?.checkReport?.items?.[0]).toMatchObject({
      aspect: "Etiket yazısı",
      ok: false,
      note: expect.stringContaining("'Bor %11' yazısı 'Bor %1' olmuş"),
    });
    expect(created?.chatMessage?.text).toContain("Görsel geldi; kontrol: şu kısımlar hatalı geldi");
    expect(created?.chatMessage?.text).toContain("Onaylıyor musun, yeniden üreteyim mi?");
    expect(result).toMatchObject({ approvalId: "apr_1", checkReport: { passed: false } });
    // The slot waits for the owner: nothing rendered, nothing generated again.
    expect(state.versionCreates).toHaveLength(0);
    expect(state.jobs).toHaveLength(0);

    // The next picture of the same product reuses the description (no second reading).
    const second = { ...payload, approval: { ...payload.approval } };
    await runJob(handler, "job_p2", second);
    expect(model.calls.filter((c) => c.kind === "describe")).toHaveLength(1);
    expect(gemini.seen).toHaveLength(2);
  });

  it("posts each variant on its own and links a regenerated picture to the old request", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    await seedProduct(state);
    const gemini = geminiImage(await png(1080, 1350));
    const model = fakeModel({ describe: DESCRIBED, verify: allOk() });
    const { deps } = handlerDeps(api, {
      fetchFn: gemini.fetchFn,
      vision: {
        ocr: {
          reference: REFERENCE_OCR,
          generated: [line("BORO", LABEL_BOX), line("Bor %11", LABEL_BOX)],
        },
      },
      productVision: model.productVision,
    });
    const handler = createImageGenerateHandler(deps);
    for (const index of [1, 2]) {
      const payload = {
        prompt: "tarla",
        referenceAssetIds: ["asset_front"],
        productIds: ["prod_boro"],
        style: "",
        variant: { index, count: 2 },
        approval: { kind: "variant", conversationId: "conv_1", productId: "prod_boro" },
      };
      await runJob(handler, `job_v${index}`, payload);
    }
    expect(state.approvalCreates.map((a) => [a.kind, a.chatMessage?.text.slice(0, 20)])).toEqual([
      ["variant", "Görsel geldi (1/2); "],
      ["variant", "Görsel geldi (2/2); "],
    ]);
    expect(state.approvalCreates[0]?.checkReport?.passed).toBe(true);
    expect(state.approvalCreates[0]?.chatMessage?.text).toContain("kontrol: temiz");
    expect(promptOf(gemini.seen)).not.toContain("STYLE:");

    // "Yeniden üret": the API queues the stored request with `approval.supersedesId`.
    const stored = state.approvalCreates[0]?.request?.payload ?? {};
    const regenerate = {
      ...stored,
      preserveProductLabel: true,
      approval: { kind: "variant", conversationId: "conv_1", supersedesId: "apr_1" },
    };
    const { deps: deps2 } = handlerDeps(api, {
      fetchFn: gemini.fetchFn,
      vision: {
        ocr: {
          reference: REFERENCE_OCR,
          "final-product": [line("BORO", LABEL_BOX), line("Bor %11", LABEL_BOX)],
          generated: [line("BORO", LABEL_BOX), line("Bor %11", LABEL_BOX)],
        },
      },
      productVision: model.productVision,
    });
    await runJob(createImageGenerateHandler(deps2), "job_r1", regenerate);
    const again = state.approvalCreates[2];
    expect(again).toMatchObject({ supersedesId: "apr_1", conversationId: "conv_1" });
    expect(again?.chatMessage?.text).toMatch(/^Yeniden üretilen görsel geldi;/);
  });

  it("makes the low-quality photo upgrade a white studio shot that replaces the photo on approval", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand({ imageStylePreset: "retro" })] });
    await seedProduct(state);
    const gemini = geminiImage(await png(2048, 2048, "#FFFFFF"));
    const model = fakeModel({ describe: DESCRIBED, verify: allOk() });
    const { deps } = handlerDeps(api, {
      fetchFn: gemini.fetchFn,
      vision: { ocr: { reference: REFERENCE_OCR, generated: REFERENCE_OCR } },
      productVision: model.productVision,
    });
    const payload = {
      prompt: "Aynı ürünün profesyonel stüdyo çekimi.",
      aspectRatio: "1:1",
      referenceAssetIds: ["asset_front"],
      productIds: ["prod_boro"],
      style: "",
      approval: {
        kind: "product_photo_upgrade",
        conversationId: "conv_1",
        productId: "prod_boro",
        replacesAssetId: "asset_front",
      },
    };
    await runJob(createImageGenerateHandler(deps), "job_u1", payload);
    const prompt = promptOf(gemini.seen);
    expect(prompt).toContain("pure white studio background");
    expect(prompt).not.toContain("retro");
    expect(state.approvalCreates[0]).toMatchObject({
      kind: "product_photo_upgrade",
      productId: "prod_boro",
      replacesAssetId: "asset_front",
      checkReport: { passed: true },
    });
    expect(state.approvalCreates[0]?.chatMessage?.text).toContain("Olmuş mu?");
  });

  it("reports an unchecked picture as not passed when no model can look", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    await seedProduct(state);
    const gemini = geminiImage(await png(1080, 1350));
    const { deps } = handlerDeps(api, {
      fetchFn: gemini.fetchFn,
      vision: { ocr: { reference: REFERENCE_OCR, generated: REFERENCE_OCR } },
      productVision: () => null,
    });
    const payload = {
      prompt: "tarla",
      referenceAssetIds: ["asset_front"],
      productIds: ["prod_boro"],
      approval: { kind: "product_image", conversationId: "conv_1" },
    };
    await runJob(createImageGenerateHandler(deps), "job_n1", payload);
    expect(promptOf(gemini.seen)).toContain("    | BORO\n    | Bor %11");
    const report = state.approvalCreates[0]?.checkReport;
    expect(report?.passed).toBe(false);
    expect(report?.items?.map((i) => [i.aspect, i.ok])).toEqual([
      ["Etiket yazısı", true],
      ["Görsel kontrol", false],
    ]);
  });
});

// --- chat tools ---------------------------------------------------------------------------------

function chat(init: Parameters<typeof createFakeApi>[0] = {}) {
  const { api, state } = createFakeApi({ brands: [fakeBrand()], ...init });
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
  const allow = setInterval(() => {
    for (const p of state.parts) {
      if (p.type === "consent" && p.state === "pending") state.decideConsent(p.consentId, true);
    }
  }, 5);
  return { api, state, ex, writer, stop: () => clearInterval(allow) };
}

describe("chat tools", () => {
  it("generate_ai_image picks the asked side and queues one approval job per variant", async () => {
    const c = chat();
    try {
      await seedProduct(c.state);
      const res = await c.ex.execute("generate_ai_image", {
        prompt: "Sola bakan şişe, tarlada gün doğumu",
        referenceProducts: ["@boro"],
        variants: 2,
        style: "retro",
        targetContentId: "cnt_x",
        targetSlotId: "hero",
      });
      expect(res.isError, JSON.stringify(res.data)).toBe(false);
      expect(c.state.jobs.map((j) => j.payload)).toEqual(
        [1, 2].map((index) => ({
          prompt: "Sola bakan şişe, tarlada gün doğumu",
          aspectRatio: "4:5",
          imageSize: "2K",
          referenceAssetIds: ["asset_left"],
          preserveProductLabel: false,
          targetContentId: "cnt_x",
          targetSlotId: "hero",
          productIds: ["prod_boro"],
          style: "retro",
          approval: {
            kind: "variant",
            conversationId: "conv_1",
            contentId: "cnt_x",
            slotId: "hero",
            productId: "prod_boro",
          },
          variant: { index, count: 2 },
        })),
      );
      expect(res.data).toMatchObject({ jobIds: ["job_created_1", "job_created_2"] });
      await c.writer.flush();
      const consent = c.state.parts.find((p) => p.type === "consent");
      expect(consent?.type === "consent" ? consent.detail : "").toContain("2 görsel");
    } finally {
      c.stop();
    }
  });

  it("get_product flags a low-quality photo and upgrade_product_photo replaces the worst one", async () => {
    const c = chat();
    try {
      await seedProduct(c.state, {
        asset_front: await sharpPhoto(1600),
        asset_left: await blurryPhoto(),
      });
      c.state.products[0] = product({ imageAssetIds: ["asset_front", "asset_left"] });
      const got = await c.ex.execute("get_product", { product: "@boro" });
      expect(got.isError, JSON.stringify(got.data)).toBe(false);
      expect(got.data).toMatchObject({ lowQualityPhotos: ["asset_left"] });
      expect(String(got.data.note)).toContain(
        "Bu ürünün resmi kalitesiz, kalitesini artırayım mı?",
      );

      const res = await c.ex.execute("upgrade_product_photo", { product: "boro" });
      expect(res.isError, JSON.stringify(res.data)).toBe(false);
      expect(c.state.jobs[0]?.payload).toMatchObject({
        referenceAssetIds: ["asset_left"],
        productIds: ["prod_boro"],
        style: "",
        aspectRatio: "1:1",
        preserveProductLabel: false,
        approval: {
          kind: "product_photo_upgrade",
          conversationId: "conv_1",
          productId: "prod_boro",
          replacesAssetId: "asset_left",
        },
      });
      // The same request is not paid twice.
      const twice = await c.ex.execute("upgrade_product_photo", { product: "boro" });
      expect(twice.data).toMatchObject({ duplicate: true });
      expect(c.state.jobs).toHaveLength(1);
    } finally {
      c.stop();
    }
  });
});

describe("photo quality", () => {
  it("calls small, soft photos low quality and big sharp ones fine", async () => {
    const good = await assessPhotoQuality(await sharpPhoto(1600));
    expect(good).toMatchObject({ width: 1600, height: 1600, lowQuality: false, reasons: [] });
    const bad = await assessPhotoQuality(await blurryPhoto());
    expect(bad.lowQuality).toBe(true);
    expect(bad.reasons).toEqual(expect.arrayContaining(["düşük çözünürlük (320×320)", "bulanık"]));
    const dark = await assessPhotoQuality(await png(1600, 1600, "#0A0A0A"));
    expect(dark.reasons).toContain("karanlık, ışık yetersiz");
  });
});
