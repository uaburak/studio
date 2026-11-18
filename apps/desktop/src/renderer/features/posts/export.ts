// Export a post (port of StudioKit's PostExporter and StudioMac's export menu): JPEG / PNG of
// this slide or all slides, one PDF of the carousel, a reel's MP4 or cover; "Paylaş…" opens the
// macOS share menu and "Finder'da göster" the written files. Which assets make the export is
// decided here, through the API the AppKit app used:
// - JPEG: the version's rendered slides (missing renders are made first, `content.render` jpeg);
// - PNG: `content.render` png → `pngAssetIds` (lossless, rendered on the Mac);
// - PDF: `content.render` pdf → `pdfAssetId` (one multi-page Chromium PDF);
// - Reels: the version's video / cover asset.
// The main process asks where to save, downloads and writes (shared/post-files.ts).
import {
  type ApiClient,
  type Content,
  type ContentVersion,
  isTerminalJobStatus,
  type Job,
  readReelVersionInfo,
  slugify,
} from "@studio/contract";
import { useMemo } from "react";
import type {
  PostFile,
  PostFileFormat,
  PostFilesRequest,
  PostFilesResult,
} from "../../../shared/post-files.ts";
import type { MenuEntry } from "../../components/ui/menu.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { bridge } from "../../lib/bridge.ts";
import { type Toast, useAppStore } from "../../state/app-store.ts";

type ToastInput = Omit<Toast, "id" | "tone"> & { tone?: Toast["tone"] };

export type ExportFormat = "jpeg" | "png" | "pdf";

export interface ExportChoice {
  format: ExportFormat;
  /** 0-based slides; null = all (a PDF always holds every slide). */
  slides: number[] | null;
}

export type ExportApi = {
  jobs: Pick<ApiClient["jobs"], "create" | "get">;
  contents: { versions: Pick<ApiClient["contents"]["versions"], "get"> };
};

/** `hasat-sonrasi-v3` (StudioKit's PostExporter.baseName). */
export function exportBaseName(title: string, version: number): string {
  const slug = slugify(title);
  return `${slug || "post"}-v${version}`;
}

const EXT: Record<ExportFormat, string> = { jpeg: "jpg", png: "png", pdf: "pdf" };

/** The export menu's choices (StudioMac PostFileExport.menu). */
export function exportChoices(
  slideCount: number,
  currentSlide: number | null,
): { id: string; label: string; choice: ExportChoice }[] {
  const all = (format: ExportFormat): ExportChoice => ({ format, slides: null });
  if (slideCount > 1 && currentSlide !== null) {
    const one = (format: ExportFormat): ExportChoice => ({ format, slides: [currentSlide] });
    return [
      { id: "jpeg-one", label: `JPEG — bu slayt (${currentSlide + 1})`, choice: one("jpeg") },
      { id: "jpeg-all", label: `JPEG — tüm slaytlar (${slideCount})`, choice: all("jpeg") },
      { id: "png-one", label: `PNG — bu slayt (${currentSlide + 1})`, choice: one("png") },
      { id: "png-all", label: `PNG — tüm slaytlar (${slideCount})`, choice: all("png") },
      { id: "pdf", label: `PDF — carousel (${slideCount} sayfa)`, choice: all("pdf") },
    ];
  }
  const many = slideCount > 1;
  return [
    {
      id: "jpeg-all",
      label: many ? `JPEG — tüm slaytlar (${slideCount})` : "JPEG",
      choice: all("jpeg"),
    },
    {
      id: "png-all",
      label: many ? `PNG — tüm slaytlar (${slideCount})` : "PNG",
      choice: all("png"),
    },
    { id: "pdf", label: many ? `PDF — carousel (${slideCount} sayfa)` : "PDF", choice: all("pdf") },
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runJob(
  api: ExportApi,
  input: Parameters<ApiClient["jobs"]["create"]>[0],
  options: {
    timeoutMs: number;
    pollMs: number;
    onProgress?: ((message: string) => void) | undefined;
  },
): Promise<Job> {
  const job = await api.jobs.create(input);
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const current = await api.jobs.get(job.id);
    if (current.progressMessage) options.onProgress?.(current.progressMessage);
    if (current.status === "succeeded") return current;
    if (current.status === "failed") throw new Error(current.error ?? "İş başarısız oldu.");
    if (current.status === "cancelled") throw new Error("İş iptal edildi.");
    if (isTerminalJobStatus(current.status)) return current;
    if (Date.now() >= deadline)
      throw new Error("İş zamanında bitmedi; Mac'teki işçi çalışıyor mu?");
    await sleep(options.pollMs);
  }
}

/**
 * The assets (with file names) of `choice` for `version`: JPEG renders missing slides first,
 * PNG and PDF are rendered by the worker. Throws a Turkish message when something is missing.
 */
export async function exportFiles(
  api: ExportApi,
  content: Content,
  version: ContentVersion,
  choice: ExportChoice,
  options: { timeoutMs?: number; pollMs?: number; onProgress?: (message: string) => void } = {},
): Promise<PostFile[]> {
  const run = {
    timeoutMs: options.timeoutMs ?? 300_000,
    pollMs: options.pollMs ?? 400,
    onProgress: options.onProgress,
  };
  const count = version.slides.length;
  const indices = (choice.slides ?? version.slides.map((_, i) => i)).filter(
    (i) => i >= 0 && i < count,
  );
  const base = exportBaseName(content.title, version.version);
  const name = (i: number, ext: string) =>
    count > 1 ? `${base}-${i + 1}.${ext}` : `${base}.${ext}`;
  switch (choice.format) {
    case "jpeg": {
      let current = version;
      if (indices.some((i) => !current.slides[i]?.renderedAssetId)) {
        options.onProgress?.("Eksik görseller render ediliyor");
        await runJob(
          api,
          {
            type: "content.render",
            contentId: content.id,
            payload: { format: "jpeg", version: version.version },
          },
          run,
        );
        current = await api.contents.versions.get(content.id, version.version);
      }
      return indices.map((i) => {
        const assetId = current.slides[i]?.renderedAssetId;
        if (!assetId) throw new Error(`Slayt ${i + 1} render edilemedi.`);
        return { assetId, name: name(i, EXT.jpeg) };
      });
    }
    case "png": {
      options.onProgress?.("PNG hazırlanıyor");
      const done = await runJob(
        api,
        {
          type: "content.render",
          contentId: content.id,
          payload: { format: "png", version: version.version, slides: indices },
        },
        run,
      );
      const ids = (done.output as { pngAssetIds?: unknown } | undefined)?.pngAssetIds;
      return indices.map((i) => {
        const assetId = Array.isArray(ids) ? ids[i] : null;
        if (typeof assetId !== "string") throw new Error(`Slayt ${i + 1} PNG olarak üretilemedi.`);
        return { assetId, name: name(i, EXT.png) };
      });
    }
    case "pdf": {
      options.onProgress?.("PDF hazırlanıyor");
      const done = await runJob(
        api,
        {
          type: "content.render",
          contentId: content.id,
          payload: { format: "pdf", version: version.version },
        },
        run,
      );
      const pdf = (done.output as { pdfAssetId?: unknown } | undefined)?.pdfAssetId;
      if (typeof pdf !== "string") throw new Error("PDF üretilemedi.");
      return [{ assetId: pdf, name: `${base}.pdf` }];
    }
  }
}

/** A reel's MP4 (or its cover JPEG); a Turkish reason when the version has none. */
export function reelFile(
  content: Content,
  version: ContentVersion,
  cover: boolean,
): PostFile | string {
  const info = readReelVersionInfo(version.slides[0]?.html ?? "");
  const base = exportBaseName(content.title, version.version);
  if (cover) {
    const id = info.coverAssetId ?? version.slides[0]?.renderedAssetId ?? null;
    return id ? { assetId: id, name: `${base}-kapak.jpg` } : "Kapak görseli yok.";
  }
  return info.videoAssetId
    ? { assetId: info.videoAssetId, name: `${base}.mp4` }
    : "Bu sürümde video yok.";
}

/** "hasat-v3.pdf kaydedildi" / "3 dosya kaydedildi". */
export function savedText(paths: string[]): string {
  const first = paths[0];
  if (paths.length === 1 && first) return `${first.split("/").pop()} kaydedildi`;
  return `${paths.length} dosya kaydedildi`;
}

/** Why exporting is not possible right now (null: it is). */
export function exportBlocker(content: Content, version: ContentVersion | null): string | null {
  if (!bridge().postFiles) return "Dışa aktarma yalnızca Studio uygulamasında çalışır.";
  if (!version) return "Dışa aktarılacak bir sürüm yok.";
  if (content.type === "reel" && !readReelVersionInfo(version.slides[0]?.html ?? "").videoAssetId)
    return "Bu sürümde video yok.";
  return null;
}

let busy = false;
/** The files the last export wrote ("Son dışa aktarımı Finder'da göster"). */
let lastExport: string[] = [];

/** Export / share / reveal with toasts (the AppKit app's status line). */
export function usePostExport() {
  const api = useApi();
  return useMemo(() => {
    const toast = (message: string, extra: Omit<ToastInput, "message"> = {}) =>
      useAppStore.getState().showToast({ message, ...extra });

    async function deliver(
      request: () => Promise<PostFilesRequest>,
      kind: "save" | "share",
    ): Promise<string[] | null> {
      const files = bridge().postFiles;
      if (!files) {
        toast("Dışa aktarma yalnızca Studio uygulamasında çalışır.", { tone: "danger" });
        return null;
      }
      if (busy) {
        toast("Dışa aktarma sürüyor.");
        return null;
      }
      busy = true;
      try {
        const prepared = await request();
        const result: PostFilesResult =
          kind === "save" ? await files.save(prepared) : await files.share(prepared);
        if (result.ok) {
          if (kind === "save") {
            const paths = result.paths;
            lastExport = paths;
            toast(savedText(paths), {
              action: { label: "Finder'da göster", run: () => void files.reveal(paths) },
              durationMs: 10_000,
            });
          }
          return result.paths;
        }
        if (!("canceled" in result && result.canceled)) {
          toast(`Dışa aktarma: ${"message" in result ? result.message : "olmadı."}`, {
            tone: "danger",
          });
        }
        return null;
      } catch (e) {
        toast(`Dışa aktarma: ${describeError(e)}`, { tone: "danger" });
        return null;
      } finally {
        busy = false;
      }
    }

    const prepare = (format: ExportFormat | "mp4") =>
      toast(`${format === "mp4" ? "Video" : format.toUpperCase()} hazırlanıyor…`);

    const slideRequest =
      (content: Content, version: ContentVersion, choice: ExportChoice) => async () => {
        prepare(choice.format);
        const files = await exportFiles(api, content, version, choice);
        return { format: choice.format as PostFileFormat, files };
      };

    const reelRequest = (content: Content, version: ContentVersion, cover: boolean) => async () => {
      const file = reelFile(content, version, cover);
      if (typeof file === "string") throw new Error(file);
      return { format: (cover ? "jpeg" : "mp4") as PostFileFormat, files: [file] };
    };

    return {
      exportSlides: (content: Content, version: ContentVersion, choice: ExportChoice) =>
        deliver(slideRequest(content, version, choice), "save"),
      exportReel: (content: Content, version: ContentVersion, cover: boolean) =>
        deliver(reelRequest(content, version, cover), "save"),
      /** Every slide as JPEG (a reel: its MP4) in the macOS share menu. */
      share: (content: Content, version: ContentVersion) =>
        deliver(
          content.type === "reel"
            ? reelRequest(content, version, false)
            : slideRequest(content, version, { format: "jpeg", slides: null }),
          "share",
        ),
      /** Shows the last export's files in Finder. */
      revealLast: () => {
        if (lastExport.length > 0) void bridge().postFiles?.reveal(lastExport);
      },
      hasLast: () => lastExport.length > 0,
    };
  }, [api]);
}

export type PostExport = ReturnType<typeof usePostExport>;

/** "Dışa aktar ▸" and "Paylaş…" entries of a post's menus. */
export function exportMenuEntries(
  exporter: PostExport,
  content: Content,
  version: ContentVersion | null,
  currentSlide: number | null,
): MenuEntry[] {
  const blocker = exportBlocker(content, version);
  const disabled = blocker !== null || version === null;
  const detail = blocker ? { detail: blocker } : {};
  const submenu: MenuEntry[] = !version
    ? []
    : content.type === "reel"
      ? [
          {
            id: "mp4",
            label: "Video (MP4)",
            onSelect: () => void exporter.exportReel(content, version, false),
          },
          {
            id: "cover",
            label: "Kapak (JPEG)",
            onSelect: () => void exporter.exportReel(content, version, true),
          },
        ]
      : exportChoices(version.slides.length, currentSlide).map((c) => ({
          id: c.id,
          label: c.label,
          onSelect: () => void exporter.exportSlides(content, version, c.choice),
        }));
  return [
    { id: "export", label: "Dışa aktar", disabled, ...detail, submenu },
    {
      id: "share",
      label: "Paylaş…",
      disabled,
      ...detail,
      onSelect: () => {
        if (version) void exporter.share(content, version);
      },
    },
    {
      id: "reveal-export",
      label: "Son dışa aktarımı Finder'da göster",
      disabled: !exporter.hasLast(),
      onSelect: exporter.revealLast,
    },
  ];
}
