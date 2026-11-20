// Wecra's editor for the canvas runner (page.ts): the engine drawing into an off-screen canvas of
// the hidden page — so its exporter renders with the GPU exactly as the post editor's canvas does
// — on a document in memory (no store, nothing kept), with Studio's font source for the post's
// brand (wecra/fonts.ts).
import "../post-editor/wecra/embed.ts";
import { EditorController } from "@/editor/controller";
import { memoryDocumentSource } from "@/editor/documentSource";
import type { Message } from "@/engine/codec";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { fonts } from "@/engine/fonts";
import type { RenderKit } from "../post-editor/model/brand-kit.ts";
import type { BundleImages } from "../post-editor/wecra/bundle.ts";
import { installStudioFonts } from "../post-editor/wecra/fonts.ts";
import type { OpenedEditor } from "./run.ts";

let sessions = 0;
/** A session of its own per document (new layers' ids are `session:local`). */
const nextSession = () =>
  1_000_000 + (Math.floor(Date.now() / 1000) % 1_000_000) * 10 + (++sessions % 10);

/** The brand's fonts (and this Mac's) for the next document. */
export function useBrandFonts(kit: Pick<RenderKit, "tokens" | "files">): void {
  installStudioFonts(kit);
}

/** Wecra's editor on `document`, drawing into an off-screen canvas. */
export async function openEditor(
  document: Message,
  images: BundleImages,
  fileName: string,
): Promise<OpenedEditor> {
  const canvas = window.document.createElement("canvas");
  canvas.id = `canvas-runner-${++sessions}`;
  canvas.width = 256;
  canvas.height = 256;
  canvas.style.cssText = "position:fixed;left:0;top:0;width:256px;height:256px;";
  window.document.body.append(canvas);
  const sessionID = nextSession();
  const source = memoryDocumentSource(document, {
    fileName,
    location: "Studio",
    sessionID,
    images,
  });
  let engine: Engine | null = null;
  try {
    engine = await Engine.create(canvas, { sessionID });
    // The pictures at full size as the engine asks (before the document: no request is missed);
    // run.ts servePictures says why.
    engine.setImageSource((hash) => images.get(hash));
    const status = engine.load(await source.load());
    if (status !== 0) throw new Error(`Wecra belgesi açılamadı (durum ${status}).`);
    const live = engine;
    live.on("DOCUMENT_CHANGED", (e) =>
      source.onChanges(e.message, { kind: e.kind, label: e.label }),
    );
    const ed = new EditorController(live, new EngineStore(live), source);
    ed.canvas = canvas;
    return {
      ed,
      close: () => {
        ed.dispose();
        live.destroy();
        canvas.remove();
      },
    };
  } catch (e) {
    engine?.destroy();
    canvas.remove();
    throw e;
  }
}

/** The fonts the document asked for are in, and the engine laid the texts out with them. */
export async function settle(ed: EditorController): Promise<void> {
  for (let i = 0; i < 4; i++) {
    ed.engine.pump();
    await fonts.settled();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  ed.engine.pump();
}
