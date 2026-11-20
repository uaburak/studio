import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BrandProfile, Content, ConversationAlias, Job } from "@studio/contract";
import type { LintReport } from "@studio/design-kit/lint";
import { createRenderer, isChromiumAvailable } from "@studio/design-kit/render";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { AiPolicy } from "../src/ai/policy.ts";
import { ClaudeError, ClaudeUsageLimitError } from "../src/claude/errors.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeCallOptions, ClaudeCallResult, ClaudeRunner } from "../src/claude/runner.ts";
import { buildBrandContext, fileAssetMap, NEUTRAL_TOKENS } from "../src/generate/brand.ts";
import { type ContentGenerateDeps, createContentGenerateHandler } from "../src/generate/handler.ts";
import { presetFor, type SlideRenderer, slideBounds } from "../src/generate/pipeline.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const KIT_FIXTURES = fileURLToPath(
  new URL("../../../packages/design-kit/test/fixtures/", import.meta.url),
);
const kit = (rel: string) => path.join(KIT_FIXTURES, rel);
const typographic = readFileSync(kit("slides/typographic.html"), "utf8");

/** Venta tokens + facts with every brand file mapped to a fake asset id (served by the fake API). */
function ventaProfile(): { profile: BrandProfile; files: Map<string, Uint8Array> } {
  const tokens = JSON.parse(readFileSync(kit("venta/brand.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const facts = JSON.parse(readFileSync(kit("venta/facts.json"), "utf8"));
  const fileAssets: Record<string, string> = {};
  const files = new Map<string, Uint8Array>();
  for (const dir of ["fonts", "logos", "assets"]) {
    for (const name of readdirSync(kit(`venta/${dir}`))) {
      if (!/\.(woff2|png)$/.test(name)) continue;
      const id = `file_${dir}_${name}`.replace(/[^A-Za-z0-9_-]/g, "_");
      fileAssets[`${dir}/${name}`] = id;
      files.set(id, new Uint8Array(readFileSync(kit(`venta/${dir}/${name}`))));
    }
  }
  return {
    files,
    profile: {
      id: "prof_1",
      brandId: "brand_1",
      version: 2,
      status: "approved",
      isCurrent: true,
      tokens: { ...tokens, status: "provisional", fileAssets, facts },
      designRules: "DESIGN.md",
      voice: "VOICE.md",
      createdAt: NOW,
      updatedAt: NOW,
      approvedAt: NOW,
    },
  };
}

function content(overrides: Partial<Content> = {}): Content {
  return {
    id: "content_1",
    brandId: "brand_1",
    type: "post",
    title: "Venta Borinc tanıtım",
    brief: "Ürünü tanıt.",
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

function jobFor(payload: Record<string, unknown>): Job {
  return {
    id: "job_gen",
    type: "content.generate",
    status: "running",
    payload,
    brandId: "brand_1",
    contentId: "content_1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function ctxFor(job: Job): { ctx: JobContext; progress: string[] } {
  const progress: string[] = [];
  return {
    progress,
    ctx: {
      jobId: job.id,
      job,
      attempt: 1,
      workerId: "mac",
      signal: new AbortController().signal,
      progress: (_v, m) => progress.push(m ?? ""),
      log: () => {},
    },
  };
}

function designResult(html: string, slides = 1): ClaudeCallResult {
  const output = {
    slides: Array.from({ length: slides }, (_, i) => ({ id: `slide-${i + 1}`, html })),
    caption: "Venta Borinc. Bor ve çinko bir arada. #venta",
    rationale: "Tek fikir.",
    critique: [{ issue: "x", severity: "low", fix: "y" }],
    changes: [],
  };
  return {
    output,
    text: "",
    model: "claude-opus-5-5",
    cliVersion: "2.1.292",
    usage: {
      inputTokens: 5,
      outputTokens: 4000,
      cacheReadTokens: 30_000,
      cacheWriteTokens: 10_000,
      costUsd: 0.4,
      durationMs: 60_000,
      durationApiMs: 59_000,
      wallMs: 61_000,
    },
    rateLimit: undefined,
  };
}

function report(errors: number): LintReport {
  return {
    schema: "studio.lint/1",
    kit: "0",
    contract: "v1",
    artboard: { width: 1080, height: 1350 },
    ok: errors === 0,
    summary: { errors, warnings: 1, info: 0 },
    stages: { static: true, layout: true, pixel: true, render: true },
    issues: Array.from({ length: errors }, () => ({
      rule: "text-overlap",
      severity: "error" as const,
      layer: "headline",
      message: "overlap",
    })),
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

function makeDeps(
  api: ContentGenerateDeps["api"],
  runner: ClaudeRunner,
  renderer: SlideRenderer,
  env: Record<string, string> = {},
): ContentGenerateDeps {
  return {
    api,
    gate: new ClaudeGate({ runner }),
    settings: loadAgentSettings(env),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-gen-")),
    renderer: () => renderer,
    // The checks' model pass has its own tests (checks.test.ts).
    checkModelCaller: null,
  };
}

const photoAlias: ConversationAlias = {
  id: "alias_1",
  conversationId: "conv_1",
  alias: "image",
  previousAliases: [],
  assetId: "asset_photo",
  kind: "image",
  mimeType: "image/png",
  width: 1200,
  height: 1200,
  filename: "venta-borinc.png",
  contentPath: "/api/assets/asset_photo/content",
  messageId: "msg_1",
  createdAt: NOW,
  updatedAt: NOW,
};

describe("brand context", () => {
  it("builds brand.css, facts and resolvable brand files from an approved profile", async () => {
    const { profile, files } = ventaProfile();
    const { api, state } = createFakeApi();
    for (const [id, bytes] of files)
      state.assets.set(id, { bytes, contentType: "application/octet-stream" });
    const brand = buildBrandContext({
      brand: fakeBrand(),
      profile,
      api,
      cacheDir: mkdtempSync(path.join(tmpdir(), "brand-cache-")),
    });
    expect(brand.mode).toBe("provisional");
    expect(brand.fontFamilies).toEqual(["Archivo", "Montserrat"]);
    expect(brand.allowedNumbers).toContain("3b");
    expect(brand.logos.map((l) => l.path)).toContain(
      "/brand/logos/venta-wordmark-black.standin.png",
    );
    expect(brand.promptTokens).not.toHaveProperty("fileAssets");
    expect(brand.promptTokens).not.toHaveProperty("facts");
    const css = await brand.resolver.resolve("/brand/brand.css");
    expect(new TextDecoder().decode(css?.body)).toContain("font-family: 'Archivo'");
    const font = await brand.resolver.resolve("/brand/fonts/archivo-latin-wdth-normal.woff2");
    expect(font?.contentType).toBe("font/woff2");
    expect(await brand.resolver.resolve("/brand/fonts/missing.woff2")).toBeNull();
  });

  it("falls back to a labelled neutral default without an approved profile", () => {
    const { api } = createFakeApi();
    const brand = buildBrandContext({ brand: fakeBrand(), profile: null, api, cacheDir: tmpdir() });
    expect(brand).toMatchObject({ mode: "neutral", allowedNumbers: [], logos: [], facts: null });
    expect(brand.label).toContain("nötr");
    expect(brand.fallbackReason).toBe("markanın onaylı bir profili yok");
    expect(brand.fontFamilies).toEqual([NEUTRAL_TOKENS.font.text.family]);
  });

  it("reads the file map defensively", () => {
    expect(
      fileAssetMap({ fileAssets: { "fonts/a.woff2": "x", "../etc/passwd": "y", "b.png": 3 } }),
    ).toEqual({
      "fonts/a.woff2": "x",
    });
  });
});

describe("presets and slide counts", () => {
  it("uses Instagram 4:5 by default and the platform presets otherwise", () => {
    expect(presetFor("post", []).id).toBe("instagram-feed-portrait");
    expect(presetFor("carousel", ["linkedin"]).id).toBe("linkedin-feed-portrait");
    expect(presetFor("post", ["facebook", "instagram"]).id).toBe("instagram-feed-portrait");
    expect(presetFor("story", ["facebook"]).id).toBe("facebook-story");
    expect(slideBounds("post", "5 slayt")).toEqual({ min: 1, max: 1 });
    expect(slideBounds("carousel", "4 slaytlık bir anlatım")).toEqual({ min: 4, max: 4 });
    expect(slideBounds("carousel", "depolama ipuçları")).toEqual({ min: 3, max: 6 });
  });

  // Slide-count requests set the count; images being uploaded / attached do not.
  it.each([
    ["10 slaytlık carousel", 10],
    ["5 slayt", 5],
    ["7 sayfalık bir anlatım", 7],
    ["6 kartlık seri", 6],
    ["8 görsellik carousel", 8],
    ["5 görselli carousel", 5],
    ["6 görsel carousel hazırla", 6],
    ["10 görselden oluşan bir carousel", 10],
    ["carousel 4 görsel olsun", 4],
    ["a 7-slide carousel", 7],
    ["7 slides about soil", 7],
    ["5 slide'lık anlatım", 5],
    ["Bunu 5 slaytta anlat", 5],
    ["5 tane slayt olsun", 5],
    ["SEKİZ değil 8 SLAYTLIK", 8],
    ["5 slaytlık carousel ekle", 5],
    ["10 görsel yükleyeceğim, 5 slaytlık carousel yap", 5],
    ["3 fotoğraf ekledim, 6 kartlık carousel hazırla", 6],
    ["5 slayt, 3 fotoğraf ekledim", 5],
    ["2026 yılı için 5 slayt", 5],
    ["12 slayt", 10],
    ["1 slayt", 2],
    ["10 görsel yükleyeceğim", null],
    ["10 görsel yükleyeceğim, bunlardan carousel yap", null],
    ["3 fotoğraf ekledim", null],
    ["5 görsel gönderdim", null],
    ["10 görseli yükledim", null],
    ["10 tane görsel attım", null],
    ["4 görsel paylaşacağım", null],
    ["8 görsel var elimde", null],
    ["4 kart ekledim", null],
    ["5 slayt yükledim", null],
    ["5 slides uploaded", null],
    ["depolama ipuçları", null],
  ] as const)("slideBounds(carousel, %j) -> %s", (brief, count) => {
    expect(slideBounds("carousel", brief)).toEqual(
      count === null ? { min: 3, max: 6 } : { min: count, max: count },
    );
  });
});

describe("content.generate handler (fake renderer)", () => {
  it("generates, critiques, revises, uploads renders and stores a generated version", async () => {
    const { profile, files } = ventaProfile();
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    for (const [id, bytes] of files)
      state.assets.set(id, { bytes, contentType: "application/octet-stream" });
    state.profiles.set("brand_1", profile);
    state.contents.set("content_1", content());
    state.aliases.set("conv_1", [photoAlias]);
    state.assets.set("asset_photo", {
      bytes: new Uint8Array(readFileSync(kit("venta/assets/product-venta-borinc.png"))),
      contentType: "image/png",
    });
    // Brand skills: the enabled one reaches the design prompt and the version note.
    const skillBase = {
      brandId: "brand_1",
      description: "Venta ürün postları",
      origin: "manual" as const,
      createdAt: NOW,
      updatedAt: NOW,
    };
    state.skills.push(
      {
        ...skillBase,
        id: "skill_1",
        name: "venta-urun",
        body: "# Ürün postu\n- Ürün sağda, başlık solda.",
        enabled: true,
        version: 2,
      },
      { ...skillBase, id: "skill_2", name: "kapali", body: "# Kapalı", enabled: false, version: 1 },
    );

    const calls: ClaudeCallOptions[] = [];
    const runner: ClaudeRunner = async (options) => {
      calls.push(options);
      return designResult(typographic);
    };
    const rendered: string[] = [];
    let renders = 0;
    const renderer: SlideRenderer = {
      async renderAndLint(req) {
        renders++;
        rendered.push(req.html);
        const media = await req.resolver?.resolve("/media/asset_photo.png");
        expect(media?.contentType).toBe("image/png");
        expect(req.lint?.allowedNumbers).toContain("3b");
        expect(req.lint?.brandFonts).toEqual(["Archivo", "Montserrat"]);
        expect(req.lint?.safeArea).toEqual({ top: 64, right: 64, bottom: 64, left: 64 });
        // first pass has errors, the revision is clean
        const errors = renders === 1 ? 2 : 0;
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
          report: report(errors),
        };
      },
    };
    const handler = createContentGenerateHandler(makeDeps(api, runner, renderer));
    const job = jobFor({
      brandId: "brand_1",
      contentId: "content_1",
      title: "Venta Borinc tanıtım",
      brief: "Ürünü ambalajıyla tanıt.",
      type: "post",
      targetPlatforms: ["instagram"],
      imageSlot: "user_upload",
      imageBrief: "@image — Ürün ambalajı fotoğrafı",
      planItem: { planId: "plan_1", itemId: "item_0", date: "2026-11-18", pillar: "ürün tanıtımı" },
      conversationId: "conv_1",
      brandProfileVersion: 2,
    });
    const { ctx, progress } = ctxFor(job);
    const out = await handler.run(job.payload as never, ctx);

    expect(calls.map((c) => c.label)).toEqual([
      "content-ontent_1-generate",
      "content-ontent_1-revise",
    ]);
    // Generate call: system prompt has the contract and the brand; the user image is attached.
    expect(calls[0]?.system).toContain("<design_contract>");
    expect(calls[0]?.system).toContain("PROFILE STATUS: PROVISIONAL");
    expect(calls[0]?.system).toContain("/brand/logos/venta-wordmark-black.standin.png");
    expect(calls[0]?.system).toContain('<skill name="venta-urun" version="2"');
    expect(calls[0]?.system).not.toContain("kapali");
    const genText = calls[0]?.content[0];
    expect(genText?.type === "text" && genText.text).toContain("FILLED state");
    expect(genText?.type === "text" && genText.text).toContain(
      "/media/asset_photo.png (@image, 1200x1200)",
    );
    expect(calls[0]?.content.filter((b) => b.type === "image")).toHaveLength(1);
    // Revise call: render attached, lint report included.
    const revText = calls[1]?.content[0];
    expect(revText?.type === "text" && revText.text).toContain("<linter_report>");
    expect(calls[1]?.content.filter((b) => b.type === "image")).toHaveLength(1);

    expect(renders).toBe(2);
    expect(state.uploads).toEqual([
      {
        brandId: "brand_1",
        kind: "image",
        source: "generated",
        width: 1080,
        height: 1350,
        bytes: expect.any(Number),
      },
    ]);
    expect(state.versionCreates).toHaveLength(1);
    const created = state.versionCreates[0];
    expect(created).toMatchObject({
      origin: "generated",
      jobId: "job_gen",
      renderedAssetIds: ["asset_gen_1"],
    });
    expect(created?.slides[0]).toMatchObject({ width: 1080, height: 1350 });
    expect(created?.note).toContain("geçici marka profili v2");
    expect(created?.note).toContain("Skill'ler: venta-urun v2.");
    expect(state.contentUpdates).toEqual([
      { caption: "Venta Borinc. Bor ve çinko bir arada. #venta" },
    ]);
    expect(out).toMatchObject({
      contentId: "content_1",
      version: 1,
      lintClean: true,
      calls: 2,
      finalPass: "v2",
      preset: "instagram-feed-portrait",
      media: ["@image"],
      brandSkills: ["venta-urun v2"],
      brandProfile: { mode: "provisional", version: 2 },
      passes: [
        { pass: "v1", errors: 2 },
        { pass: "v2", errors: 0 },
      ],
    });
    expect(progress).toContain("Görseller yükleniyor");
    // The generation checks ran on the stored version (no model in this test).
    expect(progress).toContain("Kontroller çalışıyor");
    expect(out).toMatchObject({ checks: { version: 1, fixedVersion: null } });
    expect(state.checkRuns.map((r) => [r.version, r.trigger])).toEqual([[1, "generate"]]);
  });

  it("revises an existing version with the user's instruction in one call (ai_edit)", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set(
      "content_1",
      content({
        caption: "Eski açıklama",
        currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) },
      }),
    );
    const baseHtml = typographic.replace(
      "</main>",
      '<img data-layer="photo-x" data-type="image" src="/media/asset_user.jpg" alt=""></main>',
    );
    state.versions.push({
      id: "ver_1",
      contentId: "content_1",
      version: 1,
      origin: "manual_edit",
      contentHash: "a".repeat(64),
      slideCount: 1,
      note: null,
      jobId: null,
      createdAt: NOW,
      updatedAt: NOW,
      slides: [
        {
          html: baseHtml,
          width: 1080,
          height: 1350,
          renderedAssetId: "asset_render_v1",
          layers: null,
        },
      ],
    });
    state.assets.set("asset_render_v1", { bytes: await jpeg(), contentType: "image/jpeg" });
    state.assets.set("asset_user", { bytes: await jpeg(), contentType: "image/jpeg" });

    const calls: ClaudeCallOptions[] = [];
    const runner: ClaudeRunner = async (options) => {
      calls.push(options);
      return designResult(baseHtml.replace("</main>", "<!-- edited --></main>"));
    };
    let mediaResolved = false;
    const renderer: SlideRenderer = {
      async renderAndLint(req) {
        mediaResolved = (await req.resolver?.resolve("/media/asset_user.jpg")) != null;
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
          report: {
            ...report(1),
            layers: [
              {
                id: "headline",
                type: "text",
                role: "headline",
                parent: null,
                rect: { x: 64, y: 80, w: 900, h: 200 },
                visible: true,
              },
            ],
          } as LintReport,
        };
      },
    };
    const handler = createContentGenerateHandler(makeDeps(api, runner, renderer));
    const job = jobFor({
      brandId: "brand_1",
      contentId: "content_1",
      brief: "Ürünü tanıt.",
      type: "post",
      baseVersion: 1,
      instructions: "Başlığı biraz küçült",
    });
    const { ctx } = ctxFor(job);
    const out = await handler.run(job.payload as never, ctx);

    // One edit call (lint errors alone do not trigger fix passes), with the base render attached.
    expect(calls.map((c) => c.label)).toEqual(["content-ontent_1-edit"]);
    const text = calls[0]?.content[0];
    expect(text?.type === "text" && text.text).toContain("Başlığı biraz küçült");
    expect(text?.type === "text" && text.text).toContain("Eski açıklama");
    expect(text?.type === "text" && text.text).toContain('src="/media/asset_user.jpg"');
    expect(calls[0]?.content.filter((b) => b.type === "image")).toHaveLength(1);
    expect(mediaResolved).toBe(true);

    const created = state.versionCreates[0];
    expect(created).toMatchObject({ origin: "ai_edit", jobId: "job_gen" });
    expect(created?.note).toContain("AI düzenleme (v1 üzerine): Başlığı biraz küçült");
    expect(created?.slides[0]?.html).toContain("<!-- edited -->");
    expect(created?.slides[0]?.html).toContain('src="/media/asset_user.jpg"');
    expect(created?.layouts).toEqual([
      [
        {
          id: "headline",
          type: "text",
          role: "headline",
          parent: null,
          x: 64,
          y: 80,
          w: 900,
          h: 200,
          visible: true,
        },
      ],
    ]);
    expect(out).toMatchObject({
      version: 2,
      baseVersion: 1,
      revised: true,
      calls: 1,
      finalPass: "edit",
    });
  });

  it("runs a fix pass while errors remain and reuses a version stored by an earlier attempt", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set("content_1", content({ type: "carousel" }));
    let calls = 0;
    const runner: ClaudeRunner = async () => {
      calls++;
      return designResult(typographic, 3);
    };
    let renders = 0;
    const renderer: SlideRenderer = {
      async renderAndLint() {
        renders++;
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
          // errors until the fix pass (renders 7..9)
          report: report(renders <= 6 ? 1 : 0),
        };
      },
    };
    const handler = createContentGenerateHandler(makeDeps(api, runner, renderer));
    const job = jobFor({ brief: "Depolama ipuçları", type: "carousel" });
    const out = await handler.run(job.payload as never, ctxFor(job).ctx);
    expect(calls).toBe(3); // generate, revise, fix
    expect(out).toMatchObject({ slides: 3, finalPass: "fix1", lintClean: true });
    expect(state.uploads).toHaveLength(3);
    expect(out.brandProfile).toMatchObject({ mode: "neutral", version: null });
    expect(state.versionCreates[0]?.note).toContain("nötr varsayılan");

    // Same job again (a retried attempt): nothing is generated twice.
    const again = await handler.run(job.payload as never, ctxFor(job).ctx);
    expect(again).toMatchObject({ reused: true, version: 1 });
    expect(calls).toBe(3);
  });

  it("gives the HTML engine the named products' photos as pictures (imageSlot stays none)", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set("content_1", content({ title: "Venta Boro" }));
    const cover = new Uint8Array(
      await sharp({ create: { width: 900, height: 1200, channels: 3, background: "#2e5e46" } })
        .jpeg()
        .toBuffer(),
    );
    const side = new Uint8Array(readFileSync(kit("venta/assets/product-venta-borinc.png")));
    state.assets.set("asset_cover", { bytes: cover, contentType: "image/jpeg" });
    state.assets.set("asset_side", { bytes: side, contentType: "image/png" });
    state.products.push({
      id: "prod_boro",
      brandId: "brand_1",
      name: "Venta Boro",
      slug: "venta-boro",
      description: "Sıvı bor gübresi",
      category: null,
      tags: [],
      notes: null,
      imageAssetIds: ["asset_cover", "asset_side"],
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    // The model places the cover photo as an image layer.
    const withPhoto = typographic.replace(
      "</main>",
      '<img data-layer="product-photo" data-type="image" src="/media/asset_cover.jpg" alt="Venta Boro" style="position:absolute; left:640px; top:700px; width:360px; height:480px; object-fit:contain">\n  </main>',
    );
    const calls: ClaudeCallOptions[] = [];
    const runner: ClaudeRunner = async (options) => {
      calls.push(options);
      return designResult(withPhoto);
    };
    const rendered: string[] = [];
    const renderer: SlideRenderer = {
      async renderAndLint(req) {
        rendered.push(req.html);
        expect((await req.resolver?.resolve("/media/asset_cover.jpg"))?.body).toEqual(cover);
        expect((await req.resolver?.resolve("/media/asset_side.png"))?.body).toEqual(side);
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
          report: report(0),
        };
      },
    };
    const handler = createContentGenerateHandler(makeDeps(api, runner, renderer));
    const job = jobFor({
      brandId: "brand_1",
      contentId: "content_1",
      title: "Venta Boro",
      brief: "Venta Boro tanıtım postu. Ürünün kendi fotoğrafını kullan.",
      type: "post",
      imageSlot: "none",
      engine: "html",
      productIds: ["prod_boro"],
    });
    const out = await handler.run(job.payload as never, ctxFor(job).ctx);

    const gen = calls[0]?.content[0];
    const text = gen?.type === "text" ? gen.text : "";
    expect(text).toContain("Product photos");
    expect(text).toContain("/media/asset_cover.jpg (Venta Boro (kapak), 900x1200)");
    expect(text).toContain("/media/asset_side.png (Venta Boro (2. fotoğraf), 1200x1200)");
    // imageSlot "none": no empty or AI slot is asked for; the product photos are pictures.
    expect(text).toContain("no empty image slot");
    expect(text).not.toContain("EMPTY image slot");
    // The product's facts still come with the instructions.
    expect(text).toContain("Sıvı bor gübresi");
    // The cover is shown to the model, labelled as the product's photo.
    const blocks = calls[0]?.content ?? [];
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
    expect(
      blocks.some(
        (b) =>
          b.type === "text" &&
          b.text.startsWith('Product photo "Venta Boro (kapak)" = /media/asset_cover.jpg'),
      ),
    ).toBe(true);
    // The sanitiser keeps the product photo; the stored version shows it.
    expect(rendered[0]).toContain('src="/media/asset_cover.jpg"');
    expect(state.versionCreates[0]?.slides[0]?.html).toContain('src="/media/asset_cover.jpg"');
    expect(out).toMatchObject({
      media: [],
      productPhotos: ["/media/asset_cover.jpg", "/media/asset_side.png"],
    });
    expect(out).not.toHaveProperty("slotImages");
  });

  it("generates reels via the video engine and supports Gemini fallback when Claude is unavailable", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set("content_1", content({ type: "reel", title: "Hasat Zamanı" }));

    const coverPng = new Uint8Array(
      await sharp({ create: { width: 1080, height: 1920, channels: 3, background: "#16301A" } })
        .png()
        .toBuffer(),
    );
    const deps: ContentGenerateDeps = {
      ...makeDeps(
        api,
        async () => {
          throw new Error("Claude should not be called when Gemini fallback handles it");
        },
        {
          renderAndLint: async () => {
            throw new Error("static renderer unused for reel");
          },
        },
        { GEMINI_API_KEY: "fake-gemini-key" },
      ),
      health: () => ({ state: "limited", message: "Claude limit dolu", checkedAt: NOW }),
      geminiFetch: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        hook: "Toprakta doğru denge",
                        scenes: [
                          {
                            eyebrow: "MTM Agro",
                            headline: "Toprakta doğru denge",
                            subhead: "Sezon hazırlığı",
                            durationSec: 2,
                          },
                          {
                            eyebrow: "",
                            headline: "Detaylar açıklamada",
                            subhead: "",
                            durationSec: 2,
                          },
                        ],
                        narrationScript: "",
                        overlays: [],
                        cta: "mtmagro.com",
                        caption: "Sezon hazırlığı. #mtmagro",
                        durationSec: 4,
                      }),
                    },
                  ],
                },
              },
            ],
            modelVersion: "gemini-2.5-flash",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      reelSeams: {
        frameCapturer: async function* () {
          yield coverPng;
        },
        ffmpeg: async () => ({
          stdout: new TextEncoder().encode("FAKE_MP4"),
          stderr: "",
        }),
      },
    };

    const handler = createContentGenerateHandler(deps);
    const job = jobFor({ brief: "Hareketli grafik Reels", type: "reel" });
    const out = await handler.run(job.payload as never, ctxFor(job).ctx);

    expect(out).toMatchObject({
      contentId: "content_1",
      recipe: "motion_graphics",
      provider: "gemini",
      videoAssetId: "asset_gen_1",
      coverAssetId: "asset_gen_2",
      renderedAssetIds: ["asset_gen_2"],
    });
    expect(state.uploads.map((u) => u.kind)).toEqual(["video", "image"]);
  });
});

const chromium = await isChromiumAvailable();

describe.skipIf(!chromium || process.env.STUDIO_SKIP_RENDER === "1")(
  "content.generate with Chromium",
  () => {
    const renderer = createRenderer({ timeoutMs: 30_000 });
    afterAll(() => renderer.close());

    it("renders the spike's typographic design with brand files served from the API", async () => {
      const { profile, files } = ventaProfile();
      const { api, state } = createFakeApi({ brands: [fakeBrand()] });
      for (const [id, bytes] of files)
        state.assets.set(id, { bytes, contentType: "application/octet-stream" });
      state.profiles.set("brand_1", profile);
      state.contents.set("content_1", content());
      const handler = createContentGenerateHandler(
        makeDeps(api, async () => designResult(typographic), renderer, {
          STUDIO_DESIGN_FIX_PASSES: "0",
        }),
      );
      const job = jobFor({ brief: "Tipografik post", imageSlot: "none" });
      const out = (await handler.run(job.payload as never, ctxFor(job).ctx)) as Record<
        string,
        unknown
      > & {
        lint: { rules: string[] }[];
      };
      // The fixture uses only brand files and allowed numbers: no network or font errors.
      const rules = out.lint.flatMap((l) => l.rules);
      expect(rules).not.toContain("error:network-request");
      expect(rules).not.toContain("error:font-load");
      expect(rules).not.toContain("error:unverified-number");
      const upload = state.assets.get("asset_gen_1");
      expect(upload?.contentType).toBe("image/jpeg");
      const meta = await sharp(upload?.bytes).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([1080, 1350, "jpeg"]);
    });
  },
);

describe("Faz 4: malformed answers, Turkish errors, Claude's limit (U5, U12, S7)", () => {
  const okRenderer: SlideRenderer = {
    async renderAndLint() {
      return {
        jpeg: await jpeg(),
        pixelWidth: 1080,
        pixelHeight: 1350,
        deviceScaleFactor: 1,
        network: { blocked: [], missing: [] },
        served: [],
        timings: { contextMs: 1, loadMs: 1, assetsMs: 1, screenshotMs: 1, encodeMs: 1, totalMs: 5 },
        report: report(0),
      };
    },
  };

  it("U5: one malformed answer is asked again once with the problem, not a failed post", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set("content_1", content());
    const calls: ClaudeCallOptions[] = [];
    const runner: ClaudeRunner = async (options) => {
      calls.push(options);
      if (calls.length === 1) return { ...designResult(typographic), output: { slides: [] } };
      return designResult(typographic);
    };
    const handler = createContentGenerateHandler(makeDeps(api, runner, okRenderer));
    const job = jobFor({ brief: "Ürünü tanıt.", type: "post" });
    const out = await handler.run(job.payload as never, ctxFor(job).ctx);
    expect(calls.map((c) => c.label)).toEqual([
      "content-ontent_1-generate",
      "content-ontent_1-generate-reask",
      "content-ontent_1-revise",
    ]);
    const reask = calls[1]?.content[0];
    expect(reask?.type === "text" && reask.text).toContain("YOUR PREVIOUS ANSWER WAS REJECTED");
    expect(out).toMatchObject({ reasked: 1 });
    expect(state.versionCreates).toHaveLength(1);
  });

  it("U5/U12: two malformed answers fail with a Turkish message (details only in the log)", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set("content_1", content());
    let calls = 0;
    const runner: ClaudeRunner = async () => {
      calls++;
      throw new ClaudeError("output", "content-x: no structured output (stop: end_turn)");
    };
    const handler = createContentGenerateHandler(makeDeps(api, runner, okRenderer));
    const job = jobFor({ brief: "Ürünü tanıt.", type: "post" });
    const error = await handler.run(job.payload as never, ctxFor(job).ctx).catch((e) => e);
    expect(calls).toBe(2);
    expect((error as Error).message).toBe("Claude'un yanıtı beklenen biçimde değildi.");
  });

  it("U12: a design that cannot be rendered says which slide in Turkish", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set("content_1", content());
    const runner: ClaudeRunner = async () => designResult(typographic);
    const broken: SlideRenderer = {
      async renderAndLint() {
        throw new Error("Protocol error: Target closed");
      },
    };
    const deps = makeDeps(api, runner, broken);
    deps.settings.designFixPasses = 0;
    const handler = createContentGenerateHandler(deps);
    const job = jobFor({ brief: "Ürünü tanıt.", type: "post" });
    const error = await handler.run(job.payload as never, ctxFor(job).ctx).catch((e) => e);
    expect((error as Error).message).toContain("1. slayt görsele dönüştürülemedi");
    expect((error as Error).message).not.toMatch(/render failed|Protocol error/);
  });

  it("U12: a bad payload is refused in Turkish", async () => {
    const { api } = createFakeApi({ brands: [fakeBrand()] });
    const handler = createContentGenerateHandler(
      makeDeps(api, async () => designResult(typographic), okRenderer),
    );
    const job = { ...jobFor({ type: "post" }), payload: { nope: true } };
    await expect(handler.run(job.payload as never, ctxFor(job).ctx)).rejects.toThrow(
      /Üretim isteği eksik ya da bozuk/,
    );
  });

  it("S7 'Sor': the job waits for the owner's answer and goes on with Gemini, said on the version", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set("content_1", content());
    let claudeCalls = 0;
    const runner: ClaudeRunner = async () => {
      claudeCalls++;
      throw new ClaudeUsageLimitError("limit", new Date(Date.now() + 3_600_000), "message");
    };
    const policy = new AiPolicy();
    const deps = makeDeps(api, runner, okRenderer, { GEMINI_API_KEY: "gem-key-123456" });
    deps.gate = new ClaudeGate({
      runner,
      limitChoice: () => policy.limitChoice(),
      maxSleepChunkMs: 50,
    });
    deps.aiPolicy = policy;
    const design = {
      slides: [{ id: "slide-1", html: typographic }],
      caption: "Gemini açıklaması",
      rationale: "r",
      critique: [],
      changes: [],
    };
    deps.geminiFetch = async () =>
      new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(design) }] } }],
          modelVersion: "gemini-2.5-flash",
        }),
        { status: 200 },
      );
    const handler = createContentGenerateHandler(deps);
    const job = jobFor({ brief: "Ürünü tanıt.", type: "post" });
    const { ctx, progress } = ctxFor(job);
    const running = handler.run(job.payload as never, ctx);
    await vi.waitFor(() =>
      expect(progress.some((m) => m.includes("Seçiminiz bekleniyor"))).toBe(true),
    );
    // The owner answers "Gemini ile devam et" (the API stores it; the worker reads it again).
    policy.apply({
      claudeLimit: "ask",
      limitDecision: {
        choice: "gemini",
        until: new Date(Date.now() + 3_600_000).toISOString(),
        decidedAt: new Date().toISOString(),
      },
      budget: { monthlyUsd: null, stopAtBudget: false, spentUsd: 0, monthStart: NOW },
    });
    deps.gate.wake();
    const out = await running;
    expect(claudeCalls).toBe(1);
    expect(out).toMatchObject({ provider: "gemini", fallback: { reason: "claude_limit" } });
    expect(state.versionCreates[0]?.note).toContain(
      "Claude sınırı doldu, Gemini Flash ile üretildi.",
    );
    expect(progress.some((m) => m.includes("Gemini Flash ile sürüyor"))).toBe(true);
  });
});
