// The owner's Meta App ID and LinkedIn Client ID (not secret): `desktop-accounts.json` in the
// state directory. Until saved here, the AppKit app's values (its user defaults) are used, so a
// Mac that was set up there keeps working.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type Runner, runCommand } from "./secrets.ts";

export interface AppIds {
  metaAppId: string;
  linkedInClientId: string;
}

const APPKIT_DOMAIN = "net.burakkoc.studio.mac";
const APPKIT_KEYS: Record<keyof AppIds, string> = {
  metaAppId: "studio.meta.appId",
  linkedInClientId: "studio.linkedin.clientId",
};

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
  private imported: Partial<AppIds> | null = null;

  constructor(
    private readonly file: string,
    private readonly run: Runner | null = runCommand,
  ) {}

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

  private async appKit(): Promise<Partial<AppIds>> {
    if (this.imported) return this.imported;
    const out: Partial<AppIds> = {};
    if (this.run) {
      for (const key of Object.keys(APPKIT_KEYS) as (keyof AppIds)[]) {
        const result = await this.run("/usr/bin/defaults", [
          "read",
          APPKIT_DOMAIN,
          APPKIT_KEYS[key],
        ]);
        const value = result.code === 0 ? result.stdout.trim() : "";
        if (value) out[key] = value;
      }
    }
    this.imported = out;
    return out;
  }

  async get(): Promise<AppIds> {
    const saved = this.readFile() ?? {};
    const needsImport = saved.metaAppId === undefined || saved.linkedInClientId === undefined;
    const fallback = needsImport ? await this.appKit() : {};
    return {
      metaAppId: saved.metaAppId ?? fallback.metaAppId ?? "",
      linkedInClientId: saved.linkedInClientId ?? fallback.linkedInClientId ?? "",
    };
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
