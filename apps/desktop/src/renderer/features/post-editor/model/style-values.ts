// Inspector values ⇄ the CSS design-kit writes: picture adjustments as a `filter`, colours,
// font families and weights.

export interface Adjustments {
  /** −100…100 each; 0 is the picture as it is. */
  exposure: number;
  contrast: number;
  saturation: number;
  warmth: number;
}

export const NO_ADJUSTMENTS: Adjustments = { exposure: 0, contrast: 0, saturation: 0, warmth: 0 };

export const ADJUSTMENT_PRESETS: { label: string; value: Adjustments }[] = [
  { label: "Doğal", value: NO_ADJUSTMENTS },
  { label: "Sıcak hasat", value: { exposure: 6, contrast: 8, saturation: -4, warmth: 18 } },
  { label: "Canlı", value: { exposure: 4, contrast: 12, saturation: 22, warmth: 0 } },
];

const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

/** The adjustments as a design-kit-allowed CSS filter (null: none). */
export function filterCss(a: Adjustments): string | null {
  const parts: string[] = [];
  if (a.exposure) parts.push(`brightness(${round(1 + a.exposure / 200)})`);
  if (a.contrast) parts.push(`contrast(${round(1 + a.contrast / 200)})`);
  if (a.saturation) parts.push(`saturate(${round(1 + a.saturation / 100)})`);
  if (a.warmth > 0) parts.push(`sepia(${round(a.warmth / 250)})`);
  if (a.warmth) parts.push(`hue-rotate(${round(-a.warmth / 10, 1)}deg)`);
  return parts.length ? parts.join(" ") : null;
}

/** Reads a filter `filterCss` wrote (anything else counts as no adjustment). */
export function parseFilter(filter: string | null | undefined): Adjustments {
  const out = { ...NO_ADJUSTMENTS };
  if (!filter || filter === "none") return out;
  const fn = (name: string) => {
    const m = new RegExp(`${name}\\((-?[\\d.]+)`).exec(filter);
    return m ? Number(m[1]) : null;
  };
  const b = fn("brightness");
  const c = fn("contrast");
  const s = fn("saturate");
  const h = fn("hue-rotate");
  if (b !== null) out.exposure = Math.round((b - 1) * 200);
  if (c !== null) out.contrast = Math.round((c - 1) * 200);
  if (s !== null) out.saturation = Math.round((s - 1) * 100);
  if (h !== null) out.warmth = Math.round(-h * 10);
  return out;
}

/** `rgb(255, 106, 0)` / `rgba(…)` / `#ff6a00` → `#FF6A00` (null: not a colour we read). */
export function cssColorHex(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(v))
    return `#${v
      .slice(1)
      .split("")
      .map((c) => c + c)
      .join("")}`.toUpperCase();
  const m = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/i.exec(v);
  if (!m) return null;
  return `#${[m[1], m[2], m[3]]
    .map((n) =>
      Math.round(Math.min(255, Number(n)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`.toUpperCase();
}

/** The alpha of a computed colour (1 when opaque). */
export function cssColorAlpha(value: string | null | undefined): number {
  const m = /^rgba\([^)]*,\s*([\d.]+)\s*\)$/i.exec((value ?? "").trim());
  return m ? Number(m[1]) : (value ?? "").trim() === "transparent" ? 0 : 1;
}

/** The first family of a CSS `font-family` list, unquoted. */
export function primaryFamily(fontFamily: string | null | undefined): string | null {
  const first = (fontFamily ?? "")
    .split(",")[0]
    ?.trim()
    .replace(/^["']|["']$/g, "");
  return first || null;
}

/** A family as design-kit's `font-family` allow-list takes it (quoted, safe characters). */
export function familyCss(
  family: string,
  fallback: "sans-serif" | "serif" = "sans-serif",
): string | null {
  const name = family.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 .-]{0,63}$/.test(name)) return null;
  return `"${name}", ${fallback}`;
}

export const WEIGHTS: { value: number; label: string }[] = [
  { value: 100, label: "Thin" },
  { value: 200, label: "Extra Light" },
  { value: 300, label: "Light" },
  { value: 400, label: "Regular" },
  { value: 500, label: "Medium" },
  { value: 600, label: "Semibold" },
  { value: 700, label: "Bold" },
  { value: 800, label: "Extra Bold" },
  { value: 900, label: "Black" },
];
