import { z } from "zod";
import { EntityId, Timestamp } from "./common.ts";

/*
 * Device pairing (task L1). The API runs on the owner's Mac. Requests from the
 * Mac itself (127.0.0.1) and the local worker (WORKER_TOKEN) are trusted; a
 * phone on the network (or, later, through the tunnel) must present a device
 * token: `Authorization: Bearer <token>`.
 *
 *   Mac app:  POST /api/pairing/codes  -> { code, expiresAt, secret, secretExpiresAt }
 *                                                                          (127.0.0.1 only)
 *   phone:    POST /api/pairing/claim {code | secret, deviceName, platform}
 *                                      -> { device, token, routes }        (public, rate-limited)
 *   Mac app:  GET  /api/devices, POST /api/devices/{id}/revoke             (127.0.0.1 only)
 *   Mac app:  PUT  /api/pairing/routes  (127.0.0.1 only; where phones can reach this Mac)
 *   phone:    GET  /api/pairing/routes  (paired device; keeps its saved routes fresh)
 *
 * One pairing offer carries two single-use secrets that unlock the same claim:
 * the 6-digit code (typed by hand, valid PAIRING_CODE_TTL_MS) and a long random
 * secret (inside the QR code the Mac shows, valid PAIRING_SECRET_TTL_MS).
 * Claiming with either one uses up both. Creating a new offer invalidates the
 * previous unused one. The server keeps only SHA-256 hashes of the code, the
 * secret and the device token; the token is shown exactly once (claim response).
 */

export const PAIRING_CODE_TTL_MS = 2 * 60 * 1000;
export const PAIRING_CODE_LENGTH = 6;
/** Lifetime of the QR secret (high entropy, so it may live longer than the code). */
export const PAIRING_SECRET_TTL_MS = 10 * 60 * 1000;
/** Failed claims allowed per client address in PAIRING_RATE_WINDOW_MS. */
export const PAIRING_MAX_FAILURES_PER_CLIENT = 5;
/** Failed claims allowed from all addresses together in PAIRING_RATE_WINDOW_MS. */
export const PAIRING_MAX_FAILURES_TOTAL = 20;
export const PAIRING_RATE_WINDOW_MS = 10 * 60 * 1000;

/** Bonjour service type the Mac app advertises (TXT: name, api, pairing). */
export const BONJOUR_SERVICE_TYPE = "_studio._tcp";
/** `api` TXT key: bumped when a phone could no longer talk to this server. */
export const LAN_API_VERSION = "1";

export const PairingCodeValue = z
  .string()
  .regex(/^\d{6}$/, "pairing code is 6 digits")
  .meta({ id: "PairingCodeValue" });

/** The QR pairing secret: 32 random bytes, base64url without padding (43 characters). */
export const PairingSecretValue = z
  .string()
  .regex(/^[A-Za-z0-9_-]{32,128}$/, "pairing secret is base64url")
  .meta({ id: "PairingSecretValue" });

/** Scheme of the pairing link inside the QR code (`studio://pair?...`, see `PairingInvite`). */
export const PAIRING_LINK_SCHEME = "studio";

export const DevicePlatform = z.enum(["ios", "ipados", "macos", "other"]).meta({
  id: "DevicePlatform",
});
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const PairingCode = z
  .object({
    code: PairingCodeValue,
    expiresAt: Timestamp,
    /** For the QR code only; never shown as text. Absent from servers before QR pairing. */
    secret: PairingSecretValue.optional(),
    secretExpiresAt: Timestamp.optional(),
  })
  .meta({
    id: "PairingCode",
    description: "Short-lived, single-use pairing offer: a 6-digit code and a QR secret.",
  });
export type PairingCode = z.infer<typeof PairingCode>;

export const PairingClaim = z
  .object({
    /** Typed by hand. Exactly one of `code` and `secret`. */
    code: PairingCodeValue.optional(),
    /** Read from the QR code. Exactly one of `code` and `secret`. */
    secret: PairingSecretValue.optional(),
    deviceName: z.string().trim().min(1).max(80),
    platform: DevicePlatform.default("other"),
    /**
     * The token this phone used before (re-pairing after "Yeniden bağla"): when it belongs
     * to a device that is not revoked, that device is revoked once the claim succeeds, so the
     * Mac does not list the same phone twice.
     */
    replacesToken: z.string().min(1).max(512).optional(),
  })
  .refine((c) => (c.code === undefined) !== (c.secret === undefined), {
    message: "pass code or secret, not both",
  })
  .meta({ id: "PairingClaim" });
export type PairingClaim = z.input<typeof PairingClaim>;

/**
 * Where a phone can reach this Mac (task: QR pairing and automatic reconnection). The Mac
 * app publishes it whenever its addresses or the tunnel change; phones get it in the claim
 * result and refresh it after every connect. Addresses are tried in this order: the Bonjour
 * service (resolved on the spot), the LAN addresses, then the tunnel.
 */
export const MacRoutes = z
  .object({
    /** The Mac's name as people know it ("Burak's MacBook Pro"). */
    macName: z.string().trim().min(1).max(120),
    /** Id of the Mac host (`HealthResponse.instance`); phones skip addresses that answer with another id. */
    macId: z.string().min(1).max(128).nullable(),
    /** Current LAN IPv4 addresses of the Mac (without port). */
    lanAddresses: z.array(z.ipv4()).max(8),
    /** LAN gateway port; null when local network access is off. */
    lanPort: z.number().int().min(1).max(65535).nullable(),
    /** Bonjour service name (`_studio._tcp`), when advertised. */
    bonjourName: z.string().min(1).max(63).nullable(),
    /** Remote Control tunnel (`https://…`), when configured. */
    tunnelUrl: z
      .url({ protocol: /^https$/ })
      .max(2_000)
      .nullable(),
    updatedAt: Timestamp,
  })
  .meta({ id: "MacRoutes" });
export type MacRoutes = z.infer<typeof MacRoutes>;

/** `PUT /api/pairing/routes` body (the server stamps `updatedAt`, and `macId` when it knows it). */
export const MacRoutesInput = MacRoutes.omit({ updatedAt: true }).meta({ id: "MacRoutesInput" });
export type MacRoutesInput = z.input<typeof MacRoutesInput>;

export const Device = z
  .object({
    id: EntityId,
    name: z.string(),
    platform: DevicePlatform,
    createdAt: Timestamp,
    lastSeenAt: Timestamp.nullable(),
    /** Set when the owner removed the device; its token no longer works. */
    revokedAt: Timestamp.nullable(),
  })
  .meta({ id: "Device", description: "A paired device (phone)." });
export type Device = z.infer<typeof Device>;

export const PairingResult = z
  .object({
    device: Device,
    /** Long random bearer token. Shown once; the server stores only its hash. */
    token: z.string().min(32),
    /** Where to reach this Mac later; null until the Mac app published its routes. */
    routes: MacRoutes.nullable().optional(),
  })
  .meta({ id: "PairingResult" });
export type PairingResult = z.infer<typeof PairingResult>;

export const DeviceList = z
  .object({ items: z.array(Device) })
  .meta({ id: "DeviceList", description: "Paired devices, newest first (revoked ones included)." });
export type DeviceList = z.infer<typeof DeviceList>;
