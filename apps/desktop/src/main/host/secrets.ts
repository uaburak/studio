// Per-install files in the state directory. Data, the token vault and phone pairing keep working
// whichever app runs the host.
//
// - `host-secrets.json` (0600): WORKER_TOKEN (shared by the API and the worker, 64 hex chars) and
//   TOKEN_ENCRYPTION_KEY of the social token vault (base64 of 32 bytes), each encrypted with
//   Electron's safeStorage (its key lives in the macOS Keychain), G10. Losing the vault key makes
//   stored social tokens unreadable, so it is never regenerated once it exists.
//   Before G10 both were plain 0600 files (`worker-token`, `vault-key`, shared with the AppKit
//   app); they are read once, sealed, verified and deleted. A plain file that shows up again
//   later (the AppKit app makes a new one when it is missing) is never used: it is moved aside as
//   `<name>.appkit-<time>` and the sealed value wins.
//   Without safeStorage (no Keychain access) the plain files are used as before.
// - `owner-secret` (0600): STUDIO_OWNER_SECRET, proves a request comes from this app (the API's
//   `local` principal, G1). Persistent, so a copy of the app that attaches to a running host
//   still talks to it.
// - `instance-id`: HealthResponse.instance of this Mac's host (phones tell Macs apart by it).
// - `host.json`: {apiPort, lanPort?, pid} of the app that started the children (removed when it
//   stops them on a clean quit).
import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** safeStorage in the app; a reversible stand-in in tests. */
export interface Cipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

export class HostSecretsError extends Error {}

export interface HostSecrets {
  workerToken: string;
  vaultKey: string;
}

type SealedName = "worker-token" | "vault-key";

export const SEALED_FILE = "host-secrets.json";
export const OWNER_SECRET_FILE = "owner-secret";

/** Shortest value accepted as a secret (32 random bytes in hex or base64 are longer). */
const MIN_SECRET_LENGTH = 32;

function readTrimmed(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function valid(value: string | null | undefined): string | null {
  return value && value.length >= MIN_SECRET_LENGTH ? value : null;
}

/** Atomic 0600 write (tmp + rename), in a 0700 folder when it has to be created. */
export function writeSecretFile(file: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

function readSealed(dir: string): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(join(dir, SEALED_FILE), "utf8")) as unknown;
    if (!value || typeof value !== "object") return {};
    const out: Record<string, string> = {};
    for (const [key, sealed] of Object.entries(value)) {
      if (typeof sealed === "string") out[key] = sealed;
    }
    return out;
  } catch {
    return {};
  }
}

function writeSealed(dir: string, data: Record<string, string>): void {
  writeSecretFile(join(dir, SEALED_FILE), `${JSON.stringify(data, null, 2)}\n`);
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function loadOrCreateSealed(
  dir: string,
  name: SealedName,
  generate: () => string,
  cipher: Cipher | null,
  now: () => Date,
): string {
  const plainFile = join(dir, name);
  const plain = valid(readTrimmed(plainFile));
  const store = readSealed(dir);
  const sealed = store[name];

  if (!cipher?.available()) {
    if (sealed) {
      throw new HostSecretsError(
        "Şifreli anahtarlar açılamadı: bu Mac'te Anahtar Zinciri erişimi yok. Mac'i yeniden başlatıp tekrar dene.",
      );
    }
    if (plain) return plain;
    const value = generate();
    writeSecretFile(plainFile, value);
    return value;
  }

  if (sealed) {
    let value: string | null;
    try {
      value = valid(cipher.decrypt(Buffer.from(sealed, "base64")));
    } catch {
      value = null;
    }
    if (!value) {
      // Never make a new vault key here: the stored social tokens would be lost for good.
      throw new HostSecretsError(
        `Şifreli anahtar (${name}) çözülemedi. macOS Anahtar Zinciri erişimi sorduysa Studio'yu yeniden açıp “İzin Ver”i seç. Anahtar Zinciri değiştiyse Ayarlar → Gelişmiş → Yedekten geri yükle ile son yedeği geri yükle.`,
      );
    }
    if (plain !== null) {
      if (plain === value) rmSync(plainFile, { force: true });
      else renameSync(plainFile, `${plainFile}.appkit-${stamp(now())}`);
    }
    return value;
  }

  const value = plain ?? generate();
  store[name] = cipher.encrypt(value).toString("base64");
  writeSealed(dir, store);
  // Only delete the plain copy once the sealed one reads back.
  const check = readSealed(dir)[name];
  if (!check || cipher.decrypt(Buffer.from(check, "base64")) !== value) {
    throw new HostSecretsError(`Anahtar (${name}) şifreli olarak kaydedilemedi.`);
  }
  if (plain !== null) rmSync(plainFile, { force: true });
  return value;
}

/** The worker token and vault key (sealed with `cipher`; see the header). */
export function loadOrCreateHostSecrets(
  dir: string,
  cipher: Cipher | null,
  now: () => Date = () => new Date(),
): HostSecrets {
  return {
    workerToken: loadOrCreateSealed(
      dir,
      "worker-token",
      () => randomBytes(32).toString("hex"),
      cipher,
      now,
    ),
    vaultKey: loadOrCreateSealed(
      dir,
      "vault-key",
      () => randomBytes(32).toString("base64"),
      cipher,
      now,
    ),
  };
}

/** Replaces both (restore from a backup). */
export function writeHostSecrets(dir: string, secrets: HostSecrets, cipher: Cipher | null): void {
  if (!valid(secrets.workerToken) || !valid(secrets.vaultKey)) {
    throw new HostSecretsError("Yedekteki anahtarlar eksik ya da bozuk.");
  }
  if (!cipher?.available()) {
    writeSecretFile(join(dir, "worker-token"), secrets.workerToken);
    writeSecretFile(join(dir, "vault-key"), secrets.vaultKey);
    return;
  }
  writeSealed(dir, {
    ...readSealed(dir),
    "worker-token": cipher.encrypt(secrets.workerToken).toString("base64"),
    "vault-key": cipher.encrypt(secrets.vaultKey).toString("base64"),
  });
  for (const name of ["worker-token", "vault-key"]) rmSync(join(dir, name), { force: true });
}

export function loadOrCreateOwnerSecret(dir: string): string {
  const file = join(dir, OWNER_SECRET_FILE);
  const existing = valid(readTrimmed(file));
  if (existing) return existing;
  const secret = randomBytes(32).toString("hex");
  writeSecretFile(file, secret);
  return secret;
}

export function writeOwnerSecret(dir: string, secret: string): void {
  if (!valid(secret)) throw new HostSecretsError("Yedekteki sahip anahtarı bozuk.");
  writeSecretFile(join(dir, OWNER_SECRET_FILE), secret);
}

export function loadOrCreateInstanceId(dir: string): string {
  const existing = readTrimmed(join(dir, "instance-id"));
  if (existing) return existing;
  const id = randomUUID().toLowerCase();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instance-id"), id);
  return id;
}

export function writeInstanceId(dir: string, id: string): void {
  const clean = id.trim();
  if (!/^[A-Za-z0-9-]{8,128}$/.test(clean))
    throw new HostSecretsError("Yedekteki Mac kimliği bozuk.");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instance-id"), clean);
}

export interface HostFile {
  apiPort: number;
  lanPort?: number | null;
  pid: number;
}

export function readHostFile(dir: string): HostFile | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, "host.json"), "utf8")) as Partial<HostFile>;
    if (typeof value.apiPort !== "number" || typeof value.pid !== "number") return null;
    return {
      apiPort: value.apiPort,
      pid: value.pid,
      ...(typeof value.lanPort === "number" ? { lanPort: value.lanPort } : {}),
    };
  } catch {
    return null;
  }
}

/** Same keys the AppKit app writes (`lanPort` left out when off). */
export function writeHostFile(dir: string, file: HostFile): void {
  mkdirSync(dir, { recursive: true });
  const body: Record<string, number> = { apiPort: file.apiPort, pid: file.pid };
  if (typeof file.lanPort === "number") body.lanPort = file.lanPort;
  const tmp = join(dir, `host.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(body));
  renameSync(tmp, join(dir, "host.json"));
}

/** Removes host.json when it still names `pid` (the children it describes are gone). */
export function removeHostFile(dir: string, pid: number): void {
  const file = join(dir, "host.json");
  if (!existsSync(file)) return;
  if (readHostFile(dir)?.pid === pid) rmSync(file, { force: true });
}
