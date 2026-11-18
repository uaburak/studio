// The canvas runner's jobs (S1): a canvas version's Wecra document read or edited without a
// post window — the Mac app's hidden page runs them (page.ts), the chat agent asks for them
// (`canvas_outline`, `canvas_edit`), the iPhone through the chat.
//
// `canvas.apply`: the post's current version must be the one the operations were written against
// (else nothing changes: the agent reads again); its bundle opens in Wecra's engine with the
// brand's fonts, the operations run as Wecra's own MCP write tools (operations.ts), the frames
// must still fit the post (frames.ts), and the document becomes a new `ai_edit` version exactly as
// the canvas saves one (save.ts: renders, facts, pictures as assets, the bundle, checks). Hand
// edits made on the canvas are in that document, so they stay.
//
// `canvas.read`: the version's slides as an outline (`@studio/design-kit/canvas canvasOutline`
// over facts read from the live document — for versions saved before the facts), and Wecra's
// `get_design_context` for named layers.
import {
  type ApiClient,
  type CanvasApplyOutput,
  CanvasApplyPayload,
  CanvasReadPayload,
  type Content,
  type ContentVersion,
  type Job,
} from "@studio/contract";
import { canvasOutline } from "@studio/design-kit/canvas";
import { runTool } from "@/editor/agents/mcpTools";
import type { EditorController } from "@/editor/controller";
import type { Message } from "@/engine/codec";
import { type BundleImages, loadBundle } from "../post-editor/wecra/bundle.ts";
import { slideFacts } from "../post-editor/wecra/facts.ts";
import { canvasFrames, frameBlocker, postFormat } from "../post-editor/wecra/frames.ts";
import { documentHash } from "../post-editor/wecra/hash.ts";
import {
  captureDocument,
  createCanvasVersion,
  slideFrames,
  type VersionApi,
} from "../post-editor/wecra/save.ts";
import { applyOperations, headlessToolEnv } from "./operations.ts";

export type RunnerApi = VersionApi & {
  contents: Pick<ApiClient["contents"], "get"> & {
    versions: Pick<ApiClient["contents"]["versions"], "get" | "create">;
  };
};

export interface OpenedEditor {
  ed: EditorController;
  close(): void;
}

export interface CanvasRunnerDeps {
  api: RunnerApi;
  /** An asset's bytes (the bundle, its pictures, a picture to place). */
  fetchAsset(assetId: string): Promise<Uint8Array>;
  /** The brand's fonts for Wecra's text engine (before a document opens). */
  prepareFonts(brandId: string): Promise<void>;
  /** Wecra's editor on a document (a drawing engine in the page; headless in the tests). */
  openEditor(document: Message, images: BundleImages, fileName: string): Promise<OpenedEditor>;
  /** Fonts and pictures the document asked for are in (before facts and renders are read). */
  settle(ed: EditorController): Promise<void>;
  progress?(value: number, message: string): void;
  signal?: AbortSignal;
}

/** A job that cannot be done as asked (said to the agent as it is). */
export class CanvasJobError extends Error {
  override name = "CanvasJobError";
}

const LOCKED = new Set(["publishing", "published"]);
const MAX_DESIGN_CHARS = 60_000;

function check(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CanvasJobError("İptal edildi.");
}

/** The post, its version and the version's Wecra document. */
async function openVersion(
  deps: CanvasRunnerDeps,
  contentId: string,
  wanted: number | undefined,
): Promise<{
  content: Content;
  version: ContentVersion;
  editor: OpenedEditor;
  sourceVersion: number | null;
  images: BundleImages;
  missing: number;
}> {
  const { api } = deps;
  const content = await api.contents.get(contentId);
  const current = content.currentVersion?.version ?? null;
  const number = wanted ?? current;
  if (number === null) throw new CanvasJobError(`“${content.title}” postunun henüz tasarımı yok.`);
  const version = await api.contents.versions.get(contentId, number);
  if (version.editorDocument?.kind !== "wecra")
    throw new CanvasJobError(
      `v${version.version} tuvalde kaydedilmiş bir sürüm değil (Wecra belgesi yok). HTML postlarını revise_post ile düzelt.`,
    );
  deps.progress?.(0.1, "Tuval belgesi açılıyor");
  const bundle = await loadBundle(await deps.fetchAsset(version.editorDocument.assetId), (id) =>
    deps.fetchAsset(id),
  );
  check(deps.signal);
  await deps.prepareFonts(content.brandId);
  const editor = await deps.openEditor(bundle.message, bundle.images, content.title);
  return {
    content,
    version,
    editor,
    sourceVersion: bundle.meta.sourceVersion ?? null,
    images: bundle.images,
    missing: bundle.missing?.length ?? 0,
  };
}

/** `canvas.apply` (see the top). */
export async function applyCanvasJob(job: Job, deps: CanvasRunnerDeps): Promise<CanvasApplyOutput> {
  const payload = CanvasApplyPayload.parse(job.payload);
  const contentId = job.contentId;
  if (!contentId) throw new CanvasJobError("canvas.apply işi için contentId gerekli.");
  const head = await deps.api.contents.get(contentId);
  if (LOCKED.has(head.status))
    throw new CanvasJobError(`“${head.title}” yayında ya da yayınlanıyor; değiştirilemez.`);
  const current = head.currentVersion?.version ?? null;
  if (current !== payload.version)
    throw new CanvasJobError(
      `Post değişti: güncel sürüm v${current ?? "-"}, işlemler v${payload.version} için yazıldı. Hiçbir şey değişmedi; canvas_outline ile güncel sürümü okuyup yeniden dene.`,
    );
  check(deps.signal);
  const opened = await openVersion(deps, contentId, payload.version);
  const { content, version, editor } = opened;
  const { ed } = editor;
  try {
    // A picture of the document that is no longer in the media would be saved empty.
    if (opened.missing)
      throw new CanvasJobError(
        `Belgedeki ${opened.missing} görsel medyada bulunamadı; sürüm oluşmadı. Postu tuvalde açıp görselleri yeniden yerleştir.`,
      );
    await deps.settle(ed);
    const before = await documentHash(ed.engine.encodeDocumentKiwi());
    deps.progress?.(0.3, "Wecra işlemleri uygulanıyor");
    const results = await applyOperations(ed, payload.operations, { fetchAsset: deps.fetchAsset });
    check(deps.signal);
    const failed = results.filter((r) => !r.ok);
    if (failed.length === results.length)
      throw new CanvasJobError(
        `Hiçbir işlem uygulanamadı; sürüm oluşmadı. ${failed.map((r) => r.summary).join(" | ")}`.slice(
          0,
          4_000,
        ),
      );
    const after = await documentHash(ed.engine.encodeDocumentKiwi());
    if (after === before)
      throw new CanvasJobError(
        `İşlemler belgeyi değiştirmedi; sürüm oluşmadı. ${results.map((r) => r.summary).join(" | ")}`.slice(
          0,
          4_000,
        ),
      );
    const first = version.slides[0];
    const blocker = frameBlocker(
      content.type,
      canvasFrames(ed),
      postFormat(content.type, first ? { width: first.width, height: first.height } : null),
    );
    if (blocker) throw new CanvasJobError(`Sürüm oluşmadı: ${blocker}`);
    await deps.settle(ed);
    check(deps.signal);
    deps.progress?.(0.6, "Kareler dışa aktarılıyor");
    const capture = captureDocument(ed);
    const created = await createCanvasVersion({
      api: deps.api,
      content,
      ed,
      capture,
      images: opened.images,
      sourceVersion: opened.sourceVersion,
      origin: "ai_edit",
      note: payload.note?.trim() || "AI tuvalde düzenledi.",
      jobId: job.id,
    });
    const checkJob = await created.check;
    deps.progress?.(1, "Tamamlandı");
    return {
      contentId,
      version: created.version.version,
      baseVersion: version.version,
      results,
      slides: capture.slides.length,
      checkJobId: checkJob?.id ?? null,
    };
  } finally {
    editor.close();
  }
}

/** `canvas.read` (see the top). */
export async function readCanvasJob(
  job: Job,
  deps: CanvasRunnerDeps,
): Promise<Record<string, unknown>> {
  const payload = CanvasReadPayload.parse(job.payload);
  const contentId = job.contentId;
  if (!contentId) throw new CanvasJobError("canvas.read işi için contentId gerekli.");
  const opened = await openVersion(deps, contentId, payload.version);
  const { ed } = opened.editor;
  try {
    await deps.settle(ed);
    check(deps.signal);
    const slides = slideFrames(ed).map((s, i) => {
      const facts = slideFacts(ed, s.guid);
      return facts
        ? canvasOutline(facts, i + 1)
        : {
            slide: i + 1,
            frameId: s.guid,
            name: s.name,
            width: s.width,
            height: s.height,
            layers: [],
          };
    });
    let design: string | undefined;
    if (payload.nodeIds?.length) {
      const env = headlessToolEnv(ed);
      try {
        const r = await runTool(env, "get_design_context", { nodeIds: payload.nodeIds, depth: 4 });
        design = r.content
          .filter((c) => c.type === "text")
          .map((c) => (c as { text: string }).text)
          .join("\n")
          .slice(0, MAX_DESIGN_CHARS);
      } finally {
        env.dispose();
      }
    }
    return {
      contentId,
      version: opened.version.version,
      slides,
      ...(design !== undefined ? { design } : {}),
      ...(opened.missing ? { missingImages: opened.missing } : {}),
    };
  } finally {
    opened.editor.close();
  }
}

/** One job of the canvas runner. */
export async function runCanvasJob(
  job: Job,
  deps: CanvasRunnerDeps,
): Promise<Record<string, unknown>> {
  switch (job.type) {
    case "canvas.apply":
      return { ...(await applyCanvasJob(job, deps)) };
    case "canvas.read":
      return readCanvasJob(job, deps);
    default:
      throw new CanvasJobError(`Tuval çalıştırıcısı ${job.type} işini yapmaz.`);
  }
}
