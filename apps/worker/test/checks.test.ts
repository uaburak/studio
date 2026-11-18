import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Content, ContentCheckResult, ContentVersion, Job } from "@studio/contract";
import type { LayerMetrics, LintIssue, LintReport } from "@studio/design-kit/lint";
import { getPreset, type PlatformPreset } from "@studio/design-kit/presets";
import { createRenderer, isChromiumAvailable } from "@studio/design-kit/render";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { deterministicFindings, withPasses } from "../src/checks/deterministic.ts";
import { slideFixFor } from "../src/checks/fixes.ts";
import { createContentCheckHandler } from "../src/checks/handler.ts";
import { type ModelCaller, modelResults } from "../src/checks/model.ts";
import {
  type ChecksDeps,
  runContentChecks,
  type SlideReport,
  slideTexts,
} from "../src/checks/pipeline.ts";
import {
  characterCount,
  findBannedWords,
  limitHashtags,
  splitCaption,
  trimCaption,
} from "../src/checks/text.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeRunner } from "../src/claude/runner.ts";
import { buildBrandContext } from "../src/generate/brand.ts";
import type { SlideRenderer } from "../src/generate/pipeline.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const KIT_FIXTURES = fileURLToPath(
  new URL("../../../packages/design-kit/test/fixtures/", import.meta.url),
);
const typographic = readFileSync(path.join(KIT_FIXTURES, "slides/typographic.html"), "utf8");
const preset = getPreset("instagram-feed-portrait") as PlatformPreset;
const settings = { disabledChecks: [], bannedWords: [], strictness: "standard" as const };

function report(issues: Partial<LintIssue>[], layers: Partial<LayerMetrics>[] = []): LintReport {
  const full = issues.map((i) => ({
    rule: "text-overlap",
    severity: "error" as const,
    layer: null,
    message: "x",
    ...i,
  }));
  return {
    schema: "studio.lint/1",
    kit: "0",
    contract: "v1",
    artboard: { width: 1080, height: 1350 },
    ok: !full.some((i) => i.severity === "error"),
    summary: {
      errors: full.filter((i) => i.severity === "error").length,
      warnings: full.filter((i) => i.severity === "warning").length,
      info: full.filter((i) => i.severity === "info").length,
    },
    stages: { static: true, layout: true, pixel: true, render: true },
    issues: full,
    layers: layers.map((l) => ({
      id: "x",
      type: "text",
      role: null,
      parent: null,
      rect: null,
      visible: true,
      ...l,
    })),
  } as LintReport;
}

const headlineMetrics = (rect: { x: number; y: number; w: number; h: number }) => ({
  id: "headline",
  type: "text",
  role: "headline",
  rect,
  text: {
    lines: 2,
    fontSize: 96,
    minFontSize: 96,
    weight: "800",
    family: "Helvetica Neue",
    color: "rgb(21, 21, 21)",
    textRect: rect,
    chars: 20,
  },
});

describe("caption and copy helpers", () => {
  it("splits, trims and limits captions", () => {
    expect(splitCaption("Merhaba\n\n#a #b\n#c")).toEqual({
      body: "Merhaba",
      hashtags: ["#a", "#b", "#c"],
    });
    const long = `${"Toprak canlıdır. ".repeat(200)}\n\n#venta #bor`;
    const trimmed = trimCaption(long, 2_200);
    expect(characterCount(trimmed)).toBeLessThanOrEqual(2_200);
    expect(trimmed.endsWith("#venta #bor")).toBe(true);
    expect(trimmed).toContain("canlıdır.\n\n#venta");
    expect(trimCaption("kısa", 2_200)).toBe("kısa");

    const tags = Array.from({ length: 35 }, (_, i) => `#t${i}`).join(" ");
    expect(splitCaption(limitHashtags(`Gövde #t0\n\n${tags} #T1`, 30)).hashtags).toHaveLength(29);
  });

  it("matches banned words with Turkish case and suffixes", () => {
    const hits = findBannedWords("İLAÇSIZ üretim, ücretsizdir ve garanti ederiz!", [
      "ilaçsız",
      "Ücretsiz",
      "garanti etmek",
      "bedava",
    ]);
    expect(hits.map((h) => [h.word, h.match])).toEqual([
      ["ilaçsız", "İLAÇSIZ"],
      ["Ücretsiz", "ücretsizdir"],
    ]);
    expect(findBannedWords("garanti ederiz", ["garanti"]).map((h) => h.match)).toEqual(["garanti"]);
    expect(findBannedWords("dengarantisiz", ["garanti"])).toEqual([]);
  });
});

describe("deterministic checks", () => {
  const base = {
    contentType: "post" as const,
    platforms: ["instagram" as const],
    title: "Venta",
    brief: "Ürünü tanıt, bor ve çinko vurgusu, web adresiyle bitir.",
    carousel: null,
    captionNumbers: [],
    palette: ["#151515", "#FFFFFF", "#2F5D50"],
    preset,
    settings,
  };

  it("maps lint findings, caption limits, banned words and the brief to checks", () => {
    const slide = {
      index: 0,
      width: 1080,
      height: 1350,
      jpegBytes: 300_000,
      failure: null,
      texts: [{ layer: "body", role: "body", text: "Ücretsiz kargo" }],
      report: report(
        [
          { rule: "safe-area", severity: "warning", layer: "headline", data: { overflow: 30 } },
          {
            rule: "contrast",
            severity: "error",
            layer: "body",
            data: { median: 2.1, required: 4.5 },
          },
          { rule: "widow", severity: "warning", layer: "headline" },
          { rule: "slot-empty", severity: "info", layer: "photo" },
          { rule: "numbers-unchecked", severity: "info", layer: null },
        ],
        [
          { id: "body", text: { color: "rgb(255, 0, 0)" } as LayerMetrics["text"] },
          { id: "logo", type: "logo", rect: { x: 900, y: 1200, w: 60, h: 20 } },
        ],
      ),
    };
    const caption = `${"a".repeat(2_300)}\n\n${Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ")} #t1`;
    const results = deterministicFindings({
      ...base,
      caption,
      slides: [slide],
      settings: { ...settings, bannedWords: ["ücretsiz"] },
      platforms: [],
      brief: "kısa",
    });
    const byCheck = (id: string) => results.filter((r) => r.checkId === id);
    expect(byCheck("layout.safe-area")[0]).toMatchObject({
      status: "warn",
      refs: [{ slide: 0, layer: "headline" }],
      evidence: { rule: "safe-area", overflow: 30 },
    });
    expect(byCheck("layout.safe-area")[0]?.message).toContain("güvenli alanın 30 px dışında");
    expect(byCheck("layout.contrast")[0]).toMatchObject({ status: "fail" });
    expect(byCheck("layout.contrast")[0]?.message).toContain("2.1:1");
    expect(byCheck("layout.legibility").map((r) => r.evidence?.rule)).toEqual(["widow"]);
    expect(byCheck("brand.colors")[0]?.message).toContain("#FF0000");
    expect(byCheck("visual.logo-legibility")).toHaveLength(1);
    expect(byCheck("text.caption-length")[0]).toMatchObject({ status: "fail" });
    expect(byCheck("text.hashtags").map((r) => r.status)).toEqual(["fail", "warn"]);
    expect(byCheck("text.banned-words")).toHaveLength(1);
    expect(byCheck("text.banned-words")[0]?.refs).toEqual([{ slide: 0, layer: "body" }]);
    expect(
      byCheck("brief.completeness")
        .map((r) => r.evidence?.rule)
        .sort(),
    ).toEqual(["brief-short", "no-platform", "slot-empty"]);

    // Relaxed drops cosmetic rules; switched-off checks never report.
    const relaxed = deterministicFindings({
      ...base,
      caption: "Kısa açıklama.",
      slides: [slide],
      settings: { ...settings, strictness: "relaxed", disabledChecks: ["layout.contrast"] },
    });
    expect(relaxed.some((r) => r.evidence?.rule === "widow")).toBe(false);
    expect(relaxed.some((r) => r.checkId === "layout.contrast")).toBe(false);
    expect(relaxed.some((r) => r.checkId === "brand.colors")).toBe(false);

    // Every check that ran gets a pass row when it found nothing.
    const rows = withPasses(relaxed, ["layout.overflow", "layout.safe-area"]);
    expect(rows.find((r) => r.checkId === "layout.overflow")).toMatchObject({ status: "pass" });
    expect(rows.filter((r) => r.checkId === "layout.safe-area").map((r) => r.status)).toEqual([
      "warn",
    ]);
  });

  it("reports slides that could not be rendered", () => {
    const results = deterministicFindings({
      ...base,
      caption: "Açıklama",
      slides: [
        {
          index: 1,
          width: 1080,
          height: 1350,
          report: null,
          failure: "boom",
          jpegBytes: null,
          texts: [],
        },
      ],
    });
    expect(results[0]).toMatchObject({
      checkId: "visual.resolution",
      status: "fail",
      refs: [{ slide: 1, layer: null }],
    });
  });
});

describe("automatic fixes", () => {
  const ctx = (rep: LintReport) => ({
    html: typographic,
    report: rep,
    width: 1080,
    height: 1350,
    safe: preset.safeArea,
    colors: { ink: "#151515", paper: "#FFFFFF" },
  });

  it("moves a layer into the safe area, shrinks overflowing text, recolours poor contrast", () => {
    const outside = report([], [headlineMetrics({ x: 20, y: 300, w: 600, h: 200 })]);
    const move = slideFixFor(
      {
        checkId: "layout.safe-area",
        refs: [{ slide: 0, layer: "headline" }],
        evidence: { rule: "safe-area" },
      },
      ctx(outside),
    );
    expect(move).toMatchObject({
      kind: "move",
      op: { op: "transform", layer: "headline", translate: { x: 46, y: 0 } },
    });

    const tooWide = report([], [headlineMetrics({ x: 0, y: 300, w: 1060, h: 200 })]);
    const shrink = slideFixFor(
      { checkId: "layout.safe-area", refs: [{ slide: 0, layer: "headline" }], evidence: null },
      ctx(tooWide),
    );
    expect(shrink?.kind).toBe("shrink");
    expect((shrink?.op as { fontSize: number } | undefined)?.fontSize).toBeLessThan(96);

    const overflow = report(
      [],
      [
        {
          ...headlineMetrics({ x: 100, y: 300, w: 600, h: 200 }),
          text: {
            ...headlineMetrics({ x: 0, y: 0, w: 0, h: 0 }).text,
            textRect: { x: 100, y: 300, w: 600, h: 320 },
          },
        },
      ],
    );
    const fit = slideFixFor(
      {
        checkId: "layout.overflow",
        refs: [{ slide: 0, layer: "headline" }],
        evidence: { rule: "text-overflow-box" },
      },
      ctx(overflow),
    );
    expect(fit?.op).toMatchObject({ op: "setTypography", layer: "headline" });
    expect((fit?.op as { fontSize: number } | undefined)?.fontSize).toBe(72);

    const recolor = slideFixFor(
      {
        checkId: "layout.contrast",
        refs: [{ slide: 0, layer: "body" }],
        evidence: { rule: "contrast", background: "rgb(250,250,250)", required: 4.5 },
      },
      ctx(report([])),
    );
    expect(recolor?.op).toMatchObject({ op: "setColor", value: { token: "ink" } });

    // Text overlap has no automatic fix.
    expect(
      slideFixFor(
        {
          checkId: "layout.overflow",
          refs: [{ slide: 0, layer: "headline" }],
          evidence: { rule: "text-overlap" },
        },
        ctx(overflow),
      ),
    ).toBeNull();
  });
});

describe("model pass results", () => {
  const input = {
    brandName: "Venta",
    language: "tr",
    voice: "",
    skills: "",
    facts: null,
    products: [],
    content: {
      type: "post",
      platforms: ["instagram"],
      title: "t",
      brief: "b",
      caption: "Topraginiz için en iyi gübre.",
    },
    slides: [{ index: 0, texts: [{ layer: "headline", role: "headline", text: "Bor ve çinko" }] }],
    checks: ["text.language", "accuracy.claims"] as const,
    strictness: "standard" as const,
  };

  it("keeps findings that quote the post, places them and drops invented ones", () => {
    const rows = modelResults(
      {
        findings: [
          {
            check: "text.language",
            severity: "fail",
            where: "caption",
            quote: "Topraginiz",
            message: "Yazım hatası.",
            suggestion: "Toprağınız",
          },
          {
            check: "accuracy.claims",
            severity: "warn",
            where: "slide-9:x",
            quote: "en iyi gübre",
            message: "Desteklenmeyen üstünlük iddiası.",
            suggestion: "",
          },
          {
            check: "text.language",
            severity: "fail",
            where: "caption",
            quote: "olmayan metin",
            message: "x",
            suggestion: "",
          },
          { check: "brand.voice", severity: "fail", where: "caption", quote: "", message: "y" },
        ],
      },
      { ...input, checks: [...input.checks] },
      "gemini-2.5-flash-lite",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      checkId: "text.language",
      status: "fail",
      source: "model",
      refs: [],
      evidence: { quote: "Topraginiz", suggestion: "Toprağınız" },
    });
    expect(rows[0]?.message).toContain("Öneri: Toprağınız");
    expect(rows[1]).toMatchObject({ checkId: "accuracy.claims", status: "warn", refs: [] });

    const relaxed = modelResults(
      {
        findings: [
          {
            check: "text.language",
            severity: "fail",
            where: "slide-1:headline",
            quote: "Bor",
            message: "m",
          },
        ],
      },
      { ...input, checks: [...input.checks], strictness: "relaxed" },
      "m",
    );
    expect(relaxed[0]).toMatchObject({ status: "warn", refs: [{ slide: 0, layer: "headline" }] });
  });
});

// --- pipeline -----------------------------------------------------------------------------------

async function jpeg(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toBuffer(),
  );
}

function setup(options: { caption?: string; html?: string; renderer?: SlideRenderer } = {}) {
  const { api, state } = createFakeApi({ brands: [fakeBrand()] });
  const content: Content = {
    id: "content_1",
    brandId: "brand_1",
    type: "post",
    title: "Venta Borinc",
    brief: "Ürünü tanıt; bor ve çinko vurgusu, web adresiyle bitir.",
    status: "draft",
    targetPlatforms: ["instagram"],
    caption: options.caption ?? "Venta Borinc ile toprağınız güçlenir.\n\n#venta",
    currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) },
    approval: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.contents.set(content.id, content);
  const version: ContentVersion = {
    id: "ver_1",
    contentId: content.id,
    version: 1,
    origin: "generated",
    contentHash: "a".repeat(64),
    slideCount: 1,
    note: null,
    jobId: "job_gen",
    createdAt: NOW,
    updatedAt: NOW,
    slides: [
      {
        html: options.html ?? typographic,
        width: 1080,
        height: 1350,
        renderedAssetId: "asset_r1",
        layers: null,
      },
    ],
  };
  state.versions.push(version);
  const renders: string[] = [];
  const renderer: SlideRenderer = options.renderer ?? {
    async renderAndLint(req) {
      renders.push(req.html);
      expect(req.lint?.safeArea).toEqual(preset.safeArea);
      return {
        jpeg: await jpeg(),
        pixelWidth: 1080,
        pixelHeight: 1350,
        deviceScaleFactor: 1,
        network: { blocked: [], missing: [] },
        served: [],
        timings: { contextMs: 1, loadMs: 1, assetsMs: 1, screenshotMs: 1, encodeMs: 1, totalMs: 5 },
        report: report([], [headlineMetrics({ x: 66, y: 300, w: 600, h: 200 })]),
      };
    },
  };
  const calls: string[] = [];
  const runner: ClaudeRunner = async () => {
    calls.push("claude");
    throw new Error("Claude is not used here");
  };
  const deps: ChecksDeps = {
    api,
    gate: new ClaudeGate({ runner }),
    settings: loadAgentSettings({}),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-checks-")),
    renderer: () => renderer,
    checkModelCaller: null,
  };
  const brand = buildBrandContext({ brand: fakeBrand(), profile: null, api, cacheDir: tmpdir() });
  return { api, state, deps, brand, renders, calls };
}

const outsideReport = () =>
  report(
    [{ rule: "safe-area", severity: "warning", layer: "headline", data: { overflow: 44 } }],
    [headlineMetrics({ x: 20, y: 300, w: 600, h: 200 })],
  );

describe("check pipeline", () => {
  it("fixes a layer outside the safe area into a new version and stores both runs", async () => {
    const { state, deps, brand, renders } = setup();
    const res = await runContentChecks({
      deps,
      jobId: "job_gen",
      trigger: "generate",
      contentId: "content_1",
      version: 1,
      brand,
      reports: new Map<number, SlideReport>([[0, { report: outsideReport(), jpegBytes: 200_000 }]]),
      fix: "auto",
      signal: new AbortController().signal,
    });

    // One render of the fixed slide, a new manual_edit version with the move.
    expect(renders).toHaveLength(1);
    expect(renders[0]).toMatch(/translate:\s*46px 0px/);
    expect(state.versionCreates).toHaveLength(1);
    expect(state.versionCreates[0]).toMatchObject({
      origin: "manual_edit",
      jobId: "job_gen",
      renderedAssetIds: ["asset_gen_1"],
    });
    expect(state.versionCreates[0]?.note).toContain("Kontroller: otomatik düzeltme (v1 üzerine)");
    expect(res.fixedVersion?.version).toBe(2);

    // Runs: v1 with the problem (fixed in v2), v2 with the "fixed" row.
    expect(
      state.checkRuns.map((r) => [r.version, r.trigger, r.fixedVersion, r.fromVersion]),
    ).toEqual([
      [1, "generate", 2, null],
      [2, "fix", null, 1],
    ]);
    const v1 = state.checkRuns[0]?.results ?? [];
    expect(v1.find((r) => r.checkId === "layout.safe-area")).toMatchObject({
      status: "warn",
      fixable: true,
    });
    const v2 = state.checkRuns[1]?.results ?? [];
    const fixed = v2.find((r) => r.checkId === "layout.safe-area");
    expect(fixed).toMatchObject({ status: "fixed", refs: [{ slide: 0, layer: "headline" }] });
    expect(fixed?.message).toContain("güvenli alana taşındı");
    // Model checks are skipped without a model; everything else passes.
    expect(v2.find((r) => r.checkId === "text.language")).toMatchObject({ status: "skipped" });
    expect(v2.find((r) => r.checkId === "layout.overflow")).toMatchObject({ status: "pass" });
    expect(res.brief).toMatchObject({ version: 2, fixedVersion: 2, blocking: 0 });
    expect(res.brief.highlights[0]).toMatchObject({ checkId: "layout.safe-area", status: "fixed" });
  });

  it("does not fix when the brand switched automatic fixes off", async () => {
    const { state, deps, brand } = setup();
    state.checkSettings.set("brand_1", {
      brandId: "brand_1",
      disabledChecks: [],
      bannedWords: [],
      strictness: "strict",
      autoFix: false,
      updatedAt: NOW,
    });
    const res = await runContentChecks({
      deps,
      jobId: "job_gen",
      trigger: "generate",
      contentId: "content_1",
      version: 1,
      brand,
      reports: new Map([[0, { report: outsideReport() }]]),
      fix: "auto",
      signal: new AbortController().signal,
    });
    expect(state.versionCreates).toHaveLength(0);
    // Strict: the warning blocks approval.
    expect(res.brief).toMatchObject({ version: 1, fixedVersion: null, blocking: 1 });
    expect(state.checkRuns[0]).toMatchObject({ strictness: "strict", blocking: 1 });
  });

  it("trims a caption over the limit without a new version", async () => {
    const long = `${"Toprak canlıdır ve beslenmek ister. ".repeat(80)}\n\n#venta`;
    const { state, deps, brand } = setup({ caption: long });
    const res = await runContentChecks({
      deps,
      jobId: "job_chk",
      trigger: "fix",
      contentId: "content_1",
      brand,
      reports: new Map([[0, { report: report([]) }]]),
      fix: ["text.caption-length"],
      signal: new AbortController().signal,
    });
    expect(res.captionFixed).toBe(true);
    expect(state.versionCreates).toHaveLength(0);
    const stored = state.contents.get("content_1")?.caption ?? "";
    expect(characterCount(stored)).toBeLessThanOrEqual(2_200);
    expect(stored.endsWith("#venta")).toBe(true);
    const run = state.checkRuns[0];
    expect(run?.results.find((r) => r.checkId === "text.caption-length")).toMatchObject({
      status: "fixed",
    });
  });

  it("runs the model pass with the post's text and stamps what it read", async () => {
    const { state, deps, brand } = setup();
    const seen: string[] = [];
    const caller: ModelCaller = async (req) => {
      seen.push(req.content[0]?.type === "text" ? req.content[0].text : "");
      expect(req.system).toContain("text.language");
      return {
        model: "gemini-2.5-flash-lite",
        output: {
          findings: [
            {
              check: "text.language",
              severity: "fail",
              where: "caption",
              quote: "toprağınız güçlenir",
              message: "Örnek bulgu.",
              suggestion: "",
            },
          ],
        },
      };
    };
    const res = await runContentChecks({
      deps: { ...deps, checkModelCaller: caller },
      jobId: "job_chk",
      trigger: "manual",
      contentId: "content_1",
      brand,
      reports: new Map([[0, { report: report([]) }]]),
      signal: new AbortController().signal,
    });
    expect(seen[0]).toContain("caption:\nVenta Borinc ile toprağınız güçlenir.");
    expect(seen[0]).toContain("slide-1:headline");
    const run = state.checkRuns[0];
    expect(run?.model).toBe("gemini-2.5-flash-lite");
    expect(run?.results.find((r) => r.checkId === "text.language")).toMatchObject({
      status: "fail",
      source: "model",
    });
    const voice = run?.results.find((r) => r.checkId === "brand.voice");
    expect(voice).toMatchObject({ status: "pass", source: "model" });
    expect(typeof voice?.evidence?.textHash).toBe("string");
    expect(res.brief.blocking).toBe(1);

    // An edit render that kept the text carries the model results over (no call).
    const carry = await runContentChecks({
      deps: { ...deps, checkModelCaller: caller },
      jobId: "job_render",
      trigger: "render",
      contentId: "content_1",
      version: 1,
      brand,
      reports: new Map([[0, { report: report([]) }]]),
      carryOver: { run: run as NonNullable<typeof run>, unchangedSlides: new Set() },
      model: false,
      signal: new AbortController().signal,
    });
    expect(seen).toHaveLength(1);
    expect(carry.run?.results.find((r) => r.checkId === "text.language")).toMatchObject({
      status: "fail",
    });
  });

  it("content.check runs on demand and reports the brief", async () => {
    const { deps } = setup();
    const handler = createContentCheckHandler(deps);
    const job: Job = {
      id: "job_chk",
      type: "content.check",
      status: "running",
      payload: {},
      brandId: "brand_1",
      contentId: "content_1",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const ctx: JobContext = {
      jobId: job.id,
      job,
      attempt: 1,
      workerId: "mac",
      signal: new AbortController().signal,
      progress: () => {},
      log: () => {},
    };
    const out = await handler.run({}, ctx);
    expect(out).toMatchObject({
      contentId: "content_1",
      version: 1,
      runId: "check_1",
      captionFixed: false,
      checks: { version: 1, blocking: 0 },
    });
  });

  it("finds the slide texts the model and the banned words read", () => {
    expect(slideTexts(typographic).map((t) => t.layer)).toEqual(
      expect.arrayContaining(["eyebrow", "headline", "body", "web"]),
    );
    const rows: ContentCheckResult[] = [];
    expect(withPasses(rows, ["brief.completeness"])).toHaveLength(1);
  });
});

const chromiumAvailable = await isChromiumAvailable();

describe.skipIf(!chromiumAvailable || process.env.STUDIO_SKIP_RENDER === "1")(
  "check pipeline with Chromium",
  () => {
    const renderer = createRenderer({ timeoutMs: 30_000 });
    afterAll(() => renderer.close());

    it("measures a real render and moves a headline back into the safe area", async () => {
      const shifted = typographic.replace(
        'data-layer="headline"',
        'data-layer="headline" style="translate: -110px 0px"',
      );
      const { state, deps, brand } = setup({ html: shifted, renderer });
      const res = await runContentChecks({
        deps,
        jobId: "job_chk",
        trigger: "fix",
        contentId: "content_1",
        brand,
        fix: true,
        signal: new AbortController().signal,
      });
      const v1 = state.checkRuns[0]?.results ?? [];
      const before = v1.find(
        (r) => r.checkId === "layout.safe-area" && r.refs[0]?.layer === "headline",
      );
      expect(before).toMatchObject({ fixable: true });
      expect(res.fixedVersion?.version).toBe(2);
      expect(state.versionCreates[0]?.slides[0]?.html).not.toContain("translate: -110px 0px");
      const v2 = state.checkRuns[1]?.results ?? [];
      expect(
        v2.filter(
          (r) =>
            r.checkId === "layout.safe-area" &&
            r.refs[0]?.layer === "headline" &&
            (r.status === "warn" || r.status === "fail"),
        ),
      ).toEqual([]);
      expect(v2.find((r) => r.status === "fixed")?.message).toContain("güvenli alana taşındı");
    });
  },
);
