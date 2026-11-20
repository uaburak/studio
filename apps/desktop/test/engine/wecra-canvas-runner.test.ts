// The canvas runner (S1) with Wecra's real engine, headless (no GPU in jsdom: the export's pixels
// are stood in for, as in the save model's tests): a canvas version's document opens from its
// bundle, the agent's operations run as Wecra's own MCP write tools (text, colour, font size,
// move, hide, a new text, delete, duplicate, reorder, a picture from the brand's media into a
// slot), the edited document reads back as the expected facts and becomes a new `ai_edit` version
// exactly as the canvas saves one (renders, slide HTML with facts, the bundle, checks) — the hand
// edits of the version stay. A stale base version, a version without a document, frames that no
// longer fit the post and operations that change nothing make no version.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WNode } from "@shared/agents/web/convert";
import type { Content, ContentVersion, Job } from "@studio/contract";
import { type CanvasFacts, readCanvas } from "@studio/design-kit/canvas";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { EditorController } from "@/editor/controller";
import { memoryDocumentSource } from "@/editor/documentSource";
import { pageFrames } from "@/editor/exporting";
import { EMPTY_DOCUMENT } from "@/editor/fixtures";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { BUNDLED_FACES, fonts } from "@/engine/fonts";
import {
  applyCanvasJob,
  type CanvasRunnerDeps,
  createCanvasJob,
  readCanvasJob,
  runCanvasJob,
} from "../../src/renderer/features/canvas-runner/run.ts";
import {
  BundleImages,
  decodeBundle,
  encodeBundle,
} from "../../src/renderer/features/post-editor/wecra/bundle.ts";
import { canvasFacts } from "../../src/renderer/features/post-editor/wecra/facts.ts";
import {
  finishSlide,
  importSlides,
  layerMarks,
  slideSpec,
} from "../../src/renderer/features/post-editor/wecra/import.ts";

// PNG encoding needs an OffscreenCanvas (the browser's): the engine's pixels, as raw bytes here.
// A frame with a picture waits for its decoded pixels (Wecra's waiting export): jsdom decodes
// none, so that export answers with stand-in bytes too.
vi.mock("@/editor/exporting", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/editor/exporting")>();
  return {
    ...original,
    encodePixels: async (p: { width: number; height: number }) =>
      new TextEncoder().encode(`png ${p.width}x${p.height}`),
    renderExport: async () => ({ bytes: new TextEncoder().encode("png (waited)") }),
  };
});

const INTER = resolve(
  import.meta.dirname,
  "../../src/renderer/vendor/wecra-editor/src/renderer/src/engine/fonts/InterVariable.ttf",
);

const SIZE = { width: 1080, height: 1350 };
/** A picture of the brand's media (PNG signature; decoded by the stand-in below). */
const PHOTO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const SLIDE_HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"></head><body>
<main data-artboard style="width:1080px;height:1350px">
<h1 data-layer="headline" data-type="text" data-role="headline">Hasat bitti</h1>
<p data-layer="body" data-type="text" data-role="body">Toprak</p>
<figure data-layer="field-photo" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty" data-slot-label="Saha fotoğrafı" data-slot-fit="cover"></figure>
<div data-layer="band" data-type="shape" data-role="decoration"></div>
</main></body></html>`;

const text = (i: number, chars: string, x: number, y: number, w: number): WNode => ({
  kind: "text",
  chars,
  x,
  y,
  w,
  h: 48,
  lines: 1,
  ci: i,
  c: { fg: "#1d2a1b" },
  ts: { font: "Inter, sans-serif", size: 40, weight: 700, lh: 48, ls: 0, align: "left" },
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

const LAYERS = ["", "headline", "body", "field-photo", "band"];
const tree = (): WNode =>
  box(0, "main", {
    w: 1080,
    h: 1350,
    pos: "relative",
    c: { bg: "#f4efe4" },
    children: [
      box(1, "h1", {
        x: 80,
        y: 200,
        w: 600,
        h: 48,
        children: [text(1, "Hasat bitti", 80, 200, 600)],
      }),
      box(2, "p", { x: 80, y: 1000, w: 300, h: 48, children: [text(2, "Toprak", 80, 1000, 300)] }),
      box(3, "figure", { x: 560, y: 320, w: 400, h: 500, c: { bg: "#e0d9c8" } }),
      box(4, "div", { x: 0, y: 1300, w: 1080, h: 50, c: { bg: "#2f5d2b" } }),
    ],
  });

type Node = { guid: string; name?: string; type?: string; visible?: boolean };

let sessions = 40;

/** Wecra's editor on a document, headless (what the page's `openEditor` does with a canvas). */
async function headlessEditor(message: unknown, images: BundleImages, fileName = "Post") {
  const source = memoryDocumentSource(message as never, {
    fileName,
    sessionID: ++sessions,
    images,
  });
  const engine = await Engine.create(null, { sessionID: sessions });
  expect(engine.load(await source.load())).toBe(0);
  engine.on("DOCUMENT_CHANGED", (e) =>
    source.onChanges(e.message, { kind: e.kind, label: e.label }),
  );
  const ed = new EditorController(engine, new EngineStore(engine), source);
  return { ed, engine, close: () => engine.destroy() };
}

/**
 * The bundle of a version saved from the canvas: the imported slide (contract marks on its Wecra
 * layers) with a hand edit made on the canvas (the band recoloured and renamed).
 */
async function canvasBundle(): Promise<{ bundle: Uint8Array; ids: Record<string, string> }> {
  const images = new BundleImages();
  const { ed, engine, close } = await headlessEditor(structuredClone(EMPTY_DOCUMENT), images);
  const { spec, fonts: families } = slideSpec(tree(), (i) => LAYERS[i] || null, 0);
  await importSlides(ed, [
    {
      index: 0,
      ...SIZE,
      spec: finishSlide(spec, 0, SIZE),
      fonts: families,
      missing: [],
      marks: layerMarks(SLIDE_HTML),
    },
  ]);
  await fonts.settled();
  engine.pump();
  const frame = pageFrames(ed)[0]?.ref as string;
  const ids: Record<string, string> = { frame };
  for (const n of engine.readNodes([frame], { subtree: true, fields: ["name"] }) as Node[])
    if (n.name) ids[n.name] = n.guid;
  // The user's hand edit on the canvas (kept by every AI edit after it).
  engine.setProps([ids.band as string], {
    name: "Alt bant",
    fillPaints: [
      { type: "SOLID", color: { r: 0.8, g: 0.2, b: 0.1, a: 1 }, opacity: 1, visible: true },
    ],
  } as never);
  ids["Alt bant"] = ids.band as string;
  const bundle = encodeBundle(engine.encodeDocumentKiwi(), images, [], 3);
  close();
  return { bundle, ids };
}

interface FakeState {
  status: Content["status"];
  /** 0: the post has no version yet. */
  current: number;
  versions: Map<number, ContentVersion>;
  type: Content["type"];
}

function fakeRunner(bundle: Uint8Array, options: Partial<FakeState> = {}) {
  const assets = new Map<string, Uint8Array>([
    ["doc-2", bundle],
    ["photo-1", PHOTO],
  ]);
  const calls: { type: string; input: Record<string, unknown> }[] = [];
  const state: FakeState = {
    status: options.status ?? "draft",
    current: options.current ?? 2,
    type: options.type ?? "post",
    versions:
      options.versions ??
      new Map([
        [
          2,
          {
            id: "v2",
            contentId: "p1",
            version: 2,
            origin: "manual_edit",
            contentHash: "0".repeat(64),
            slideCount: 1,
            note: null,
            jobId: null,
            createdAt: "2026-11-18T10:00:00.000Z",
            updatedAt: "2026-11-18T10:00:00.000Z",
            slides: [
              { html: "<main data-artboard></main>", ...SIZE, renderedAssetId: "r2", layers: null },
            ],
            editorDocument: { kind: "wecra", assetId: "doc-2", format: 2 },
          } as ContentVersion,
        ],
      ]),
  };
  let n = 0;
  const content = (): Content =>
    ({
      id: "p1",
      brandId: "b1",
      type: state.type,
      title: "Hasat",
      status: state.status,
      currentVersion: state.current ? { version: state.current } : null,
    }) as never;
  const api = {
    contents: {
      get: async () => content(),
      versions: {
        get: async (_id: string, number: number) => {
          const v = state.versions.get(number);
          if (!v) throw new Error(`no v${number}`);
          return v;
        },
        create: async (_id: string, input: Record<string, unknown>) => {
          calls.push({ type: "version", input });
          state.current += 1;
          const v = { ...input, id: `v${state.current}`, version: state.current } as never;
          state.versions.set(state.current, v);
          return v;
        },
      },
    },
    assets: {
      upload: async (input: { file: Blob; filename?: string; kind?: string; source?: string }) => {
        const id = `asset-${++n}`;
        assets.set(id, new Uint8Array(await input.file.arrayBuffer()));
        calls.push({ type: "upload", input: { id, name: input.filename, kind: input.kind } });
        return { id } as never;
      },
      contentUrl: (id: string) => `/api/assets/${id}/content`,
    },
    jobs: {
      create: async (input: Record<string, unknown>) => {
        calls.push({ type: "job", input });
        return { id: `check-${calls.length}` } as never;
      },
    },
  };
  const opened: { close: () => void }[] = [];
  const deps: CanvasRunnerDeps = {
    api: api as never,
    fetchAsset: async (id) => {
      const bytes = assets.get(id);
      if (!bytes) throw new Error(`no asset ${id}`);
      return bytes;
    },
    prepareFonts: async () => {},
    openEditor: async (message, images, fileName) => {
      const e = await headlessEditor(message, images, fileName);
      const handle = { ed: e.ed, close: vi.fn(e.close) };
      opened.push(handle);
      return handle;
    },
    settle: async (ed) => {
      await fonts.settled();
      ed.engine.pump();
    },
  };
  return { deps, calls, assets, state, opened };
}

const job = (type: Job["type"], payload: Record<string, unknown>): Job =>
  ({
    id: "job-1",
    type,
    status: "running",
    payload,
    brandId: "b1",
    contentId: "p1",
    createdAt: "2026-11-18T10:00:00.000Z",
    updatedAt: "2026-11-18T10:00:00.000Z",
  }) as Job;

/** The facts of the version a job created (its slide HTML carries them). */
function factsOf(version: Record<string, unknown>): CanvasFacts {
  const slides = version.slides as { html: string }[];
  const c = readCanvas(slides[0]?.html);
  if (c.kind !== "facts") throw new Error(`no facts (${c.kind})`);
  return c.facts;
}

beforeAll(() => {
  const ttf = new Uint8Array(readFileSync(INTER));
  fonts.setSource({ list: async () => BUNDLED_FACES, read: async () => ttf });
  // Image decoding is the browser's (createImageBitmap): a 400×500 picture here.
  (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
    width: 400,
    height: 500,
    close: () => {},
  });
});

describe("the canvas runner's canvas.apply (Wecra's operations on the document)", () => {
  it("edits the version's document with Wecra's tools and stores it as a new ai_edit version", async () => {
    const { bundle, ids } = await canvasBundle();
    const { deps, calls, assets, opened } = fakeRunner(bundle);
    const progress = vi.fn();
    const out = await applyCanvasJob(
      job("canvas.apply", {
        version: 2,
        note: "Başlık güncellendi",
        operations: [
          {
            tool: "update_nodes",
            args: {
              updates: [
                {
                  nodeId: ids.headline,
                  characters: "Hasat başladı",
                  fills: "#aa1100",
                  fontSize: 56,
                },
                { nodeId: ids.body, x: 120, y: 1040 },
              ],
            },
          },
          {
            tool: "create_nodes",
            args: {
              parentId: ids.frame,
              nodes: [
                {
                  type: "TEXT",
                  name: "kampanya",
                  characters: "Kasım boyunca",
                  x: 80,
                  y: 300,
                  fontFamily: "Inter",
                  fontStyle: "Bold",
                  fontSize: 32,
                  fills: "#1D2A1B",
                },
              ],
            },
          },
          {
            tool: "place_image",
            args: { nodeId: ids["field-photo"], assetId: "photo-1", scaleMode: "FILL" },
          },
          {
            tool: "set_properties",
            args: { nodeIds: [ids.body], properties: { textCase: "UPPER" } },
          },
        ],
      }),
      { ...deps, progress },
    );
    expect(out).toMatchObject({ contentId: "p1", version: 3, baseVersion: 2, slides: 1 });
    expect(out.results.map((r) => [r.tool, r.ok])).toEqual([
      ["update_nodes", true],
      ["create_nodes", true],
      ["place_image", true],
      ["set_properties", true],
    ]);
    expect(out.results[0]?.summary).toBe("update_nodes: everything applied.");
    expect(out.checkJobId).toBeTruthy();
    expect(progress).toHaveBeenCalledWith(1, "Tamamlandı");
    expect(opened[0]?.close).toHaveBeenCalled();

    // The version is made as the canvas makes one: renders, the bundle, an ai_edit version, checks.
    expect(calls.filter((c) => c.type === "upload").map((c) => c.input.name)).toEqual([
      "tuval-gorseli.png",
      "kare-1.png",
      "post.wecra",
    ]);
    const version = calls.find((c) => c.type === "version")?.input as Record<string, unknown>;
    expect(version).toMatchObject({
      origin: "ai_edit",
      note: "Başlık güncellendi",
      jobId: "job-1",
      editorDocument: { kind: "wecra", format: 2 },
    });
    expect(calls.find((c) => c.type === "job")?.input).toMatchObject({
      type: "content.check",
      contentId: "p1",
      payload: { version: 3, model: false },
    });

    // The new slide HTML's facts: the AI's edits and the user's hand edit.
    const facts = factsOf(version);
    const byName = (name: string) => facts.nodes.find((n) => n.name === name);
    expect(byName("headline")?.text).toMatchObject({
      characters: "Hasat başladı",
      size: 56,
      color: "#AA1100",
    });
    expect(byName("body")?.bounds).toMatchObject({ x: 120, y: 1040 });
    expect(byName("kampanya")?.text).toMatchObject({ characters: "Kasım boyunca", size: 32 });
    expect(byName("kampanya")?.bounds).toMatchObject({ x: 80, y: 300 });
    expect(byName("field-photo")?.fills.at(-1)).toMatchObject({ type: "image", fit: "fill" });
    expect(byName("field-photo")?.mark?.type).toBe("slot");
    expect(byName("Alt bant")?.fills[0]).toMatchObject({ type: "solid", color: "#CC331A" });
    expect(readCanvas((version.slides as { html: string }[])[0]?.html)).toMatchObject({
      kind: "facts",
      sourceVersion: 3,
    });

    // The bundle is the edited document (with the picture as the brand's asset).
    const documentId = (version.editorDocument as { assetId: string }).assetId;
    const decoded = decodeBundle(assets.get(documentId) as Uint8Array);
    expect(decoded.meta.sourceVersion).toBe(3);
    expect(Object.values(decoded.meta.assets ?? {}).map((a) => a.mimeType)).toEqual(["image/png"]);
    const reopened = await headlessEditor(decoded.message, decoded.images);
    const frame = pageFrames(reopened.ed)[0]?.ref as string;
    const again = canvasFacts(reopened.ed, frame);
    expect(again.nodes.find((n) => n.name === "headline")?.text?.characters).toBe("Hasat başladı");
    expect(again.nodes.map((n) => n.name)).toEqual(facts.nodes.map((n) => n.name));
    reopened.close();
  });

  it("deletes, duplicates, reorders and hides with Wecra's tools", async () => {
    const { bundle, ids } = await canvasBundle();
    const { deps, calls } = fakeRunner(bundle);
    const out = await applyCanvasJob(
      job("canvas.apply", {
        version: 2,
        operations: [
          { tool: "duplicate_nodes", args: { nodeIds: [ids.headline], x: 80, y: 600 } },
          { tool: "delete_nodes", args: { nodeIds: [ids.body] } },
          {
            tool: "reparent_nodes",
            args: { nodeIds: [ids["Alt bant"]], parentId: ids.frame, index: 0 },
          },
          {
            tool: "update_nodes",
            args: { updates: [{ nodeId: ids["field-photo"], visible: false }] },
          },
        ],
      }),
      deps,
    );
    expect(out.results.every((r) => r.ok)).toBe(true);
    expect(out.results[0]?.touched).toHaveLength(1);
    const facts = factsOf(
      calls.find((c) => c.type === "version")?.input as Record<string, unknown>,
    );
    const names = facts.nodes.map((n) => n.name);
    // The band is at the bottom now, the body is gone, the headline has a copy.
    expect(names[0]).toBe("Alt bant");
    expect(names).not.toContain("body");
    expect(names.filter((n) => n === "headline")).toHaveLength(2);
    expect(facts.nodes.find((n) => n.name === "field-photo")?.visible).toBe(false);
  });

  it("reports what Wecra refused and still saves what it applied; nothing applied → no version", async () => {
    const { bundle, ids } = await canvasBundle();
    const partly = fakeRunner(bundle);
    const out = await applyCanvasJob(
      job("canvas.apply", {
        version: 2,
        operations: [
          {
            tool: "update_nodes",
            args: { updates: [{ nodeId: ids.headline, characters: "Yeni" }] },
          },
          { tool: "delete_nodes", args: { nodeIds: ["999:999"] } },
          { tool: "place_image", args: { nodeId: ids.headline, path: "/etc/passwd" } },
        ],
      }),
      partly.deps,
    );
    expect(out.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(out.results[1]?.summary).toMatch(/999:999/);
    expect(out.results[2]?.summary).toMatch(/dosya yolu/);
    expect(partly.calls.filter((c) => c.type === "version")).toHaveLength(1);

    const none = fakeRunner(bundle);
    await expect(
      applyCanvasJob(
        job("canvas.apply", {
          version: 2,
          operations: [{ tool: "delete_nodes", args: { nodeIds: ["999:999"] } }],
        }),
        none.deps,
      ),
    ).rejects.toThrow(/Hiçbir işlem uygulanamadı/);
    // Applied but no change (the same text again): no version either.
    await expect(
      applyCanvasJob(
        job("canvas.apply", {
          version: 2,
          operations: [
            {
              tool: "update_nodes",
              args: { updates: [{ nodeId: ids.body, characters: "Toprak" }] },
            },
          ],
        }),
        none.deps,
      ),
    ).rejects.toThrow(/değiştirmedi/);
    expect(none.calls.filter((c) => c.type === "version")).toHaveLength(0);
  });

  it("makes no version when the post moved on, has no document, is published or no longer fits", async () => {
    const { bundle, ids } = await canvasBundle();
    const op = {
      tool: "update_nodes",
      args: { updates: [{ nodeId: ids.headline, characters: "X" }] },
    };

    const stale = fakeRunner(bundle, { current: 3 });
    await expect(
      applyCanvasJob(job("canvas.apply", { version: 2, operations: [op] }), stale.deps),
    ).rejects.toThrow(/Post değişti: güncel sürüm v3/);
    expect(stale.opened).toHaveLength(0);

    const html = fakeRunner(bundle);
    const v2 = html.state.versions.get(2) as ContentVersion;
    html.state.versions.set(2, { ...v2, editorDocument: null });
    await expect(
      applyCanvasJob(job("canvas.apply", { version: 2, operations: [op] }), html.deps),
    ).rejects.toThrow(/Wecra belgesi yok/);

    const published = fakeRunner(bundle, { status: "published" });
    await expect(
      applyCanvasJob(job("canvas.apply", { version: 2, operations: [op] }), published.deps),
    ).rejects.toThrow(/yayında/);

    // A second frame on a single post: the frames no longer fit, nothing is saved.
    const frames = fakeRunner(bundle);
    await expect(
      applyCanvasJob(
        job("canvas.apply", {
          version: 2,
          operations: [{ tool: "duplicate_nodes", args: { nodeIds: [ids.frame] } }],
        }),
        frames.deps,
      ),
    ).rejects.toThrow(/Sürüm oluşmadı: .*tek kare/);
    expect(frames.calls.filter((c) => c.type === "version")).toHaveLength(0);
    expect(frames.opened[0]?.close).toHaveBeenCalled();
  });
});

describe("the canvas runner's canvas.read", () => {
  it("outlines the version's slides from the live document and reads named layers in full", async () => {
    const { bundle, ids } = await canvasBundle();
    const { deps } = fakeRunner(bundle);
    const out = (await readCanvasJob(job("canvas.read", { nodeIds: [ids.headline] }), deps)) as {
      version: number;
      slides: { frameId: string; layers: { id: string; name: string }[] }[];
      design: string;
    };
    expect(out.version).toBe(2);
    expect(out.slides[0]?.frameId).toBe(ids.frame);
    expect(out.slides[0]?.layers.map((l) => l.name)).toEqual([
      "headline",
      "body",
      "field-photo",
      "Alt bant",
    ]);
    expect(out.slides[0]?.layers[0]).toMatchObject({
      id: ids.headline,
      type: "text",
      text: { characters: "Hasat bitti", font: "Inter Bold", size: 40 },
      contract: { layer: "headline", type: "text", role: "headline" },
    });
    expect(out.design).toContain(ids.headline);
    await expect(runCanvasJob(job("content.check", {}), deps)).rejects.toThrow(/yapmaz/);
  });
});

const LOGO_SVG = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80" viewBox="0 0 200 80"><rect width="200" height="80" fill="#2f5d2b"/></svg>',
);

describe("the canvas runner's canvas.create (a blank Wecra document, Faz 2)", () => {
  it("makes one white frame per slide and stores a blank canvas version (no AI)", async () => {
    const { bundle } = await canvasBundle();
    const { deps, calls, opened } = fakeRunner(bundle, { current: 0, type: "carousel" });
    const out = await createCanvasJob(
      job("canvas.create", { slides: 3, width: 1080, height: 1080, origin: "manual_edit" }),
      deps,
    );
    expect(out).toMatchObject({ contentId: "p1", version: 1, slides: 3, results: [] });
    expect(out.frameIds).toHaveLength(3);
    expect(opened[0]?.close).toHaveBeenCalled();
    const version = calls.find((c) => c.type === "version")?.input as Record<string, unknown>;
    expect(version).toMatchObject({
      origin: "manual_edit",
      note: "Boş tuval.",
      editorDocument: { kind: "wecra", format: 2 },
    });
    const slides = version.slides as { width: number; height: number; html: string }[];
    expect(slides.map((s) => [s.width, s.height])).toEqual([
      [1080, 1080],
      [1080, 1080],
      [1080, 1080],
    ]);
    // The frames are the slides, in reading order, named as an imported post's are.
    const names = slides.map((s) => {
      const c = readCanvas(s.html);
      return c.kind === "facts" ? c.facts.frame.name : null;
    });
    expect(names).toEqual(["Kare 1", "Kare 2", "Kare 3"]);
    expect(calls.find((c) => c.type === "job")?.input).toMatchObject({ type: "content.check" });
  });

  it("designs the blank frames at once with Wecra's operations on `frame:N` (a logo SVG as vectors)", async () => {
    const { bundle } = await canvasBundle();
    const { deps, calls, assets } = fakeRunner(bundle, { current: 0 });
    assets.set("logo-svg", LOGO_SVG);
    const out = await createCanvasJob(
      job("canvas.create", {
        slides: 1,
        width: 1080,
        height: 1350,
        note: "Wecra ile üretildi",
        operations: [
          {
            tool: "update_nodes",
            args: { updates: [{ nodeId: "frame:1", fills: "#F4EFE4" }] },
          },
          {
            tool: "create_nodes",
            args: {
              parentId: "frame:1",
              nodes: [
                {
                  type: "TEXT",
                  name: "Başlık",
                  characters: "Hasat zamanı",
                  x: 80,
                  y: 160,
                  fontFamily: "Inter",
                  fontStyle: "Bold",
                  fontSize: 72,
                  fills: "#1D2A1B",
                },
                { name: "Logo", image: { assetId: "logo-svg" }, x: 80, y: 1200, width: 200 },
              ],
            },
          },
        ],
      }),
      deps,
    );
    expect(out.results.map((r) => [r.tool, r.ok])).toEqual([
      ["update_nodes", true],
      ["create_nodes", true],
    ]);
    const version = calls.find((c) => c.type === "version")?.input as Record<string, unknown>;
    expect(version).toMatchObject({ origin: "generated", note: "Wecra ile üretildi" });
    const facts = factsOf(version);
    expect(facts.frame.name).toBe("Kare 1");
    expect(facts.nodes.find((n) => n.name === "Başlık")?.text).toMatchObject({
      characters: "Hasat zamanı",
      size: 72,
    });
    expect(facts.nodes.find((n) => n.name === "Logo")).toBeTruthy();
  });

  it("refuses a post that already has another version, and a frame count the type can't take", async () => {
    const { bundle } = await canvasBundle();
    const stale = fakeRunner(bundle);
    await expect(
      createCanvasJob(job("canvas.create", { slides: 1, width: 1080, height: 1350 }), stale.deps),
    ).rejects.toThrow(/Post değişti/);
    const single = fakeRunner(bundle, { current: 0 });
    await expect(
      createCanvasJob(job("canvas.create", { slides: 2, width: 1080, height: 1350 }), single.deps),
    ).rejects.toThrow(/tek kare/);
    expect(single.calls.filter((c) => c.type === "version")).toHaveLength(0);
  });
});
