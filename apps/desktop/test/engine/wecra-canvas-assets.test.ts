// The brand kit, image slots, the brand's logo and safe areas on the canvas (real engine,
// headless): the kit's colours and type as the document's styles (once, linked), a slot filled
// and emptied (undoable, its mark following, the checks seeing it), the logo placed as the
// brand's logo for its background, the safe-area bands drawn by the engine.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WNode } from "@shared/agents/web/convert";
import { parseBrandTokens } from "@studio/design-kit/brand";
import { canvasLayers } from "@studio/design-kit/canvas";
import { describe, expect, it, vi } from "vitest";
import { EditorController } from "@/editor/controller";
import { memoryDocumentSource } from "@/editor/documentSource";
import { EMPTY_DOCUMENT } from "@/editor/fixtures";
import { CMD_ENABLED } from "@/engine/abi";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import {
  BRAND_STYLE_TAG,
  brandStyleSpecs,
  prepareBrandStyles,
} from "../../src/renderer/features/post-editor/wecra/brand-styles.ts";
import { BundleImages } from "../../src/renderer/features/post-editor/wecra/bundle.ts";
import { canvasFacts } from "../../src/renderer/features/post-editor/wecra/facts.ts";
import {
  finishSlide,
  importSlides,
  layerMarks,
  slideSpec,
} from "../../src/renderer/features/post-editor/wecra/import.ts";
import {
  attachSafeAreas,
  initSafeAreas,
  postPreset,
  SAFE_AREA_COLOR,
  safeAreasByDefault,
  safeAreasOn,
  toggleSafeAreas,
} from "../../src/renderer/features/post-editor/wecra/safe-areas.ts";
import {
  backgroundLuminance,
  emptySlot,
  fillSlot,
  insertLogo,
  type KitLogo,
  logoBox,
  markOf,
  pickLogo,
  postSlots,
  slotInfo,
} from "../../src/renderer/features/post-editor/wecra/slots.ts";

const DK = resolve(import.meta.dirname, "../../../../packages/design-kit/test/fixtures/venta");
const venta = () => parseBrandTokens(JSON.parse(readFileSync(resolve(DK, "brand.json"), "utf8")));
const SIZE = { width: 1080, height: 1350 };

const box = (i: number, tag: string, rest: Partial<WNode>): WNode => ({
  kind: "box",
  i,
  tag,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  d: "block",
  pos: "absolute",
  pad: [0, 0, 0, 0],
  bw: [0, 0, 0, 0],
  mar: [0, 0, 0, 0],
  rad: [0, 0, 0, 0],
  gap: [0, 0],
  sh: [],
  c: {},
  children: [],
  ...rest,
});

const SLIDE = `<!doctype html><html lang="tr"><body><main data-artboard>
<h1 data-layer="headline" data-type="text" data-role="headline">Hasat</h1>
<figure data-layer="field-photo" data-type="slot" data-slot-ratio="4:3" data-slot-state="empty" data-slot-label="Saha fotoğrafı" data-slot-fit="cover"></figure>
<div data-layer="band" data-type="shape"></div>
<div data-layer="dark" data-type="shape"></div>
</main></body></html>`;
const LAYERS = ["", "headline", "field-photo", "band", "dark"];

/** The slide as Wecra's walker reads it: a headline set as Venta's "headline", an empty slot
 *  (its placeholder pill drawn from ::after), a green band, a dark panel. */
const tree = (): WNode =>
  box(0, "main", {
    w: 1080,
    h: 1350,
    pos: "relative",
    c: { bg: "#ffffff" },
    children: [
      box(1, "h1", {
        x: 72,
        y: 900,
        w: 600,
        h: 74,
        children: [
          {
            kind: "text",
            chars: "Hasat",
            x: 72,
            y: 900,
            w: 600,
            h: 74,
            lines: 1,
            ci: 1,
            c: { fg: "#0b0b0b" },
            ts: {
              font: "Montserrat, sans-serif",
              size: 72,
              weight: 800,
              lh: 73.44,
              ls: -1.44,
              align: "left",
            },
            children: [],
          },
        ],
      }),
      box(2, "figure", {
        x: 0,
        y: 0,
        w: 1080,
        h: 810,
        clip: true,
        c: { bg: "#f2f4ef" },
        children: [
          box(-1, "::after", {
            i: undefined,
            name: "after",
            x: 400,
            y: 380,
            w: 280,
            h: 50,
            bg: "#ffffff",
            bc: null,
            abs: true,
            pseudoOf: 2,
            which: "::after",
          }),
        ],
      }),
      box(3, "div", { x: 0, y: 810, w: 1080, h: 16, c: { bg: "#66b052" } }),
      box(4, "div", { x: 0, y: 1150, w: 1080, h: 200, c: { bg: "#16301a" } }),
    ],
  });

async function post() {
  const images = new BundleImages();
  const source = memoryDocumentSource(structuredClone(EMPTY_DOCUMENT), { sessionID: 7, images });
  const engine = await Engine.create(null, { sessionID: 7 });
  expect(engine.load(await source.load())).toBe(0);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const { spec, fonts } = slideSpec(tree(), (i) => LAYERS[i] || null, 0);
  const frames = await importSlides(ed, [
    {
      index: 0,
      ...SIZE,
      spec: finishSlide(spec, 0, SIZE),
      fonts,
      missing: [],
      marks: layerMarks(SLIDE),
    },
  ]);
  const frame = frames[0]?.ref as string;
  const find = (layer: string) =>
    (
      engine.readNodes([frame], {
        subtree: true,
        fields: ["pluginData", "type", "name"],
      }) as unknown as {
        guid: string;
        type?: string;
        name?: string;
        pluginData?: { pluginID?: string; key?: string; value?: string }[];
      }[]
    ).find((n) => markOf(n)?.layer === layer)?.guid as string;
  const picture = async (bytes: Uint8Array, src: string) => ({
    hash: await images.put(bytes),
    width: 64,
    height: 32,
    src,
  });
  return { ed, engine, frame, find, picture, images };
}

const PNG = new Uint8Array(readFileSync(resolve(DK, "logos/venta-wordmark-black.standin.png")));
const PNG_WHITE = new Uint8Array(
  readFileSync(resolve(DK, "logos/venta-wordmark-white.standin.png")),
);

type Read = {
  styleIdForFill?: { guid?: unknown };
  styleIdForText?: { guid?: unknown };
  fillPaints?: { type?: string; imageScaleMode?: string }[];
};
const styled = (ref: { guid?: unknown } | undefined) =>
  !!ref?.guid && JSON.stringify(ref.guid) !== "{}";

describe("the brand kit as the document's styles", () => {
  it("makes every colour and type token a style once, and links the layers that use them", async () => {
    const { ed, engine, find } = await post();
    const tokens = venta();
    await prepareBrandStyles(ed, { mode: "approved", tokens });
    const styles = engine.styles(undefined, { includeRemote: false });
    const ours = styles.filter((s) => s.description.startsWith(BRAND_STYLE_TAG));
    expect(ours.length).toBe(brandStyleSpecs(tokens).length);
    expect(ours.map((s) => s.name)).toContain("Marka/green");
    expect(ours.map((s) => s.name)).toContain("Marka/headline");
    const green = ours.find((s) => s.name === "Marka/green");
    const band = engine.readNode(find("band"), { fields: ["styleIdForFill"] }) as Read;
    expect(styled(band.styleIdForFill)).toBe(true);
    expect(JSON.stringify(band.styleIdForFill)).toContain(
      JSON.stringify(green?.id).slice(1, -1).split(":")[1] as string,
    );
    const headline = engine.readNode(find("headline"), {
      fields: ["styleIdForText", "styleIdForFill"],
    }) as Read;
    expect(styled(headline.styleIdForText)).toBe(true);
    expect(styled(headline.styleIdForFill)).toBe(true); // ink #0B0B0B
    // Not an edit: nothing to undo.
    expect(engine.commandState("UNDO") & CMD_ENABLED).toBe(0);
    // Opening again adds nothing.
    await prepareBrandStyles(ed, { mode: "approved", tokens });
    expect(engine.styles(undefined, { includeRemote: false }).length).toBe(styles.length);
    // The neutral kit seeds nothing.
    const other = await post();
    await prepareBrandStyles(other.ed, { mode: "neutral", tokens });
    expect(other.engine.styles(undefined, { includeRemote: false }).length).toBe(0);
  });

  it("follows a token's new value in the style it made", async () => {
    const { ed, engine } = await post();
    const tokens = venta();
    await prepareBrandStyles(ed, { mode: "approved", tokens });
    const changed = parseBrandTokens({
      ...JSON.parse(readFileSync(resolve(DK, "brand.json"), "utf8")),
      color: {
        ...JSON.parse(readFileSync(resolve(DK, "brand.json"), "utf8")).color,
        green: "#00FF00",
      },
    });
    await prepareBrandStyles(ed, { mode: "approved", tokens: changed });
    const green = engine
      .styles(undefined, { includeRemote: false })
      .find((s) => s.description === `${BRAND_STYLE_TAG}color:green`);
    const c = (green?.fillPaints?.[0] as { color?: { g: number; r: number } } | undefined)?.color;
    expect(c?.g).toBeCloseTo(1);
    expect(c?.r).toBeCloseTo(0);
  });
});

describe("image slots on the canvas", () => {
  it("shows the empty slot's label, fills it from a picture and empties it, one undo step each", async () => {
    const { ed, engine, frame, find, picture } = await post();
    const slot = find("field-photo");
    const info = slotInfo(ed, slot);
    expect(info).toMatchObject({
      label: "Saha fotoğrafı",
      ratio: "4:3",
      fit: "cover",
      filled: false,
    });
    expect(postSlots(ed).map((s) => [s.label, s.filled])).toEqual([["Saha fotoğrafı", false]]);
    const pic = await picture(PNG, "/media/asset-7.png");
    expect(fillSlot(ed, slot, pic)).toBe(true);
    const filled = slotInfo(ed, slot);
    expect(filled?.filled).toBe(true);
    const node = engine.readNode(slot, { fields: ["fillPaints", "pluginData"] }) as Read & {
      pluginData?: { pluginID?: string; key?: string; value?: string }[];
    };
    expect(node.fillPaints?.at(-1)).toMatchObject({ type: "IMAGE", imageScaleMode: "FILL" });
    expect(markOf(node)).toMatchObject({
      type: "slot",
      src: "/media/asset-7.png",
      image: pic.hash,
    });
    // The checks see a filled slot of that asset.
    const layer = canvasLayers(canvasFacts(ed, frame)).find((l) => l.type === "slot");
    expect(layer?.slot).toMatchObject({ state: "filled", src: "/media/asset-7.png" });
    // Undo: empty again (one step).
    engine.command("UNDO");
    expect(slotInfo(ed, slot)?.filled).toBe(false);
    engine.command("REDO");
    expect(slotInfo(ed, slot)?.filled).toBe(true);
    // Kaldır: the slot colour back, the file forgotten.
    expect(emptySlot(ed, slot, "#F2F4EF")).toBe(true);
    expect(slotInfo(ed, slot)?.filled).toBe(false);
    expect(markOf(engine.readNode(slot, { fields: ["pluginData"] }) as never)).toMatchObject({
      src: null,
      image: null,
    });
    const empty = canvasLayers(canvasFacts(ed, frame)).find((l) => l.type === "slot");
    expect(empty?.slot?.state).toBe("empty");
  });
});

describe("the brand's logo", () => {
  const logos: KitLogo[] = [
    { token: "venta-black", path: "logos/venta-black.png", aspect: 6.2, on: "light" },
    { token: "venta-white", path: "logos/venta-white.png", aspect: 6.2, on: "dark" },
  ];

  it("picks the logo made for the background under it", async () => {
    const { ed, frame } = await post();
    expect(backgroundLuminance(ed, frame, { x: 100, y: 1000 })).toBeGreaterThan(0.9); // white page
    expect(backgroundLuminance(ed, frame, { x: 100, y: 1250 })).toBeLessThan(0.05); // dark panel
    expect(pickLogo(logos, 1)?.token).toBe("venta-black");
    expect(pickLogo(logos, 0.02)?.token).toBe("venta-white");
    expect(pickLogo([logos[0] as KitLogo], 0.02)?.token).toBe("venta-black");
  });

  it("places it as the brand's logo the checks recognise, one undo step", async () => {
    const { ed, engine, frame, picture } = await post();
    const at = logoBox(SIZE, 6.2, 72, 56);
    expect(at).toEqual({ x: 72, y: 1350 - 72 - 56, w: 56 * 6.2, h: 56 });
    const pic = await picture(PNG_WHITE, "/brand/logos/venta-white.png");
    const id = insertLogo(ed, frame, pic, at);
    expect(id).toBeTruthy();
    expect(ed.selection).toEqual([id]);
    const logo = canvasLayers(canvasFacts(ed, frame)).find((l) => l.type === "logo");
    expect(logo).toMatchObject({ id: "logo", src: "/brand/logos/venta-white.png" });
    expect(logo?.rect).toMatchObject({ x: 72, y: 1222, h: 56 });
    engine.command("UNDO");
    expect(canvasLayers(canvasFacts(ed, frame)).some((l) => l.type === "logo")).toBe(false);
  });
});

describe("safe areas", () => {
  it("uses the checks' preset insets: a story's UI bands, a feed post's margin", () => {
    expect(postPreset("story", ["instagram"], { width: 1080, height: 1920 }).id).toBe(
      "instagram-story",
    );
    // A slide of another size: the preset of that size (as the worker picks it).
    expect(postPreset("story", ["instagram"], SIZE).id).toBe("instagram-feed-portrait");
    expect(postPreset("story", ["instagram"], { width: 1080, height: 1920 }).safeArea).toEqual({
      top: 250,
      right: 64,
      bottom: 340,
      left: 64,
    });
    expect(postPreset("post", [], SIZE).safeArea).toEqual({
      top: 64,
      right: 64,
      bottom: 64,
      left: 64,
    });
    expect(postPreset("reel", ["instagram"], { width: 1080, height: 1920 }).id).toBe(
      "instagram-reel-cover",
    );
    expect(safeAreasByDefault("story")).toBe(true);
    expect(safeAreasByDefault("reel")).toBe(true);
    expect(safeAreasByDefault("carousel")).toBe(false);
  });

  it("draws them in every slide frame through the engine while on, none when off", async () => {
    const { ed, engine, frame } = await post();
    const set = vi.spyOn(engine, "setSafeAreas");
    initSafeAreas(ed, true);
    initSafeAreas(ed, false); // the first default stays
    expect(safeAreasOn(ed)).toBe(true);
    const insets = { top: 250, right: 64, bottom: 340, left: 64 };
    const off = attachSafeAreas(ed, insets);
    expect(set).toHaveBeenLastCalledWith([{ id: frame, insets, color: SAFE_AREA_COLOR }]);
    toggleSafeAreas(ed);
    expect(set).toHaveBeenLastCalledWith([]);
    toggleSafeAreas(ed);
    expect(set).toHaveBeenLastCalledWith([{ id: frame, insets, color: SAFE_AREA_COLOR }]);
    off();
    expect(set).toHaveBeenLastCalledWith([]);
  });
});
