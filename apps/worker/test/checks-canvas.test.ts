// Checks on versions saved from the canvas (Wecra's editor): they read the slide's facts (texts,
// boxes, fonts, slots) and the render's pixels (contrast) — no Chromium layout — and never pass
// what they could not read: an older canvas save (one picture) is skipped with the reason.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CheckId, Content, ContentCheckResult, ContentVersion } from "@studio/contract";
import { type CanvasFacts, canvasSlideHtml } from "@studio/design-kit/canvas";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  canvasFacts,
  renderFacts,
  textOf,
} from "../../../packages/design-kit/test/canvas-fixture.ts";
import { loadAgentSettings } from "../src/agent.ts";
import {
  CONTENT_CHECKS,
  LEGACY_CANVAS_REASON,
  skipReasons,
  withPasses,
} from "../src/checks/deterministic.ts";
import type { ModelCaller } from "../src/checks/model.ts";
import { type ChecksDeps, runContentChecks } from "../src/checks/pipeline.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeRunner } from "../src/claude/runner.ts";
import { buildBrandContext } from "../src/generate/brand.ts";
import type { SlideRenderer } from "../src/generate/pipeline.ts";
import { silentLogger } from "../src/log.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

type Node = CanvasFacts["nodes"][number];

/** A canvas slide with problems a person would see: overflow, edge, contrast, a banned word. */
function troubled(): CanvasFacts {
  return canvasFacts((nodes) =>
    nodes.map((n): Node => {
      if (n.id === "7:2")
        // The headline: pale on the pale background, 30 px from the left edge.
        return {
          ...n,
          bounds: { x: 30, y: 200, w: 600, h: 96 },
          text: textOf({
            characters: "Ücretsiz hasat",
            family: "Archivo",
            style: "Extra Bold",
            weight: 800,
            size: 80,
            lineHeight: 96,
            color: "#E4DED2",
            lines: [{ x: 30, y: 200, w: 520, h: 96, from: 0, to: 14 }],
          }),
        };
      if (n.id === "7:3" && n.text)
        // The body: longer than its fixed box (Wecra's overflow flag).
        return { ...n, text: { ...n.text, autoResize: "none", overflow: true } };
      return n;
    }),
  );
}

async function pngOf(facts: CanvasFacts): Promise<Uint8Array> {
  const r = renderFacts(facts);
  return new Uint8Array(
    await sharp(r.data, { raw: { width: r.width, height: r.height, channels: 3 } })
      .png()
      .toBuffer(),
  );
}

const LEGACY = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v1">
  <meta name="studio:format" content="1080x1350">
  <meta name="studio:editor" content="wecra">
  <meta name="studio:render" content="sha256:${"a".repeat(64)}">
  <meta name="studio:source-version" content="1">
</head>
<body>
  <main data-artboard style="width:1080px;height:1350px">
    <img data-layer="canvas" data-type="image" data-role="background" src="/media/asset_c1.png" alt="Ücretsiz hasat" style="position:absolute;left:0;top:0;width:1080px;height:1350px">
  </main>
</body>
</html>`;

async function setup(html: string, png: Uint8Array | null, bannedWords: string[] = []) {
  const { api, state } = createFakeApi({ brands: [fakeBrand()] });
  const content: Content = {
    id: "content_1",
    brandId: "brand_1",
    type: "post",
    title: "Hasat",
    brief: "Hasat sonrası bakım; bor ve çinko, web adresiyle bitir.",
    status: "draft",
    targetPlatforms: ["instagram"],
    caption: "Hasattan sonra toprağı besleyin.\n\n#hasat",
    currentVersion: { id: "ver_2", version: 2, contentHash: "b".repeat(64) },
    approval: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.contents.set(content.id, content);
  const version: ContentVersion = {
    id: "ver_2",
    contentId: content.id,
    version: 2,
    origin: "manual_edit",
    contentHash: "b".repeat(64),
    slideCount: 1,
    note: "Tuvalde düzenlendi.",
    jobId: null,
    createdAt: NOW,
    updatedAt: NOW,
    slides: [{ html, width: 1080, height: 1350, renderedAssetId: "asset_c1", layers: null }],
  };
  state.versions.push(version);
  if (png) state.assets.set("asset_c1", { bytes: png, contentType: "image/png" });
  state.checkSettings.set("brand_1", {
    brandId: "brand_1",
    disabledChecks: [],
    bannedWords,
    strictness: "standard",
    autoFix: true,
    updatedAt: NOW,
  });
  const renders: string[] = [];
  const renderer: SlideRenderer = {
    async renderAndLint(req) {
      renders.push(req.html);
      throw new Error("a canvas slide is not measured in Chromium");
    },
  };
  const runner: ClaudeRunner = async () => {
    throw new Error("Claude is not used here");
  };
  const prompts: string[] = [];
  const caller: ModelCaller = async (req) => {
    prompts.push(req.content[0]?.type === "text" ? req.content[0].text : "");
    return { model: "gemini-2.5-flash-lite", output: { findings: [] } };
  };
  const deps: ChecksDeps = {
    api,
    gate: new ClaudeGate({ runner }),
    settings: loadAgentSettings({}),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-canvas-checks-")),
    renderer: () => renderer,
    checkModelCaller: caller,
  };
  const brand = buildBrandContext({ brand: fakeBrand(), profile: null, api, cacheDir: tmpdir() });
  brand.fontFamilies = ["Archivo", "Montserrat"];
  const run = (fix: boolean | "auto" = "auto") =>
    runContentChecks({
      deps,
      jobId: "job_chk",
      trigger: "manual",
      contentId: "content_1",
      version: 2,
      brand,
      fix,
      signal: new AbortController().signal,
    });
  return { state, run, renders, prompts };
}

const byCheck = (rows: readonly ContentCheckResult[], id: string) =>
  rows.filter((r) => r.checkId === id);

describe("checks on a canvas version (facts + render)", () => {
  it("finds overflow, safe-area, low contrast, banned words and the empty slot from the facts and the pixels", async () => {
    const facts = troubled();
    const html = canvasSlideHtml({ facts, src: "/media/asset_c1.png", sha256: "c".repeat(64) });
    const { state, run, renders, prompts } = await setup(html, await pngOf(facts), ["ücretsiz"]);
    const res = await run();
    expect(renders).toEqual([]);
    const rows = state.checkRuns[0]?.results ?? [];

    expect(byCheck(rows, "layout.overflow")).toEqual([
      expect.objectContaining({
        status: "warn",
        refs: [{ slide: 0, layer: "topraginiz-icin-bor-ve-cinko" }],
        evidence: expect.objectContaining({ rule: "text-overflow-box" }),
      }),
    ]);
    expect(byCheck(rows, "layout.safe-area")[0]).toMatchObject({
      status: "warn",
      refs: [{ slide: 0, layer: "headline" }],
      evidence: { rule: "safe-area", overflow: 34 },
    });
    const contrast = byCheck(rows, "layout.contrast")[0];
    expect(contrast).toMatchObject({ status: "fail", refs: [{ slide: 0, layer: "headline" }] });
    expect(contrast?.message).toMatch(/kontrastı 1\.\d:1; en az 3:1/);
    expect(byCheck(rows, "text.banned-words")[0]).toMatchObject({
      status: "fail",
      refs: [{ slide: 0, layer: "headline" }],
      evidence: { word: "ücretsiz", match: "Ücretsiz", where: "slide" },
    });
    expect(
      byCheck(rows, "brief.completeness").find((r) => r.evidence?.rule === "slot-empty"),
    ).toMatchObject({ status: "warn", refs: [{ slide: 0, layer: "field-photo" }] });
    // Fonts are the brand's and were there; the logo is the brand's file, large enough.
    expect(byCheck(rows, "brand.fonts")).toEqual([expect.objectContaining({ status: "pass" })]);
    expect(byCheck(rows, "brand.logo")).toEqual([expect.objectContaining({ status: "pass" })]);
    // A canvas slide is fixed on the canvas: nothing is patched, no version is made.
    expect(rows.some((r) => r.fixable)).toBe(false);
    expect(state.versionCreates).toHaveLength(0);
    expect(res.brief.blocking).toBeGreaterThan(0);
    // The model pass reads the real texts.
    expect(prompts[0]).toContain("slide-1:headline (headline): Ücretsiz hasat");
    expect(prompts[0]).toContain("slide-1:topraginiz-icin-bor-ve-cinko: Toprağınız için bor");
    // Nothing that ran over the slide says "pass" without having read it.
    expect(rows.filter((r) => r.status === "skipped")).toEqual([]);
  });

  it("a clean canvas slide passes what it really checked", async () => {
    const facts = canvasFacts((nodes) =>
      nodes.filter((n) => n.mark?.type !== "slot").map((n) => n),
    );
    const html = canvasSlideHtml({ facts, src: "/media/asset_c1.png", sha256: "c".repeat(64) });
    const { state, run } = await setup(html, await pngOf(facts));
    await run();
    const rows = state.checkRuns[0]?.results ?? [];
    for (const id of ["layout.overflow", "layout.safe-area", "layout.contrast", "brand.fonts"])
      expect(byCheck(rows, id)).toEqual([expect.objectContaining({ status: "pass" })]);
    expect(rows.filter((r) => r.status === "fail")).toEqual([]);
  });

  it("without the render: contrast is skipped with the reason and the picture is reported; the rest still checks", async () => {
    const facts = troubled();
    const html = canvasSlideHtml({ facts, src: "/media/asset_c1.png", sha256: "c".repeat(64) });
    const { state, run } = await setup(html, null);
    await run();
    const rows = state.checkRuns[0]?.results ?? [];
    expect(byCheck(rows, "layout.contrast")).toEqual([
      expect.objectContaining({
        status: "skipped",
        message: expect.stringContaining("kontrast ölçülemedi"),
      }),
    ]);
    expect(byCheck(rows, "visual.resolution")[0]).toMatchObject({
      status: "fail",
      refs: [{ slide: 0, layer: "canvas" }],
    });
    expect(byCheck(rows, "layout.overflow")[0]).toMatchObject({ status: "warn" });
  });

  it("notices the brand logo is gone when the design it came from had one", async () => {
    const facts = canvasFacts((nodes) => nodes.filter((n) => n.mark?.type !== "logo"));
    const html = canvasSlideHtml({
      facts,
      src: "/media/asset_c1.png",
      sha256: "c".repeat(64),
      sourceVersion: 1,
    });
    const { state, run } = await setup(html, await pngOf(facts));
    state.versions.push({
      ...(state.versions[0] as ContentVersion),
      id: "ver_1",
      version: 1,
      origin: "generated",
      slides: [
        {
          html: '<!doctype html><html lang="tr"><body><main data-artboard style="width:1080px;height:1350px"><img data-layer="logo" data-type="logo" src="/brand/logos/mark.png" alt=""></main></body></html>',
          width: 1080,
          height: 1350,
          renderedAssetId: null,
          layers: null,
        },
      ],
    });
    await run();
    const logo = byCheck(state.checkRuns[0]?.results ?? [], "brand.logo");
    expect(logo).toEqual([
      expect.objectContaining({
        status: "warn",
        message: expect.stringContaining("v1 tasarımında vardı"),
        evidence: { rule: "logo-missing", sourceVersion: 1 },
      }),
    ]);
  });
});

describe("older canvas saves (one picture, no facts)", () => {
  it("are skipped with 'eski tuval kaydı, yeniden kaydedin', never passed", async () => {
    const { state, run, renders } = await setup(LEGACY, await pngOf(canvasFacts()), ["ücretsiz"]);
    await run();
    expect(renders).toEqual([]);
    const rows = state.checkRuns[0]?.results ?? [];
    const content = rows.filter((r) => CONTENT_CHECKS.has(r.checkId as CheckId));
    expect(content.length).toBeGreaterThan(10);
    for (const r of content) {
      expect(r.status, r.checkId).toBe("skipped");
      expect(r.message).toBe(LEGACY_CANVAS_REASON);
    }
    expect(LEGACY_CANVAS_REASON).toMatch(/Eski tuval kaydı.*yeniden kaydedin/);
    // The caption is still checked.
    expect(byCheck(rows, "text.caption-length")[0]).toMatchObject({ status: "pass" });
    expect(state.checkRuns[0]?.blocking).toBe(0);
  });
});

describe("coverage: nothing found where nothing was read is not a pass", () => {
  it("skips the slide checks of an unmeasured or failed slide and contrast without pixels", () => {
    const reasons = skipReasons(
      [
        { index: 0, mode: "unmeasured", report: null, failure: null, canvas: "none" },
        { index: 1, mode: "fresh", report: null, failure: "boom", canvas: "none" },
      ],
      false,
    );
    expect(reasons.get("layout.overflow")).toContain("Slayt 1 ölçülmedi");
    expect(reasons.get("visual.resolution")).toContain("Slayt 1");
    expect(reasons.has("text.caption-length")).toBe(false);
    const rows = withPasses([], ["layout.overflow", "text.caption-length"], reasons);
    expect(rows.map((r) => [r.checkId, r.status])).toEqual([
      ["layout.overflow", "skipped"],
      ["text.caption-length", "pass"],
    ]);
    expect(
      skipReasons(
        [{ index: 0, mode: "unmeasured", report: null, failure: null, canvas: "legacy" }],
        true,
      ).size,
    ).toBe(0);
  });
});
