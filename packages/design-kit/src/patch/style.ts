/**
 * Inline style editing for patch operations: an allow-list of properties with strict
 * value validators, and a minimal-diff editor for `style` attribute text.
 */
import { IMAGE_FITS } from "../contract/constants.ts";
import { parseDeclarationList } from "../html/css.ts";

const NUM = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)`;
const re = (s: string) => new RegExp(`^${s}$`);
const PX = re(`${NUM}px|0`);
const NONNEG_PX = re(String.raw`(?:\d+(?:\.\d+)?|\.\d+)px|0`);
const PERCENT = re(`${NUM}%`);
const TOKEN_NAME = /^[a-z][a-z0-9-]{0,47}$/;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB = re(
  String.raw`rgba?\(\s*\d{1,3}(?:\.\d+)?%?\s*(?:,\s*|\s+)\d{1,3}(?:\.\d+)?%?\s*(?:,\s*|\s+)\d{1,3}(?:\.\d+)?%?\s*(?:(?:,|\/)\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)`,
);
const HSL = re(
  String.raw`hsla?\(\s*${NUM}(?:deg)?\s*(?:,\s*|\s+)\d{1,3}(?:\.\d+)?%\s*(?:,\s*|\s+)\d{1,3}(?:\.\d+)?%\s*(?:(?:,|\/)\s*(?:0|1|0?\.\d+|\d{1,3}%)\s*)?\)`,
);
const COLOR_VAR = /^var\(--color-[a-z][a-z0-9-]{0,47}\)$/;
const COLOR_MIX =
  /^color-mix\(in (?:srgb|oklab|oklch|srgb-linear),\s*(?:var\(--color-[a-z][a-z0-9-]*\)|#[0-9a-fA-F]{3,8})(?:\s+\d{1,3}(?:\.\d+)?%)?,\s*(?:var\(--color-[a-z][a-z0-9-]*\)|#[0-9a-fA-F]{3,8}|transparent)(?:\s+\d{1,3}(?:\.\d+)?%)?\)$/;

export function isColorValue(v: string): boolean {
  const s = v.trim();
  return (
    HEX.test(s) ||
    RGB.test(s) ||
    HSL.test(s) ||
    COLOR_VAR.test(s) ||
    COLOR_MIX.test(s) ||
    s === "transparent" ||
    s.toLowerCase() === "currentcolor"
  );
}

/** A literal colour (not a token), for `setColor { literal }`. */
export function isColorLiteral(v: string): boolean {
  const s = v.trim();
  return HEX.test(s) || RGB.test(s) || HSL.test(s) || s === "transparent";
}

const oneOf =
  (...values: string[]) =>
  (v: string) =>
    values.includes(v);
const numberIn = (min: number, max: number) => (v: string) => {
  if (!re(NUM).test(v)) return false;
  const n = Number(v);
  return n >= min && n <= max;
};
const pxIn = (min: number, max: number) => (v: string) => {
  if (!PX.test(v)) return false;
  const n = Number.parseFloat(v);
  return n >= min && n <= max;
};
const lengthOrAuto = (v: string) => v === "auto" || pxIn(-10000, 10000)(v);
const sizeOrAuto = (v: string) =>
  v === "auto" ||
  (NONNEG_PX.test(v) && Number.parseFloat(v) <= 10000) ||
  (PERCENT.test(v) && Number.parseFloat(v) >= 0);
const positionComponent = (v: string) =>
  ["left", "center", "right", "top", "bottom"].includes(v) || PX.test(v) || PERCENT.test(v);

const FONT_TOKEN = /^var\(--font-[a-z][a-z0-9-]{0,47}\)$/;
/** A family installed on the Mac, quoted: `"Futura"`, `'SF Pro Display'`. */
const QUOTED_FAMILY = /^(?:"[A-Za-z0-9][A-Za-z0-9 .-]{0,63}"|'[A-Za-z0-9][A-Za-z0-9 .-]{0,63}')$/;
const GENERIC_FAMILIES = new Set(["serif", "sans-serif", "monospace", "system-ui", "cursive"]);

/**
 * `var(--font-<role>)` (a brand font), or an editor-picked installed family: one quoted name,
 * then at most two more quoted names or generic families (`"Futura", "Avenir Next", sans-serif`).
 */
function isFontFamily(v: string): boolean {
  if (FONT_TOKEN.test(v)) return true;
  const parts = v.split(",").map((p) => p.trim());
  if (parts.length > 3 || !QUOTED_FAMILY.test(parts[0] ?? "")) return false;
  return parts.slice(1).every((p) => QUOTED_FAMILY.test(p) || GENERIC_FAMILIES.has(p));
}

const FILTER_FUNCTION = new RegExp(
  String.raw`^(?:(?:brightness|contrast|saturate|grayscale|sepia|invert)\((?:\d+(?:\.\d+)?)%?\)|hue-rotate\(${NUM}deg\)|blur\((?:\d+(?:\.\d+)?)px\))$`,
);

/**
 * Picture adjustments as a CSS `filter`: up to six of brightness / contrast / saturate /
 * grayscale / sepia / invert (0–400 or 0–400 %), hue-rotate (deg) and blur (≤ 50 px), or `none`.
 */
function isFilter(v: string): boolean {
  if (v === "none") return true;
  const fns = v.match(/[a-z-]+\([^)]*\)/g) ?? [];
  if (fns.length === 0 || fns.length > 6 || fns.join(" ") !== v.replace(/\s+/g, " ").trim())
    return false;
  return fns.every((f) => {
    if (!FILTER_FUNCTION.test(f)) return false;
    const n = Number.parseFloat(f.slice(f.indexOf("(") + 1));
    if (f.startsWith("blur")) return n <= 50;
    if (f.startsWith("hue-rotate")) return Math.abs(n) <= 360;
    return f.includes("%") ? n <= 400 : n <= 4;
  });
}

/** Allowed inline style properties and their validators. */
export const STYLE_PROPERTIES: Record<string, (value: string) => boolean> = {
  left: lengthOrAuto,
  top: lengthOrAuto,
  right: lengthOrAuto,
  bottom: lengthOrAuto,
  width: sizeOrAuto,
  height: sizeOrAuto,
  "max-width": sizeOrAuto,
  translate: (v) => {
    const p = v.split(/\s+/);
    return p.length >= 1 && p.length <= 2 && p.every((x) => pxIn(-10000, 10000)(x));
  },
  rotate: (v) => re(`${NUM}deg`).test(v) && Math.abs(Number.parseFloat(v)) <= 360,
  scale: (v) => {
    const p = v.split(/\s+/);
    return p.length >= 1 && p.length <= 2 && p.every((x) => numberIn(-20, 20)(x));
  },
  color: isColorValue,
  "background-color": isColorValue,
  "border-color": isColorValue,
  "font-family": isFontFamily,
  "font-size": pxIn(1, 1000),
  "font-weight": (v) =>
    v === "normal" || v === "bold" || (/^\d{1,4}$/.test(v) && Number(v) >= 1 && Number(v) <= 1000),
  "font-style": oneOf("normal", "italic"),
  "font-stretch": (v) =>
    PERCENT.test(v) && Number.parseFloat(v) >= 50 && Number.parseFloat(v) <= 200,
  "line-height": (v) => v === "normal" || numberIn(0.5, 4)(v) || pxIn(1, 2000)(v),
  "letter-spacing": (v) =>
    v === "normal" ||
    (re(`${NUM}em`).test(v) && Math.abs(Number.parseFloat(v)) <= 1) ||
    pxIn(-100, 100)(v),
  "text-align": oneOf("left", "right", "center", "justify", "start", "end"),
  "text-transform": oneOf("none", "uppercase", "lowercase", "capitalize"),
  "text-wrap": oneOf("wrap", "nowrap", "balance", "pretty", "stable"),
  "white-space": oneOf("normal", "nowrap", "pre-line"),
  opacity: numberIn(0, 1),
  "border-radius": (v) =>
    pxIn(0, 10000)(v) ||
    /^var\(--radius-[a-z][a-z0-9-]{0,47}\)$/.test(v) ||
    (PERCENT.test(v) && Number.parseFloat(v) >= 0 && Number.parseFloat(v) <= 50),
  "object-fit": (v) => (IMAGE_FITS as readonly string[]).includes(v),
  "object-position": (v) => {
    const p = v.split(/\s+/);
    return p.length >= 1 && p.length <= 2 && p.every(positionComponent);
  },
  "mix-blend-mode": oneOf(
    "normal",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-burn",
    "color-dodge",
    "luminosity",
  ),
  "z-index": (v) => /^-?\d{1,4}$/.test(v),
  filter: isFilter,
  gap: (v) => pxIn(0, 2000)(v),
};

export function isAllowedStyle(property: string, value: string): boolean {
  const check = STYLE_PROPERTIES[property];
  return !!check && check(value.trim());
}

export function isTokenName(name: string): boolean {
  return TOKEN_NAME.test(name);
}

/** Format a number for CSS without float noise (max 4 decimals). */
export function num(n: number): string {
  const r = Math.round(n * 10000) / 10000;
  return Object.is(r, -0) ? "0" : String(r);
}

/**
 * Apply property changes to a declaration list with a minimal diff: existing declarations
 * keep their position and formatting, new ones are appended in the list's own style,
 * `null` removes a property.
 */
export function editDeclarations(
  css: string,
  changes: ReadonlyArray<readonly [string, string | null]>,
): string {
  let text = css;
  for (const [prop, value] of changes) {
    const decls = parseDeclarationList(text);
    const matches = decls.filter((d) => d.name === prop);
    if (value === null) {
      for (const d of [...matches].reverse()) {
        const all = parseDeclarationList(text);
        const i = all.findIndex((x) => x.start === d.start);
        const next = all[i + 1];
        const prev = all[i - 1];
        if (next) text = text.slice(0, d.start) + text.slice(next.start);
        else if (prev) {
          const prevEnd = text[prev.end - 1] === ";" ? prev.end - 1 : prev.end;
          text = text.slice(0, prevEnd) + text.slice(d.end).replace(/^\s+/, "");
        } else text = text.slice(0, d.start) + text.slice(d.end).replace(/^\s+/, "");
      }
      continue;
    }
    const last = matches[matches.length - 1];
    if (last) {
      text = text.slice(0, last.valueStart) + value + text.slice(last.valueEnd);
      continue;
    }
    const first = decls[0];
    const colonSpace = first ? /:\s/.test(text.slice(first.start, first.valueStart)) : true;
    const semiSpace =
      decls.length < 2 || /;\s/.test(text.slice(decls[0]?.start ?? 0, decls[1]?.start ?? 0));
    const trimmed = text.trimEnd();
    const decl = `${prop}:${colonSpace ? " " : ""}${value}`;
    if (trimmed === "") text = decl;
    else
      text = `${trimmed}${trimmed.endsWith(";") ? (semiSpace ? " " : "") : semiSpace ? "; " : ";"}${decl}`;
  }
  return text;
}
