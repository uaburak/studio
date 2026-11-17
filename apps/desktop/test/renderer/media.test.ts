import type { Asset } from "@studio/contract";
import { describe, expect, it, vi } from "vitest";
import {
  assetMeta,
  downloadName,
  filterAssets,
  imageRequestPayload,
  isImageAsset,
  lightboxImages,
  mediaCounts,
  mediaSummary,
} from "../../src/renderer/features/media/media-model.ts";
import {
  assetDragPayload,
  attachDecision,
  hasAssetDrag,
  onComposerAttach,
  readAssetDrag,
  requestComposerAttach,
  STUDIO_ASSET_MIME,
  writeAssetDrag,
} from "../../src/renderer/lib/asset-drag.ts";

function asset(id: string, over: Partial<Asset> = {}): Asset {
  return {
    id,
    brandId: "b1",
    kind: "image",
    source: "upload",
    objectKey: `k/${id}`,
    mimeType: "image/jpeg",
    bytes: 2_500_000,
    sha256: "0".repeat(64),
    width: 1080,
    height: 1350,
    durationMs: null,
    originalFilename: `${id}.jpg`,
    createdAt: "2026-11-10T10:00:00.000Z",
    ...over,
  };
}

const library = [
  asset("tarla", { originalFilename: "Tarla Çekimi.jpg", createdAt: "2026-11-01T10:00:00.000Z" }),
  asset("ai-1", {
    source: "generated",
    originalFilename: null,
    createdAt: "2026-11-12T10:00:00.000Z",
  }),
  asset("logo", { kind: "logo", mimeType: "image/svg+xml", originalFilename: "mtm-logo.svg" }),
  asset("reel", {
    kind: "video",
    mimeType: "video/mp4",
    originalFilename: "damla.mp4",
    width: null,
    height: null,
  }),
  asset("katalog", {
    kind: "document",
    mimeType: "application/pdf",
    originalFilename: "Katalog.pdf",
  }),
];

/** A DataTransfer stand-in (jsdom has none). */
function transfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "none",
    get types() {
      return [...data.keys()];
    },
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  } as unknown as DataTransfer;
}

describe("media filtering", () => {
  it("sorts newest first and filters by kind with counts", () => {
    // Same time: a stable order by id.
    expect(filterAssets(library, "").map((a) => a.id)).toEqual([
      "ai-1",
      "reel",
      "logo",
      "katalog",
      "tarla",
    ]);
    expect(filterAssets(library, "", "images").map((a) => a.id)).toEqual(["ai-1", "logo", "tarla"]);
    expect(filterAssets(library, "", "videos").map((a) => a.id)).toEqual(["reel"]);
    expect(filterAssets(library, "", "documents").map((a) => a.id)).toEqual(["katalog"]);
    expect(mediaCounts(library)).toEqual({ all: 5, images: 3, videos: 1, documents: 1 });
  });

  it("searches names, kinds and AI pictures, Turkish-insensitively, every word", () => {
    expect(filterAssets(library, "cekimi").map((a) => a.id)).toEqual(["tarla"]);
    expect(filterAssets(library, "TARLA çekİmİ").map((a) => a.id)).toEqual(["tarla"]);
    expect(filterAssets(library, "ai").map((a) => a.id)).toEqual(["ai-1"]);
    expect(filterAssets(library, "yapay zeka").map((a) => a.id)).toEqual(["ai-1"]);
    expect(filterAssets(library, "logo").map((a) => a.id)).toEqual(["logo"]);
    expect(filterAssets(library, "video").map((a) => a.id)).toEqual(["reel"]);
    expect(filterAssets(library, "tarla video")).toEqual([]);
  });

  it("previews only pictures and labels the pane", () => {
    expect(library.filter(isImageAsset).map((a) => a.id)).toEqual(["tarla", "ai-1", "logo"]);
    expect(lightboxImages(library).map((i) => [i.assetId, i.caption])).toEqual([
      ["tarla", "Tarla Çekimi.jpg"],
      ["ai-1", null],
      ["logo", "mtm-logo.svg"],
    ]);
    expect(mediaSummary("MTM Agro", 128)).toBe("MTM Agro · 128 görsel");
    expect(mediaSummary(null, 3)).toBe("3 görsel");
    expect(assetMeta(library[0] as Asset)).toBe("1080×1350 · 2,4 MB");
    expect(downloadName(library[1] as Asset)).toBe("image-ai-1.jpg");
    expect(downloadName(library[2] as Asset)).toBe("mtm-logo.svg");
  });
});

describe("dragging a Studio asset into the composer", () => {
  it("round-trips the payload through the drag data without text/plain", () => {
    const dt = transfer();
    writeAssetDrag(dt, [assetDragPayload(library[0] as Asset)]);
    expect(dt.types).toEqual([STUDIO_ASSET_MIME]);
    expect(dt.effectAllowed).toBe("copy");
    expect(hasAssetDrag(dt)).toBe(true);
    expect(readAssetDrag(dt)).toEqual([
      {
        assetId: "tarla",
        brandId: "b1",
        mimeType: "image/jpeg",
        filename: "Tarla Çekimi.jpg",
        width: 1080,
        height: 1350,
      },
    ]);
  });

  it("ignores foreign or broken drag data", () => {
    const dt = transfer();
    expect(readAssetDrag(dt)).toEqual([]);
    dt.setData(STUDIO_ASSET_MIME, "{not json");
    expect(readAssetDrag(dt)).toEqual([]);
    dt.setData(STUDIO_ASSET_MIME, JSON.stringify([{ assetId: 3 }, { brandId: "b1" }]));
    expect(readAssetDrag(dt)).toEqual([]);
  });

  it("attaches an asset of the composer's brand as it is, copies others, refuses the rest", () => {
    const payload = assetDragPayload(library[0] as Asset);
    expect(attachDecision(payload, "b1")).toBe("attach");
    expect(attachDecision(payload, "b2")).toBe("copy");
    expect(attachDecision(payload, null)).toBe("refuse");
    expect(attachDecision(assetDragPayload(library[3] as Asset), "b1")).toBe("refuse");
  });

  it("hands “Sohbete ekle” to the mounted composer", () => {
    const payload = assetDragPayload(library[0] as Asset);
    expect(requestComposerAttach([payload])).toBe(false);
    const listener = vi.fn();
    const off = onComposerAttach(listener);
    expect(requestComposerAttach([payload])).toBe(true);
    expect(listener).toHaveBeenCalledWith([payload]);
    off();
    expect(requestComposerAttach([payload])).toBe(false);
  });
});

describe("AI image request", () => {
  it("builds the image.generate payload or says what is missing", () => {
    expect(
      imageRequestPayload({
        prompt: "  hasat sonrası tarla  ",
        aspectRatio: "9:16",
        imageSize: "1K",
        referenceAssetId: "tarla",
        preserveProductLabel: true,
      }),
    ).toEqual({
      ok: true,
      payload: {
        prompt: "hasat sonrası tarla",
        aspectRatio: "9:16",
        imageSize: "1K",
        referenceAssetIds: ["tarla"],
        preserveProductLabel: true,
      },
    });
    expect(
      imageRequestPayload({
        prompt: " ",
        aspectRatio: "4:5",
        imageSize: "2K",
        referenceAssetId: null,
        preserveProductLabel: false,
      }),
    ).toEqual({ ok: false, reason: "Görseli tarif eden bir metin yaz." });
  });
});
