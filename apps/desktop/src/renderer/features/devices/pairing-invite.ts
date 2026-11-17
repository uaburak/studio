// What the "iPhone'u bağla" QR code holds (pure). Port of StudioKit's `PairingInvite`
// (apps/apple/StudioKit/Sources/StudioKit/Pairing/PairingInvite.swift), byte for byte:
//
//   studio://pair?v=1&n=<Mac name>&s=<secret>&e=<expiry, Unix s>&i=<Mac id>
//                &a=<IPv4,IPv4>&p=<LAN port>&b=<Bonjour name>&t=<tunnel URL>
//
// `v`, `n`, `s`, `e` are required; the rest are left out when unknown (`b` also when it equals
// `n`). Values are percent-encoded the way Foundation's `URLComponents.queryItems` does (the
// RFC 3986 query characters stay, `&` `=` `#` and the rest are encoded) and `+` becomes `%2B`.
import type { MacRoutes, PairingCode } from "@studio/contract";

export const PAIRING_SCHEME = "studio";
export const PAIRING_HOST = "pair";
export const PAIRING_VERSION = 1;

export interface PairingInvite {
  macName: string;
  /** One-time secret for `POST /api/pairing/claim`. Never shown or logged. */
  secret: string;
  /** Unix seconds (whole: the link carries seconds). */
  expiresAt: number;
  macId: string | null;
  lanAddresses: string[];
  lanPort: number | null;
  bonjourName: string | null;
  /** The tunnel URL exactly as the routes give it (not normalised). */
  tunnelUrl: string | null;
}

/** Dotted-quad IPv4 without leading zeros (StudioKit's `IPv4Text.isValid`). */
export function isIPv4(text: string): boolean {
  const parts = text.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^[0-9]{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false;
    return Number.parseInt(part, 10) <= 255;
  });
}

export function makeInvite(fields: {
  macName: string;
  secret: string;
  /** Milliseconds or a Date; rounded down to whole seconds. */
  expiresAt: number | Date;
  macId?: string | null;
  lanAddresses?: string[];
  lanPort?: number | null;
  bonjourName?: string | null;
  tunnelUrl?: string | null;
}): PairingInvite {
  const ms = fields.expiresAt instanceof Date ? fields.expiresAt.getTime() : fields.expiresAt;
  return {
    macName: fields.macName,
    secret: fields.secret,
    expiresAt: Math.floor(ms / 1000),
    macId: fields.macId ?? null,
    lanAddresses: fields.lanAddresses ?? [],
    lanPort: fields.lanPort ?? null,
    // Bonjour advertises the Mac under its own name unless told otherwise.
    bonjourName: fields.bonjourName ?? fields.macName,
    tunnelUrl: fields.tunnelUrl ?? null,
  };
}

/** The invite for a fresh pairing offer and the Mac's routes; null for a server without QR secrets. */
export function inviteFromOffer(offer: PairingCode, routes: MacRoutes): PairingInvite | null {
  if (!offer.secret || !offer.secretExpiresAt) return null;
  return makeInvite({
    macName: routes.macName,
    secret: offer.secret,
    expiresAt: Date.parse(offer.secretExpiresAt),
    macId: routes.macId,
    lanAddresses: routes.lanAddresses,
    lanPort: routes.lanPort,
    bonjourName: routes.bonjourName,
    tunnelUrl: routes.tunnelUrl,
  });
}

// RFC 3986 query characters minus `&` and `=` (Foundation's query-item set); `+` is encoded too.
const QUERY_ITEM_SAFE = /^[A-Za-z0-9\-._~!$'()*,;:@/?]$/;

/** Percent-encode a query item name or value as `URLComponents.queryItems` + the `%2B` fix. */
export function encodeQueryItem(value: string): string {
  let out = "";
  for (const char of value) {
    if (QUERY_ITEM_SAFE.test(char)) {
      out += char;
      continue;
    }
    for (const byte of new TextEncoder().encode(char)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** `studio://pair?...` — the QR code's text. */
export function inviteUrl(invite: PairingInvite): string {
  const items: [string, string][] = [
    ["v", String(PAIRING_VERSION)],
    ["n", invite.macName],
    ["s", invite.secret],
    ["e", String(Math.trunc(invite.expiresAt))],
  ];
  if (invite.macId !== null) items.push(["i", invite.macId]);
  const addresses = invite.lanAddresses.filter(isIPv4);
  if (addresses.length > 0) items.push(["a", addresses.join(",")]);
  if (invite.lanPort !== null) items.push(["p", String(invite.lanPort)]);
  if (invite.bonjourName !== null && invite.bonjourName !== invite.macName) {
    items.push(["b", invite.bonjourName]);
  }
  if (invite.tunnelUrl !== null) items.push(["t", invite.tunnelUrl]);
  const query = items.map(([k, v]) => `${encodeQueryItem(k)}=${encodeQueryItem(v)}`).join("&");
  return `${PAIRING_SCHEME}://${PAIRING_HOST}?${query}`;
}

export function isInviteExpired(invite: PairingInvite, nowMs: number = Date.now()): boolean {
  return nowMs / 1000 >= invite.expiresAt;
}
