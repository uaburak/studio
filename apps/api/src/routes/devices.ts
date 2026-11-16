import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorBody,
  Device,
  DeviceList,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_FAILURES_PER_CLIENT,
  PAIRING_MAX_FAILURES_TOTAL,
  PAIRING_RATE_WINDOW_MS,
  PairingClaim,
  PairingCode,
  PairingResult,
} from "@studio/contract";
import { and, count, desc, eq, gt, gte, isNull, lt, min } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { devices, pairingCodes, pairingFailures } from "../db/schema.ts";
import { randomDigits, randomToken, sha256Hex } from "../lib/crypto.ts";
import { errorBody, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { createRouter, errors, IdParams, json, jsonBody } from "../lib/router.ts";
import { clientAddress, requireLocal } from "../middleware/access.ts";

/*
 * Device pairing (task L1). The Mac app shows a 6-digit code (POST
 * /api/pairing/codes, 127.0.0.1 only); the phone trades it for a device token
 * (POST /api/pairing/claim, public). Wrong, expired and reused codes look the
 * same to the caller (401). Failed claims are counted per client address and
 * in total; over the limit every claim (even a correct one) gets 429 until the
 * window passes. The 6-digit space, the 2-minute lifetime, one active code at
 * a time and the global cap keep guessing hopeless (at most 20 tries per
 * 10 minutes against 1 000 000 values).
 */

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
    summary: "Create a pairing code (Mac only)",
    description: `A ${PAIRING_CODE_LENGTH}-digit, single-use code valid for ${PAIRING_CODE_TTL_MS / 1000} s. Invalidates the previous unused code.`,
    responses: { 201: json(PairingCode, "The new code."), 403: forbidden },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const now = Date.now();
    const code = randomDigits(PAIRING_CODE_LENGTH);
    const expiresAt = new Date(now + PAIRING_CODE_TTL_MS);
    await db.batch([
      db
        .update(pairingCodes)
        .set({ usedAt: new Date(now) })
        .where(isNull(pairingCodes.usedAt)),
      db.insert(pairingCodes).values({
        id: newId(),
        codeHash: await sha256Hex(code),
        expiresAt,
        createdAt: new Date(now),
      }),
    ]);
    return c.json(PairingCode.parse({ code, expiresAt: expiresAt.toISOString() }), 201);
  },
);

deviceRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/pairing/claim",
    tags,
    summary: "Trade a pairing code for a device token (public)",
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

    // Single use: the conditional update is the claim.
    const claimed = await db
      .update(pairingCodes)
      .set({ usedAt: new Date(now) })
      .where(
        and(
          eq(pairingCodes.codeHash, await sha256Hex(input.code)),
          isNull(pairingCodes.usedAt),
          gt(pairingCodes.expiresAt, new Date(now)),
        ),
      )
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
    return c.json(PairingResult.parse({ device: toDevice(device), token }), 201);
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
