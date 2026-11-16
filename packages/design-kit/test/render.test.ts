/**
 * Renderer integration tests (real Chromium). Skipped when Chromium cannot be launched or
 * STUDIO_SKIP_RENDER=1; they run by default on the Mac worker.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { brandFontFamilies, componentContext, generateBrandCss } from "../src/brand/index.ts";
import { createSlideHtml } from "../src/document/index.ts";
import {
  IN_PAGE_LINT_SCRIPT,
  type InPageResult,
  inPageInput,
  LINT_RULES,
  type LintConfig,
  type LintReport,
  lintCarousel,
  RULE_IDS,
  type RuleId,
} from "../src/lint/index.ts";
import { applyPatch } from "../src/patch/index.ts";
import { PLATFORM_PRESETS, validateExport } from "../src/presets/index.ts";
import {
  combineResolvers,
  createDirectoryResolver,
  createMemoryResolver,
  createRenderer,
  imageInfo,
  isChromiumAvailable,
  RenderError,
  type Renderer,
  VIRTUAL_ORIGIN,
} from "../src/render/index.ts";
import { buildPreviewDocument } from "../src/sanitize/index.ts";
import {
  doc,
  FINAL_SLIDES,
  fixturePath,
  slide,
  ventaBrandJson,
  ventaCss,
  ventaFacts,
  ventaTokens,
} from "./helpers.ts";

const enabled = process.env.STUDIO_SKIP_RENDER !== "1" && (await isChromiumAvailable());
const SPIKE_OUT = fileURLToPath(new URL("../../../spikes/design-render/out/", import.meta.url));

/** Deterministic "busy photo" (seeded noise + stripes), like the spike's busy-test-photo.jpg. */
async function busyPhoto(): Promise<Uint8Array> {
  const w = 1600;
  const h = 1200;
  const px = new Uint8Array(w * h * 3);
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const stripe = ((x + y) >> 5) % 2 ? 60 : 200;
      px[i] = Math.min(255, stripe * 0.4 + rnd() * 150);
      px[i + 1] = Math.min(255, stripe * 0.7 + rnd() * 90);
      px[i + 2] = Math.min(255, stripe * 0.3 + rnd() * 60);
    }
  return new Uint8Array(
    await sharp(px, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 85 })
      .toBuffer(),
  );
}

const facts = ventaFacts();
const tokens = ventaTokens();
const lint: Omit<LintConfig, "width" | "height"> = {
  brandFonts: brandFontFamilies(tokens),
  allowedNumbers: facts.allowedNumbers,
};

describe.skipIf(!enabled)("renderer (Chromium)", () => {
  let renderer: Renderer;
  let media: Uint8Array;
  const resolverWith = (css: string) =>
    combineResolvers(
      createMemoryResolver({ "/brand/brand.css": css, "/media/busy-test-photo.jpg": media }),
      createDirectoryResolver({ brand: fixturePath("venta") }),
    );

  beforeAll(async () => {
    media = await busyPhoto();
    renderer = createRenderer({ resolver: resolverWith(ventaCss()) });
  });
  afterAll(async () => {
    await renderer?.close();
  });

  const run = (
    html: string,
    size = { width: 1080, height: 1350 },
    extra: Partial<LintConfig> = {},
  ) => renderer.renderAndLint({ html, ...size, lint: { ...lint, ...extra } });

  describe("the spike's final samples", () => {
    const reports: Record<string, LintReport> = {};

    it.each(FINAL_SLIDES)("%s renders at 1080x1350, sRGB JPEG + PNG, lint-clean", async (name) => {
      const res = await run(slide(name));
      reports[name] = res.report;
      const png = await imageInfo(res.png as Uint8Array);
      const jpg = await imageInfo(res.jpeg as Uint8Array);
      expect(png).toMatchObject({ format: "png", width: 1080, height: 1350 });
      expect(jpg).toMatchObject({
        format: "jpeg",
        width: 1080,
        height: 1350,
        space: "srgb",
        hasIcc: true,
      });
      expect(res.report.stages).toEqual({ static: true, layout: true, pixel: true, render: true });
      expect(res.network).toEqual({ blocked: [], missing: [] });
      expect(res.served).toContain("/brand/brand.css");
      expect(res.report.issues.filter((i) => i.severity === "error")).toEqual([]);
      expect(res.report.ok).toBe(true);
      expect(res.report.fontsLoaded?.length).toBeGreaterThan(0);
      expect(
        validateExport(PLATFORM_PRESETS["instagram-feed-portrait"], {
          format: "jpeg",
          width: 1080,
          height: 1350,
          bytes: (res.jpeg as Uint8Array).byteLength,
        }).ok,
      ).toBe(true);
      expect(res.timings.totalMs).toBeLessThan(10_000);
    });

    it("only the known weakness remains as a warning: the void on the carousel cover", () => {
      const warnings = Object.entries(reports).flatMap(([n, r]) =>
        r.issues.filter((i) => i.severity === "warning").map((i) => `${n}:${i.rule}`),
      );
      expect(warnings).toEqual(["carousel-1:large-void"]);
    });

    it("the carousel passes the cross-slide checks", () => {
      const c = lintCarousel([
        reports["carousel-1"],
        reports["carousel-2"],
        reports["carousel-3"],
      ] as LintReport[]);
      expect(c.issues).toEqual([]);
      expect(c.ok).toBe(true);
    });

    it("renders the same bytes twice (PNG and JPEG)", async () => {
      const a = await renderer.render({ html: slide("carousel-2"), width: 1080, height: 1350 });
      const b = await renderer.render({ html: slide("carousel-2"), width: 1080, height: 1350 });
      expect(Buffer.from(a.png as Uint8Array).equals(Buffer.from(b.png as Uint8Array))).toBe(true);
      expect(Buffer.from(a.jpeg as Uint8Array).equals(Buffer.from(b.jpeg as Uint8Array))).toBe(
        true,
      );
      // and across browsers: a fresh renderer gives the same pixels
      const other = createRenderer({ resolver: resolverWith(ventaCss()) });
      try {
        const c = await other.render({
          html: slide("carousel-2"),
          width: 1080,
          height: 1350,
          formats: ["png"],
        });
        expect(Buffer.from(c.png as Uint8Array).equals(Buffer.from(a.png as Uint8Array))).toBe(
          true,
        );
      } finally {
        await other.close();
      }
    });

    it.skipIf(!existsSync(SPIKE_OUT))(
      "matches the spike's own renders pixel for pixel (new brand.css, same look)",
      async () => {
        for (const [name, file] of [
          ["product-intro", "01-product-intro/v2/slide-1.png"],
          ["typographic", "02-typographic/v2/slide-1.png"],
          ["carousel-2", "03-carousel/v2/slide-2.png"],
          ["image-slot", "04-image-slot/v2/slide-1.png"],
        ] as const) {
          const ours = await sharp(
            (
              await renderer.render({
                html: slide(name),
                width: 1080,
                height: 1350,
                formats: ["png"],
              })
            ).png as Uint8Array,
          )
            .raw()
            .toBuffer();
          const theirs = await sharp(readFileSync(join(SPIKE_OUT, file)))
            .raw()
            .toBuffer();
          expect(ours.length).toBe(theirs.length);
          let diff = 0;
          for (let i = 0; i < ours.length; i++)
            diff += Math.abs((ours[i] as number) - (theirs[i] as number));
          expect(diff / ours.length, name).toBeLessThan(0.05);
        }
      },
    );

    it("renders at 2x for high-resolution output", async () => {
      const res = await renderer.render({
        html: slide("typographic"),
        width: 1080,
        height: 1350,
        deviceScaleFactor: 2,
      });
      expect(await imageInfo(res.jpeg as Uint8Array)).toMatchObject({ width: 2160, height: 2700 });
      expect(res).toMatchObject({ pixelWidth: 2160, pixelHeight: 2700 });
      expect(
        validateExport("instagram-feed-portrait", {
          format: "jpeg",
          width: 2160,
          height: 2700,
          bytes: (res.jpeg as Uint8Array).byteLength,
        }).issues.map((i) => i.code),
      ).toContain("too-wide");
    });
  });

  describe("reproduces the spike's linter verdicts", () => {
    it("broken fixture: every rule the spike reported (css-unreadable is gone: CSS is now read statically)", async () => {
      const { report } = await run(slide("spike-bad"));
      const rules = new Set(report.issues.map((i) => i.rule));
      const spike = [
        "lang",
        "forbidden-element",
        "forbidden-link",
        "event-handler",
        "css-font-face",
        "css-url",
        "layer-id-format",
        "layer-type",
        "layer-id-duplicate",
        "image-src",
        "image-broken",
        "text-outside-text-layer",
        "min-font-size",
        "unverified-number",
        "network-request",
        "contrast",
        "colour-literal",
        "undeclared-visual",
        "safe-area",
        "percentage",
      ];
      for (const r of spike) expect(rules, r).toContain(r);
      expect(report.ok).toBe(false);
    });

    it("first-pass product post: the hexagon badges paint over their letters (text-occluded)", async () => {
      const { report } = await run(slide("product-intro.v1"));
      expect(
        report.issues.filter((i) => i.severity === "error").map((i) => `${i.rule}:${i.layer}`),
      ).toEqual(["text-occluded:badge-b-letter", "text-occluded:badge-zn-letter"]);
    });

    it("a slot filled by the patch engine renders without the empty-slot notice", async () => {
      const filled = applyPatch(slide("image-slot"), {
        op: "fillSlot",
        layer: "field-photo",
        src: "/media/busy-test-photo.jpg",
        alt: "Tarla",
      });
      const { report, network } = await run(filled.html);
      expect(network.missing).toEqual([]);
      expect(report.issues.filter((i) => i.rule !== "contract-version")).toEqual([]);
    });
  });

  describe("brand components", () => {
    const ctx = componentContext(tokens);
    const page = createSlideHtml({
      width: 1080,
      height: 1350,
      css: ".photo { mix-blend-mode: multiply; object-fit: contain; }",
      body: [
        '<p data-layer="counter" data-type="text" data-role="counter" class="brand-counter" style="position:absolute; left:72px; top:72px">1<span class="brand-counter__total"> / 3</span></p>',
        '<p data-layer="eyebrow" data-type="text" data-role="eyebrow" class="ts-eyebrow" style="position:absolute; left:72px; top:160px; color:var(--color-green-deep)">Mikro bitki besin maddeleri</p>',
        '<div data-layer="rule" data-type="shape" data-role="decoration" class="brand-rule" style="position:absolute; left:72px; top:212px"></div>',
        '<h1 data-layer="headline" data-type="text" data-role="headline" class="ts-display-l" style="position:absolute; left:72px; top:250px; width:936px; color:var(--color-ink)">Bor ve çinko</h1>',
        '<img data-layer="photo" data-type="image" class="photo" src="/brand/assets/product-venta-borinc.png" alt="Venta Borinc" style="position:absolute; left:380px; top:470px; width:700px; height:700px">',
        badge("badge-b", 72, 560, "amber", "B"),
        badge("badge-zn", 72, 700, "green", "Zn"),
        '<p data-layer="body" data-type="text" data-role="body" class="ts-body" style="position:absolute; left:72px; top:880px; width:300px">Kullanmadan önce etiketi okuyunuz.</p>',
        signOff(),
        '<div data-layer="band" data-type="shape" data-role="decoration" class="brand-band brand-band--tab" style="position:absolute; left:0; top:1326px; width:1080px; height:24px"></div>',
      ].join("\n"),
    });
    function badge(id: string, left: number, top: number, tone: string, label: string) {
      return `<div data-layer="${id}" data-type="group" data-role="badge" class="brand-badge brand-badge--${tone}" style="position:absolute; left:${left}px; top:${top}px">
  <div data-layer="${id}-shape" data-type="shape" data-role="decoration" class="brand-badge__shape"></div>
  <p data-layer="${id}-label" data-type="text" data-role="badge" class="brand-badge__label">${label}</p>
</div>`;
    }
    function signOff() {
      return `<div data-layer="sign-off" data-type="group" data-role="sign-off" class="brand-sign-off" style="position:absolute; left:72px; top:1236px; width:936px">
  <img data-layer="logo" data-type="logo" class="brand-sign-off__logo" src="/brand/${ctx.logo?.path}" alt="Venta">
  <p data-layer="web" data-type="text" data-role="caption" class="brand-sign-off__text">www.mtmagro.com</p>
</div>`;
    }

    it("a page built from the components passes every check (the clean fixture for all layout rules)", async () => {
      const res = await run(page);
      expect(res.report.issues).toEqual([]);
      writeFileSync(join(tmp, "components.png"), res.png as Uint8Array);
    });

    it("each component example renders lint-clean on its own", async () => {
      const { manifest } = generateBrandCss(ventaBrandJson());
      for (const c of manifest.components) {
        const body = c.example.replace(/left:72px; top:72px/, "left:72px; top:600px");
        const { report } = await run(
          createSlideHtml({ width: 1080, height: 1350, body }),
          undefined,
          { rules: { "large-void": "off" } },
        );
        expect(report.issues, c.name).toEqual([]);
      }
    });
  });

  describe("layout, pixel and render rules", () => {
    const P = (
      id: string,
      style: string,
      text = "Kullanmadan önce etiketi okuyunuz.",
      extra = "",
    ) =>
      `<p data-layer="${id}" data-type="text" class="ts-body"${extra} style="position:absolute; ${style}">${text}</p>`;
    const LOGO =
      '<img data-layer="logo" data-type="logo" src="/brand/logos/venta-wordmark-black.standin.png" alt="Venta" style="position:absolute; left:72px; top:1236px; height:40px">';
    const FILL = `${P("fill-a", "left:72px; top:72px; width:936px")}${P("fill-b", "left:72px; top:700px; width:936px")}${P("fill-c", "left:72px; top:1100px; width:936px")}`;

    const FAILING: Partial<
      Record<RuleId, { html: string; size?: { width: number; height: number } }>
    > = {
      "artboard-size": {
        html: doc(P("t", "left:72px; top:72px"), "", { width: 1000, height: 1350 }),
      },
      "artboard-overflow": { html: doc(FILL, "[data-artboard] { overflow: visible; }") },
      "document-size": {
        html: doc(FILL).replace("</main>", '</main><div style="height:3000px"></div>'),
      },
      "text-layer-inline": {
        html: doc(`${FILL}<span data-layer="t" data-type="text" class="ts-body">x</span>`),
      },
      "slot-ratio-mismatch": {
        html: doc(
          `${FILL}<figure data-layer="s" data-type="slot" data-slot-ratio="4:5" data-slot-state="empty" data-slot-label="Foto" style="position:absolute; left:300px; top:300px; width:400px; height:400px"></figure>`,
        ),
      },
      "slot-too-small": {
        html: doc(
          `${FILL}<figure data-layer="s" data-type="slot" data-slot-ratio="1:1" data-slot-state="empty" data-slot-label="F" style="position:absolute; left:300px; top:300px; width:150px; height:150px"></figure>`,
        ),
      },
      "image-broken": {
        html: doc(
          `${FILL}<img data-layer="i" data-type="image" src="/media/missing.png" alt="" style="position:absolute; left:300px; top:300px; width:300px; height:300px">`,
        ),
      },
      "image-upscaled": {
        html: doc(
          `${FILL}<img data-layer="i" data-type="image" src="/brand/assets/product-venta-borinc.png" alt="" style="position:absolute; left:-100px; top:0; width:1400px; height:1400px">`,
        ),
      },
      "image-distorted": {
        html: doc(
          `${FILL}<img data-layer="i" data-type="image" src="/brand/assets/product-venta-borinc.png" alt="" style="position:absolute; left:100px; top:300px; width:800px; height:400px; object-fit:fill">`,
        ),
      },
      "text-outside-text-layer": {
        html: doc(
          `${FILL}<div data-layer="g" data-type="group" style="position:absolute; left:72px; top:400px">${P("t", "position:static")}loose words</div>`,
        ),
      },
      "undeclared-visual": {
        html: doc(
          `${FILL}<div style="position:absolute; left:400px; top:400px; width:100px; height:100px; background:var(--color-green)"></div>`,
        ),
      },
      "font-family": { html: doc(P("t", "left:72px; top:72px; width:936px; font-family: serif")) },
      "min-font-size": { html: doc(P("t", "left:72px; top:72px; width:936px; font-size:18px")) },
      "small-font-size": { html: doc(P("t", "left:72px; top:72px; width:936px; font-size:26px")) },
      "text-occluded": { html: slide("product-intro.v1") },
      "text-clipped": {
        html: doc(P("t", "left:72px; top:72px; width:300px; height:40px; overflow:hidden")),
      },
      "text-overflow-box": { html: doc(P("t", "left:72px; top:72px; width:300px; height:40px")) },
      "text-truncated": {
        html: doc(
          P(
            "t",
            "left:72px; top:72px; width:300px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis",
          ),
        ),
      },
      "text-line-clamp": {
        html: doc(
          P(
            "t",
            "left:72px; top:72px; width:200px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden",
          ),
        ),
      },
      "text-outside-artboard": { html: doc(P("t", "left:800px; top:72px; white-space:nowrap")) },
      "safe-area": { html: doc(P("t", "left:20px; top:72px; width:600px")) },
      widow: {
        html: doc(
          P(
            "t",
            "left:72px; top:72px; width:936px; font-size:72px; line-height:1.1",
            "Bor ve çinko bir arada<br>da",
          ),
        ),
      },
      "text-overlap": {
        html: doc(
          P("a", "left:72px; top:300px; width:600px") + P("b", "left:72px; top:300px; width:600px"),
        ),
      },
      "text-logo-overlap": { html: doc(LOGO + P("t", "left:72px; top:1230px; width:600px")) },
      "diacritic-collision": {
        html: doc(
          `<h1 data-layer="t" data-type="text" class="ts-display-xl" style="position:absolute; left:72px; top:200px; width:936px; line-height:0.62">Ş<br>İ</h1>`,
        ),
      },
      "logo-clear-space": {
        html: doc(
          `${LOGO}<p data-layer="web" data-type="text" class="ts-body" style="position:absolute; left:330px; top:1236px">www.mtmagro.com</p>`,
        ),
      },
      "large-void": { html: doc(P("t", "left:72px; top:72px; width:936px")) },
      contrast: { html: doc(P("t", "left:72px; top:72px; width:936px; color:var(--color-line)")) },
      "contrast-busy-background": {
        html: doc(
          `<div data-layer="bg" data-type="shape" data-role="background" style="position:absolute; left:0; top:0; width:1080px; height:300px; background: linear-gradient(90deg, #000 0 70%, #fafafa 70%)"></div>${P("t", "left:72px; top:100px; width:936px; font-size:60px; color:#fff; line-height:1.2", "Bor ve çinko bir arada olur")}`,
        ),
      },
      "contrast-unknown": {
        html: doc(
          P(
            "t",
            "left:72px; top:72px; width:936px; background-image:linear-gradient(90deg, var(--color-ink), var(--color-green)); -webkit-background-clip:text; background-clip:text; color:transparent",
          ),
        ),
      },
      "network-request": {
        html: doc(
          `${FILL}<img data-layer="i" data-type="image" src="/media/missing.png" alt="" style="position:absolute; left:300px; top:300px; width:300px; height:300px">`,
        ),
      },
    };

    const covered = RULE_IDS.filter(
      (id) => ["layout", "pixel", "render"].includes(LINT_RULES[id].stage) && id !== "font-load",
    );

    it("every layout, pixel and render rule has a failing fixture", () => {
      expect(covered.filter((id) => !(id in FAILING))).toEqual([]);
    });

    it.each(covered)("%s fires on its failing fixture", async (rule) => {
      const f = FAILING[rule] as { html: string; size?: { width: number; height: number } };
      const { report } = await run(
        f.html,
        f.size ?? { width: 1080, height: 1350 },
        rule === "large-void" ? {} : { rules: { "large-void": "off" } },
      );
      const hit = report.issues.find((i) => i.rule === rule);
      expect(
        hit,
        JSON.stringify(
          report.issues.map((i) => `${i.rule}:${i.layer}:${i.message.slice(0, 80)}`),
          null,
          1,
        ),
      ).toBeDefined();
      expect(hit?.severity).toBe(LINT_RULES[rule].severity);
    });

    it("font-load fires when a brand font file is missing", async () => {
      const broken = structuredClone(ventaBrandJson()) as {
        font: { display: { files: string[] } };
      };
      broken.font.display.files = ["fonts/missing-latin.woff2"];
      const css = generateBrandCss(broken).css;
      const res = await renderer.renderAndLint({
        html: doc(
          `<h1 data-layer="t" data-type="text" class="ts-display-m" style="position:absolute; left:72px; top:72px; width:936px">Bor</h1>`,
        ),
        width: 1080,
        height: 1350,
        resolver: resolverWith(css),
        lint,
      });
      expect(res.report.issues.map((i) => i.rule)).toEqual(
        expect.arrayContaining(["font-load", "network-request"]),
      );
      expect(res.network.missing).toContain("/brand/fonts/missing-latin.woff2");
    });
  });

  describe("isolation", () => {
    it("blocks every request outside the virtual origin and never runs scripts", async () => {
      const html = doc(
        `<img data-layer="a" data-type="image" src="https://evil.example/pixel.png" alt="" style="position:absolute;left:0;top:0;width:10px;height:10px"><p data-layer="t" data-type="text" id="t" style="position:absolute;left:72px;top:72px">before</p><script>document.getElementById("t").textContent = "script ran";</script>`,
        "p { background-image: url(https://evil.example/bg.png) }",
      );
      const res = await renderer.renderAndLint({ html, width: 1080, height: 1350, lint });
      expect(res.network.blocked).toEqual(
        expect.arrayContaining(["https://evil.example/pixel.png", "https://evil.example/bg.png"]),
      );
      expect(res.report.layers.find((l) => l.id === "t")?.content).toBe("before");
      const { report } = res;
      expect(report.issues.filter((i) => i.rule === "network-request")).toHaveLength(2);
    });

    it("times out and can be aborted", async () => {
      await expect(
        renderer.render({ html: slide("typographic"), width: 1080, height: 1350, timeoutMs: 1 }),
      ).rejects.toMatchObject({ code: "timeout" });
      const ac = new AbortController();
      const p = renderer.render({
        html: slide("typographic"),
        width: 1080,
        height: 1350,
        signal: ac.signal,
      });
      ac.abort();
      await expect(p).rejects.toBeInstanceOf(RenderError);
      // the shared browser is still usable
      const ok = await renderer.render({
        html: slide("typographic"),
        width: 1080,
        height: 1350,
        formats: ["png"],
      });
      expect(ok.png?.byteLength).toBeGreaterThan(1000);
    });

    it("relaunches the browser after it went away", async () => {
      await (await renderer.browser()).close();
      const ok = await renderer.render({
        html: slide("typographic"),
        width: 1080,
        height: 1350,
        formats: ["png"],
      });
      expect(ok.png?.byteLength).toBeGreaterThan(1000);
    });

    it("rejects bad requests", async () => {
      await expect(renderer.render({ html: "x", width: 0, height: 10 })).rejects.toMatchObject({
        code: "invalid_request",
      });
      await expect(
        createRenderer().render({ html: "x", width: 10, height: 10 }),
      ).rejects.toMatchObject({ code: "no_resolver" });
    });
  });

  describe("PDF (LinkedIn document posts)", () => {
    it("builds a multi-page, deterministic PDF from the carousel", async () => {
      const slides = ["carousel-1", "carousel-2", "carousel-3"].map((n) => ({
        html: slide(n),
        width: 1080,
        height: 1350,
      }));
      const a = await renderer.renderPdf({ slides, title: "Doğru saklama rehberi" });
      const b = await renderer.renderPdf({ slides, title: "Doğru saklama rehberi" });
      const text = Buffer.from(a.pdf).toString("latin1");
      expect(text.startsWith("%PDF-1.7")).toBe(true);
      expect(text).toContain("/Count 3");
      expect(text.match(/\/Type \/Page /g)).toHaveLength(3);
      expect(text).toContain("/MediaBox [0 0 810 1012.5]");
      expect(text).toContain("/Width 2160 /Height 2700");
      expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
      expect(Buffer.from(a.pdf).equals(Buffer.from(b.pdf))).toBe(true);
      expect(
        validateExport("linkedin-document-portrait", {
          format: "pdf",
          width: 2160,
          height: 2700,
          bytes: a.pdf.byteLength,
          pages: a.pages,
        }).ok,
      ).toBe(true);
      writeFileSync(join(tmp, "carousel.pdf"), a.pdf);
    });
  });

  describe("web editor path", () => {
    it("runs the same in-page checks against a sandboxed srcdoc preview from the parent page", async () => {
      const html = slide("product-intro.v1");
      const preview = buildPreviewDocument(html);
      const direct = await run(html);
      const browser = await renderer.browser();
      const context = await browser.newContext({
        viewport: { width: 1400, height: 1400 },
        javaScriptEnabled: false,
      });
      try {
        const resolver = resolverWith(ventaCss());
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== VIRTUAL_ORIGIN) return route.abort();
          if (url.pathname === "/editor") {
            const esc = preview.srcdoc.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
            return route.fulfill({
              status: 200,
              contentType: "text/html",
              body: `<!doctype html><body style="margin:0"><iframe sandbox="${preview.iframe.sandbox}" style="border:0;width:1080px;height:1350px" srcdoc="${esc}"></iframe></body>`,
            });
          }
          const r = await resolver.resolve(url.pathname);
          return r
            ? route.fulfill({ status: 200, body: Buffer.from(r.body), contentType: r.contentType })
            : route.fulfill({ status: 404 });
        });
        const page = await context.newPage();
        await page.goto(`${VIRTUAL_ORIGIN}/editor`, { waitUntil: "load" });
        const input = inPageInput({ ...lint, width: 1080, height: 1350 });
        const res = (await page.evaluate(
          `(async () => { const d = document.querySelector("iframe").contentDocument; await d.fonts.ready; return (${IN_PAGE_LINT_SCRIPT})(${JSON.stringify(input)}, d); })()`,
        )) as InPageResult;
        const errors = res.findings.map((f) => `${f.rule}:${f.layer}`).sort();
        expect(errors).toEqual(["text-occluded:badge-b-letter", "text-occluded:badge-zn-letter"]);
        expect(direct.report.issues.filter((i) => i.rule === "text-occluded")).toHaveLength(2);
        expect(res.layers.length).toBe(direct.report.layers.length);
      } finally {
        await context.close();
      }
    });
  });
});

/** Scratch output (component page PNG, carousel PDF), removed after the run. */
const tmp = mkdtempSync(join(tmpdir(), "design-kit-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("directory resolver", () => {
  it("serves only known files inside the root", async () => {
    const r = createDirectoryResolver({ brand: fixturePath("venta") });
    expect((await r.resolve("/brand/logos/venta-wordmark-black.standin.png"))?.contentType).toBe(
      "image/png",
    );
    expect(await r.resolve("/brand/brand.json")).toBeNull(); // not a served type
    expect(await r.resolve("/brand/../venta/facts.json")).toBeNull();
    expect(await r.resolve("/brand/%2e%2e/slides/spike-bad.html")).toBeNull();
    expect(await r.resolve("/media/x.png")).toBeNull(); // no media root
    expect(await r.resolve("/brand/fonts")).toBeNull(); // a directory
    const outside = join(tmp, "outside.png");
    writeFileSync(outside, "x");
    const root = join(tmp, "root");
    mkdirSync(root, { recursive: true });
    symlinkSync(outside, join(root, "link.png"));
    expect(await createDirectoryResolver({ media: root }).resolve("/media/link.png")).toBeNull();
  });
});
