/**
 * The e2e scripts drive a private API the way the Mac app does: with its owner secret
 * (`X-Studio-Owner`, see apps/api/src/middleware/access.ts). Start that API with the same value,
 * e.g. `wrangler dev … --var STUDIO_OWNER_SECRET:test-owner`, and run the script with
 * `STUDIO_OWNER_SECRET=test-owner`. Without it the API answers 401 to the owner's routes.
 */
export const ownerSecret = process.env.STUDIO_OWNER_SECRET ?? "";

export function requireOwnerSecret(): void {
  if (!ownerSecret) {
    console.error(
      "set STUDIO_OWNER_SECRET (the value the private API was started with: --var STUDIO_OWNER_SECRET:<value>)",
    );
    process.exit(2);
  }
}

/** `fetch` that adds the owner header. */
export const ownerFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (ownerSecret) headers.set("X-Studio-Owner", ownerSecret);
  return fetch(input, { ...init, headers });
};

/** Node's WebSocket accepts headers in its second argument (undici's `WebSocketInit`). */
export const OwnerWebSocket = class extends WebSocket {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, {
      ...(protocols !== undefined ? { protocols } : {}),
      headers: ownerSecret ? { "X-Studio-Owner": ownerSecret } : {},
    } as unknown as string[]);
  }
} as typeof WebSocket;
