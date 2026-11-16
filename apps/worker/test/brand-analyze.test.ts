import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Asset, Content, ContentVersion, Job } from "@studio/contract";
import { parseBrandTokens } from "@studio/design-kit/brand";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { type AgentDeps, loadAgentSettings } from "../src/agent.ts";
import { createBrandAnalyzeHandler } from "../src/brand/handler.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { silentLogger } from "../src/log.ts";
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
});
