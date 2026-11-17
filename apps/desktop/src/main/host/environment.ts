// Where the host keeps its state, and how it finds node / claude (port of
// StudioMac/Host/HostEnvironment.swift).
//
// Finder-launched apps get a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so the PATH is
// read once from the user's login shell. The repo path comes from the settings: the host runs
// the API and worker from the repo's sources (`node_modules` must be installed).
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { dirname, join } from "node:path";

/** `~/Library/Application Support/Studio` (shared with the AppKit app). */
export function stateDirectory(home = homedir()): string {
  return join(home, "Library", "Application Support", "Studio");
}

/** The checkout this build runs from (walks up to `pnpm-workspace.yaml` + `apps/api`). */
export function defaultRepoPath(startDir: string, home = homedir()): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(dir, "pnpm-workspace.yaml")) &&
      existsSync(join(dir, "apps", "api", "wrangler.jsonc"))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(home, "Desktop", "Burak", "Code", "Studio");
}

/** `~/...` → absolute. */
export function expandTilde(path: string, home = homedir()): string {
  if (path === "~") return home;
  return path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

const PATH_MARK_START = "__STUDIO_PATH__";
const PATH_MARK_END = "__END__";

/** The PATH between the markers the login shell printed (noise from rc files is ignored). */
export function parseShellPath(output: string): string | null {
  const start = output.indexOf(PATH_MARK_START);
  if (start === -1) return null;
  const from = start + PATH_MARK_START.length;
  const end = output.indexOf(PATH_MARK_END, from);
  if (end === -1) return null;
  return output.slice(from, end);
}

/** Login PATH with the common tool folders appended (no duplicates). */
export function mergePath(path: string | null, home = homedir()): string {
  const parts = (path ?? "").split(":").filter(Boolean);
  const extras = [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    `${home}/.local/bin`,
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  for (const extra of extras) if (!parts.includes(extra)) parts.push(extra);
  return parts.join(":");
}

let cachedPath: string | undefined;

/** PATH of the user's login shell (cached), with common tool folders appended. */
export function loginShellPath(): string {
  if (cachedPath !== undefined) return cachedPath;
  const shell = process.env.SHELL || "/bin/zsh";
  let raw: string | null = null;
  try {
    // -l and -i: PATH is often set in .zshrc (interactive) as well as .zprofile.
    const result = spawnSync(
      shell,
      ["-l", "-i", "-c", `printf '${PATH_MARK_START}%s${PATH_MARK_END}' "$PATH"`],
      { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    raw = parseShellPath(result.stdout ?? "");
  } catch {
    raw = null;
  }
  cachedPath = mergePath(raw);
  return cachedPath;
}

/** First executable named `tool` on `path`. */
export function which(tool: string, path: string): string | null {
  for (const dir of path.split(":")) {
    if (!dir) continue;
    const candidate = join(dir, tool);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** Environment shared by every child: login PATH and the user's basics only. */
export function baseEnvironment(
  path: string,
  inherited: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: path,
    HOME: home,
    LANG: inherited.LANG || "en_US.UTF-8",
  };
  for (const key of ["USER", "LOGNAME", "TMPDIR", "SHELL"]) {
    const value = inherited[key];
    if (value) env[key] = value;
  }
  if (!env.USER) {
    try {
      env.USER = userInfo().username;
    } catch {
      // keep it unset
    }
  }
  return env;
}

// --- ports ---------------------------------------------------------------------------------

/** True when nothing listens on `port` at `address` (bind test). */
export function isPortFree(port: number, address: string): Promise<boolean> {
  return bindTest(port, address).then((p) => p !== null);
}

/** A port the kernel picks as free on `address`. */
export function freePort(address: string): Promise<number | null> {
  return bindTest(0, address);
}

function bindTest(port: number, address: string): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(null));
    server.listen({ port, host: address, exclusive: true }, () => {
      const info = server.address();
      const bound = typeof info === "object" && info ? info.port : null;
      server.close(() => resolve(bound));
    });
  });
}

/** IPv4 addresses of active, non-loopback, non-link-local interfaces. */
export function lanAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const result: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      if (!result.includes(entry.address)) result.push(entry.address);
    }
  }
  return result;
}

// --- logs ----------------------------------------------------------------------------------

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The last `lines` lines of a text (ANSI colour codes removed, empty lines dropped). */
export function tailText(text: string, lines = 12): string {
  return text
    .replace(ANSI, "")
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-lines)
    .join("\n");
}

/** The last `lines` lines of a log file (reads at most the last 16 KB). */
export function tail(file: string, lines = 12): string {
  try {
    const buffer = readFileSync(file);
    const slice = buffer.length > 16_384 ? buffer.subarray(buffer.length - 16_384) : buffer;
    return tailText(slice.toString("utf8"), lines);
  } catch {
    return "";
  }
}

/** Move a log aside when it grew past `limit` bytes (one generation kept). */
export function rotate(file: string, limit = 5_000_000): void {
  try {
    if (statSync(file).size <= limit) return;
    rmSync(`${file}.1`, { force: true });
    renameSync(file, `${file}.1`);
  } catch {
    // missing file: nothing to rotate
  }
}

/** The Mac's user-visible name ("Burak's MacBook Pro"). */
export function computerName(): string {
  try {
    const result = spawnSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const name = result.stdout?.trim();
    if (name) return name;
  } catch {
    // fall through
  }
  return process.env.HOST || "Mac";
}
