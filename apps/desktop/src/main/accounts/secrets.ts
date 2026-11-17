// Secrets the owner types once: Meta App Secret, LinkedIn Client Secret, the Cloudflare tunnel
// token. Main process only; the renderer can save or forget one but never reads it back.
//
// - Saved values are encrypted with Electron's safeStorage (its key lives in the macOS
//   Keychain) in `desktop-secrets.json` (0600) in the state directory.
// - Values the AppKit app saved in the Keychain are read as a fallback (read-only, only when a
//   flow needs them), so switching apps keeps working. Forgetting a secret here records it as
//   removed, so the AppKit copy is not picked up again.
import { execFile } from "node:child_process";
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

/** Where the AppKit app keeps each secret (KeychainSecretStore / tunnel token store). */
export const APPKIT_KEYCHAIN: Record<SecretName, { service: string; account: string }> = {
  "meta-app-secret": { service: "net.burakkoc.studio.publishing", account: "meta-app-secret" },
  "linkedin-client-secret": {
    service: "net.burakkoc.studio.publishing",
    account: "linkedin-client-secret",
  },
  "cloudflare-tunnel-token": { service: "net.burakkoc.studio", account: "cloudflare-tunnel-token" },
};

export type Runner = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export const runCommand: Runner = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 60_000, encoding: "utf8" }, (error, stdout) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout: stdout ?? "" });
    });
  });

/** Read-only access to the AppKit app's Keychain items (`security`). */
export class AppKitKeychain {
  constructor(private readonly run: Runner = runCommand) {}

  async has(name: SecretName): Promise<boolean> {
    const { service, account } = APPKIT_KEYCHAIN[name];
    const result = await this.run("/usr/bin/security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
    ]);
    return result.code === 0;
  }

  async load(name: SecretName): Promise<string | null> {
    const { service, account } = APPKIT_KEYCHAIN[name];
    const result = await this.run("/usr/bin/security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
    const value = result.code === 0 ? result.stdout.trim() : "";
    return value.length > 0 ? value : null;
  }
}

interface SecretsFile {
  /** base64 of the encrypted value; null = removed here (ignore the AppKit copy). */
  [name: string]: string | null;
}

export class FileSecretStore implements SecretStore {
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
    private readonly fallback: Pick<AppKitKeychain, "has" | "load"> | null = null,
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
    const data = this.read();
    if (name in data) return data[name] !== null;
    return (await this.fallback?.has(name)) ?? false;
  }

  async load(name: SecretName): Promise<string | null> {
    const data = this.read();
    if (name in data) {
      const stored = data[name];
      if (stored === null || stored === undefined) return null;
      try {
        return this.cipher.decrypt(Buffer.from(stored, "base64"));
      } catch {
        return null;
      }
    }
    return (await this.fallback?.load(name)) ?? null;
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
