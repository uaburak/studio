// The post editor's Wecra document with Wecra's real engine (headless): a design-kit slide as
// Wecra's walker reads it → Wecra's converter → create_nodes → frames and layers (auto layout
// from flex, texts, names from data-layer); the document bundle round trip; the engine's export
// of each slide frame; and a canvas save (renders + bundle → a new version) on a fake API.

import type { WNode } from "@shared/agents/web/convert";
import { decodeMessage } from "@shared/schema/codec";
import { WECRA_DOCUMENT_MIME } from "@studio/contract";
import { describe, expect, it, vi } from "vitest";
import { EditorController } from "@/editor/controller";
import { type DocumentSource, memoryDocumentSource } from "@/editor/documentSource";
import { pageFrames } from "@/editor/exporting";
import { EMPTY_DOCUMENT } from "@/editor/fixtures";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import {
  BundleImages,
  decodeBundle,
  encodeBundle,
  imageHashesIn,
} from "../../src/renderer/features/post-editor/wecra/bundle.ts";
import {
  finishSlide,
  importSlides,
  slideSpec,
} from "../../src/renderer/features/post-editor/wecra/import.ts";
import { WecraPostSession } from "../../src/renderer/features/post-editor/wecra/session.ts";

// PNG encoding needs an OffscreenCanvas (the browser's): the engine's pixels, as raw bytes here.
vi.mock("@/editor/exporting", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/editor/exporting")>();
  return {
    ...original,
    encodePixels: async (p: { width: number; height: number }) =>
      new TextEncoder().encode(`png ${p.width}x${p.height}`),
  };
});

const SIZE = { width: 1080, height: 1350 };

/** The first item (the test fails when there is none). */
function first<T>(list: readonly T[]): T {
  const item = list[0];
  if (item === undefined) throw new Error("empty");
  return item;
}

const text = (i: number, chars: string, x: number, y: number, w: number, h: number): WNode => ({
  kind: "text",
  chars,
  x,
  y,
  w,
  h,
  lines: 1,
  ci: i,
  c: { fg: "#1d2a1b" },
  ts: { font: '"Avenir Next", sans-serif', size: 40, weight: 700, lh: 48, ls: 0, align: "left" },
  children: [],
});

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

/** A design-kit slide as Wecra's walker captures it: an artboard, a headline, a flex row. */
function capturedSlide(): { tree: WNode; layers: string[] } {
  const layers = ["", "headline", "stack", "eyebrow", "body", "badge"];
  const tree = box(0, "main", {
    w: 1080,
    h: 1350,
    pos: "relative",
    c: { bg: "#f4efe4" },
    children: [
      // <h1 data-layer="headline"> (a text-only box: folded into its text)
      box(1, "h1", {
        x: 80,
        y: 200,
        w: 600,
        h: 48,
        children: [text(1, "Hasat bitti", 80, 200, 220, 48)],
      }),
      // <div data-layer="stack" style="display:flex;gap:16px"> with two texts
      box(2, "div", {
        x: 80,
        y: 900,
        w: 316,
        h: 48,
        d: "flex",
        fd: "row",
        fw: "nowrap",
        jc: "normal",
        ai: "normal",
        gap: [16, 16],
        children: [
          box(3, "p", {
            x: 80,
            y: 900,
            w: 100,
            h: 48,
            pos: "static",
            children: [text(3, "Üst", 80, 900, 100, 48)],
          }),
          box(4, "p", {
            x: 196,
            y: 900,
            w: 200,
            h: 48,
            pos: "static",
            children: [text(4, "Gövde", 196, 900, 200, 48)],
          }),
        ],
      }),
      // <div data-layer="badge"> a rounded, filled shape
      box(5, "div", { x: 880, y: 80, w: 120, h: 120, rad: [60, 60, 60, 60], c: { bg: "#2f5d2b" } }),
    ],
  });
  return { tree, layers };
}

/** Wecra's editor on `source` without its view: the engine's changes reach the source as EditorApp sends them. */
async function editorOn(source: DocumentSource, sessionID = 7) {
  const engine = await Engine.create(null, { sessionID });
  expect(engine.load(await source.load())).toBe(0);
  engine.on("DOCUMENT_CHANGED", (e) =>
    source.onChanges(e.message, { kind: e.kind, label: e.label }),
  );
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine };
}

async function headlessEditor(
  message = structuredClone(EMPTY_DOCUMENT),
  images = new BundleImages(),
) {
  const source = memoryDocumentSource(message, { sessionID: 7, images });
  return { source, ...(await editorOn(source)) };
}

async function importedPost() {
  const { ed, source, engine } = await headlessEditor();
  const { tree, layers } = capturedSlide();
  const { spec, fonts, pictures } = slideSpec(tree, (i) => layers[i] || null, 0);
  expect(pictures).toEqual([]);
  expect(fonts).toEqual(["Avenir Next"]);
  const frames = await importSlides(ed, [
    { index: 0, ...SIZE, spec: finishSlide(spec, 0, SIZE), fonts, missing: [] },
  ]);
  return { ed, source, engine, frames };
}

type Node = {
  guid: string;
  name?: string;
  type?: string;
  textData?: { characters?: string };
  stackMode?: string;
  size?: { x: number; y: number };
  fillPaints?: { type: string }[];
};

describe("a post in Wecra's editor (real engine, headless)", () => {
  it("imports a design-kit slide: a clipped frame, layers named after data-layer, flex as auto layout", async () => {
    const { ed, engine, frames } = await importedPost();
    expect(frames.map((f) => f.name)).toEqual(["Kare 1"]);
    const all = engine.readNodes([first(frames).ref], {
      subtree: true,
      fields: ["name", "type", "textData", "stackMode", "size", "frameMaskDisabled", "fillPaints"],
    }) as (Node & { frameMaskDisabled?: boolean })[];
    const frame = first(all);
    expect(frame.size).toEqual({ x: 1080, y: 1350 });
    expect(frame.frameMaskDisabled).toBe(false); // clips its content
    const byName = new Map(all.map((n) => [n.name, n]));
    expect(byName.get("stack")?.stackMode).toBe("HORIZONTAL");
    expect(byName.get("badge")?.fillPaints?.[0]?.type).toBe("SOLID");
    // A text that is its layer's only text takes the layer's id; texts sharing a layer keep their text.
    expect(byName.get("headline")?.textData?.characters).toBe("Hasat bitti");
    const texts = all.filter((n) => n.type === "TEXT").map((n) => n.textData?.characters);
    expect(texts).toEqual(expect.arrayContaining(["Hasat bitti", "Üst", "Gövde"]));
    // The import is where the document starts: nothing to undo.
    engine.command("UNDO");
    expect(engine.readNode(first(frames).ref)).not.toBeNull();
    expect(ed.store.page).toBe("0:1");
  });

  it("bundles the document with its images and opens it again, the same", async () => {
    const { engine, frames } = await importedPost();
    const images = new BundleImages();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const hash = await images.put(png);
    const badge = first(
      (engine.readNodes([first(frames).ref], { subtree: true, fields: ["name"] }) as Node[]).filter(
        (n) => n.name === "badge",
      ),
    );
    const hashBytes = Array.from({ length: 20 }, (_, i) =>
      Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16),
    );
    engine.setProps([badge.guid], {
      fillPaints: [
        {
          type: "IMAGE",
          image: { hash: hashBytes },
          imageScaleMode: "FILL",
          opacity: 1,
          visible: true,
        },
      ],
    } as never);
    const document = engine.encodeDocumentKiwi();
    expect([...imageHashesIn(decodeMessage(document))]).toContain(hash);
    const bytes = encodeBundle(document, images, [
      { guid: first(frames).ref, name: "Kare 1", ...{ width: 1080, height: 1350 } },
    ]);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // a zip
    const back = decodeBundle(bytes);
    expect(back.meta).toMatchObject({ format: 1, kind: "wecra", images: [hash] });
    expect(back.meta.wecra.appVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(await back.images.get(hash)).toEqual(png);
    const reopened = await headlessEditor(back.message, back.images);
    const names = (nodes: Node[]) => nodes.map((n) => `${n.type}:${n.name}`).sort();
    const read = (e: Engine) =>
      e.readNodes([first(frames).ref], {
        subtree: true,
        fields: ["name", "type", "size"],
      }) as Node[];
    expect(names(read(reopened.engine))).toEqual(names(read(engine)));
    expect(pageFrames(reopened.ed).map((f) => f.name)).toEqual(["Kare 1"]);
  });

  it("exports each slide frame through the engine at its size", async () => {
    const { engine, frames } = await importedPost();
    const out = engine.exportNodes(
      [first(frames).ref],
      {
        imageType: "PNG",
        constraint: { type: "CONTENT_SCALE", value: 1 },
        useAbsoluteBounds: true,
        colorProfile: "SRGB",
      },
      { allowPending: true },
    );
    expect(out.status).toBe("ok");
    if (out.status !== "ok" || !("pixels" in out)) throw new Error("no pixels");
    expect([out.pixels.width, out.pixels.height]).toEqual([1080, 1350]);
  });

  it("saves the canvas as a version: engine renders + the Wecra document, hash over the renders", async () => {
    const post = await importedPost();
    const bundle = encodeBundle(post.engine.encodeDocumentKiwi(), new BundleImages(), []);
    const calls: { type: string; input: unknown }[] = [];
    let n = 0;
    const api = {
      assets: {
        upload: async (input: { file: Blob; kind?: string; filename?: string }) => {
          calls.push({
            type: "upload",
            input: { kind: input.kind, mime: input.file.type, name: input.filename },
          });
          return { id: `asset-${++n}`, mimeType: input.file.type } as never;
        },
        contentUrl: (id: string) => `/api/assets/${id}/content`,
      },
      jobs: {
        create: async (input: unknown) => {
          calls.push({ type: "job", input });
          return {} as never;
        },
      },
      contents: {
        versions: {
          create: async (_id: string, input: unknown) => {
            calls.push({ type: "version", input });
            return { id: "v-new", version: 3 } as never;
          },
        },
      },
    };
    const refresh = vi.fn(async () => {});
    const session = new WecraPostSession({
      api: api as never,
      content: () => ({ id: "post-1", brandId: "brand-1", type: "post", title: "Post" }),
      kit: () => ({ css: "", files: {} }),
      refresh,
      autosaveMs: 0,
      fetchAsset: async () => bundle,
    });
    await session.open({
      id: "v2",
      version: 2,
      slides: [],
      editorDocument: { kind: "wecra", assetId: "doc-1", format: 1 },
    } as never);
    expect(session.getState().phase).toBe("ready");
    const source = session.source;
    if (!source) throw new Error("no document");
    const { ed, engine } = await editorOn(source, 8);
    await session.attach(ed);
    // An edit on the canvas: the document is dirty.
    const frame = first(pageFrames(ed)).ref;
    engine.setProps([frame], { name: "Kapak" } as never);
    expect(session.getState().dirty).toBe(true);
    expect(await session.save("Başlık büyüdü")).toBe(true);
    const uploads = calls.filter((c) => c.type === "upload").map((c) => c.input);
    expect(uploads).toEqual([
      { kind: "image", mime: "image/png", name: "kare-1.png" },
      { kind: "document", mime: WECRA_DOCUMENT_MIME, name: "post.wecra" },
    ]);
    const version = calls.find((c) => c.type === "version")?.input as {
      origin: string;
      note: string;
      slides: { html: string; width: number; height: number }[];
      renderedAssetIds: string[];
      editorDocument: unknown;
    };
    expect(version.origin).toBe("manual_edit");
    expect(version.note).toBe("Başlık büyüdü");
    expect(version.renderedAssetIds).toEqual(["asset-1"]);
    // Measured already (the render is the slide's one layer): no measuring render job follows.
    expect((version as unknown as { layouts: unknown }).layouts).toEqual([
      [
        {
          id: "canvas",
          type: "image",
          role: "background",
          parent: null,
          x: 0,
          y: 0,
          w: 1080,
          h: 1350,
          visible: true,
        },
      ],
    ]);
    expect(version.editorDocument).toEqual({ kind: "wecra", assetId: "asset-2", format: 1 });
    expect(version.slides[0]).toMatchObject({ width: 1080, height: 1350 });
    expect(first(version.slides).html).toContain('src="/media/asset-1.png"');
    expect(first(version.slides).html).toMatch(/studio:render" content="sha256:[0-9a-f]{64}"/);
    expect(first(version.slides).html).toContain("Hasat bitti");
    expect(calls.find((c) => c.type === "job")?.input).toMatchObject({
      type: "content.check",
      payload: { version: 3, model: false },
    });
    expect(refresh).toHaveBeenCalled();
    expect(session.getState()).toMatchObject({ dirty: false, saving: false, version: 3 });
    // The version it saved opens as the document already on the canvas (no reload).
    await session.open({ id: "v-new", version: 3, slides: [], editorDocument: null } as never);
    expect(session.source).toBe(source);
  });

  it("refuses to save a canvas whose frames don't fit the post (slide count)", async () => {
    const post = await importedPost();
    const session = new WecraPostSession({
      api: {} as never,
      content: () => ({ id: "p", brandId: "b", type: "carousel", title: "C" }),
      kit: () => ({ css: "", files: {} }),
      refresh: async () => {},
      autosaveMs: 0,
    });
    expect(
      session.saveBlocker([{ guid: "1:1", name: "Kare 1", width: 1080, height: 1350 }]),
    ).toMatch(/2–20 kare/);
    expect(
      session.saveBlocker([
        { guid: "1:1", name: "Kare 1", width: 1080, height: 1350 },
        { guid: "1:2", name: "Kare 2", width: 5000, height: 1350 },
      ]),
    ).toMatch(/Kare 2/);
    void post;
  });
});

describe("fonts for Wecra's text engine", () => {
  it("offers the brand's TTF / OTF files under their role's family (not WOFF), with Wecra's Inter", async () => {
    const { brandFileFaces, studioFontSource } = await import(
      "../../src/renderer/features/post-editor/wecra/fonts.ts"
    );
    const kit = {
      files: {
        "fonts/Brand-Bold.ttf": "a1",
        "fonts/Brand.woff2": "a2",
        "fonts/Brand-Italic.otf": "a3",
      },
      tokens: {
        font: {
          display: {
            family: "Brand Sans",
            files: [
              { path: "fonts/Brand-Bold.ttf", weight: 700 },
              "fonts/Brand.woff2",
              { path: "fonts/Brand-Italic.otf", style: "italic" },
            ],
          },
        },
      },
    } as never;
    const faces = brandFileFaces(kit);
    expect(faces.map((f) => [f.id, f.family, f.style, f.weight])).toEqual([
      ["studio-file:a1", "Brand Sans", "Bold", 700],
      ["studio-file:a3", "Brand Sans", "Italic", 400],
    ]);
    const all = await studioFontSource(kit).list();
    expect(all.some((f) => f.family === "Inter")).toBe(true);
    expect(all.filter((f) => f.family === "Brand Sans")).toHaveLength(2);
  });
});
