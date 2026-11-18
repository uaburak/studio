// Fonts installed on this Mac (Marka Kiti, the future post editor): what the main process lists
// through AppKit (NSFontManager) and the renderer shows in the FontPicker. Plain JSON only.

export interface InstalledFontStyle {
  /** Style name as macOS shows it: "Regular", "Demi Bold Italic". */
  name: string;
  /** PostScript name: "AvenirNext-DemiBoldItalic". */
  postscriptName: string;
  /** CSS weight 100 … 900. */
  weight: number;
  italic: boolean;
}

export interface InstalledFontFamily {
  /** Family name as CSS (and Chromium on the Mac) knows it: "Avenir Next". */
  family: string;
  /** Lightest first; upright before italic. */
  styles: InstalledFontStyle[];
}

export interface InstalledFonts {
  /** Sorted by family name. */
  families: InstalledFontFamily[];
  scannedAt: string;
  /**
   * `appkit`: the Mac's own font list (main process); `local-font-access`: the browser's
   * `queryLocalFonts()`; `sample`: a stand-in list outside Electron.
   */
  source: "appkit" | "local-font-access" | "sample";
  /** Why the list is empty or partial (Turkish). */
  error?: string;
}

export interface FontsBridge {
  /** Cached; rescanned when a font folder changed or with `refresh`. */
  list(options?: { refresh?: boolean }): Promise<InstalledFonts>;
}

export const FONTS_IPC = { list: "fonts:list" } as const;

const STYLE_WEIGHTS: [RegExp, number][] = [
  [/\b(hairline|thin)\b/i, 100],
  [/\b(extra|ultra)[\s-]?light\b/i, 200],
  [/\blight\b/i, 300],
  [/\b(semi|demi)[\s-]?bold\b/i, 600],
  [/\b(extra|ultra)[\s-]?bold\b/i, 800],
  [/\b(black|heavy|fat|poster)\b/i, 900],
  [/\bbold\b/i, 700],
  [/\bmedium\b/i, 500],
  [/\b(regular|book|roman|normal|plain|text)\b/i, 400],
];

/** AppKit's 0–15 weight scale (5 = regular, 9 = bold) as a CSS weight. */
export function cssWeightFromAppKit(weight: number): number {
  if (weight <= 2) return 100;
  if (weight === 3) return 200;
  if (weight === 4) return 300;
  if (weight === 5) return 400;
  if (weight <= 7) return 500;
  if (weight === 8) return 600;
  if (weight === 9) return 700;
  if (weight <= 11) return 800;
  return 900;
}

/** CSS weight of a style: from its name ("Semibold" → 600), else from AppKit's weight. */
export function weightFromStyle(name: string, appKitWeight?: number): number {
  const spaced = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  for (const [pattern, weight] of STYLE_WEIGHTS) if (pattern.test(spaced)) return weight;
  return appKitWeight === undefined ? 400 : cssWeightFromAppKit(appKitWeight);
}

export function isItalicStyle(name: string): boolean {
  return /\b(italic|oblique|kursiv)\b/i.test(name.replace(/([a-z])([A-Z])/g, "$1 $2"));
}

/** Lightest first, upright before italic, then by name. */
export function sortStyles(styles: InstalledFontStyle[]): InstalledFontStyle[] {
  return [...styles].sort(
    (a, b) =>
      a.weight - b.weight || Number(a.italic) - Number(b.italic) || a.name.localeCompare(b.name),
  );
}

/** The style a family is shown in by default: upright 400 (or the nearest upright one). */
export function defaultStyle(family: InstalledFontFamily): InstalledFontStyle | null {
  const upright = family.styles.filter((s) => !s.italic);
  const pool = upright.length > 0 ? upright : family.styles;
  let best: InstalledFontStyle | null = null;
  for (const style of pool) {
    if (!best || Math.abs(style.weight - 400) < Math.abs(best.weight - 400)) best = style;
  }
  return best;
}

/** Families the brand kit's contract accepts (letters, digits, spaces, dashes). */
export function isKitFamilyName(family: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N} -]{0,63}$/u.test(family);
}
