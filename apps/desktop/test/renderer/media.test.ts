import type { Asset } from "@studio/contract";
import { describe, expect, it, vi } from "vitest";
import {
  analysisTooltip,
  assetMeta,
  downloadName,
  filterAssets,
  imageRequestPayload,
  isImageAsset,
  lightboxImages,
  mediaCounts,
  mediaSummary,
  tileDetail,
  topTags,
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

  it("sends the product's place, size and label text only for a label-preserving picture (U9)", () => {
    const base = {
      prompt: "tarla",
      aspectRatio: "4:5" as const,
      imageSize: "2K" as const,
      referenceAssetId: "ref",
      preserveProductLabel: true,
      productPosition: "bottom-left" as const,
      productSize: "large" as const,
      labelText: "  VENTA BORİNÇ\nGÜBRE 25 KG ",
    };
    expect(imageRequestPayload(base)).toEqual({
      ok: true,
      payload: {
        prompt: "tarla",
        aspectRatio: "4:5",
        imageSize: "2K",
        referenceAssetIds: ["ref"],
        preserveProductLabel: true,
        productPosition: "bottom-left",
        productScale: 0.78,
        labelText: "VENTA BORİNÇ\nGÜBRE 25 KG",
      },
    });
    const defaults = imageRequestPayload({
      ...base,
      productPosition: "auto",
      productSize: "medium",
      labelText: " ",
    });
    expect(defaults.ok && defaults.payload).toEqual({
      prompt: "tarla",
      aspectRatio: "4:5",
      imageSize: "2K",
      referenceAssetIds: ["ref"],
      preserveProductLabel: true,
    });
    const off = imageRequestPayload({ ...base, preserveProductLabel: false });
    expect(off.ok && off.payload).not.toHaveProperty("labelText");
  });
});

describe("media tagging and search (N12)", () => {
  const tagged = (id: string, labels: string[], over: Partial<Asset> = {}): Asset =>
    asset(id, {
      analysis: {
        status: "complete",
        tags: labels.map((label, i) => ({ id: `tag_${i}`, label, confidence: 0.9 - i * 0.1 })),
        text: id === "bag" ? "VENTA BORİNÇ" : "",
        colors: [{ hex: "#2f7d32", share: 0.6, name: "yeşil" }],
        orientation: "portrait",
        aspectRatio: 0.8,
        isCutout: id === "bag",
        isLogoLike: false,
        caption: null,
        hasFeaturePrint: true,
        note: null,
        analyzedAt: "2026-11-19T10:00:00.000Z",
      },
      ...over,
    });

  it("searches what Vision read: Turkish tags, the text on the picture, colours, cutouts", () => {
    const all = [tagged("field", ["tarla", "buğday"]), tagged("bag", ["çuval"]), asset("plain")];
    expect(filterAssets(all, "bugday").map((a) => a.id)).toEqual(["field"]);
    expect(filterAssets(all, "borinç").map((a) => a.id)).toEqual(["bag"]);
    expect(filterAssets(all, "dekupe").map((a) => a.id)).toEqual(["bag"]);
    expect(
      filterAssets(all, "yeşil dikey")
        .map((a) => a.id)
        .sort(),
    ).toEqual(["bag", "field"]);
    expect(filterAssets(all, "plain").map((a) => a.id)).toEqual(["plain"]);
  });

  it("offers the most common tags as chips and shows the first tags under a tile", () => {
    const all = [
      tagged("a", ["tarla", "buğday"]),
      tagged("b", ["tarla"]),
      tagged("c", ["çuval", "tarla"]),
      asset("d"),
    ];
    expect(topTags(all)).toEqual([
      { label: "tarla", count: 3 },
      { label: "buğday", count: 1 },
      { label: "çuval", count: 1 },
    ]);
    expect(topTags(all, 1)).toEqual([{ label: "tarla", count: 3 }]);
    expect(tileDetail(all[0] as Asset)).toBe("1080×1350 · tarla, buğday");
    expect(tileDetail(asset("d"))).toBe("1080×1350 · 2,4 MB");
    expect(analysisTooltip(tagged("bag", ["çuval"]))).toBe(
      "Etiketler: çuval\nYazı: VENTA BORİNÇ\nRenkler: yeşil",
    );
    expect(analysisTooltip(asset("d"))).toBeUndefined();
  });
});
