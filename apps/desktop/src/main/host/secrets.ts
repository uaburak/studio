// Per-install files in the state directory, shared with the AppKit app so data, the token
// vault and phone pairing keep working whichever app runs the host.
//
// - `worker-token`: WORKER_TOKEN shared by the API and the worker (64 hex chars, 0600).
// - `vault-key`: TOKEN_ENCRYPTION_KEY of the social token vault (base64 of 32 bytes, 0600).
//   Losing it makes stored social tokens unreadable.
// - `instance-id`: HealthResponse.instance of this Mac's host (phones tell Macs apart by it).
// - `host.json`: {apiPort, lanPort?, pid} of the app that started the children.
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function readTrimmed(file: string): string | null {
  try {
    const text = readFileSync(file, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function writeSecret(dir: string, name: string, value: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  writeFileSync(file, value, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadOrCreateWorkerToken(dir: string): string {
  const existing = readTrimmed(join(dir, "worker-token"));
  if (existing && existing.length >= 32) return existing;
  const token = randomBytes(32).toString("hex");
  writeSecret(dir, "worker-token", token);
  return token;
}

export function loadOrCreateVaultKey(dir: string): string {
  const existing = readTrimmed(join(dir, "vault-key"));
  if (existing && existing.length >= 32) return existing;
  const key = randomBytes(32).toString("base64");
  writeSecret(dir, "vault-key", key);
  return key;
}

export function loadOrCreateInstanceId(dir: string): string {
  const existing = readTrimmed(join(dir, "instance-id"));
  if (existing) return existing;
  const id = randomUUID().toLowerCase();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "instance-id"), id);
  return id;
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
