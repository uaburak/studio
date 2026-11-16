/**
 * `content.render` handler (Faz 2 & Faz 6):
 * - Slot-fill (`slotAssignments[slotLayerId] = assetId` -> `/api/assets/${assetId}/content`),
 * - Typed `@studio/design-kit` layer patching (`patches`),
 * - Creates a new `ContentVersion` and moves `draft` -> `in_review` when edits are applied,
 * - Renders slides to sRGB JPEG (respecting Instagram 1440px max width) and updates `renderedAssetIds`,
 * - Renders single-pass multi-page Chromium vector PDF (`page.pdf`) for LinkedIn carousels (`format: "pdf" | "both"`),
 * - Delegates Reels (`content.type === "reel"` or `format === "mp4"`) to the Reels Video Engine.
 */
import path from "node:path";
import {
  ApiError,
  ContentRenderPayload,
  type ContentVersion,
  type SlideInput,
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
import { loadBrandContext } from "../generate/brand.ts";
import { defineHandler, type JobContext, RetryableError } from "../registry.ts";
import {
  createApiAssetPathResolver,
  type ReelEngineTestSeams,
  renderExistingReelVersion,
} from "../video/render-reel.ts";

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
 * Fill a single slot or image layer across a slide's HTML using `@studio/design-kit`'s
 * `applyPatch`, with a clean fallback for non-contract `<img>` / `[data-slot]` markup.
 */
export function applySlotAssignmentToSlide(
  html: string,
  slotLayerId: string,
  assetId: string,
  patchCtx: PatchContext,
): { html: string; matched: boolean } {
  const src = `/api/assets/${encodeURIComponent(assetId)}/content`;
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
        const parsedOp = PatchOp.parse(opCandidate);
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
    const parsedOp = PatchOp.parse(rest);

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

async function renderSingleSlideJpeg(input: {
  renderer: RenderCapable;
  html: string;
  width: number;
  height: number;
  clampInstagramWidth: boolean;
  resolver: AssetResolver;
  signal: AbortSignal;
}): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  let pngBytes: Uint8Array | undefined;
  let jpegBytes: Uint8Array | undefined;

  if (typeof input.renderer.render === "function") {
    const res = await input.renderer.render({
      html: input.html,
      width: input.width,
      height: input.height,
      formats: ["png", "jpeg"],
      jpegQuality: 92,
      resolver: input.resolver,
      signal: input.signal,
    });
    pngBytes = res.png;
    jpegBytes = res.jpeg;
  } else {
    const res = await input.renderer.renderAndLint({
      html: input.html,
      width: input.width,
      height: input.height,
      formats: ["png", "jpeg"],
      jpegQuality: 92,
      resolver: input.resolver,
      signal: input.signal,
    });
    pngBytes = res.png;
    jpegBytes = res.jpeg;
  }

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
    };
  }

  if (pngBytes) {
    const srgbJpeg = await pngToSrgbJpeg(pngBytes, 92);
    return { jpeg: srgbJpeg, width: input.width, height: input.height };
  }
  return { jpeg: jpegBytes as Uint8Array, width: input.width, height: input.height };
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
  pdfAssetId?: string;
  videoAssetId?: string;
  coverAssetId?: string;
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
    const reelOut = await renderExistingReelVersion({
      deps,
      renderer: deps.renderer(),
      ...(deps.reelSeams ? { seams: deps.reelSeams } : {}),
      jobId: options.jobId ?? `render-${Date.now()}`,
      brandId,
      content,
      version: targetVersion,
      signal,
      progress,
    });
    return reelOut as ContentRenderOutput;
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

  if (hasSlotAssignments || hasPatches) {
    progress(0.22, "Görsel yuvaları ve katman yamaları uygulanıyor");
    const patchCtx: PatchContext = {
      ...brandPatchContext(brand.tokens),
      assetPrefixes: RENDER_ASSET_PREFIXES,
    };

    let workingSlides: SlideInput[] = targetVersion.slides.map((s) => ({
      html: s.html,
      width: s.width,
      height: s.height,
    }));

    if (hasSlotAssignments && payload.slotAssignments) {
      for (const [slotLayerId, assetId] of Object.entries(payload.slotAssignments)) {
        let matchedAny = false;
        workingSlides = workingSlides.map((s) => {
          const res = applySlotAssignmentToSlide(s.html, slotLayerId, assetId, patchCtx);
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

    const noteParts: string[] = [];
    if (hasSlotAssignments && payload.slotAssignments) {
      noteParts.push(
        `Görsel yuvası dolduruldu (${Object.keys(payload.slotAssignments).join(", ")}).`,
      );
    }
    if (hasPatches && payload.patches) {
      noteParts.push(`${payload.patches.length} katman yaması uygulandı.`);
    }

    targetVersion = await deps.api.client.contents.versions.create(
      content.id,
      {
        origin: "manual_edit",
        slides: workingSlides,
        note: noteParts.join(" ").slice(0, 2000),
        ...(options.jobId ? { jobId: options.jobId } : {}),
      },
      init,
    );
  }

  const resolver = combineResolvers(brand.resolver, createApiAssetPathResolver(deps.api, signal));
  const renderer = deps.renderer();
  const shouldRenderJpeg =
    payload.format === "jpeg" ||
    payload.format === "both" ||
    hasSlotAssignments ||
    hasPatches ||
    targetVersion.slides.some((s) => !s.renderedAssetId);

  let renderedAssetIds: (string | null)[] = targetVersion.slides.map((s) => s.renderedAssetId);
  const renderedJpegPages: {
    jpeg: Uint8Array;
    pixelWidth: number;
    pixelHeight: number;
    cssWidth: number;
    cssHeight: number;
  }[] = [];

  if (shouldRenderJpeg) {
    progress(0.45, "Slaytlar JPEG olarak render ediliyor");
    const clampInstagram = content.targetPlatforms.includes("instagram");
    const freshIds: string[] = [];
    const baseSlug = slug(content.title);

    for (const [i, slide] of targetVersion.slides.entries()) {
      signal.throwIfAborted();
      const rendered = await renderSingleSlideJpeg({
        renderer,
        html: slide.html,
        width: slide.width,
        height: slide.height,
        clampInstagramWidth: clampInstagram,
        resolver,
        signal,
      });
      renderedJpegPages.push({
        jpeg: rendered.jpeg,
        pixelWidth: rendered.width,
        pixelHeight: rendered.height,
        cssWidth: slide.width,
        cssHeight: slide.height,
      });
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
      freshIds.push(uploaded.id);
    }

    renderedAssetIds = freshIds;
    targetVersion = await deps.api.client.contents.versions.update(
      content.id,
      targetVersion.version,
      { renderedAssetIds: freshIds },
      init,
    );
  }

  let pdfAssetId: string | undefined;
  if (payload.format === "pdf" || payload.format === "both") {
    progress(0.78, "LinkedIn çok sayfalı PDF dışa aktarılıyor");
    const pdfBytes = await renderMultiSlideChromiumPdf({
      renderer,
      slides: targetVersion.slides,
      ...(renderedJpegPages.length === targetVersion.slides.length
        ? { renderedJpegs: renderedJpegPages }
        : {}),
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

  if (hasSlotAssignments || hasPatches) {
    const refreshed = await deps.api.client.contents.get(content.id, init);
    if (refreshed.status === "draft") {
      await deps.api.client.contents
        .transition(content.id, "in_review", init)
        .catch(() => undefined);
    }
  }

  progress(1, "Tamamlandı");
  return {
    contentId: content.id,
    version: targetVersion.version,
    versionId: targetVersion.id,
    renderedAssetIds,
    ...(pdfAssetId ? { pdfAssetId } : {}),
  };
}

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
