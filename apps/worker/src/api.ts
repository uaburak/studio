/**
 * The worker's HTTP side of the API: the typed contract client (with the worker
 * token for `/api/worker/runs/...`) plus raw asset download.
 */
import { type ApiClient, ApiError, assetContentPath, createApiClient } from "@studio/contract";

export interface StudioApi {
  client: ApiClient;
  baseUrl: string;
  /** Bytes of an asset (`GET /api/assets/{id}/content`), refusing anything above `maxBytes`. */
  downloadAsset(
    assetId: string,
    options?: { maxBytes?: number; signal?: AbortSignal },
  ): Promise<{ bytes: Uint8Array; contentType: string }>;
}

export interface StudioApiOptions {
  baseUrl: string;
  workerToken?: string | undefined;
  fetch?: typeof fetch;
}

/** `ws://host/api/hub` -> `http://host`. */
export function apiBaseFromHubUrl(hubUrl: string): string {
  return hubUrl.replace(/^ws/i, "http").replace(/\/api\/hub\/?$/, "");
}

export function createStudioApi(options: StudioApiOptions): StudioApi {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const client = createApiClient({
    baseUrl,
    fetch: doFetch,
    ...(options.workerToken ? { workerToken: options.workerToken } : {}),
  });
  return {
    client,
    baseUrl,
    async downloadAsset(assetId, opts = {}) {
      const headers: Record<string, string> = {};
      if (options.workerToken) headers.authorization = `Bearer ${options.workerToken}`;
      const res = await doFetch(`${baseUrl}${assetContentPath(assetId)}`, {
        headers,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if (!res.ok) {
        throw new ApiError(`asset ${assetId}: HTTP ${res.status}`, res.status);
      }
      const max = opts.maxBytes ?? 25 * 1024 * 1024;
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > max) {
        await res.body?.cancel();
        throw new ApiError(`asset ${assetId} is too large (${declared} bytes)`, 413);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > max) {
        throw new ApiError(`asset ${assetId} is too large (${bytes.byteLength} bytes)`, 413);
      }
      return {
        bytes,
        contentType: res.headers.get("content-type") ?? "application/octet-stream",
      };
    },
  };
}

/** True for errors worth retrying (network, 5xx, 429). */
export function isTransientApiError(error: unknown): boolean {
  if (error instanceof ApiError) {
    return error.status === undefined || error.status >= 500 || error.status === 429;
  }
  return error instanceof TypeError; // fetch failed
}
