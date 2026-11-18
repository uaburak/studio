import { createRoute } from "@hono/zod-openapi";
import {
  ApiErrorBody,
  Device,
  DeviceList,
  MacRoutes,
  MacRoutesInput,
  PAIRING_CODE_LENGTH,
  PAIRING_CODE_TTL_MS,
  PAIRING_MAX_CODE_TRIES,
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
import { hubStub } from "./jobs.ts";

/*
 * Device pairing (task L1, QR pairing). The Mac app creates a pairing offer
 * (POST /api/pairing/codes, Mac only): a 6-digit code it can show as text and
 * a 32-byte secret it puts in a QR code. The phone trades either one for a
 * device token (POST /api/pairing/claim, public); either one uses up the
 * whole offer. Wrong, expired and reused codes or secrets look the same to the
 * caller (401).
 *
 * Guessing (G9): only codes can be guessed (1 000 000 values); the QR secret
 * (32 random bytes) cannot, so secret claims are never counted or limited and
 * nobody can lock the QR path out. Every code claim first records an attempt
 * and counts in the same D1 batch (a transaction), so concurrent claims are
 * serialized and each sees all earlier ones:
 *  - the active offer's code dies after PAIRING_MAX_CODE_TRIES attempts (its
 *    QR secret keeps working); at most that many guesses ever reach the
 *    comparison, bursts included;
 *  - a client address with PAIRING_MAX_FAILURES_PER_CLIENT failures, or all
 *    clients together with PAIRING_MAX_FAILURES_TOTAL (loose), get 429 until
 *    the window passes. Behind the tunnel the LAN gateway passes the real
 *    client address on, so tunnel clients are told apart too.
 * A successful claim removes its own attempt again.
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
    const wrong = () =>
      c.json(errorBody("unauthorized", "pairing code is wrong, expired or already used"), 401);

    let codeId: string | undefined;
    if (input.secret !== undefined) {
      // Single use: the conditional update is the claim (within the secret's lifetime).
      const claimed = await db
        .update(pairingCodes)
        .set({ usedAt: new Date(now) })
        .where(
          and(
            eq(pairingCodes.secretHash, await sha256Hex(input.secret)),
            gt(pairingCodes.secretExpiresAt, new Date(now)),
            isNull(pairingCodes.usedAt),
          ),
        )
        .returning({ id: pairingCodes.id });
      codeId = claimed[0]?.id;
      if (!codeId) return wrong();
    } else {
      const attempt = await reserveCodeAttempt(db, clientAddress(c), now);
      if (attempt.kind === "limited") {
        return c.json(
          errorBody("rate_limited", "too many failed pairing attempts; wait and retry"),
          429,
          { "Retry-After": String(attempt.retryAfterSeconds) },
        );
      }
      if (attempt.kind === "codeDead") return wrong();
      const claimed = await db
        .update(pairingCodes)
        .set({ usedAt: new Date(now) })
        .where(
          and(
            eq(pairingCodes.codeHash, await sha256Hex(input.code ?? "")),
            gt(pairingCodes.expiresAt, new Date(now)),
            isNull(pairingCodes.usedAt),
          ),
        )
        .returning({ id: pairingCodes.id });
      codeId = claimed[0]?.id;
      if (!codeId) {
        // The attempt row stays as the failure. The offer's last allowed try kills its code.
        if (attempt.offerId && attempt.offerTries >= PAIRING_MAX_CODE_TRIES) {
          await killCode(db, attempt.offerId, now);
        }
        return wrong();
      }
      await db.delete(pairingFailures).where(eq(pairingFailures.id, attempt.attemptId));
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
      const retired = await db
        .update(devices)
        .set({ revokedAt: new Date(now) })
        .where(
          and(
            eq(devices.tokenHash, await sha256Hex(input.replacesToken)),
            isNull(devices.revokedAt),
          ),
        )
        .returning({ id: devices.id });
      for (const old of retired) await closeDeviceStreams(c.env, old.id);
    }

    const routes = await readRoutes(db);
    return c.json(PairingResult.parse({ device: toDevice(device), token, routes }), 201);
  },
);

type CodeAttempt =
  | { kind: "limited"; retryAfterSeconds: number }
  | { kind: "codeDead" }
  | { kind: "go"; attemptId: string; offerId: string | null; offerTries: number };

/**
 * Records a code attempt and counts, in one D1 batch (a transaction): the attempt itself, the
 * client's and everybody's failures in the window, and the tries on the active offer (all code
 * attempts since it was made: only one offer is active at a time). Over a rate limit the attempt
 * is taken back (it compared nothing); over the offer's tries its code is killed.
 */
async function reserveCodeAttempt(db: Db, ip: string, now: number): Promise<CodeAttempt> {
  const since = new Date(now - PAIRING_RATE_WINDOW_MS);
  const offer = await db
    .select({ id: pairingCodes.id, createdAt: pairingCodes.createdAt })
    .from(pairingCodes)
    .where(and(isNull(pairingCodes.usedAt), gt(pairingCodes.expiresAt, new Date(now))))
    .orderBy(desc(pairingCodes.createdAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const attemptId = newId();
  const failures = (client?: string) =>
    db
      .select({ n: count(), oldest: min(pairingFailures.createdAt) })
      .from(pairingFailures)
      .where(
        client === undefined
          ? gte(pairingFailures.createdAt, since)
          : and(eq(pairingFailures.clientIp, client), gte(pairingFailures.createdAt, since)),
      );
  const [, , mine, all, onOffer] = await db.batch([
    db.delete(pairingFailures).where(lt(pairingFailures.createdAt, since)),
    db.insert(pairingFailures).values({ id: attemptId, clientIp: ip, createdAt: new Date(now) }),
    failures(ip),
    failures(),
    db
      .select({ n: count() })
      .from(pairingFailures)
      .where(gte(pairingFailures.createdAt, offer?.createdAt ?? new Date(now + 1))),
  ]);
  // The counts include this attempt: n - 1 failures came before it.
  const limited =
    (mine[0]?.n ?? 0) > PAIRING_MAX_FAILURES_PER_CLIENT
      ? mine[0]
      : (all[0]?.n ?? 0) > PAIRING_MAX_FAILURES_TOTAL
        ? all[0]
        : undefined;
  if (limited) {
    await db.delete(pairingFailures).where(eq(pairingFailures.id, attemptId));
    const oldest = limited.oldest ? new Date(limited.oldest).getTime() : now;
    return {
      kind: "limited",
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + PAIRING_RATE_WINDOW_MS - now) / 1000)),
    };
  }
  const offerTries = offer ? (onOffer[0]?.n ?? 0) : 0;
  if (offer && offerTries > PAIRING_MAX_CODE_TRIES) {
    await killCode(db, offer.id, now);
    return { kind: "codeDead" };
  }
  return { kind: "go", attemptId, offerId: offer?.id ?? null, offerTries };
}

/** The offer's code stops working; its QR secret keeps its own lifetime. */
async function killCode(db: Db, offerId: string, now: number): Promise<void> {
  await db
    .update(pairingCodes)
    .set({ expiresAt: new Date(now) })
    .where(and(eq(pairingCodes.id, offerId), gt(pairingCodes.expiresAt, new Date(now))));
}

/** A revoked device's open streams authenticated only at upgrade: close them now (G8). */
async function closeDeviceStreams(env: Env, deviceId: string): Promise<void> {
  try {
    await hubStub(env).closeDeviceSockets(deviceId);
  } catch (error) {
    console.warn(`api: could not close the streams of revoked device ${deviceId}`, error);
  }
}

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
    description:
      "Its token stops working immediately and its open live streams (jobs, conversations) are closed. Revoking twice is a no-op.",
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
    await closeDeviceStreams(c.env, id);
    return c.json(toDevice(row), 200);
  },
);
