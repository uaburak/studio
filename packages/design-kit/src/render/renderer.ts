/**
 * Chromium renderer (Node only). One browser is reused; every render gets a fresh context:
 * JavaScript off, every request blocked except the virtual origin, whose `/brand/` and
 * `/media/` paths are served by an `AssetResolver`. DNS is disabled at the browser level
 * as a second fence. The page waits for fonts and images before any pixel is captured.
 */
import { type Browser, type BrowserContext, chromium, type Page } from "playwright-core";
import {
  HIDE_TEXT_CSS,
  type InPageInput,
  type InPageResult,
  inPageLintInvocation,
} from "../lint/inpage.ts";
import type { Raster } from "../lint/raster.ts";
import type { LintConfig, LintReport } from "../lint/report.ts";
import { type LintPage, lintSlide, type NetworkLog } from "../lint/run.ts";
import { STRICT_CSP } from "../sanitize/preview.ts";
import { decodePng, pngToSrgbJpeg } from "./images.ts";
import { buildImagePdf } from "./pdf.ts";
import type { AssetResolver } from "./resolver.ts";

/** Virtual origin the design is loaded from. `.invalid` can never resolve (RFC 2606). */
export const VIRTUAL_ORIGIN = "https://studio.invalid";
const DOC_PATH = "/__studio/slide.html";

export const CHROMIUM_ARGS = [
  "--force-color-profile=srgb",
  "--font-render-hinting=none",
  "--disable-lcd-text",
  "--hide-scrollbars",
  "--host-resolver-rules=MAP * ~NOTFOUND",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-domain-reliability",
  "--no-pings",
];

export type ImageFormat = "png" | "jpeg";

export interface RendererOptions {
  /** Serves `/brand/…` and `/media/…` (overridable per render). */
  resolver?: AssetResolver;
  /** Chromium binary; default: the one Playwright installed. */
  executablePath?: string;
  /** Extra Chromium flags. */
  args?: readonly string[];
  /** Per-render timeout (ms), default 30 000. */
  timeoutMs?: number;
  /** Max wait for fonts and images (ms), default 10 000. */
  assetTimeoutMs?: number;
  /** Policy sent with the document (default `STRICT_CSP`). */
  csp?: string;
}

export interface RenderRequest {
  html: string;
  /** Artboard size in CSS px. */
  width: number;
  height: number;
  /** 2 for 2x output. Default 1. */
  deviceScaleFactor?: number;
  /** Default `["png", "jpeg"]`. */
  formats?: readonly ImageFormat[];
  jpegQuality?: number;
  resolver?: AssetResolver;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RenderTimings {
  contextMs: number;
  loadMs: number;
  assetsMs: number;
  screenshotMs: number;
  encodeMs: number;
  lintMs?: number;
  totalMs: number;
}

export interface RenderResult {
  png?: Uint8Array;
  jpeg?: Uint8Array;
  /** Pixel size of the images. */
  pixelWidth: number;
  pixelHeight: number;
  deviceScaleFactor: number;
  network: NetworkLog;
  /** Virtual-origin paths that were served. */
  served: string[];
  timings: RenderTimings;
}

export interface RenderAndLintRequest extends RenderRequest {
  /** Lint configuration without the size (taken from the request). */
  lint?: Omit<LintConfig, "width" | "height">;
}

export interface RenderAndLintResult extends RenderResult {
  report: LintReport;
}

export interface RenderAndInspectRequest extends RenderRequest {
  /** An expression evaluated in the laid-out page (the design's own JavaScript stays off). */
  inspect: string;
  /**
   * CSS added for a second capture at CSS scale (e.g. text made transparent, for contrast
   * against the rendered background); omitted: no second capture.
   */
  rasterCss?: string;
}

export interface RenderAndInspectResult<T> extends RenderResult {
  inspected: T;
  /** The capture with `rasterCss` applied. */
  raster?: Raster;
}

export interface PdfRequest {
  slides: readonly { html: string; width: number; height: number }[];
  /** Raster scale of the page images (default 2). */
  deviceScaleFactor?: number;
  jpegQuality?: number;
  title?: string;
  resolver?: AssetResolver;
  timeoutMs?: number;
}

export class RenderError extends Error {
  readonly code: "timeout" | "aborted" | "no_resolver" | "browser" | "invalid_request";
  constructor(code: RenderError["code"], message: string) {
    super(message);
    this.name = "RenderError";
    this.code = code;
  }
}

interface Session {
  page: Page;
  network: { blocked: string[]; missing: string[] };
  served: string[];
  timings: Omit<RenderTimings, "screenshotMs" | "encodeMs" | "totalMs">;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      p.catch(() => undefined);
      reject(new RenderError("aborted", `${what} was aborted`));
      return;
    }
    const timer = setTimeout(
      () => reject(new RenderError("timeout", `${what} timed out after ${ms}ms`)),
      ms,
    );
    const onAbort = () => reject(new RenderError("aborted", `${what} was aborted`));
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** A LintPage backed by a Playwright page (exported for workers that drive pages themselves). */
export function playwrightLintPage(page: Page, size: { width: number; height: number }): LintPage {
  return {
    runInPage: (input: InPageInput) =>
      page.evaluate(inPageLintInvocation(input)) as Promise<InPageResult>,
    captureTextFreeRaster: async () => {
      await page.evaluate(
        `(() => { const s = document.createElement("style"); s.id = "__studio_hide_text"; s.textContent = ${JSON.stringify(HIDE_TEXT_CSS)}; document.head.appendChild(s); })()`,
      );
      try {
        const png = await page.screenshot({
          type: "png",
          clip: { x: 0, y: 0, width: size.width, height: size.height },
          scale: "css",
          animations: "disabled",
          caret: "hide",
        });
        return await decodePng(new Uint8Array(png));
      } finally {
        await page.evaluate(
          `(() => { document.getElementById("__studio_hide_text")?.remove(); })()`,
        );
      }
    },
  };
}

export class Renderer {
  readonly #options: RendererOptions;
  #browser: Promise<Browser> | null = null;

  constructor(options: RendererOptions = {}) {
    this.#options = options;
  }

  /** The shared browser (launched on first use, relaunched after a crash). */
  async browser(): Promise<Browser> {
    if (!this.#browser) {
      const launching = chromium
        .launch({
          headless: true,
          ...(this.#options.executablePath ? { executablePath: this.#options.executablePath } : {}),
          args: [...CHROMIUM_ARGS, ...(this.#options.args ?? [])],
        })
        .then((b) => {
          b.on("disconnected", () => {
            if (this.#browser === launching) this.#browser = null;
          });
          return b;
        });
      launching.catch(() => {
        if (this.#browser === launching) this.#browser = null;
      });
      this.#browser = launching;
    }
    try {
      return await this.#browser;
    } catch (e) {
      throw new RenderError("browser", `could not launch Chromium: ${(e as Error).message}`);
    }
  }

  async close(): Promise<void> {
    const b = this.#browser;
    this.#browser = null;
    if (b) await (await b.catch(() => null))?.close();
  }

  async #session<T>(req: RenderRequest, fn: (s: Session) => Promise<T>): Promise<T> {
    const resolver = req.resolver ?? this.#options.resolver;
    if (!resolver)
      throw new RenderError(
        "no_resolver",
        "no asset resolver: pass `resolver` to the renderer or the request",
      );
    if (!(req.width > 0 && req.height > 0 && req.width <= 4096 && req.height <= 4096))
      throw new RenderError("invalid_request", `bad artboard size ${req.width}x${req.height}`);
    const dsf = req.deviceScaleFactor ?? 1;
    if (!(dsf > 0 && dsf <= 4))
      throw new RenderError("invalid_request", `bad deviceScaleFactor ${dsf}`);
    const timeout = req.timeoutMs ?? this.#options.timeoutMs ?? 30_000;
    const assetTimeout = this.#options.assetTimeoutMs ?? 10_000;
    const csp = this.#options.csp ?? STRICT_CSP;
    const browser = await this.browser();
    let context: BrowserContext | null = null;
    const run = async (): Promise<T> => {
      const t0 = Date.now();
      context = await browser.newContext({
        viewport: { width: req.width, height: req.height },
        deviceScaleFactor: dsf,
        javaScriptEnabled: false,
        colorScheme: "light",
        reducedMotion: "reduce",
        locale: "tr-TR",
        timezoneId: "Europe/Istanbul",
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      context.setDefaultTimeout(timeout);
      const network = { blocked: [] as string[], missing: [] as string[] };
      const served: string[] = [];
      await context.route("**/*", async (route) => {
        const raw = route.request().url();
        let url: URL;
        try {
          url = new URL(raw);
        } catch {
          network.blocked.push(raw);
          return route.abort("blockedbyclient");
        }
        if (url.origin !== VIRTUAL_ORIGIN) {
          network.blocked.push(raw);
          return route.abort("blockedbyclient");
        }
        if (url.pathname === DOC_PATH)
          return route.fulfill({
            status: 200,
            body: req.html,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "content-security-policy": csp,
              "cache-control": "no-store",
            },
          });
        const res = url.search ? null : await resolver.resolve(url.pathname);
        if (!res) {
          network.missing.push(url.pathname + url.search);
          return route.fulfill({
            status: 404,
            body: "not found",
            headers: { "content-type": "text/plain" },
          });
        }
        served.push(url.pathname);
        return route.fulfill({
          status: 200,
          body: Buffer.from(res.body.buffer, res.body.byteOffset, res.body.byteLength),
          headers: { "content-type": res.contentType, "cache-control": "no-store" },
        });
      });
      const page = await context.newPage();
      // Loads the CSP refuses never reach the route; record them as blocked too.
      page.on("requestfailed", (r) => {
        if (/csp/i.test(r.failure()?.errorText ?? "")) network.blocked.push(r.url());
      });
      const t1 = Date.now();
      await page.goto(VIRTUAL_ORIGIN + DOC_PATH, { waitUntil: "load", timeout });
      const t2 = Date.now();
      await withTimeout(
        page.evaluate(
          "(async () => { await document.fonts.ready; await Promise.all(Array.from(document.images).map((img) => (img.complete ? null : img.decode().catch(() => null)))); await document.fonts.ready; return document.fonts.status; })()",
        ),
        assetTimeout,
        "waiting for fonts and images",
      );
      const t3 = Date.now();
      return fn({
        page,
        network,
        served,
        timings: { contextMs: t1 - t0, loadMs: t2 - t1, assetsMs: t3 - t2 },
      });
    };
    try {
      return await withTimeout(run(), timeout, "render", req.signal);
    } finally {
      const ctx = context as BrowserContext | null;
      if (ctx) await ctx.close().catch(() => undefined);
    }
  }

  async #capture(
    s: Session,
    req: RenderRequest,
  ): Promise<
    Omit<RenderResult, "network" | "served" | "timings"> & {
      screenshotMs: number;
      encodeMs: number;
    }
  > {
    const formats = req.formats ?? ["png", "jpeg"];
    const dsf = req.deviceScaleFactor ?? 1;
    const t0 = Date.now();
    const png = new Uint8Array(
      await s.page.screenshot({
        type: "png",
        clip: { x: 0, y: 0, width: req.width, height: req.height },
        scale: "device",
        animations: "disabled",
        caret: "hide",
      }),
    );
    const t1 = Date.now();
    const jpeg = formats.includes("jpeg")
      ? await pngToSrgbJpeg(png, req.jpegQuality ?? 92)
      : undefined;
    const t2 = Date.now();
    return {
      ...(formats.includes("png") ? { png } : {}),
      ...(jpeg ? { jpeg } : {}),
      pixelWidth: Math.round(req.width * dsf),
      pixelHeight: Math.round(req.height * dsf),
      deviceScaleFactor: dsf,
      screenshotMs: t1 - t0,
      encodeMs: t2 - t1,
    };
  }

  /** Render one slide to PNG and/or sRGB JPEG. */
  async render(req: RenderRequest): Promise<RenderResult> {
    const t0 = Date.now();
    return this.#session(req, async (s) => {
      const { screenshotMs, encodeMs, ...img } = await this.#capture(s, req);
      return {
        ...img,
        network: s.network,
        served: s.served,
        timings: { ...s.timings, screenshotMs, encodeMs, totalMs: Date.now() - t0 },
      };
    });
  }

  /** Render and lint in one page load: images, the lint report (all stages) and timings. */
  async renderAndLint(req: RenderAndLintRequest): Promise<RenderAndLintResult> {
    const t0 = Date.now();
    return this.#session(req, async (s) => {
      const { screenshotMs, encodeMs, ...img } = await this.#capture(s, req);
      const t1 = Date.now();
      const report = await lintSlide(req.html, {
        ...req.lint,
        width: req.width,
        height: req.height,
        page: playwrightLintPage(s.page, req),
        network: s.network,
      });
      const lintMs = Date.now() - t1;
      return {
        ...img,
        report,
        network: s.network,
        served: s.served,
        timings: { ...s.timings, screenshotMs, encodeMs, lintMs, totalMs: Date.now() - t0 },
      };
    });
  }

  /**
   * Render and inspect in one page load: the images, the value of `inspect` evaluated in the
   * page (geometry a caller measures itself, e.g. an SVG design's text boxes) and, with
   * `rasterCss`, a second capture with that CSS applied.
   */
  async renderAndInspect<T>(req: RenderAndInspectRequest): Promise<RenderAndInspectResult<T>> {
    const t0 = Date.now();
    return this.#session(req, async (s) => {
      const { screenshotMs, encodeMs, ...img } = await this.#capture(s, req);
      const inspected = (await s.page.evaluate(req.inspect)) as T;
      let raster: Raster | undefined;
      if (req.rasterCss !== undefined) {
        await s.page.evaluate(
          `(() => { const s = document.createElement("style"); s.textContent = ${JSON.stringify(req.rasterCss)}; document.head.appendChild(s); })()`,
        );
        const png = await s.page.screenshot({
          type: "png",
          clip: { x: 0, y: 0, width: req.width, height: req.height },
          scale: "css",
          animations: "disabled",
          caret: "hide",
        });
        raster = await decodePng(new Uint8Array(png));
      }
      return {
        ...img,
        inspected,
        ...(raster ? { raster } : {}),
        network: s.network,
        served: s.served,
        timings: { ...s.timings, screenshotMs, encodeMs, totalMs: Date.now() - t0 },
      };
    });
  }

  /** Multi-page PDF (one JPEG page per slide), e.g. for LinkedIn document posts. */
  async renderPdf(
    req: PdfRequest,
  ): Promise<{ pdf: Uint8Array; pages: number; network: NetworkLog[]; totalMs: number }> {
    const t0 = Date.now();
    const dsf = req.deviceScaleFactor ?? 2;
    const pages = [];
    const network: NetworkLog[] = [];
    for (const slide of req.slides) {
      const r = await this.render({
        html: slide.html,
        width: slide.width,
        height: slide.height,
        deviceScaleFactor: dsf,
        formats: ["jpeg"],
        jpegQuality: req.jpegQuality ?? 90,
        ...(req.resolver ? { resolver: req.resolver } : {}),
        ...(req.timeoutMs ? { timeoutMs: req.timeoutMs } : {}),
      });
      network.push(r.network);
      pages.push({
        jpeg: r.jpeg as Uint8Array,
        pixelWidth: r.pixelWidth,
        pixelHeight: r.pixelHeight,
        cssWidth: slide.width,
        cssHeight: slide.height,
      });
    }
    const pdf = buildImagePdf(pages, req.title ? { title: req.title } : {});
    return { pdf, pages: pages.length, network, totalMs: Date.now() - t0 };
  }
}

export function createRenderer(options: RendererOptions = {}): Renderer {
  return new Renderer(options);
}

/** Can Chromium be launched here? (Tests skip the renderer suite when not.) */
export async function isChromiumAvailable(executablePath?: string): Promise<boolean> {
  try {
    const b = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    await b.close();
    return true;
  } catch {
    return false;
  }
}
