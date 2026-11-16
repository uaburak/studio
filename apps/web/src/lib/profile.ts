/**
 * Helpers for brand profile tokens (`brand.json` equivalent). Tokens are a
 * free-form JSON object; we only read conventional shapes for display.
 */

const COLOR_RE =
  /^(#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch)\([^)]*\))$/i;

export function isColorValue(value: unknown): value is string {
  return typeof value === "string" && COLOR_RE.test(value.trim());
}

export interface TokenEntry {
  /** Dotted path inside the tokens object, e.g. `colors.primary`. */
  path: string;
  value: string;
}

/** Walk the tokens depth-first and collect leaf values matching `predicate`. */
function collect(
  value: unknown,
  predicate: (path: string, leaf: unknown) => boolean,
  path: string,
  out: TokenEntry[],
  limit: number,
) {
  if (out.length >= limit) return;
  if (value !== null && typeof value === "object") {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries) {
      collect(child, predicate, path ? `${path}.${key}` : key, out, limit);
    }
    return;
  }
  if (predicate(path, value)) out.push({ path, value: String(value).trim() });
}

/** Colour leaves anywhere in the tokens (for swatches). */
export function extractColorTokens(tokens: Record<string, unknown>, limit = 24): TokenEntry[] {
  const out: TokenEntry[] = [];
  collect(tokens, (_, leaf) => isColorValue(leaf), "", out, limit);
  return out;
}

/** String leaves whose path mentions font/typeface (for the type specimen). */
export function extractFontTokens(tokens: Record<string, unknown>, limit = 8): TokenEntry[] {
  const out: TokenEntry[] = [];
  collect(
    tokens,
    (path, leaf) =>
      typeof leaf === "string" && /font|typeface|family/i.test(path) && !isColorValue(leaf),
    "",
    out,
    limit,
  );
  return out;
}

export type ParsedTokens =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

/** Parse the tokens editor text: must be a JSON object. */
export function parseTokens(text: string): ParsedTokens {
  if (!text.trim()) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Geçerli JSON değil: ${(error as Error).message}` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "Belirteçler bir JSON nesnesi olmalı ({ ... })." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

/** Starting point for the first profile version. */
export const TOKEN_TEMPLATE = {
  colors: { primary: "#1b1a17", accent: "#df4325", background: "#f4f1ea" },
  fonts: { heading: "Instrument Serif", body: "Geist" },
  radius: 12,
  spacing: 8,
};
