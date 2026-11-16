import type { TokenHealthStatus } from "@studio/contract";
import { ApiProblem } from "./errors.ts";

/**
 * Token vault (AES-256-GCM, WebCrypto).
 *
 * Key: `TOKEN_ENCRYPTION_KEY`, a per-install random secret. The Mac app generates
 * it on first run, keeps it in a 0600 file in ~/Library/Application Support/Studio
 * (`vault-key`) and hands it to the API only through the process environment. There
 * is no built-in fallback: without the key the vault refuses to store tokens (the
 * API answers 409 with an explanation) instead of encrypting with a guessable value.
 *
 * Every ciphertext is bound to its row (additional data), and rows carry a
 * `key_version`:
 * - 2: the per-install key (HKDF salt `studio-token-vault-v2`).
 * - 1: legacy rows written before P3 with a secret derived from `WORKER_TOKEN` or the
 *   old hard-coded development value. They are re-encrypted with the per-install key
 *   the first time a key is available (`migrateLegacyTokens`), then never read again.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8(text: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(text));
}

export const VAULT_KEY_VERSION = 2;
const LEGACY_KEY_VERSION = 1;

const HKDF_SALT_V2 = utf8("studio-token-vault-v2");
const HKDF_SALT_V1 = utf8("studio-token-vault-v1");
const HKDF_INFO = utf8("social-account-tokens");

/**
 * The value pre-P3 builds used when no secret was configured. Kept ONLY to read
 * (and immediately re-encrypt) rows written by those builds; never used to encrypt.
 */
const LEGACY_DEV_SECRET = "studio-local-dev-vault";

/** The per-install key must carry at least this many characters (32 random bytes in base64 = 44). */
export const MIN_VAULT_KEY_LENGTH = 32;

/** Warn 7 days before token expiry (PLAN.md §3.3). */
export const EXPIRING_SOON_MS = 7 * 24 * 3600_000;

export interface VaultEnv {
  TOKEN_ENCRYPTION_KEY?: string | undefined;
  WORKER_TOKEN?: string | undefined;
}

export const VAULT_UNAVAILABLE_MESSAGE =
  "Token kasası anahtarı tanımlı değil. Studio Mac uygulaması API'yi başlatırken kendi anahtarını verir; " +
  "API'yi elle başlattıysanız TOKEN_ENCRYPTION_KEY ortam değişkenini (en az 32 karakter) verin.";

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

function currentSecret(env: VaultEnv): string | null {
  const raw = env.TOKEN_ENCRYPTION_KEY?.trim();
  return raw && raw.length >= MIN_VAULT_KEY_LENGTH ? raw : null;
}

/** True when tokens can be stored (the per-install key is present). */
export function vaultReady(env: VaultEnv): boolean {
  return currentSecret(env) !== null;
}

function deriveKey(secret: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const cacheKey = `${toBase64(salt)}:${secret}`;
  let cached = keyCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      const baseKey = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, [
        "deriveKey",
      ]);
      return crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt, info: HKDF_INFO },
        baseKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    })();
    keyCache.set(cacheKey, cached);
  }
  return cached;
}

function requireKey(env: VaultEnv): Promise<CryptoKey> {
  const secret = currentSecret(env);
  if (!secret) throw new ApiProblem("conflict", VAULT_UNAVAILABLE_MESSAGE);
  return deriveKey(secret, HKDF_SALT_V2);
}

function accountAad(socialAccountId: string): Uint8Array<ArrayBuffer> {
  return utf8(`social_account_token:${socialAccountId}`);
}

export interface SealedValue {
  ciphertext: string;
  iv: string;
  keyVersion: number;
}

async function seal(
  env: VaultEnv,
  aad: Uint8Array<ArrayBuffer>,
  plaintext: string,
): Promise<SealedValue> {
  const key = await requireKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    encoder.encode(plaintext),
  );
  return {
    ciphertext: toBase64(new Uint8Array(encrypted)),
    iv: toBase64(iv),
    keyVersion: VAULT_KEY_VERSION,
  };
}

async function open(
  env: VaultEnv,
  aad: Uint8Array<ArrayBuffer>,
  sealed: { ciphertext: string; iv: string; keyVersion?: number | null },
): Promise<string> {
  const params = { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: aad };
  if ((sealed.keyVersion ?? LEGACY_KEY_VERSION) >= VAULT_KEY_VERSION) {
    const key = await requireKey(env);
    try {
      return decoder.decode(
        await crypto.subtle.decrypt(params, key, fromBase64(sealed.ciphertext)),
      );
    } catch {
      throw new ApiProblem(
        "conflict",
        "Kayıtlı erişim anahtarı bu kurulumun kasa anahtarıyla çözülemedi (kasa anahtarı değişmiş). Hesabı yeniden bağlayın.",
      );
    }
  }
  for (const secret of legacySecrets(env)) {
    try {
      const key = await deriveKey(secret, HKDF_SALT_V1);
      return decoder.decode(
        await crypto.subtle.decrypt(params, key, fromBase64(sealed.ciphertext)),
      );
    } catch {
      // try the next legacy candidate
    }
  }
  throw new ApiProblem(
    "conflict",
    "Eski kasadaki erişim anahtarı çözülemedi. Hesabı yeniden bağlayın.",
  );
}

/** Secrets pre-P3 builds may have used, in the order they preferred them. */
function legacySecrets(env: VaultEnv): string[] {
  const out: string[] = [];
  const explicit = env.TOKEN_ENCRYPTION_KEY?.trim();
  if (explicit) out.push(explicit);
  const worker = env.WORKER_TOKEN?.trim();
  if (worker) out.push(worker);
  out.push(LEGACY_DEV_SECRET);
  return [...new Set(out)];
}

export function encryptAccountToken(
  env: VaultEnv,
  socialAccountId: string,
  plaintext: string,
): Promise<SealedValue> {
  return seal(env, accountAad(socialAccountId), plaintext);
}

export function decryptAccountToken(
  env: VaultEnv,
  socialAccountId: string,
  sealed: { ciphertext: string; iv: string; keyVersion?: number | null },
): Promise<string> {
  return open(env, accountAad(socialAccountId), sealed);
}

function settingAad(name: string): Uint8Array<ArrayBuffer> {
  return utf8(`studio_setting:${name}`);
}

/** Generic sealed setting (e.g. the cloud publisher token), bound to its name. */
export function encryptSetting(env: VaultEnv, name: string, plaintext: string) {
  return seal(env, settingAad(name), plaintext);
}

export function decryptSetting(
  env: VaultEnv,
  name: string,
  sealed: { ciphertext: string; iv: string; keyVersion?: number | null },
) {
  return open(env, settingAad(name), sealed);
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
