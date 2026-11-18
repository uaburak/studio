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
import { readFile, stat } from "node:fs/promises";
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

// --- one face's file (the post editor's engine shapes text with the font's own bytes) ----------

/** JXA: PostScript names → the font files they are in (NSFontDescriptor's file URL). */
export const APPKIT_FONT_FILES_SCRIPT = `ObjC.import('AppKit');
function run(argv) {
  const out = {};
  for (const ps of argv) {
    const font = $.NSFont.fontWithNameSize(ps, 12);
    if (font.isNil()) { out[ps] = null; continue; }
    const url = font.fontDescriptor.objectForKey($('NSCTFontFileURLAttribute'));
    out[ps] = url.isNil() ? null : url.path.js;
  }
  return JSON.stringify(out);
}`;

/** Largest font file handed to the renderer. */
export const MAX_FONT_FILE_BYTES = 64 * 1024 * 1024;

const tag = (b: Uint8Array, o: number) =>
  String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0);

/** The PostScript name (name ID 6) of the face whose table directory starts at `dir`. */
export function postscriptNameAt(bytes: Uint8Array, dir: number): string | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = view.getUint16(dir + 4);
  for (let i = 0; i < tables; i++) {
    const rec = dir + 12 + i * 16;
    if (tag(bytes, rec) !== "name") continue;
    const base = view.getUint32(rec + 8);
    const count = view.getUint16(base + 2);
    const strings = base + view.getUint16(base + 4);
    for (let j = 0; j < count; j++) {
      const r = base + 6 + j * 12;
      const platform = view.getUint16(r);
      const nameId = view.getUint16(r + 6);
      if (nameId !== 6) continue;
      const length = view.getUint16(r + 8);
      const offset = strings + view.getUint16(r + 10);
      const raw = bytes.subarray(offset, offset + length);
      if (platform === 3 || platform === 0) {
        let s = "";
        for (let k = 0; k + 1 < raw.length; k += 2)
          s += String.fromCharCode(((raw[k] ?? 0) << 8) | (raw[k + 1] ?? 0));
        return s;
      }
      return new TextDecoder("latin1").decode(raw);
    }
  }
  return null;
}

/**
 * One face of a font file as a standalone font: the file itself, or — for a collection
 * (.ttc / .otc) — the face named `postscriptName`, its tables copied into a file of its own.
 */
export function faceOfFile(bytes: Uint8Array, postscriptName: string): Uint8Array | null {
  if (bytes.length < 12) return null;
  if (tag(bytes, 0) !== "ttcf") return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const faces = view.getUint32(8);
  for (let i = 0; i < faces; i++) {
    const dir = view.getUint32(12 + i * 4);
    if (postscriptNameAt(bytes, dir) !== postscriptName) continue;
    const count = view.getUint16(dir + 4);
    const records = Array.from({ length: count }, (_, k) => {
      const rec = dir + 12 + k * 16;
      return { rec, offset: view.getUint32(rec + 8), length: view.getUint32(rec + 12) };
    });
    const header = 12 + count * 16;
    const size = records.reduce((n, r) => n + ((r.length + 3) & ~3), header);
    const out = new Uint8Array(size);
    const w = new DataView(out.buffer);
    out.set(bytes.subarray(dir, dir + header), 0);
    let at = header;
    records.forEach((r, k) => {
      out.set(bytes.subarray(r.offset, r.offset + r.length), at);
      w.setUint32(12 + k * 16 + 8, at);
      at += (r.length + 3) & ~3;
    });
    return out;
  }
  return null;
}

export interface FontFileDeps {
  /** PostScript names → file paths (null: not installed). */
  locate(postscriptNames: string[]): Promise<Record<string, string | null>>;
  read(path: string): Promise<Uint8Array>;
}

export function defaultFontFileDeps(): FontFileDeps {
  return {
    locate: (names) =>
      new Promise((resolve, reject) => {
        execFile(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-e", APPKIT_FONT_FILES_SCRIPT, ...names],
          { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
          (error, stdout) =>
            error ? reject(error) : resolve(JSON.parse(String(stdout)) as Record<string, string>),
        );
      }),
    read: async (path) => new Uint8Array(await readFile(path)),
  };
}

/** A face's bytes by PostScript name (cached paths; files are read each time, faces sliced). */
export class FontFiles {
  private paths = new Map<string, string | null>();

  constructor(private readonly deps: FontFileDeps = defaultFontFileDeps()) {}

  async read(postscriptName: string): Promise<Uint8Array | null> {
    if (!/^[\w .-]{1,128}$/.test(postscriptName)) return null;
    if (!this.paths.has(postscriptName)) {
      const found = await this.deps.locate([postscriptName]).catch(() => ({}));
      this.paths.set(
        postscriptName,
        (found as Record<string, string | null>)[postscriptName] ?? null,
      );
    }
    const path = this.paths.get(postscriptName);
    if (!path || !/\.(ttf|otf|ttc|otc|dfont)$/i.test(path)) return null;
    const bytes = await this.deps.read(path).catch(() => null);
    if (!bytes || bytes.length > MAX_FONT_FILE_BYTES) return null;
    return faceOfFile(bytes, postscriptName);
  }
}
