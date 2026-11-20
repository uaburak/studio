/**
 * The Wecra engine (Faz 2) in the worker: `content.generate` with `engine: "wecra"` asks the
 * design model (a fake Claude here — no paid call) for Wecra operations on blank frames, the
 * canvas runner (faked: each canvas job stores the next canvas version from canvas facts) makes the
 * blank document and runs them, the critique → fix loop is bounded, the caption and hashtags go
 * on the post, the checks run on the final version, a consented "AI görsel" area is queued through
 * the product-image line by its Wecra layer id. Engines that do not run fail clearly.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  CanvasApplyOutput,
  CanvasCreateOutput,
  Content,
  ContentCheckBrief,
  Job,
  JobCreate,
} from "@studio/contract";
import { type CanvasFacts, type CanvasNode, canvasSlideHtml } from "@studio/design-kit/canvas";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { canvasFacts, textOf } from "../../../packages/design-kit/test/canvas-fixture.ts";
import { loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeCallOptions, ClaudeCallResult, ClaudeRunner } from "../src/claude/runner.ts";
import { type ContentGenerateDeps, createContentGenerateHandler } from "../src/generate/handler.ts";
import type { SlideRenderer } from "../src/generate/pipeline.ts";
import { aiPictureSlots } from "../src/generate/wecra/engine.ts";
import {
  captionWithHashtags,
  normalizeHashtags,
  readCritique,
  readDesign,
} from "../src/generate/wecra/plan.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

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

const op = (tool: string, args: Record<string, unknown>) => ({
  tool,
  argsJson: JSON.stringify(args),
});

const DESIGN = {
  rationale: "Tek büyük başlık, toprak tonları.",
  slides: [
    {
      slide: 1,
      operations: [
        op("update_nodes", { updates: [{ nodeId: "frame:1", fills: "#F4EFE4" }] }),
        op("create_nodes", {
          parentId: "frame:1",
          nodes: [
            {
              type: "TEXT",
              name: "Başlık",
              characters: "Hasat zamanı",
              x: 80,
              y: 160,
              width: 920,
              fontFamily: "Inter",
              fontStyle: "Bold",
              fontSize: 96,
              textAutoResize: "HEIGHT",
            },
            { type: "RECTANGLE", name: "AI görsel", x: 80, y: 420, width: 920, height: 690 },
          ],
        }),
        { tool: "run_command", argsJson: "{}" },
      ],
    },
  ],
  caption: "Toprağınız kışa hazır mı?",
  hashtags: ["hasat", "#Toprak", "hasat", "kış bakımı"],
};

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

/** The facts of the version the n-th canvas job makes (a headline that overflows until fixed). */
function factsFor(n: number): CanvasFacts {
  return canvasFacts((nodes) => [
    ...nodes.filter((x) => x.id !== "7:4"),
    {
      ...(nodes.find((x) => x.id === "7:4") as CanvasNode),
      id: "9:1",
      name: "AI görsel",
      mark: null,
      fills: [{ type: "solid", color: "#E0D9C8", opacity: 1 }],
      bounds: { x: 80, y: 420, w: 920, h: 690 },
    },
    {
      ...(nodes.find((x) => x.id === "7:2") as CanvasNode),
      id: "9:2",
      name: "Başlık",
      mark: null,
      text: textOf({ characters: "Hasat zamanı", overflow: n === 1 }),
    },
  ]);
}

async function png(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 108, height: 135, channels: 3, background: "#ffffff" } })
      .png()
      .toBuffer(),
  );
}

async function setup(options: { content?: Content; failApplies?: boolean } = {}) {
  const { api, state } = createFakeApi({ brands: [fakeBrand()] });
  const content = options.content ?? draft();
  state.contents.set(content.id, content);
  state.assets.set("asset_render", { bytes: await png(), contentType: "image/png" });
  const client = api.client as unknown as Record<string, unknown>;
  client.workers = {
    presence: async () => ({
      online: true,
      lastSeenAt: NOW,
      workers: [
        {
          workerId: "canvas",
          capabilities: ["canvas.read", "canvas.apply", "canvas.create"],
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
  // The canvas runner: each canvas job stores the next canvas version (facts `factsFor(n)`).
  const canvasJobs: JobCreate[] = [];
  const jobs = client.jobs as { create(input: JobCreate): Promise<Job> };
  const create = jobs.create.bind(jobs);
  jobs.create = async (input: JobCreate) => {
    const job = await create(input);
    if (input.type !== "canvas.create" && input.type !== "canvas.apply") return job;
    canvasJobs.push(input);
    const done = (output: Record<string, unknown>) => {
      const finished = { ...job, status: "succeeded" as const, output };
      state.jobs[state.jobs.indexOf(job)] = finished;
      return finished;
    };
    if (input.type === "canvas.apply" && options.failApplies) {
      const failed = { ...job, status: "failed" as const, error: "Hiçbir işlem uygulanamadı." };
      state.jobs[state.jobs.indexOf(job)] = failed;
      return failed;
    }
    const payload = input.payload as { version?: number; slides?: number };
    const made = await api.client.contents.versions.create(input.contentId as string, {
      origin: input.type === "canvas.create" ? "generated" : "ai_edit",
      slides: [
        {
          html: canvasSlideHtml({
            facts: factsFor(canvasJobs.length),
            src: "/media/asset_render.png",
            sha256: "c".repeat(64),
          }),
          width: 1080,
          height: 1350,
        },
      ],
      renderedAssetIds: ["asset_render"],
      editorDocument: { kind: "wecra", assetId: "asset_doc", format: 2 },
      jobId: job.id,
    });
    if (input.type === "canvas.create") {
      const output: CanvasCreateOutput = {
        contentId: input.contentId as string,
        version: made.version,
        frameIds: ["7:1"],
        results: [
          { tool: "update_nodes", ok: true, summary: "ok", touched: [] },
          { tool: "create_nodes", ok: false, summary: "fontStyle: Black yok", touched: [] },
        ],
        slides: payload.slides ?? 1,
        checkJobId: null,
      };
      return done(output);
    }
    const output: CanvasApplyOutput = {
      contentId: input.contentId as string,
      version: made.version,
      baseVersion: payload.version ?? 0,
      results: [{ tool: "update_nodes", ok: true, summary: "ok", touched: [] }],
      slides: 1,
      checkJobId: null,
    };
    return done(output);
  };
  return { api, state, canvasJobs };
}

function deps(api: ContentGenerateDeps["api"], runner: ClaudeRunner): ContentGenerateDeps {
  return {
    api,
    gate: new ClaudeGate({ runner }),
    settings: loadAgentSettings({}),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-wecra-")),
    renderer: () => {
      throw new Error("the Wecra engine renders nothing in Chromium");
    },
    checkModelCaller: null,
    canvasPollMs: 1,
    canvasTimeoutMs: 2_000,
  } as ContentGenerateDeps & { renderer: () => SlideRenderer };
}

function job(payload: Record<string, unknown>): { job: Job; ctx: JobContext; progress: string[] } {
  const j: Job = {
    id: "job_wecra",
    type: "content.generate",
    status: "running",
    payload: { brief: "Kış öncesi toprak bakımı", ...payload },
    brandId: "brand_1",
    contentId: "content_1",
    createdAt: NOW,
    updatedAt: NOW,
  };
  const progress: string[] = [];
  return {
    job: j,
    progress,
    ctx: {
      jobId: j.id,
      job: j,
      attempt: 1,
      workerId: "mac",
      signal: new AbortController().signal,
      progress: (_v, m) => progress.push(m ?? ""),
      log: () => {},
    },
  };
}

describe("the Wecra engine (content.generate, engine: wecra)", () => {
  it("designs on a blank canvas with Wecra operations, fixes once from the render, writes the caption", async () => {
    const { api, state, canvasJobs } = await setup();
    const calls: ClaudeCallOptions[] = [];
    const answers = [
      DESIGN,
      {
        verdict: "fix",
        issues: ["Başlık kutusuna sığmıyor"],
        operations: [op("update_nodes", { updates: [{ nodeId: "9:2", fontSize: 80 }] })],
      },
      { verdict: "ok", issues: [], operations: [] },
    ];
    const runner: ClaudeRunner = async (o) => {
      calls.push(o);
      return result(answers[calls.length - 1]);
    };
    const handler = createContentGenerateHandler(deps(api, runner));
    const { job: j, ctx } = job({ engine: "wecra" });
    const out = (await handler.run(j.payload as never, ctx)) as Record<string, unknown>;

    // The blank canvas, designed at once: the frame references stay for the runner to resolve.
    expect(canvasJobs.map((c) => c.type)).toEqual(["canvas.create", "canvas.apply"]);
    const created = canvasJobs[0]?.payload as Record<string, unknown>;
    expect(created).toMatchObject({
      baseVersion: null,
      slides: 1,
      width: 1080,
      height: 1350,
      origin: "generated",
      generateJobId: "job_wecra",
    });
    const ops = created.operations as { tool: string; args: Record<string, unknown> }[];
    // The unknown tool is dropped before the runner sees it.
    expect(ops.map((o) => o.tool)).toEqual(["update_nodes", "create_nodes"]);
    expect(ops[1]?.args.parentId).toBe("frame:1");

    // The critique saw the render and the outline (with the refused operation) and fixed v1.
    const critique = calls[1];
    expect(critique?.content.some((b) => b.type === "image")).toBe(true);
    const text = critique?.content.find((b) => b.type === "text" && b.text.includes("<outline>"));
    expect(text && "text" in text ? text.text : "").toContain("fontStyle: Black yok");
    expect(canvasJobs[1]?.payload).toMatchObject({
      version: 1,
      operations: [{ tool: "update_nodes", args: { updates: [{ nodeId: "9:2", fontSize: 80 }] } }],
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.system).toContain("frame:N");
    expect(calls[0]?.webAccess).toBe(true);

    expect(out).toMatchObject({
      engine: "wecra",
      version: 2,
      generatedVersion: 1,
      passes: 2,
      critique: ["Başlık kutusuna sığmıyor"],
    });
    expect(state.contents.get("content_1")?.caption).toBe(
      "Toprağınız kışa hazır mı?\n\n#hasat #Toprak #kışbakımı",
    );
    // No AI picture without consent.
    expect(state.jobs.some((x) => x.type === "image.generate")).toBe(false);
    expect((out.checks as ContentCheckBrief | null)?.version ?? 2).toBe(2);
  });

  it("keeps the design when a fix pass can't be applied, and queues the consented AI picture by its layer id", async () => {
    const { api, state, canvasJobs } = await setup({ failApplies: true });
    let n = 0;
    const runner: ClaudeRunner = async () => {
      n += 1;
      if (n === 1) return result(DESIGN);
      return result({
        verdict: "fix",
        issues: ["Kontrast düşük"],
        operations: [op("update_nodes", { updates: [{ nodeId: "9:2", fills: "#000000" }] })],
      });
    };
    const handler = createContentGenerateHandler(deps(api, runner));
    const { job: j, ctx } = job({
      engine: "wecra",
      imageSlot: "ai_generate",
      slotImage: { consented: true },
      conversationId: "conv_1",
    });
    const out = (await handler.run(j.payload as never, ctx)) as Record<string, unknown>;
    // 1 + designFixPasses (default 1) critique passes, both fixes refused: the design stays v1.
    expect(canvasJobs.map((c) => c.type)).toEqual([
      "canvas.create",
      "canvas.apply",
      "canvas.apply",
    ]);
    expect(out).toMatchObject({ version: 1, passes: 2 });
    const image = state.jobs.find((x) => x.type === "image.generate");
    expect(image?.payload).toMatchObject({
      approval: { kind: "product_image", contentId: "content_1", slotId: "9:1" },
    });
  });

  it("is chosen only for engine wecra; engines that do not run fail clearly", async () => {
    const { api, canvasJobs } = await setup();
    const runner: ClaudeRunner = async () => {
      throw new Error("no AI call expected");
    };
    const handler = createContentGenerateHandler(deps(api, runner));
    const code = job({ engine: "code" });
    await expect(handler.run(code.job.payload as never, code.ctx)).rejects.toThrow(
      "Bu motor henüz hazır değil (Kod)",
    );
    const reel = job({ engine: "wecra", type: "reel" });
    await expect(handler.run(reel.job.payload as never, reel.ctx)).rejects.toThrow(/Reels/);
    expect(canvasJobs).toHaveLength(0);
  });

  it("says so when the Mac app's canvas runner is not there", async () => {
    const { api } = await setup();
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
      deps(api, async () => {
        throw new Error("no AI call expected");
      }),
    );
    const { job: j, ctx } = job({ engine: "wecra" });
    await expect(handler.run(j.payload as never, ctx)).rejects.toThrow(/tuval çalıştırıcısı/);
  });
});

describe("the Wecra plan (model answer → canvas operations)", () => {
  it("checks the operations, clamps the slides and orders them", () => {
    const plan = readDesign(
      {
        slides: [
          { slide: 2, operations: [op("create_nodes", { parentId: "frame:2", nodes: [] })] },
          { slide: 1, operations: [op("update_nodes", { updates: [] }), { tool: "x" }] },
          { slide: 7, operations: [op("delete_nodes", { nodeIds: ["frame:7"] })] },
          { slide: 3, operations: [{ tool: "set_properties", argsJson: "{nope" }] },
        ],
        caption: "  Merhaba ",
        hashtags: ["#a", "a b"],
      },
      { min: 2, max: 3 },
    );
    expect(plan.slides).toBe(3);
    expect(plan.operations.map((o) => o.tool)).toEqual(["update_nodes", "create_nodes"]);
    expect(plan.problems.join(" ")).toMatch(/slayt 7/);
    expect(plan.problems.join(" ")).toMatch(/geçerli JSON değil/);
    expect(plan.caption).toBe("Merhaba");
    expect(plan.hashtags).toEqual(["#a", "#ab"]);
    expect(captionWithHashtags(plan.caption, plan.hashtags)).toBe("Merhaba\n\n#a #ab");
    expect(normalizeHashtags(["#Hasat", "hasat", "!", 3])).toEqual(["#Hasat"]);
    expect(readCritique({ verdict: "fix", issues: [], operations: [] }).ok).toBe(true);
  });

  it("finds the AI picture areas still without a picture", () => {
    expect(
      aiPictureSlots([
        {
          slide: 1,
          frameId: "1:1",
          name: "Kare 1",
          width: 1080,
          height: 1350,
          background: null,
          fonts: [],
          layers: [
            {
              id: "2:1",
              name: "AI görsel",
              type: "shape",
              wecraType: "RECTANGLE",
              parent: null,
              box: [0, 0, 800, 1000],
            },
            {
              id: "2:2",
              name: "ai görsel",
              type: "image",
              wecraType: "RECTANGLE",
              parent: null,
              box: [0, 0, 10, 10],
              fills: ["image"],
            },
          ],
        },
      ] as never),
    ).toEqual([{ slide: 0, slotId: "2:1", ratio: { w: 800, h: 1000 }, label: "AI görsel" }]);
  });
});
