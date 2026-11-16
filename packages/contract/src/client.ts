import { HealthResponse } from "./health.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  /** Base URL of the API, e.g. "" (same origin) or "http://localhost:8787". */
  baseUrl?: string;
  fetch?: typeof fetch;
}

/**
 * Minimal typed client. Every response is validated against the contract
 * schema, so a server/client mismatch fails loudly instead of silently.
 */
export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  async function getJson(path: string, init?: RequestInit): Promise<unknown> {
    const res = await doFetch(`${baseUrl}${path}`, {
      ...init,
      headers: { accept: "application/json", ...init?.headers },
    });
    if (!res.ok) {
      throw new ApiError(`${path} returned HTTP ${res.status}`, res.status);
    }
    return res.json();
  }

  return {
    async health(init?: RequestInit): Promise<HealthResponse> {
      const data = await getJson("/api/health", init);
      const parsed = HealthResponse.safeParse(data);
      if (!parsed.success) {
        throw new ApiError("/api/health response does not match the contract");
      }
      return parsed.data;
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
