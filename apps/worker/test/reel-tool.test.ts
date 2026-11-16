import type { ConversationAlias } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { STUDIO_TOOLS, StudioToolExecutor } from "../src/chat/tools.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import { createFakeApi, NOW } from "./fake-api.ts";

function alias(name: string, assetId: string, mimeType: string): ConversationAlias {
  return {
    id: `alias_${name}`,
    conversationId: "conv_1",
    alias: name,
    previousAliases: [],
    assetId,
    kind: mimeType.startsWith("video/") ? "video" : "image",
    mimeType,
    width: null,
    height: null,
    filename: null,
    contentPath: `/api/assets/${assetId}/content`,
    messageId: "msg_1",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function executor() {
  const { api, state } = createFakeApi();
  state.aliases.set("conv_1", [
    alias("tarla", "asset_clip", "video/mp4"),
    alias("urun", "asset_photo", "image/png"),
  ]);
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
    generationChoice: { model: "sonnet", effort: "low" },
  });
  return { state, ex, writer };
}

describe("generate_reel chat tool", () => {
  it("is listed with the three recipes", () => {
    const tool = STUDIO_TOOLS.find((t) => t.name === "generate_reel");
    expect(tool?.inputSchema.properties?.recipe?.enum).toEqual([
      "motion_graphics",
      "footage_edit",
      "narration",
    ]);
  });

  it("creates a reel content and queues content.generate with the reel options (aliases resolved)", async () => {
    const { state, ex, writer } = executor();
    const res = await ex.execute("generate_reel", {
      brief: "Tarladan kısa bir kurgu, bor eksikliğini anlat",
      title: "Tarlada bor",
      recipe: "footage_edit",
      clipAlias: "@tarla",
      imageAlias: "urun",
      durationSec: 20,
      platforms: ["instagram", "facebook"],
    });
    expect(res.isError).toBe(false);
    const content = [...state.contents.values()][0];
    expect(content).toMatchObject({
      type: "reel",
      title: "Tarlada bor",
      targetPlatforms: ["instagram", "facebook"],
    });
    const job = state.jobs[0];
    expect(job).toMatchObject({ type: "content.generate", contentId: content?.id });
    expect(job?.payload).toMatchObject({
      type: "reel",
      conversationId: "conv_1",
      model: "sonnet",
      reel: {
        recipe: "footage_edit",
        clipAssetId: "asset_clip",
        heroAssetId: "asset_photo",
        durationSec: 20,
      },
    });
    expect(res.data).toMatchObject({ ok: true, contentId: content?.id, jobIds: [job?.id] });
    await writer.flush();
    expect(state.parts.some((p) => p.type === "content_ref")).toBe(true);
  });

  it("refuses an unknown alias and a request without brief or plan item", async () => {
    const { ex } = executor();
    const bad = await ex.execute("generate_reel", { brief: "x", clipAlias: "@yok" });
    expect(bad.isError).toBe(true);
    const empty = await ex.execute("generate_reel", {});
    expect(empty.isError).toBe(true);
  });
});
