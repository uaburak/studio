import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { createDb } from "../db/client.ts";
import { devices } from "../db/schema.ts";
import { authenticateWorker, bearerToken } from "../hub/auth.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { errorBody } from "../lib/errors.ts";
import type { AppEnv } from "../lib/router.ts";

/**
 * AUTH SEAM — every /api request passes through `accessControl` (task L1).
 *
 * The API runs on the owner's Mac (wrangler dev / workerd, started by the Mac
 * app). A request is let in when it is one of:
 *
 * - `local`: it came from this Mac. workerd only listens on 127.0.0.1; the
 *   address is the `CF-Connecting-IP` header Miniflare sets from the socket.
 *   Miniflare keeps a client-supplied `CF-Connecting-IP`, so LAN traffic never
 *   reaches workerd directly: it goes through the LAN gateway
 *   (scripts/lan-gateway.mjs), which overwrites that header with the real
 *   peer address and marks the request with `X-Studio-Gateway`. A request
 *   carrying that marker is never local, even when its peer is 127.0.0.1
 *   (e.g. a future Cloudflare Tunnel connector on this Mac).
 * - `worker`: `Authorization: Bearer <WORKER_TOKEN>` (the local worker).
 * - `device`: `Authorization: Bearer <device token>` of a paired, not revoked
 *   device (routes/devices.ts). Only the token's SHA-256 is stored.
 *
 * Public: `GET /api/health` and `POST /api/pairing/claim` (rate-limited).
 * Everything else answers `401 unauthorized` with `WWW-Authenticate: Bearer`.
 * Device management (`/api/devices`, `/api/pairing/codes`) additionally
 * requires `local` (`requireLocal`, 403 otherwise).
 */

export type Principal =
  | { kind: "local" }
  | { kind: "worker" }
  | { kind: "device"; deviceId: string };

/** Set by the LAN gateway on every request it forwards. */
export const GATEWAY_HEADER = "X-Studio-Gateway";

const PUBLIC_PATHS = new Set(["/api/health", "/api/pairing/claim"]);

/** Do not write `last_seen_at` more often than this per device. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

export function isLoopback(address: string | null | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase();
  return a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
}

/** Peer address as seen by Miniflare or the LAN gateway ("unknown" if absent). */
export function clientAddress(c: Context<AppEnv>): string {
  return c.req.header("CF-Connecting-IP")?.trim() || "unknown";
}

/** True only for requests made on this Mac directly to workerd (not via the gateway). */
export function isLocalRequest(c: Context<AppEnv>): boolean {
  if (c.req.header(GATEWAY_HEADER) !== undefined) return false;
  return isLoopback(c.req.header("CF-Connecting-IP"));
}

export async function authenticate(c: Context<AppEnv>): Promise<Principal | null> {
  if (isLocalRequest(c)) return { kind: "local" };
  const authorization = c.req.header("Authorization");
  const token = bearerToken(authorization);
  if (token === null) return null;
  if ((await authenticateWorker(c.env.WORKER_TOKEN, authorization)) === "ok") {
    return { kind: "worker" };
  }
  const db = createDb(c.env.DB);
  const row = await db.query.devices.findFirst({
    where: eq(devices.tokenHash, await sha256Hex(token)),
  });
  if (!row || row.revokedAt) return null;
  const now = Date.now();
  if (!row.lastSeenAt || now - row.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS) {
    await db
      .update(devices)
      .set({ lastSeenAt: new Date(now) })
      .where(eq(devices.id, row.id));
  }
  return { kind: "device", deviceId: row.id };
}

export const accessControl: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) {
    await next();
    return;
  }
  const principal = await authenticate(c);
  if (!principal) {
    return c.json(
      errorBody("unauthorized", "pair this device with the Mac first (Authorization: Bearer)"),
      401,
      { "WWW-Authenticate": "Bearer" },
    );
  }
  c.set("principal", principal);
  await next();
};

/** Only the Mac itself (pairing codes, device list, revoke). */
export const requireLocal: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get("principal")?.kind !== "local") {
    return c.json(errorBody("forbidden", "only the Mac itself can manage devices"), 403);
  }
  await next();
};
