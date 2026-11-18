import { eq } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { createDb } from "../db/client.ts";
import { devices } from "../db/schema.ts";
import { authenticateWorker, bearerToken, tokensMatch } from "../hub/auth.ts";
import { sha256Hex } from "../lib/crypto.ts";
import { errorBody } from "../lib/errors.ts";
import type { AppEnv } from "../lib/router.ts";

/**
 * AUTH SEAM — every /api request passes through `accessControl` (task L1, G1).
 *
 * The API runs on the owner's Mac (wrangler dev / workerd, started by the Mac
 * app). A request is let in when it is one of:
 *
 * - `local`: the Mac app itself. ALL of these must hold:
 *   1. not marked by the LAN gateway (`X-Studio-Gateway`). LAN and tunnel
 *      traffic always goes through the gateway (scripts/lan-gateway.mjs),
 *      which overwrites `CF-Connecting-IP` with the real peer and adds the
 *      marker, so gatewayed requests are never local, even from 127.0.0.1;
 *   2. `CF-Connecting-IP` (set by Miniflare from the socket) is loopback;
 *   3. the URL host (built from the `Host` header) is 127.0.0.1, localhost or
 *      [::1] — a DNS-rebound page names its own host and is refused;
 *   4. an `Origin`, when present, is the app's own (`studio://app`) or a
 *      loopback page (the dev renderer) — never a web site;
 *   5. `X-Studio-Owner` equals `STUDIO_OWNER_SECRET`, a per-install random
 *      secret the desktop app keeps in its state folder (0600) and hands to
 *      workerd through the environment. Only the desktop main process adds it
 *      (the `studio://` protocol proxy, its webRequest hook for the renderer's
 *      own requests and WebSockets, and its direct calls). A web page open in
 *      a browser on this Mac cannot know it, so it can neither POST here nor
 *      open a WebSocket. Without the secret configured nothing is local
 *      (fails closed).
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

/** The owner secret header the desktop app's proxies add (see `local` above). */
export const OWNER_HEADER = "X-Studio-Owner";

/** The packaged renderer's origin (apps/desktop/src/main/protocol.ts). */
export const APP_ORIGIN = "studio://app";

const PUBLIC_PATHS = new Set(["/api/health", "/api/pairing/claim"]);

/** Hostnames (as `URL.hostname` spells them) that can only mean this Mac. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

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

/** The request was addressed to this Mac by a loopback name (not a rebound DNS name). */
export function isLoopbackHost(requestUrl: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(requestUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * No `Origin` (Node, URLSession, same-origin GETs), the packaged app's own origin, or a page
 * served from this Mac's loopback (the dev renderer). `null` and every web site are refused.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === APP_ORIGIN) return true;
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase()) &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

/** True only for the desktop app's own requests made on this Mac (see `local` above). */
export async function isLocalRequest(c: Context<AppEnv>): Promise<boolean> {
  if (c.req.header(GATEWAY_HEADER) !== undefined) return false;
  if (!isLoopback(c.req.header("CF-Connecting-IP"))) return false;
  if (!isLoopbackHost(c.req.url)) return false;
  if (!isAllowedOrigin(c.req.header("Origin"))) return false;
  const expected = c.env.STUDIO_OWNER_SECRET;
  const provided = c.req.header(OWNER_HEADER);
  if (!expected || !provided) return false;
  return tokensMatch(expected, provided);
}

export async function authenticate(c: Context<AppEnv>): Promise<Principal | null> {
  if (await isLocalRequest(c)) return { kind: "local" };
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
