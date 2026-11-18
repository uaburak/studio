// Fonts installed on this Mac, listed from the main process.
//
// Source: AppKit's NSFontManager through `osascript -l JavaScript` (always present on macOS,
// ~0.4 s for a few hundred families): every family with its members — PostScript name, style
// name, AppKit weight (0–15) and traits. `system_profiler SPFontsDataType` gives the same but
// takes ~15 s; `fc-list` is not on a stock Mac; Chromium's `queryLocalFonts()` needs a
// permission prompt and a user gesture. Hidden system families (".SF NS") are left out.
//
// Cached in memory with a signature of the font folders' modification times: installing or
// removing a font (Font Book, a copy into ~/Library/Fonts) rescans on the next request.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type InstalledFontFamily,
  type InstalledFontStyle,
  type InstalledFonts,
  isItalicStyle,
  sortStyles,
  weightFromStyle,
} from "../shared/fonts.ts";

/** NSFontManager members: [postscriptName, styleName, weight 0–15, traits mask]. */
export const APPKIT_FONTS_SCRIPT = `ObjC.import('AppKit');
const fm = $.NSFontManager.sharedFontManager;
const fams = fm.availableFontFamilies;
const out = [];
for (let i = 0; i < fams.count; i++) {
  const fam = fams.objectAtIndex(i).js;
  const members = fm.availableMembersOfFontFamily(fam);
  const styles = [];
  const m = members.isNil() ? 0 : members.count;
  for (let j = 0; j < m; j++) {
    const mem = members.objectAtIndex(j);
    styles.push([mem.objectAtIndex(0).js, mem.objectAtIndex(1).js, mem.objectAtIndex(2).intValue, mem.objectAtIndex(3).intValue]);
  }
  out.push([fam, styles]);
}
JSON.stringify(out);`;

/** NSItalicFontMask. */
const ITALIC_TRAIT = 0x1;

/** `osascript` output → families (sorted, hidden ones and empty families left out). */
export function parseAppKitFonts(raw: string): InstalledFontFamily[] {
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) throw new Error("unexpected font list");
  const families = new Map<string, InstalledFontFamily>();
  for (const entry of data) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) continue;
    const family = entry[0].trim();
    if (!family || family.startsWith(".") || family === "LastResort") continue;
    const styles: InstalledFontStyle[] = [];
    const seen = new Set<string>();
    for (const member of entry[1] as unknown[]) {
      if (!Array.isArray(member)) continue;
      const [postscriptName, styleName, appKitWeight, traits] = member as [
        unknown,
        unknown,
        unknown,
        unknown,
      ];
      if (typeof postscriptName !== "string" || postscriptName.startsWith(".")) continue;
      if (seen.has(postscriptName)) continue;
      seen.add(postscriptName);
      const name = typeof styleName === "string" && styleName.trim() ? styleName.trim() : "Regular";
      const mask = typeof traits === "number" ? traits : 0;
      styles.push({
        name,
        postscriptName,
        weight: weightFromStyle(name, typeof appKitWeight === "number" ? appKitWeight : undefined),
        italic: (mask & ITALIC_TRAIT) !== 0 || isItalicStyle(name),
      });
    }
    if (styles.length === 0) continue;
    const existing = families.get(family);
    if (existing) existing.styles.push(...styles);
    else families.set(family, { family, styles });
  }
  return [...families.values()]
    .map((f) => ({ ...f, styles: sortStyles(f.styles) }))
    .sort((a, b) => a.family.localeCompare(b.family, "en", { sensitivity: "base" }));
}

export interface FontListerDeps {
  /** Runs the AppKit script and returns its stdout. */
  run(): Promise<string>;
  /** Signature of the font folders (changes when a font is installed or removed). */
  signature(): Promise<string>;
  now?: () => Date;
}

export const FONT_FOLDERS = [
  "/System/Library/Fonts",
  "/System/Library/Fonts/Supplemental",
  "/Library/Fonts",
  join(homedir(), "Library/Fonts"),
];

export function defaultFontListerDeps(): FontListerDeps {
  return {
    run: () =>
      new Promise((resolve, reject) => {
        execFile(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-e", APPKIT_FONTS_SCRIPT],
          { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 },
          (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
        );
      }),
    signature: async () => {
      const parts = await Promise.all(
        FONT_FOLDERS.map(async (dir) => {
          try {
            return `${dir}:${(await stat(dir)).mtimeMs}`;
          } catch {
            return `${dir}:-`;
          }
        }),
      );
      return parts.join("|");
    },
  };
}

export class FontLister {
  private cached: { signature: string; fonts: InstalledFonts } | null = null;
  private pending: Promise<InstalledFonts> | null = null;

  constructor(private readonly deps: FontListerDeps = defaultFontListerDeps()) {}

  async list(options: { refresh?: boolean } = {}): Promise<InstalledFonts> {
    if (this.pending) return this.pending;
    const signature = await this.deps.signature().catch(() => "");
    if (!options.refresh && this.cached && this.cached.signature === signature) {
      return this.cached.fonts;
    }
    this.pending = this.scan(signature).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async scan(signature: string): Promise<InstalledFonts> {
    const scannedAt = (this.deps.now?.() ?? new Date()).toISOString();
    try {
      const families = parseAppKitFonts(await this.deps.run());
      const fonts: InstalledFonts = { families, scannedAt, source: "appkit" };
      this.cached = { signature, fonts };
      return fonts;
    } catch (error) {
      // Keep serving the last good list; say why it could not be refreshed.
      const reason = `Yazı tipleri okunamadı: ${(error as Error).message.slice(0, 200)}`;
      if (this.cached) return { ...this.cached.fonts, error: reason };
      return { families: [], scannedAt, source: "appkit", error: reason };
    }
  }
}
