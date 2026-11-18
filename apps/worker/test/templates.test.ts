/**
 * Templates (N9) and repurposing (N10) in the worker: a `content.generate` job that fills a
 * template (HTML: patched layers, auto-fit by measuring; canvas: `canvas.apply` jobs on a copy
 * of the document, auto-fit planned and corrected), and one that converts a post into a story
 * (the design pipeline with a repurpose brief, the story preset) or a Reels (a motion-graphics
 * spec from the slides).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type CanvasApplyOutput,
  type Content,
  type ContentTemplateDetail,
  type ContentVersion,
  type Job,
  type JobCreate,
  readReelVersionInfo,
  type TemplateField,
} from "@studio/contract";
import { type CanvasFacts, canvasSlideHtml } from "@studio/design-kit/canvas";
import { parseSlide } from "@studio/design-kit/document";
import type { LintReport } from "@studio/design-kit/lint";
import { templateFields } from "@studio/design-kit/template";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { canvasFacts, textOf } from "../../../packages/design-kit/test/canvas-fixture.ts";
import { loadAgentSettings } from "../src/agent.ts";
import { STUDIO_TOOLS, StudioToolExecutor } from "../src/chat/tools.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeCallOptions, ClaudeCallResult, ClaudeRunner } from "../src/claude/runner.ts";
import { type ContentGenerateDeps, createContentGenerateHandler } from "../src/generate/handler.ts";
import type { SlideRenderer } from "../src/generate/pipeline.ts";
import { reelSpecFromPost, storyBrief } from "../src/generate/repurpose.ts";
import { aiFillSchema, overflowingFields, readAiFill } from "../src/generate/template.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import type { FfmpegRunner } from "../src/video/ffmpeg.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const templateSlide = (photo = "asset_photo") => `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><meta name="studio:contract" content="v1"><meta name="studio:format" content="1080x1350"><link rel="stylesheet" href="/brand/brand.css"></head>
<body>
  <main data-artboard style="width:1080px;height:1350px">
    <figure data-layer="photo" data-type="slot" data-slot-ratio="4:5" data-slot-state="filled" data-slot-label="Ürün" data-slot-fit="cover" style="position:absolute;left:72px;top:72px;width:560px;height:700px"><img data-slot-image src="/media/${photo}.png" alt=""></figure>
    <h1 data-layer="headline" data-type="text" data-role="headline" style="position:absolute;left:72px;top:820px;width:936px;font-size:88px">Hasat bitti</h1>
    <p data-layer="body" data-type="text" data-role="body" style="position:absolute;left:72px;top:1000px;width:936px">Toprağınızı kışa hazırlayın.</p>
    <p data-layer="cta" data-type="text" data-role="cta" style="position:absolute;left:72px;top:1120px;width:600px">Şimdi incele</p>
    <img data-layer="logo" data-type="logo" src="/brand/logos/logo.png" alt="" style="position:absolute;left:72px;top:1230px;height:48px">
  </main>
</body>
</html>`;

function asFields(slides: { html: string; width: number; height: number }[]): TemplateField[] {
  const res = templateFields(slides);
  if (!res.ok) throw new Error(res.reason);
  return res.fields as TemplateField[];
}

function htmlTemplate(): ContentTemplateDetail {
  const slides = [{ html: templateSlide(), width: 1080, height: 1350 }];
  return {
    id: "tpl_html",
    brandId: "brand_1",
    name: "Ürün duyurusu",
    description: "",
    kind: "html",
    contentType: "post",
    width: 1080,
    height: 1350,
    slideCount: 1,
    fields: asFields(slides),
    previewAssetIds: ["asset_render"],
    source: { contentId: "content_src", version: 2, title: "Hasat" },
    editorDocument: null,
    useCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    slides: slides.map((s) => ({ ...s, renderedAssetId: "asset_render", layers: null })),
  };
}

const canvasHtml = (facts: CanvasFacts) =>
  canvasSlideHtml({ facts, src: "/media/render-1.png", sha256: "c".repeat(64) });

function canvasTemplate(): ContentTemplateDetail {
  const slides = [{ html: canvasHtml(canvasFacts()), width: 1080, height: 1350 }];
  return {
    ...htmlTemplate(),
    id: "tpl_canvas",
    kind: "canvas",
    fields: asFields(slides),
    editorDocument: { kind: "wecra", assetId: "asset_doc", format: 2 },
    slides: slides.map((s) => ({ ...s, renderedAssetId: "asset_render", layers: null })),
  };
}

function draft(overrides: Partial<Content> = {}): Content {
  return {
    id: "content_1",
    brandId: "brand_1",
    type: "post",
    title: "Kış bakımı",
    brief: "",
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

function jobFor(payload: Record<string, unknown>, contentId = "content_1"): Job {
  return {
    id: "job_tpl",
    type: "content.generate",
    status: "running",
    payload,
    brandId: "brand_1",
    contentId,
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

function lintReport(
  width: number,
  height: number,
  issues: LintReport["issues"],
  layers: LintReport["layers"] = [],
): LintReport {
  return {
    schema: "studio.lint/1",
    kit: "0",
    contract: "v1",
    artboard: { width, height },
    ok: issues.length === 0,
    summary: { errors: 0, warnings: issues.length, info: 0 },
    stages: { static: true, layout: true, pixel: true, render: true },
    issues,
    layers,
  } as LintReport;
}

async function jpeg(width = 1080, height = 1350): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
      .jpeg()
      .toBuffer(),
  );
}

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

function result(output: unknown): ClaudeCallResult {
  return {
    output,
    text: "",
    model: "claude-opus-5-5",
    cliVersion: "2.1.292",
    usage,
    rateLimit: undefined,
  };
}

function makeDeps(
  api: ContentGenerateDeps["api"],
  runner: ClaudeRunner,
  renderer: SlideRenderer,
  extra: Partial<ContentGenerateDeps> = {},
): ContentGenerateDeps {
  return {
    api,
    gate: new ClaudeGate({ runner }),
    settings: loadAgentSettings({}),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-tpl-")),
    renderer: () => renderer,
    checkModelCaller: null,
    canvasPollMs: 1,
    canvasTimeoutMs: 2_000,
    ...extra,
  };
}

/** Headline overflows while its inline size is above 75 px (what Chromium would say). */
function measuringRenderer(rendered: string[]): SlideRenderer {
  return {
    async renderAndLint(req) {
      rendered.push(req.html);
      const style = /data-layer="headline"[^>]*style="([^"]*)"/.exec(req.html)?.[1] ?? "";
      const size = Number(/font-size:\s*([\d.]+)px/.exec(style)?.[1] ?? 88);
      const overflow = size > 75;
      return {
        jpeg: await jpeg(req.width, req.height),
        pixelWidth: req.width,
        pixelHeight: req.height,
        deviceScaleFactor: 1,
        network: { blocked: [], missing: [] },
        served: [],
        timings: { contextMs: 1, loadMs: 1, assetsMs: 1, screenshotMs: 1, encodeMs: 1, totalMs: 5 },
        report: lintReport(
          req.width,
          req.height,
          overflow
            ? [
                {
                  rule: "text-overflow-box",
                  severity: "warning",
                  layer: "headline",
                  message: "overflow",
                },
              ]
            : [],
          [
            {
              id: "headline",
              type: "text",
              role: "headline",
              parent: null,
              rect: { x: 72, y: 820, w: 936, h: 160 },
              visible: true,
              text: {
                lines: overflow ? 3 : 2,
                fontSize: size,
                minFontSize: size,
                weight: "700",
                family: "Archivo",
                color: "#000000",
                textRect: { x: 72, y: 820, w: 936, h: 160 },
                chars: 40,
              },
            },
          ],
        ),
      };
    },
  };
}

function fakeApiWith(template: ContentTemplateDetail, content: Content = draft()) {
  const { api, state } = createFakeApi({ brands: [fakeBrand()] });
  state.contents.set(content.id, content);
  for (const id of ["asset_photo", "asset_new", "asset_render"])
    state.assets.set(id, { bytes: new Uint8Array([1]), contentType: "image/png" });
  state.assetRecords.push({
    id: "asset_new",
    brandId: "brand_1",
    kind: "image",
    source: "upload",
    objectKey: "k",
    mimeType: "image/png",
    bytes: 1,
    sha256: "0".repeat(64),
    width: 800,
    height: 1000,
    durationMs: null,
    originalFilename: "yeni.png",
    createdAt: NOW,
  });
  const client = api.client as unknown as Record<string, unknown>;
  client.templates = {
    get: async (id: string) => {
      if (id !== template.id) throw Object.assign(new Error("not found"), { status: 404 });
      return template;
    },
  };
  client.workers = {
    presence: async () => ({
      online: true,
      lastSeenAt: NOW,
      workers: [
        {
          workerId: "canvas",
          capabilities: ["canvas.read", "canvas.apply"],
          concurrency: 1,
          connectedAt: NOW,
          lastSeenAt: NOW,
          draining: false,
        },
      ],
      currentJobs: [],
      queueLength: 0,
    }),
  };
  return { api, state };
}

describe("template fill: HTML", () => {
  it("patches only the fields, keeps the layout and shrinks a text that overflows", async () => {
    const template = htmlTemplate();
    const { api, state } = fakeApiWith(template);
    const rendered: string[] = [];
    const runner: ClaudeRunner = async () => {
      throw new Error("no AI call expected");
    };
    const handler = createContentGenerateHandler(
      makeDeps(api, runner, measuringRenderer(rendered)),
    );
    const payload = {
      brandId: "brand_1",
      contentId: "content_1",
      title: "Kış bakımı",
      brief: "",
      type: "post",
      template: {
        templateId: "tpl_html",
        values: { headline: "Kışa hazır mısınız? Toprağınız sizi bekliyor", cta: "Hemen bak" },
        images: { slot: "asset_new" },
        fill: "manual",
        autoFit: true,
      },
    };
    const job = jobFor(payload);
    const { ctx, progress } = ctxFor(job);
    const out = await handler.run(job.payload as never, ctx);

    // 88 → 79 → 71 px: three renders, the last one fits.
    expect(rendered).toHaveLength(3);
    expect(progress).toContain("Taşan metinler sığdırılıyor");
    expect(out).toMatchObject({
      template: { id: "tpl_html", kind: "html" },
      filled: ["headline", "cta"],
      images: ["slot"],
      fit: { shrunk: { headline: 71 }, overflow: [] },
    });
    expect(state.versionCreates).toHaveLength(1);
    const created = state.versionCreates[0];
    expect(created?.origin).toBe("generated");
    expect(created?.jobId).toBe("job_tpl");
    expect(created?.note).toContain("“Ürün duyurusu” şablonundan üretildi.");
    expect(created?.note).toContain("Sığdırıldı: Başlık 88→71 px.");
    const html = created?.slides[0]?.html ?? "";
    const before = parseSlide(template.slides[0]?.html ?? "").model;
    const after = parseSlide(html).model;
    expect(after.layers.map((l) => l.id)).toEqual(before.layers.map((l) => l.id));
    const layer = (m: typeof after, id: string) => m.layers.find((l) => l.id === id);
    const text = (m: typeof after, id: string) => {
      const l = layer(m, id);
      return l?.type === "text" ? l.text : null;
    };
    expect(text(after, "headline")).toBe("Kışa hazır mısınız? Toprağınız sizi bekliyor");
    expect(text(after, "cta")).toBe("Hemen bak");
    // Not filled: the template's own text.
    expect(text(after, "body")).toBe("Toprağınızı kışa hazırlayın.");
    const slot = layer(after, "photo");
    expect(slot?.type === "slot" && slot.image?.src).toBe("/media/asset_new.png");
    expect(layer(after, "headline")?.style["font-size"]).toBe("71px");
    // Places and sizes stay.
    for (const id of ["photo", "body", "cta", "logo"])
      expect({ ...layer(after, id)?.style }).toEqual({ ...layer(before, id)?.style });
    expect(layer(after, "headline")?.style.left).toBe("72px");
    expect(layer(after, "headline")?.style.top).toBe("820px");
    // Checks of the new version ran (deterministic only).
    expect(state.checkRuns.at(-1)?.trigger).toBe("generate");
  });

  it("stops at the floor and leaves what still overflows to the checks", async () => {
    const template = htmlTemplate();
    const fields = template.fields.map((f) =>
      f.key === "headline" ? { ...f, minFontSize: 80 } : f,
    );
    const { api, state } = fakeApiWith({ ...template, fields });
    const rendered: string[] = [];
    const handler = createContentGenerateHandler(
      makeDeps(api, async () => result({}), measuringRenderer(rendered)),
    );
    const job = jobFor({
      brief: "",
      template: { templateId: "tpl_html", values: { headline: "Çok uzun bir başlık" } },
    });
    const { ctx } = ctxFor(job);
    const out = (await handler.run(job.payload as never, ctx)) as { fit: unknown };
    expect(out.fit).toEqual({ shrunk: { headline: 80 }, overflow: ["headline"] });
    expect(state.versionCreates[0]?.note).toContain("Sığmayan alan: Başlık.");
    // Without auto-fit nothing shrinks (one render).
    const again = fakeApiWith(template);
    const renders: string[] = [];
    const h2 = createContentGenerateHandler(
      makeDeps(again.api, async () => result({}), measuringRenderer(renders)),
    );
    const j2 = jobFor({
      brief: "",
      template: { templateId: "tpl_html", values: { headline: "Uzun" }, autoFit: false },
    });
    await h2.run(j2.payload as never, ctxFor(j2).ctx);
    expect(renders).toHaveLength(1);
  });

  it("lets the AI write the unlocked fields and the caption from the brief", async () => {
    const template = htmlTemplate();
    const { api, state } = fakeApiWith(template);
    const calls: ClaudeCallOptions[] = [];
    const runner: ClaudeRunner = async (o) => {
      calls.push(o);
      return result({
        fields: { headline: "Kış geliyor", body: "Bor ve çinkoyu şimdi verin.", extra: "x" },
        caption: "Kışa hazırlık. #tarim",
      });
    };
    const handler = createContentGenerateHandler(makeDeps(api, runner, measuringRenderer([])));
    const job = jobFor({
      title: "Kış bakımı",
      brief: "Kışlık gübreleme hatırlatması",
      template: { templateId: "tpl_html", values: { cta: "Bayiye sor" }, fill: "ai" },
    });
    const out = await handler.run(job.payload as never, ctxFor(job).ctx);
    expect(calls).toHaveLength(1);
    const prompt = calls[0]?.content[0];
    expect(prompt?.type === "text" && prompt.text).toContain("Kışlık gübreleme hatırlatması");
    expect(prompt?.type === "text" && prompt.text).toContain('"cta":"Bayiye sor"');
    // The model writes only what the user did not give.
    const schema = calls[0]?.schema as { properties: { fields: { required: string[] } } };
    expect(schema.properties.fields.required).toEqual(["headline", "body"]);
    expect(out).toMatchObject({ fill: "ai", filled: ["headline", "body", "cta"] });
    const html = state.versionCreates[0]?.slides[0]?.html ?? "";
    expect(html).toContain("Kış geliyor");
    expect(html).toContain("Bayiye sor");
    expect(state.contents.get("content_1")?.caption).toBe("Kışa hazırlık. #tarim");
  });

  it("refuses a template of another type or one that is gone", async () => {
    const template = htmlTemplate();
    const { api } = fakeApiWith(template, draft({ type: "story" }));
    const handler = createContentGenerateHandler(
      makeDeps(api, async () => result({}), measuringRenderer([])),
    );
    const job = jobFor({ brief: "", template: { templateId: "tpl_html" } });
    await expect(handler.run(job.payload as never, ctxFor(job).ctx)).rejects.toThrow(
      "Şablonun türü (post) postunkiyle (story) aynı değil",
    );
    const gone = jobFor({ brief: "", template: { templateId: "tpl_missing" } });
    await expect(handler.run(gone.payload as never, ctxFor(gone).ctx)).rejects.toThrow(
      "Şablon bulunamadı",
    );
  });
});

describe("template fill: canvas", () => {
  /** The canvas runner: each `canvas.apply` makes the next version from `factsFor(n)`. */
  function withRunner(
    api: ContentGenerateDeps["api"],
    state: ReturnType<typeof createFakeApi>["state"],
    factsFor: (applyIndex: number) => CanvasFacts,
  ) {
    const applied: JobCreate[] = [];
    const client = api.client as unknown as {
      jobs: { create(input: JobCreate): Promise<Job> };
    };
    const create = client.jobs.create.bind(client.jobs);
    client.jobs.create = async (input: JobCreate) => {
      const job = await create(input);
      if (input.type !== "canvas.apply") return job;
      applied.push(input);
      const payload = input.payload as { version: number };
      const made = await api.client.contents.versions.create(input.contentId as string, {
        origin: "ai_edit",
        slides: [{ html: canvasHtml(factsFor(applied.length)), width: 1080, height: 1350 }],
        editorDocument: { kind: "wecra", assetId: "asset_doc", format: 2 },
        jobId: job.id,
      });
      const output: CanvasApplyOutput = {
        contentId: input.contentId as string,
        version: made.version,
        baseVersion: payload.version,
        results: [{ tool: "update_nodes", ok: true, summary: "ok", touched: [] }],
        slides: 1,
        checkJobId: null,
      };
      const done = { ...job, status: "succeeded" as const, output };
      state.jobs[state.jobs.indexOf(job)] = done;
      return done;
    };
    return applied;
  }

  it("copies the template's document, fills it with Wecra operations and corrects the fit once", async () => {
    const template = canvasTemplate();
    const { api, state } = fakeApiWith(template);
    const long = "Hasat bitti, toprağı kışa hazırlama zamanı geldi";
    const applied = withRunner(api, state, (n) =>
      canvasFacts((nodes) =>
        nodes.map((node) =>
          node.id === "7:2"
            ? {
                ...node,
                // First fill: Wecra still needed two lines; after the correction it fits.
                bounds: { ...node.bounds, h: n === 1 ? 150 : 96 },
                text: textOf({
                  characters: long,
                  size: n === 1 ? 56 : 46,
                  lineHeight: n === 1 ? 72 : 56,
                  lines:
                    n === 1
                      ? [
                          { x: 80, y: 200, w: 590, h: 72, from: 0, to: 30 },
                          { x: 80, y: 272, w: 400, h: 72, from: 30, to: 48 },
                        ]
                      : [{ x: 80, y: 200, w: 590, h: 56, from: 0, to: 48 }],
                }),
              }
            : node,
        ),
      ),
    );
    const handler = createContentGenerateHandler(
      makeDeps(api, async () => result({}), measuringRenderer([])),
    );
    const job = jobFor({
      brief: "",
      template: {
        templateId: "tpl_canvas",
        values: { headline: long },
        images: { slot: "asset_new" },
      },
    });
    const out = (await handler.run(job.payload as never, ctxFor(job).ctx)) as Record<
      string,
      unknown
    >;

    // v1: the template's copy (its document, renders, facts).
    const copy = state.versionCreates[0];
    expect(copy).toMatchObject({
      origin: "generated",
      jobId: "job_tpl",
      editorDocument: { kind: "wecra", assetId: "asset_doc", format: 2 },
      renderedAssetIds: ["asset_render"],
      note: "“Ürün duyurusu” şablonundan kopyalandı.",
    });
    expect(copy?.slides[0]?.html).toBe(template.slides[0]?.html);

    // The fill: one update_nodes (text and the planned smaller size) and place_image on the slot.
    expect(applied).toHaveLength(2);
    const first = applied[0]?.payload as {
      version: number;
      operations: { tool: string; args: Record<string, unknown> }[];
    };
    expect(first.version).toBe(1);
    expect(first.operations.map((o) => o.tool)).toEqual(["update_nodes", "place_image"]);
    const update = (
      first.operations[0]?.args.updates as Record<string, unknown>[] | undefined
    )?.[0];
    expect(update).toMatchObject({ nodeId: "7:2", characters: long });
    expect(update?.fontSize).toBeLessThan(80);
    expect(first.operations[1]?.args).toEqual({
      nodeId: "7:4",
      assetId: "asset_new",
      scaleMode: "FILL",
    });
    // The correction: only the size, on the filled version.
    const second = applied[1]?.payload as typeof first;
    expect(second.version).toBe(2);
    expect(second.operations).toEqual([
      {
        tool: "update_nodes",
        args: { updates: [{ nodeId: "7:2", fontSize: expect.any(Number) }] },
      },
    ]);
    const fixed =
      (second.operations[0]?.args.updates as { fontSize: number }[] | undefined)?.[0]?.fontSize ??
      0;
    expect(fixed).toBeLessThan(56);
    expect(fixed).toBeGreaterThanOrEqual(48);
    expect(out).toMatchObject({ version: 3, template: { kind: "canvas" } });
    expect((out.canvasJobIds as string[]).length).toBe(2);
  });

  it("says so when the Mac app's canvas runner is not there", async () => {
    const template = canvasTemplate();
    const { api } = fakeApiWith(template);
    (api.client as unknown as Record<string, unknown>).workers = {
      presence: async () => ({
        online: true,
        lastSeenAt: NOW,
        workers: [],
        currentJobs: [],
        queueLength: 0,
      }),
    };
    const handler = createContentGenerateHandler(
      makeDeps(api, async () => result({}), measuringRenderer([])),
    );
    const job = jobFor({
      brief: "",
      template: { templateId: "tpl_canvas", values: { headline: "x" } },
    });
    await expect(handler.run(job.payload as never, ctxFor(job).ctx)).rejects.toThrow(
      "tuval çalıştırıcısı bağlı değil",
    );
  });

  it("fills an untouched copy on a retry and leaves a post that changed since", async () => {
    const template = canvasTemplate();
    const copyOf = (jobId: string, assetId: string): ContentVersion => ({
      id: "ver_copy",
      contentId: "content_1",
      version: 1,
      origin: "generated",
      contentHash: "a".repeat(64),
      slideCount: 1,
      note: null,
      jobId,
      createdAt: NOW,
      updatedAt: NOW,
      slides: template.slides,
      editorDocument: { kind: "wecra", assetId, format: 2 },
    });
    const ref = { id: "ver_copy", version: 1, contentHash: "a".repeat(64) };
    for (const [assetId, fills] of [
      ["asset_doc", true],
      ["asset_edited", false],
    ] as const) {
      const { api, state } = fakeApiWith(template, draft({ currentVersion: ref }));
      state.versions.push(copyOf("job_earlier", assetId));
      const applied = withRunner(api, state, () => canvasFacts());
      const handler = createContentGenerateHandler(
        makeDeps(api, async () => result({}), measuringRenderer([])),
      );
      const job = jobFor({
        brief: "",
        template: { templateId: "tpl_canvas", values: { headline: "Ekim" }, autoFit: false },
      });
      const out = (await handler.run(job.payload as never, ctxFor(job).ctx)) as Record<
        string,
        unknown
      >;
      expect(applied).toHaveLength(fills ? 1 : 0);
      expect(state.versionCreates.filter((v) => v.note?.includes("kopyalandı"))).toHaveLength(0);
      if (!fills) expect(out.reused).toBe(true);
    }
  });
});

describe("template helpers", () => {
  it("reads the model's fill defensively", () => {
    const fields = htmlTemplate().fields;
    expect(
      readAiFill(
        { fields: { headline: "  Yeni  ", body: 3, nope: "x", cta: "" }, caption: "c" },
        fields,
      ),
    ).toEqual({ values: { headline: "Yeni" }, caption: "c" });
    const schema = aiFillSchema(fields.filter((f) => f.kind === "text")) as {
      properties: { fields: { required: string[] } };
    };
    expect(schema.properties.fields.required).toEqual(["headline", "body", "cta"]);
  });

  it("finds the filled fields a render says no longer fit (overlap on either side)", () => {
    const fields = htmlTemplate().fields.map((f) => ({
      ...f,
      metrics: f.metrics,
    }));
    const report = lintReport(
      1080,
      1350,
      [
        {
          rule: "text-overlap",
          severity: "error",
          layer: "body",
          message: "overlap",
          data: { other: "headline" },
        },
      ],
      [],
    );
    expect(overflowingFields(fields, { headline: "x" }, [report]).map((f) => f.field.key)).toEqual([
      "headline",
    ]);
    expect(overflowingFields(fields, {}, [report])).toEqual([]);
  });
});

// --- repurposing --------------------------------------------------------------------------------

const storySlide = `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><meta name="studio:contract" content="v1"><meta name="studio:format" content="1080x1920"><link rel="stylesheet" href="/brand/brand.css"></head>
<body>
  <main data-artboard style="width:1080px;height:1920px">
    <h1 data-layer="headline" data-type="text" data-role="headline" style="position:absolute;left:64px;top:400px;width:900px">Hasat bitti</h1>
  </main>
</body>
</html>`;

function sourceVersion(contentId: string, slides: string[]): ContentVersion {
  return {
    id: "ver_src",
    contentId,
    version: 2,
    origin: "generated",
    contentHash: "a".repeat(64),
    slideCount: slides.length,
    note: null,
    jobId: null,
    createdAt: NOW,
    updatedAt: NOW,
    slides: slides.map((html) => ({
      html,
      width: 1080,
      height: 1350,
      renderedAssetId: "asset_render",
      layers: null,
    })),
  };
}

describe("repurposing: story", () => {
  it("designs a 1080×1920 story from the post's texts and pictures, inside the story's safe areas", async () => {
    const png = new Uint8Array(
      await sharp({ create: { width: 800, height: 1000, channels: 3, background: "#88aa66" } })
        .png()
        .toBuffer(),
    );
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set(
      "content_src",
      draft({
        id: "content_src",
        title: "Hasat",
        caption: "Hasat zamanı. #tarim",
        status: "approved",
      }),
    );
    state.versions.push(sourceVersion("content_src", [templateSlide()]));
    state.contents.set("content_1", draft({ type: "story", title: "Hasat · Story" }));
    state.assets.set("asset_photo", { bytes: png, contentType: "image/png" });

    const calls: ClaudeCallOptions[] = [];
    const runner: ClaudeRunner = async (o) => {
      calls.push(o);
      return result({
        slides: [{ id: "slide-1", html: storySlide }],
        caption: "Hasat story. #tarim",
        rationale: "Tek mesaj.",
        critique: [],
        changes: [],
      });
    };
    const sizes: string[] = [];
    const renderer: SlideRenderer = {
      async renderAndLint(req) {
        sizes.push(`${req.width}x${req.height}`);
        expect(req.lint?.safeArea).toEqual({ top: 250, right: 64, bottom: 340, left: 64 });
        return {
          jpeg: await jpeg(req.width, req.height),
          pixelWidth: req.width,
          pixelHeight: req.height,
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
          report: lintReport(req.width, req.height, []),
        };
      },
    };
    const handler = createContentGenerateHandler(makeDeps(api, runner, renderer));
    const job = jobFor({
      title: "Hasat · Story",
      brief: "Hasat duyurusu",
      type: "story",
      targetPlatforms: ["instagram"],
      repurpose: { sourceContentId: "content_src", sourceVersion: 2, target: "story" },
      instructions: "Daha samimi olsun",
    });
    await handler.run(job.payload as never, ctxFor(job).ctx);

    const prompt = calls[0]?.content[0];
    const text = prompt?.type === "text" ? prompt.text : "";
    expect(text).toContain("Bu bir dönüştürme");
    expect(text).toContain("Başlık: Hasat bitti");
    expect(text).toContain("Çağrı: Şimdi incele");
    expect(text).toContain("@kaynak-1");
    expect(text).toContain("üstten 250 px ve alttan 340 px");
    expect(text).toContain("Daha samimi olsun");
    // The post's picture goes to the model as media.
    expect(calls[0]?.content.filter((b) => b.type === "image")).toHaveLength(1);
    expect(sizes.every((s) => s === "1080x1920")).toBe(true);
    const created = state.versionCreates.at(-1);
    expect(created?.slides[0]).toMatchObject({ width: 1080, height: 1920 });
    expect(created?.note).toContain("“Hasat” v2 postundan dönüştürüldü.");
  });

  it("builds the brief from a carousel's slides", () => {
    const post = {
      kind: "html" as const,
      slides: [
        { index: 0, texts: [{ role: "headline", text: "Bir", size: null }], images: [] },
        { index: 1, texts: [{ role: "body", text: "İki", size: null }], images: [] },
      ],
    };
    const out = storyBrief({
      source: { title: "Seri", type: "carousel", caption: "" },
      post,
      media: [],
      platforms: ["facebook"],
    });
    expect(out.brief).toContain("“Seri” carousel 9:16 story olacak");
    expect(out.brief).toContain("Kare 1 · Başlık: Bir");
    expect(out.brief).toContain("Kare 2 · Metin: İki");
    expect(out.instructions).toContain("1080×1920");
  });
});

describe("repurposing: Reels", () => {
  it("makes motion-graphics scenes from the slides with the pictures as scene images", () => {
    const post = {
      kind: "html" as const,
      slides: [
        {
          index: 0,
          texts: [
            { role: "eyebrow", text: "Yeni", size: null },
            { role: "headline", text: "Hasat bitti", size: null },
            { role: "subhead", text: "Kışa hazırlık", size: null },
          ],
          images: [{ src: "/media/a1.png", assetId: "a1", slot: true }],
        },
        {
          index: 1,
          texts: [
            { role: "headline", text: "Bor ve çinko", size: null },
            { role: "cta", text: "Bayiye sor", size: null },
          ],
          images: [{ src: "/media/a2.png", assetId: "a2", slot: true }],
        },
      ],
    };
    const spec = reelSpecFromPost(post, { brandName: "MTM Agro", title: "Hasat" });
    expect(spec).toMatchObject({
      recipe: "motion_graphics",
      hook: "Hasat bitti",
      cta: "Bayiye sor",
      heroAssetId: "a1",
      captions: false,
    });
    expect(spec.scenes?.map((s) => [s.eyebrow, s.headline, s.subhead, s.imageAssetId])).toEqual([
      ["Yeni", "Hasat bitti", "Kışa hazırlık", "a1"],
      ["", "Bor ve çinko", "", "a2"],
    ]);
    expect(spec.scenes?.every((s) => (s.durationMs ?? 0) >= 2_200)).toBe(true);

    // A single post: its body becomes a second scene; one picture skips the hook scene.
    const single = reelSpecFromPost(
      {
        kind: "html",
        slides: [
          {
            index: 0,
            texts: [
              { role: "headline", text: "Hasat bitti", size: null },
              { role: "body", text: "Toprağı hazırlayın. Bor ve çinko şimdi.", size: null },
            ],
            images: [{ src: "/media/a1.png", assetId: "a1", slot: true }],
          },
        ],
      },
      { brandName: "MTM Agro", title: "Hasat" },
    );
    expect(single.scenes?.map((s) => [s.headline, s.subhead, s.imageAssetId ?? null])).toEqual([
      ["Hasat bitti", "", null],
      ["Toprağı hazırlayın.", "Bor ve çinko şimdi.", "a1"],
    ]);
    expect(single.cta).toBe("MTM Agro");
  });

  it("renders the converted post's spec as a Reels (no AI) with a picture per scene", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.contents.set("content_src", draft({ id: "content_src", title: "Hasat" }));
    state.versions.push(sourceVersion("content_src", [templateSlide()]));
    state.contents.set("content_1", draft({ type: "reel", title: "Hasat · Reels" }));
    const html: string[] = [];
    const ffmpeg: FfmpegRunner = async (args, opts) => {
      if (opts?.stdin && typeof opts.stdin === "object" && Symbol.asyncIterator in opts.stdin) {
        for await (const _frame of opts.stdin as AsyncIterable<Uint8Array>) {
          // consume
        }
      }
      return { stdout: new Uint8Array(), stderr: args.length === 3 ? "Duration: 00:00:05.00" : "" };
    };
    const aiCalls: string[] = [];
    const handler = createContentGenerateHandler(
      makeDeps(
        api,
        async (o) => {
          aiCalls.push(o.label);
          return result({});
        },
        measuringRenderer([]),
        {
          reelSeams: {
            ffmpeg,
            frameCapturer: async function* (req) {
              html.push(req.html);
              yield new Uint8Array([1]);
            },
          },
        },
      ),
    );
    const job = jobFor({
      title: "Hasat · Reels",
      brief: "Hasat",
      type: "reel",
      reel: { recipe: "motion_graphics" },
      repurpose: { sourceContentId: "content_src", sourceVersion: 2, target: "reel" },
    });
    const out = (await handler.run(job.payload as never, ctxFor(job).ctx)) as { provider: string };
    expect(out.provider).toBe("spec");
    expect(aiCalls).toEqual([]);
    const stored = state.versionCreates.at(-1);
    const info = readReelVersionInfo(stored?.slides[0]?.html ?? "");
    expect(info.recipe).toBe("motion_graphics");
    expect(info.spec?.hook).toBe("Hasat bitti");
    expect(info.spec?.cta).toBe("Şimdi incele");
    expect(info.spec?.scenes.map((s) => s.imageAssetId ?? null)).toEqual([null, "asset_photo"]);
    // The composition shows the post's picture in its scene.
    expect(html[0]).toContain('src="/media/asset_photo.jpg"');
  });
});

// --- the chat agent's tools ---------------------------------------------------------------------

describe("chat tools: templates and repurposing", () => {
  function executor() {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    state.aliases.set("conv_1", [
      {
        id: "alias_1",
        conversationId: "conv_1",
        alias: "urun",
        previousAliases: [],
        assetId: "asset_new",
        kind: "image",
        mimeType: "image/png",
        width: 800,
        height: 1000,
        filename: "urun.png",
        contentPath: "/api/assets/asset_new/content",
        messageId: "msg_1",
        createdAt: NOW,
        updatedAt: NOW,
      },
    ]);
    const uses: { id: string; input: Record<string, unknown> }[] = [];
    const repurposes: { id: string; input: Record<string, unknown> }[] = [];
    const made = (id: string, type: Content["type"]) => ({
      content: draft({ id, type }),
      job: {
        id: `job_${id}`,
        type: "content.generate" as const,
        status: "queued" as const,
        payload: {},
        brandId: "brand_1",
        contentId: id,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    const { slides: _slides, ...summary } = htmlTemplate();
    (api.client as unknown as Record<string, unknown>).templates = {
      list: async (brandId: string) => ({
        items: brandId === "brand_1" ? [summary] : [],
        nextCursor: null,
      }),
      use: async (id: string, input: Record<string, unknown>) => {
        uses.push({ id, input });
        return made(`cnt_tpl_${uses.length}`, "post");
      },
    };
    const contents = api.client.contents as unknown as Record<string, unknown>;
    contents.repurpose = async (id: string, input: Record<string, unknown>) => {
      repurposes.push({ id, input });
      return made(`cnt_rp_${repurposes.length}`, input.target as Content["type"]);
    };
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
      jobPollIntervalMs: 10,
      generationChoice: { model: "sonnet" },
    });
    return { ex, state, writer, uses, repurposes };
  }

  it("are offered to every provider", () => {
    const names = STUDIO_TOOLS.map((t) => t.name);
    for (const n of ["list_templates", "generate_from_template", "repurpose_content"])
      expect(names).toContain(n);
    const plan = STUDIO_TOOLS.find((t) => t.name === "propose_plan");
    expect(plan?.inputSchema.properties?.items?.items?.properties).toHaveProperty("templateId");
  });

  it("lists the brand's templates with their unlocked fields as data", async () => {
    const { ex } = executor();
    const res = await ex.execute("list_templates", {});
    expect(res.isError).toBe(false);
    const templates = res.data.templates as { id: string; fields: { key: string }[] }[];
    expect(templates[0]?.id).toBe("tpl_html");
    expect(templates[0]?.fields.map((f) => f.key)).toEqual(["slot", "headline", "body", "cta"]);
  });

  it("makes a post from a template once per conversation, pictures by @alias", async () => {
    const { ex, uses, writer } = executor();
    const args = {
      templateId: "tpl_html",
      title: "Kış",
      values: [{ key: "headline", text: "Kış geliyor" }],
      images: [{ key: "slot", alias: "@urun" }],
    };
    const first = await ex.execute("generate_from_template", args);
    expect(first.isError, JSON.stringify(first.data)).toBe(false);
    expect(first.data).toMatchObject({
      ok: true,
      contentId: "cnt_tpl_1",
      jobIds: ["job_cnt_tpl_1"],
    });
    expect(uses[0]).toEqual({
      id: "tpl_html",
      input: {
        title: "Kış",
        values: { headline: "Kış geliyor" },
        images: { slot: "asset_new" },
        conversationId: "conv_1",
        model: "sonnet",
      },
    });
    const again = await ex.execute("generate_from_template", args);
    expect(again.data.duplicate).toBe(true);
    expect(uses).toHaveLength(1);
    await writer.flush();
  });

  it("converts a post into a story or a Reels", async () => {
    const { ex, repurposes } = executor();
    const res = await ex.execute("repurpose_content", { contentId: "content_src", target: "reel" });
    expect(res.isError, JSON.stringify(res.data)).toBe(false);
    expect(res.data).toMatchObject({ contentId: "cnt_rp_1", target: "reel" });
    expect(repurposes[0]).toEqual({
      id: "content_src",
      input: { target: "reel", conversationId: "conv_1", model: "sonnet" },
    });
    const bad = await ex.execute("repurpose_content", { contentId: "x", target: "carousel" });
    expect(bad.isError).toBe(true);
  });
});
