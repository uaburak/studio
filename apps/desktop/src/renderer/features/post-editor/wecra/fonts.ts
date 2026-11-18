// Where Wecra's text engine gets its fonts in Studio (Wecra's FontSource): Wecra's own Inter
// (bundled), the fonts installed on this Mac (Studio's font list; a face's bytes from the main
// process, `fonts:read`), and the brand's uploaded font files — TTF / OTF as they are, WOFF / WOFF2
// decoded to the sfnt they wrap (font-files.ts: the engine reads sfnt fonts only; E9). A text whose
// family is none of these draws in Inter and Wecra's Design panel says "Missing fonts", as in
// Wecra (the post can't become a version then: missing-fonts.ts).
//
// Which wins when the Mac has the brand's family installed too — as brand.css decides for the
// worker's render (design-kit `fontFaces` / `fontStack`): a role marked `system` (the brand says
// "the installed font") uses the installed family, its files only stand in on a Mac without it;
// any other role's files are the family (brand.css declares them under the family's own name, and
// an @font-face beats a local font of the same name), so the installed faces of it are left out.

import { resolveFontFile } from "@studio/design-kit/brand";
import {
  BUNDLED_FACES,
  type FontFaceInfo,
  type FontSource,
  fonts,
  mergeFaces,
} from "@/engine/fonts";
import type { RenderKit } from "../model/brand-kit.ts";
import { assetContentUrl } from "../model/brand-kit.ts";
import { toSfnt } from "./font-files.ts";

const SYSTEM = "studio-system:";
const FILE = "studio-file:";

const STYLE_NAMES: [number, string][] = [
  [100, "Thin"],
  [200, "Extra Light"],
  [300, "Light"],
  [400, "Regular"],
  [500, "Medium"],
  [600, "Semi Bold"],
  [700, "Bold"],
  [800, "Extra Bold"],
  [900, "Black"],
];

function styleName(weight: number, italic: boolean): string {
  const base = STYLE_NAMES.reduce((best, s) =>
    Math.abs(s[0] - weight) < Math.abs(best[0] - weight) ? s : best,
  )[1];
  if (!italic) return base;
  return base === "Regular" ? "Italic" : `${base} Italic`;
}

/** The font files the engine can take (WOFF / WOFF2 are decoded when read). */
const FONT_FILE = /\.(ttf|otf|woff2?)$/i;

/** The brand's uploaded font files as faces of their role's family. */
export function brandFileFaces(kit: Pick<RenderKit, "tokens" | "files">): FontFaceInfo[] {
  const out: FontFaceInfo[] = [];
  for (const role of Object.values(kit.tokens.font)) {
    for (const file of role.files ?? []) {
      const resolved = resolveFontFile(file, role);
      const assetId = kit.files[resolved.path];
      if (!assetId || !FONT_FILE.test(resolved.path)) continue;
      // "700", or a variable file's range "100 900" (its lightest weight names it).
      const range = (resolved.weight ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter(Number.isFinite);
      const weight = range[0] ?? 400;
      const italic = resolved.style === "italic";
      out.push({
        id: `${FILE}${assetId}`,
        family: role.family,
        style: styleName(weight, italic),
        weight,
        italic,
        source: "user",
        collectionIndex: 0,
        ...(range.length > 1 ? { variable: true } : {}),
      });
    }
  }
  return out;
}

/**
 * The installed faces and the brand's files, by brand.css's rule (see the top): a `system` role's
 * family is the installed one when it is there (its files stand in otherwise); any other role's
 * files are the family, the installed faces of it are left out.
 */
export function precedence(
  installed: readonly FontFaceInfo[],
  kit: Pick<RenderKit, "tokens" | "files"> | null,
): FontFaceInfo[] {
  const files = kit ? brandFileFaces(kit) : [];
  if (!kit || files.length === 0) return [...installed];
  const lower = (f: { family: string }) => f.family.toLowerCase();
  const system = new Set(
    Object.values(kit.tokens.font)
      .filter((r) => r.system)
      .map(lower),
  );
  const have = new Set(installed.map(lower));
  const brandOwned = new Set(files.map(lower).filter((f) => !system.has(f)));
  return [
    ...installed.filter((f) => !brandOwned.has(lower(f))),
    ...files.filter((f) => brandOwned.has(lower(f)) || !have.has(lower(f))),
  ];
}

/** Studio's font source for Wecra's engine. */
export function studioFontSource(kit: Pick<RenderKit, "tokens" | "files"> | null): FontSource {
  return {
    async list() {
      const local: FontFaceInfo[] = [];
      const bridge = typeof window !== "undefined" ? window.studio?.fonts : undefined;
      if (bridge?.read) {
        try {
          const installed = await bridge.list();
          for (const family of installed.families)
            for (const style of family.styles)
              local.push({
                id: `${SYSTEM}${style.postscriptName}`,
                family: family.family,
                style: style.name,
                postscriptName: style.postscriptName,
                weight: style.weight,
                italic: style.italic,
                source: "system",
                collectionIndex: 0,
              });
        } catch {
          // the bundled Inter and the brand's files still work
        }
      }
      return mergeFaces(precedence(local, kit));
    },
    async read(face) {
      if (face.id.startsWith(SYSTEM)) {
        const bytes = await window.studio?.fonts?.read?.(face.id.slice(SYSTEM.length));
        if (!bytes) throw new Error(`no font ${face.family} ${face.style}`);
        return new Uint8Array(bytes);
      }
      if (face.id.startsWith(FILE)) {
        const res = await fetch(assetContentUrl(face.id.slice(FILE.length)));
        if (!res.ok) throw new Error(`no font ${face.family} ${face.style}`);
        // WOFF / WOFF2 as the sfnt they wrap (the engine reads no other).
        return toSfnt(new Uint8Array(await res.arrayBuffer()));
      }
      if (BUNDLED_FACES.some((f) => f.id === face.id)) {
        const { defaultFontSource } = await import("@/engine/fonts");
        return defaultFontSource.read(face);
      }
      throw new Error(`no font ${face.family} ${face.style}`);
    },
  };
}

/** Wecra's font service reads from Studio's source for this brand (before the editor opens). */
export function installStudioFonts(kit: Pick<RenderKit, "tokens" | "files"> | null): void {
  fonts.setSource(studioFontSource(kit));
}
