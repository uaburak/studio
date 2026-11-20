// A Wecra document becomes a version of the post — the same way for the canvas (session.ts: ⌘S,
// approve, a chat message, closing the post) and for the canvas runner (an AI edit made with
// Wecra's design operations while no window has the post open, canvas-runner/run.ts):
//
//   the slides are the page's top-level frames in reading order (Wecra's `pageFrames`); each is
//   exported by Wecra's engine (PNG, 1x, sRGB) and read as canvas facts (facts.ts) at once; the
//   document's pictures become the brand's assets (each once: assets.ts) and the document is
//   bundled with references to them (bundle.ts); the renders and the bundle are uploaded and a
//   version is created whose slides are those renders (`canvasSlideHtml`) with the bundle as its
//   `editorDocument`; a `content.check` job (no model pass) checks it.
import type { ApiClient, ContentVersion, ContentVersionOrigin, Job } from "@studio/contract";
import { WECRA_DOCUMENT_MIME } from "@studio/contract";
import type { CanvasFacts } from "@studio/design-kit/canvas";
import type { EditorController } from "@/editor/controller";
import { convertPixels } from "@/editor/exportCore";
import { encodePixels, pageFrames, renderExport } from "@/editor/exporting";
import type { ExportOutput } from "@/engine/codec";
import { shareImages } from "./assets.ts";
import {
  BUNDLE_FORMAT,
  type BundleImages,
  type BundleSlide,
  encodeBundle,
  usedImages,
} from "./bundle.ts";
import { slideFacts } from "./facts.ts";
import { canvasSlideHtml, canvasSlideLayout, sha256Hex } from "./slide-html.ts";

/** A slide's render: the frame at 1x, in sRGB. */
export const SLIDE_EXPORT = {
  imageType: "PNG",
  constraint: { type: "CONTENT_SCALE", value: 1 },
  useAbsoluteBounds: true,
  colorProfile: "SRGB",
} as const;

export interface SavedSlide extends BundleSlide {
  png: Uint8Array;
}

export interface CapturedFrame {
  slide: BundleSlide;
  out: ExportOutput;
}

/** Everything a version is made of, read from the editor at once. */
export interface CanvasCapture {
  document: Uint8Array;
  slides: BundleSlide[];
  /** Each slide's canvas facts (`null`: unreadable — the slide is then the render alone). */
  facts: (CanvasFacts | null)[];
  captured: CapturedFrame[];
}

/** The slide frames (the page's top-level frames in reading order) with their sizes. */
export function slideFrames(ed: EditorController): BundleSlide[] {
  const frames = pageFrames(ed);
  const nodes = ed.engine.readNodes(
    frames.map((f) => f.ref),
    { fields: ["size", "name"] },
  );
  return frames.map((f, i) => {
    const size = (nodes[i] as { size?: { x: number; y: number } } | undefined)?.size;
    return {
      guid: f.ref,
      name: f.name,
      width: Math.round(size?.x ?? 0),
      height: Math.round(size?.y ?? 0),
    };
  });
}

/**
 * Every slide frame as Wecra's engine draws it now (synchronously: a save started as the post
 * closes gets the pixels before the editor goes). `closing`: drawn as it is, even with a font or
 * an image still on its way.
 */
export function exportFrames(
  ed: EditorController,
  slides: readonly BundleSlide[],
  closing = false,
): CapturedFrame[] {
  if (ed.engine.destroyed) throw new Error("Tuval hazır değil.");
  return slides.map((slide) => ({
    slide,
    out: ed.engine.exportNodes(
      [slide.guid],
      SLIDE_EXPORT,
      closing ? { allowPending: true } : undefined,
    ),
  }));
}

/**
 * The PNG of each captured frame. A frame the engine could not draw at once (a font or an image
 * on its way) goes through Wecra's own export, which waits for them — while the editor is there.
 */
export async function encodeFrames(
  ed: EditorController | null,
  captured: readonly CapturedFrame[],
): Promise<SavedSlide[]> {
  const out: SavedSlide[] = [];
  for (const { slide, out: o } of captured) {
    let png: Uint8Array;
    if (o.status === "ok" && "pixels" in o) {
      const from = ed?.engine.destroyed === false ? ed.engine.colorProfile : "SRGB";
      png = await encodePixels(
        { ...o.pixels, pixels: convertPixels(o.pixels.pixels, from, "SRGB") },
        "image/png",
        undefined,
        "SRGB",
      );
    } else if (ed && !ed.engine.destroyed) {
      const r = await renderExport(ed, [slide.guid], SLIDE_EXPORT);
      if ("error" in r) throw new Error(`${slide.name} dışa aktarılamadı: ${r.error}`);
      png = r.bytes;
    } else {
      throw new Error(`${slide.name} dışa aktarılamadı.`);
    }
    out.push({ ...slide, png });
  }
  return out;
}

/** The document, its slides, their facts and their renders, read from the editor at once. */
export function captureDocument(ed: EditorController, closing = false): CanvasCapture {
  const slides = slideFrames(ed);
  return {
    document: ed.engine.encodeDocumentKiwi(),
    slides,
    facts: slides.map((s) => slideFacts(ed, s.guid)),
    captured: exportFrames(ed, slides, closing),
  };
}

export type VersionApi = Pick<ApiClient, "assets" | "jobs"> & {
  contents: { versions: Pick<ApiClient["contents"]["versions"], "create"> };
};

export interface CreatedCanvasVersion {
  version: ContentVersion;
  /** The `content.check` job over it (null: it could not be queued). */
  check: Promise<Job | null>;
}

/** Uploads the renders, the pictures and the document, and creates the version (see the top). */
export async function createCanvasVersion(o: {
  api: VersionApi;
  content: { id: string; brandId: string };
  /** The editor the capture is of (null: it is gone — every frame must have been drawn). */
  ed: EditorController | null;
  capture: CanvasCapture;
  images: BundleImages;
  /** The HTML version the document was first imported from. */
  sourceVersion: number | null;
  /** `generated`: the Wecra engine's design on a blank canvas (canvas-runner `canvas.create`). */
  origin: ContentVersionOrigin;
  note: string;
  jobId?: string;
}): Promise<CreatedCanvasVersion> {
  const { api, content, capture, images } = o;
  const exported = await encodeFrames(o.ed, capture.captured);
  // The pictures as the brand's assets, each once (E13); the bundle refers to them.
  await shareImages(images, usedImages(capture.document, images), (input) =>
    api.assets.upload({
      brandId: content.brandId,
      kind: "image",
      source: "upload",
      file: input.file,
      filename: input.filename,
    }),
  );
  const bundle = encodeBundle(capture.document, images, capture.slides, o.sourceVersion);
  const renders = await Promise.all(
    exported.map(async (s, i) => {
      const asset = await api.assets.upload({
        brandId: content.brandId,
        kind: "image",
        source: "generated",
        width: s.width,
        height: s.height,
        file: new Blob([s.png as BlobPart], { type: "image/png" }),
        filename: `kare-${i + 1}.png`,
      });
      return { asset, sha256: await sha256Hex(s.png) };
    }),
  );
  const documentAsset = await api.assets.upload({
    brandId: content.brandId,
    kind: "document",
    source: "generated",
    file: new Blob([bundle as BlobPart], { type: WECRA_DOCUMENT_MIME }),
    filename: "post.wecra",
  });
  const version = await api.contents.versions.create(content.id, {
    origin: o.origin,
    note: o.note,
    ...(o.jobId ? { jobId: o.jobId } : {}),
    slides: exported.map((s, i) => ({
      html: canvasSlideHtml({
        src: `/media/${encodeURIComponent((renders[i] as { asset: { id: string } }).asset.id)}.png`,
        sha256: (renders[i] as { sha256: string }).sha256,
        width: s.width,
        height: s.height,
        facts: capture.facts[i] ?? null,
        sourceVersion: o.sourceVersion,
      }),
      width: s.width,
      height: s.height,
    })),
    renderedAssetIds: renders.map((r) => r.asset.id),
    // The render and the described layers, measured (the facts): no measuring render follows.
    layouts: exported.map((s, i) => canvasSlideLayout(capture.facts[i] ?? null, s.width, s.height)),
    editorDocument: { kind: "wecra", assetId: documentAsset.id, format: BUNDLE_FORMAT },
  });
  // The deterministic checks on the new renders (the model pass stays a manual run).
  const check = api.jobs
    .create({
      type: "content.check",
      brandId: content.brandId,
      contentId: content.id,
      payload: { version: version.version, model: false },
    })
    .catch(() => null);
  return { version, check };
}
