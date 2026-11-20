/**
 * "Bilgileri üret" (`content.details`, Faz 2): the caption, hashtags, title and publish details
 * written from a post's design as it is (its renders and the canvas's text layers), with a fake
 * Claude (no paid call). It never makes a version; an approved post keeps its caption; hand-written
 * alt texts stay.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Content, ContentDetailsOutput, Job, PublishDetails } from "@studio/contract";
import { canvasSlideHtml } from "@studio/design-kit/canvas";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { canvasFacts } from "../../../packages/design-kit/test/canvas-fixture.ts";
import { type AgentDeps, loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import type { ClaudeCallOptions, ClaudeRunner } from "../src/claude/runner.ts";
import { createContentDetailsHandler, writeDetails } from "../src/details/handler.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const ANSWER = {
  title: "Kış öncesi toprak bakımı",
  caption: "Hasat bitti; toprağınızı kışa hazırlamanın zamanı.",
  hashtags: ["hasat", "toprak"],
  altTexts: ["Bej zeminde koyu yeşil 'Hasat bitti' başlığı ve bir tarla fotoğrafı.", "fazla"],
  firstComment: "",
};

async function setup(content: Partial<Content> = {}, details: PublishDetails | null = null) {
  const { api, state } = createFakeApi({ brands: [fakeBrand()] });
  const png = new Uint8Array(
    await sharp({ create: { width: 108, height: 135, channels: 3, background: "#ffffff" } })
      .png()
      .toBuffer(),
  );
  state.assets.set("asset_render", { bytes: png, contentType: "image/png" });
  state.contents.set("content_1", {
    id: "content_1",
    brandId: "brand_1",
    type: "post",
    title: "Yeni post",
    brief: "Kış bakımı",
    status: "draft",
    targetPlatforms: ["instagram"],
    caption: "",
    currentVersion: null,
    approval: null,
    createdAt: NOW,
    updatedAt: NOW,
    publishDetails: details,
    ...content,
  });
  await api.client.contents.versions.create("content_1", {
    origin: "manual_edit",
    slides: [
      {
        html: canvasSlideHtml({
          facts: canvasFacts(),
          src: "/media/asset_render.png",
          sha256: "c".repeat(64),
        }),
        width: 1080,
        height: 1350,
      },
    ],
    renderedAssetIds: ["asset_render"],
    editorDocument: { kind: "wecra", assetId: "asset_doc", format: 2 },
  });
  // The approval a version clears in the fake is put back for the approved case.
  if (content.status) {
    const c = state.contents.get("content_1") as Content;
    state.contents.set("content_1", { ...c, status: content.status });
  }
  const put: PublishDetails[] = [];
  const contents = api.client.contents as unknown as Record<string, unknown>;
  contents.setPublishDetails = async (_id: string, input: PublishDetails) => {
    put.push(input);
    return state.contents.get("content_1");
  };
  return { api, state, put, versionsBefore: state.versionCreates.length };
}

function run(api: AgentDeps["api"], calls: ClaudeCallOptions[], payload = {}) {
  const runner: ClaudeRunner = async (o) => {
    calls.push(o);
    return {
      output: ANSWER,
      text: "",
      model: "claude-opus-5-5",
      cliVersion: "2.1.292",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        durationMs: 1,
        durationApiMs: 1,
        wallMs: 1,
      },
      rateLimit: undefined,
    };
  };
  const deps: AgentDeps = {
    api,
    gate: new ClaudeGate({ runner }),
    settings: loadAgentSettings({}),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-details-")),
  };
  const job: Job = {
    id: "job_details",
    type: "content.details",
    status: "running",
    payload,
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
  return createContentDetailsHandler(deps).run(
    payload as never,
    ctx,
  ) as Promise<ContentDetailsOutput>;
}

describe("Bilgileri üret (content.details)", () => {
  it("writes the caption, hashtags, title and alt texts from the design without making a version", async () => {
    const { api, state, put, versionsBefore } = await setup();
    const calls: ClaudeCallOptions[] = [];
    const out = await run(api, calls);
    // It read the render and the canvas's text layers.
    expect(calls[0]?.content.some((b) => b.type === "image")).toBe(true);
    const prompt = calls[0]?.content.find(
      (b) => b.type === "text" && b.text.includes("<tasarimdaki_yazilar>"),
    );
    expect(prompt && "text" in prompt ? prompt.text : "").toContain("Hasat bitti");

    expect(out).toMatchObject({
      version: 1,
      written: ["title", "caption", "altText"],
      hashtags: ["#hasat", "#toprak"],
    });
    const c = state.contents.get("content_1") as Content;
    expect(c.title).toBe("Kış öncesi toprak bakımı");
    expect(c.caption).toBe("Hasat bitti; toprağınızı kışa hazırlamanın zamanı.\n\n#hasat #toprak");
    expect(put[0]).toMatchObject({
      altTexts: ["Bej zeminde koyu yeşil 'Hasat bitti' başlığı ve bir tarla fotoğrafı."],
      altTextSources: ["auto"],
    });
    // The design is untouched: no version, no canvas job.
    expect(state.versionCreates.length).toBe(versionsBefore);
    expect(state.jobs.filter((j) => j.type.startsWith("canvas."))).toHaveLength(0);
  });

  it("leaves an approved post's caption as it is (it would revoke the approval)", async () => {
    const { api, state, versionsBefore } = await setup({ status: "approved" });
    const out = await run(api, [], { fields: ["caption", "title"] });
    expect(out.written).toEqual(["title"]);
    expect(out.notes.join(" ")).toMatch(/açıklama değişmedi/);
    expect((state.contents.get("content_1") as Content).caption).toBe("");
    expect(state.versionCreates.length).toBe(versionsBefore);
  });

  it("refuses a published post", async () => {
    const { api } = await setup({ status: "published" });
    await expect(run(api, [])).rejects.toThrow(/yayında/);
  });

  it("keeps hand-written alt texts", () => {
    const r = writeDetails(
      { altTexts: ["elle", null], altTextSources: ["manual", null], firstComment: "ilk" },
      { altTexts: ["yeni 1", "yeni 2"], firstComment: null },
    );
    expect(r.next).toEqual({
      altTexts: ["elle", "yeni 2"],
      altTextSources: ["manual", "auto"],
      firstComment: "ilk",
    });
    expect(r).toMatchObject({ changed: true, manualKept: true, firstComment: false });
  });
});
