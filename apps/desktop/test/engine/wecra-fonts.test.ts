// Brand fonts for Wecra's text engine (E9), with Wecra's real engine (headless) and its Inter:
// WOFF (zlib per table) and WOFF2 (Google's decoder) files become the sfnt the engine reads, so a
// brand whose fonts are web fonts draws in them, not in the fallback; an installed family wins over
// the brand's file only when the brand says so (`system`); a text whose font is missing keeps the
// canvas as a draft but makes no version ("Eksik font: …").
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";
import type { WNode } from "@shared/agents/web/convert";
import type { ContentVersion } from "@studio/contract";
import type { CanvasFacts } from "@studio/design-kit/canvas";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { compress } from "woff2-encoder";
import { EditorController } from "@/editor/controller";
import { type DocumentSource, memoryDocumentSource } from "@/editor/documentSource";
import { pageFrames } from "@/editor/exporting";
import { EMPTY_DOCUMENT } from "@/editor/fixtures";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { BUNDLED_FACES, fonts } from "@/engine/fonts";
import {
  BundleImages,
  encodeBundle,
} from "../../src/renderer/features/post-editor/wecra/bundle.ts";
import { slideFacts } from "../../src/renderer/features/post-editor/wecra/facts.ts";
import {
  fontFileFormat,
  toSfnt,
  woff2ToSfnt,
  woffToSfnt,
} from "../../src/renderer/features/post-editor/wecra/font-files.ts";
import {
  brandFileFaces,
  precedence,
  studioFontSource,
} from "../../src/renderer/features/post-editor/wecra/fonts.ts";
import {
  finishSlide,
  importSlides,
  slideSpec,
} from "../../src/renderer/features/post-editor/wecra/import.ts";
import {
  canvasMissingFonts,
  missingFamilies,
} from "../../src/renderer/features/post-editor/wecra/missing-fonts.ts";
import { WecraPostSession } from "../../src/renderer/features/post-editor/wecra/session.ts";
import { memoryDrafts } from "../../src/renderer/lib/bridge.ts";

// PNG encoding needs an OffscreenCanvas (the browser's): the engine's pixels, as raw bytes here.
vi.mock("@/editor/exporting", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/editor/exporting")>();
  return {
    ...original,
    encodePixels: async (p: { width: number; height: number }) =>
      new TextEncoder().encode(`png ${p.width}x${p.height}`),
  };
});

const INTER = new Uint8Array(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../../src/renderer/vendor/wecra-editor/src/renderer/src/engine/fonts/InterVariable.ttf",
    ),
  ),
);

/** The sfnt's tables: tag → bytes. */
function sfntTables(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, Uint8Array>();
  const n = view.getUint16(4);
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    out.set(tag, bytes.subarray(offset, offset + length));
  }
  return out;
}

/** A WOFF 1.0 file of an sfnt (each table zlib-compressed when that is smaller). */
function toWoff(sfnt: Uint8Array): Uint8Array {
  const view = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const n = view.getUint16(4);
  const entries = [...sfntTables(sfnt)].map(([tag, data], i) => {
    const z = new Uint8Array(deflateSync(data));
    const at = 12 + i * 16;
    return {
      tag,
      checksum: view.getUint32(at + 4),
      orig: data,
      stored: z.byteLength < data.byteLength ? z : data,
    };
  });
  let size = 44 + n * 20;
  const offsets = entries.map((e) => {
    const o = size;
    size += (e.stored.byteLength + 3) & ~3;
    return o;
  });
  const out = new Uint8Array(size);
  const o = new DataView(out.buffer);
  out.set(new TextEncoder().encode("wOFF"), 0);
  o.setUint32(4, view.getUint32(0));
  o.setUint32(8, size);
  o.setUint16(12, n);
  entries.forEach((e, i) => {
    const at = 44 + i * 20;
    out.set(new TextEncoder().encode(e.tag), at);
    o.setUint32(at + 4, offsets[i] as number);
    o.setUint32(at + 8, e.stored.byteLength);
    o.setUint32(at + 12, e.orig.byteLength);
    o.setUint32(at + 16, e.checksum);
    out.set(e.stored, offsets[i] as number);
  });
  return out;
}

const KIT_FILES = {
  "fonts/Brand-Regular.woff2": "w2",
  "fonts/Brand-Bold.woff": "w1",
  "fonts/Brand-Italic.otf": "o1",
};

function kit(system = false) {
  return {
    files: KIT_FILES,
    tokens: {
      font: {
        display: {
          family: "Brand Sans",
          ...(system ? { system: true } : {}),
          files: [
            "fonts/Brand-Regular.woff2",
            { path: "fonts/Brand-Bold.woff", weight: 700 },
            { path: "fonts/Brand-Italic.otf", style: "italic" },
          ],
        },
      },
    },
  } as never;
}

let woff2Inter: Uint8Array;
// WOFF2 compression is CPU-bound: under the whole repo's parallel test run it can take > 10 s.
beforeAll(async () => {
  woff2Inter = await compress(INTER);
}, 60_000);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WOFF / WOFF2 brand files as sfnt (E9)", () => {
  it("tells the formats apart by their first bytes", () => {
    expect(fontFileFormat(INTER)).toBe("sfnt");
    expect(fontFileFormat(woff2Inter)).toBe("woff2");
    expect(fontFileFormat(toWoff(INTER))).toBe("woff");
    expect(fontFileFormat(new Uint8Array([1, 2]))).toBe("unknown");
  });

  it("writes a WOFF's tables back as the sfnt they were, byte for byte", async () => {
    const woff = toWoff(INTER);
    expect(woff.byteLength).toBeLessThan(INTER.byteLength);
    const sfnt = await woffToSfnt(woff);
    expect(fontFileFormat(sfnt)).toBe("sfnt");
    const before = sfntTables(INTER);
    const after = sfntTables(sfnt);
    expect([...after.keys()]).toEqual([...before.keys()].sort());
    for (const [tag, data] of before) expect(after.get(tag), tag).toEqual(data);
    await expect(woffToSfnt(woff.subarray(0, 60))).rejects.toThrow(/WOFF/);
  });

  it("decodes a WOFF2 (Google's decoder) to an sfnt with the font's tables and glyphs", async () => {
    const sfnt = await woff2ToSfnt(woff2Inter);
    expect(fontFileFormat(sfnt)).toBe("sfnt");
    const before = sfntTables(INTER);
    const after = sfntTables(sfnt);
    for (const tag of ["cmap", "glyf", "head", "hhea", "hmtx", "maxp", "name", "GSUB", "GPOS"])
      expect(after.has(tag), tag).toBe(before.has(tag));
    // maxp.numGlyphs
    const glyphs = (t: Uint8Array | undefined) => (t ? (t[4] ?? 0) * 256 + (t[5] ?? 0) : -1);
    expect(glyphs(after.get("maxp"))).toBe(glyphs(before.get("maxp")));
    expect(await toSfnt(INTER)).toBe(INTER);
  });

  it("offers the brand's TTF / OTF / WOFF / WOFF2 files and reads them as sfnt", async () => {
    const faces = brandFileFaces(kit());
    expect(faces.map((f) => [f.id, f.family, f.style, f.weight])).toEqual([
      ["studio-file:w2", "Brand Sans", "Regular", 400],
      ["studio-file:w1", "Brand Sans", "Bold", 700],
      ["studio-file:o1", "Brand Sans", "Italic", 400],
    ]);
    const served: Record<string, Uint8Array> = {
      "/api/assets/w2/content": woff2Inter,
      "/api/assets/w1/content": toWoff(INTER),
    };
    vi.stubGlobal("fetch", async (url: string) =>
      served[url] ? new Response(served[url] as BodyInit) : new Response(null, { status: 404 }),
    );
    const source = studioFontSource(kit());
    const list = await source.list();
    expect(list.some((f) => f.family === "Inter")).toBe(true);
    const regular = list.find((f) => f.id === "studio-file:w2");
    const bold = list.find((f) => f.id === "studio-file:w1");
    expect(fontFileFormat(await source.read(regular as never))).toBe("sfnt");
    expect(fontFileFormat(await source.read(bold as never))).toBe("sfnt");
  });

  it("lets an installed family win only for a `system` role (as brand.css)", () => {
    const installed = [
      { id: "studio-system:BrandSans-Regular", family: "Brand Sans", style: "Regular" },
      { id: "studio-system:Other", family: "Other", style: "Regular" },
    ].map((f) => ({
      ...f,
      weight: 400,
      italic: false,
      source: "system" as const,
      collectionIndex: 0,
    }));
    // Not system: the brand's files are the family; the installed faces of it are left out.
    expect(precedence(installed, kit()).map((f) => f.id)).toEqual([
      "studio-system:Other",
      "studio-file:w2",
      "studio-file:w1",
      "studio-file:o1",
    ]);
    // System: the installed family; the files only stand in on a Mac without it.
    expect(precedence(installed, kit(true)).map((f) => f.id)).toEqual([
      "studio-system:BrandSans-Regular",
      "studio-system:Other",
    ]);
    expect(precedence(installed.slice(1), kit(true)).map((f) => f.id)).toEqual([
      "studio-system:Other",
      "studio-file:w2",
      "studio-file:w1",
      "studio-file:o1",
    ]);
  });
});

// --- the engine ----------------------------------------------------------------------------------

const SIZE = { width: 1080, height: 1350 };

const slideTree = (family: string): WNode => ({
  kind: "box",
  i: 0,
  tag: "main",
  x: 0,
  y: 0,
  w: 1080,
  h: 1350,
  d: "block",
  pos: "relative",
  pad: [0, 0, 0, 0],
  bw: [0, 0, 0, 0],
  mar: [0, 0, 0, 0],
  rad: [0, 0, 0, 0],
  gap: [0, 0],
  sh: [],
  c: { bg: "#f4efe4" },
  children: [
    {
      kind: "text",
      chars: "Hasat bitti",
      x: 80,
      y: 200,
      w: 700,
      h: 60,
      lines: 1,
      ci: 1,
      c: { fg: "#1d2a1b" },
      ts: { font: `${family}, sans-serif`, size: 48, weight: 400, lh: 60, ls: 0, align: "left" },
      children: [],
    },
  ],
});

async function editorOn(source: DocumentSource, sessionID: number) {
  const engine = await Engine.create(null, { sessionID });
  expect(engine.load(await source.load())).toBe(0);
  engine.on("DOCUMENT_CHANGED", (e) =>
    source.onChanges(e.message, { kind: e.kind, label: e.label }),
  );
  return { ed: new EditorController(engine, new EngineStore(engine), source), engine };
}

/** A canvas version whose one slide has a text in `family`. */
async function textBundle(family: string): Promise<Uint8Array> {
  const images = new BundleImages();
  const source = memoryDocumentSource(structuredClone(EMPTY_DOCUMENT), { sessionID: 41, images });
  const { ed, engine } = await editorOn(source, 41);
  const { spec, fonts: families } = slideSpec(slideTree(family), () => null, 0);
  await importSlides(ed, [
    { index: 0, ...SIZE, spec: finishSlide(spec, 0, SIZE), fonts: families, missing: [] },
  ]);
  return encodeBundle(engine.encodeDocumentKiwi(), images, []);
}

const facts = (ed: EditorController) =>
  slideFacts(ed, pageFrames(ed)[0]?.ref as string) as CanvasFacts;

describe("the engine with the brand's web fonts (E9)", () => {
  it("draws a text in the brand's WOFF2 family (not the fallback)", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      url === "/api/assets/w2/content"
        ? new Response(woff2Inter as BodyInit)
        : new Response(null, { status: 404 }),
    );
    fonts.setSource(studioFontSource(kit()));
    const source = memoryDocumentSource(structuredClone(EMPTY_DOCUMENT), {
      sessionID: 42,
      images: new BundleImages(),
    });
    const { ed, engine } = await editorOn(source, 42);
    const { spec, fonts: families } = slideSpec(slideTree("Brand Sans"), () => null, 0);
    await importSlides(ed, [
      { index: 0, ...SIZE, spec: finishSlide(spec, 0, SIZE), fonts: families, missing: [] },
    ]);
    await fonts.settled();
    engine.pump();
    const f = facts(ed);
    expect(f.nodes.find((n) => n.type === "text")?.text?.family).toBe("Brand Sans");
    expect(f.fonts.find((x) => x.family === "Brand Sans")?.missing).toBe(false);
    expect(missingFamilies([f])).toEqual([]);
    expect(canvasMissingFonts(ed)).toEqual([]);
  });

  it("keeps a canvas whose font is missing as a draft and makes no version", async () => {
    fonts.setSource({ list: async () => BUNDLED_FACES, read: async () => INTER });
    const bundle = await textBundle("Inter");
    const calls: string[] = [];
    const drafts = memoryDrafts();
    const session = new WecraPostSession({
      api: {
        assets: {
          upload: async () => {
            calls.push("upload");
            return { id: `a${calls.length}` } as never;
          },
          contentUrl: (id: string) => `/api/assets/${id}/content`,
        },
        jobs: { create: async () => ({}) as never },
        contents: {
          versions: {
            create: async () => {
              calls.push("version");
              return { id: "v3", version: 3 } as never;
            },
            get: async () => {
              throw new Error("no");
            },
          },
        },
      } as never,
      content: () => ({ id: "p1", brandId: "b1", type: "post", title: "Post" }),
      kit: () => ({ css: "", files: {} }),
      refresh: async () => {},
      drafts,
      draftMs: 0,
      fetchAsset: async () => bundle,
    });
    const v2 = {
      id: "v2",
      contentId: "p1",
      version: 2,
      origin: "manual_edit",
      contentHash: "0".repeat(64),
      slides: [{ html: "<main data-artboard></main>", ...SIZE, renderedAssetId: "r2" }],
      editorDocument: { kind: "wecra", assetId: "doc-2", format: 2 },
    } as unknown as ContentVersion;
    await session.open(v2);
    const { ed, engine } = await editorOn(session.source as DocumentSource, 43);
    await session.attach(ed);
    await fonts.settled();
    engine.pump();
    const text = facts(ed).nodes.find((n) => n.type === "text")?.id as string;
    engine.setProps([text], {
      fontName: { family: "Yok Sans", style: "Regular", postscript: "" },
    } as never);
    await fonts.settled();
    engine.pump();
    expect(canvasMissingFonts(ed)).toEqual(["Yok Sans"]);
    expect(session.getState().dirty).toBe(true);

    expect(await session.save()).toBe(false);
    expect(session.getState().saveError).toBe(
      "Eksik font: Yok Sans. Mac'e yükleyin ya da marka kitine ekleyin.",
    );
    expect(calls).toEqual([]);
    // The draft keeps the canvas as it is.
    expect(drafts.items.get("p1")).toMatchObject({ baseVersion: 2 });

    // With a font Wecra has, the version is made.
    engine.setProps([text], {
      fontName: { family: "Inter", style: "Bold", postscript: "" },
    } as never);
    await fonts.settled();
    engine.pump();
    expect(await session.save()).toBe(true);
    expect(calls).toContain("version");
  });
});
