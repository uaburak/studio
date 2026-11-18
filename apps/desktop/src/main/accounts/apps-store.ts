// The owner's Meta App ID and LinkedIn Client ID (not secret): `desktop-accounts.json` in the
// state directory.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface AppIds {
  metaAppId: string;
  linkedInClientId: string;
}

/** Meta App IDs are digits only (AccountsModel.saveMetaApp). */
export function validateMetaAppId(raw: string): string {
  const id = raw.trim();
  if (id && !/^\d+$/.test(id)) throw new Error("Uygulama Kimliği yalnızca rakamlardan oluşur.");
  return id;
}

export function validateClientId(raw: string): string {
  const id = raw.trim();
  if (id.length > 128 || /\s/.test(id)) throw new Error("Client ID geçersiz.");
  return id;
}

export class AppIdsStore {
  constructor(private readonly file: string) {}

  private readFile(): Partial<AppIds> | null {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, unknown>;
      return {
        ...(typeof raw.metaAppId === "string" ? { metaAppId: raw.metaAppId } : {}),
        ...(typeof raw.linkedInClientId === "string"
          ? { linkedInClientId: raw.linkedInClientId }
          : {}),
      };
    } catch {
      return null;
    }
  }

  async get(): Promise<AppIds> {
    const saved = this.readFile() ?? {};
    return { metaAppId: saved.metaAppId ?? "", linkedInClientId: saved.linkedInClientId ?? "" };
  }

  async set(patch: Partial<AppIds>): Promise<AppIds> {
    const next = { ...(await this.get()), ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, this.file);
    return next;
  }
}
