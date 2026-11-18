// `Studio --self-test` (S3, P1, P9): proves an app build can run its host without windows.
//
// In a temporary state folder, on free ports, with a mock Keychain (no prompt, the owner's Keychain
// untouched), no Dock icon, no Bonjour and no tunnel, it starts the host the way the app does
// (dev: the repo; packaged: the bundle's host with Electron's own binary as Node), waits for the
// API, checks that the empty database was migrated, creates a brand and a content through the
// API, waits for the worker and the hidden canvas runner to connect, reads `/api/health`, stops
// everything and exits 0 (all passed) or 1, printing a JSON report. The worker runs with the AI
// off (`STUDIO_CLAUDE_ENABLED=0`): nothing is sent to a model.
//
//   out/…/Electron.app/…/Electron apps/desktop --self-test     (dev, after `electron-vite build`)
//   release/mac-arm64/Studio.app/Contents/MacOS/Studio --self-test
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCanvasRunner } from "@studio/contract";
import { app, crashReporter } from "electron";
import { CANVAS_RUNNER_PAGE } from "../shared/canvas-runner.ts";
import { CanvasExecutor, nodeHubSocket } from "./canvas/executor.ts";
import { CanvasRunnerWindow } from "./canvas/runner-window.ts";
import { createHost } from "./host/create-host.ts";
import { freePort, loginShellPath, which } from "./host/environment.ts";
import { isAlive } from "./host/guards.ts";
import { LOCK_FILE } from "./host/lock.ts";
import { loadOrCreateHostSecrets, loadOrCreateOwnerSecret } from "./host/secrets.ts";
import { detectTools, findChromium } from "./host/tools.ts";
import { installMainLog, MainLog } from "./main-log.ts";
import { APP_ORIGIN, handleAppProtocol, OWNER_HEADER } from "./protocol.ts";

export const SELF_TEST_ARG = "--self-test";

export function isSelfTest(argv: readonly string[] = process.argv): boolean {
  return argv.includes(SELF_TEST_ARG);
}

export interface SelfTestContext {
  root: string;
  stateDir: string;
}

/** Before `ready`: a throwaway profile and state folder, a mock Keychain. */
export function prepareSelfTest(): SelfTestContext {
  const root = mkdtempSync(join(tmpdir(), "studio-self-test-"));
  const stateDir = join(root, "state");
  app.commandLine.appendSwitch("use-mock-keychain");
  app.setPath("userData", join(root, "chromium"));
  app.setPath("crashDumps", join(stateDir, "logs", "crashes"));
  return { root, stateDir };
}

interface Step {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

class Steps {
  readonly list: Step[] = [];

  async run(name: string, task: () => Promise<string>): Promise<boolean> {
    const started = Date.now();
    try {
      const detail = await task();
      this.list.push({ name, ok: true, ms: Date.now() - started, detail });
      console.log(`✓ ${name} (${Date.now() - started} ms) ${detail}`);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.list.push({ name, ok: false, ms: Date.now() - started, detail });
      console.log(`✗ ${name} (${Date.now() - started} ms) ${detail}`);
      return false;
    }
  }
}

async function until<T>(
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | null | undefined | false>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `${what}: ${Math.round(timeoutMs / 1000)} sn içinde olmadı${last instanceof Error ? ` (${last.message})` : ""}`,
  );
}

function logTail(stateDir: string, name: string, lines = 15): string {
  try {
    return readFileSync(join(stateDir, "logs", `${name}.log`), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-lines)
      .join("\n");
  } catch {
    return "";
  }
}

export async function runSelfTest(ctx: SelfTestContext): Promise<number> {
  const started = Date.now();
  const steps = new Steps();
  const mainLog = new MainLog(join(ctx.stateDir, "logs", "desktop.log"));
  installMainLog(mainLog);
  crashReporter.start({ uploadToServer: false, submitURL: "", compress: true });
  // Closing the hidden canvas page must not quit before the report (Electron's default).
  app.on("window-all-closed", () => undefined);
  await app.whenReady();
  app.dock?.hide();
  app.setActivationPolicy?.("accessory");

  const ownerSecret = loadOrCreateOwnerSecret(ctx.stateDir);
  const apiPort = (await freePort("127.0.0.1")) ?? 18790;
  const created = createHost({
    stateDir: ctx.stateDir,
    configuration: () => ({
      hostEnabled: true,
      repoPath: "",
      lanEnabled: false,
      remoteControlEnabled: false,
      remoteHostname: "",
      preferredAPIPort: apiPort,
      preferredLANPort: 0,
    }),
    cipher: null,
    ownerSecret: () => ownerSecret,
    executable: process.execPath,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    version: app.getVersion(),
    hostDirOverride: process.env.STUDIO_HOST_DIR,
    readTunnelToken: async () => null,
    workerEnvOverrides: { STUDIO_CLAUDE_ENABLED: "0" },
    useWorkerEnvStore: false,
    log: (message) => mainLog.write("info", message),
  });
  const { host } = created;
  const layout = created.layout();
  const report: Record<string, unknown> = {
    app: { version: app.getVersion(), packaged: app.isPackaged, electron: process.versions.electron },
    mode: created.mode,
    layout: layout ? { mode: layout.mode, root: layout.root } : null,
    stateDir: ctx.stateDir,
    apiPort,
  };
  if (layout?.mode === "packaged") {
    try {
      report.manifest = JSON.parse(readFileSync(join(layout.root, "manifest.json"), "utf8"));
    } catch {
      report.manifest = null;
    }
  }

  const ownerFetch = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set(OWNER_HEADER, ownerSecret);
    headers.set("accept", "application/json");
    return fetch(`http://127.0.0.1:${host.apiPort ?? apiPort}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  };
  const json = async <T>(path: string, init: RequestInit = {}, status = 200): Promise<T> => {
    const res = await ownerFetch(path, init);
    const text = await res.text();
    if (res.status !== status) throw new Error(`${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  };
  type Health = {
    components?: { id: string; state: string; label: string; detail: string }[];
    migrations?: { applied: number; last: string | null; expected: string };
  };
  type Presence = { online: boolean; workers: { workerId: string; capabilities: string[] }[] };

  const canvas: { runner: CanvasRunnerWindow | null; executor: CanvasExecutor | null } = {
    runner: null,
    executor: null,
  };
  const pids: number[] = [];
  const watchdog = setTimeout(
    () => {
      console.log("✗ self-test: 8 dakikada bitmedi");
      app.exit(1);
    },
    8 * 60_000,
  );

  try {
    const hostUp = await steps.run("sunucu başlar (göçler + API)", async () => {
      await host.start();
      const status = host.status;
      if (status.kind !== "running") {
        const message = status.kind === "error" ? status.message : status.kind;
        throw new Error(
          `${message}\n--- migrate.log\n${logTail(ctx.stateDir, "migrate")}\n--- api.log\n${logTail(ctx.stateDir, "api")}`,
        );
      }
      for (const phase of Object.values(host.snapshot().services)) {
        if (phase?.kind === "running") pids.push(phase.pid);
      }
      return `API ${host.apiPort}, ${layout?.mode ?? "?"} düzeni`;
    });

    if (hostUp) {
      await steps.run("durum klasörü kilitli", async () => {
        const lock = JSON.parse(readFileSync(join(ctx.stateDir, LOCK_FILE), "utf8")) as {
          pid: number;
        };
        if (lock.pid !== process.pid) throw new Error(`kilit başka işlemde: ${lock.pid}`);
        return `pid ${lock.pid}`;
      });

      await steps.run("sağlık ucu + boş veritabanı göçleri", async () => {
        const health = await json<Health>("/api/health");
        const byId = Object.fromEntries((health.components ?? []).map((c) => [c.id, c]));
        for (const id of ["db", "storage", "migrations", "vault"]) {
          if (byId[id]?.state !== "ok") {
            throw new Error(`${id}: ${byId[id]?.state ?? "yok"} ${byId[id]?.detail ?? ""}`);
          }
        }
        report.migrations = health.migrations;
        return `${health.migrations?.applied} göç, son ${health.migrations?.last}`;
      });

      await steps.run("API ile marka ve içerik oluşturulur", async () => {
        const brand = await json<{ id: string }>(
          "/api/brands",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name: "Öz Sınama Markası", slug: "oz-sinama" }),
          },
          201,
        );
        const content = await json<{ id: string }>(
          "/api/contents",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ brandId: brand.id, type: "post", title: "Öz sınama içeriği" }),
          },
          201,
        );
        const back = await json<{ id: string; title: string }>(`/api/contents/${content.id}`);
        if (back.title !== "Öz sınama içeriği") throw new Error("içerik geri okunamadı");
        return `marka ${brand.id}, içerik ${content.id}`;
      });

      await steps.run("worker bağlanır", async () => {
        const presence = await until("worker bağlantısı", 90_000, async () => {
          const p = await json<Presence>("/api/workers/presence");
          return p.online ? p : null;
        });
        const worker = presence.workers.find((w) => !isCanvasRunner(w.capabilities));
        return `${worker?.workerId ?? "?"}: ${worker?.capabilities.length ?? 0} iş türü`;
      });

      await steps.run("gizli tuval çalıştırıcısı açılır ve bağlanır", async () => {
        handleAppProtocol(
          join(import.meta.dirname, "../renderer"),
          () => host.apiPort,
          () => ownerSecret,
        );
        const runner = new CanvasRunnerWindow({
          url: () => `${APP_ORIGIN}/${CANVAS_RUNNER_PAGE}`,
          preload: join(import.meta.dirname, "../preload/index.cjs"),
          readyTimeoutMs: 60_000,
          log: (message) => mainLog.write("warn", message),
        });
        canvas.runner = runner;
        await runner.warmUp();
        const token = loadOrCreateHostSecrets(ctx.stateDir, null).workerToken;
        const executor = new CanvasExecutor({
          workerId: "studio-canvas",
          version: app.getVersion(),
          target: () =>
            host.apiPort === null
              ? null
              : { url: `ws://127.0.0.1:${host.apiPort}/api/hub`, token },
          socket: nodeHubSocket,
          runner,
          log: (message) => mainLog.write("warn", message),
        });
        canvas.executor = executor;
        executor.start();
        await until("tuval çalıştırıcısının bağlantısı", 30_000, async () => {
          const p = await json<Presence>("/api/workers/presence");
          return p.workers.some((w) => isCanvasRunner(w.capabilities));
        });
        return "sayfa hazır, hub'a bağlı";
      });

      await steps.run("sağlık ucu: worker ve tuval", async () => {
        const health = await json<Health>("/api/health");
        report.health = health.components;
        const bad = (health.components ?? []).filter((c) => c.state === "fail");
        if (bad.length > 0) {
          throw new Error(bad.map((c) => `${c.label}: ${c.detail}`).join("; "));
        }
        const byId = Object.fromEntries((health.components ?? []).map((c) => [c.id, c]));
        if (byId.worker?.state !== "ok" || byId.canvas?.state !== "ok") {
          throw new Error(`worker ${byId.worker?.state}, tuval ${byId.canvas?.state}`);
        }
        return (health.components ?? []).map((c) => `${c.id}=${c.state}`).join(" ");
      });
    }

    // Informational: what the owner would have to install (never pass / fail).
    if (layout) {
      const path = await loginShellPath();
      report.chromium = findChromium(layout, ctx.stateDir);
      report.tools = detectTools(path, which).map((t) => ({ id: t.id, state: t.state }));
    }
  } finally {
    canvas.executor?.stop();
    canvas.runner?.close();
    await steps.run("sunucu kapanır, süreçler biter, kilit bırakılır", async () => {
      await host.stop({ graceMs: 5_000 });
      await until("alt süreçlerin bitmesi", 10_000, async () => pids.every((p) => !isAlive(p)));
      if (existsSync(join(ctx.stateDir, LOCK_FILE))) throw new Error("kilit dosyası kaldı");
      if (existsSync(join(ctx.stateDir, "host.json"))) throw new Error("host.json kaldı");
      return `${pids.length} alt süreç durdu`;
    });
    clearTimeout(watchdog);
  }

  const ok = steps.list.every((s) => s.ok);
  report.ok = ok;
  report.seconds = Math.round((Date.now() - started) / 100) / 10;
  report.steps = steps.list;
  const text = JSON.stringify(report, null, 2);
  writeFileSync(join(ctx.root, "self-test-report.json"), `${text}\n`);
  console.log(`STUDIO_SELF_TEST_REPORT ${JSON.stringify(report)}`);
  console.log(ok ? "SELF-TEST OK" : `SELF-TEST FAILED (kayıtlar: ${ctx.stateDir}/logs)`);
  if (ok) rmSync(ctx.root, { recursive: true, force: true });
  return ok ? 0 : 1;
}
