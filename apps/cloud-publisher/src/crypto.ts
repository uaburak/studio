/**
 * Secrets handling, all WebCrypto:
 * - bearer auth for the Mac (constant-time compare),
 * - access tokens encrypted at rest (AES-256-GCM, row-bound AAD),
 * - signed, expiring media URLs (HMAC-SHA256) that Meta can fetch.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// --- bearer auth ---------------------------------------------------------------------

function bearerToken(header: string | null): string | null {
  if (!header) return null;
  return /^Bearer\s+(\S+)\s*$/i.exec(header)?.[1] ?? null;
}

/**
 * `Authorization: Bearer <PUBLISHER_TOKEN>`. Both sides are hashed first so
 * the comparison is constant-time and length-independent. Fails closed when
 * the secret is not configured.
 */
export async function isAuthorized(expected: string | undefined, header: string | null) {
  const provided = bearerToken(header);
  if (!expected || provided === null) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// --- base64 helpers ------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const toBase64Url = (bytes: Uint8Array) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return fromBase64(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return null;
  }
}

// --- token encryption ----------------------------------------------------------------

const TOKEN_PREFIX = "v1";

/** `TOKEN_ENCRYPTION_KEY` is base64 of exactly 32 random bytes. */
export async function importTokenKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new Error("TOKEN_ENCRYPTION_KEY is not configured");
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(secret.trim());
  } catch {
    throw new Error("TOKEN_ENCRYPTION_KEY must be base64");
  }
  if (raw.byteLength !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypt with a fresh 96-bit IV. `aad` binds the ciphertext to its row
 * (order + target), so a ciphertext copied to another row will not decrypt.
 * Format: `v1.<iv b64>.<ciphertext+tag b64>`.
 */
export async function encryptToken(key: CryptoKey, token: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(token),
  );
  return `${TOKEN_PREFIX}.${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

export async function decryptToken(key: CryptoKey, sealed: string, aad: string): Promise<string> {
  const [prefix, iv, ct] = sealed.split(".");
  if (prefix !== TOKEN_PREFIX || !iv || !ct) throw new Error("unknown token format");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: encoder.encode(aad) },
    key,
    fromBase64(ct),
  );
  return decoder.decode(plain);
}

// --- signed media URLs ---------------------------------------------------------------

async function hmacKey(secret: string | undefined): Promise<CryptoKey> {
  if (!secret) throw new Error("MEDIA_URL_SECRET is not configured");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const signedPayload = (orderId: string, mediaId: string, exp: number) =>
  encoder.encode(`media\n${orderId}\n${mediaId}\n${exp}`);

/**
 * Path of a signed media URL: `/media/{orderId}/{exp}/{sig}/{mediaId}`.
 * `exp` is epoch seconds; the media id stays last so Meta sees the file name.
 */
export async function signMediaPath(
  secret: string | undefined,
  orderId: string,
  mediaId: string,
  exp: number,
): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, signedPayload(orderId, mediaId, exp));
  return `/media/${encodeURIComponent(orderId)}/${exp}/${toBase64Url(new Uint8Array(sig))}/${encodeURIComponent(mediaId)}`;
}

export type MediaSignatureCheck = "ok" | "invalid" | "expired";

export async function verifyMediaSignature(
  secret: string | undefined,
  orderId: string,
  mediaId: string,
  expRaw: string,
  sigRaw: string,
  nowMs: number,
): Promise<MediaSignatureCheck> {
  if (!/^\d{1,12}$/.test(expRaw)) return "invalid";
  const exp = Number(expRaw);
  const sig = fromBase64Url(sigRaw);
  if (sig?.byteLength !== 32) return "invalid";
  const key = await hmacKey(secret);
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", key, sig, signedPayload(orderId, mediaId, exp));
  if (!valid) return "invalid";
  return exp * 1000 <= nowMs ? "expired" : "ok";
}
