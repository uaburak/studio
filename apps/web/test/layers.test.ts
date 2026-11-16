import { describe, expect, it } from "vitest";
import {
  clearSlideSlot,
  collectSlotAssignments,
  createHistory,
  fillSlideSlot,
  moveSlideLayer,
  parseSlideLayers,
  pushHistory,
  redoHistory,
  reorderSlideLayer,
  resizeSlideLayer,
  setSlideArtboardSize,
  undoHistory,
  updateSlideLayerStyle,
  updateSlideLayerText,
} from "../src/lib/layers.ts";
import { buildEditorSlideSrcdoc, extractSlideAssetRefs } from "../src/lib/slide-preview.ts";

const SAMPLE_SLIDE = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="studio:contract" content="v1">
  <meta name="studio:format" content="1080x1350">
  <style>
    .headline { font-family: var(--font-display); font-size: 88px; color: #1b1a17; }
  </style>
</head>
<body>
  <main data-artboard style="width:1080px;height:1350px">
    <figure data-layer="hero-slot" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty"
            data-slot-label="Ürün fotoğrafı" data-slot-fit="cover"
            style="position:absolute; left:72px; top:72px; width:560px; height:700px"></figure>
    <div data-layer="bg-band" data-type="shape"
         style="position:absolute; left:0px; top:800px; width:1080px; height:16px; background-color:#2c7a4b"></div>
    <div data-layer="copy-group" data-type="group" style="position:absolute; left:72px; top:860px; width:936px">
      <h1 data-layer="headline" data-type="text" data-role="headline" class="headline">Bor ve çinko<br>bir arada</h1>
      <p data-layer="body" data-type="text" data-role="body">Yüksek verim için dengeli formül.</p>
    </div>
    <img data-layer="brand-logo" data-type="logo" src="/brand/logos/venta.png" alt="Venta"
         style="position:absolute; left:72px; top:1240px; width:180px; height:40px">
  </main>
</body>
</html>`;

describe("HTML layer parser & patcher", () => {
  it("parses artboard size and all [data-layer] elements with roles, slots, and styles", () => {
    const parsed = parseSlideLayers(SAMPLE_SLIDE);
    expect(parsed.artboard).toEqual({ width: 1080, height: 1350 });
    expect(parsed.layers.map((l) => `${l.id}:${l.type}`)).toEqual([
      "hero-slot:slot",
      "bg-band:shape",
      "copy-group:group",
      "headline:text",
      "body:text",
      "brand-logo:logo",
    ]);

    const slot = parsed.layers.find((l) => l.id === "hero-slot");
    expect(slot).toMatchObject({
      slotState: "empty",
      slotRatio: "4:5",
      slotLabel: "Ürün fotoğrafı",
      bounds: { x: 72, y: 72, width: 560, height: 700 },
    });

    const headline = parsed.layers.find((l) => l.id === "headline");
    expect(headline?.text).toBe("Bor ve çinko\nbir arada");
    expect(headline?.fontSize).toBe(88);
    expect(headline?.parentId).toBe("copy-group");
  });

  it("moves top-level absolute layers via left/top and nested group children via translate", () => {
    const movedAbs = moveSlideLayer(SAMPLE_SLIDE, "hero-slot", { dx: 28, dy: -12 });
    const slot = parseSlideLayers(movedAbs).layers.find((l) => l.id === "hero-slot");
    expect(slot?.bounds.x).toBe(100);
    expect(slot?.bounds.y).toBe(60);

    const movedNested = moveSlideLayer(SAMPLE_SLIDE, "headline", { dx: 15, dy: 25 });
    const headline = parseSlideLayers(movedNested).layers.find((l) => l.id === "headline");
    expect(headline?.translate).toEqual({ x: 15, y: 25 });
  });

  it("resizes layers, updates multiline text safely, and patches styles & visibility", () => {
    let html = resizeSlideLayer(SAMPLE_SLIDE, "hero-slot", { width: 640, height: 800 });
    html = updateSlideLayerText(html, "headline", "Yeni <Başlık>\nİkinci satır");
    html = updateSlideLayerStyle(html, "headline", {
      fontSize: 72,
      color: "#df4325",
      textAlign: "center",
      opacity: 0.8,
      hidden: true,
    });

    const parsed = parseSlideLayers(html);
    const slot = parsed.layers.find((l) => l.id === "hero-slot");
    expect(slot?.bounds).toMatchObject({ width: 640, height: 800 });

    const headline = parsed.layers.find((l) => l.id === "headline");
    expect(headline?.text).toBe("Yeni <Başlık>\nİkinci satır");
    expect(headline?.fontSize).toBe(72);
    expect(["#df4325", "rgb(223, 67, 37)"]).toContain(headline?.color);
    expect(headline?.textAlign).toBe("center");
    expect(headline?.opacity).toBe(0.8);
    expect(headline?.hidden).toBe(true);
    expect(html).toContain("data-hidden");
  });

  it("reorders sibling layers in z-order", () => {
    const up = reorderSlideLayer(SAMPLE_SLIDE, "hero-slot", "up");
    const rootIds = parseSlideLayers(up)
      .layers.filter((l) => l.parentId === null)
      .map((l) => l.id);
    expect(rootIds).toEqual(["bg-band", "hero-slot", "copy-group", "brand-logo"]);

    const front = reorderSlideLayer(SAMPLE_SLIDE, "hero-slot", "front");
    const rootFrontIds = parseSlideLayers(front)
      .layers.filter((l) => l.parentId === null)
      .map((l) => l.id);
    expect(rootFrontIds[rootFrontIds.length - 1]).toBe("hero-slot");
  });

  it("fills and clears visual slots and extracts slotAssignments & asset URLs", () => {
    const filled = fillSlideSlot(SAMPLE_SLIDE, "hero-slot", {
      src: "/media/asset-42.jpg",
      alt: "Tarla sahnesi",
      assetId: "asset-42",
      fit: "cover",
    });

    const parsed = parseSlideLayers(filled);
    const slot = parsed.layers.find((l) => l.id === "hero-slot");
    expect(slot?.slotState).toBe("filled");
    expect(slot?.src).toBe("/media/asset-42.jpg");
    expect(slot?.assetId).toBe("asset-42");
    expect(filled).toContain("data-slot-image");

    expect(collectSlotAssignments([{ html: filled, width: 1080, height: 1350 }])).toEqual({
      "hero-slot": "asset-42",
    });

    const refs = extractSlideAssetRefs(filled);
    expect(refs).toEqual([{ rawUrl: "/media/asset-42.jpg", assetId: "asset-42" }]);

    const srcDoc = buildEditorSlideSrcdoc(
      filled,
      new Map([["/media/asset-42.jpg", "blob:http://localhost/mock-uuid"]]),
    );
    expect(srcDoc).toContain('src="blob:http://localhost/mock-uuid"');
    expect(srcDoc).toContain("default-src 'none'");

    const cleared = clearSlideSlot(filled, "hero-slot");
    expect(parseSlideLayers(cleared).layers.find((l) => l.id === "hero-slot")?.slotState).toBe(
      "empty",
    );
  });

  it("changes artboard dimensions and updates studio:format meta", () => {
    const story = setSlideArtboardSize(SAMPLE_SLIDE, 1080, 1920);
    expect(parseSlideLayers(story).artboard).toEqual({ width: 1080, height: 1920 });
    expect(story).toContain('content="1080x1920"');
  });
});

describe("Editor undo/redo history stack", () => {
  it("supports multi-step undo, redo, and clears future on new branch edit", () => {
    let h = createHistory("v0");
    h = pushHistory(h, "v1");
    h = pushHistory(h, "v2");
    expect(h.present).toBe("v2");

    h = undoHistory(h);
    expect(h.present).toBe("v1");
    h = undoHistory(h);
    expect(h.present).toBe("v0");
    // Extra undo at boundary is a no-op
    expect(undoHistory(h).present).toBe("v0");

    h = redoHistory(h);
    expect(h.present).toBe("v1");

    // Branching clears redo stack
    h = pushHistory(h, "v3");
    expect(h.present).toBe("v3");
    expect(h.future).toEqual([]);
  });
});
