// Packaging (S3, P1, P2, P9): dev vs packaged paths, the state folder's lock, the worker's keys
// from the app's store, the tools Studio does not carry, keeping the Mac awake.
import { mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
  crashReporter: { start: vi.fn() },
  powerSaveBlocker: { start: vi.fn(() => 1), stop: vi.fn() },
}));

import { defaultRepoPath } from "../../src/main/host/environment.ts";
import {
  chooseLayout,
  devLayout,
  electronNodeRuntime,
  findRepo,
  packagedLayout,
  runtimeApiConfig,
} from "../../src/main/host/layout.ts";
import {
  HostLock,
  holderAlive,
  type LockDeps,
  lockHeldMessage,
  parseLstart,
} from "../../src/main/host/lock.ts";
import type { Cipher } from "../../src/main/host/secrets.ts";
import {
  chromiumRevision,
  detectTools,
  findChromium,
  parseInstallProgress,
} from "../../src/main/host/tools.ts";
import { allowedWorkerEnvName, WorkerEnvStore } from "../../src/main/host/worker-env.ts";
import { KeepAwake } from "../../src/main/system-services.ts";

const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

function fakeRepo(): string {
  const root = tmp("studio-repo-");
  mkdirSync(join(root, "apps", "api"), { recursive: true });
  mkdirSync(join(root, "apps", "desktop", "out", "main"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "");
  writeFileSync(join(root, "apps", "api", "wrangler.jsonc"), "{}");
  return root;
}

describe("host layout: dev or packaged, chosen explicitly", () => {
  it("dev: the repo the build runs from, its wrangler, tsx worker and .env", () => {
    const repo = fakeRepo();
    const layout = chooseLayout({
      isPackaged: false,
      resourcesPath: "/unused",
      appPath: join(repo, "apps", "desktop"),
      stateDir: "/state",
    });
    expect(layout?.mode).toBe("dev");
    expect(layout?.root).toBe(repo);
    expect(layout?.wrangler).toBe(
      join(repo, "apps", "api", "node_modules", "wrangler", "bin", "wrangler.js"),
    );
    expect(layout?.workerArgs).toEqual([
      `--env-file-if-exists=${join(repo, ".env")}`,
      "--import",
      "tsx",
      "src/main.ts",
    ]);
    expect(layout?.skillsDir).toBeNull();
    expect(layout?.wranglerArgs).toEqual([]);
  });

  it("dev: the repo setting wins over the build's own checkout", () => {
    const layout = chooseLayout({
      isPackaged: false,
      resourcesPath: "/unused",
      appPath: "/somewhere",
      stateDir: "/state",
      repoSetting: "/other/repo",
    });
    expect(layout?.root).toBe("/other/repo");
  });

  it("packaged: Contents/Resources/host, never a repo or a guessed developer folder", () => {
    const layout = chooseLayout({
      isPackaged: true,
      resourcesPath: "/Applications/Studio.app/Contents/Resources",
      appPath: "/Applications/Studio.app/Contents/Resources/app.asar",
      stateDir: "/state",
      repoSetting: "/Users/x/Code/Studio",
    });
    const host = "/Applications/Studio.app/Contents/Resources/host";
    expect(layout?.mode).toBe("packaged");
    expect(layout?.root).toBe(host);
    expect(layout?.repo).toBeNull();
    expect(layout?.wrangler).toBe(join(host, "node_modules", "wrangler", "bin", "wrangler.js"));
    expect(layout?.wranglerArgs).toEqual(["--config", "/state/runtime/api/wrangler.json"]);
    expect(layout?.apiCwd).toBe("/state/runtime/api");
    expect(layout?.workerArgs).toEqual(["--enable-source-maps", join(host, "worker", "main.js")]);
    expect(layout?.skillsDir).toBe(join(host, "agent", "skills"));
    expect(layout?.leftoverPatterns.every((p) => p.startsWith(host))).toBe(true);
  });

  it("STUDIO_HOST_DIR runs a staged host from a dev build", () => {
    const layout = chooseLayout({
      isPackaged: false,
      resourcesPath: "/unused",
      appPath: "/unused",
      stateDir: "/state",
      hostDirOverride: "/repo/apps/desktop/out/host",
    });
    expect(layout?.mode).toBe("packaged");
    expect(layout?.root).toBe("/repo/apps/desktop/out/host");
  });

  it("no repo and not packaged: no layout (the old hard-coded folder is gone)", () => {
    const dir = tmp("studio-norepo-");
    expect(findRepo(dir)).toBeNull();
    expect(defaultRepoPath(dir)).toBe("");
    expect(
      chooseLayout({ isPackaged: false, resourcesPath: "/x", appPath: dir, stateDir: "/s" }),
    ).toBeNull();
  });

  it("Electron's binary as Node: the shim first, ELECTRON_RUN_AS_NODE", () => {
    expect(electronNodeRuntime("/A/Studio", "/A/host")).toEqual({
      executable: "/A/Studio",
      args: ["--require=/A/host/bin/node-shim.cjs"],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("writes wrangler's config in the state folder with paths into the app", () => {
    const host = tmp("studio-host-");
    const state = tmp("studio-state-");
    mkdirSync(join(host, "api"));
    writeFileSync(
      join(host, "api", "wrangler.json"),
      JSON.stringify({
        name: "studio-api",
        main: "index.js",
        d1_databases: [{ binding: "DB", database_id: "x", migrations_dir: "migrations" }],
      }),
    );
    const layout = packagedLayout(host, state);
    layout.prepare(state);
    const file = join(state, "runtime", "api", "wrangler.json");
    const written = JSON.parse(readFileSync(file, "utf8"));
    expect(written).toMatchObject({
      name: "studio-api",
      main: join(host, "api", "index.js"),
      no_bundle: true,
      send_metrics: false,
      d1_databases: [
        { binding: "DB", database_id: "x", migrations_dir: join(host, "api", "migrations") },
      ],
    });
    // Unchanged config: not rewritten (wrangler would restart on a change).
    const before = statSync(file).mtimeMs;
    utimesSync(file, new Date(0), new Date(0));
    layout.prepare(state);
    expect(statSync(file).mtimeMs).not.toBe(before);
    expect(statSync(file).mtimeMs).toBe(0);
  });

  it("absolute paths in the template are kept", () => {
    expect(runtimeApiConfig({ main: "/abs/index.js" }, "/host").main).toBe("/abs/index.js");
  });

  it("dev layout says how to fix a missing install", () => {
    expect(devLayout("/r").missingMessage("/r/x")).toContain("pnpm install");
    expect(packagedLayout("/h", "/s").missingMessage("/h/x")).toContain("yeniden indirip kur");
  });
});

describe("host.lock", () => {
  const deps = (alive: Record<number, number | null>): LockDeps => ({
    isAlive: (pid) => pid in alive,
    processStartedAt: (pid) => alive[pid] ?? null,
    now: Date.now,
  });

  it("is atomic and re-entrant for its own process", () => {
    const dir = tmp("studio-lock-");
    const lock = new HostLock(dir, { pid: 10, mode: "dev", version: "1" }, deps({ 10: 1000 }));
    expect(lock.acquire()).toEqual({ kind: "acquired" });
    expect(lock.acquire()).toEqual({ kind: "acquired" });
    const info = JSON.parse(readFileSync(join(dir, "host.lock"), "utf8"));
    expect(info).toMatchObject({ pid: 10, startedAt: 1000, mode: "dev" });
    expect(statSync(join(dir, "host.lock")).mode & 0o777).toBe(0o600);
    lock.release();
    expect(() => readFileSync(join(dir, "host.lock"))).toThrow();
  });

  it("a second process sees it held, with a Turkish explanation", () => {
    const dir = tmp("studio-lock-");
    const alive = deps({ 10: 1000, 11: 2000 });
    const first = new HostLock(dir, { pid: 10, mode: "packaged", version: "1" }, alive);
    const second = new HostLock(dir, { pid: 11, mode: "dev", version: "1" }, alive);
    first.acquire();
    const outcome = second.acquire();
    expect(outcome.kind).toBe("held");
    if (outcome.kind === "held") {
      expect(outcome.holder.pid).toBe(10);
      expect(lockHeldMessage(outcome.holder)).toContain("Studio uygulaması, işlem 10");
    }
    // Releasing someone else's lock does nothing.
    second.release();
    expect(JSON.parse(readFileSync(join(dir, "host.lock"), "utf8")).pid).toBe(10);
  });

  it("a dead holder, or its pid reused by another process, is stale", () => {
    const dir = tmp("studio-lock-");
    writeFileSync(join(dir, "host.lock"), JSON.stringify({ pid: 10, startedAt: 1000 }));
    // pid 10 now belongs to a process started much later.
    const lock = new HostLock(
      dir,
      { pid: 11, mode: "dev", version: "1" },
      deps({ 10: 99_000, 11: 1 }),
    );
    expect(lock.acquire()).toEqual({ kind: "acquired" });
    expect(JSON.parse(readFileSync(join(dir, "host.lock"), "utf8")).pid).toBe(11);
    expect(
      holderAlive(
        { pid: 10, startedAt: 1000, mode: "", version: "", host: "", acquiredAt: "" },
        deps({}),
      ),
    ).toBe(false);
  });

  it("a half-written lock is waited for, then taken over when old", () => {
    const dir = tmp("studio-lock-");
    writeFileSync(join(dir, "host.lock"), "");
    const now = { t: Date.now() };
    const d: LockDeps = { isAlive: () => false, processStartedAt: () => null, now: () => now.t };
    const lock = new HostLock(dir, { pid: 11, mode: "dev", version: "1" }, d);
    expect(lock.acquire().kind).toBe("held");
    now.t += 60_000;
    expect(lock.acquire()).toEqual({ kind: "acquired" });
  });

  it("reads ps start times", () => {
    expect(parseLstart("Wed Nov 18 21:12:03 2026\n")).toBe(Date.parse("Wed Nov 18 21:12:03 2026"));
    expect(parseLstart("")).toBeNull();
  });
});

/** A reversible stand-in for safeStorage. */
const cipher: Cipher = {
  available: () => true,
  encrypt: (text) => Buffer.from(`sealed:${text}`, "utf8"),
  decrypt: (data) => {
    const text = data.toString("utf8");
    if (!text.startsWith("sealed:")) throw new Error("not sealed");
    return text.slice("sealed:".length);
  },
};

describe("worker keys from the app's secure settings", () => {
  it("allows provider keys and worker settings, never the host's own variables", () => {
    for (const name of ["GEMINI_API_KEY", "ELEVENLABS_API_KEY", "STUDIO_GEMINI_MODEL_PRO"]) {
      expect(allowedWorkerEnvName(name)).toBe(true);
    }
    for (const name of [
      "STUDIO_HUB_URL",
      "STUDIO_WORKER_TOKEN",
      "STUDIO_API_URL",
      "PATH",
      "ANTHROPIC_API_KEY",
      "HOME",
    ]) {
      expect(allowedWorkerEnvName(name)).toBe(false);
    }
  });

  it("keeps values sealed, shows names only", () => {
    const dir = tmp("studio-wenv-");
    const store = new WorkerEnvStore(dir, cipher);
    store.set("ELEVENLABS_API_KEY", "  eleven-secret-value  ");
    const raw = readFileSync(join(dir, "worker-env.json"), "utf8");
    expect(raw).not.toContain("eleven-secret-value");
    expect(statSync(join(dir, "worker-env.json")).mode & 0o777).toBe(0o600);
    expect(store.env()).toEqual({ ELEVENLABS_API_KEY: "eleven-secret-value" });
    expect(store.summary()).toEqual({
      entries: [{ name: "ELEVENLABS_API_KEY", source: "settings" }],
      imported: null,
      sealed: true,
    });
    expect(() => store.set("STUDIO_WORKER_TOKEN", "x")).toThrow();
    store.remove("ELEVENLABS_API_KEY");
    expect(store.env()).toEqual({});
  });

  it("imports a dev .env once, again only after it changed", () => {
    const dir = tmp("studio-wenv-");
    const env = join(tmp("studio-repo-"), ".env");
    writeFileSync(
      env,
      "GEMINI_API_KEY=gemini-1\nSTUDIO_HUB_URL=ws://elsewhere\nOTHER=1\nSTUDIO_LOG_LEVEL=debug\n",
    );
    const store = new WorkerEnvStore(dir, cipher);
    expect(store.syncFromDotEnv(env)?.sort()).toEqual(["GEMINI_API_KEY", "STUDIO_LOG_LEVEL"]);
    expect(store.syncFromDotEnv(env)).toBeNull();
    expect(store.env()).toEqual({ GEMINI_API_KEY: "gemini-1", STUDIO_LOG_LEVEL: "debug" });
    store.set("ELEVENLABS_API_KEY", "set-in-settings");
    // Changed .env: new values come in, names it dropped go, Settings' own values stay.
    writeFileSync(env, "GEMINI_API_KEY=gemini-2\n");
    utimesSync(env, new Date(), new Date(Date.now() + 5_000));
    expect(store.syncFromDotEnv(env)).toEqual(["GEMINI_API_KEY"]);
    expect(store.env()).toEqual({
      GEMINI_API_KEY: "gemini-2",
      ELEVENLABS_API_KEY: "set-in-settings",
    });
    expect(store.summary().imported).toMatchObject({ from: env, count: 1 });
    expect(store.syncFromDotEnv(join(dir, "missing.env"))).toBeNull();
  });

  it("without the Keychain: plain 0600 values, said so", () => {
    const dir = tmp("studio-wenv-");
    const store = new WorkerEnvStore(dir, null);
    store.set("GEMINI_API_KEY", "plain-key");
    expect(store.env()).toEqual({ GEMINI_API_KEY: "plain-key" });
    expect(store.summary().sealed).toBe(false);
  });
});

describe("tools Studio does not carry", () => {
  function playwright(revision: string): string {
    const repo = tmp("studio-pw-");
    const dir = join(repo, "apps", "worker", "node_modules", "playwright-core");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "browsers.json"),
      JSON.stringify({ browsers: [{ name: "chromium-headless-shell", revision }] }),
    );
    return repo;
  }

  it("finds Chromium in the state folder, then Playwright's cache, else asks to install", () => {
    const repo = playwright("1255");
    const layout = devLayout(repo);
    const state = tmp("studio-state-");
    const home = tmp("studio-home-");
    expect(chromiumRevision(join(repo, "apps", "worker", "node_modules", "playwright-core"))).toBe(
      "1255",
    );
    const missing = findChromium(layout, state, home);
    expect(missing).toMatchObject({ state: "missing", browsersPath: join(state, "browsers") });
    expect(missing.message).toContain("Chromium'u indir");
    const cache = join(home, "Library", "Caches", "ms-playwright", "chromium_headless_shell-1255");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, "INSTALLATION_COMPLETE"), "");
    expect(findChromium(layout, state, home)).toMatchObject({
      state: "ready",
      location: "cache",
      browsersPath: null,
    });
    const own = join(state, "browsers", "chromium_headless_shell-1255");
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "INSTALLATION_COMPLETE"), "");
    expect(findChromium(layout, state, home)).toMatchObject({ state: "ready", location: "state" });
  });

  it("reads the installer's progress", () => {
    expect(parseInstallProgress("|■■■■      |  40% of 90.1 MiB\n|■■■■■■|  55% of")).toBe(55);
    expect(parseInstallProgress("Downloading Chrome Headless Shell")).toBeNull();
  });

  it("says what is missing and the one-line install", () => {
    const tools = detectTools(
      "/usr/bin",
      (tool) => (tool === "claude" ? "/x/claude" : null),
      "/nohome",
    );
    const ffmpeg = tools.find((t) => t.id === "ffmpeg");
    expect(ffmpeg).toMatchObject({ state: "missing", install: "brew install ffmpeg" });
    expect(tools.find((t) => t.id === "claude")).toMatchObject({
      state: "ok",
      path: "/x/claude",
      install: null,
    });
  });
});

describe("keeping the Mac awake (P2)", () => {
  function keeper(busy: { jobs: number; nextScheduleAt: number | null } | null, enabled = true) {
    const start = vi.fn(() => 7);
    const stop = vi.fn();
    const k = new KeepAwake({
      busy: async () => busy,
      enabled: () => enabled,
      now: () => 0,
      start,
      stop,
    });
    return { k, start, stop };
  }

  it("holds while jobs run or wait, and lets go after", async () => {
    const busy = { jobs: 2, nextScheduleAt: null as number | null };
    const start = vi.fn(() => 7);
    const stop = vi.fn();
    const k = new KeepAwake({
      busy: async () => busy,
      enabled: () => true,
      now: () => 0,
      start,
      stop,
    });
    await k.check();
    expect(k.active).toBe(true);
    expect(k.reason).toContain("2 iş");
    await k.check();
    expect(start).toHaveBeenCalledTimes(1);
    busy.jobs = 0;
    await k.check();
    expect(k.active).toBe(false);
    expect(stop).toHaveBeenCalledWith(7);
  });

  it("holds for a schedule due within the hour only", async () => {
    const soon = keeper({ jobs: 0, nextScheduleAt: 30 * 60_000 });
    await soon.k.check();
    expect(soon.k.active).toBe(true);
    const later = keeper({ jobs: 0, nextScheduleAt: 3 * 3_600_000 });
    await later.k.check();
    expect(later.k.active).toBe(false);
  });

  it("never holds when switched off or the host is down", async () => {
    const off = keeper({ jobs: 5, nextScheduleAt: null }, false);
    await off.k.check();
    expect(off.start).not.toHaveBeenCalled();
    const down = keeper(null);
    await down.k.check();
    expect(down.start).not.toHaveBeenCalled();
  });
});
