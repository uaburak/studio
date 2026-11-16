/**
 * Asset resolvers back the renderer's virtual origins (`/brand/…`, `/media/…`).
 * Local folders now; an R2-backed resolver later implements the same interface.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { isVirtualAssetUrl } from "../sanitize/url.ts";

export interface AssetResponse {
  body: Uint8Array;
  contentType: string;
}

export interface AssetResolver {
  /** `path` is the URL path (`/brand/fonts/a.woff2`). Return `null` for "not found". */
  resolve(path: string): Promise<AssetResponse | null>;
}

export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

export function contentTypeFor(path: string): string | null {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? null;
}

/**
 * Serve `/brand/…` and `/media/…` from local folders. Paths are validated, decoded and
 * confined to their root (symlinks included). Unknown file types are not served.
 */
export function createDirectoryResolver(roots: { brand?: string; media?: string }): AssetResolver {
  const realRoots = new Map<string, Promise<string>>();
  const rootReal = (dir: string) => {
    let p = realRoots.get(dir);
    if (!p) {
      p = realpath(dir);
      realRoots.set(dir, p);
    }
    return p;
  };
  return {
    async resolve(path) {
      if (!isVirtualAssetUrl(path)) return null;
      const prefix = path.startsWith("/brand/") ? "brand" : "media";
      const dir = roots[prefix];
      if (!dir) return null;
      const rel = decodeURIComponent(path.slice(prefix.length + 2));
      const type = contentTypeFor(rel);
      if (!type) return null;
      try {
        const base = await rootReal(dir);
        const file = await realpath(join(base, rel));
        if (!file.startsWith(base + sep)) return null;
        if (!(await stat(file)).isFile()) return null;
        return { body: new Uint8Array(await readFile(file)), contentType: type };
      } catch {
        return null;
      }
    },
  };
}

/** In-memory files keyed by URL path (`/brand/brand.css`). Handy for generated CSS and tests. */
export function createMemoryResolver(
  files: Readonly<Record<string, Uint8Array | string>>,
): AssetResolver {
  const enc = new TextEncoder();
  return {
    async resolve(path) {
      const f = files[path];
      if (f === undefined || !isVirtualAssetUrl(path)) return null;
      return {
        body: typeof f === "string" ? enc.encode(f) : f,
        contentType: contentTypeFor(path) ?? "application/octet-stream",
      };
    },
  };
}

/** First resolver that has the file wins. */
export function combineResolvers(...resolvers: readonly AssetResolver[]): AssetResolver {
  return {
    async resolve(path) {
      for (const r of resolvers) {
        const res = await r.resolve(path);
        if (res) return res;
      }
      return null;
    },
  };
}
