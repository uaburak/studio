import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorBody,
  Device,
  DeviceList,
  MacRoutes,
  MacRoutesInput,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_FAILURES_PER_CLIENT,
  PAIRING_MAX_FAILURES_TOTAL,
  PAIRING_RATE_WINDOW_MS,
  PAIRING_SECRET_TTL_MS,
  PairingClaim,
  PairingCode,
  PairingResult,
} from "@studio/contract";
import { and, count, desc, eq, gt, gte, isNull, lt, min } from "drizzle-orm";
import { createDb, type Db } from "../db/client.ts";
import { appMeta, devices, pairingCodes, pairingFailures } from "../db/schema.ts";
import { randomDigits, randomToken, sha256Hex } from "../lib/crypto.ts";
import { errorBody, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { clientAddress, requireLocal } from "../middleware/access.ts";

/*
 * Device pairing (task L1, QR pairing). The Mac app creates a pairing offer
 * (POST /api/pairing/codes, 127.0.0.1 only): a 6-digit code it can show as
 * text and a 32-byte secret it puts in a QR code. The phone trades either one
 * for a device token (POST /api/pairing/claim, public); either one uses up the
 * whole offer. Wrong, expired and reused codes or secrets look the same to the
 * caller (401). Failed claims are counted per client address and in total;
 * over the limit every claim (even a correct one) gets 429 until the window
 * passes. The 6-digit space, the 2-minute lifetime, one active offer at a time
 * and the global cap keep guessing hopeless (at most 20 tries per 10 minutes
 * against 1 000 000 values); the QR secret cannot be guessed at all.
 *
 * Routes (where phones reach this Mac) are published by the Mac app and kept
 * in `app_meta` under ROUTES_KEY; phones read them after every connect.
 */

const ROUTES_KEY = "mac_routes";
/** Unclaimed offers older than this are deleted when a new one is made. */
const OFFER_KEEP_MS = 24 * 60 * 60 * 1000;

const tags = ["Devices"];

type DeviceRow = typeof devices.$inferSelect;

function toDevice(r: DeviceRow): Device {
  return {
    id: r.id,
    name: r.name,
    platform: r.platform,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null,
    revokedAt: r.revokedAt ? r.revokedAt.toISOString() : null,
  };
}

const unauthorized = json(ApiErrorBody, "Wrong, expired or already used code (`unauthorized`).");
const rateLimited = json(ApiErrorBody, "Too many failed attempts (`rate_limited`, Retry-After).");
const forbidden = json(ApiErrorBody, "Not called from the Mac itself (`forbidden`).");

export const deviceRoutes = createRouter();

deviceRoutes.use("/api/pairing/codes", requireLocal);
deviceRoutes.use("/api/devices", requireLocal);
deviceRoutes.use("/api/devices/*", requireLocal);

deviceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/pairing/codes",
    tags,
    summary: "Create a pairing offer: code and QR secret (Mac only)",
    description: `A ${PAIRING_CODE_LENGTH}-digit code valid for ${PAIRING_CODE_TTL_MS / 1000} s and a QR secret valid for ${PAIRING_SECRET_TTL_MS / 1000} s; claiming with either uses up both. Invalidates the previous unused offer.`,
    responses: { 201: json(PairingCode, "The new code."), 403: forbidden },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const now = Date.now();
    const code = randomDigits(PAIRING_CODE_LENGTH);
    const secret = randomToken(32);
    const expiresAt = new Date(now + PAIRING_CODE_TTL_MS);
    const secretExpiresAt = new Date(now + PAIRING_SECRET_TTL_MS);
    await db.batch([
      db
        .update(pairingCodes)
        .set({ usedAt: new Date(now) })
        .where(isNull(pairingCodes.usedAt)),
      // The Mac renews the QR offer while it is on screen; old unclaimed offers are noise.
      db
        .delete(pairingCodes)
        .where(
          and(
            isNull(pairingCodes.deviceId),
            lt(pairingCodes.createdAt, new Date(now - OFFER_KEEP_MS)),
          ),
        ),
      db.insert(pairingCodes).values({
        id: newId(),
        codeHash: await sha256Hex(code),
        expiresAt,
        secretHash: await sha256Hex(secret),
        secretExpiresAt,
        createdAt: new Date(now),
      }),
    ]);
    return c.json(
      PairingCode.parse({
        code,
        expiresAt: expiresAt.toISOString(),
        secret,
        secretExpiresAt: secretExpiresAt.toISOString(),
      }),
      201,
    );
  },
);

deviceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/pairing/claim",
    tags,
    summary: "Trade a pairing code or QR secret for a device token (public)",
    request: { body: jsonBody(PairingClaim) },
    responses: {
      201: json(PairingResult, "Paired. The token is shown only here."),
      400: errors[400],
      401: unauthorized,
      429: rateLimited,
    },
  }),
  async (c) => {
    const input = c.req.valid("json");
    const db = createDb(c.env.DB);
    const now = Date.now();
    const since = new Date(now - PAIRING_RATE_WINDOW_MS);
    const ip = clientAddress(c);

    await db.delete(pairingFailures).where(lt(pairingFailures.createdAt, since));
    const [mine, all] = await Promise.all([
      db
        .select({ n: count(), oldest: min(pairingFailures.createdAt) })
        .from(pairingFailures)
        .where(and(eq(pairingFailures.clientIp, ip), gte(pairingFailures.createdAt, since))),
      db
        .select({ n: count(), oldest: min(pairingFailures.createdAt) })
        .from(pairingFailures)
        .where(gte(pairingFailures.createdAt, since)),
    ]);
    const limited =
      (mine[0]?.n ?? 0) >= PAIRING_MAX_FAILURES_PER_CLIENT
        ? mine[0]
        : (all[0]?.n ?? 0) >= PAIRING_MAX_FAILURES_TOTAL
          ? all[0]
          : undefined;
    if (limited) {
      const oldest = limited.oldest ? new Date(limited.oldest).getTime() : now;
      const retryAfter = Math.max(1, Math.ceil((oldest + PAIRING_RATE_WINDOW_MS - now) / 1000));
      return c.json(
        errorBody("rate_limited", "too many failed pairing attempts; wait and retry"),
        429,
        {
          "Retry-After": String(retryAfter),
        },
      );
    }

    // Single use: the conditional update is the claim (code or secret, each within its lifetime).
    const match =
      input.secret !== undefined
        ? and(
            eq(pairingCodes.secretHash, await sha256Hex(input.secret)),
            gt(pairingCodes.secretExpiresAt, new Date(now)),
          )
        : and(
            eq(pairingCodes.codeHash, await sha256Hex(input.code ?? "")),
            gt(pairingCodes.expiresAt, new Date(now)),
          );
    const claimed = await db
      .update(pairingCodes)
      .set({ usedAt: new Date(now) })
      .where(and(match, isNull(pairingCodes.usedAt)))
      .returning({ id: pairingCodes.id });
    const codeId = claimed[0]?.id;
    if (!codeId) {
      await db
        .insert(pairingFailures)
        .values({ id: newId(), clientIp: ip, createdAt: new Date(now) });
      return c.json(
        errorBody("unauthorized", "pairing code is wrong, expired or already used"),
        401,
      );
    }

    const token = `sdt_${randomToken(32)}`;
    const id = newId();
    const [row] = await db.batch([
      db
        .insert(devices)
        .values({
          id,
          name: input.deviceName,
          platform: input.platform,
          tokenHash: await sha256Hex(token),
          createdAt: new Date(now),
        })
        .returning(),
      db.update(pairingCodes).set({ deviceId: id }).where(eq(pairingCodes.id, codeId)),
    ]);
    const device = row[0];
    if (!device) throw new Error("device insert returned nothing");

    // Re-pairing the same phone: retire the device its previous token belonged to.
    if (input.replacesToken) {
      await db
        .update(devices)
        .set({ revokedAt: new Date(now) })
        .where(
          and(
            eq(devices.tokenHash, await sha256Hex(input.replacesToken)),
            isNull(devices.revokedAt),
          ),
        );
    }

    const routes = await readRoutes(db);
    return c.json(PairingResult.parse({ device: toDevice(device), token, routes }), 201);
  },
);

/** Saved routes, or null when the Mac app has not published any (or they no longer parse). */
async function readRoutes(db: Db): Promise<MacRoutes | null> {
  const row = await db.query.appMeta.findFirst({ where: eq(appMeta.key, ROUTES_KEY) });
  if (!row) return null;
  try {
    const parsed = MacRoutes.safeParse(JSON.parse(row.value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

deviceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/pairing/routes",
    tags,
    summary: "Where phones can reach this Mac",
    description:
      "LAN addresses, Bonjour name and tunnel URL as the Mac app last published them. Paired phones refresh their saved routes with it after every connect.",
    responses: { 200: json(MacRoutes, "The routes."), 404: errors[404] },
  }),
  async (c) => {
    const routes = await readRoutes(createDb(c.env.DB));
    if (!routes) throw notFound("routes", ROUTES_KEY);
    return c.json(routes, 200);
  },
);

deviceRoutes.openapi(
  createRoute({
    method: "put",
    path: "/api/pairing/routes",
    tags,
    summary: "Publish where phones can reach this Mac (Mac only)",
    description:
      "The Mac app calls this whenever its LAN addresses, the gateway port or the tunnel change. `macId` is replaced with this API's host id when it has one.",
    request: { body: jsonBody(MacRoutesInput) },
    responses: { 200: json(MacRoutes, "The saved routes."), 400: errors[400], 403: forbidden },
  }),
  async (c) => {
    if (c.get("principal")?.kind !== "local") {
      return c.json(errorBody("forbidden", "only the Mac itself can publish its routes"), 403);
    }
    const input = c.req.valid("json");
    const now = new Date();
    const routes = MacRoutes.parse({
      ...input,
      macId: c.env.STUDIO_INSTANCE_ID || input.macId,
      updatedAt: now.toISOString(),
    });
    await createDb(c.env.DB)
      .insert(appMeta)
      .values({ key: ROUTES_KEY, value: JSON.stringify(routes), updatedAt: now })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(routes), updatedAt: now },
      });
    return c.json(routes, 200);
  },
);

deviceRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/devices",
    tags,
    summary: "List paired devices (Mac only)",
    responses: { 200: json(DeviceList, "Newest first, revoked ones included."), 403: forbidden },
  }),
  async (c) => {
    const rows = await createDb(c.env.DB)
      .select()
      .from(devices)
      .orderBy(desc(devices.createdAt), desc(devices.id));
    return c.json({ items: rows.map(toDevice) }, 200);
  },
);

deviceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/devices/{id}/revoke",
    tags,
    summary: "Revoke a paired device (Mac only)",
    description: "Its token stops working immediately. Revoking twice is a no-op.",
    request: { params: IdParams },
    responses: { 200: json(Device, "The revoked device."), 403: forbidden, 404: errors[404] },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const db = createDb(c.env.DB);
    await db
      .update(devices)
      .set({ revokedAt: new Date() })
      .where(and(eq(devices.id, id), isNull(devices.revokedAt)));
    const row = await db.query.devices.findFirst({ where: eq(devices.id, id) });
    if (!row) throw notFound("device", id);
    return c.json(toDevice(row), 200);
  },
);
