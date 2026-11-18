// Pure helpers of the `studio://` protocol handler (tested without Electron).
import { normalize, resolve, sep } from "node:path";

/** The file under `root` for a request path; null when it would leave `root`. */
export function resolveAppFile(root: string, pathname: string): string | null {
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^([/\\])+/, "");
  const file = resolve(root, relative || "index.html");
  if (file !== root && !file.startsWith(root + sep)) return null;
  return file;
}

export function apiTargetUrl(requestUrl: string, apiPort: number): string | null {
  const url = new URL(requestUrl);
  if (!url.pathname.startsWith("/api/")) return null;
  return `http://127.0.0.1:${apiPort}${url.pathname}${url.search}`;
}

/** `scheme://host[:port]` of a URL, also for custom schemes (Node's URL says "null" for those). */
export function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.host ? `${parsed.protocol}//${parsed.host}` : null;
  } catch {
    return null;
  }
}

/**
 * Whether a request the app's own pages make must carry the owner secret (G1): HTTP or a
 * WebSocket to the local API (127.0.0.1 / localhost on its port), or, in development, the
 * renderer's own `/api/` (the Vite proxy forwards it to the API).
 */
export function needsOwnerHeader(
  url: string,
  apiPort: number | null,
  devOrigin: string | null,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    apiPort !== null &&
    (parsed.protocol === "http:" || parsed.protocol === "ws:") &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
    parsed.port === String(apiPort)
  ) {
    return true;
  }
  return devOrigin !== null && originOf(url) === devOrigin && parsed.pathname.startsWith("/api/");
}
