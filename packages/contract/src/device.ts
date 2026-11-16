import { z } from "zod";
import { EntityId, Timestamp } from "./common.ts";

/*
 * Device pairing (task L1). The API runs on the owner's Mac. Requests from the
 * Mac itself (127.0.0.1) and the local worker (WORKER_TOKEN) are trusted; a
 * phone on the network (or, later, through the tunnel) must present a device
 * token: `Authorization: Bearer <token>`.
 *
 *   Mac app:  POST /api/pairing/codes            -> { code, expiresAt }   (127.0.0.1 only)
 *   phone:    POST /api/pairing/claim {code, deviceName, platform}
 *                                                -> { device, token }      (public, rate-limited)
 *   Mac app:  GET  /api/devices, POST /api/devices/{id}/revoke             (127.0.0.1 only)
 *
 * The code is 6 digits, single use, valid PAIRING_CODE_TTL_MS. Creating a new
 * code invalidates the previous unused one. The server keeps only a SHA-256
 * hash of the device token; the token is shown exactly once (claim response).
 */

export const PAIRING_CODE_TTL_MS = 2 * 60 * 1000;
export const PAIRING_CODE_LENGTH = 6;
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

export const DevicePlatform = z.enum(["ios", "ipados", "macos", "other"]).meta({
  id: "DevicePlatform",
});
export type DevicePlatform = z.infer<typeof DevicePlatform>;

export const PairingCode = z
  .object({
    code: PairingCodeValue,
    expiresAt: Timestamp,
  })
  .meta({ id: "PairingCode", description: "Short-lived, single-use pairing code." });
export type PairingCode = z.infer<typeof PairingCode>;

export const PairingClaim = z
  .object({
    code: PairingCodeValue,
    deviceName: z.string().trim().min(1).max(80),
    platform: DevicePlatform.default("other"),
  })
  .meta({ id: "PairingClaim" });
export type PairingClaim = z.input<typeof PairingClaim>;

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
  })
  .meta({ id: "PairingResult" });
export type PairingResult = z.infer<typeof PairingResult>;

export const DeviceList = z
  .object({ items: z.array(Device) })
  .meta({ id: "DeviceList", description: "Paired devices, newest first (revoked ones included)." });
export type DeviceList = z.infer<typeof DeviceList>;
