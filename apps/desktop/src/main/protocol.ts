// The packaged renderer is served from `studio://app/…`. Requests under `/api/` are forwarded
// to the local API on 127.0.0.1 (same origin for the renderer, so no CORS; the API counts them
// as the Mac itself, like the AppKit app). WebSockets go straight to ws://127.0.0.1:<port>.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { apiTargetUrl, resolveAppFile } from "./protocol-paths.ts";

export const APP_SCHEME = "studio";
export const APP_ORIGIN = `${APP_SCHEME}://app`;

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

export function handleAppProtocol(rendererRoot: string, apiPort: () => number | null): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const port = apiPort();
    const target = port === null ? null : apiTargetUrl(request.url, port);
    if (new URL(request.url).pathname.startsWith("/api/")) {
      if (!target) {
        return new Response(
          JSON.stringify({
            error: { code: "unavailable", message: "Studio sunucusu hazır değil." },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        );
      }
      const headers = new Headers(request.headers);
      headers.delete("origin");
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
