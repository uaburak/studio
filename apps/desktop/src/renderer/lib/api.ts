// The typed API client of the renderer. HTTP goes to the page's own origin (`/api/…`): the
// Vite dev proxy or the `studio://` protocol forwards it to the local API. WebSockets connect
// straight to ws://127.0.0.1:<apiPort>. The main process adds the app's owner secret to both
// (the page never sees it), which is what makes the API count them as the Mac itself.
import { type ApiClient, createApiClient } from "@studio/contract";
import { createContext, useContext } from "react";

/** ws(s)://<anything>/api/… → ws://127.0.0.1:<port>/api/… */
export function rewriteSocketUrl(url: string, port: number): string {
  const parsed = new URL(url, "http://placeholder");
  return `ws://127.0.0.1:${port}${parsed.pathname}${parsed.search}`;
}

export function socketClassFor(port: () => number | null): typeof WebSocket {
  const Base = globalThis.WebSocket;
  return class ApiWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      const p = port() ?? 8790;
      super(rewriteSocketUrl(String(url), p), protocols);
    }
  } as typeof WebSocket;
}

export function createStudioClient(port: () => number | null): ApiClient {
  return createApiClient({ baseUrl: "", WebSocket: socketClassFor(port) });
}

export const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (!client) throw new Error("ApiContext missing");
  return client;
}

/** `<img src>` of an asset's bytes (same origin). */
export function assetUrl(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}/content`;
}

export function imageUrl(image: { assetId: string; url?: string | undefined }): string {
  return image.url ?? assetUrl(image.assetId);
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.replace(/^\/api\/[^:]*: /, "");
    if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
      return "Studio sunucusuna ulaşılamadı.";
    }
    return message;
  }
  return String(error);
}
