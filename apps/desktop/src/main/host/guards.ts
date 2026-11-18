// Startup guards (port of StudioMac/Host/StartupGuards.swift and LocalHost's helpers).
import { execFile, spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// --- repo access (macOS privacy protection) --------------------------------------------------
//
// TCC guards Desktop, Documents and Downloads. A child the app spawns counts as the app
// itself, so when the repo lives in one of those folders and the app has no grant, `open()`
// of any repo file blocks while macOS shows its consent prompt, and wrangler hangs before
// printing anything. The host therefore reads one repo file itself first and tells the owner
// what to do while it waits.

export type RepoAccessOutcome =
  | { kind: "readable" }
  | { kind: "denied"; code: string }
  /** Still blocked after `limit`. */
  | { kind: "stillWaiting" }
  | { kind: "cancelled" };

/** `open` + `close`: null when readable, else the error code (EPERM, ENOENT, …). */
export async function openForReading(file: string): Promise<string | null> {
  try {
    const handle = await open(file, "r");
    await handle.close();
    return null;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "EIO";
  }
}

export function checkRepoAccess(
  read: () => Promise<string | null>,
  options: {
    noticeAfterMs: number;
    limitMs: number;
    onWaiting: () => void;
    signal?: AbortSignal;
  },
): Promise<RepoAccessOutcome> {
  return new Promise((resolve) => {
    let done = false;
    const settle = (outcome: RepoAccessOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(notice);
      clearTimeout(limit);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => settle({ kind: "cancelled" });
    const notice = setTimeout(() => {
      if (!done) options.onWaiting();
    }, options.noticeAfterMs);
    const limit = setTimeout(() => settle({ kind: "stillWaiting" }), options.limitMs);
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    void read().then((code) =>
      settle(code === null ? { kind: "readable" } : { kind: "denied", code }),
    );
  });
}

/** The protected folder (as System Settings names it) that contains `path`, if any. */
export function protectedFolder(path: string, home = homedir()): string | null {
  const folders: [string, string][] = [
    ["Desktop", "Masaüstü Klasörü"],
    ["Documents", "Belgeler Klasörü"],
    ["Downloads", "İndirilenler Klasörü"],
  ];
  for (const [folder, name] of folders) {
    const root = join(home, folder);
    if (path === root || path.startsWith(`${root}/`)) return name;
  }
  return null;
}

export function settingsHint(repo: string, home = homedir()): string {
  const folder = protectedFolder(repo, home);
  return `Sistem Ayarları → Gizlilik ve Güvenlik → Dosyalar ve Klasörler → Studio${folder ? ` → ${folder}` : ""}`;
}

export function waitingMessage(repo: string, home = homedir()): string {
  return (
    "macOS, Studio'nun depo klasörüne erişim izni istiyor. Açılan pencerede “İzin Ver”e tıkla " +
    `(ya da ${settingsHint(repo, home)} iznini aç); izin gelince Studio kendiliğinden başlar.`
  );
}

export function accessFailureMessage(
  outcome: RepoAccessOutcome,
  repo: string,
  probe: string,
  home = homedir(),
): string {
  switch (outcome.kind) {
    case "denied":
      if (outcome.code === "EPERM" || outcome.code === "EACCES") {
        return (
          `macOS, Studio'nun depo klasörünü okumasına izin vermiyor (${probe}). ` +
          `${settingsHint(repo, home)} iznini açıp Studio'yu yeniden başlat.`
        );
      }
      return `Depo dosyası okunamadı (${probe}): ${outcome.code}.`;
    case "stillWaiting":
      return (
        "Depo klasörüne erişim izni yanıtsız kaldı (macOS izin penceresi onaylanmadı). " +
        `${settingsHint(repo, home)} iznini açıp Studio'yu yeniden başlat.`
      );
    default:
      return "";
  }
}

export function migrationTimeoutMessage(seconds: number, repo: string, home = homedir()): string {
  let message = `Veritabanı güncellemesi (wrangler d1 migrations) ${seconds} sn içinde bitmedi ve durduruldu.`;
  if (protectedFolder(repo, home)) {
    message += ` Depo korumalı bir klasörde; macOS erişim izni bekliyor olabilir: ${settingsHint(repo, home)}.`;
  }
  return `${message} Ayrıntı: migrate.log.`;
}

// --- processes left by a crashed app ----------------------------------------------------------

/** Whether a process with this id still runs (EPERM: it runs as someone else). */
export function isAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function output(tool: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(tool, args, { encoding: "utf8", timeout: 5_000 }, (_error, stdout) =>
      resolve(stdout ?? ""),
    );
  });
}

/** `pkill -f` patterns that match only this repo's API and gateway processes. */
export function leftoverPatterns(repoPath: string): string[] {
  return [
    `${repoPath}/apps/api/node_modules/wrangler`,
    `${repoPath}/node_modules/.pnpm/wrangler`,
    `${repoPath}/apps/api/scripts/lan-gateway.mjs`,
  ];
}

/** `lsof -Fn` output → the cwd path. */
export function parseLsofCwd(text: string): string | null {
  const line = text.split("\n").find((l) => l.startsWith("n"));
  return line ? line.slice(1) : null;
}

export interface PsEntry {
  pid: number;
  ppid: number;
  command: string;
}

/** `ps -axo pid=,ppid=,command=` output → entries. */
export function parsePs(text: string): PsEntry[] {
  const entries: PsEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) {
      entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
    }
  }
  return entries;
}

/**
 * Helpers a crashed app left behind: its Bonjour registration (`dns-sd -R … _studio._tcp`) and
 * its tunnel connector (`cloudflared tunnel … run`), both re-parented to launchd (ppid 1). A
 * cloudflared also has to run in `stateDir` (checked by the caller), so the owner's own
 * tunnels are never touched.
 */
export function orphanedHelpers(entries: PsEntry[]): { dnsSd: number[]; cloudflared: number[] } {
  const orphans = entries.filter((e) => e.ppid === 1 && e.pid > 1);
  return {
    dnsSd: orphans
      .filter(
        (e) => e.command.startsWith("/usr/bin/dns-sd -R ") && e.command.includes(" _studio._tcp "),
      )
      .map((e) => e.pid),
    cloudflared: orphans
      .filter((e) => /(^|\/)cloudflared tunnel --no-autoupdate run( |$)/.test(e.command))
      .map((e) => e.pid),
  };
}

function terminate(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // gone
  }
}

async function cwdOf(pid: number): Promise<string | null> {
  return parseLsofCwd(
    await output("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]),
  );
}

/**
 * Stops this repo's API, gateway and worker processes that outlived their app (matched by
 * their full paths inside the repo, so nothing else is touched), and the app's orphaned
 * `dns-sd` and `cloudflared` (see `orphanedHelpers`).
 */
export async function stopLeftovers(repoPath: string, stateDir: string): Promise<void> {
  const workerDir = `${repoPath}/apps/worker`;
  // The worker runs as `tsx src/main.ts` inside apps/worker: match its working directory.
  const pids = (await output("/usr/bin/pgrep", ["-f", "tsx src/main.ts"]))
    .split("\n")
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  for (const pid of pids) {
    if ((await cwdOf(pid)) === workerDir) terminate(pid);
  }
  const helpers = orphanedHelpers(
    parsePs(await output("/bin/ps", ["-axo", "pid=,ppid=,command="])),
  );
  for (const pid of helpers.dnsSd) terminate(pid);
  for (const pid of helpers.cloudflared) {
    if ((await cwdOf(pid)) === stateDir) terminate(pid);
  }
  for (const pattern of leftoverPatterns(repoPath)) {
    await new Promise<void>((resolve) => {
      const child = spawn("/usr/bin/pkill", ["-TERM", "-f", pattern], { stdio: "ignore" });
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
  }
  // Give them a moment to release their ports.
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

// --- Remote Control ---------------------------------------------------------------------------

export const DEFAULT_REMOTE_HOSTNAME = "social.burakkoc.net";

export function normalizedHostname(raw: string): string {
  let clean = raw.trim();
  if (clean.startsWith("https://")) clean = clean.slice("https://".length);
  if (clean.startsWith("http://")) clean = clean.slice("http://".length);
  while (clean.endsWith("/")) clean = clean.slice(0, -1);
  return clean.length === 0 ? DEFAULT_REMOTE_HOSTNAME : clean;
}

/**
 * Command-line arguments passed to `cloudflared`. With a token, the token itself travels only
 * as `TUNNEL_TOKEN` in the environment (`tunnelEnvironment`): a command line is visible to
 * every process on the Mac (`ps`) and was written to tunnel.log's header.
 */
export function tunnelArguments(
  token: string | null,
  hostname: string,
  localTargetURL: string,
): string[] {
  if (token?.trim()) {
    return ["tunnel", "--no-autoupdate", "run", "--url", localTargetURL];
  }
  return [
    "tunnel",
    "--no-autoupdate",
    "run",
    "--url",
    localTargetURL,
    normalizedHostname(hostname),
  ];
}

/** The environment that carries the tunnel token (`cloudflared tunnel run` reads TUNNEL_TOKEN). */
export function tunnelEnvironment(token: string | null): Record<string, string> {
  const trimmed = token?.trim();
  return trimmed ? { TUNNEL_TOKEN: trimmed } : {};
}

/** The tunnel token the AppKit app keeps in the Keychain (read only when Remote Control is on). */
export async function readTunnelToken(): Promise<string | null> {
  const text = await output("/usr/bin/security", [
    "find-generic-password",
    "-s",
    "net.burakkoc.studio",
    "-a",
    "cloudflare-tunnel-token",
    "-w",
  ]);
  const token = text.trim();
  return token.length > 0 ? token : null;
}
