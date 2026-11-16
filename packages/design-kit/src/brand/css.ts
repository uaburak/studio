/**
 * brand.css generator: the only stylesheet a design links (`/brand/brand.css`). It holds
 * the self-hosted @font-face rules, colour/spacing/radius tokens, type styles, the base
 * reset, the shared slot placeholder, editor rules (hidden layers) and brand components.
 *
 * Font files are referenced, not bundled: `fontUrl` maps each file reference to the URL
 * written into the CSS. The default is a URL relative to the stylesheet (`fonts/x.woff2`),
 * which resolves to `/brand/fonts/x.woff2` in the renderer and to the editor's asset host
 * in previews, without rewriting.
 */
import { KIT_VERSION } from "../version.ts";
import {
  type BrandComponent,
  type ComponentContext,
  ComponentRegistry,
  componentCss,
  createComponentRegistry,
} from "./components.ts";
import {
  type BrandTokens,
  colorValue,
  type FontFile,
  type FontRole,
  parseBrandTokens,
  resolveUsage,
} from "./tokens.ts";

/** Google Fonts / Fontsource subsets (same ranges the spike used). */
export const UNICODE_RANGES = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext":
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
} as const;

export interface ResolvedFontFile {
  path: string;
  style: "normal" | "italic";
  weight: string | null;
  stretch: string | null;
  unicodeRange: string | null;
}

/** Normalise a font file entry; string entries are read the Fontsource way (`*-latin-ext-*-italic.woff2`). */
export function resolveFontFile(file: FontFile, role: FontRole): ResolvedFontFile {
  const f = typeof file === "string" ? { path: file } : file;
  const name = f.path.split("/").pop() ?? f.path;
  const style = "style" in f && f.style ? f.style : /italic/i.test(name) ? "italic" : "normal";
  const range =
    "unicodeRange" in f && f.unicodeRange
      ? f.unicodeRange
      : /latin-ext/i.test(name)
        ? "latin-ext"
        : /latin/i.test(name)
          ? "latin"
          : null;
  const weightSpec = "weight" in f && f.weight !== undefined ? f.weight : role.axes?.wght;
  const stretchSpec = "stretch" in f && f.stretch ? f.stretch : role.axes?.wdth;
  return {
    path: f.path,
    style,
    weight:
      weightSpec === undefined
        ? null
        : Array.isArray(weightSpec)
          ? `${weightSpec[0]} ${weightSpec[1]}`
          : String(weightSpec),
    stretch: stretchSpec ? `${stretchSpec[0]}% ${stretchSpec[1]}%` : null,
    unicodeRange:
      range === null
        ? null
        : range === "latin" || range === "latin-ext"
          ? UNICODE_RANGES[range]
          : range,
  };
}

export interface GenerateBrandCssOptions {
  /** Components to include (default: the built-ins). */
  components?: ComponentRegistry | readonly BrandComponent[];
  /** URL written for a font file (default: the path, relative to brand.css). */
  fontUrl?: (file: ResolvedFontFile) => string;
}

export interface BrandCssManifest {
  /** CSS custom properties defined in `:root`. */
  variables: string[];
  /** Type style classes (`.ts-*`). */
  typeClasses: string[];
  components: { name: string; description: string; example: string }[];
  /** Font families brand.css loads (what the linter accepts). */
  fontFamilies: string[];
}

export interface BrandCss {
  css: string;
  manifest: BrandCssManifest;
}

const SAFE_URL = /^[A-Za-z0-9._~\-/%:+@=,]+$/;

function fontFaces(role: FontRole, fontUrl: (f: ResolvedFontFile) => string): string[] {
  return role.files.map((file) => {
    const f = resolveFontFile(file, role);
    const url = fontUrl(f);
    if (!SAFE_URL.test(url) || /^(?:javascript|data):/i.test(url))
      throw new Error(`unsafe font URL: ${url}`);
    const lines = [
      `  font-family: '${role.family}';`,
      `  font-style: ${f.style};`,
      f.weight ? `  font-weight: ${f.weight};` : null,
      f.stretch ? `  font-stretch: ${f.stretch};` : null,
      "  font-display: block;",
      `  src: url('${url}') format('woff2');`,
      f.unicodeRange ? `  unicode-range: ${f.unicodeRange};` : null,
    ].filter(Boolean);
    return `@font-face {\n${lines.join("\n")}\n}`;
  });
}

export function componentContext(tokens: BrandTokens): ComponentContext {
  const logoEntries = Object.entries(tokens.logos);
  const light = logoEntries.find(([, l]) => l.on === "light") ?? logoEntries[0];
  return {
    tokens,
    usage: resolveUsage(tokens),
    colors: Object.keys(tokens.color),
    logo: light
      ? {
          name: light[0],
          path: light[1].path,
          aspect:
            light[1].aspect ??
            (light[1].intrinsic ? light[1].intrinsic[0] / light[1].intrinsic[1] : 1),
        }
      : null,
  };
}

/** Generate brand.css from validated tokens (or raw brand.json, which is validated first). */
export function generateBrandCss(
  input: BrandTokens | unknown,
  options: GenerateBrandCssOptions = {},
): BrandCss {
  const tokens = parseBrandTokens(input);
  const ctx = componentContext(tokens);
  const u = ctx.usage;
  const registry =
    options.components instanceof ComponentRegistry
      ? options.components
      : createComponentRegistry(options.components as readonly BrandComponent[] | undefined);
  const fontUrl = options.fontUrl ?? ((f: ResolvedFontFile) => f.path);

  const vars: [string, string][] = [];
  for (const [name, c] of Object.entries(tokens.color))
    vars.push([`--color-${name}`, colorValue(c).toUpperCase()]);
  for (const [name, f] of Object.entries(tokens.font))
    vars.push([`--font-${name}`, `'${f.family}', ${f.fallback}`]);
  vars.push(["--margin", `${tokens.space.margin}px`]);
  if (tokens.space.gutter !== undefined) vars.push(["--gutter", `${tokens.space.gutter}px`]);
  for (const s of tokens.space.scale) vars.push([`--space-${s}`, `${s}px`]);
  for (const [name, r] of Object.entries(tokens.radius)) vars.push([`--radius-${name}`, `${r}px`]);
  const rule = tokens.rule ?? { width: 56, thickness: 6 };
  vars.push(["--rule-width", `${rule.width}px`], ["--rule-thickness", `${rule.thickness}px`]);
  vars.push([
    "--rule-color",
    `var(--color-${rule.color && ctx.colors.includes(rule.color) ? rule.color : u.accent})`,
  ]);
  vars.push(
    ["--brand-background", `var(--color-${u.background})`],
    ["--brand-text", `var(--color-${u.text})`],
  );
  vars.push(
    ["--slot-fill", `var(--color-${u.slotFill})`],
    ["--slot-ink", `var(--color-${u.slotInk})`],
    ["--slot-paper", `var(--color-${u.background})`],
  );

  const typeClasses: string[] = [];
  const typeCss = Object.entries(tokens.type).map(([name, t]) => {
    const role = tokens.font[t.font];
    if (!role) throw new Error(`type style "${name}" uses unknown font role "${t.font}"`);
    const d = role.default ?? {};
    const lines = [
      `  font-family: var(--font-${t.font});`,
      `  font-size: ${t.size}px;`,
      `  font-weight: ${t.weight};`,
      `  line-height: ${t.leading};`,
    ];
    const tracking = t.tracking ?? d.tracking;
    const transform = t.transform ?? d.transform;
    const stretch = t.stretch ?? d.stretch;
    const style = t.style ?? d.style;
    if (tracking) lines.push(`  letter-spacing: ${tracking};`);
    if (transform) lines.push(`  text-transform: ${transform};`);
    if (stretch) lines.push(`  font-stretch: ${stretch};`);
    if (style) lines.push(`  font-style: ${style};`);
    typeClasses.push(`.ts-${name}`);
    return `.ts-${name} {\n${lines.join("\n")}\n}`;
  });

  const components = registry.list().map((c) => ({
    name: c.name,
    description: c.description,
    css: componentCss(c, ctx),
    example: c.example(ctx, { id: `example-${c.name}`, left: 72, top: 72 }),
  }));

  const header = `/* GENERATED by @studio/design-kit ${KIT_VERSION} (contract v1). Do not edit by hand. */
/* Brand: ${(tokens.name ?? tokens.id ?? "brand").replace(/\*\//g, "")}${tokens.version ? ` v${tokens.version.replace(/\*\//g, "")}` : ""} */`;
  const faces = Object.values(tokens.font).flatMap((f) => fontFaces(f, fontUrl));
  const css = [
    header,
    ...faces,
    "",
    `:root {\n${vars.map(([k, v]) => `  ${k}: ${v};`).join("\n")}\n}`,
    "",
    "/* ---- base: identical for every design ---- */",
    "*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }",
    "html, body { margin: 0; background: var(--brand-background); }",
    `body {\n  font-family: var(--font-${u.textFont});\n  color: var(--brand-text);\n  -webkit-font-smoothing: antialiased;\n  text-rendering: geometricPrecision;\n  font-kerning: normal;\n  font-synthesis: none;\n  hyphens: manual;\n}`,
    "[data-artboard] { position: relative; overflow: hidden; background: var(--brand-background); }",
    "img { display: block; max-width: none; }",
    "/* editor: hidden layers are not painted but keep their box (siblings do not reflow) */",
    "[data-hidden] { visibility: hidden !important; }",
    "",
    "/* ---- type styles (designs may override size/leading per layer) ---- */",
    ...typeCss,
    "",
    "/* ---- image slot: shared placeholder look ---- */",
    '[data-type="slot"] { position: relative; overflow: hidden; display: block; }',
    '[data-type="slot"] > img[data-slot-image] { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }',
    '[data-type="slot"][data-slot-fit="contain"] > img[data-slot-image] { object-fit: contain; }',
    `[data-type="slot"][data-slot-state="empty"] {
  background-color: var(--slot-fill);
  background-image: repeating-linear-gradient(135deg, color-mix(in srgb, var(--slot-ink) 7%, transparent) 0 2px, transparent 2px 22px);
}`,
    `[data-type="slot"][data-slot-state="empty"]::before {
  content: "";
  position: absolute; inset: 24px;
  border: 2px solid color-mix(in srgb, var(--slot-ink) 28%, transparent);
  border-radius: inherit;
}`,
    `[data-type="slot"][data-slot-state="empty"]::after {
  content: attr(data-slot-label) "  ·  " attr(data-slot-ratio);
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  font-family: var(--font-${u.textFont}); font-weight: 700; font-size: 24px; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--slot-ink); white-space: nowrap;
  background: var(--slot-paper); padding: 14px 22px; border-radius: 999px;
}`,
    "",
    "/* ---- brand components ---- */",
    ...components.map((c) => `/* ${c.name} */\n${c.css}`),
    "",
  ].join("\n");

  return {
    css,
    manifest: {
      variables: vars.map(([k]) => k),
      typeClasses,
      components: components.map(({ name, description, example }) => ({
        name,
        description,
        example,
      })),
      fontFamilies: [...new Set(Object.values(tokens.font).map((f) => f.family))],
    },
  };
}

/** Prompt text describing what brand.css offers (variables, type classes, components). */
export function describeBrandCss(manifest: BrandCssManifest): string {
  const parts = [
    `brand.css defines these CSS variables: ${manifest.variables.join(" ")}`,
    `Type-style classes: ${manifest.typeClasses.join(" ")}`,
    "Base: box-sizing border-box, zero margins, img { display:block }, [data-artboard] overflow:hidden, [data-hidden] is not painted, empty slots get the shared placeholder look.",
    "Brand components (use them instead of rebuilding the same element):",
    ...manifest.components.map(
      (c) => `- ${c.name}: ${c.description}\n  Example:\n${c.example.replace(/^/gm, "    ")}`,
    ),
  ];
  return parts.join("\n");
}
