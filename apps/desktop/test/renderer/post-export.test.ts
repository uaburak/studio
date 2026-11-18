// Export choices and assets (port of StudioKit's PostExporter): JPEG uses the renders (making the
// missing ones first), PNG and PDF are rendered by the worker, reels give their MP4 / cover.
import { encodeReelSpec, type Job } from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  type ExportApi,
  exportBaseName,
  exportChoices,
  exportFiles,
  reelFile,
  savedText,
} from "../../src/renderer/features/posts/export.ts";
import { content, job, slide, version } from "./post-fixtures.ts";

function fakeApi(outputs: Record<string, Record<string, unknown>>, rendered?: () => void) {
  const created: { type: string; payload: unknown }[] = [];
  const jobs = new Map<string, Job>();
  const api = {
    jobs: {
      create: async (input: { type: string; payload?: Record<string, unknown> }) => {
        created.push({ type: input.type, payload: input.payload });
        const format = String(input.payload?.format ?? "jpeg");
        const j = job({ id: `j${created.length}`, output: outputs[format] ?? {} });
        jobs.set(j.id, j);
        if (format === "jpeg") rendered?.();
        return { ...j, status: "queued" as const };
      },
      get: async (id: string) => jobs.get(id) as Job,
    },
    contents: {
      versions: {
        get: async () =>
          version("p1", 3, [slide({ renderedAssetId: "r1" }), slide({ renderedAssetId: "r2" })]),
      },
    },
  };
  return { api: api as unknown as ExportApi, created };
}

const post = content({ title: "Hasat sonrası toprak bakımı" });

describe("post export", () => {
  it("names files like the AppKit app", () => {
    expect(exportBaseName("Hasat sonrası toprak bakımı", 3)).toBe("hasat-sonrasi-toprak-bakimi-v3");
    expect(exportBaseName("!!!", 1)).toBe("post-v1");
    expect(savedText(["/a/b/hasat-v3.pdf"])).toBe("hasat-v3.pdf kaydedildi");
    expect(savedText(["/a/1.jpg", "/a/2.jpg"])).toBe("2 dosya kaydedildi");
  });

  it("offers this slide or all slides, and one PDF", () => {
    expect(exportChoices(3, 1).map((c) => c.label)).toEqual([
      "JPEG — bu slayt (2)",
      "JPEG — tüm slaytlar (3)",
      "PNG — bu slayt (2)",
      "PNG — tüm slaytlar (3)",
      "PDF — carousel (3 sayfa)",
    ]);
    expect(exportChoices(1, 0).map((c) => c.label)).toEqual(["JPEG", "PNG", "PDF"]);
    expect(exportChoices(4, null).map((c) => c.choice)).toEqual([
      { format: "jpeg", slides: null },
      { format: "png", slides: null },
      { format: "pdf", slides: null },
    ]);
  });

  it("uses rendered JPEGs, rendering missing ones first", async () => {
    const v = version("p1", 3, [
      slide({ renderedAssetId: "r1" }),
      slide({ renderedAssetId: null }),
    ]);
    const { api, created } = fakeApi({});
    const files = await exportFiles(api, post, v, { format: "jpeg", slides: null }, { pollMs: 0 });
    expect(created).toEqual([{ type: "content.render", payload: { format: "jpeg", version: 3 } }]);
    expect(files).toEqual([
      { assetId: "r1", name: "hasat-sonrasi-toprak-bakimi-v3-1.jpg" },
      { assetId: "r2", name: "hasat-sonrasi-toprak-bakimi-v3-2.jpg" },
    ]);
  });

  it("asks the worker for PNGs of the chosen slides", async () => {
    const v = version("p1", 3, [slide(), slide(), slide()]);
    const { api, created } = fakeApi({ png: { pngAssetIds: [null, "png2", null] } });
    const files = await exportFiles(api, post, v, { format: "png", slides: [1] }, { pollMs: 0 });
    expect(created[0]?.payload).toEqual({ format: "png", version: 3, slides: [1] });
    expect(files).toEqual([{ assetId: "png2", name: "hasat-sonrasi-toprak-bakimi-v3-2.png" }]);
  });

  it("asks the worker for one PDF", async () => {
    const v = version("p1", 2, [slide(), slide()]);
    const { api, created } = fakeApi({ pdf: { pdfAssetId: "pdf1" } });
    const files = await exportFiles(api, post, v, { format: "pdf", slides: null }, { pollMs: 0 });
    expect(created[0]?.payload).toEqual({ format: "pdf", version: 2 });
    expect(files).toEqual([{ assetId: "pdf1", name: "hasat-sonrasi-toprak-bakimi-v2.pdf" }]);
  });

  it("says what is missing", async () => {
    const v = version("p1", 2, [slide()]);
    const { api } = fakeApi({ pdf: {} });
    await expect(
      exportFiles(api, post, v, { format: "pdf", slides: null }, { pollMs: 0 }),
    ).rejects.toThrow("PDF üretilemedi.");
  });

  it("exports a reel's MP4 and cover", () => {
    const spec = encodeReelSpec({ recipe: "footage_edit", durationMs: 5_000 });
    const html = `<main data-artboard data-video-asset-id="vid" data-cover-asset-id="cov" data-reel-spec-b64="${spec}"></main>`;
    const v = version("p1", 4, [slide({ html })]);
    const reel = content({ type: "reel", title: "Hasat" });
    expect(reelFile(reel, v, false)).toEqual({ assetId: "vid", name: "hasat-v4.mp4" });
    expect(reelFile(reel, v, true)).toEqual({ assetId: "cov", name: "hasat-v4-kapak.jpg" });
    const empty = version("p1", 1, [slide({ html: "<main></main>", renderedAssetId: null })]);
    expect(reelFile(reel, empty, false)).toBe("Bu sürümde video yok.");
  });
});
