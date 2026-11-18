// Where the host keeps its state, and how it finds node / claude.
//
// Finder-launched apps get a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so the PATH is
// read once from the user's login shell — in the background (A11: a slow shell or `scutil` never
// blocks the main process). The repo path comes from the settings: the host runs the API and
// worker from the repo's sources (`node_modules` must be installed).
import { execFile } from "node:child_process";
import {
  accessSync,
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import { findRepo } from "./layout.ts";

/** `~/Library/Application Support/Studio`. */
export function stateDirectory(home = homedir()): string {
  return join(home, "Library", "Application Support", "Studio");
}

/**
 * The checkout this build runs from (walks up to `pnpm-workspace.yaml` + `apps/api`); "" when
 * there is none (the packaged app: its host comes from the app bundle, host/layout.ts). Never a
 * guessed folder.
 */
export function defaultRepoPath(startDir: string): string {
  return findRepo(startDir) ?? "";
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

/** stdout of a short command, "" when it fails or takes longer than `timeoutMs`. */
export function commandOutput(
  file: string,
  args: string[],
  timeoutMs: number,
  run: typeof execFile = execFile,
): Promise<string> {
  return new Promise((resolve) => {
    try {
      run(
        file,
        args,
        { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1_000_000 },
        (_error, stdout) => resolve(typeof stdout === "string" ? stdout : ""),
      ).stdin?.end();
    } catch {
      resolve("");
    }
  });
}

let cachedPath: Promise<string> | undefined;

/** PATH of the user's login shell (read once, in the background), with tool folders appended. */
export function loginShellPath(): Promise<string> {
  cachedPath ??= (async () => {
    const shell = process.env.SHELL || "/bin/zsh";
    // -l and -i: PATH is often set in .zshrc (interactive) as well as .zprofile.
    const output = await commandOutput(
      shell,
      ["-l", "-i", "-c", `printf '${PATH_MARK_START}%s${PATH_MARK_END}' "$PATH"`],
      5_000,
    );
    return mergePath(parseShellPath(output));
  })();
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

/** The last `lines` lines of a log file (reads only its last `bytes`, never the whole file). */
export function tail(file: string, lines = 12, bytes = 16_384): string {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return tailText(buffer.toString("utf8"), lines);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
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

/**
 * Rotation while a child still writes the log (its descriptor is in append mode): the content is
 * copied to `.1` and the file is emptied in place, so the child's next line lands at its start.
 * Returns whether the log was rotated.
 */
export function rotateInPlace(file: string, limit = 5_000_000): boolean {
  try {
    if (statSync(file).size <= limit) return false;
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
    return true;
  } catch {
    return false;
  }
}

/** The Mac's user-visible name ("Deniz's MacBook Pro"), read in the background. */
export async function computerName(): Promise<string> {
  const name = (await commandOutput("/usr/sbin/scutil", ["--get", "ComputerName"], 2_000)).trim();
  return name || process.env.HOST || "Mac";
}

let cachedUserName: Promise<string> | undefined;

/** The Mac user's full name ("Deniz Yılmaz"; the short login name when there is none). */
export function macUserName(): Promise<string> {
  cachedUserName ??= (async () => {
    const full = (await commandOutput("/usr/bin/id", ["-F"], 2_000)).trim();
    if (full) return full;
    try {
      return userInfo().username;
    } catch {
      return "";
    }
  })();
  return cachedUserName;
}
