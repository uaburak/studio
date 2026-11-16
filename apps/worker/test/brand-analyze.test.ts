import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type Asset,
  BrandAnalyzePayload,
  type Content,
  type ContentVersion,
  type Job,
} from "@studio/contract";
import { parseBrandTokens } from "@studio/design-kit/brand";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { type AgentDeps, loadAgentSettings } from "../src/agent.ts";
import { createBrandAnalyzeHandler, rasterizeLogo } from "../src/brand/handler.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { silentLogger } from "../src/log.ts";
import { prepareModelImage } from "../src/media.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

function analyzeJobCtx(payload: Record<string, unknown>): JobContext {
  const job: Job = {
    id: "job_brand_1",
    type: "brand.analyze",
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

async function tinyLogoPng(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 320, height: 80, channels: 4, background: "#3E9B3A" } })
      .png()
      .toBuffer(),
  );
}

describe("brand.analyze handler", () => {
  it("analyzes brand assets + approved content edit feedback via Gemini (when Claude is limited) and produces valid @studio/design-kit BrandTokens", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });

    const logoBytes = await tinyLogoPng();
    state.assets.set("asset_logo_1", { bytes: logoBytes, contentType: "image/png" });
    const logoRecord: Asset = {
      id: "asset_logo_1",
      brandId: "brand_1",
      kind: "logo",
      source: "upload",
      objectKey: "brands/brand_1/logo.png",
      mimeType: "image/png",
      bytes: logoBytes.byteLength,
      sha256: "0".repeat(64),
      width: 320,
      height: 80,
      durationMs: null,
      originalFilename: "mtm-logo.png",
      createdAt: NOW,
    };
    const fontRecord: Asset = {
      id: "asset_font_1",
      brandId: "brand_1",
      kind: "font",
      source: "upload",
      objectKey: "brands/brand_1/montserrat.woff2",
      mimeType: "font/woff2",
      bytes: 1024,
      sha256: "1".repeat(64),
      width: null,
      height: null,
      durationMs: null,
      originalFilename: "Montserrat-Bold.woff2",
      createdAt: NOW,
    };
    state.assetRecords.push(logoRecord, fontRecord);

    // Seed an approved content item with v1 (generated) -> v2 (manual_edit where user shortened headline)
    const v1: ContentVersion = {
      id: "ver_fb_1",
      contentId: "cnt_pub",
      version: 1,
      origin: "generated",
      contentHash: "1".repeat(64),
      slideCount: 1,
      note: "Üretildi",
      jobId: null,
      createdAt: NOW,
      updatedAt: NOW,
      slides: [
        {
          html: "<html><body><h1>Çok Uzun ve Karmaşık İlk Başlık Metni</h1></body></html>",
          width: 1080,
          height: 1350,
          renderedAssetId: null,
        },
      ],
    };
    const v2: ContentVersion = {
      id: "ver_fb_2",
      contentId: "cnt_pub",
      version: 2,
      origin: "manual_edit",
      contentHash: "2".repeat(64),
      slideCount: 1,
      note: "Başlık kısaltıldı",
      jobId: null,
      createdAt: NOW,
      updatedAt: NOW,
      slides: [
        {
          html: "<html><body><h1>Net Kısa Başlık</h1></body></html>",
          width: 1080,
          height: 1350,
          renderedAssetId: null,
        },
      ],
    };
    state.versions.push(v1, v2);
    const pubContent: Content = {
      id: "cnt_pub",
      brandId: "brand_1",
      type: "post",
      title: "Güz Bakımı",
      brief: "Toprak analizi",
      status: "published",
      targetPlatforms: ["instagram"],
      caption: "Toprak analizi ile doğru gübreleme. #mtmagro",
      currentVersion: { id: "ver_fb_2", version: 2, contentHash: "2".repeat(64) },
      approval: { versionId: "ver_fb_2", contentHash: "2".repeat(64), approvedAt: NOW },
      createdAt: NOW,
      updatedAt: NOW,
    };
    state.contents.set("cnt_pub", pubContent);

    let capturedBody = "";
    const fakeGeminiFetch: typeof fetch = async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      colors: {
                        paper: { value: "#FFFFFF", use: "zemin" },
                        ink: { value: "#111A13", use: "ana metin" },
                        accent: { value: "#3E9B3A", use: "marka yeşili" },
                        "accent-deep": { value: "#1E5C1B", use: "koyu yeşil vurgu" },
                      },
                      displayFontFamily: "Montserrat",
                      textFontFamily: "Montserrat",
                      marginPx: 72,
                      designRules:
                        "# Tasarım Kuralları\n- Başlıkları 3-4 kelimeyle kısa tutun.\n- 72px sol hizalı ızgara kullanın.",
                      voice:
                        "# Ses Tonu\n- Net, teknik ve güven veren Türkçe.\n- Doğrulanmamış verim yüzdesi yazmayın.",
                      allowedNumbers: ["10", "6132"],
                      statements: ["MTM Agro bitki besleme çözümleri üretir."],
                      forbiddenClaims: ["%100 verim artışı garantisi"],
                      provisional: false,
                    }),
                  },
                ],
              },
            },
          ],
          modelVersion: "gemini-2.5-flash",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const deps: AgentDeps = {
      api,
      gate: new ClaudeGate({
        runner: async () => {
          throw new Error("Claude should not be called while limited with Gemini configured");
        },
      }),
      settings: loadAgentSettings({ GEMINI_API_KEY: "fake-brand-key" }),
      logger: silentLogger,
      health: () => ({ state: "limited", message: "limit dolu", checkedAt: NOW }),
      stateDir: mkdtempSync(path.join(tmpdir(), "worker-brand-")),
      geminiFetch: fakeGeminiFetch,
    };

    const handler = createBrandAnalyzeHandler(deps);
    const payload = {
      notes: "Tarım sektöründe sade, teknik kurumsal görünüm.",
      samplePosts: [
        { caption: "Toprak analizi neden önemlidir?", likes: 185, comments: 14 },
        { caption: "Genel duyuru", likes: 22, comments: 1 },
      ],
      includeApprovedContentFeedback: true,
      autoApprove: true,
    };

    const out = await handler.run(payload, analyzeJobCtx(payload));

    expect(out).toMatchObject({
      profileId: "prof_1",
      version: 1,
      status: "approved",
      provider: "gemini",
      visualReferencesUsed: 1,
      feedbackItemsAnalyzed: 1,
    });

    // Verify feedback loop diff and sample posts reached the model prompt
    expect(capturedBody).toContain("Çok Uzun ve Karmaşık İlk Başlık Metni");
    expect(capturedBody).toContain("Net Kısa Başlık");
    expect(capturedBody).toContain("beğeni=185");

    const current = state.profiles.get("brand_1");
    expect(current?.status).toBe("approved");
    expect(current?.designRules).toContain("Başlıkları 3-4 kelimeyle kısa tutun");
    expect(current?.voice).toContain("Net, teknik ve güven veren Türkçe");

    // Verify stored tokens pass `@studio/design-kit`'s strict BrandTokensSchema
    const parsedKitTokens = parseBrandTokens(current?.tokens);
    expect(parsedKitTokens.color.accent).toMatchObject({ value: "#3E9B3A" });
    expect(Object.keys(parsedKitTokens.logos)).toContain("mtm-logo");
    const fileAssets = (current?.tokens.fileAssets ?? {}) as Record<string, string>;
    expect(fileAssets["logos/mtm-logo.png"]).toBe("asset_logo_1");
    expect(current?.tokens.facts).toEqual({
      allowedNumbers: ["10", "6132"],
      statements: ["MTM Agro bitki besleme çözümleri üretir."],
      forbidden: ["%100 verim artışı garantisi"],
    });
  });

  it("uses the brand kit: every sample, logo backgrounds, the user's palette and fonts with licence", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const asset = (id: string, kind: Asset["kind"], name: string, mime = "image/png"): Asset => ({
      id,
      brandId: "brand_1",
      kind,
      source: "upload",
      objectKey: `brands/brand_1/${id}`,
      mimeType: mime,
      bytes: 100,
      sha256: "0".repeat(64),
      width: kind === "logo" ? 320 : 1080,
      height: kind === "logo" ? 80 : 1350,
      durationMs: null,
      originalFilename: name,
      createdAt: NOW,
    });
    const png = await tinyLogoPng();
    const records = [
      asset("s1", "image", "post-1.png"),
      asset("s2", "image", "post-2.png"),
      asset("s3", "image", "post-3.png"),
      asset("unrelated", "image", "chat-attachment.png"),
      asset("logo_light", "logo", "logo.png"),
      asset("logo_dark", "logo", "logo-negatif.png"),
      asset("font_archivo", "font", "Archivo-Bold.woff2", "font/woff2"),
    ];
    // One kit file is not in the first page of assets: the handler fetches it by id.
    const hidden = records.pop() as Asset;
    state.assetRecords.push(...records);
    const fontOnlyById = new Map([[hidden.id, hidden]]);
    const baseGet = api.client.assets.get;
    (api.client.assets as { get: typeof baseGet }).get = async (id, init) =>
      fontOnlyById.get(id) ?? baseGet(id, init);
    for (const r of records) {
      if (r.kind !== "font") state.assets.set(r.id, { bytes: png, contentType: "image/png" });
    }
    state.kits.set("brand_1", {
      brandId: "brand_1",
      logos: [
        { assetId: "logo_light", background: "light" },
        { assetId: "logo_dark", background: "dark", label: "Negatif logo" },
      ],
      fonts: [
        {
          assetId: "font_archivo",
          family: "Archivo",
          role: "display",
          licenseNote: "SIL OFL 1.1, Google Fonts",
        },
      ],
      palette: [
        { name: "accent", hex: "#FF6A00", use: "tek vurgu" },
        { name: "ink", hex: "#0A0A0A" },
      ],
      samples: [
        { assetId: "s1", caption: "Hasat başladı, tarlada ilk gün." },
        { assetId: "s2" },
        { assetId: "s3" },
      ],
      notes: "Siyah beyaz, tek turuncu vurgu.",
      updatedAt: NOW,
    });

    let capturedBody = "";
    const fakeGeminiFetch: typeof fetch = async (_url, init) => {
      capturedBody = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      colors: {
                        paper: { value: "#FFFFFF", use: "zemin" },
                        accent: { value: "#3366FF", use: "modelin tahmini" },
                      },
                      displayFontFamily: "Inter",
                      textFontFamily: "Inter",
                      marginPx: 64,
                      gutterPx: 20,
                      cornerRadiusPx: 0,
                      designRules: "# Tasarım\n- Siyah zemin, tek turuncu vurgu.",
                      voice: "# Ses\n- Kısa ve net.",
                      allowedNumbers: [],
                      statements: [],
                      forbiddenClaims: [],
                      provisional: false,
                    }),
                  },
                ],
              },
            },
          ],
          modelVersion: "gemini-2.5-flash",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const handler = createBrandAnalyzeHandler({
      api,
      gate: new ClaudeGate({
        runner: async () => {
          throw new Error("Claude should not be called while limited");
        },
      }),
      settings: loadAgentSettings({ GEMINI_API_KEY: "fake-brand-key" }),
      logger: silentLogger,
      health: () => ({ state: "limited", message: "limit dolu", checkedAt: NOW }),
      stateDir: mkdtempSync(path.join(tmpdir(), "worker-brand-kit-")),
      geminiFetch: fakeGeminiFetch,
    });
    const payload = BrandAnalyzePayload.parse({ includeApprovedContentFeedback: false });
    const out = await handler.run(payload, analyzeJobCtx(payload));

    // 3 samples + 2 logos; the unrelated chat image is not a reference.
    expect(out).toMatchObject({
      version: 1,
      status: "draft",
      visualReferencesUsed: 5,
      samplesUsed: 3,
      usedKit: true,
    });
    expect(capturedBody).toContain("örnek post 1/3");
    expect(capturedBody).toContain("Hasat başladı");
    expect(capturedBody).toContain("koyu zemin için");
    expect(capturedBody).toContain("accent: #FF6A00");
    expect(capturedBody).toContain("SIL OFL 1.1");
    expect(capturedBody).toContain("Siyah beyaz, tek turuncu vurgu.");
    expect(capturedBody).not.toContain("chat-attachment");

    const draft = state.profileHistory.at(-1);
    expect(draft?.status).toBe("draft");
    expect(state.profiles.get("brand_1")).toBeUndefined();
    const tokens = parseBrandTokens(draft?.tokens);
    // The user's palette wins over the model's guess.
    expect(tokens.color.accent).toMatchObject({ value: "#FF6A00", use: "tek vurgu" });
    expect(tokens.color.ink).toMatchObject({ value: "#0A0A0A" });
    expect(tokens.color.paper).toMatchObject({ value: "#FFFFFF" });
    expect(tokens.font.display).toMatchObject({
      family: "Archivo",
      files: ["fonts/archivo-bold.woff2"],
      license: "Archivo: SIL OFL 1.1, Google Fonts",
    });
    // No text font in the kit: the model's family for running text, no files.
    expect(tokens.font.text).toMatchObject({ family: "Inter", files: [] });
    expect(Object.values(tokens.logos).map((l) => l.on)).toEqual(["light", "dark"]);
    expect(tokens.space).toMatchObject({ margin: 64, gutter: 20 });
    expect(tokens.radius).toMatchObject({ md: 0 });
    expect(tokens.assets).toEqual({});
    const fileAssets = (draft?.tokens.fileAssets ?? {}) as Record<string, string>;
    expect(fileAssets["fonts/archivo-bold.woff2"]).toBe("font_archivo");
    expect(Object.values(fileAssets).sort()).toEqual(["font_archivo", "logo_dark", "logo_light"]);
  });

  it("marks the draft provisional when fewer than 3 samples could be read", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const png = await tinyLogoPng();
    state.assetRecords.push({
      id: "s1",
      brandId: "brand_1",
      kind: "image",
      source: "upload",
      objectKey: "k",
      mimeType: "image/png",
      bytes: 1,
      sha256: "0".repeat(64),
      width: 10,
      height: 10,
      durationMs: null,
      originalFilename: "a.png",
      createdAt: NOW,
    });
    state.assets.set("s1", { bytes: png, contentType: "image/png" });
    state.kits.set("brand_1", {
      brandId: "brand_1",
      logos: [],
      fonts: [],
      palette: [],
      samples: [{ assetId: "s1" }, { assetId: "missing_1" }, { assetId: "missing_2" }],
      notes: "",
      updatedAt: NOW,
    });
    const handler = createBrandAnalyzeHandler({
      api,
      gate: new ClaudeGate({ runner: async () => Promise.reject(new Error("no claude")) }),
      settings: loadAgentSettings({ GEMINI_API_KEY: "k" }),
      logger: silentLogger,
      health: () => ({ state: "limited", message: "", checkedAt: NOW }),
      stateDir: mkdtempSync(path.join(tmpdir(), "worker-brand-thin-")),
      geminiFetch: async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        colors: {},
                        displayFontFamily: "Inter",
                        textFontFamily: "Inter",
                        marginPx: 72,
                        designRules: "d",
                        voice: "v",
                        allowedNumbers: [],
                        statements: [],
                        forbiddenClaims: [],
                        provisional: false,
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    const payload = BrandAnalyzePayload.parse({ includeApprovedContentFeedback: false });
    const out = await handler.run(payload, analyzeJobCtx(payload));
    expect(out).toMatchObject({ samplesUsed: 1, usedKit: true });
    expect(state.profileHistory.at(-1)?.tokens.status).toBe("provisional");

    // None readable: an honest error instead of a profile from nothing.
    state.kits.set("brand_1", {
      ...(state.kits.get("brand_1") as NonNullable<ReturnType<typeof state.kits.get>>),
      samples: [{ assetId: "missing_1" }, { assetId: "missing_2" }, { assetId: "missing_3" }],
    });
    await expect(handler.run(payload, analyzeJobCtx(payload))).rejects.toThrow(
      "Örnek post görselleri okunamadı",
    );
  });

  it("renders SVG logos on their background so the model can see them", async () => {
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="80"><text x="10" y="50" font-size="40" fill="#FFFFFF">Logo</text></svg>',
    );
    expect(await prepareModelImage(svg)).toBeNull();
    const png = await rasterizeLogo(svg, "#141414");
    const prepared = await prepareModelImage(png);
    expect(prepared?.mediaType).toMatch(/^image\/(png|jpeg)$/);
    const stats = await sharp(png).stats();
    expect(stats.isOpaque).toBe(true);
    // Not an image at all: handed back untouched (and skipped later).
    const junk = new TextEncoder().encode("not an image");
    expect(await rasterizeLogo(junk, "#FFFFFF")).toBe(junk);
  });
});
