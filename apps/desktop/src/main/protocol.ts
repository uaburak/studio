// The packaged renderer is served from `studio://app/…`. Requests under `/api/` are forwarded
// to the local API on 127.0.0.1 with the app's owner secret (`X-Studio-Owner`), which makes the
// API treat them as the Mac itself (G1). Only this app's own pages can reach a `studio://` URL;
// a request that names another origin is refused here. WebSockets go straight to
// ws://127.0.0.1:<port>; the main process's webRequest hook adds the secret to those
// (see app.ts).
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { apiTargetUrl, resolveAppFile } from "./protocol-paths.ts";

export const APP_SCHEME = "studio";
export const APP_ORIGIN = `${APP_SCHEME}://app`;
export const OWNER_HEADER = "X-Studio-Owner";

export function registerSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

function problem(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function handleAppProtocol(
  rendererRoot: string,
  apiPort: () => number | null,
  ownerSecret: () => string,
): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const port = apiPort();
    const target = port === null ? null : apiTargetUrl(request.url, port);
    if (new URL(request.url).pathname.startsWith("/api/")) {
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== APP_ORIGIN) {
        return problem(403, "forbidden", "Bu istek Studio'nun kendi sayfasından gelmiyor.");
      }
      if (!target) return problem(503, "unavailable", "Studio sunucusu hazır değil.");
      const headers = new Headers(request.headers);
      // Checked above; the API sees the owner secret instead.
      headers.delete("origin");
      headers.set(OWNER_HEADER, ownerSecret());
      const hasBody = request.method !== "GET" && request.method !== "HEAD";
      return net.fetch(target, {
        method: request.method,
        headers,
        ...(hasBody ? { body: request.body, duplex: "half" } : {}),
      } as RequestInit);
    }
    const file = resolveAppFile(rendererRoot, new URL(request.url).pathname);
    if (!file) return new Response("Not found", { status: 404 });
    const response = await net.fetch(pathToFileURL(file).toString()).catch(() => null);
    if (response?.ok) return response;
    // Client-side routes fall back to the app shell.
    return net.fetch(pathToFileURL(resolve(rendererRoot, "index.html")).toString());
  });
}
