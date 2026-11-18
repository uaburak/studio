import type { Asset, AssetAnalysisPut } from "@studio/contract";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { CHAT_SYSTEM_PROMPT } from "../src/chat/prompt.ts";
import { STUDIO_TOOLS, StudioToolExecutor } from "../src/chat/tools.ts";
import { TurnWriter } from "../src/chat/writer.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

function asset(id: string, name: string, brandId = "brand_1"): Asset {
  return {
    id,
    brandId,
    kind: "image",
    source: "upload",
    objectKey: `k/${id}`,
    mimeType: "image/png",
    bytes: 10,
    sha256: "0".repeat(64),
    width: 1080,
    height: 1350,
    durationMs: null,
    originalFilename: name,
    createdAt: NOW,
  };
}

function print(axis: number, tilt = 0): string {
  const values = new Float32Array(4);
  values[axis] = Math.cos(tilt);
  values[(axis + 1) % 4] = Math.sin(tilt);
  return Buffer.from(values.buffer).toString("base64");
}

function analysis(over: Partial<AssetAnalysisPut>): AssetAnalysisPut {
  return { status: "complete", version: 1, ...over };
}

async function setup() {
  const { api, state } = createFakeApi({ brands: [fakeBrand()] });
  state.assetRecords.push(
    asset("field", "IMG_1.png"),
    asset("logo", "marka.png"),
    asset("bag", "cuval.png"),
    asset("other", "tarla.png", "brand_2"),
    { ...asset("pdf", "katalog.pdf"), kind: "document", mimeType: "application/pdf" },
  );
  const png = new Uint8Array(
    await sharp({ create: { width: 40, height: 50, channels: 3, background: "#7a5" } })
      .png()
      .toBuffer(),
  );
  for (const id of ["field", "logo", "bag"])
    state.assets.set(id, { bytes: png, contentType: "image/png" });
  state.analyses.set(
    "field",
    analysis({
      tags: [
        { id: "field", label: "tarla", confidence: 0.8 },
        { id: "tractor", label: "traktör", confidence: 0.6 },
      ],
      orientation: "portrait",
      colors: [{ hex: "#6b8e23", share: 0.6, name: "yeşil" }],
      featurePrint: { revision: 2, count: 4, data: print(0) },
    }),
  );
  state.analyses.set(
    "bag",
    analysis({
      tags: [{ id: "sack", label: "çuval", confidence: 0.7 }],
      text: "VENTA BORİNÇ",
      isCutout: true,
      orientation: "portrait",
      featurePrint: { revision: 2, count: 4, data: print(0, 0.3) },
    }),
  );
  state.analyses.set(
    "logo",
    analysis({
      isLogoLike: true,
      orientation: "square",
      featurePrint: { revision: 2, count: 4, data: print(2) },
    }),
  );
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
  });
  return { ex, state };
}

describe("search_media (N12): the agent finds pictures itself", () => {
  it("is offered to every agent and named in the system prompt", () => {
    const tool = STUDIO_TOOLS.find((t) => t.name === "search_media");
    expect(tool?.inputSchema.properties?.query?.type).toBe("string");
    expect(CHAT_SYSTEM_PROMPT).toContain("search_media");
    expect(CHAT_SYSTEM_PROMPT).toContain("labelCheck");
  });

  it("searches Turkish tags and the text on pictures, results as data", async () => {
    const { ex } = await setup();
    const res = await ex.execute("search_media", { query: "tarla" });
    expect(res.isError).toBe(false);
    const data = res.data as { results: { assetId: string; tags: string[] }[]; count: number };
    expect(data.results.map((r) => r.assetId)).toEqual(["field"]);
    expect(data.results[0]?.tags).toEqual(["tarla", "traktör"]);

    const text = await ex.execute("search_media", { query: "venta borinc" });
    expect((text.data as { results: { assetId: string; text: string }[] }).results).toEqual([
      expect.objectContaining({ assetId: "bag", text: "VENTA BORİNÇ", isCutout: true }),
    ]);

    const cutouts = await ex.execute("search_media", { cutoutOnly: true });
    expect(
      (cutouts.data as { results: { assetId: string }[] }).results.map((r) => r.assetId),
    ).toEqual(["bag"]);
    const square = await ex.execute("search_media", { orientation: "square" });
    expect(
      (square.data as { results: { assetId: string }[] }).results.map((r) => r.assetId),
    ).toEqual(["logo"]);
    const none = await ex.execute("search_media", { query: "deniz" });
    expect((none.data as { count: number }).count).toBe(0);
  });

  it("finds similar pictures and can show thumbnails", async () => {
    const { ex } = await setup();
    const res = await ex.execute("search_media", {
      similarTo: "field",
      withThumbnails: true,
      limit: 2,
    });
    const data = res.data as {
      results: { assetId: string; similarity: number }[];
      thumbnailsInOrder: string[];
    };
    expect(data.results.map((r) => r.assetId)).toEqual(["bag", "logo"]);
    expect(data.results[0]?.similarity).toBeGreaterThan(data.results[1]?.similarity ?? 1);
    expect(data.thumbnailsInOrder).toEqual(["bag", "logo"]);
    expect(res.images).toHaveLength(2);
  });
});
