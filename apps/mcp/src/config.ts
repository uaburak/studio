// Where Studio keeps its state on this Mac, and which API address the MCP server may talk to.
//
// The base URL is loopback only: `STUDIO_API_URL` may move it to another port or loopback name,
// never to another host. Without it the port comes from `host.json` (the running app writes it;
// 8790 is taken by something else sometimes) and falls back to 8790.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_PORT = 8790;

/** `~/Library/Application Support/Studio` (apps/desktop/src/main/host/environment.ts). */
export function stateDirectory(home = homedir()): string {
  return join(home, "Library", "Application Support", "Studio");
}

/** apps/desktop/src/main/host/secrets.ts OWNER_SECRET_FILE. */
export const OWNER_SECRET_FILE = "owner-secret";

/** apps/api/src/middleware/access.ts OWNER_HEADER. */
export const OWNER_HEADER = "X-Studio-Owner";

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class ConfigError extends Error {}

/** True for http(s) URLs whose host can only mean this Mac. */
export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  return LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

/** Normalised loopback base URL (origin only), or throws ConfigError. */
export function checkBaseUrl(value: string): string {
  if (!isLoopbackUrl(value)) {
    throw new ConfigError(
      `STUDIO_API_URL yalnızca bu Mac'i gösterebilir (127.0.0.1 / localhost): "${value}" reddedildi. ` +
        "Only a loopback address is allowed.",
    );
  }
  return new URL(value).origin;
}

function hostFilePort(stateDir: string): number | null {
  try {
    const value = JSON.parse(readFileSync(join(stateDir, "host.json"), "utf8")) as {
      apiPort?: unknown;
    };
    const port = value.apiPort;
    return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536
      ? port
      : null;
  } catch {
    return null;
  }
}

/** The API base URL: env override (loopback only), else host.json's port, else 8790. */
export function resolveBaseUrl(
  env: Record<string, string | undefined> = process.env,
  stateDir = stateDirectory(),
): string {
  const override = env.STUDIO_API_URL?.trim();
  if (override) return checkBaseUrl(override);
  return `http://127.0.0.1:${hostFilePort(stateDir) ?? DEFAULT_API_PORT}`;
}
