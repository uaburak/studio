/**
 * The SVG engine (Faz 3): the sanitiser, the Chromium render with a brand font (real Chromium,
 * skipped without it), the critique → revise loop with a fake design model (no paid call) and a
 * fake renderer, the stored SVG source, a chat revision from that source, and the "AI görsel"
 * slot: marker → slot-image job → the approved picture rendered into the SVG.
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Asset,
  type BrandProfile,
  type Content,
  isEngineReady,
  isSvgSlideHtml,
  type Job,
} from "@studio/contract";
import {
  combineResolvers,
  createMemoryResolver,
  createRenderer,
  isChromiumAvailable,
  type RenderAndInspectRequest,
} from "@studio/design-kit/render";
import { sanitizeFindings } from "@studio/design-kit/sanitize";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { checkLintConfig, presetForVersion, runContentChecks } from "../src/checks/pipeline.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeCallOptions, ClaudeCallResult, ClaudeRunner } from "../src/claude/runner.ts";
import { buildBrandContext } from "../src/generate/brand.ts";
import { type ContentGenerateDeps, createContentGenerateHandler } from "../src/generate/handler.ts";
import {
  assertSafeSvgSlide,
  fillSvgSlot,
  prepareSvgSlide,
  readSvgSlide,
  SvgSlideError,
  svgSlots,
  svgSourceForModel,
  svgTexts,
} from "../src/generate/svg/document.ts";
import {
  renderSvgSlide,
  SVG_INSPECT_SCRIPT,
  type SvgInspection,
  type SvgRenderer,
} from "../src/generate/svg/render.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createContentRenderHandler, type RenderCapable } from "../src/render/handler.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const KIT_FIXTURES = fileURLToPath(
  new URL("../../../packages/design-kit/test/fixtures/", import.meta.url),
);
const kit = (rel: string) => path.join(KIT_FIXTURES, rel);

const SIZE = { width: 1080, height: 1350, lang: "tr" };

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
      tokens: { ...tokens, fileAssets, facts },
      designRules: "DESIGN.md",
      voice: "VOICE.md",
      createdAt: NOW,
      updatedAt: NOW,
      approvedAt: NOW,
    },
  };
}

async function color(hex: string, width = 64, height = 48): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: hex } })
      .png()
      .toBuffer(),
  );
}

async function jpeg(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toBuffer(),
  );
}

const svgOf = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350">${body}</svg>`;

const HEADLINE = (text: string) =>
  `<text id="headline" x="96" y="260" style="font-family: var(--font-display)" font-size="96" font-weight="800" fill="#1E3A2B"><tspan x="96" dy="0">${text}</tspan></text>`;

const SLOT =
  '<rect data-slot="ai-image" data-slot-ratio="4:3" data-slot-label="AI görsel" x="96" y="520" width="888" height="666" rx="24" fill="#E0D9C8"/>';

describe("SVG slide sanitiser", () => {
  it("removes scripts, handlers, foreignObject, links, animation and every outside reference", () => {
    const raw = `\`\`\`svg
<?xml version="1.0"?>
<!-- model note -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="500" height="600" onload="alert(1)">
  <style>@import url(https://evil.example/x.css); @font-face { font-family: X; src: url(https://evil.example/x.woff2) } .h { fill: #111; } .bg { fill: url(https://evil.example/p.svg#a) }</style>
  <script>alert(1)</script>
  <foreignObject width="10" height="10"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>
  <a href="https://evil.example"><text id="cta" class="h" x="10" y="40">Tıkla</text></a>
  <rect width="10" height="10" onclick="alert(1)"><animate attributeName="x" values="0;10" dur="1s"/></rect>
  <set attributeName="fill" to="red"/>
  <use href="https://evil.example/s.svg#x"/>
  <rect fill="url(https://evil.example/x.svg#p)" width="1" height="1"/>
  <image href="https://evil.example/x.png" width="10" height="10"/>
  <image href="data:image/png;base64,AAAA" width="10" height="10"/>
  <image xlink:href="/media/asset_ok.jpg" x="0" y="0" width="100" height="100"/>
  <image href="/media/asset_other.jpg" width="10" height="10"/>
  <image href="/brand/logos/venta-wordmark-black.standin.png" width="10" height="10"/>
  <feImage href="/media/asset_ok.jpg"/>
</svg>
\`\`\``;
    const out = prepareSvgSlide(raw, { ...SIZE, mediaIds: new Set(["asset_ok"]) });
    expect(isSvgSlideHtml(out.html)).toBe(true);
    for (const bad of [
      "<script",
      "foreignObject",
      "onload",
      "onclick",
      "<animate",
      "<set",
      "evil.example",
      "data:image",
      "@import",
      "@font-face",
      "asset_other",
      "<a ",
      "feImage",
    ])
      expect(out.html, bad).not.toContain(bad);
    // What is kept: the copy, the allowed pictures (one href spelling), the class rule, the size.
    expect(out.html).toContain('<text id="cta" class="h" x="10" y="40">Tıkla</text>');
    expect(out.html).toContain('href="/media/asset_ok.jpg"');
    expect(out.html).toContain('href="/brand/logos/venta-wordmark-black.standin.png"');
    expect(out.html).toContain(".h { fill: #111; }");
    expect(out.html).toMatch(/<svg[^>]*width="1080"[^>]*height="1350"/);
    expect(out.html).toContain('<link rel="stylesheet" href="/brand/brand.css">');
    expect(out.findings.join("\n")).toMatch(/asset_other/);
    // A second pass of design-kit's sanitiser finds nothing; the last fence passes.
    expect(sanitizeFindings(out.html, { assetPrefixes: ["/brand/", "/media/"] })).toEqual([]);
    expect(() => assertSafeSvgSlide(out.html)).not.toThrow();
    // The stored source comes back for a revision, its style inside.
    expect(readSvgSlide(out.html)?.css).toContain(".h { fill: #111; }");
    expect(svgSourceForModel(out.html)).toMatch(/^<svg[^>]*><style>/);
    expect(svgTexts(out.html)).toEqual([{ id: "cta", text: "Tıkla" }]);
  });

  it("rejects an answer without an SVG and a slide that slips past the sanitiser", () => {
    expect(() => prepareSvgSlide("<div>no svg</div>", SIZE)).toThrow(SvgSlideError);
    expect(() =>
      assertSafeSvgSlide(
        '<html><body><svg><image href="https://evil.example/x.png"/></svg></body></html>',
      ),
    ).toThrow(SvgSlideError);
    expect(() =>
      assertSafeSvgSlide('<html><body><svg><rect onmouseover="x()"/></svg></body></html>'),
    ).toThrow(/event handler/);
  });

  it("reads slot markers and fills one with a picture (rounded corners kept)", () => {
    const { html } = prepareSvgSlide(svgOf(`${HEADLINE("Hasat")}${SLOT}`), SIZE);
    expect(svgSlots([{ html }])).toEqual([
      {
        slide: 0,
        slotId: "ai-image",
        state: "empty",
        ratio: { w: 4, h: 3 },
        label: "AI görsel",
        box: { x: 96, y: 520, width: 888, height: 666 },
      },
    ]);
    const filled = fillSvgSlot(html, "ai-image", "/media/asset_pic.png");
    expect(filled.matched).toBe(true);
    expect(filled.html).toContain('<clipPath id="slot-clip-ai-image"><rect x="96" y="520"');
    expect(filled.html).toMatch(
      /<image x="96" y="520" width="888" height="666"[^>]*clip-path="url\(#slot-clip-ai-image\)"[^>]*preserveAspectRatio="xMidYMid slice" data-slot="ai-image" data-slot-state="filled" href="\/media\/asset_pic.png"><\/image>/,
    );
    expect(svgSlots([{ html: filled.html }])[0]?.state).toBe("filled");
    expect(sanitizeFindings(filled.html, { assetPrefixes: ["/brand/", "/media/"] })).toEqual([]);
    // Filled again (a re-approval): the picture changes in place.
    const again = fillSvgSlot(filled.html, "ai-image", "/media/asset_two.png");
    expect(again.html).toContain('href="/media/asset_two.png"');
    expect(again.html).not.toContain("asset_pic");
    expect(fillSvgSlot(html, "nope", "/media/x.png").matched).toBe(false);
    expect(() => fillSvgSlot(html, "ai-image", "https://evil.example/x.png")).toThrow();
  });
});

const chromium = await isChromiumAvailable();

describe.skipIf(!chromium || process.env.STUDIO_SKIP_RENDER === "1")(
  "SVG render with Chromium (brand fonts)",
  () => {
    const renderer = createRenderer({ timeoutMs: 30_000 });
    afterAll(() => renderer.close());

    it("renders the SVG with the brand's WOFF2 font, the picture, and measures the text", async () => {
      const { profile, files } = ventaProfile();
      const { api, state } = createFakeApi({ brands: [fakeBrand()] });
      for (const [id, bytes] of files)
        state.assets.set(id, { bytes, contentType: "application/octet-stream" });
      const brand = buildBrandContext({
        brand: fakeBrand(),
        profile,
        api,
        cacheDir: mkdtempSync(path.join(tmpdir(), "svg-brand-")),
      });
      expect(brand.fontFamilies).toContain("Archivo");
      const { html } = prepareSvgSlide(
        svgOf(
          `<rect width="1080" height="1350" fill="#FFFFFF"/>${HEADLINE("Hasat zamanı")}` +
            '<image href="/media/asset_pic.png" x="96" y="520" width="888" height="666" preserveAspectRatio="xMidYMid slice"/>' +
            '<text id="spill" x="900" y="1300" style="font-family: var(--font-display)" font-size="64" fill="#1E3A2B">Taşan bir satır</text>',
        ),
        SIZE,
      );
      const resolver = combineResolvers(
        brand.resolver,
        createMemoryResolver({ "/media/asset_pic.png": await color("#2255AA", 400, 300) }),
      );
      const out = await renderSvgSlide(renderer, {
        html,
        width: 1080,
        height: 1350,
        resolver,
        lint: { brandFonts: brand.fontFamilies, safeArea: 64, allowedNumbers: [] },
      });
      const meta = await sharp(out.jpeg as Uint8Array).metadata();
      expect([meta.width, meta.height, meta.format]).toEqual([1080, 1350, "jpeg"]);
      // The brand font loaded and the text uses it.
      expect(out.report.fontsLoaded).toContain("archivo");
      const headline = out.report.layers.find((l) => l.id === "headline");
      expect(headline?.text?.family).toBe("Archivo");
      expect(headline?.text?.fontSize).toBe(96);
      expect(headline?.text?.contrast?.median).toBeGreaterThan(4.5);
      const rules = out.report.issues.map((i) => `${i.rule}:${i.layer}`);
      expect(rules).not.toContain("font-load:headline");
      expect(rules).not.toContain("font-family:headline");
      expect(rules).toContain("text-outside-artboard:spill");
      expect(out.report.issues.some((i) => i.rule === "network-request")).toBe(false);
      // The picture is painted where the <image> is.
      const { data, info } = await sharp(out.jpeg as Uint8Array)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const at = (x: number, y: number) => {
        const i = (y * info.width + x) * info.channels;
        return [data[i], data[i + 1], data[i + 2]] as number[];
      };
      const [r, g, b] = at(540, 850);
      expect(b).toBeGreaterThan(140);
      expect(r).toBeLessThan(80);
      expect(g).toBeLessThan(120);
    });

    it("re-checks a stored neutral-default SVG slide without false font-load failures (real run)", async () => {
      // A brand without an approved profile: the neutral default's Helvetica Neue has no files
      // (no @font-face, so `document.fonts` never lists it as loaded) — it is an installed font.
      const { api } = createFakeApi({ brands: [fakeBrand()] });
      const brand = buildBrandContext({
        brand: fakeBrand(),
        profile: null,
        api,
        cacheDir: mkdtempSync(path.join(tmpdir(), "svg-neutral-")),
      });
      expect(brand.mode).toBe("neutral");
      expect(brand.manifest.systemFontFamilies).toEqual(["Helvetica Neue"]);
      // The slide a real SVG generation stored (content.check reported 7 font-load fails on it).
      const html = readFileSync(
        fileURLToPath(new URL("./fixtures/svg-neutral-slide.txt", import.meta.url)),
        "utf8",
      );
      const resolver = combineResolvers(
        brand.resolver,
        createMemoryResolver({
          "/media/01a1f126-31fe-7000-a9a2-677ce9736a1a.jpg": await color("#C8D8C0", 540, 565),
        }),
      );
      const preset = presetForVersion(
        { type: "post", targetPlatforms: ["instagram"] },
        { width: 1080, height: 1350 },
      );
      const out = await renderSvgSlide(renderer, {
        html,
        width: 1080,
        height: 1350,
        resolver,
        lint: checkLintConfig(brand, preset, "post", 1),
      });
      const rules = out.report.issues.map((i) => `${i.rule}:${i.layer}`);
      expect(rules.filter((r) => r.startsWith("font-"))).toEqual([]);
      expect(out.report.layers.find((l) => l.id === "headline")?.text?.family).toBe(
        "Helvetica Neue",
      );
      expect(out.report.issues.some((i) => i.rule === "network-request")).toBe(false);
    });
  },
);

// --- the engine with a fake model and a fake renderer -----------------------------------------

const usage = {
  inputTokens: 5,
  outputTokens: 50,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  durationMs: 1,
  durationApiMs: 1,
  wallMs: 1,
};
const result = (output: unknown): ClaudeCallResult => ({
  output,
  text: "",
  model: "claude-opus-5-5",
  cliVersion: "2.1.292",
  usage,
  rateLimit: undefined,
});

function design(svg: string, extra: Record<string, unknown> = {}) {
  return {
    slides: [{ id: "slide-1", svg }],
    caption: "Toprağınız kışa hazır mı?",
    hashtags: ["hasat", "#Toprak", "hasat"],
    rationale: "Tek büyük başlık.",
    critique: [],
    changes: [],
    ...extra,
  };
}

/**
 * A renderer that measures the slide from its markup: a headline reading "TAŞ…" runs off the
 * artboard (an error the critique must fix); everything else sits inside.
 */
function fakeSvgRenderer(seen: RenderAndInspectRequest[] = []): RenderCapable & SvgRenderer {
  return {
    async renderAndLint() {
      throw new Error("an SVG slide is never linted as HTML");
    },
    async renderAndInspect<T>(req: RenderAndInspectRequest) {
      seen.push(req);
      const texts = [...req.html.matchAll(/<text id="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g)].map(
        (m) => {
          const text = (m[2] ?? "").replace(/<[^>]+>/g, "").trim();
          const rect = text.startsWith("TAŞ")
            ? { x: 700, y: 180, w: 900, h: 110 }
            : { x: 96, y: 180, w: 700, h: 110 };
          return {
            id: m[1] as string,
            text,
            rect,
            fontSize: 96,
            minFontSize: 96,
            weight: "800",
            family: "Archivo, sans-serif",
            color: "rgb(30, 58, 43)",
            lines: 1,
            legal: false,
            allowOverlap: false,
            runs: [{ color: "rgb(30, 58, 43)", fontSize: 96, weight: "800", rects: [rect] }],
          };
        },
      );
      const slots = [...req.html.matchAll(/<(rect|image)\b[^>]*data-slot="([^"]+)"[^>]*>/g)].map(
        (m) => ({
          id: m[2] as string,
          state: m[1] === "image" ? "filled" : "empty",
          ratio: "4:3",
          label: "AI görsel",
          rect: { x: 96, y: 520, w: 888, h: 666 },
        }),
      );
      const inspected: SvgInspection = {
        root: { width: req.width, height: req.height },
        texts,
        images: [],
        slots,
        fonts: [{ family: "Archivo", status: "loaded" }],
      };
      return {
        jpeg: await jpeg(),
        png: await color("#ffffff", req.width, req.height),
        pixelWidth: req.width,
        pixelHeight: req.height,
        deviceScaleFactor: 1,
        network: { blocked: [], missing: [] },
        served: [],
        timings: { contextMs: 1, loadMs: 1, assetsMs: 1, screenshotMs: 1, encodeMs: 1, totalMs: 5 },
        inspected: inspected as T,
      };
    },
  };
}

function draft(overrides: Partial<Content> = {}): Content {
  return {
    id: "content_1",
    brandId: "brand_1",
    type: "post",
    title: "Kış bakımı",
    brief: "Kış öncesi toprak bakımı",
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

function setup(content: Content = draft()) {
  const { profile, files } = ventaProfile();
  const { api, state } = createFakeApi({ brands: [fakeBrand()] });
  for (const [id, bytes] of files)
    state.assets.set(id, { bytes, contentType: "application/octet-stream" });
  state.profiles.set("brand_1", profile);
  state.contents.set(content.id, content);
  return { api, state };
}

function deps(
  api: ContentGenerateDeps["api"],
  runner: ClaudeRunner,
  renderer: RenderCapable & SvgRenderer,
  env: Record<string, string> = {},
): ContentGenerateDeps {
  return {
    api,
    gate: new ClaudeGate({ runner }),
    settings: loadAgentSettings(env),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-svg-")),
    renderer: () => renderer as never,
    checkModelCaller: null,
  };
}

function job(payload: Record<string, unknown>, id = "job_svg"): { job: Job; ctx: JobContext } {
  const j: Job = {
    id,
    type: "content.generate",
    status: "running",
    payload: {
      brandId: "brand_1",
      contentId: "content_1",
      brief: "Kış öncesi toprak bakımı",
      ...payload,
    },
    brandId: "brand_1",
    contentId: "content_1",
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    job: j,
    ctx: {
      jobId: j.id,
      job: j,
      attempt: 1,
      workerId: "mac",
      signal: new AbortController().signal,
      progress: () => {},
      log: () => {},
    },
  };
}

const textOfCall = (c: ClaudeCallOptions | undefined) =>
  (c?.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => ("text" in b ? b.text : ""))
    .join("\n");

describe("the SVG engine (content.generate, engine: svg)", () => {
  it("writes the SVG, critiques it from the render and the report, stores the SVG as the version", async () => {
    const { api, state } = setup();
    const calls: ClaudeCallOptions[] = [];
    const answers = [
      design(
        svgOf(
          `<rect width="1080" height="1350" fill="#F4EFE4"/>${HEADLINE("TAŞAN başlık")}<script>alert(1)</script>`,
        ),
      ),
      design(
        svgOf(`<rect width="1080" height="1350" fill="#F4EFE4"/>${HEADLINE("Hasat zamanı")}`),
        {
          critique: [{ issue: "Başlık taşıyor", severity: "high", fix: "Kısalt" }],
          changes: ["Başlık kısaldı"],
        },
      ),
    ];
    const runner: ClaudeRunner = async (o) => {
      calls.push(o);
      return result(answers[calls.length - 1]);
    };
    const seen: RenderAndInspectRequest[] = [];
    const handler = createContentGenerateHandler(deps(api, runner, fakeSvgRenderer(seen)));
    const { job: j, ctx } = job({ engine: "svg" });
    const out = (await handler.run(j.payload as never, ctx)) as Record<string, unknown>;

    // generate → critique/revise; clean after the first revision, so no more passes.
    expect(calls.map((c) => c.label)).toEqual(["svg-generate-ontent_1", "svg-revise1-ontent_1"]);
    expect(calls[0]?.system).toContain("var(--font-display)");
    expect(calls[0]?.system).toContain("/brand/logos/venta-wordmark-black.standin.png");
    expect(calls[0]?.system).toContain("<facts_json>");
    expect(calls[0]?.webAccess).toBe(true);
    const revise = textOfCall(calls[1]);
    expect(revise).toContain("<linter_report>");
    expect(revise).toContain("text-outside-artboard");
    expect(revise).toContain("TAŞAN başlık");
    expect(calls[1]?.content.some((b) => b.type === "image")).toBe(true);
    expect(seen[0]?.inspect).toBe(SVG_INSPECT_SCRIPT);
    expect(seen[0]?.rasterCss).toContain("transparent");

    // The version: the SVG documents (the source), the renders, the caption with hashtags.
    expect(state.versionCreates).toHaveLength(1);
    const created = state.versionCreates[0];
    expect(created?.origin).toBe("generated");
    const html = created?.slides[0]?.html ?? "";
    expect(isSvgSlideHtml(html)).toBe(true);
    expect(html).toContain("Hasat zamanı");
    expect(html).not.toContain("<script");
    expect(readSvgSlide(html)?.svg).toMatch(/^<svg/);
    expect(created?.renderedAssetIds).toEqual(["asset_gen_1"]);
    expect(created?.layouts?.[0]).not.toBeNull();
    expect(state.contents.get("content_1")?.caption).toBe(
      "Toprağınız kışa hazır mı?\n\n#hasat #Toprak",
    );
    expect(out).toMatchObject({
      engine: "svg",
      version: 1,
      lintClean: true,
      passes: [
        { pass: "v1", errors: 1 },
        { pass: "v2", errors: 0 },
      ],
      critique: ["high: Başlık taşıyor"],
    });
    // No AI picture without a slot and consent.
    expect(state.jobs.some((x) => x.type === "image.generate")).toBe(false);
  });

  it("bounds the critique passes (1 + designFixPasses) and keeps the best version", async () => {
    const { api, state } = setup();
    const calls: ClaudeCallOptions[] = [];
    const runner: ClaudeRunner = async (o) => {
      calls.push(o);
      return result(design(svgOf(HEADLINE(`TAŞAN ${calls.length}`))));
    };
    const handler = createContentGenerateHandler(
      deps(api, runner, fakeSvgRenderer(), { STUDIO_DESIGN_FIX_PASSES: "2" }),
    );
    const { job: j, ctx } = job({ engine: "svg" });
    const out = (await handler.run(j.payload as never, ctx)) as Record<string, unknown>;
    expect(calls.map((c) => c.label)).toEqual([
      "svg-generate-ontent_1",
      "svg-revise1-ontent_1",
      "svg-revise2-ontent_1",
      "svg-revise3-ontent_1",
    ]);
    expect(out).toMatchObject({ lintClean: false, errors: 1 });
    expect(state.versionCreates[0]?.note).toContain("hata kaldı");
  });

  it("queues the consented AI picture for the slot marker; approving renders it into the SVG", async () => {
    const { api, state } = setup();
    const runner: ClaudeRunner = async () =>
      result(
        design(
          svgOf(`<rect width="1080" height="1350" fill="#F4EFE4"/>${HEADLINE("Hasat")}${SLOT}`),
        ),
      );
    const renderer = fakeSvgRenderer();
    const handler = createContentGenerateHandler(deps(api, runner, renderer));
    const { job: j, ctx } = job({
      engine: "svg",
      imageSlot: "ai_generate",
      slotImage: { consented: true },
      conversationId: "conv_1",
    });
    const out = (await handler.run(j.payload as never, ctx)) as Record<string, unknown>;
    const image = state.jobs.find((x) => x.type === "image.generate");
    expect(image?.payload).toMatchObject({
      aspectRatio: "1:1",
      approval: {
        kind: "product_image",
        contentId: "content_1",
        slotId: "ai-image",
        conversationId: "conv_1",
      },
    });
    expect(out.slotImages).toMatchObject({ jobs: [{ slotId: "ai-image" }] });

    // The approve route queues content.render { slotAssignments } on the SVG version.
    state.assets.set("asset_pic", { bytes: await color("#2255AA"), contentType: "image/png" });
    state.assetRecords.push({
      id: "asset_pic",
      brandId: "brand_1",
      kind: "image",
      source: "generated",
      objectKey: "brands/brand_1/asset_pic",
      mimeType: "image/png",
      bytes: 10,
      sha256: "0".repeat(64),
      width: 1024,
      height: 1024,
      durationMs: null,
      originalFilename: null,
      createdAt: NOW,
    } as Asset);
    const seen: RenderAndInspectRequest[] = [];
    const render = createContentRenderHandler({
      ...deps(api, runner, fakeSvgRenderer(seen)),
    });
    const payload = {
      format: "jpeg" as const,
      version: 1,
      slotAssignments: { "ai-image": "asset_pic" },
      note: "Onaylanan görsel SVG yuvasına yerleştirildi",
    };
    const rendered = await render.run(payload, {
      ...ctx,
      jobId: "job_render",
      job: { ...ctx.job, id: "job_render", type: "content.render", payload },
    });
    expect(rendered).toMatchObject({ version: 2 });
    const v2 = state.versions.find((v) => v.version === 2);
    const html = v2?.slides[0]?.html ?? "";
    expect(isSvgSlideHtml(html)).toBe(true);
    expect(html).toMatch(
      /<image [^>]*data-slot="ai-image" data-slot-state="filled" href="\/media\/asset_pic.png">/,
    );
    expect(html).toContain('clip-path="url(#slot-clip-ai-image)"');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.html).toBe(html);
    expect(v2?.slides[0]?.renderedAssetId).toBeTruthy();
  });

  it("revises a stored SVG post from the chat (revise_post: base version + instruction, no engine)", async () => {
    const base = prepareSvgSlide(
      svgOf(
        `<rect width="1080" height="1350" fill="#F4EFE4"/>${HEADLINE("Hasat")}<image href="/media/asset_pic.png" data-slot="ai-image" data-slot-state="filled" x="96" y="520" width="888" height="666"/>`,
      ),
      SIZE,
    );
    const { api, state } = setup(
      draft({
        caption: "Eski açıklama",
        currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) },
      }),
    );
    state.assets.set("asset_render", { bytes: await jpeg(), contentType: "image/jpeg" });
    state.versions.push({
      id: "ver_1",
      contentId: "content_1",
      version: 1,
      origin: "generated",
      contentHash: "a".repeat(64),
      slideCount: 1,
      note: null,
      jobId: "job_old",
      createdAt: NOW,
      updatedAt: NOW,
      slides: [
        {
          html: base.html,
          width: 1080,
          height: 1350,
          renderedAssetId: "asset_render",
          layers: null,
        },
      ],
    });
    const calls: ClaudeCallOptions[] = [];
    const runner: ClaudeRunner = async (o) => {
      calls.push(o);
      return result(
        design(
          svgOf(
            `<rect width="1080" height="1350" fill="#F4EFE4"/>${HEADLINE("Kış geldi")}<image href="/media/asset_pic.png" data-slot="ai-image" data-slot-state="filled" x="96" y="520" width="888" height="666"/>`,
          ),
          { caption: "Eski açıklama", hashtags: [], changes: ["Başlık değişti"] },
        ),
      );
    };
    const handler = createContentGenerateHandler(deps(api, runner, fakeSvgRenderer()));
    const { job: j, ctx } = job(
      { baseVersion: 1, instructions: "Başlığı “Kış geldi” yap" },
      "job_revise",
    );
    const out = (await handler.run(j.payload as never, ctx)) as Record<string, unknown>;
    expect(calls.map((c) => c.label)).toEqual(["svg-edit-ontent_1"]);
    const prompt = textOfCall(calls[0]);
    expect(prompt).toContain("<instruction>");
    expect(prompt).toContain("Kış geldi");
    expect(prompt).toContain("<current_svg>");
    expect(prompt).toContain(">Hasat</tspan>");
    expect(calls[0]?.content.some((b) => b.type === "image")).toBe(true);
    expect(out).toMatchObject({ engine: "svg", revised: true, baseVersion: 1, version: 2 });
    const v2 = state.versionCreates.at(-1);
    expect(v2?.origin).toBe("ai_edit");
    // The approved picture of the base stays (its /media id is allowed in a revision).
    expect(v2?.slides[0]?.html).toContain('href="/media/asset_pic.png"');
    expect(v2?.slides[0]?.html).toContain("Kış geldi");
  });

  it("checks an SVG version on demand with the SVG lint, never the HTML contract linter", async () => {
    const { html } = prepareSvgSlide(svgOf(HEADLINE("TAŞAN başlık")), SIZE);
    const { api, state } = setup(
      draft({ currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) } }),
    );
    state.versions.push({
      id: "ver_1",
      contentId: "content_1",
      version: 1,
      origin: "generated",
      contentHash: "a".repeat(64),
      slideCount: 1,
      note: null,
      jobId: null,
      createdAt: NOW,
      updatedAt: NOW,
      slides: [{ html, width: 1080, height: 1350, renderedAssetId: null, layers: null }],
    });
    const runner: ClaudeRunner = async () => {
      throw new Error("no AI call expected");
    };
    const res = await runContentChecks({
      deps: deps(api, runner, fakeSvgRenderer()),
      jobId: null,
      trigger: "manual",
      contentId: "content_1",
      fix: true,
      signal: new AbortController().signal,
    });
    const rules = (res.run?.results ?? []).map((r) => String(r.evidence?.rule ?? ""));
    expect(rules).toContain("text-outside-artboard");
    for (const contractRule of ["artboard-count", "brand-css-missing", "svg-outside-shape", "lang"])
      expect(rules).not.toContain(contractRule);
    // Nothing is patched into an SVG slide.
    expect(res.fixedVersion).toBeNull();
    expect(state.versionCreates).toHaveLength(0);
  });

  it("is ready; Reels are refused clearly", async () => {
    expect(isEngineReady("svg")).toBe(true);
    const { api } = setup();
    const runner: ClaudeRunner = async () => {
      throw new Error("no AI call expected");
    };
    const handler = createContentGenerateHandler(deps(api, runner, fakeSvgRenderer()));
    const reel = job({ engine: "svg", type: "reel" });
    await expect(handler.run(reel.job.payload as never, reel.ctx)).rejects.toThrow(/Reels/);
  });
});
