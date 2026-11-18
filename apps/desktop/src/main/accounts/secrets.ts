// Secrets the owner types once: Meta App Secret, LinkedIn Client Secret, the Cloudflare tunnel
// token. Main process only; the renderer can save or forget one but never reads it back.
//
// Saved values are encrypted with Electron's safeStorage (its key lives in the macOS Keychain)
// in `desktop-secrets.json` (0600) in the state directory.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type SecretName = "meta-app-secret" | "linkedin-client-secret" | "cloudflare-tunnel-token";

export interface SecretStore {
  load(name: SecretName): Promise<string | null>;
  /** Whether a value exists, without reading it (no Keychain prompt). */
  has(name: SecretName): Promise<boolean>;
  save(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
}

/** safeStorage in the app; a reversible stand-in in tests. */
export interface Cipher {
  available(): boolean;
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

interface SecretsFile {
  /** base64 of the encrypted value; null = removed. */
  [name: string]: string | null;
}

export class FileSecretStore implements SecretStore {
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  private read(): SecretsFile {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return value && typeof value === "object" ? (value as SecretsFile) : {};
    } catch {
      return {};
    }
  }

  private write(data: SecretsFile): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }

  async has(name: SecretName): Promise<boolean> {
    const stored = this.read()[name];
    return stored !== null && stored !== undefined;
  }

  async load(name: SecretName): Promise<string | null> {
    const stored = this.read()[name];
    if (stored === null || stored === undefined) return null;
    try {
      return this.cipher.decrypt(Buffer.from(stored, "base64"));
    } catch {
      return null;
    }
  }

  async save(name: SecretName, value: string): Promise<void> {
    if (!this.cipher.available()) {
      throw new Error("Bu Mac'te şifreli saklama kullanılamıyor (Anahtar Zinciri erişimi yok).");
    }
    const data = this.read();
    data[name] = this.cipher.encrypt(value).toString("base64");
    this.write(data);
  }

  async delete(name: SecretName): Promise<void> {
    const data = this.read();
    data[name] = null;
    this.write(data);
  }
}

/** Tests. */
export class MemorySecretStore implements SecretStore {
  readonly values = new Map<SecretName, string>();

  constructor(initial: Partial<Record<SecretName, string>> = {}) {
    for (const [key, value] of Object.entries(initial)) {
      if (value) this.values.set(key as SecretName, value);
    }
  }

  async has(name: SecretName) {
    return this.values.has(name);
  }
  async load(name: SecretName) {
    return this.values.get(name) ?? null;
  }
  async save(name: SecretName, value: string) {
    this.values.set(name, value);
  }
  async delete(name: SecretName) {
    this.values.delete(name);
  }
}
