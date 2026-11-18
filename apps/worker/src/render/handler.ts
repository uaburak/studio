/**
 * `content.render` handler (Faz 2 & Faz 6):
 * - Slot-fill (`slotAssignments[slotLayerId] = assetId` -> `/media/${assetId}.<ext>`),
 * - Typed `@studio/design-kit` layer patching (`patches`, each `{ slide, op, ... }`; the
 *   older `set_text` / `set_visible` spellings are accepted),
 * - Creates a new `manual_edit` version from `version` (default: current) and moves
 *   `draft` -> `in_review` when edits are applied; slides whose HTML did not change keep
 *   their render and layer layout,
 * - Renders slides to sRGB JPEG (respecting Instagram 1440px max width) and stores
 *   `renderedAssetIds` plus the measured layer boxes (`layouts`) on the version,
 * - Lossless PNG exports (`format: "png"`, `pngAssetIds`) without touching the version,
 * - Renders single-pass multi-page Chromium vector PDF (`page.pdf`) for LinkedIn carousels (`format: "pdf" | "both"`),
 * - Delegates Reels (`content.type === "reel"` or `format === "mp4"`) to the Reels Video Engine.
 */
import path from "node:path";
import {
  ApiError,
  ContentRenderPayload,
  type ContentVersion,
  type SlideInput,
  type SlideLayout,
} from "@studio/contract";
import { brandPatchContext } from "@studio/design-kit/brand";
import { parseSlide } from "@studio/design-kit/document";
import { applyPatch, type PatchContext, PatchOp } from "@studio/design-kit/patch";
import {
  type AssetResolver,
  buildImagePdf,
  combineResolvers,
  pngToSrgbJpeg,
  type RenderAndLintRequest,
  type RenderAndLintResult,
  Renderer,
  type RenderRequest,
  type RenderResult,
} from "@studio/design-kit/render";
import { STRICT_CSP, sanitizeSlideHtml } from "@studio/design-kit/sanitize";
import sharp from "sharp";
import type { AgentDeps } from "../agent.ts";
import {
  checkLintConfig,
  failedBrief,
  presetForVersion,
  runContentChecks,
  type SlideReport,
} from "../checks/pipeline.ts";
import { loadBrandContext } from "../generate/brand.ts";
import { extensionForMime } from "../media.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";
import {
  createApiAssetPathResolver,
  type ReelEngineTestSeams,
  renderExistingReelVersion,
} from "../video/render-reel.ts";
import { layoutFromReport, missingSystemFonts } from "./layout.ts";

export const RENDER_ASSET_PREFIXES = ["/brand/", "/media/", "/api/assets/"] as const;

export interface RenderCapable {
  render?(request: RenderRequest): Promise<RenderResult>;
  renderAndLint(request: RenderAndLintRequest): Promise<RenderAndLintResult>;
}

export interface ContentRenderDeps extends AgentDeps {
  renderer: () => RenderCapable;
  reelSeams?: ReelEngineTestSeams;
}

function slug(text: string): string {
  return (
    text
      .toLocaleLowerCase("tr")
      .replace(/[çğıöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" })[c] ?? c)
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "content"
  );
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Contract-conform image path of an uploaded asset (`/media/<assetId><ext>`). The
 * renderer's API resolver serves `/media/<id>.*` from `GET /api/assets/<id>/content`.
 */
export function mediaSrcFor(assetId: string, extension = ".jpg"): string {
  return `/media/${encodeURIComponent(assetId)}${extension}`;
}

/**
 * The patch spellings the apps send, normalised to design-kit `PatchOp`s:
 * `set_text` -> `setText`, `set_visible {visible}` / `setVisibility {visible}` ->
 * `setVisibility {hidden}`.
 */
export function normalizePatchOp(raw: Record<string, unknown>): Record<string, unknown> {
  const { op, ...rest } = raw;
  if (op === "set_text") return { ...rest, op: "setText" };
  if (
    op === "set_visible" ||
    (op === "setVisibility" && !("hidden" in rest) && "visible" in rest)
  ) {
    const { visible, ...others } = rest;
    return { ...others, op: "setVisibility", hidden: visible === false };
  }
  return raw;
}

/**
 * Fill a single slot or image layer across a slide's HTML using `@studio/design-kit`'s
 * `applyPatch`, with a clean fallback for non-contract `<img>` / `[data-slot]` markup.
 */
export function applySlotAssignmentToSlide(
  html: string,
  slotLayerId: string,
  assetId: string,
  patchCtx: PatchContext,
  src: string = mediaSrcFor(assetId),
): { html: string; matched: boolean } {
  const doc = parseSlide(html);
  const entry = doc.entries.get(slotLayerId);

  if (entry) {
    if (entry.type === "slot") {
      let patched = applyPatch(doc, { op: "fillSlot", layer: slotLayerId, src }, patchCtx).html;
      // Strip any optional empty-slot placeholder attributes/classes on the filled slot
      patched = patched.replace(
        new RegExp(
          `(<[^>]*\\bdata-layer="${slotLayerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>)`,
        ),
        (tag) =>
          tag
            .replace(/\s+data-slot-empty(?:="[^"]*")?/gi, "")
            .replace(/\bclass="([^"]*)"/i, (_m, cls: string) => {
              const cleaned = cls
                .split(/\s+/)
                .filter((c) => c && c !== "empty-slot" && c !== "is-empty" && c !== "slot-empty")
                .join(" ");
              return cleaned ? `class="${cleaned}"` : "";
            }),
      );
      return { html: patched, matched: true };
    }
    if (entry.type === "image") {
      const patched = applyPatch(
        doc,
        { op: "replaceImage", layer: slotLayerId, src },
        patchCtx,
      ).html;
      return { html: patched, matched: true };
    }
  }

  // Fallback for raw `<img data-layer="slotLayerId">` or `<div data-slot="slotLayerId">`
  const escapedId = slotLayerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const imgTagRe = new RegExp(
    `<img\\b([^>]*\\b(?:data-layer|data-slot)="${escapedId}"[^>]*)>`,
    "i",
  );
  if (imgTagRe.test(html)) {
    const next = html.replace(imgTagRe, (_full, attrs: string) => {
      const cleaned = attrs
        .replace(/\s+data-slot-empty(?:="[^"]*")?/gi, "")
        .replace(/\s+data-slot-state="[^"]*"/gi, "");
      if (/\bsrc="[^"]*"/i.test(cleaned)) {
        return `<img${cleaned.replace(/\bsrc="[^"]*"/i, `src="${escapeAttr(src)}"`)}>`;
      }
      return `<img${cleaned} src="${escapeAttr(src)}">`;
    });
    return { html: next, matched: true };
  }

  const slotContainerRe = new RegExp(
    `<([a-z0-9]+)\\b([^>]*\\b(?:data-layer|data-slot)="${escapedId}"[^>]*)>([\\s\\S]*?)<\\/\\1>`,
    "i",
  );
  if (slotContainerRe.test(html)) {
    const next = html.replace(slotContainerRe, (_full, tag: string, attrs: string) => {
      let nextAttrs = attrs
        .replace(/\s+data-slot-empty(?:="[^"]*")?/gi, "")
        .replace(/\bdata-slot-state="[^"]*"/i, 'data-slot-state="filled"');
      if (!/\bdata-slot-state=/i.test(nextAttrs)) {
        nextAttrs += ' data-slot-state="filled"';
      }
      return `<${tag}${nextAttrs}><img data-slot-image src="${escapeAttr(src)}" alt=""></${tag}>`;
    });
    return { html: next, matched: true };
  }

  return { html, matched: false };
}

function applyPayloadPatchesToSlides(
  slides: SlideInput[],
  patches: ReadonlyArray<Record<string, unknown>>,
  patchCtx: PatchContext,
): SlideInput[] {
  const out = slides.map((s) => ({ ...s }));

  for (const rawPatch of patches) {
    // Shape 1: PatchLog `{ slide: 0, entries: [{ op: ... }] }`
    if (typeof rawPatch.slide === "number" && Array.isArray(rawPatch.entries)) {
      const targetSlide = out[rawPatch.slide];
      if (!targetSlide) {
        throw new Error(`Patch hedef slayt bulunamadı: slide=${rawPatch.slide}`);
      }
      let currentHtml = targetSlide.html;
      for (const entry of rawPatch.entries) {
        const opCandidate =
          entry && typeof entry === "object" && "op" in entry
            ? (entry as { op: unknown }).op
            : entry;
        const parsedOp = PatchOp.parse(
          opCandidate && typeof opCandidate === "object"
            ? normalizePatchOp(opCandidate as Record<string, unknown>)
            : opCandidate,
        );
        currentHtml = applyPatch(currentHtml, parsedOp, patchCtx).html;
      }
      targetSlide.html = currentHtml;
      continue;
    }

    // Shape 2: `{ slide?: number, slideIndex?: number, ...PatchOp }`
    const { slide: slideIdx, slideIndex, ...rest } = rawPatch;
    const explicitIdx =
      typeof slideIdx === "number"
        ? slideIdx
        : typeof slideIndex === "number"
          ? slideIndex
          : undefined;
    const parsedOp = PatchOp.parse(normalizePatchOp(rest));

    if (explicitIdx !== undefined) {
      const targetSlide = out[explicitIdx];
      if (!targetSlide) {
        throw new Error(`Patch hedef slayt bulunamadı: slide=${explicitIdx}`);
      }
      targetSlide.html = applyPatch(targetSlide.html, parsedOp, patchCtx).html;
      continue;
    }

    // Without explicit slide index: apply to slides containing `parsedOp.layer` (or slide 0 for root insertions)
    if ("layer" in parsedOp && typeof parsedOp.layer === "string") {
      let appliedCount = 0;
      for (const s of out) {
        const doc = parseSlide(s.html);
        if (doc.entries.has(parsedOp.layer)) {
          s.html = applyPatch(doc, parsedOp, patchCtx).html;
          appliedCount++;
        }
      }
      if (appliedCount === 0) {
        throw new Error(`Patch hedef katmanı hiçbir slaytta bulunamadı: "${parsedOp.layer}"`);
      }
    } else if (out[0]) {
      out[0].html = applyPatch(out[0].html, parsedOp, patchCtx).html;
    }
  }

  return out;
}

/**
 * Combine multiple slides into one HTML document for single-pass Chromium `page.pdf(...)`
 * export at exact artboard dimensions (`@page { size: Wpx Hpx; margin: 0; }`, `@scope` per slide).
 */
export function buildCombinedMultiSlidePdfHtml(
  slides: ReadonlyArray<{ html: string; width: number; height: number }>,
): { html: string; width: number; height: number } {
  const first = slides[0];
  if (!first) throw new Error("PDF dışa aktarımı için en az 1 slayt gerekli.");
  const width = first.width;
  const height = first.height;

  const sections = slides.map((s, i) => {
    const styles: string[] = [];
    const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    for (let m = styleRe.exec(s.html); m !== null; m = styleRe.exec(s.html)) {
      if (m[1]) styles.push(m[1]);
    }
    const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(s.html);
    const bodyInner = bodyMatch?.[1] ?? s.html;
    const isLast = i === slides.length - 1;
    const scopedCss = styles.length
      ? `<style>@scope (#__studio_pdf_page_${i}) {\n${styles.join("\n")}\n}</style>`
      : "";
    return `<section id="__studio_pdf_page_${i}" class="__studio_pdf_page" style="width:${s.width}px;height:${s.height}px;position:relative;overflow:hidden;page-break-after:${isLast ? "auto" : "always"};break-after:${isLast ? "auto" : "page"};">
${scopedCss}
${bodyInner}
</section>`;
  });

  const html = `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="/brand/brand.css">
  <style>
    @page { size: ${width}px ${height}px; margin: 0; }
    * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    html, body { margin: 0; padding: 0; width: ${width}px; background: #FFFFFF; }
  </style>
</head>
<body>
${sections.join("\n")}
</body>
</html>`;

  return { html, width, height };
}

async function renderMultiSlideChromiumPdf(input: {
  renderer: RenderCapable;
  slides: ReadonlyArray<{ html: string; width: number; height: number }>;
  renderedJpegs?: ReadonlyArray<{
    jpeg: Uint8Array;
    pixelWidth: number;
    pixelHeight: number;
    cssWidth: number;
    cssHeight: number;
  }>;
  title: string;
  resolver: AssetResolver;
  signal: AbortSignal;
}): Promise<Uint8Array> {
  if (input.renderer instanceof Renderer) {
    const { html, width, height } = buildCombinedMultiSlidePdfHtml(input.slides);
    const browser = await input.renderer.browser();
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      javaScriptEnabled: false,
      colorScheme: "light",
      reducedMotion: "reduce",
      locale: "tr-TR",
      timezoneId: "Europe/Istanbul",
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    const docUrl = "https://studio.invalid/__studio/export-pdf.html";
    try {
      await context.route("**/*", async (route) => {
        const raw = route.request().url();
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          return route.abort("blockedbyclient");
        }
        if (url.origin !== "https://studio.invalid") {
          return route.abort("blockedbyclient");
        }
        if (url.pathname === "/__studio/export-pdf.html") {
          return route.fulfill({
            status: 200,
            body: html,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": STRICT_CSP,
              "cache-control": "no-store",
            },
          });
        }
        const res = url.search ? null : await input.resolver.resolve(url.pathname);
        if (!res) {
          return route.fulfill({ status: 404, body: "not found" });
        }
        return route.fulfill({
          status: 200,
          body: Buffer.from(res.body.buffer, res.body.byteOffset, res.body.byteLength),
          headers: { "content-type": res.contentType, "cache-control": "no-store" },
        });
      });

      const page = await context.newPage();
      await page.goto(docUrl, { waitUntil: "load", timeout: 30_000 });
      await page.evaluate(
        "(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null)))); await document.fonts.ready; })()",
      );
      await page.emulateMedia({ media: "screen" });
      const pdfBuf = await page.pdf({
        width: `${width}px`,
        height: `${height}px`,
        printBackground: true,
        margin: { top: "0px", right: "0px", bottom: "0px", left: "0px" },
        pageRanges: `1-${input.slides.length}`,
      });
      return new Uint8Array(pdfBuf.buffer, pdfBuf.byteOffset, pdfBuf.byteLength);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  // Fallback for fake renderers in unit tests that do not expose a Playwright Browser
  if (input.renderedJpegs && input.renderedJpegs.length === input.slides.length) {
    return buildImagePdf(input.renderedJpegs, { title: input.title });
  }
  const pages = [];
  for (const s of input.slides) {
    const jpeg = await renderSingleSlideJpeg({
      renderer: input.renderer,
      html: s.html,
      width: s.width,
      height: s.height,
      clampInstagramWidth: false,
      resolver: input.resolver,
      signal: input.signal,
    });
    pages.push({
      jpeg: jpeg.jpeg,
      pixelWidth: jpeg.width,
      pixelHeight: jpeg.height,
      cssWidth: s.width,
      cssHeight: s.height,
    });
  }
  return buildImagePdf(pages, { title: input.title });
}

/**
 * Render one slide: PNG + sRGB JPEG and, when the renderer can lint, the measured
 * layer boxes. A renderer whose lint pass fails falls back to a plain render
 * (no layout) instead of failing the job.
 */
async function renderSlideRaster(input: {
  renderer: RenderCapable;
  html: string;
  width: number;
  height: number;
  resolver: AssetResolver;
  signal: AbortSignal;
  formats: ("png" | "jpeg")[];
  /** Brand families that must be installed fonts (reported back when they are not). */
  systemFonts?: readonly string[];
  /** Full lint configuration (the generation checks); replaces `systemFonts`. */
  lint?: RenderAndLintRequest["lint"];
}): Promise<{
  png?: Uint8Array;
  jpeg?: Uint8Array;
  layout: SlideLayout | null;
  /** System font families that are not installed on this Mac. */
  missingFonts: string[];
  /** The lint report of the render (`null` when the renderer could not lint). */
  report: RenderAndLintResult["report"] | null;
}> {
  const request = {
    html: input.html,
    width: input.width,
    height: input.height,
    formats: input.formats,
    jpegQuality: 92,
    resolver: input.resolver,
    signal: input.signal,
  };
  try {
    const res = await input.renderer.renderAndLint(
      input.lint
        ? { ...request, lint: input.lint }
        : input.systemFonts?.length
          ? { ...request, lint: { systemFonts: input.systemFonts } }
          : request,
    );
    return {
      ...(res.png ? { png: res.png } : {}),
      ...(res.jpeg ? { jpeg: res.jpeg } : {}),
      layout: layoutFromReport(res.report),
      missingFonts: missingSystemFonts([res.report]),
      report: res.report ?? null,
    };
  } catch (error) {
    input.signal.throwIfAborted();
    if (typeof input.renderer.render !== "function") throw error;
    const res = await input.renderer.render(request);
    return {
      ...(res.png ? { png: res.png } : {}),
      ...(res.jpeg ? { jpeg: res.jpeg } : {}),
      layout: null,
      missingFonts: [],
      report: null,
    };
  }
}

async function renderSingleSlideJpeg(input: {
  renderer: RenderCapable;
  html: string;
  width: number;
  height: number;
  clampInstagramWidth: boolean;
  resolver: AssetResolver;
  signal: AbortSignal;
  systemFonts?: readonly string[];
  lint?: RenderAndLintRequest["lint"];
}): Promise<{
  jpeg: Uint8Array;
  width: number;
  height: number;
  layout: SlideLayout | null;
  missingFonts: string[];
  report: RenderAndLintResult["report"] | null;
}> {
  const res = await renderSlideRaster({ ...input, formats: ["png", "jpeg"] });
  const pngBytes = res.png;
  const jpegBytes = res.jpeg;
  const sourceBytes = pngBytes ?? jpegBytes;
  if (!sourceBytes) {
    throw new Error("Slayt render çıktısı (PNG/JPEG) alınamadı.");
  }

  const maxWidth = 1440;
  if (input.clampInstagramWidth && input.width > maxWidth) {
    const out = await sharp(sourceBytes)
      .resize({ width: maxWidth, withoutEnlargement: true })
      .toColorspace("srgb")
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true })
      .withIccProfile("srgb")
      .toBuffer({ resolveWithObject: true });
    return {
      jpeg: new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength),
      width: out.info.width,
      height: out.info.height,
      layout: res.layout,
      missingFonts: res.missingFonts,
      report: res.report,
    };
  }

  if (pngBytes) {
    const srgbJpeg = await pngToSrgbJpeg(pngBytes, 92);
    return {
      jpeg: srgbJpeg,
      width: input.width,
      height: input.height,
      layout: res.layout,
      missingFonts: res.missingFonts,
      report: res.report,
    };
  }
  return {
    jpeg: jpegBytes as Uint8Array,
    width: input.width,
    height: input.height,
    layout: res.layout,
    missingFonts: res.missingFonts,
    report: res.report,
  };
}

export interface ExecuteContentRenderOptions {
  deps: ContentRenderDeps;
  jobId?: string;
  brandId?: string;
  contentId: string;
  payload: ContentRenderPayload;
  signal: AbortSignal;
  progress?: (value: number, message: string) => void;
}

export interface ContentRenderOutput extends Record<string, unknown> {
  contentId: string;
  version: number;
  versionId: string;
  renderedAssetIds: (string | null)[];
  /** Slides (0-based) rendered by this job. */
  renderedSlides?: number[];
  /** The edits left every slide unchanged: no new version was stored. */
  unchanged?: boolean;
  pngAssetIds?: (string | null)[];
  pdfAssetId?: string;
  videoAssetId?: string;
  coverAssetId?: string;
  /** System brand fonts that are not installed on this Mac (the fallback was rendered). */
  missingFonts?: string[];
}

/** `/media/<id><ext>` for each slot assignment (extension from the asset's mime type). */
async function slotSources(
  deps: ContentRenderDeps,
  assignments: Record<string, string>,
  signal: AbortSignal,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const assetId of new Set(Object.values(assignments))) {
    let ext = ".jpg";
    try {
      const asset = await deps.api.client.assets.get(assetId, { signal });
      ext = extensionForMime(asset.mimeType) || ext;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ApiError && error.status === 404) {
        throw new Error(`Görsel bulunamadı: ${assetId}`);
      }
    }
    out.set(assetId, mediaSrcFor(assetId, ext));
  }
  return out;
}

export async function executeContentRender(
  options: ExecuteContentRenderOptions,
): Promise<ContentRenderOutput> {
  const { deps, payload, signal } = options;
  const progress = options.progress ?? (() => {});
  const init = { signal };

  progress(0.05, "İçerik ve sürüm okunuyor");
  const content = await deps.api.client.contents.get(options.contentId, init);
  const brandId = options.brandId ?? content.brandId;
  if (content.brandId !== brandId) {
    throw new Error(`İçerik (${options.contentId}) başka bir markaya ait.`);
  }

  const targetVerNum = payload.version ?? content.currentVersion?.version;
  if (!targetVerNum) {
    throw new Error("Bu içeriğin henüz render edilecek bir tasarım sürümü yok.");
  }
  let targetVersion: ContentVersion = await deps.api.client.contents.versions.get(
    content.id,
    targetVerNum,
    init,
  );

  if (content.type === "reel" || payload.format === "mp4") {
    // Reels: re-render the video from its spec (edits in `reel`), never the cover slide.
    if (payload.format === "mp4" || payload.reel !== undefined || payload.force) {
      const reelOut = await renderExistingReelVersion({
        deps,
        renderer: deps.renderer(),
        ...(deps.reelSeams ? { seams: deps.reelSeams } : {}),
        jobId: options.jobId ?? `render-${Date.now()}`,
        brandId,
        content,
        version: targetVersion,
        patch: payload.reel,
        note: payload.note,
        signal,
        progress,
      });
      return reelOut as ContentRenderOutput;
    }
    if (payload.format === "jpeg") {
      // The cover is rendered with the video; nothing to measure on a reel.
      progress(1, "Tamamlandı");
      return {
        contentId: content.id,
        version: targetVersion.version,
        versionId: targetVersion.id,
        contentHash: targetVersion.contentHash,
        renderedAssetIds: targetVersion.slides.map((s) => s.renderedAssetId),
        unchanged: true,
      } as unknown as ContentRenderOutput;
    }
    throw new Error(
      "Reels için PNG/PDF dışa aktarımı yok; videoyu (MP4) ya da kapak görselini dışa aktarın.",
    );
  }

  progress(0.12, "Marka varlıkları hazırlanıyor");
  const brand = await loadBrandContext({
    api: deps.api,
    brandId,
    cacheDir: path.join(deps.stateDir, "cache", "assets"),
    signal,
  });

  const hasSlotAssignments =
    payload.slotAssignments !== undefined && Object.keys(payload.slotAssignments).length > 0;
  const hasPatches = payload.patches !== undefined && payload.patches.length > 0;
  const hasEdits = hasSlotAssignments || hasPatches;

  const baseVersionNumber = targetVersion.version;
  // Renders and layouts carried over to the version that gets rendered.
  let renderedAssetIds: (string | null)[] = targetVersion.slides.map((s) => s.renderedAssetId);
  let layouts: (SlideLayout | null)[] = targetVersion.slides.map((s) => s.layers ?? null);
  let changed: boolean[] = targetVersion.slides.map(() => false);

  if (hasEdits) {
    progress(0.22, "Görsel yuvaları ve katman yamaları uygulanıyor");
    const patchCtx: PatchContext = {
      ...brandPatchContext(brand.tokens),
      assetPrefixes: RENDER_ASSET_PREFIXES,
    };
    const base = targetVersion;
    let workingSlides: SlideInput[] = base.slides.map((s) => ({
      html: s.html,
      width: s.width,
      height: s.height,
    }));

    if (hasSlotAssignments && payload.slotAssignments) {
      const sources = await slotSources(deps, payload.slotAssignments, signal);
      for (const [slotLayerId, assetId] of Object.entries(payload.slotAssignments)) {
        let matchedAny = false;
        workingSlides = workingSlides.map((s) => {
          const res = applySlotAssignmentToSlide(
            s.html,
            slotLayerId,
            assetId,
            patchCtx,
            sources.get(assetId),
          );
          if (res.matched) matchedAny = true;
          return { ...s, html: res.html };
        });
        if (!matchedAny) {
          throw new Error(`Görsel yuvası katmanı hiçbir slaytta bulunamadı: "${slotLayerId}"`);
        }
      }
    }

    if (hasPatches && payload.patches) {
      workingSlides = applyPayloadPatchesToSlides(workingSlides, payload.patches, patchCtx);
    }

    workingSlides = workingSlides.map((s) => ({
      ...s,
      html: sanitizeSlideHtml(s.html, { assetPrefixes: RENDER_ASSET_PREFIXES }).html,
    }));
    changed = workingSlides.map((s, i) => s.html !== base.slides[i]?.html);

    if (!changed.some(Boolean)) {
      progress(1, "Değişiklik yok");
      return {
        contentId: content.id,
        version: base.version,
        versionId: base.id,
        renderedAssetIds,
        renderedSlides: [],
        unchanged: true,
      };
    }

    const noteParts: string[] = [];
    if (payload.note) noteParts.push(payload.note);
    if (hasSlotAssignments && payload.slotAssignments) {
      noteParts.push(
        `Görsel yuvası dolduruldu (${Object.keys(payload.slotAssignments).join(", ")}).`,
      );
    }
    if (hasPatches && payload.patches && !payload.note) {
      noteParts.push(
        `${payload.patches.length} katman yaması uygulandı (v${base.version} üzerine).`,
      );
    }

    // Unchanged slides keep their render and layout; changed ones get new ones below.
    renderedAssetIds = renderedAssetIds.map((id, i) => (changed[i] ? null : id));
    layouts = layouts.map((l, i) => (changed[i] ? null : l));
    targetVersion = await deps.api.client.contents.versions.create(
      content.id,
      {
        origin: "manual_edit",
        slides: workingSlides,
        note: noteParts.join(" ").slice(0, 2000),
        ...(options.jobId ? { jobId: options.jobId } : {}),
        ...(renderedAssetIds.some((id) => id !== null)
          ? { renderedAssetIds: [...renderedAssetIds], layouts: [...layouts] }
          : {}),
      },
      init,
    );
  }

  const resolver = combineResolvers(brand.resolver, createApiAssetPathResolver(deps.api, signal));
  const renderer = deps.renderer();
  const wantsJpeg = payload.format === "jpeg" || payload.format === "both";
  const toRender = targetVersion.slides
    .map((_, i) => i)
    .filter(
      (i) =>
        payload.force === true ||
        changed[i] === true ||
        !renderedAssetIds[i] ||
        (wantsJpeg && layouts[i] === null),
    );

  const renderedJpegPages: {
    jpeg: Uint8Array;
    pixelWidth: number;
    pixelHeight: number;
    cssWidth: number;
    cssHeight: number;
  }[] = [];

  const missingFonts = new Set<string>();
  // Edits are checked afterwards (roadmap 13): their renders lint with the checks' config.
  const checkReports = new Map<number, SlideReport>();
  const lint = hasEdits
    ? checkLintConfig(
        brand,
        presetForVersion(content, targetVersion.slides[0]),
        content.type,
        targetVersion.slides.length,
      )
    : undefined;
  if (toRender.length > 0) {
    progress(0.45, "Slaytlar JPEG olarak render ediliyor");
    const clampInstagram = content.targetPlatforms.includes("instagram");
    const baseSlug = slug(content.title);

    for (const i of toRender) {
      const slide = targetVersion.slides[i];
      if (!slide) continue;
      signal.throwIfAborted();
      const rendered = await renderSingleSlideJpeg({
        renderer,
        html: slide.html,
        width: slide.width,
        height: slide.height,
        clampInstagramWidth: clampInstagram,
        resolver,
        signal,
        systemFonts: brand.manifest.systemFontFamilies,
        ...(lint ? { lint } : {}),
      });
      for (const family of rendered.missingFonts) missingFonts.add(family);
      if (rendered.report) {
        checkReports.set(i, { report: rendered.report, jpegBytes: rendered.jpeg.byteLength });
      }
      renderedJpegPages[i] = {
        jpeg: rendered.jpeg,
        pixelWidth: rendered.width,
        pixelHeight: rendered.height,
        cssWidth: slide.width,
        cssHeight: slide.height,
      };
      const uploaded = await deps.api.client.assets.upload(
        {
          brandId,
          kind: "image",
          source: "generated",
          width: rendered.width,
          height: rendered.height,
          file: new Blob([rendered.jpeg.slice()], { type: "image/jpeg" }),
          filename: `${baseSlug}-v${targetVersion.version}-${i + 1}.jpg`,
        },
        init,
      );
      renderedAssetIds[i] = uploaded.id;
      layouts[i] = rendered.layout;
    }

    targetVersion = await deps.api.client.contents.versions.update(
      content.id,
      targetVersion.version,
      { renderedAssetIds: [...renderedAssetIds], layouts: [...layouts] },
      init,
    );
  }

  let pngAssetIds: (string | null)[] | undefined;
  if (payload.format === "png") {
    progress(0.6, "PNG olarak dışa aktarılıyor");
    const wanted = new Set(payload.slides ?? targetVersion.slides.map((_, i) => i));
    pngAssetIds = [];
    for (const [i, slide] of targetVersion.slides.entries()) {
      if (!wanted.has(i)) {
        pngAssetIds.push(null);
        continue;
      }
      signal.throwIfAborted();
      const res = await renderSlideRaster({
        renderer,
        html: slide.html,
        width: slide.width,
        height: slide.height,
        resolver,
        signal,
        formats: ["png"],
      });
      if (!res.png) throw new Error("Slayt PNG olarak render edilemedi.");
      const uploaded = await deps.api.client.assets.upload(
        {
          brandId,
          kind: "image",
          source: "generated",
          width: slide.width,
          height: slide.height,
          file: new Blob([res.png.slice()], { type: "image/png" }),
          filename: `${slug(content.title)}-v${targetVersion.version}-${i + 1}.png`,
        },
        init,
      );
      pngAssetIds.push(uploaded.id);
    }
  }

  let pdfAssetId: string | undefined;
  if (payload.format === "pdf" || payload.format === "both") {
    progress(0.78, "LinkedIn çok sayfalı PDF dışa aktarılıyor");
    const allPagesRendered =
      targetVersion.slides.length > 0 &&
      targetVersion.slides.every((_, i) => renderedJpegPages[i] !== undefined);
    const pdfBytes = await renderMultiSlideChromiumPdf({
      renderer,
      slides: targetVersion.slides,
      ...(allPagesRendered ? { renderedJpegs: renderedJpegPages } : {}),
      title: content.title,
      resolver,
      signal,
    });
    const firstSlide = targetVersion.slides[0];
    const pdfAsset = await deps.api.client.assets.upload(
      {
        brandId,
        kind: "document",
        source: "generated",
        ...(firstSlide ? { width: firstSlide.width, height: firstSlide.height } : {}),
        file: new Blob([pdfBytes.slice()], { type: "application/pdf" }),
        filename: `${slug(content.title)}-v${targetVersion.version}.pdf`,
      },
      init,
    );
    pdfAssetId = pdfAsset.id;
  }

  if (hasEdits) {
    const refreshed = await deps.api.client.contents.get(content.id, init);
    if (refreshed.status === "draft") {
      await deps.api.client.contents
        .transition(content.id, "in_review", init)
        .catch(() => undefined);
    }
  }

  // Checks of the edited version: deterministic only (no model call per edit); unchanged
  // slides and the language results carry over from the base version's run. Without such a
  // run only a version whose slides were all rendered now is checked (no extra renders).
  let checks: Record<string, unknown> | undefined;
  if (hasEdits && targetVersion.version !== baseVersionNumber) {
    try {
      const previous = (
        await deps.api.client.contents.checks.list(
          content.id,
          { version: baseVersionNumber, limit: 1 },
          init,
        )
      ).items[0];
      const allFresh = targetVersion.slides.every((_, i) => checkReports.has(i));
      if (!previous && !allFresh) throw new SkipChecks();
      progress(0.95, "Kontroller güncelleniyor");
      const res = await runContentChecks({
        deps,
        jobId: options.jobId ?? null,
        trigger: "render",
        contentId: content.id,
        version: targetVersion.version,
        brand,
        reports: checkReports,
        carryOver: previous
          ? {
              run: previous,
              unchangedSlides: new Set(
                changed.flatMap((c, i) => (c || checkReports.has(i) ? [] : [i])),
              ),
            }
          : null,
        lintMissing: false,
        model: false,
        fix: false,
        signal,
      });
      checks = res.brief;
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof SkipChecks)) {
        deps.logger.warn(`checks after render failed: ${(error as Error).message}`);
        checks = failedBrief(targetVersion.version, error);
      }
    }
  }

  progress(1, "Tamamlandı");
  return {
    contentId: content.id,
    version: targetVersion.version,
    versionId: targetVersion.id,
    renderedAssetIds,
    renderedSlides: toRender,
    ...(pngAssetIds ? { pngAssetIds } : {}),
    ...(pdfAssetId ? { pdfAssetId } : {}),
    ...(missingFonts.size > 0 ? { missingFonts: [...missingFonts] } : {}),
    ...(checks ? { checks } : {}),
  };
}

/** The edited version is not checked now (no earlier run to carry unchanged slides from). */
class SkipChecks extends Error {}

export function createContentRenderHandler(deps: ContentRenderDeps) {
  return defineHandler({
    payload: ContentRenderPayload,
    run: async (payload, ctx: JobContext) => {
      const contentId = ctx.job.contentId;
      if (!contentId) {
        throw new Error("content.render işi için contentId gerekli.");
      }
      try {
        return await executeContentRender({
          deps,
          jobId: ctx.jobId,
          ...(ctx.job.brandId ? { brandId: ctx.job.brandId } : {}),
          contentId,
          payload,
          signal: ctx.signal,
          progress: (v, m) => ctx.progress(v, m),
        });
      } catch (error) {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? error;
        if (error instanceof ApiError && (error.status === undefined || error.status >= 500)) {
          throw new RetryableError(error.message);
        }
        throw error;
      }
    },
  });
}
