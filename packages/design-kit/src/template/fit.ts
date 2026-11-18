/**
 * Fitting a new text into a template's text layer (N9 auto-fit): how small its font must get so
 * the text stays inside the box the source text had — the layout stays exactly, only the size
 * goes down, never below the floor (the contract's minimum for the role, or 60 % of the source
 * size, whichever is larger).
 *
 * The estimate wraps the words greedily with the average character advance the source's
 * laid-out lines had (canvas facts: Wecra's own text engine). The HTML path measures in Chromium
 * instead (the worker's render loop) and uses this only for the hint (`maxChars`).
 */
import { CONTRACT_LIMITS } from "../contract/constants.ts";

export interface TextBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a text layer was laid out in the source (`TemplateTextMetrics` of @studio/contract). */
export interface TextMetrics {
  box: TextBox;
  /** px */
  fontSize: number | null;
  /** px */
  lineHeight: number | null;
  /** Average advance of one character at `fontSize`, px. */
  charWidth: number | null;
  lines: number;
  autoResize: "none" | "height" | "width-and-height" | null;
}

/** Share of the source size auto-fit may shrink a text to. */
export const AUTO_FIT_MIN_SCALE = 0.6;
/** Typical advance of a character relative to the font size (when nothing was measured). */
const DEFAULT_ADVANCE = 0.55;
const DEFAULT_LINE_HEIGHT = 1.2;
/** Estimates err on the safe side (kerning, wider glyphs). */
const SAFETY = 1.04;

/** The contract's smallest size for a text of this role. */
export function contractMinFontSize(role: string | null): number {
  if (role === "legal") return CONTRACT_LIMITS.legalMinFontSize;
  if (role === "body" || role === "caption") return CONTRACT_LIMITS.bodyFontSize;
  return CONTRACT_LIMITS.minFontSize;
}

/** The smallest size auto-fit gives a text whose source size was `fontSize`. */
export function autoFitFloor(role: string | null, fontSize: number | null): number {
  const contract = contractMinFontSize(role);
  if (fontSize === null || !Number.isFinite(fontSize) || fontSize <= 0) return contract;
  return Math.min(fontSize, Math.max(contract, Math.round(fontSize * AUTO_FIT_MIN_SCALE)));
}

/** Lines a text takes with `perLine` characters per line (words wrap whole; long words break). */
export function wrapLines(text: string, perLine: number): string[] {
  const width = Math.max(1, Math.floor(perLine));
  const out: string[] = [];
  for (const paragraph of text.replace(/\r\n?/g, "\n").split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (let word of words) {
      while (word.length > width) {
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!word) continue;
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line = `${line} ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

function advance(m: TextMetrics, size: number): number {
  const base = m.fontSize ?? size;
  const perChar = m.charWidth ?? base * DEFAULT_ADVANCE;
  return (perChar / base) * size * SAFETY;
}

function lineHeight(m: TextMetrics, size: number): number {
  const base = m.fontSize ?? size;
  return ((m.lineHeight ?? base * DEFAULT_LINE_HEIGHT) / base) * size;
}

/** The text fits the source box at `size` (the estimate). */
export function fitsAt(m: TextMetrics, text: string, size: number): boolean {
  const perLine = m.box.w / advance(m, size);
  const lines = wrapLines(text, perLine);
  const height = lines.length * lineHeight(m, size);
  // Rounding of the box (whole px) and of the source's own last line.
  if (height > m.box.h + 1) return false;
  if (m.autoResize === "width-and-height") {
    const longest = Math.max(...lines.map((l) => l.length));
    if (longest * advance(m, size) > m.box.w + 2) return false;
  }
  return true;
}

export interface FitResult {
  /** The size to give the text (px): the source size when it fits as it is. */
  size: number;
  /** It fits at `size` (false: even the floor overflows; the checks will say so). */
  fits: boolean;
  /** `size` differs from the source size. */
  shrunk: boolean;
}

/** The largest size ≤ the source size (≥ `floor`) at which `text` fits the source box. */
export function fitTextSize(m: TextMetrics, text: string, floor: number): FitResult | null {
  const source = m.fontSize;
  if (source === null || !Number.isFinite(source) || source <= 0) return null;
  if (m.box.w <= 0 || m.box.h <= 0) return null;
  if (fitsAt(m, text, source)) return { size: source, fits: true, shrunk: false };
  const min = Math.min(source, Math.max(1, floor));
  const step = Math.max(0.5, source * 0.02);
  for (let size = source - step; size > min; size -= step) {
    if (fitsAt(m, text, size)) {
      const rounded = Math.floor(size * 2) / 2;
      return { size: rounded, fits: true, shrunk: true };
    }
  }
  return { size: min, fits: fitsAt(m, text, min), shrunk: min < source };
}

/** About how many characters fit the box at the source size (the fill form's hint). */
export function textCapacity(m: TextMetrics): number | null {
  if (m.fontSize === null || m.box.w <= 0 || m.box.h <= 0) return null;
  const perLine = Math.max(1, Math.floor(m.box.w / advance(m, m.fontSize)));
  const lines = Math.max(1, Math.floor((m.box.h + 1) / lineHeight(m, m.fontSize)));
  return Math.max(1, perLine * lines);
}
