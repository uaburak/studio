import type { TokenHealthStatus } from "@studio/contract";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const DEFAULT_DEV_VAULT_SECRET = "studio-local-dev-vault";
const HKDF_SALT = encoder.encode("studio-token-vault-v1");
const HKDF_INFO = encoder.encode("social-account-tokens");

/** Warn 7 days before token expiry (PLAN.md §3.3). */
export const EXPIRING_SOON_MS = 7 * 24 * 3600_000;

export interface VaultEnv {
  TOKEN_ENCRYPTION_KEY?: string | undefined;
  WORKER_TOKEN?: string | undefined;
}

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

const keyCache = new Map<string, Promise<CryptoKey>>();

function resolveSecret(env: VaultEnv): string {
  const raw = env.TOKEN_ENCRYPTION_KEY?.trim() || env.WORKER_TOKEN?.trim();
  return raw && raw.length > 0 ? raw : DEFAULT_DEV_VAULT_SECRET;
}

async function deriveVaultKey(secret: string): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: HKDF_INFO,
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function getVaultKey(env: VaultEnv): Promise<CryptoKey> {
  const secret = resolveSecret(env);
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = deriveVaultKey(secret);
    keyCache.set(secret, cached);
  }
  return cached;
}

function accountAad(socialAccountId: string) {
  return encoder.encode(`social_account_token:${socialAccountId}`);
}

export async function encryptAccountToken(
  env: VaultEnv,
  socialAccountId: string,
  plaintext: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await getVaultKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: accountAad(socialAccountId) },
    key,
    encoder.encode(plaintext),
  );
  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    iv: toBase64(iv),
  };
}

export async function decryptAccountToken(
  env: VaultEnv,
  socialAccountId: string,
  ciphertext: string,
  iv: string,
): Promise<string> {
  const key = await getVaultKey(env);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(iv), additionalData: accountAad(socialAccountId) },
    key,
    fromBase64(ciphertext),
  );
  return decoder.decode(decrypted);
}

export function evaluateTokenHealth(
  expiresAt: Date | null,
  nowMs = Date.now(),
): Exclude<TokenHealthStatus, "missing_scopes" | "unchecked"> {
  if (expiresAt === null) return "valid";
  const remaining = expiresAt.getTime() - nowMs;
  if (remaining <= 0) return "invalid";
  if (remaining <= EXPIRING_SOON_MS) return "expiring_soon";
  return "valid";
}
