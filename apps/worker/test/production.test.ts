import type { BrandProduct, Content, TurnContext } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { buildConversationMetadataBlock } from "../src/chat/prompt.ts";
import { StudioToolExecutor } from "../src/chat/tools.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import { buildAgentArgs, buildClaudeArgs, WEB_TOOLS } from "../src/claude/args.ts";
import { productFacts } from "../src/generate/handler.ts";
import { createFakeApi, fakeBrand, fakeRun, NOW } from "./fake-api.ts";

/*
 * Post production basics (docs/URETIM-RESIM.md, Faz 0): engine and variants in generate_post,
 * `@product` / `@post` references, internet for the agents.
 */

function product(overrides: Partial<BrandProduct> = {}): BrandProduct {
  return {
    id: "prod_boro",
    brandId: "brand_1",
    name: "Boro",
    slug: "boro",
    description: "Sıvı bor gübresi",
    category: "Gübre",
    tags: ["bor"],
    notes: "Etiketteki yazı değişmesin.",
    imageAssetIds: ["asset_front", "asset_side"],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function post(overrides: Partial<Content> = {}): Content {
  return {
    id: "cnt_hasat",
    brandId: "brand_1",
    type: "post",
    title: "Hasat Bayramı",
    brief: "Hasat tebriği",
    status: "draft",
    targetPlatforms: ["instagram"],
    caption: "",
    currentVersion: null,
    approval: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function executor(init: Parameters<typeof createFakeApi>[0] = {}) {
  const { api, state } = createFakeApi({
    brands: [fakeBrand({ id: "brand_1" })],
    products: [product(), product({ id: "prod_venta", name: "Venta Boro", slug: "venta-boro" })],
    ...init,
  });
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
  });
  return { api, state, ex, writer };
}

describe("internet for the generation agents", () => {
  it("adds only the read-only web tools when asked", () => {
    const off = buildClaudeArgs({ systemPromptFile: "/tmp/s.md" });
    expect(off[off.indexOf("--tools") + 1]).toBe("");
    expect(off).not.toContain("--allowedTools");

    const on = buildClaudeArgs({ systemPromptFile: "/tmp/s.md", webAccess: true });
    expect(on[on.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(on[on.indexOf("--allowedTools") + 1]).toBe("WebSearch,WebFetch");

    const agent = buildAgentArgs({
      mcpConfigFile: "/tmp/mcp.json",
      appendSystemPrompt: "x",
      webAccess: true,
    });
    expect(agent[agent.indexOf("--tools") + 1]).toBe("WebSearch,WebFetch");
    expect(agent[agent.indexOf("--allowedTools") + 1]).toBe("mcp__studio,WebSearch,WebFetch");
    const plain = buildAgentArgs({ mcpConfigFile: "/tmp/mcp.json", appendSystemPrompt: "x" });
    expect(plain[plain.indexOf("--allowedTools") + 1]).toBe("mcp__studio");
    // Nothing that writes or runs commands.
    expect(WEB_TOOLS).toEqual(["WebSearch", "WebFetch"]);
  });
});

describe("generate_post: engine, variants and products", () => {
  it("queues one post and job per variant with the engine and the products", async () => {
    const { state, ex, writer } = executor();
    const res = await ex.execute("generate_post", {
      brief: "Bor eksikliği belirtileri",
      title: "Bor eksikliği",
      engine: "html",
      variants: 2,
      products: ["@boro", "venta-boro"],
    });
    expect(res.isError, JSON.stringify(res.data)).toBe(false);
    expect(state.jobs.map((j) => j.payload)).toMatchObject([
      {
        engine: "html",
        variants: 2,
        variantIndex: 1,
        productIds: ["prod_boro", "prod_venta"],
        title: "Bor eksikliği · Varyant 1/2",
      },
      { engine: "html", variants: 2, variantIndex: 2, title: "Bor eksikliği · Varyant 2/2" },
    ]);
    expect([...state.contents.values()].map((c) => c.title)).toEqual([
      "Bor eksikliği · Varyant 1/2",
      "Bor eksikliği · Varyant 2/2",
    ]);
    expect(res.data).toMatchObject({ ok: true, variants: 2, jobIds: state.jobs.map((j) => j.id) });
    await writer.flush();
    expect(state.parts.filter((p) => p.type === "content_ref")).toHaveLength(2);
  });

  it("fails clearly for an engine that is not ready, also when it is the brand's default", async () => {
    const asked = executor();
    const res = await asked.ex.execute("generate_post", { brief: "Hasat", engine: "svg" });
    expect(res.isError).toBe(true);
    expect(String(res.data.error)).toContain("Bu motor henüz hazır değil (SVG)");
    expect(asked.state.jobs).toHaveLength(0);

    const byBrand = executor({ brands: [fakeBrand({ id: "brand_1", defaultEngine: "wecra" })] });
    const res2 = await byBrand.ex.execute("generate_post", { brief: "Hasat" });
    expect(res2.isError).toBe(true);
    expect(String(res2.data.error)).toContain("Bu motor henüz hazır değil (Wecra)");

    // A single HTML post without an engine keeps the old payload (absent = html).
    const plain = executor();
    expect((await plain.ex.execute("generate_post", { brief: "Hasat" })).isError).toBe(false);
    expect(plain.state.jobs[0]?.payload).not.toHaveProperty("engine");
    expect(plain.state.jobs[0]?.payload).not.toHaveProperty("variants");
  });

  it("refuses unknown products and more than four variants", async () => {
    const { ex, state } = executor();
    const res = await ex.execute("generate_post", { brief: "x", products: ["@yok"] });
    expect(res.isError).toBe(true);
    expect(String(res.data.error)).toContain("Ürün bulunamadı: @yok");
    const many = await ex.execute("generate_post", { brief: "x", variants: 5 });
    expect(many.isError).toBe(true);
    expect(state.jobs).toHaveLength(0);
  });
});

describe("@product and @post references in tools", () => {
  it("get_content takes a post's @name; get_product lists the photos with angles", async () => {
    const { state, ex } = executor({ contents: new Map([["cnt_hasat", post()]]) });
    const got = await ex.execute("get_content", { contentId: "@hasat-bayrami" });
    expect(got.isError, JSON.stringify(got.data)).toBe(false);
    expect(got.data).toMatchObject({ content: { id: "cnt_hasat" } });

    state.assetRecords.push(
      {
        id: "asset_front",
        brandId: "brand_1",
        kind: "image",
        source: "upload",
        objectKey: "k1",
        mimeType: "image/png",
        bytes: 10,
        sha256: "a".repeat(64),
        width: 800,
        height: 1000,
        durationMs: null,
        originalFilename: "boro_on.png",
        createdAt: NOW,
      },
      {
        id: "asset_side",
        brandId: "brand_1",
        kind: "image",
        source: "upload",
        objectKey: "k2",
        mimeType: "image/png",
        bytes: 10,
        sha256: "b".repeat(64),
        width: 800,
        height: 1000,
        durationMs: null,
        originalFilename: "boro sol etiket.png",
        createdAt: NOW,
      },
    );
    const prod = await ex.execute("get_product", { product: "@boro" });
    expect(prod.isError, JSON.stringify(prod.data)).toBe(false);
    expect(prod.data).toMatchObject({
      product: { id: "prod_boro", mention: "@boro", notes: "Etiketteki yazı değişmesin." },
      photos: [
        { assetId: "asset_front", position: 0, angleHint: "ön" },
        { assetId: "asset_side", position: 1, angleHint: "sol, etiket" },
      ],
    });
    const listed = await ex.execute("list_products", {});
    expect(listed.data).toMatchObject({
      products: [
        { id: "prod_boro", mention: "@boro", photos: 2 },
        { id: "prod_venta", mention: "@venta-boro" },
      ],
    });
  });

  it("the designer gets the named products' facts", async () => {
    const { api } = createFakeApi({ products: [product()] });
    const facts = await productFacts(
      api,
      "brand_1",
      ["prod_boro", "gone"],
      new AbortController().signal,
    );
    expect(facts).toContain("Boro: Sıvı bor gübresi; kategori: Gübre; etiketler: bor");
    expect(await productFacts(api, "brand_1", ["gone"], new AbortController().signal)).toBeNull();
  });
});

describe("chat prompt", () => {
  it("shows the brand's engine and style and the mentioned products and posts", () => {
    const context: TurnContext = {
      run: fakeRun(),
      conversation: {
        id: "conv_1",
        brandId: "brand_1",
        title: "",
        status: "active",
        activeRunId: "run_1",
        lastSeq: 1,
        agentSession: null,
        lastActivityAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      brand: fakeBrand({ id: "brand_1", defaultEngine: "html", imageStylePreset: "vintage" }),
      brandProfile: null,
      messages: [],
      messagesTruncated: false,
      assets: [],
      openPlan: null,
      assistantMessage: null,
      mentionedProducts: [
        {
          mention: "boro",
          product: product(),
          photos: [
            {
              assetId: "asset_front",
              mimeType: "image/png",
              width: 800,
              height: 1000,
              filename: "boro_on.png",
              position: 0,
              angleHint: "ön",
              caption: null,
              tags: [],
              text: "BORO %15",
            },
          ],
        },
      ],
      mentionedContents: [{ mention: "hasat-bayrami", content: post({ pendingApprovals: 1 }) }],
    };
    const meta = buildConversationMetadataBlock({
      context,
      now: new Date(NOW),
      brands: [],
      images: [],
    });
    expect(meta).toContain("varsayılan motor: HTML (html)");
    expect(meta).toContain("görsel stili: vintage");
    expect(meta).toContain("<anilan_urunler>");
    expect(meta).toContain("- @boro → Boro (id: prod_boro)");
    expect(meta).toContain("assetId asset_front: kapak; açı: ön; 800x1000; boro_on.png");
    expect(meta).toContain('yazı: "BORO %15"');
    expect(meta).toContain('- @hasat-bayrami → "Hasat Bayramı" (id: cnt_hasat');
    expect(meta).toContain("1 onay bekliyor");

    const noDefault = buildConversationMetadataBlock({
      context: { ...context, brand: fakeBrand({ id: "brand_1" }) },
      now: new Date(NOW),
      brands: [],
      images: [],
    });
    expect(noDefault).toContain("varsayılan motor: yok (post üretmeden önce sor)");
  });
});
