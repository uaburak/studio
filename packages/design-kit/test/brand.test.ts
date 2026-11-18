import { describe, expect, it } from "vitest";
import {
  BrandTokensSchema,
  brandFontFamilies,
  brandPatchContext,
  brandSystemFontFamilies,
  ComponentRegistry,
  componentContext,
  createComponentRegistry,
  defineComponent,
  describeBrandCss,
  fallbackFamilyName,
  generateBrandCss,
  NEUTRAL_BRAND_TOKENS,
  parseBrandTokens,
  resolveFontFile,
  resolveUsage,
  UNICODE_RANGES,
} from "../src/brand/index.ts";
import { parseStylesheet, walkDeclarations, walkRules } from "../src/html/css.ts";
import { sanitizeStylesheet } from "../src/sanitize/index.ts";
import { ventaBrandJson, ventaTokens } from "./helpers.ts";

const minimal = {
  color: { paper: "#FFFFFF", ink: "#111111", accent: "#FF5500" },
  font: { text: { family: "Inter", files: ["fonts/inter.woff2"] } },
  space: { margin: 64, scale: [8, 16] },
};

describe("brand tokens", () => {
  it("accept the spike's brand.json (meta keys and documentation fields included)", () => {
    const t = ventaTokens();
    expect(Object.keys(t.color)).toHaveLength(10);
    expect(Object.keys(t.font)).toEqual(["display", "text"]);
    expect(Object.keys(t.logos)).toEqual([
      "venta-black",
      "venta-white",
      "mtm-agro-graphite",
      "mtm-agro-white",
    ]);
    expect(brandFontFamilies(t)).toEqual(["Archivo", "Montserrat"]);
    expect(brandPatchContext(t).fontTokens).toEqual(["display", "text"]);
    expect(resolveUsage(t)).toEqual({
      background: "paper",
      text: "graphite",
      accent: "green",
      muted: "stone",
      slotFill: "mist",
      slotInk: "green-deep",
      textFont: "text",
      displayFont: "display",
    });
  });

  it.each([
    [
      "colour injection",
      { ...minimal, color: { paper: "#fff; } body { background: url(https://e.example/) " } },
    ],
    [
      "family injection",
      {
        ...minimal,
        font: { text: { family: "Inter'; src: url(https://e.example/x)", files: [] } },
      },
    ],
    [
      "path traversal",
      { ...minimal, font: { text: { family: "Inter", files: ["../../etc/passwd"] } } },
    ],
    [
      "absolute URL path",
      { ...minimal, font: { text: { family: "Inter", files: ["https://e.example/f.woff2"] } } },
    ],
    ["bad token name", { ...minimal, color: { "Bad Name": "#fff" } }],
    [
      "tracking injection",
      {
        ...minimal,
        type: {
          body: {
            font: "text",
            size: 30,
            weight: 500,
            leading: 1.3,
            tracking: "0.1em; color: red",
          },
        },
      },
    ],
    ["no colours", { ...minimal, color: {} }],
  ])("reject %s", (_name, input) => {
    expect(BrandTokensSchema.safeParse(input).success).toBe(false);
  });
});

describe("brand.css", () => {
  const { css, manifest } = generateBrandCss(ventaBrandJson());
  const sheet = parseStylesheet(css);

  it("is deterministic", () => {
    expect(generateBrandCss(ventaBrandJson()).css).toBe(css);
  });

  it("self-hosts every font file with the right style, axes and subset", () => {
    const faces = [...walkRules(sheet.rules)].filter(
      (r) => r.kind === "at" && r.name === "font-face",
    );
    expect(faces).toHaveLength(8);
    const archivoItalicExt = faces.find((f) =>
      f.declarations.some((d) => d.value.includes("archivo-latin-ext-wdth-italic")),
    );
    const decl = (name: string) =>
      archivoItalicExt?.declarations.find((d) => d.name === name)?.value;
    expect(decl("font-family")).toBe("'Archivo'");
    expect(decl("font-style")).toBe("italic");
    expect(decl("font-weight")).toBe("100 900");
    expect(decl("font-stretch")).toBe("62% 125%");
    expect(decl("font-display")).toBe("block");
    expect(decl("src")).toBe("url('fonts/archivo-latin-ext-wdth-italic.woff2') format('woff2')");
    expect(decl("unicode-range")).toBe(UNICODE_RANGES["latin-ext"]);
  });

  it("defines the tokens and type styles the spike designs use", () => {
    for (const v of [
      "--color-green",
      "--color-green-deep",
      "--color-forest",
      "--font-display",
      "--font-text",
      "--margin",
      "--gutter",
      "--space-24",
      "--space-160",
      "--radius-lg",
      "--radius-pill",
      "--rule-width",
      "--rule-thickness",
    ])
      expect(manifest.variables).toContain(v);
    expect(css).toContain("--color-green: #66B052;");
    expect(css).toContain("--font-display: 'Archivo', sans-serif;");
    expect(manifest.typeClasses).toEqual([
      ".ts-display-xl",
      ".ts-display-l",
      ".ts-display-m",
      ".ts-headline",
      ".ts-title",
      ".ts-body-l",
      ".ts-body",
      ".ts-eyebrow",
      ".ts-caption",
    ]);
    const displayM = [...walkRules(sheet.rules)].find((r) => r.prelude === ".ts-display-m");
    expect(Object.fromEntries(displayM?.declarations.map((d) => [d.name, d.value]) ?? [])).toEqual({
      "font-family": "var(--font-display)",
      "font-size": "88px",
      "font-weight": "850",
      "line-height": "1",
      "letter-spacing": "-0.01em",
      "text-transform": "uppercase",
      "font-stretch": "125%",
      "font-style": "italic",
    });
    expect(css).toContain(".brand-rule {");
    expect(css).toContain("[data-hidden] { visibility: hidden !important; }");
    expect(css).toContain('[data-type="slot"][data-slot-state="empty"]::after');
  });

  it("ships the five components with tested examples and a prompt description", () => {
    expect(manifest.components.map((c) => c.name)).toEqual([
      "rule",
      "badge",
      "sign-off",
      "band",
      "counter",
    ]);
    for (const c of manifest.components)
      expect(c.example).toContain(`data-layer="example-${c.name}"`);
    const text = describeBrandCss(manifest);
    expect(text).toContain("brand-badge__label");
    expect(text).toContain(".ts-eyebrow");
    expect(css).toContain(".brand-badge--amber { --badge-fill: var(--color-amber); }");
  });

  it("only references URLs relative to brand.css (fonts), never other origins", () => {
    const urls = [...walkDeclarations(sheet.rules)].flatMap(({ decl }) =>
      [...decl.value.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1]),
    );
    expect(urls).toHaveLength(8);
    for (const u of urls) expect(u).toMatch(/^fonts\/[a-z0-9-]+\.woff2$/);
    // with absolute /brand/ URLs the sanitiser accepts the whole stylesheet unchanged
    const abs = generateBrandCss(ventaBrandJson(), { fontUrl: (f) => `/brand/${f.path}` }).css;
    expect(sanitizeStylesheet(abs).findings).toEqual([]);
  });

  it("resolves explicit font file entries", () => {
    const role = { family: "X", files: [], fallback: "serif" as const };
    expect(
      resolveFontFile(
        { path: "f/x.woff2", style: "italic", weight: 700, unicodeRange: "U+0000-00FF" },
        role,
      ),
    ).toEqual({
      path: "f/x.woff2",
      style: "italic",
      weight: "700",
      stretch: null,
      unicodeRange: "U+0000-00FF",
    });
  });

  it("uses system fonts by name and loads their files as a fallback family", () => {
    const { css: c, manifest } = generateBrandCss({
      ...minimal,
      font: {
        display: {
          family: "Avenir Next",
          system: true,
          weights: [400, 600, 800],
          files: ["fonts/avenir-fallback.woff2"],
        },
        text: { family: "Helvetica Neue", system: true },
      },
    });
    expect(c).toContain("--font-display: 'Avenir Next', 'Avenir Next Fallback', sans-serif;");
    expect(c).toContain("--font-text: 'Helvetica Neue', sans-serif;");
    // An @font-face named like the installed family would hide it.
    expect(c).toContain("font-family: 'Avenir Next Fallback';");
    expect(c).not.toContain("font-family: 'Avenir Next';");
    expect(c).toContain("src: url('fonts/avenir-fallback.woff2') format('woff2');");
    expect(manifest.fontFamilies).toEqual(["Avenir Next", "Helvetica Neue"]);
    expect(manifest.systemFontFamilies).toEqual(["Avenir Next", "Helvetica Neue"]);
    expect(fallbackFamilyName("Avenir Next")).toBe("Avenir Next Fallback");
    expect(brandSystemFontFamilies(parseBrandTokens(ventaBrandJson()))).toEqual([]);
  });

  it("works for a minimal brand with defaults", () => {
    const { css: c } = generateBrandCss(minimal);
    expect(c).toContain("--brand-background: var(--color-paper);");
    expect(c).toContain("--brand-text: var(--color-ink);");
    expect(c).toContain("--rule-color: var(--color-accent);");
    expect(c).toContain("src: url('fonts/inter.woff2') format('woff2');");
  });
});

describe("component registry", () => {
  const ctx = componentContext(parseBrandTokens(ventaBrandJson()));

  it("registers a per-brand component and overrides a built-in", () => {
    const registry = createComponentRegistry()
      .register(
        defineComponent({
          name: "stamp",
          description: "Round stamp.",
          css: (c) =>
            `.brand-stamp { border-radius: 50%; background: var(--color-${c.usage.accent}); }`,
          example: (_c, o) =>
            `<div data-layer="${o.id}" data-type="shape" class="brand-stamp"></div>`,
        }),
      )
      .register(
        defineComponent({
          name: "rule",
          description: "Thin rule.",
          css: () =>
            ".brand-rule { display:block; width: 40px; height: 2px; background: var(--rule-color); }",
          example: (_c, o) =>
            `<div data-layer="${o.id}" data-type="shape" class="brand-rule"></div>`,
        }),
      );
    const { css, manifest } = generateBrandCss(ventaBrandJson(), { components: registry });
    expect(manifest.components.map((c) => c.name)).toEqual([
      "rule",
      "badge",
      "sign-off",
      "band",
      "counter",
      "stamp",
    ]);
    expect(css).toContain(".brand-stamp { border-radius: 50%; background: var(--color-green); }");
    expect(css).toContain("height: 2px");
    expect(registry.clone().unregister("stamp").list()).toHaveLength(5);
  });

  it("rejects components that load URLs or have bad names", () => {
    const bad = new ComponentRegistry([
      defineComponent({
        name: "evil",
        description: "",
        css: () => ".x { background: url(https://e.example/x) }",
        example: () => "",
      }),
    ]);
    expect(() => generateBrandCss(ventaBrandJson(), { components: bad })).toThrow(
      /must not reference URLs/,
    );
    expect(() =>
      defineComponent({ name: "Bad Name", description: "", css: () => "", example: () => "" }),
    ).toThrow();
    expect(ctx.logo?.path).toBe("logos/venta-wordmark-black.standin.png");
  });
});

describe("neutral default", () => {
  it("parses and generates brand.css with system fonts only", () => {
    const tokens = parseBrandTokens(NEUTRAL_BRAND_TOKENS);
    const { css } = generateBrandCss(tokens);
    expect(css).toContain("--color-accent: #2F5D50");
    expect(css).not.toContain("@font-face");
    expect(brandFontFamilies(tokens)).toEqual(["Helvetica Neue"]);
  });
});
