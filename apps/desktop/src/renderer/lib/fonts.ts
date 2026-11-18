// Fonts installed on this Mac for the FontPicker: the main process lists them (AppKit, cached
// there); outside Electron (gallery, headless checks) the browser's `queryLocalFonts()` when it
// is allowed, else a short stand-in list. Recently picked families are remembered per viewer.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import {
  type InstalledFontFamily,
  type InstalledFontStyle,
  type InstalledFonts,
  isItalicStyle,
  sortStyles,
  weightFromStyle,
} from "../../shared/fonts.ts";
import { bridge } from "./bridge.ts";

export type {
  InstalledFontFamily,
  InstalledFontStyle,
  InstalledFonts,
} from "../../shared/fonts.ts";
export { defaultStyle, isKitFamilyName } from "../../shared/fonts.ts";

export const fontKeys = { installed: ["fonts", "installed"] as const };

const style = (name: string, postscriptName: string, weight: number, italic = false) => ({
  name,
  postscriptName,
  weight,
  italic,
});

/** Families every Mac has: what the picker shows outside Electron. */
export const SAMPLE_FONTS: InstalledFontFamily[] = [
  {
    family: "Avenir Next",
    styles: [
      style("Regular", "AvenirNext-Regular", 400),
      style("Italic", "AvenirNext-Italic", 400, true),
      style("Medium", "AvenirNext-Medium", 500),
      style("Demi Bold", "AvenirNext-DemiBold", 600),
      style("Bold", "AvenirNext-Bold", 700),
      style("Heavy", "AvenirNext-Heavy", 900),
    ],
  },
  {
    family: "Futura",
    styles: [
      style("Medium", "Futura-Medium", 500),
      style("Bold", "Futura-Bold", 700),
      style("Condensed ExtraBold", "Futura-CondensedExtraBold", 800),
    ],
  },
  {
    family: "Georgia",
    styles: [style("Regular", "Georgia", 400), style("Bold", "Georgia-Bold", 700)],
  },
  {
    family: "Helvetica Neue",
    styles: [
      style("Light", "HelveticaNeue-Light", 300),
      style("Regular", "HelveticaNeue", 400),
      style("Medium", "HelveticaNeue-Medium", 500),
      style("Bold", "HelveticaNeue-Bold", 700),
    ],
  },
  {
    family: "Menlo",
    styles: [style("Regular", "Menlo-Regular", 400), style("Bold", "Menlo-Bold", 700)],
  },
  {
    family: "New York",
    styles: [style("Regular", "NewYork-Regular", 400), style("Bold", "NewYork-Bold", 700)],
  },
  {
    family: "Times New Roman",
    styles: [
      style("Regular", "TimesNewRomanPSMT", 400),
      style("Bold", "TimesNewRomanPS-BoldMT", 700),
    ],
  },
];

interface LocalFontData {
  family: string;
  style: string;
  postscriptName: string;
}

/** `queryLocalFonts()` result → families. */
export function familiesFromLocalFonts(fonts: readonly LocalFontData[]): InstalledFontFamily[] {
  const map = new Map<string, InstalledFontStyle[]>();
  for (const f of fonts) {
    if (!f.family || f.family.startsWith(".")) continue;
    const list = map.get(f.family) ?? [];
    if (!list.some((s) => s.postscriptName === f.postscriptName)) {
      list.push({
        name: f.style || "Regular",
        postscriptName: f.postscriptName,
        weight: weightFromStyle(f.style || "Regular"),
        italic: isItalicStyle(f.style || ""),
      });
    }
    map.set(f.family, list);
  }
  return [...map.entries()]
    .map(([family, styles]) => ({ family, styles: sortStyles(styles) }))
    .sort((a, b) => a.family.localeCompare(b.family, "en", { sensitivity: "base" }));
}

async function browserFonts(): Promise<InstalledFonts> {
  const scannedAt = new Date().toISOString();
  const query = (window as { queryLocalFonts?: () => Promise<LocalFontData[]> }).queryLocalFonts;
  if (typeof query === "function") {
    try {
      const families = familiesFromLocalFonts(await query());
      if (families.length > 0) return { families, scannedAt, source: "local-font-access" };
    } catch {
      // Not allowed (no user gesture / permission): the sample list below.
    }
  }
  return {
    families: SAMPLE_FONTS,
    scannedAt,
    source: "sample",
    error: "Bu Mac'in yazı tipleri yalnızca Studio uygulamasında listelenir.",
  };
}

export async function loadInstalledFonts(refresh = false): Promise<InstalledFonts> {
  const fonts = bridge().fonts;
  if (fonts) return fonts.list(refresh ? { refresh: true } : undefined);
  return browserFonts();
}

/** The installed families (cached for the session; the main process watches font folders). */
export function useInstalledFonts() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: fontKeys.installed,
    queryFn: () => loadInstalledFonts(false),
    staleTime: 5 * 60_000,
  });
  const refresh = useCallback(async () => {
    const next = await loadInstalledFonts(true);
    queryClient.setQueryData(fontKeys.installed, next);
    return next;
  }, [queryClient]);
  return { ...query, refresh };
}

// --- recently used --------------------------------------------------------------------------------

const RECENT_KEY = "studio.fonts.recent";
export const MAX_RECENT_FONTS = 8;

export function recentFonts(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(raw)
      ? raw.filter((f): f is string => typeof f === "string").slice(0, MAX_RECENT_FONTS)
      : [];
  } catch {
    return [];
  }
}

export function rememberFont(family: string): string[] {
  const next = [family, ...recentFonts().filter((f) => f !== family)].slice(0, MAX_RECENT_FONTS);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage off: the list just is not kept.
  }
  return next;
}

/** CSS `font-family` that shows a family in its own face (quoted; system UI as the fallback). */
export function fontFace(family: string): string {
  return `"${family.replace(/["\\]/g, "")}", var(--font-sans, system-ui), sans-serif`;
}
