// Provider keys and worker settings the app hands to the worker through its environment (S3).
//
// The packaged app never reads a repo `.env`: the values live in the state folder,
// `worker-env.json` (0600), each sealed with Electron's safeStorage (its key is in the macOS
// Keychain), like the host's own secrets (secrets.ts). They are set in Settings, and a dev build
// imports them from the repo's `.env` whenever that file changed since the last import (only
// the allowed names below; the app reads the file itself, nothing is logged or shown but names).
// The Gemini and OpenAI keys of Ayarlar → Yapay zekâ stay in the API's vault and win over these.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { type Cipher, writeSecretFile } from "./secrets.ts";

export const WORKER_ENV_FILE = "worker-env.json";

/** Variables the host sets itself: never taken from `.env` or Settings. */
const HOST_OWNED = new Set([
  "STUDIO_HUB_URL",
  "STUDIO_API_URL",
  "STUDIO_WORKER_TOKEN",
  "STUDIO_STATE_DIR",
  "STUDIO_TOOLS_DIR",
  "STUDIO_SKILLS_DIR",
  "STUDIO_SHUTDOWN_TIMEOUT_S",
  "STUDIO_INSTANCE_ID",
  "STUDIO_OWNER_SECRET",
  "STUDIO_CLAUDE_BIN",
  "STUDIO_GEMINI_BIN",
  "STUDIO_CODEX_BIN",
  "STUDIO_ANTIGRAVITY_BIN",
]);

const PROVIDER_KEYS = new Set([
  "GEMINI_API_KEY",
  "ELEVENLABS_API_KEY",
  "OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]);

/** Names Settings offers (the rest only come from a dev `.env`). */
export const EDITABLE_WORKER_ENV = [
  { name: "GEMINI_API_KEY", label: "Gemini API anahtarı (kasa yoksa)", secret: true },
  {
    name: "ELEVENLABS_API_KEY",
    label: "ElevenLabs API anahtarı (Reels seslendirme)",
    secret: true,
  },
  { name: "STUDIO_ELEVENLABS_VOICE_ID", label: "ElevenLabs ses kimliği", secret: false },
  { name: "STUDIO_CLOUD_PUBLISHER_URL", label: "Bulut yayıncı adresi (eski yol)", secret: false },
  {
    name: "STUDIO_CLOUD_PUBLISHER_TOKEN",
    label: "Bulut yayıncı anahtarı (eski yol)",
    secret: true,
  },
] as const;

/** Whether a variable may be handed to the worker from `.env` or Settings. */
export function allowedWorkerEnvName(name: string): boolean {
  if (HOST_OWNED.has(name)) return false;
  return PROVIDER_KEYS.has(name) || /^STUDIO_[A-Z0-9_]+$/.test(name);
}

export type WorkerEnvSource = "env-file" | "settings";

interface StoredValue {
  /** base64 of the safeStorage-sealed value, or the value itself when `sealed` is false. */
  value: string;
  sealed: boolean;
  source: WorkerEnvSource;
}

interface StoreFile {
  version: 1;
  values: Record<string, StoredValue>;
  /** The last `.env` import: which file and its size / modification time (never contents). */
  imported?: { from: string; fingerprint: string; at: string; names: string[] };
}

export interface WorkerEnvEntry {
  name: string;
  source: WorkerEnvSource;
}

export interface WorkerEnvSummary {
  entries: WorkerEnvEntry[];
  imported: { from: string; at: string; count: number } | null;
  /** false: no Keychain access, values are plain 0600 files. */
  sealed: boolean;
}

function fingerprint(file: string): string | null {
  try {
    const s = statSync(file);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return null;
  }
}

export class WorkerEnvStore {
  constructor(
    private readonly stateDir: string,
    private readonly cipher: Cipher | null,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get file(): string {
    return join(this.stateDir, WORKER_ENV_FILE);
  }

  private read(): StoreFile {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<StoreFile>;
      const values: Record<string, StoredValue> = {};
      for (const [name, v] of Object.entries(raw.values ?? {})) {
        if (
          allowedWorkerEnvName(name) &&
          v &&
          typeof v.value === "string" &&
          typeof v.sealed === "boolean"
        ) {
          values[name] = {
            value: v.value,
            sealed: v.sealed,
            source: v.source === "settings" ? "settings" : "env-file",
          };
        }
      }
      return { version: 1, values, ...(raw.imported ? { imported: raw.imported } : {}) };
    } catch {
      return { version: 1, values: {} };
    }
  }

  private write(data: StoreFile): void {
    writeSecretFile(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }

  private seal(value: string, source: WorkerEnvSource): StoredValue {
    if (this.cipher?.available()) {
      return { value: this.cipher.encrypt(value).toString("base64"), sealed: true, source };
    }
    return { value, sealed: false, source };
  }

  private open(stored: StoredValue): string | null {
    if (!stored.sealed) return stored.value;
    if (!this.cipher?.available()) return null;
    try {
      return this.cipher.decrypt(Buffer.from(stored.value, "base64"));
    } catch {
      return null;
    }
  }

  /** The worker's variables (values that cannot be opened are left out). */
  env(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, stored] of Object.entries(this.read().values)) {
      const value = this.open(stored);
      if (value) out[name] = value;
    }
    return out;
  }

  /** Names and where they came from (never values). */
  summary(): WorkerEnvSummary {
    const data = this.read();
    return {
      entries: Object.entries(data.values)
        .map(([name, v]) => ({ name, source: v.source }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      imported: data.imported
        ? { from: data.imported.from, at: data.imported.at, count: data.imported.names.length }
        : null,
      sealed: Boolean(this.cipher?.available()),
    };
  }

  set(name: string, value: string): void {
    if (!allowedWorkerEnvName(name)) throw new Error(`${name} worker'a verilemez.`);
    const clean = value.trim();
    const data = this.read();
    if (clean) data.values[name] = this.seal(clean, "settings");
    else delete data.values[name];
    this.write(data);
  }

  remove(name: string): void {
    const data = this.read();
    delete data.values[name];
    this.write(data);
  }

  /**
   * Dev only: brings the repo `.env`'s allowed variables in when the file changed since the last
   * import (it stays the source in a dev build; the packaged app then has the same keys).
   * Values the owner set in Settings since are overwritten only by a changed `.env` that names
   * them; names dropped from `.env` that came from it are removed. Returns the imported names,
   * or null when nothing was done.
   */
  syncFromDotEnv(file: string): string[] | null {
    const print = fingerprint(file);
    if (print === null) return null;
    const data = this.read();
    if (data.imported?.from === file && data.imported.fingerprint === print) return null;
    let parsed: Record<string, string>;
    try {
      parsed = parseEnv(readFileSync(file, "utf8")) as Record<string, string>;
    } catch {
      return null;
    }
    const names: string[] = [];
    for (const [name, raw] of Object.entries(parsed)) {
      const value = typeof raw === "string" ? raw.trim() : "";
      if (!value || !allowedWorkerEnvName(name)) continue;
      data.values[name] = this.seal(value, "env-file");
      names.push(name);
    }
    for (const [name, stored] of Object.entries(data.values)) {
      if (stored.source === "env-file" && !names.includes(name)) delete data.values[name];
    }
    data.imported = { from: file, fingerprint: print, at: this.now().toISOString(), names };
    this.write(data);
    return names;
  }
}
