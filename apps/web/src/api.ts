import { createApiClient } from "@studio/contract";

/** Same-origin client; in dev Vite proxies /api to the local Worker. */
export const api = createApiClient({ baseUrl: "" });
