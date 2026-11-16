import { VIRTUAL_PREFIXES, type VirtualPrefix } from "../contract/constants.ts";

/**
 * Asset URL policy. A design may only reference root-relative paths on the virtual
 * origins the renderer serves (`/brand/…`, `/media/…`). No scheme, no host, no query,
 * no fragment, no `..`, no backslashes, no whitespace, no `data:`.
 */
const SAFE_PATH = /^\/[A-Za-z0-9._~\-/%+@=,]*$/;

export function isVirtualAssetUrl(
  url: string,
  prefixes: readonly string[] = VIRTUAL_PREFIXES,
): boolean {
  if (typeof url !== "string" || url.length === 0 || url.length > 1024) return false;
  if (!SAFE_PATH.test(url)) return false;
  if (url.startsWith("//")) return false;
  if (!prefixes.some((p) => url.startsWith(p))) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    return false;
  }
  // A decoded space is fine (file names); control characters, backslashes, ? and # are not.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
  if (/[\\\u0000-\u001f\u007f?#]/.test(decoded)) return false;
  const segments = decoded.split("/");
  if (segments.some((s) => s === ".." || s === ".")) return false;
  if (decoded.includes("//")) return false;
  return true;
}

/** `#id` references (SVG paint servers, clip paths, filters) never hit the network. */
export function isFragmentUrl(url: string): boolean {
  return /^#[A-Za-z_][A-Za-z0-9_.:-]*$/.test(url.trim());
}

export function virtualPrefixOf(url: string): VirtualPrefix | null {
  return VIRTUAL_PREFIXES.find((p) => url.startsWith(p)) ?? null;
}
