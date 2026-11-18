// The adapter against Wecra's real engine (the vendored Wasm build, headless): a post becomes
// the engine document and reads back the same; the engine's own gestures (drag with snapping,
// ⌥-drag, a resize handle, a turn, reordering) come back as design-kit patches that apply.
import { applyPatch } from "@studio/design-kit/patch";
import { describe, expect, it } from "vitest";
import { engineReader } from "../../src/renderer/features/post-editor/canvas/reader.ts";
import {
  type NodeChange,
  StudioEngine,
} from "../../src/renderer/features/post-editor/engine/studio-engine.ts";
import { editorSlides, findLayer } from "../../src/renderer/features/post-editor/model/document.ts";
import {
  geometryEdit,
  type MeasuredLayer,
  type OBox,
} from "../../src/renderer/features/post-editor/model/geometry.ts";
import {
  classifyChanges,
  diffScene,
  mergeApplied,
  SceneMap,
  sceneNodes,
  slideRects,
} from "../../src/renderer/features/post-editor/model/scene.ts";

const HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="studio:contract" content="v1"><meta name="studio:format" content="1080x1350"><link rel="stylesheet" href="/brand/brand.css"></head><body><main data-artboard style="width:1080px;height:1350px">
<div data-layer="bg" data-type="shape" data-role="background" style="position:absolute;left:0;top:0;width:1080px;height:1350px"></div>
<h1 data-layer="headline" data-type="text" data-role="headline" style="position:absolute;left:80px;top:200px;width:600px">Hasat bitti</h1>
<p data-layer="sub" data-type="text" style="position:absolute;left:80px;top:500px;width:400px">Alt başlık</p>
<div data-layer="badge" data-type="shape" style="position:absolute;left:300px;top:900px;width:200px;height:200px"></div>
</main></body></html>`;

const at = (x: number, y: number, w: number, h: number, angle = 0): MeasuredLayer => ({
  box: { cx: x + w / 2, cy: y + h / 2, w, h, angle },
  layout: { w, h },
  inherited: { angle: 0, scale: 1 },
  visible: true,
});

const MEASURE: Record<string, MeasuredLayer> = {
  bg: at(0, 0, 1080, 1350),
  headline: at(80, 200, 600, 100),
  sub: at(80, 500, 400, 40),
  badge: at(300, 900, 200, 200),
};

async function setup(slideCount = 2) {
  const sources = Array.from({ length: slideCount }, () => ({
    html: HTML,
    width: 1080,
    height: 1350,
  }));
  const slides = editorSlides(sources);
  const rects = slideRects(slides);
  const map = new SceneMap();
  const engine = await StudioEngine.create(null);
  engine.loadBlank();
  const applied = new Map<string, NodeChange>();
  const nodes = sceneNodes(
    { slides, measures: slides.map(() => MEASURE), locked: new Set(), rects },
    map,
  );
  const changes = diffScene(applied, nodes);
  expect(engine.applyChanges(changes, "remote")).toBe(0);
  mergeApplied(applied, changes);
  engine.setViewport(1200, 900, 1, 1200, 900);
  engine.setCamera({ x: 0, y: 0, zoom: 0.5 });
  const reader = engineReader(engine, map, () => rects);
  const documents: { changes: NodeChange[]; label: string }[] = [];
  engine.on("DOCUMENT_CHANGED", (e) =>
    documents.push({ changes: e.message.nodeChanges, label: e.label }),
  );
  return { engine, slides, rects, map, applied, reader, documents };
}

/** Screen point (zoom 0.5, camera at 0,0) of an artboard point on slide 0. */
const screen = (x: number, y: number) => [x * 0.5, y * 0.5] as const;

function drag(
  engine: StudioEngine,
  from: readonly [number, number],
  to: readonly [number, number],
  mods = 0,
) {
  engine.pointer(0, from[0], from[1], 0, 1, mods);
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    const x = from[0] + ((to[0] - from[0]) * i) / steps;
    const y = from[1] + ((to[1] - from[1]) * i) / steps;
    engine.pointer(1, x, y, 0, 1, mods);
  }
  engine.pointer(2, to[0], to[1], 0, 0, mods);
}

const closeBox = (a: OBox, b: OBox) => {
  for (const k of ["cx", "cy", "w", "h", "angle"] as const) expect(a[k]).toBeCloseTo(b[k], 3);
};

describe("post ⇄ engine document", () => {
  it("round-trips: every layer reads back at its measured box, frames unnamed", async () => {
    const { engine, slides, map, reader } = await setup();
    for (const slide of slides) {
      for (const layer of slide.layers) {
        const guid = map.guidOf(layer.key);
        const node = engine.readNode(guid, {
          fields: ["name", "parentIndex", "locked", "fillPaints"],
        });
        expect(node?.name).toBe(layer.key);
        expect(node?.parentIndex?.guid).toBe(map.frameGuid(slide.index));
        expect(node?.fillPaints).toEqual([]);
        const box = reader.boxInSlide(guid, slide.index);
        expect(box).not.toBeNull();
        closeBox(box as OBox, (MEASURE[layer.id] as MeasuredLayer).box);
      }
      const frame = engine.readNode(map.frameGuid(slide.index), {
        fields: ["locked", "name", "transform"],
      });
      expect(frame?.locked).toBe(false);
      expect(frame?.name).toBe("");
      expect(frame?.transform?.m02).toBe(slide.index * (1080 + 120));
    }
    // Rebuilt from the same post: nothing to change.
    const again = sceneNodes(
      { slides, measures: slides.map(() => MEASURE), locked: new Set(), rects: slideRects(slides) },
      map,
    );
    const { applied } = await setup();
    expect(diffScene(applied, again)).toEqual([]);
    engine.destroy();
  });

  it("a moved layer becomes a translate patch; the drag snaps to another layer's edge", async () => {
    const { engine, slides, map, applied, reader, documents } = await setup();
    // sub (left 80) dragged 216 px right: its left edge (296) snaps to badge's (300).
    drag(engine, screen(280, 520), screen(280 + 216, 520));
    expect(documents).toHaveLength(1);
    const doc = documents[0] as { changes: NodeChange[]; label: string };
    const edits = classifyChanges(doc.changes, map, applied, reader);
    expect(edits).toHaveLength(1);
    const edit = edits[0];
    expect(edit?.kind).toBe("geometry");
    if (edit?.kind !== "geometry") return;
    expect(edit.key).toBe("0:sub");
    const layer = findLayer(slides, "0:sub");
    if (!layer) throw new Error("no layer");
    const { ops } = geometryEdit(layer, MEASURE.sub as MeasuredLayer, edit.box);
    expect(ops).toEqual([{ op: "transform", layer: "sub", translate: { x: 220, y: 0 } }]);
    const html = applyPatch(HTML, ops[0] as never).html;
    expect(html).toContain(
      'style="position:absolute;left:80px;top:500px;width:400px;translate:220px 0px"',
    );
    engine.destroy();
  });

  it("a resize handle becomes width / height, the box's corner kept", async () => {
    const { engine, slides, map, applied, reader, documents } = await setup();
    // Select badge, then drag its bottom-right handle 100 px right and 50 px down.
    drag(engine, screen(400, 1000), screen(400, 1000));
    documents.length = 0;
    drag(engine, screen(500, 1100), screen(600, 1150));
    expect(documents).toHaveLength(1);
    const edits = classifyChanges(
      (documents[0] as { changes: NodeChange[] }).changes,
      map,
      applied,
      reader,
    );
    const edit = edits[0];
    if (edit?.kind !== "geometry") throw new Error(`not geometry: ${JSON.stringify(edits)}`);
    const layer = findLayer(slides, "0:badge");
    if (!layer) throw new Error("no layer");
    const g = geometryEdit(layer, MEASURE.badge as MeasuredLayer, edit.box);
    expect(g.ops).toContainEqual({ op: "resize", layer: "badge", width: 300, height: 250 });
    // A left/top-anchored box grows right and down: no translate needed.
    expect(g.ops.find((o) => o.op === "transform")).toBeUndefined();
    expect(g.target).toEqual({ x: 300, y: 900 });
    engine.destroy();
  });

  it("⌥-drag makes a copy: a duplicateLayer with the offset", async () => {
    const { engine, map, applied, reader, documents } = await setup();
    drag(engine, screen(400, 1000), screen(400 + 120, 1000), 2 /* ⌥ */);
    expect(documents).toHaveLength(1);
    const edits = classifyChanges(
      (documents[0] as { changes: NodeChange[] }).changes,
      map,
      applied,
      reader,
    );
    expect(edits).toHaveLength(1);
    const edit = edits[0];
    if (edit?.kind !== "duplicate") throw new Error(`not a duplicate: ${JSON.stringify(edits)}`);
    expect(edit.sourceKey).toBe("0:badge");
    // 60 screen px at 50 %: 120 artboard px.
    expect(edit.box.cx - (MEASURE.badge as MeasuredLayer).box.cx).toBeCloseTo(120, 3);
    engine.destroy();
  });

  it("a turn (an edit applied as the user's) becomes a rotate patch", async () => {
    const { engine, slides, map, applied, reader, documents } = await setup();
    const guid = map.guidOf("0:badge");
    // The badge turned 15° about its centre (400, 1000).
    const r = (15 * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const transform = {
      m00: c,
      m01: -s,
      m02: 400 - c * 100 + s * 100,
      m10: s,
      m11: c,
      m12: 1000 - s * 100 - c * 100,
    };
    engine.applyChanges([{ guid, transform } as NodeChange], "user");
    const edits = classifyChanges(
      (documents[0] as { changes: NodeChange[] }).changes,
      map,
      applied,
      reader,
    );
    const edit = edits[0];
    if (edit?.kind !== "geometry") throw new Error("not geometry");
    const layer = findLayer(slides, "0:badge");
    if (!layer) throw new Error("no layer");
    expect(geometryEdit(layer, MEASURE.badge as MeasuredLayer, edit.box).ops).toEqual([
      { op: "transform", layer: "badge", rotate: 15 },
    ]);
    engine.destroy();
  });

  it("arrow keys nudge the selection (⇧: 10 px) into translate patches", async () => {
    const { engine, slides, map, applied, reader, documents } = await setup();
    engine.setSelection([map.guidOf("0:badge")]);
    engine.key("down", "ArrowRight", "ArrowRight", 0);
    engine.key("up", "ArrowRight", "ArrowRight", 0);
    engine.key("down", "ArrowDown", "ArrowDown", 1 /* ⇧ */);
    engine.key("up", "ArrowDown", "ArrowDown", 1);
    const all = documents.flatMap((d) => d.changes);
    const edit = classifyChanges(all, map, applied, reader).find((e) => e.kind === "geometry");
    if (edit?.kind !== "geometry") throw new Error("no geometry edit");
    const layer = findLayer(slides, "0:badge");
    if (!layer) throw new Error("no layer");
    expect(geometryEdit(layer, MEASURE.badge as MeasuredLayer, edit.box).ops).toEqual([
      { op: "transform", layer: "badge", translate: { x: 1, y: 10 } },
    ]);
    engine.destroy();
  });

  it("bring forward reorders: a moveLayer to the new stack index", async () => {
    const { engine, map, applied, reader, documents } = await setup();
    engine.setSelection([map.guidOf("0:sub")]);
    expect(engine.command("BRING_FORWARD")).toBe(0);
    const edits = classifyChanges(
      (documents[0] as { changes: NodeChange[] }).changes,
      map,
      applied,
      reader,
    );
    expect(edits).toContainEqual({ kind: "reorder", key: "0:sub", index: 3 });
    engine.destroy();
  });

  it("deleting in the engine and toggling visibility map to deleteLayer and setVisibility", async () => {
    const { engine, map, applied, reader, documents } = await setup();
    engine.setSelection([map.guidOf("0:headline")]);
    engine.command("TOGGLE_VISIBLE");
    engine.command("DELETE");
    const all = documents.flatMap((d) => d.changes);
    const edits = classifyChanges(all, map, applied, reader);
    expect(edits).toContainEqual({ kind: "visibility", key: "0:headline", hidden: true });
    expect(edits).toContainEqual({ kind: "delete", key: "0:headline" });
    engine.destroy();
  });

  it("locked layers are not picked; the frame under them is not either (it is locked)", async () => {
    const { engine, map, slides, rects } = await setup(1);
    const nodes = sceneNodes(
      { slides, measures: [MEASURE], locked: new Set(["0:badge"]), rects },
      map,
    );
    engine.applyChanges(
      [...nodes.values()]
        .filter((n) => n.name === "0:badge")
        .map((n) => ({ guid: n.guid, locked: true }) as NodeChange),
      "remote",
    );
    const hits = engine.hitTest(...screen(400, 1000));
    expect(hits).not.toContain(map.guidOf("0:badge"));
    engine.destroy();
  });
});
