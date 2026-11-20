/**
 * Brand context for design generation: tokens -> brand.css (design-kit), facts and
 * their numbers guard, logo/asset lists for the prompt, and an asset resolver that
 * serves `/brand/...` files from the API.
 *
 * Where brand files come from (until the brand-kit task A5 defines it in the contract):
 * the approved profile's `tokens.fileAssets` maps a brand file path (`fonts/x.woff2`,
 * `logos/y.png`) to an asset id of the brand. Facts live in `tokens.facts`
 * (`allowedNumbers`, statements, forbidden claims), the facts.json of the spike.
 *
 * No approved profile (or unusable tokens): a neutral, clearly labelled default with
 * system fonts and no logo; no brand facts at all.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Brand, BrandProfile } from "@studio/contract";
import {
  type BrandCssManifest,
  type BrandTokens,
  brandFontFamilies,
  generateBrandCss,
  parseBrandTokens,
} from "@studio/design-kit/brand";
import {
  type AssetResolver,
  combineResolvers,
  contentTypeFor,
  createMemoryResolver,
} from "@studio/design-kit/render";
import type { StudioApi } from "../api.ts";

export type BrandMode = "approved" | "provisional" | "neutral";

export interface BrandLogo {
  name: string;
  path: string;
  width: number | null;
  height: number | null;
  aspect: number | null;
  on: string | null;
}

export interface BrandImageAsset {
  name: string;
  path: string;
  note: string;
}

export interface BrandContext {
  brand: Brand;
  profile: BrandProfile | null;
  mode: BrandMode;
  /** Turkish label for notes and the version note. */
  label: string;
  /** Why the neutral default is used, when it is. */
  fallbackReason?: string;
  tokens: BrandTokens;
  /** Tokens as stored, minus `fileAssets` and `facts` (for the prompt). */
  promptTokens: Record<string, unknown>;
  css: string;
  manifest: BrandCssManifest;
  fontFamilies: string[];
  facts: unknown | null;
  allowedNumbers: string[];
  logos: BrandLogo[];
  images: BrandImageAsset[];
  designRules: string;
  voice: string;
  /** Logo clear space per `/brand/...` path (lint config). */
  logoClearSpaceByPath: Record<string, number>;
  /** Serves `/brand/brand.css` and the mapped brand files. */
  resolver: AssetResolver;
  /** `<brand_skills>` for the design prompt (set by the generation handler; "" = none). */
  skillsBlock?: string;
}

/** Neutral default: system fonts (present on every Mac), quiet colours, no logo. */
export const NEUTRAL_TOKENS = {
  id: "neutral-default",
  name: "Nötr varsayılan",
  status: "neutral-default",
  version: "0",
  color: {
    paper: { value: "#FFFFFF", use: "default background" },
    mist: { value: "#F1F1EE", use: "secondary background, panels, empty slots" },
    ink: { value: "#151515", use: "headlines, primary text" },
    graphite: { value: "#2E2E2E", use: "body text" },
    stone: { value: "#666666", use: "secondary text (>= 28px)" },
    line: { value: "#D9D9D6", use: "hairlines" },
    accent: { value: "#2F5D50", use: "the single accent: rules, bands, large type" },
    "accent-deep": { value: "#22453B", use: "accent text on light, background for white text" },
  },
  font: {
    display: {
      family: "Helvetica Neue",
      system: true,
      files: [],
      fallback: "sans-serif",
      default: { weight: 700, leading: 1.0 },
    },
    text: {
      family: "Helvetica Neue",
      system: true,
      files: [],
      fallback: "sans-serif",
      default: { weight: 400, leading: 1.38 },
    },
  },
  type: {
    "display-l": { font: "display", size: 120, weight: 800, leading: 0.98, tracking: "-0.02em" },
    "display-m": { font: "display", size: 88, weight: 800, leading: 1.0, tracking: "-0.015em" },
    headline: { font: "display", size: 72, weight: 700, leading: 1.04, tracking: "-0.01em" },
    title: { font: "text", size: 52, weight: 700, leading: 1.1 },
    "body-l": { font: "text", size: 36, weight: 400, leading: 1.34 },
    body: { font: "text", size: 30, weight: 400, leading: 1.4 },
    eyebrow: {
      font: "text",
      size: 26,
      weight: 700,
      leading: 1.2,
      tracking: "0.12em",
      transform: "uppercase",
    },
    caption: { font: "text", size: 24, weight: 500, leading: 1.3, tracking: "0.02em" },
  },
  space: {
    unit: 8,
    margin: 72,
    gutter: 24,
    columns: 6,
    scale: [8, 16, 24, 32, 48, 64, 72, 96, 128, 160],
  },
  radius: { sm: 8, md: 16, lg: 32, pill: 999 },
  rule: { width: 56, thickness: 6, color: "accent" },
  logos: {},
  usage: {
    background: "paper",
    text: "ink",
    accent: "accent",
    muted: "stone",
    slotFill: "mist",
    slotInk: "accent-deep",
    textFont: "text",
    displayFont: "display",
  },
} as const;

const NEUTRAL_DESIGN = `NEUTRAL DEFAULT PROFILE (the brand has no approved profile yet).
- Quiet, editorial layouts: white or very light backgrounds, one accent colour used sparingly.
- Typography carries the design: large clear headlines, generous white space, strict left alignment on the 72px margin.
- No logo, no invented brand marks, icons or motifs. Do not imitate any real brand.`;
const NEUTRAL_VOICE = `NEUTRAL DEFAULT VOICE: clear, friendly, professional Turkish. Short sentences. No exaggeration, no claims, no numbers. Hashtags: at most 3 generic ones in the caption.`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `tokens.fileAssets`: brand file path -> asset id. */
export function fileAssetMap(tokens: Record<string, unknown>): Record<string, string> {
  const raw = tokens.fileAssets;
  if (!isRecord(raw)) return {};
  const out: Record<string, string> = {};
  for (const [file, id] of Object.entries(raw)) {
    if (
      typeof id === "string" &&
      /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(file) &&
      !file.includes("..")
    ) {
      out[file] = id;
    }
  }
  return out;
}

export function allowedNumbersOf(facts: unknown): string[] {
  if (!isRecord(facts) || !Array.isArray(facts.allowedNumbers)) return [];
  return facts.allowedNumbers
    .filter((n): n is string => typeof n === "string" || typeof n === "number")
    .map(String);
}

function profileMode(tokens: Record<string, unknown>): BrandMode {
  const status = typeof tokens.status === "string" ? tokens.status : "";
  return /provisional|geçici|draft|taslak|stand-?in/i.test(status) ? "provisional" : "approved";
}

/**
 * Resolver for `/brand/<file>` backed by API assets, cached on disk by asset id
 * (assets are immutable). Files without a mapping are "not found".
 */
export function createApiBrandResolver(
  api: StudioApi,
  files: Readonly<Record<string, string>>,
  cacheDir: string,
  signal?: AbortSignal,
): AssetResolver {
  const memory = new Map<string, Promise<Uint8Array | null>>();
  const load = (assetId: string): Promise<Uint8Array | null> => {
    let p = memory.get(assetId);
    if (!p) {
      p = (async () => {
        const file = path.join(cacheDir, assetId.replace(/[^A-Za-z0-9_-]/g, "_"));
        try {
          return new Uint8Array(await readFile(file));
        } catch {
          // not cached yet
        }
        try {
          const { bytes } = await api.downloadAsset(assetId, signal ? { signal } : {});
          await mkdir(cacheDir, { recursive: true });
          await writeFile(file, bytes).catch(() => undefined);
          return bytes;
        } catch {
          return null;
        }
      })();
      memory.set(assetId, p);
    }
    return p;
  };
  return {
    async resolve(urlPath) {
      if (!urlPath.startsWith("/brand/")) return null;
      const rel = decodeURIComponent(urlPath.slice("/brand/".length));
      const assetId = files[rel];
      const type = contentTypeFor(rel);
      if (!assetId || !type) return null;
      const body = await load(assetId);
      return body ? { body, contentType: type } : null;
    },
  };
}

export interface LoadBrandOptions {
  api: StudioApi;
  brandId: string;
  /** Profile version from the job payload; absent = the current approved one. */
  profileVersion?: number | undefined;
  cacheDir: string;
  signal?: AbortSignal;
}

export async function loadBrandContext(options: LoadBrandOptions): Promise<BrandContext> {
  const { api, brandId, signal } = options;
  const init = signal ? { signal } : undefined;
  const brand = await api.client.brands.get(brandId, init);
  let profile: BrandProfile | null = null;
  try {
    profile = options.profileVersion
      ? await api.client.brandProfiles.get(brandId, options.profileVersion, init)
      : await api.client.brandProfiles.current(brandId, init);
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
  if (profile && profile.status !== "approved") profile = null;
  return buildBrandContext({
    brand,
    profile,
    api,
    cacheDir: options.cacheDir,
    ...(signal ? { signal } : {}),
  });
}

export function buildBrandContext(input: {
  brand: Brand;
  profile: BrandProfile | null;
  api: StudioApi;
  cacheDir: string;
  signal?: AbortSignal;
}): BrandContext {
  const { brand, profile } = input;
  let fallbackReason: string | undefined;
  if (profile) {
    const raw = profile.tokens;
    try {
      const tokens = parseBrandTokens(raw);
      const files = fileAssetMap(raw);
      const { css, manifest } = generateBrandCss(tokens);
      const facts = raw.facts ?? null;
      const mode = profileMode(raw);
      const { fileAssets: _files, facts: _facts, ...promptTokens } = raw;
      const has = (p: string) => Boolean(files[p]);
      const logos: BrandLogo[] = Object.entries(tokens.logos)
        .filter(([, l]) => has(l.path))
        .map(([name, l]) => ({
          name,
          path: `/brand/${l.path}`,
          width: l.intrinsic?.[0] ?? null,
          height: l.intrinsic?.[1] ?? null,
          aspect: l.aspect ?? (l.intrinsic ? l.intrinsic[0] / l.intrinsic[1] : null),
          on: l.on ?? null,
        }));
      const images: BrandImageAsset[] = Object.entries(tokens.assets)
        .filter(([, a]) => has(a.path))
        .map(([name, a]) => ({
          name,
          path: `/brand/${a.path}`,
          note: typeof a.note === "string" ? a.note : "",
        }));
      const clear: Record<string, number> = {};
      for (const l of Object.values(tokens.logos)) {
        if (l.clearSpace !== undefined) clear[`/brand/${l.path}`] = l.clearSpace;
      }
      return {
        brand,
        profile,
        mode,
        label:
          mode === "provisional"
            ? `geçici marka profili v${profile.version} (onaylanmamış kaynaklardan türetildi)`
            : `onaylı marka profili v${profile.version}`,
        tokens,
        promptTokens,
        css,
        manifest,
        fontFamilies: brandFontFamilies(tokens),
        facts,
        allowedNumbers: allowedNumbersOf(facts),
        logos,
        images,
        designRules: profile.designRules,
        voice: profile.voice,
        logoClearSpaceByPath: clear,
        resolver: combineResolvers(
          createMemoryResolver({ "/brand/brand.css": css }),
          createApiBrandResolver(input.api, files, input.cacheDir, input.signal),
        ),
      };
    } catch (error) {
      fallbackReason = `marka profili v${profile.version} belirteçleri kullanılamadı (${(error as Error).message.slice(0, 200)})`;
    }
  } else {
    fallbackReason = "markanın onaylı bir profili yok";
  }
  const tokens = parseBrandTokens(NEUTRAL_TOKENS);
  const { css, manifest } = generateBrandCss(tokens);
  return {
    brand,
    profile,
    mode: "neutral",
    label: "nötr varsayılan tasarım (marka profili yok)",
    ...(fallbackReason ? { fallbackReason } : {}),
    tokens,
    promptTokens: NEUTRAL_TOKENS as unknown as Record<string, unknown>,
    css,
    manifest,
    fontFamilies: brandFontFamilies(tokens),
    facts: null,
    allowedNumbers: [],
    logos: [],
    images: [],
    designRules: NEUTRAL_DESIGN,
    voice: NEUTRAL_VOICE,
    logoClearSpaceByPath: {},
    resolver: createMemoryResolver({ "/brand/brand.css": css }),
  };
}
