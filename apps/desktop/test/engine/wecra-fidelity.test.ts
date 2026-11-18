// Import fidelity (E11), golden: a post's HTML slide rendered by Chromium (the worker's renderer)
// against the same slide after the canvas's import, in Wecra's real engine.
//
// Each slide is laid out in Chromium and read there exactly as the canvas reads it — Wecra's walker
// and Studio's `captureInWindow` (their sources, evaluated in the page) — then `slideFromCapture`
// (Wecra's converter + fidelity.ts) and `importSlides` make the Wecra layers headless (jsdom, no
// GPU). Checked:
//
//   - on the document: every contract layer's box against Chromium's (the transformed bounding
//     box), gradients' kinds, rotation, scale, stacking, blend mode, clip-path shapes, text shadows,
//     balanced lines, Turkish capitals, what the import report says;
//   - pictures' crop windows against Chromium's own pixels (the image paint's window sampled from
//     the source file vs the screenshot) — the engine can't draw pictures headless;
//   - pixel for pixel where the engine can draw headless: a slide without text or pictures
//     (fidelity-shapes.html) exported by Wecra's engine as SVG and drawn by Chromium, against
//     Chromium's render of the HTML;
//   - the design-kit's fixture slides: every non-text layer's box where Chromium has it.
//
// Skipped when Chromium (Playwright's) isn't installed.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import { generateBrandCss, parseBrandTokens } from "@studio/design-kit/brand";
import { canvasLayers } from "@studio/design-kit/canvas";
import { decodePng } from "@studio/design-kit/render";
import { afterAll, describe, expect, it } from "vitest";
import { EditorController } from "@/editor/controller";
import { memoryDocumentSource } from "@/editor/documentSource";
import { EMPTY_DOCUMENT } from "@/editor/fixtures";
import { Engine } from "@/engine/Engine";
import { EngineStore } from "@/engine/EngineStore";
import { BundleImages } from "../../src/renderer/features/post-editor/wecra/bundle.ts";
import {
  type CaptureResult,
  captureInWindow,
} from "../../src/renderer/features/post-editor/wecra/capture.ts";
import { canvasFacts } from "../../src/renderer/features/post-editor/wecra/facts.ts";
import type { ImportChange } from "../../src/renderer/features/post-editor/wecra/fidelity.ts";
import {
  finishSlide,
  importSlides,
  layerMarks,
  loadPictures,
  slideFromCapture,
  vectorLogos,
} from "../../src/renderer/features/post-editor/wecra/import.ts";
import { markOf } from "../../src/renderer/features/post-editor/wecra/slots.ts";
import { installWalker } from "../../src/renderer/vendor/wecra-editor/studio/walker.mjs";

const DK = resolve(import.meta.dirname, "../../../../packages/design-kit");
const VENTA = join(DK, "test/fixtures/venta");
const SLIDES = join(DK, "test/fixtures/slides");
const OWN = join(import.meta.dirname, "fixtures");
const SIZE = { width: 1080, height: 1350 };
const ORIGIN = "https://studio.invalid";

// Playwright's Chromium, as the worker's renderer uses it (design-kit's dependency).
interface Page {
  route(url: string, handler: (route: Route) => Promise<void>): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  screenshot(options: {
    type: "png";
    clip?: { x: number; y: number; width: number; height: number };
  }): Promise<Uint8Array>;
  setContent(html: string): Promise<void>;
  close(): Promise<void>;
}
interface Route {
  request(): { url(): string };
  fulfill(r: { status?: number; contentType?: string; body: string | Uint8Array }): Promise<void>;
}
interface Browser {
  newPage(o: {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  }): Promise<Page>;
  close(): Promise<void>;
}
const { chromium } = createRequire(join(DK, "package.json"))("playwright-core") as {
  chromium: { launch(o: { headless: boolean; args?: string[] }): Promise<Browser> };
};

let browser: Browser | null = null;
try {
  browser = await chromium.launch({
    headless: true,
    args: ["--force-color-profile=srgb", "--font-render-hinting=none", "--disable-lcd-text"],
  });
} catch {
  browser = null;
}
afterAll(async () => {
  await browser?.close();
});

const tokens = parseBrandTokens(JSON.parse(readFileSync(join(VENTA, "brand.json"), "utf8")));
const BRAND_CSS = generateBrandCss(tokens, { fontUrl: (f) => `/brand/${f.path}` }).css;
const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".css": "text/css",
};

/** A /brand/ file: the Venta fixture's, or this test's (an SVG logo). */
const fixtureFile = (path: string) =>
  path === "/brand/logos/studio-logo.svg"
    ? join(OWN, "studio-logo.svg")
    : join(VENTA, decodeURIComponent(path.slice("/brand/".length)));

/** A slide's page in Chromium, its /brand/ files served from the Venta fixture. */
async function open(html: string): Promise<Page> {
  if (!browser) throw new Error("no Chromium");
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/slide.html")
      return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/brand/brand.css")
      return route.fulfill({ contentType: "text/css", body: BRAND_CSS });
    if (url.pathname.startsWith("/brand/")) {
      const file = fixtureFile(url.pathname);
      try {
        return route.fulfill({
          contentType: TYPES[extname(file)] ?? "application/octet-stream",
          body: readFileSync(file),
        });
      } catch {
        return route.fulfill({ status: 404, body: "" });
      }
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${ORIGIN}/slide.html`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images, (i) => i.decode().catch(() => {})));
  }, null);
  return page;
}

interface OracleLayer {
  id: string;
  type: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  lines: number;
}

/** Chromium's own reading of the contract layers (before the capture touches the page). */
function oracle(page: Page): Promise<OracleLayer[]> {
  return page.evaluate(() => {
    const art = (
      document.querySelector("[data-artboard]") ?? document.body
    ).getBoundingClientRect();
    return Array.from(document.querySelectorAll("[data-layer]")).map((el) => {
      const r = el.getBoundingClientRect();
      // The lines of its text (distinct line tops of its glyphs).
      const tops = new Set<number>();
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const rect of Array.from(range.getClientRects()))
          if (rect.width > 0) tops.add(Math.round(rect.top / 4));
      }
      return {
        id: el.getAttribute("data-layer") ?? "",
        type: el.getAttribute("data-type"),
        x: r.left - art.left,
        y: r.top - art.top,
        w: r.width,
        h: r.height,
        lines: tops.size,
      };
    });
  }, null);
}

/** The canvas's capture of the page: Wecra's walker and Studio's extras, run in Chromium. */
function capture(page: Page): Promise<CaptureResult> {
  return page.evaluate(
    async ([walkerSrc, captureSrc]) => {
      // esbuild's name helper, should the sources carry it.
      (globalThis as { __name?: unknown }).__name = (f: unknown) => f;
      const install = new Function(`return (${walkerSrc})`)();
      const read = new Function(`return (${captureSrc})`)();
      return read(window, install, document.querySelector("[data-artboard]") ?? document.body);
    },
    [installWalker.toString(), captureInWindow.toString()] as const,
  );
}

const pngSize = (b: Uint8Array) => ({
  width: (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19],
  height: (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23],
});

type WNodeRead = {
  guid: string;
  name?: string;
  type?: string;
  transform?: { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
  size?: { x: number; y: number };
  parentIndex?: { guid?: string };
  childIds?: string[];
  fillPaints?: { type?: string; imageScaleMode?: string; transform?: Record<string, number> }[];
  effects?: { type?: string; radius?: number; offset?: { x: number; y: number } }[];
  pluginData?: { pluginID?: string; key?: string; value?: string }[];
  blendMode?: string;
  textData?: { characters?: string };
};

/** A slide imported onto a headless canvas (its pictures' bytes from the fixture). */
async function importOnCanvas(html: string, captured: CaptureResult) {
  const images = new BundleImages();
  const source = memoryDocumentSource(structuredClone(EMPTY_DOCUMENT), { sessionID: 7, images });
  const engine = await Engine.create(null, { sessionID: 7 });
  expect(engine.load(await source.load())).toBe(0);
  const ed = new EditorController(engine, new EngineStore(engine), source);
  const { spec, fonts, pictures, report } = slideFromCapture(captured, 0);
  // The pictures read as the import reads them (an SVG: its vectors), from the fixture's files.
  const missing = await loadPictures(pictures, undefined, async (url) => {
    const path = new URL(url, ORIGIN).pathname;
    const bytes = readFileSync(fixtureFile(path));
    return new Response(bytes, { headers: { "content-type": TYPES[extname(path)] ?? "" } });
  });
  const frames = await importSlides(
    ed,
    [
      {
        index: 0,
        ...SIZE,
        spec: finishSlide(spec, 0, SIZE),
        fonts,
        missing,
        marks: vectorLogos(layerMarks(html), pictures),
        pictures,
        report,
      },
    ],
    { importImage: async (bytes) => ({ hash: await images.put(bytes), ...pngSize(bytes) }) },
  );
  const frame = frames[0]?.ref as string;
  const nodes = engine.readNodes([frame], {
    subtree: true,
    childIds: true,
    fields: [
      "name",
      "type",
      "transform",
      "size",
      "parentIndex",
      "fillPaints",
      "effects",
      "pluginData",
      "blendMode",
      "textData",
    ],
  }) as unknown as WNodeRead[];
  const byId = new Map(nodes.map((n) => [n.guid, n]));
  /** A layer's box on the slide (axis-aligned, after its own and its parents' transforms). */
  const box = (n: WNodeRead) => {
    const chain: WNodeRead[] = [];
    for (
      let cur: WNodeRead | undefined = n;
      cur && cur.guid !== frame;
      cur = byId.get(cur.parentIndex?.guid ?? "")
    )
      chain.unshift(cur);
    let m = [1, 0, 0, 1, 0, 0];
    for (const c of chain) {
      const t = c.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
      const [a, b, cc, d, e, f] = m as [number, number, number, number, number, number];
      m = [
        a * t.m00 + cc * t.m10,
        b * t.m00 + d * t.m10,
        a * t.m01 + cc * t.m11,
        b * t.m01 + d * t.m11,
        a * t.m02 + cc * t.m12 + e,
        b * t.m02 + d * t.m12 + f,
      ];
    }
    const w = n.size?.x ?? 0;
    const h = n.size?.y ?? 0;
    const pts = [
      [0, 0],
      [w, 0],
      [0, h],
      [w, h],
    ].map(([x = 0, y = 0]) => {
      const [a = 1, b = 0, cc = 0, d = 1, e = 0, f = 0] = m;
      return [a * x + cc * y + e, b * x + d * y + f];
    });
    const xs = pts.map((p) => p[0] as number);
    const ys = pts.map((p) => p[1] as number);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  };
  const layer = (id: string) =>
    nodes.find((n) => markOf(n)?.layer === id && n.type !== "TEXT") ??
    nodes.find((n) => markOf(n)?.layer === id);
  const order = nodes.map((n) => n.guid);
  return { ed, engine, frame, nodes, byId, box, layer, report, order };
}

const losses = (report: ImportChange[]) => report.map((r) => `${r.layer}: ${r.what}`);

describe.skipIf(!browser)("import fidelity: Chromium vs the canvas (golden)", () => {
  it("puts gradients, transforms, stacking, clip paths and blend modes on the layers", async () => {
    const html = readFileSync(join(OWN, "fidelity-shapes.html"), "utf8");
    const page = await open(html);
    const truth = await oracle(page);
    const topAt = await page.evaluate(
      () =>
        document.elementFromPoint(300, 1150)?.closest("[data-layer]")?.getAttribute("data-layer") ??
        null,
      null,
    );
    const shot = await page.screenshot({ type: "png", clip: { x: 0, y: 0, ...SIZE } });
    const captured = await capture(page);
    await page.close();
    const c = await importOnCanvas(html, captured);
    // Nothing reported: every case here is one Wecra's document holds.
    expect(losses(c.report)).toEqual([]);
    for (const t of truth) {
      const n = c.layer(t.id);
      expect(n, t.id).toBeTruthy();
      const b = c.box(n as WNodeRead);
      for (const k of ["x", "y", "w", "h"] as const)
        expect(Math.abs(b[k] - t[k]), `${t.id}.${k}`).toBeLessThan(1.5);
    }
    const kinds = (id: string) => (c.layer(id)?.fillPaints ?? []).map((p) => p.type);
    expect(kinds("radial")).toEqual(["GRADIENT_RADIAL"]);
    expect(kinds("corner")).toEqual(["GRADIENT_LINEAR"]);
    expect(kinds("ellipse")).toEqual(["SOLID", "GRADIENT_RADIAL"]);
    expect(kinds("conic")).toEqual(["GRADIENT_ANGULAR"]);
    expect(kinds("scrim")).toEqual(["GRADIENT_LINEAR"]);
    const rot = c.layer("rotated")?.transform;
    expect(Math.round((Math.atan2(rot?.m10 ?? 0, rot?.m00 ?? 1) * 180) / Math.PI)).toBe(18);
    expect(c.layer("scaled")?.size).toEqual({ x: 280, y: 168 });
    // z-index: "under" (z 3) is painted over "over" (z 1), as Chromium does.
    expect(topAt).toBe("under");
    const under = c.order.indexOf(c.layer("under")?.guid as string);
    const over = c.order.indexOf(c.layer("over")?.guid as string);
    expect(under).toBeGreaterThan(over);
    expect(c.layer("multiply")?.blendMode).toBe("MULTIPLY");
    const hex = c.layer("hex") as WNodeRead;
    expect((hex.childIds ?? []).map((id) => c.byId.get(id)?.type)).toContain("VECTOR");

    // Pixel for pixel: Wecra's own SVG of the canvas document, drawn by Chromium.
    const out = c.engine.exportNodes(
      [c.frame],
      {
        imageType: "SVG",
        constraint: { type: "CONTENT_SCALE", value: 1 },
        useAbsoluteBounds: true,
        colorProfile: "SRGB",
      },
      { allowPending: true },
    );
    expect(out.status).toBe("ok");
    const svg = new TextDecoder().decode((out as unknown as { bytes: Uint8Array }).bytes);
    const svgPage = await (browser as Browser).newPage({ viewport: SIZE, deviceScaleFactor: 1 });
    await svgPage.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
    const drawn = await svgPage.screenshot({ type: "png", clip: { x: 0, y: 0, ...SIZE } });
    await svgPage.close();
    const a = await decodePng(new Uint8Array(shot));
    const b = await decodePng(new Uint8Array(drawn));
    expect([b.width, b.height]).toEqual([a.width, a.height]);
    let sum = 0;
    let far = 0;
    const pixels = a.width * a.height;
    for (let i = 0; i < pixels; i++) {
      let d = 0;
      for (let ch = 0; ch < 3; ch++)
        d = Math.max(
          d,
          Math.abs((a.data[i * a.channels + ch] ?? 0) - (b.data[i * b.channels + ch] ?? 0)),
        );
      sum += d;
      if (d > 24) far++;
    }
    // Edges and blur differ by a few levels; a gradient of the wrong angle, centre or stops, a
    // missing rotation or the wrong stacking would differ over whole regions.
    expect(sum / pixels).toBeLessThan(2);
    expect(far / pixels).toBeLessThan(0.005);
  }, 60_000);

  it("places pictures as Chromium draws them, keeps text shadows and lines, reports the rest", async () => {
    const html = readFileSync(join(OWN, "fidelity-content.html"), "utf8");
    const page = await open(html);
    const truth = await oracle(page);
    const shot = await decodePng(
      new Uint8Array(await page.screenshot({ type: "png", clip: { x: 0, y: 0, ...SIZE } })),
    );
    const captured = await capture(page);
    await page.close();
    const c = await importOnCanvas(html, captured);
    const source = await decodePng(
      new Uint8Array(readFileSync(join(VENTA, "assets/product-venta-borinc.png"))),
    );

    /** A picture paint's window sampled from the file vs Chromium's pixels in the layer's box. */
    const windowError = (
      id: string,
      paint: { imageScaleMode?: string; transform?: Record<string, number> },
    ) => {
      const t = truth.find((x) => x.id === id) as OracleLayer;
      const m =
        paint.imageScaleMode === "STRETCH" ? (paint.transform as Record<string, number>) : null;
      let sum = 0;
      let n = 0;
      for (let gy = 1; gy < 20; gy++)
        for (let gx = 1; gx < 20; gx++) {
          const u = gx / 20;
          const v = gy / 20;
          const iu = m ? (m.m00 ?? 1) * u + (m.m02 ?? 0) : u;
          const iv = m ? (m.m11 ?? 1) * v + (m.m12 ?? 0) : v;
          const sx = Math.min(source.width - 1, Math.max(0, Math.round(iu * source.width)));
          const sy = Math.min(source.height - 1, Math.max(0, Math.round(iv * source.height)));
          const px = Math.round(t.x + u * t.w);
          const py = Math.round(t.y + v * t.h);
          for (let ch = 0; ch < 3; ch++)
            sum += Math.abs(
              (source.data[(sy * source.width + sx) * source.channels + ch] ?? 0) -
                (shot.data[(py * shot.width + px) * shot.channels + ch] ?? 0),
            );
          n += 3;
        }
      return sum / n;
    };
    const photo = c.layer("photo")?.fillPaints?.find((p) => p.type === "IMAGE");
    expect(photo?.imageScaleMode).toBe("STRETCH");
    expect(windowError("photo", photo ?? {})).toBeLessThan(12);
    // The same picture centred (Wecra's Fill) would be off: the window is what matters.
    expect(
      windowError("photo", {
        imageScaleMode: "STRETCH",
        transform: { m00: 1, m11: 2 / 3, m02: 0, m12: 1 / 6 },
      }),
    ).toBeGreaterThan(windowError("photo", photo ?? {}));
    const none = c.layer("photo-none")?.fillPaints?.find((p) => p.type === "IMAGE");
    expect(none?.imageScaleMode).toBe("STRETCH");
    expect(windowError("photo-none", none ?? {})).toBeLessThan(12);
    // A picture under a gradient (the scrim over a photo): both, the picture below.
    expect((c.layer("hero")?.fillPaints ?? []).map((p) => p.type)).toEqual([
      "IMAGE",
      "GRADIENT_LINEAR",
    ]);

    const glow = c.nodes.find((n) => n.type === "TEXT" && markOf(n)?.layer === "glow");
    expect(glow?.effects?.map((e) => [e.type, e.radius, e.offset?.y])).toEqual([
      ["DROP_SHADOW", 12, 2],
    ]);
    const headline = c.nodes.find((n) => n.type === "TEXT" && markOf(n)?.layer === "headline");
    const lines = truth.find((t) => t.id === "headline")?.lines ?? 0;
    const chars = headline?.textData?.characters ?? "";
    expect(chars.split("\n").length).toBe(lines);
    expect(chars).toContain("İ");
    expect(chars).not.toMatch(/[iı]/);

    // An SVG logo: its vectors (not a 2× bitmap), still the brand's logo for the checks.
    const logo = c.layer("logo") as WNodeRead;
    expect((logo.fillPaints ?? []).some((p) => p.type === "IMAGE")).toBe(false);
    expect((logo.childIds ?? []).map((id) => c.byId.get(id)?.type)).toContain("VECTOR");
    expect(c.box(logo)).toMatchObject({ x: 72, y: 1230, w: 240, h: 60 });
    const layers = canvasLayers(canvasFacts(c.ed, c.frame));
    expect(layers.find((l) => l.type === "logo")).toMatchObject({
      src: "/brand/logos/studio-logo.svg",
    });

    const said = losses(c.report);
    expect(said).toContain("grey: filtre aktarılamadı (grayscale)");
    expect(said).toContain("masked: maske aktarılamadı");
    expect(said).toContain("headline: dengeli satır kırılımı satır sonlarıyla korundu");
  }, 60_000);

  it("keeps the design-kit's fixture slides' layers where Chromium has them", async () => {
    const names = readdirSync(SLIDES).filter((f) => f.endsWith(".html") && !f.startsWith("spike-"));
    expect(names.length).toBeGreaterThan(4);
    for (const name of names) {
      const html = readFileSync(join(SLIDES, name), "utf8");
      const page = await open(html);
      const truth = await oracle(page);
      const captured = await capture(page);
      await page.close();
      const c = await importOnCanvas(html, captured);
      for (const t of truth) {
        if (t.type === "text" || t.type === "group" || t.w === 0 || t.h === 0) continue;
        const n = c.layer(t.id);
        expect(n, `${name} ${t.id}`).toBeTruthy();
        const b = c.box(n as WNodeRead);
        for (const k of ["x", "y", "w", "h"] as const)
          expect(Math.abs(b[k] - t[k]), `${name} ${t.id}.${k}`).toBeLessThan(2);
      }
      // What the import reports for these slides (none of it about a supported case).
      for (const line of losses(c.report))
        expect(line, name).not.toMatch(/geçiş|z-index|clip-path/);
    }
  }, 120_000);
});
