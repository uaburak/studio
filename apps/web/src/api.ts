import { type ApiClient, createApiClient, type Page } from "@studio/contract";
import { createContext, useContext } from "react";

/** Same-origin client; in dev Vite proxies /api to the local Worker. */
export const api = createApiClient({ baseUrl: "" });

/** Components read the client from context so tests can inject a mock. */
export const ApiContext = createContext<ApiClient>(api);

export function useApi(): ApiClient {
  return useContext(ApiContext);
}

/**
 * Follow `nextCursor` until the end (or `maxPages`). Used for small lists
 * that the UI shows in full: brands, accounts, a month of schedules.
 */
export async function fetchAllPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<Page<T>>,
  maxPages = 10,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return items;
}
