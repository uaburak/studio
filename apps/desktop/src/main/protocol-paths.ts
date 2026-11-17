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
