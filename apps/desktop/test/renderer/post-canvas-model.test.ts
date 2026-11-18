// The canvas editor's model without the engine: geometry → patches, the draft (apply, undo,
// redo, saving, rebasing, recovery), safe areas and collisions, shortcuts, the slide documents
// (brand.css inlined, URLs mapped, morphing), inspector values and the brand kit.
import { applyPatch } from "@studio/design-kit/patch";
import { describe, expect, it, vi } from "vitest";
import {
  DEMO_PROFILE,
  DEMO_SLIDES,
} from "../../src/renderer/features/post-editor/demo/fixtures.ts";
import {
  morphDocument,
  slideDocument,
} from "../../src/renderer/features/post-editor/html/slide-document.ts";
import {
  buildRenderKit,
  resolveVirtualUrl,
} from "../../src/renderer/features/post-editor/model/brand-kit.ts";
import {
  editorSlide,
  layerLabel,
  layerTree,
  parseLayerKey,
  stackIndex,
} from "../../src/renderer/features/post-editor/model/document.ts";
import {
  DraftSession,
  type SlidePatch,
} from "../../src/renderer/features/post-editor/model/draft.ts";
import {
  aabb,
  boxMatrix,
  geometryEdit,
  type MeasuredLayer,
  matrixBox,
  moveOps,
  previewStyle,
  resizedKeepingCorner,
  topLeft,
} from "../../src/renderer/features/post-editor/model/geometry.ts";
import {
  collisions,
  moveInside,
  presetFor,
  safeAreaView,
} from "../../src/renderer/features/post-editor/model/safe-areas.ts";
import {
  diffScene,
  position,
  SceneMap,
  sceneNodes,
  slideRects,
} from "../../src/renderer/features/post-editor/model/scene.ts";
import {
  matchShortcut,
  SHORTCUTS,
} from "../../src/renderer/features/post-editor/model/shortcuts.ts";
import {
  cssColorHex,
  familyCss,
  filterCss,
  parseFilter,
  primaryFamily,
} from "../../src/renderer/features/post-editor/model/style-values.ts";
import { scopedInstruction } from "../../src/renderer/features/post-editor/ui/prompt-bar.tsx";

const HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="studio:contract" content="v1"><meta name="studio:format" content="1080x1350"><link rel="stylesheet" href="/brand/brand.css"></head><body><main data-artboard style="width:1080px;height:1350px">
<div data-layer="bg" data-type="shape" data-role="background" style="position:absolute;left:0;top:0;width:1080px;height:1350px"></div>
<h1 data-layer="headline" data-type="text" data-role="headline" style="position:absolute;left:80px;top:200px;width:600px">Hasat bitti</h1>
<div data-layer="stack" data-type="group" style="position:absolute;left:80px;top:900px;display:flex;gap:16px">
<p data-layer="eyebrow" data-type="text">Üst</p><p data-layer="body" data-type="text">Gövde metni</p>
</div>
<img data-layer="photo" data-type="image" src="/media/a1b2.jpg" alt="" style="position:absolute;left:600px;top:500px;width:400px;height:300px">
</main></body></html>`;

const measured = (x: number, y: number, w: number, h: number, angle = 0): MeasuredLayer => ({
  box: { cx: x + w / 2, cy: y + h / 2, w, h, angle },
  layout: { w, h },
  inherited: { angle: 0, scale: 1 },
  visible: true,
});

describe("the post's layers", () => {
  const slide = editorSlide({ html: HTML, width: 1080, height: 1350 }, 0);

  it("reads the tree with keys, depth and paint order", () => {
    expect(slide.layers.map((l) => l.key)).toEqual([
      "0:bg",
      "0:headline",
      "0:stack",
      "0:eyebrow",
      "0:body",
      "0:photo",
    ]);
    expect(slide.layers.find((l) => l.id === "body")).toMatchObject({
      parent: "stack",
      depth: 1,
      text: "Gövde metni",
    });
    expect(layerTree(slide).map((l) => l.id)).toEqual([
      "photo",
      "stack",
      "body",
      "eyebrow",
      "headline",
      "bg",
    ]);
    expect(stackIndex(slide, "headline")).toEqual({ index: 1, count: 4 });
    expect(parseLayerKey("3:product-photo")).toEqual({ slide: 3, id: "product-photo" });
    expect(layerLabel({ id: "headline", role: "headline", type: "text", text: "x" })).toBe(
      "Başlık",
    );
    expect(layerLabel({ id: "bg", role: "background", type: "shape", text: null })).toBe(
      "Arka plan · Bg",
    );
  });

  it("diffs the scene: nothing for the same post, one field for a moved box, REMOVED for a gone layer", () => {
    const map = new SceneMap();
    const rects = slideRects([slide]);
    const measures = [
      Object.fromEntries(slide.layers.map((l) => [l.id, measured(10, 10, 100, 50)])),
    ];
    const applied = sceneNodes({ slides: [slide], measures, locked: new Set(), rects }, map);
    expect(diffScene(applied, applied)).toEqual([]);
    const moved = sceneNodes(
      {
        slides: [slide],
        measures: [{ ...measures[0], headline: measured(30, 10, 100, 50) }],
        locked: new Set(),
        rects,
      },
      map,
    );
    const change = diffScene(applied, moved);
    expect(change).toHaveLength(1);
    expect(change[0]).toEqual({
      guid: map.guidOf("0:headline"),
      transform: expect.objectContaining({ m02: 30 }),
    });
    const fewer = editorSlide(
      { html: HTML.replace(/<img[^>]*>/, ""), width: 1080, height: 1350 },
      0,
    );
    const removed = diffScene(
      applied,
      sceneNodes({ slides: [fewer], measures, locked: new Set(), rects }, map),
    );
    expect(removed).toEqual([{ guid: map.guidOf("0:photo"), phase: "REMOVED" }]);
    // Children of a group are placed in the group's frame.
    const body = applied.get(map.guidOf("0:body"));
    expect(body?.parentIndex?.guid).toBe(map.guidOf("0:stack"));
    expect(position(0) < position(1) && position(93) < position(94)).toBe(true);
  });
});

describe("geometry → design-kit patches", () => {
  const slide = editorSlide({ html: HTML, width: 1080, height: 1350 }, 0);
  const layer = (id: string) =>
    slide.layers.find((l) => l.id === id) as (typeof slide.layers)[number];

  it("boxes and matrices agree (turned too)", () => {
    const b = { cx: 300, cy: 200, w: 120, h: 80, angle: 30 };
    const back = matrixBox(boxMatrix(b), { x: 120, y: 80 });
    for (const k of ["cx", "cy", "w", "h", "angle"] as const) expect(back[k]).toBeCloseTo(b[k], 6);
    const turned = aabb({ cx: 50, cy: 50, w: 100, h: 20, angle: 90 });
    for (const [k, v] of Object.entries({ x: 40, y: 0, w: 20, h: 100 }))
      expect(turned[k as keyof typeof turned]).toBeCloseTo(v, 9);
    const r = resizedKeepingCorner(b, 200, 100);
    expect(topLeft(r).x).toBeCloseTo(topLeft(b).x, 6);
    expect(topLeft(r).y).toBeCloseTo(topLeft(b).y, 6);
  });

  it("a move is a translate; a turn a rotate; both apply with design-kit", () => {
    const before = measured(80, 200, 600, 100);
    const moved = geometryEdit(layer("headline"), before, {
      ...before.box,
      cx: before.box.cx + 40,
      cy: before.box.cy - 12.04,
    });
    expect(moved.ops).toEqual([
      { op: "transform", layer: "headline", translate: { x: 40, y: -12 } },
    ]);
    const turned = geometryEdit(layer("headline"), before, { ...before.box, angle: -15 });
    expect(turned.ops).toEqual([{ op: "transform", layer: "headline", rotate: -15 }]);
    const html = applyPatch(HTML, moved.ops[0] as never).html;
    expect(html).toContain("translate:40px -12px");
    expect(previewStyle(moved.ops)).toEqual({ translate: "40px -12px" });
  });

  it("a resize sets width / height and keeps the box's centre where the engine put it", () => {
    const before = measured(600, 500, 400, 300);
    // The right edge dragged 100 px out: centre +50.
    const g = geometryEdit(layer("photo"), before, {
      ...before.box,
      cx: before.box.cx + 50,
      w: 500,
    });
    expect(g.ops).toEqual([{ op: "resize", layer: "photo", width: 500 }]);
    expect(g.target).toEqual({ x: 600, y: 500 });
    // The left edge dragged 100 px out: the layout grows right, so a translate brings it back.
    const left = geometryEdit(layer("photo"), before, {
      ...before.box,
      cx: before.box.cx - 50,
      w: 500,
    });
    expect(left.ops).toEqual([
      { op: "transform", layer: "photo", translate: { x: -100, y: 0 } },
      { op: "resize", layer: "photo", width: 500 },
    ]);
  });

  it("text keeps its automatic height unless dragged only vertically", () => {
    const before = measured(80, 200, 600, 100);
    const corner = geometryEdit(layer("headline"), before, {
      ...before.box,
      cx: before.box.cx + 20,
      cy: before.box.cy + 10,
      w: 640,
      h: 120,
    });
    expect(corner.ops.find((o) => o.op === "resize")).toEqual({
      op: "resize",
      layer: "headline",
      width: 640,
    });
    const vertical = geometryEdit(layer("headline"), before, {
      ...before.box,
      cy: before.box.cy + 10,
      h: 120,
    });
    expect(vertical.ops.find((o) => o.op === "resize")).toEqual({
      op: "resize",
      layer: "headline",
      height: 120,
    });
  });

  it("the scale tool writes a uniform scale; an editor transform already there is kept", () => {
    const scaled = editorSlide(
      {
        html: HTML.replace(
          "left:80px;top:200px;width:600px",
          "left:80px;top:200px;width:600px;scale:1.5;translate:10px 0px",
        ),
        width: 1080,
        height: 1350,
      },
      0,
    ).layers.find((l) => l.id === "headline");
    if (!scaled) throw new Error("no layer");
    const before: MeasuredLayer = { ...measured(0, 0, 900, 150), layout: { w: 600, h: 100 } };
    const g = geometryEdit(scaled, before, { ...before.box, w: 1800, h: 300 }, "scale");
    expect(g.ops).toEqual([{ op: "transform", layer: "headline", scale: 3 }]);
    // Resize mode turns the same drag into a layout width (÷ the scale).
    const r = geometryEdit(scaled, before, { ...before.box, w: 1200 }, "resize");
    expect(r.ops).toContainEqual({ op: "resize", layer: "headline", width: 800 });
  });

  it("inside a turned group a move is undone into the parent's frame", () => {
    const before: MeasuredLayer = {
      ...measured(100, 100, 50, 50),
      inherited: { angle: 90, scale: 2 },
    };
    const ops = moveOps(layer("body"), before, 0, 20);
    // 20 px down on the page is 10 px along the group's x axis (turned 90°, scaled ×2).
    expect(ops).toEqual([{ op: "transform", layer: "body", translate: { x: 10, y: 0 } }]);
  });
});

describe("the draft", () => {
  const sources = [{ html: HTML, width: 1080, height: 1350 }];
  const headlineMove = {
    slide: 0,
    op: "transform" as const,
    layer: "headline",
    translate: { x: 10, y: 0 },
  };

  function draft(commit = vi.fn(async (_p: SlidePatch[]) => 2 as number | null), autosaveMs = 0) {
    return {
      commit,
      d: new DraftSession({ commit }, { version: 1, slides: sources }, {}, { autosaveMs }),
    };
  }

  it("applies at once, undoes and redoes with design-kit's inverses (byte for byte)", () => {
    const { d } = draft();
    expect(d.apply([headlineMove], "Taşı")).toBe(true);
    const moved = d.getSnapshot().slides[0]?.html ?? "";
    expect(moved).toContain("translate:10px 0px");
    expect(d.getSnapshot().changedSlides).toEqual([0]);
    expect(d.undo()).toBe("Taşı");
    expect(d.getSnapshot().slides[0]?.html).toBe(HTML);
    expect(d.redo()).toBe("Taşı");
    expect(d.getSnapshot().slides[0]?.html).toBe(moved);
    // Each step went to `pending` for the server: the move, its inverse, the move again.
    expect(d.getSnapshot().pending.map((p) => p.op)).toEqual([
      "transform",
      "replaceLayer",
      "transform",
    ]);
  });

  it("refuses an op design-kit refuses, applying nothing", () => {
    const { d } = draft();
    expect(
      d.apply(
        [headlineMove, { slide: 0, op: "setStyle", layer: "headline", set: { position: "fixed" } }],
        "x",
      ),
    ).toBe(false);
    expect(d.lastError).toMatch(/not editable|not allowed/);
    expect(d.getSnapshot().slides[0]?.html).toBe(HTML);
    expect(d.getSnapshot().pending).toEqual([]);
  });

  it("merges a correction into the last step (one undo)", () => {
    const { d } = draft();
    d.apply([headlineMove], "Boyutlandır");
    d.apply([{ slide: 0, op: "transform", layer: "headline", translate: { x: 12, y: 0 } }], "x", {
      merge: true,
    });
    expect(d.getSnapshot().undo).toHaveLength(1);
    d.undo();
    expect(d.getSnapshot().slides[0]?.html).toBe(HTML);
  });

  it("saves pending edits as one commit; edits during the save wait for the next", async () => {
    let release: (v: number) => void = () => {};
    const commit = vi.fn((_p: SlidePatch[]) => new Promise<number | null>((r) => (release = r)));
    const { d } = draft(commit);
    d.apply([headlineMove], "Taşı");
    const saving = d.flush("Burak");
    expect(d.getSnapshot().inflight).toHaveLength(1);
    d.apply([{ slide: 0, op: "setText", layer: "headline", text: "Kış" }], "Metin");
    release(2);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    release(3);
    expect(await saving).toBe(true);
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[0]?.[0]).toEqual([
      { op: "transform", layer: "headline", translate: { x: 10, y: 0 }, slide: 0 },
    ]);
    expect(commit.mock.calls[1]?.[0].map((p) => p.op)).toEqual(["setText"]);
    expect(d.getSnapshot().baseVersion).toBe(3);
    expect(d.dirty).toBe(false);
  });

  it("keeps the edits when a save fails (offline worker) and retries", async () => {
    const commit = vi.fn(async () => {
      throw new Error("İş zamanında bitmedi");
    });
    const { d } = draft(commit as never);
    d.apply([headlineMove], "Taşı");
    expect(await d.flush()).toBe(false);
    expect(d.getSnapshot().saveError).toBe("İş zamanında bitmedi");
    expect(d.getSnapshot().pending).toHaveLength(1);
    expect(d.getSnapshot().slides[0]?.html).toContain("translate:10px 0px");
  });

  it("saves on its own after a pause, not while a gesture holds it", async () => {
    vi.useFakeTimers();
    try {
      const { d, commit } = draft(undefined, 1000);
      const release = d.hold();
      d.apply([headlineMove], "Taşı");
      await vi.advanceTimersByTimeAsync(2000);
      expect(commit).not.toHaveBeenCalled();
      release();
      await vi.advanceTimersByTimeAsync(1100);
      expect(commit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebases unsaved edits on a version from elsewhere, or drops them when they no longer fit", () => {
    const { d } = draft();
    d.apply([headlineMove], "Taşı");
    const ai = HTML.replace("Hasat bitti", "Kış geldi");
    expect(d.rebase({ version: 5, slides: [{ html: ai, width: 1080, height: 1350 }] })).toBe(true);
    expect(d.getSnapshot().slides[0]?.html).toContain("Kış geldi");
    expect(d.getSnapshot().slides[0]?.html).toContain("translate:10px 0px");
    const gone = HTML.replace(/<h1[\s\S]*?<\/h1>/, "");
    expect(d.rebase({ version: 6, slides: [{ html: gone, width: 1080, height: 1350 }] })).toBe(
      false,
    );
    expect(d.getSnapshot().pending).toEqual([]);
    expect(d.getSnapshot().undo).toEqual([]);
  });

  it("recovers unsaved edits a closed window left for the same base version", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const a = new DraftSession(
      { commit: async () => 2 },
      { version: 1, slides: sources },
      {},
      { autosaveMs: 0, storage, storageKey: "k" },
    );
    a.apply([headlineMove], "Taşı");
    const b = new DraftSession(
      { commit: async () => 2 },
      { version: 1, slides: sources },
      {},
      { autosaveMs: 0, storage, storageKey: "k" },
    );
    expect(b.recover()).toBe(true);
    expect(b.getSnapshot().slides[0]?.html).toContain("translate:10px 0px");
    const other = new DraftSession(
      { commit: async () => 2 },
      { version: 2, slides: sources },
      {},
      { autosaveMs: 0, storage, storageKey: "k" },
    );
    expect(other.recover()).toBe(false);
  });
});

describe("safe areas", () => {
  const story = editorSlide({ html: DEMO_SLIDES.story[0] as string, width: 1080, height: 1920 }, 0);

  it("picks the preset from the post's type, size and platform", () => {
    expect(presetFor("story", ["instagram"], { width: 1080, height: 1920 })?.id).toBe(
      "instagram-story",
    );
    expect(presetFor("reel", ["instagram"], { width: 1080, height: 1920 })?.id).toBe(
      "instagram-reel-cover",
    );
    expect(presetFor("carousel", ["facebook"], { width: 1080, height: 1350 })?.id).toBe(
      "facebook-feed-portrait",
    );
    expect(presetFor("post", [], { width: 1080, height: 1080 })?.id).toBe("instagram-feed-square");
    const feed = safeAreaView(presetFor("carousel", [], { width: 1080, height: 1350 }) as never);
    expect(feed.gridCrop).toEqual({ x: 33.75, y: 0, w: 1012.5, h: 1350 });
  });

  it("warns for text in the story's reply area and computes the move that fixes it", () => {
    const view = safeAreaView(
      presetFor("story", ["instagram"], { width: 1080, height: 1920 }) as never,
    );
    expect(view.bands.map((b) => b.label)).toEqual([
      "Profil ve süre çubuğu · 250 px",
      "Yanıt alanı · 340 px",
    ]);
    const measure = {
      cta: measured(285, 1750, 510, 65),
      headline: measured(80, 1000, 900, 220),
      background: measured(0, 0, 1080, 1920),
    };
    const found = collisions(story.layers, measure, story, view);
    expect(found.map((c) => c.layerId)).toEqual(["cta"]);
    expect(found[0]?.edges).toEqual(["bottom"]);
    expect(found[0]?.fix).toEqual({ dx: 0, dy: -235 });
    expect(found[0]?.message).toContain("alt 340 px");
    expect(
      moveInside({ x: 0, y: 0, w: 2000, h: 10 }, { x: 64, y: 64, w: 952, h: 1222 }),
    ).toBeNull();
  });
});

describe("shortcuts", () => {
  const key = (
    code: string,
    key: string,
    mods: Partial<{ meta: boolean; shift: boolean; alt: boolean }> = {},
  ) => ({
    code,
    key,
    metaKey: !!mods.meta,
    ctrlKey: false,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
  });

  it("cover the design's table", () => {
    const cases: [ReturnType<typeof key>, string][] = [
      [key("KeyV", "v"), "tool.move"],
      [key("KeyZ", "z", { meta: true }), "undo"],
      [key("KeyZ", "z", { meta: true, shift: true }), "redo"],
      [key("KeyD", "d", { meta: true }), "layer.duplicate"],
      [key("KeyD", "d", { meta: true, shift: true }), "slide.duplicate"],
      [key("KeyK", "k", { meta: true }), "ai.focus"],
      [key("KeyK", "k", { meta: true, shift: true }), "image.place"],
      [key("Digit1", "!", { shift: true }), "zoom.fit"],
      [key("Equal", "=", { meta: true }), "zoom.in"],
      [key("Quote", "'", { meta: true }), "view.safeArea"],
      [key("KeyR", "r", { shift: true }), "view.rulers"],
      [key("KeyR", "r"), "layer.shape"],
      [key("Enter", "Enter", { meta: true }), "approve"],
      [key("Enter", "Enter", { meta: true, shift: true }), "schedule"],
      [key("Backspace", "Backspace"), "layer.delete"],
      [key("Delete", "Delete"), "layer.delete"],
      [key("BracketRight", "]", { meta: true }), "layer.forward"],
      [key("Escape", "Escape"), "escape"],
    ];
    for (const [e, command] of cases) expect(matchShortcut(e)?.command, `${e.code}`).toBe(command);
    expect(matchShortcut(key("KeyQ", "q"))).toBeNull();
    expect(matchShortcut(key("KeyV", "v", { alt: true }))).toBeNull();
    // Every command in the table is reachable.
    expect(new Set(SHORTCUTS.map((s) => s.command)).size).toBe(SHORTCUTS.length);
  });
});

describe("slide documents", () => {
  const kit = { css: ":root{--color-ink:#111}", files: { "logos/mark.svg": "asset-9" } };

  it("inlines brand.css where its link was and maps /media and /brand", () => {
    const html = HTML.replace(
      "</main>",
      '<img data-layer="logo" data-type="logo" src="/brand/logos/mark.svg" alt=""></main>',
    );
    const doc = slideDocument(html, kit);
    expect(doc).not.toContain("/brand/brand.css");
    expect(doc).toContain(":root{--color-ink:#111}");
    expect(doc).toContain('src="/api/assets/a1b2/content"');
    expect(doc).toContain('src="/api/assets/asset-9/content"');
    expect(doc).toContain("Content-Security-Policy");
    expect(resolveVirtualUrl("/media/x%20y.png", {})).toBe("/api/assets/x%20y/content");
    expect(resolveVirtualUrl("/brand/fonts/missing.woff2", {})).toBeNull();
  });

  it("morphs a live document in place (untouched nodes stay the same objects)", () => {
    const live = new DOMParser().parseFromString(slideDocument(HTML, kit), "text/html");
    const photo = live.querySelector('[data-layer="photo"]');
    const moved = applyPatch(HTML, {
      op: "transform",
      layer: "headline",
      translate: { x: 5, y: 5 },
    }).html;
    expect(morphDocument(live, slideDocument(moved, kit))).toBe("morphed");
    expect(live.querySelector('[data-layer="headline"]')?.getAttribute("style")).toContain(
      "translate:5px 5px",
    );
    expect(live.querySelector('[data-layer="photo"]')).toBe(photo);
    const reordered = applyPatch(moved, { op: "moveLayer", layer: "photo", index: 0 }).html;
    morphDocument(live, slideDocument(reordered, kit));
    expect(
      [...live.querySelectorAll("main > [data-layer]")].map((e) => e.getAttribute("data-layer")),
    ).toEqual(["photo", "bg", "headline", "stack"]);
    expect(morphDocument(live, slideDocument(HTML, { ...kit, css: "x{}" }))).toBe("reload");
  });
});

describe("inspector values", () => {
  it("adjustments round-trip through a design-kit-allowed filter", () => {
    const a = { exposure: 6, contrast: 8, saturation: -4, warmth: 18 };
    const css = filterCss(a) as string;
    expect(
      applyPatch(HTML, { op: "setStyle", layer: "photo", set: { filter: css } }).html,
    ).toContain("filter:");
    expect(parseFilter(css)).toEqual(a);
    expect(filterCss({ exposure: 0, contrast: 0, saturation: 0, warmth: 0 })).toBeNull();
  });

  it("reads colours and families", () => {
    expect(cssColorHex("rgb(255, 106, 0)")).toBe("#FF6A00");
    expect(cssColorHex("#abc")).toBe("#AABBCC");
    expect(primaryFamily('"Avenir Next", sans-serif')).toBe("Avenir Next");
    expect(familyCss("SF Pro Display")).toBe('"SF Pro Display", sans-serif');
    expect(familyCss('Evil"; x')).toBeNull();
    const html = applyPatch(HTML, {
      op: "setStyle",
      layer: "headline",
      set: { "font-family": familyCss("Futura") as string },
    }).html;
    expect(html).toContain("font-family:&quot;Futura&quot;, sans-serif");
  });

  it("scopes an AI request to the picked layers", () => {
    const describe = (key: string) => ({
      slide: 0,
      id: key.split(":")[1] as string,
      label: "Başlık",
    });
    expect(scopedInstruction("Kısalt", ["0:headline"], describe)).toBe(
      "Kapsam: Kare 1 › headline (Başlık). Yalnızca bu katmanları değiştir; diğerlerini olduğu gibi bırak.\nKısalt",
    );
    expect(scopedInstruction("Kısalt", [], describe)).toBe("Kısalt");
  });
});

describe("the brand kit", () => {
  it("builds the worker's brand.css from the approved profile, else the neutral default", () => {
    const kit = buildRenderKit(DEMO_PROFILE);
    expect(kit.mode).toBe("approved");
    expect(kit.css).toContain("--color-forest: #2F5D2B");
    expect(kit.swatches.map((s) => s.token)).toContain("harvest");
    expect(kit.fonts).toEqual([
      { role: "display", family: "Avenir Next" },
      { role: "text", family: "Helvetica Neue" },
    ]);
    expect(kit.ctx.colorTokens).toContain("forest");
    expect(buildRenderKit({ ...DEMO_PROFILE, status: "draft" }).mode).toBe("neutral");
    expect(buildRenderKit({ status: "approved", tokens: { nonsense: true } }).mode).toBe("neutral");
  });

  it("every demo slide parses into layers and passes design-kit's patch checks", () => {
    for (const html of [...DEMO_SLIDES.carousel, ...DEMO_SLIDES.story]) {
      const s = editorSlide({ html, width: 1080, height: 1350 }, 0);
      expect(s.layers.length).toBeGreaterThan(3);
      const headline = s.layers.find((l) => l.role === "headline");
      if (!headline) throw new Error("no headline");
      expect(() =>
        applyPatch(html, { op: "transform", layer: headline.id, translate: { x: 1, y: 1 } }),
      ).not.toThrow();
    }
  });
});
