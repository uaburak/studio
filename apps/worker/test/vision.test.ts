import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Job } from "@studio/contract";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { AgentRuntime } from "../src/agent-runtime.ts";
import { AiPolicy } from "../src/ai/policy.ts";
import { loadConfig } from "../src/config.ts";
import {
  chooseAutoPosition,
  lightGains,
  meanSaliency,
  placementRect,
} from "../src/image/compose.ts";
import {
  compareLabel,
  expectedFromOwner,
  expectedFromReference,
  labelTokens,
  normalizeLabelText,
  tokenSimilarity,
  turkishDistance,
} from "../src/image/label-check.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import {
  analyzePicture,
  createMediaAnalyzeHandler,
  type MediaAnalyzeDeps,
  pictureFacts,
  toTags,
} from "../src/vision/analyze.ts";
import {
  createVisionHelper,
  findVisionHelper,
  missingVisionHelper,
  type VisionHelper,
  VisionHelperError,
} from "../src/vision/helper.ts";
import { colorName, turkishLabel } from "../src/vision/labels-tr.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";
import { fakeVision, line } from "./fake-vision.ts";

describe("label check (U9): Turkish-aware comparison", () => {
  it("normalizes case, punctuation and glued units the Turkish way", () => {
    // tr-TR: I → ı, İ → i.
    expect(normalizeLabelText("KULLANIMDA GÜVENLİK KURALLARI!")).toBe(
      "kullanımda güvenlik kuralları",
    );
    expect(normalizeLabelText("İĞDIR · ıspanak")).toBe("iğdır ıspanak");
    expect(labelTokens("Net: 25KG")).toEqual(["net", "25", "kg"]);
  });

  it("counts a lost diacritic as half a letter", () => {
    expect(turkishDistance("güvenlik", "guvenlik")).toBe(0.5);
    expect(turkishDistance("güvenlik", "göyerlik")).toBe(3);
    expect(turkishDistance("kullanımda", "kullanimda")).toBe(0.5);
    expect(tokenSimilarity("borinç", "borinc")).toBeGreaterThan(0.9);
    expect(tokenSimilarity("kurallari", "kuballari")).toBeLessThan(0.9);
  });

  it("finds a garbled label (the Venta Borinc case) and requires numbers to be exact", () => {
    const expected = ["KULLANIMDA GÜVENLİK KURALLARI", "Doz: 2-3 kg/da", "VENTA BORİNÇ"];
    const garbled = compareLabel({
      expected,
      source: "ocr",
      found: ["KULLANISMA GÖYERLİK KUBALLARI", "Doz: 2-3 kg/da", "VENTA BORINC"],
    });
    expect(garbled.status).toBe("mismatch");
    expect(garbled.missing).toEqual(["KULLANIMDA GÜVENLİK KURALLARI"]);
    expect(garbled.message).toContain("KULLANIMDA GÜVENLİK KURALLARI");

    const number = compareLabel({
      expected,
      source: "ocr",
      found: ["KULLANIMDA GÜVENLİK KURALLARI", "Doz: 2-8 kg/da", "VENTA BORİNÇ"],
    });
    expect(number.missing).toEqual(["Doz: 2-3 kg/da"]);

    const same = compareLabel({
      expected,
      source: "ocr",
      found: ["KULLANIMDA GUVENLIK KURALLARI", "Doz 2-3 kg / da", "VENTA", "BORİNÇ"],
    });
    expect(same.status).toBe("ok");
    expect(same.score).toBe(1);
  });

  it("says unreadable when the final picture shows (almost) no label, no_label when the reference had none", () => {
    expect(compareLabel({ expected: ["VENTA BORİNÇ"], source: "ocr", found: [] }).status).toBe(
      "unreadable",
    );
    expect(
      compareLabel({ expected: ["VENTA BORİNÇ GÜBRE"], source: "ocr", found: ["x"] }).status,
    ).toBe("unreadable");
    expect(compareLabel({ expected: [], source: "ocr", found: ["A"] }).status).toBe("no_label");
  });

  it("takes only the product's confident lines from the reference", () => {
    const { expected, finePrint } = expectedFromReference(
      [
        line("VENTA", { x: 0.4, y: 0.3, width: 0.2, height: 0.05 }),
        line("ince yazı", { x: 0.4, y: 0.6, width: 0.2, height: 0.005 }),
        line("bulanık", { x: 0.4, y: 0.7, width: 0.2, height: 0.05 }, 0.3),
        line("TABELA", { x: 0.01, y: 0.01, width: 0.1, height: 0.05 }),
      ],
      { x: 0.25, y: 0.2, width: 0.5, height: 0.6 },
    );
    expect(expected).toEqual(["VENTA"]);
    expect(finePrint).toEqual(["ince yazı", "bulanık"]);
    expect(expectedFromOwner("VENTA BORİNÇ\n\n  ---\nNet 25 kg ")).toEqual([
      "VENTA BORİNÇ",
      "Net 25 kg",
    ]);
  });
});

describe("placement (U9)", () => {
  it("respects position and scale, keeps aspect and stays inside the frame", () => {
    const r = placementRect(1000, 1250, 200, 300, "bottom-left", 0.5);
    expect(r.height).toBe(625);
    expect(r.width).toBe(Math.round((625 * 200) / 300));
    expect(r.top + r.height).toBeLessThanOrEqual(1250 - 20);
    expect(r.left + r.width / 2).toBeCloseTo(300, -1);
    const wide = placementRect(1000, 1000, 1000, 200, "center", 0.9);
    expect(wide.width).toBe(850);
    expect(wide.height).toBe(170);
    expect(wide.top).toBe(Math.round(520 - 85));
  });

  it("picks the emptiest spot from the saliency grid, lower centre on ties", () => {
    const empty = { objects: [], columns: 3, rows: 3, grid: new Array(9).fill(0) };
    expect(chooseAutoPosition(empty, 900, 900, 100, 100, 0.4)).toBe("bottom-center");
    // Busy bottom centre and bottom right: the bottom left is free.
    const busy = {
      objects: [],
      columns: 3,
      rows: 3,
      grid: [0.2, 0.2, 0.2, 0.2, 1, 1, 0, 1, 1],
    };
    expect(chooseAutoPosition(busy, 900, 900, 100, 100, 0.3)).toBe("bottom-left");
    expect(meanSaliency(busy, 900, 900, { left: 0, top: 600, width: 300, height: 300 })).toBe(0);
    expect(chooseAutoPosition(null, 900, 900, 100, 100, 0.4)).toBe("bottom-center");
  });

  it("keeps light gains small", () => {
    const dark = lightGains({ r: 20, g: 20, b: 30 }, { r: 240, g: 240, b: 240 });
    expect(dark.brightness).toBe(0.9);
    const warm = lightGains({ r: 200, g: 150, b: 90 }, { r: 128, g: 128, b: 128 });
    expect(warm.red).toBeGreaterThan(1);
    expect(warm.blue).toBeLessThan(1);
    expect(warm.blue).toBeGreaterThanOrEqual(0.95);
    expect(lightGains({ r: 0, g: 0, b: 0 }, { r: 10, g: 10, b: 10 })).toEqual({
      brightness: 1,
      red: 1,
      green: 1,
      blue: 1,
    });
  });
});

/** A fake `studio-vision` binary (a Node script) answering by command. */
function fakeBinary(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-vision-"));
  const file = path.join(dir, "studio-vision");
  writeFileSync(
    file,
    `#!/usr/bin/env node\nlet s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);${script}});\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

describe("studio-vision client", () => {
  it("finds the helper by STUDIO_VISION_HELPER or next to the bundled worker", () => {
    const bin = fakeBinary("");
    expect(findVisionHelper({ STUDIO_VISION_HELPER: bin }, "/nowhere")).toBe(bin);
    expect(findVisionHelper({ STUDIO_VISION_HELPER: "/missing/bin" }, "/nowhere")).toBeNull();
    // <host>/worker/main.js → <host>/bin/studio-vision
    const host = path.dirname(bin);
    const bundled = path.join(host, "bin");
    mkdirSync(bundled, { recursive: true });
    copyFileSync(bin, path.join(bundled, "studio-vision"));
    chmodSync(path.join(bundled, "studio-vision"), 0o755);
    expect(findVisionHelper({}, path.join(host, "worker"))).toBe(
      path.join(bundled, "studio-vision"),
    );
  });

  it("runs a request, reports helper errors by code and survives bad output", async () => {
    const bin = fakeBinary(`
      if (r.command === "version") { console.log(JSON.stringify({ok:true,command:"version",helperVersion:"9",timingMs:1,result:{helperVersion:"9",os:"x",ocrLanguages:["tr-TR"],foregroundMask:true,featurePrintRevision:2}})); return; }
      if (r.command === "ocr") { console.log(JSON.stringify({ok:true,command:"ocr",helperVersion:"9",timingMs:1,result:{languages:r.languages,unsupportedLanguages:[],lines:[{text:"MERHABA",confidence:1,box:{x:0,y:0,width:1,height:1}}],text:"MERHABA"}})); return; }
      if (r.command === "foreground-mask") { console.log(JSON.stringify({ok:false,command:r.command,helperVersion:"9",timingMs:1,error:{code:"no_foreground",message:"yok"}})); process.exit(1); }
      process.stdout.write("garbage");
    `);
    const helper = createVisionHelper({ bin, logger: silentLogger });
    expect(await helper.available()).toBe(true);
    expect((await helper.info())?.helperVersion).toBe("9");
    const ocr = await helper.ocr("/x.png");
    expect(ocr.text).toBe("MERHABA");
    expect(ocr.languages).toEqual(["tr-TR", "en-US"]);
    await expect(helper.foregroundMask("/x.png", "/y.png")).rejects.toMatchObject({
      name: "VisionHelperError",
      code: "no_foreground",
    });
    await expect(helper.classify("/x.png")).rejects.toMatchObject({ code: "bad_output" });
  });

  it("kills a helper that hangs and is honest when there is none", async () => {
    const bin = fakeBinary("setTimeout(() => {}, 60_000);");
    const helper = createVisionHelper({ bin, logger: silentLogger });
    await expect(helper.ocr("/x.png", { timeoutMs: 300 })).rejects.toMatchObject({
      code: "timeout",
    });
    const none = missingVisionHelper();
    expect(await none.available()).toBe(false);
    await expect(none.ocr("/x.png")).rejects.toBeInstanceOf(VisionHelperError);
    await expect(none.ocr("/x.png")).rejects.toThrow(/swift build/);
  });
});

describe("media tagging (N12): what sharp and Vision see", () => {
  it("maps Vision identifiers to Turkish and names colours", () => {
    expect(turkishLabel("wheat")).toBe("buğday");
    expect(turkishLabel("rice_field")).toBe("çeltik tarlası");
    expect(turkishLabel("formula_one_car")).toBe("formula one car");
    expect(colorName(250, 250, 250)).toBe("beyaz");
    expect(colorName(10, 10, 10)).toBe("siyah");
    expect(colorName(200, 30, 30)).toBe("kırmızı");
    expect(colorName(30, 140, 50)).toBe("yeşil");
    expect(colorName(30, 60, 200)).toBe("mavi");
    expect(colorName(240, 200, 20)).toBe("sarı");
    expect(colorName(120, 70, 30)).toBe("kahverengi");
    expect(colorName(128, 128, 128)).toBe("gri");
  });

  it("keeps the strongest Turkish tags, one per word", () => {
    const tags = toTags([
      { identifier: "car", confidence: 0.5 },
      { identifier: "automobile", confidence: 0.6 },
      { identifier: "outdoor", confidence: 0.3 },
      { identifier: "noise", confidence: 0.05 },
    ]);
    expect(tags.map((t) => [t.id, t.label])).toEqual([
      ["automobile", "otomobil"],
      ["outdoor", "dış mekân"],
    ]);
  });

  it("reads colours, shape, cutouts and logo-likeness", async () => {
    // A logo: transparent background, one green mark.
    const logo = await sharp({
      create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 150, height: 150, channels: 4, background: "#1a8f3a" },
          })
            .png()
            .toBuffer(),
          left: 75,
          top: 75,
        },
      ])
      .png()
      .toBuffer();
    const facts = await pictureFacts(new Uint8Array(logo));
    expect(facts).toMatchObject({ orientation: "square", isCutout: true });
    expect(facts.colors[0]).toMatchObject({ name: "yeşil" });
    const analysis = await analyzePicture(
      {
        api: createFakeApi().api,
        logger: silentLogger,
        settings: loadAgentSettings({}),
        stateDir: mkdtempSync(path.join(tmpdir(), "worker-vision-")),
        vision: missingVisionHelper(),
      },
      new Uint8Array(logo),
    );
    expect(analysis).toMatchObject({
      status: "partial",
      isCutout: true,
      isLogoLike: true,
      orientation: "square",
    });
    expect(analysis.note).toMatch(/studio-vision/);

    // A noisy landscape photo: no cutout, not logo-like.
    const w = 120;
    const h = 60;
    const raw = Buffer.alloc(w * h * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 7919) % 251;
    const photo = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
      .jpeg()
      .toBuffer();
    const photoFacts = await pictureFacts(new Uint8Array(photo));
    expect(photoFacts).toMatchObject({ orientation: "landscape", isCutout: false, aspectRatio: 2 });
    const broken = await analyzePicture(
      {
        api: createFakeApi().api,
        logger: silentLogger,
        settings: loadAgentSettings({}),
        stateDir: tmpdir(),
        vision: missingVisionHelper(),
      },
      new Uint8Array([1, 2, 3]),
    );
    expect(broken.status).toBe("failed");
  });
});

function analyzeCtx(brandId: string | undefined): JobContext {
  const job: Job = {
    id: "job_media_1",
    type: "media.analyze",
    status: "running",
    ...(brandId ? { brandId } : {}),
    payload: {},
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

async function pngOf(color: string, w = 64, h = 48): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: w, height: h, channels: 3, background: color } })
      .png()
      .toBuffer(),
  );
}

function deps(
  api: MediaAnalyzeDeps["api"],
  vision: VisionHelper,
  extra: Partial<MediaAnalyzeDeps> = {},
) {
  return {
    api,
    logger: silentLogger,
    settings: loadAgentSettings({ GEMINI_API_KEY: "k-123456" }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-media-")),
    vision,
    ...extra,
  } satisfies MediaAnalyzeDeps;
}

describe("media.analyze job (N12)", () => {
  it("reads every waiting picture of the brand and stores Turkish tags, text and colours", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    for (const [id, color] of [
      ["a1", "#d4a017"],
      ["a2", "#1f6f2f"],
    ] as const) {
      state.assets.set(id, { bytes: await pngOf(color), contentType: "image/png" });
      state.assetRecords.push({
        id,
        brandId: "brand_1",
        kind: "image",
        source: "upload",
        objectKey: `k/${id}`,
        mimeType: "image/png",
        bytes: 10,
        sha256: "0".repeat(64),
        width: 64,
        height: 48,
        durationMs: null,
        originalFilename: `${id}.png`,
        createdAt: NOW,
      });
    }
    const vision = fakeVision({
      analyze: {
        classify: {
          labels: [
            { identifier: "wheat", confidence: 0.81 },
            { identifier: "agriculture", confidence: 0.52 },
          ],
        },
        ocr: {
          languages: ["tr-TR"],
          unsupportedLanguages: [],
          lines: [
            line("GÜNEŞ TARIM", { x: 0, y: 0, width: 1, height: 0.2 }),
            line("??", { x: 0, y: 0.5, width: 1, height: 0.1 }, 0.1),
          ],
          text: "",
        },
        featurePrint: { revision: 2, count: 1, data: "AACAPw==" },
        errors: {},
      },
    });
    const out = await createMediaAnalyzeHandler(deps(api, vision)).run(
      { reason: "upload", includePartial: false },
      analyzeCtx("brand_1"),
    );
    expect(out).toMatchObject({ analyzed: 2, complete: 2, visionHelper: true });
    const stored = state.analyses.get("a1");
    expect(stored).toMatchObject({
      status: "complete",
      text: "GÜNEŞ TARIM",
      orientation: "landscape",
      featurePrint: { revision: 2 },
      tags: [
        { id: "wheat", label: "buğday" },
        { id: "agriculture", label: "tarım" },
      ],
    });
    expect(stored?.colors?.[0]?.name).toBe("sarı");
    expect(state.analyses.get("a2")?.colors?.[0]?.name).toBe("yeşil");
    // Nothing left: a second run reads nothing.
    const again = await createMediaAnalyzeHandler(deps(api, vision)).run(
      { reason: "backfill", includePartial: false },
      analyzeCtx(undefined),
    );
    expect(again).toMatchObject({ analyzed: 0 });
  });

  it("without the helper stores a partial analysis, and records a missing file as failed", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.assets.set("ok", { bytes: await pngOf("#ffffff"), contentType: "image/png" });
    for (const id of ["ok", "gone"]) {
      state.assetRecords.push({
        id,
        brandId: "brand_1",
        kind: "image",
        source: "upload",
        objectKey: `k/${id}`,
        mimeType: "image/png",
        bytes: 10,
        sha256: "0".repeat(64),
        width: null,
        height: null,
        durationMs: null,
        originalFilename: null,
        createdAt: NOW,
      });
    }
    const out = await createMediaAnalyzeHandler(deps(api, missingVisionHelper())).run(
      { reason: "upload", includePartial: true },
      analyzeCtx("brand_1"),
    );
    expect(out).toMatchObject({ analyzed: 2, partial: 1, failed: 1, visionHelper: false });
    expect(String(out.note)).toMatch(/studio-vision/);
    expect(state.analyses.get("ok")).toMatchObject({ status: "partial" });
    expect(state.analyses.get("gone")).toMatchObject({ status: "failed" });
  });

  it("adds an AI caption only when the owner turned it on and the budget allows", async () => {
    const policy = new AiPolicy();
    const settings = (mediaCaptions: boolean, monthlyUsd: number | null, spentUsd = 0) => ({
      claudeLimit: "ask" as const,
      limitDecision: null,
      budget: { monthlyUsd, stopAtBudget: false, spentUsd, monthStart: NOW },
      mediaCaptions,
    });
    let calls = 0;
    const geminiFetch: typeof fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: '{"caption":"Tarlada buğday çuvalı."}' }] } }],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
        }),
        { status: 200 },
      );
    };
    const vision = fakeVision({ analyze: { errors: {} } });
    const { api } = createFakeApi();
    const bytes = await pngOf("#aa8844");
    const run = () => analyzePicture(deps(api, vision, { aiPolicy: policy, geminiFetch }), bytes);

    expect((await run()).caption).toBeNull();
    expect(calls).toBe(0);
    policy.apply(settings(true, null));
    expect((await run()).caption).toBe("Tarlada buğday çuvalı.");
    expect(calls).toBe(1);
    policy.apply(settings(true, 5, 5));
    expect((await run()).caption).toBeNull();
    expect(calls).toBe(1);
  });

  it("queues the one-time backfill at start only when the Vision helper is there", async () => {
    const make = (vision: VisionHelper) => {
      const { api, state } = createFakeApi();
      const runtime = new AgentRuntime({
        config: loadConfig({
          STUDIO_WORKER_ID: "mac",
          STUDIO_STATE_DIR: mkdtempSync(path.join(tmpdir(), "worker-rt-")),
        }),
        settings: loadAgentSettings({}),
        logger: silentLogger,
        api,
        runner: async () => {
          throw new Error("unused");
        },
        selfTest: async () => ({ state: "ok", message: "ok", checkedAt: NOW }),
        recheckIntervalMs: 0,
        vision,
      });
      return { runtime, state };
    };
    const withHelper = make(fakeVision());
    await withHelper.runtime.startMediaBackfill();
    expect(withHelper.state.backfills).toEqual([{ includePartial: true }]);
    const without = make(missingVisionHelper());
    await without.runtime.startMediaBackfill();
    expect(without.state.backfills).toEqual([]);
  });
});
