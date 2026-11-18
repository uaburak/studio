// What a packaged Mac app needs besides its window (P1, P2, P9), wired from app.ts with one call:
//
// - crash reports written locally next to the logs (`crashReporter`, never uploaded);
// - "Mac açılınca Studio'yu başlat" (the login item; only the packaged app registers itself);
// - "Mac'i uyanık tut": a power save blocker while jobs run or wait, or a schedule is due within
//   the hour (checked through the local API every minute);
// - updates: electron-updater, wired but off (`UPDATES` below; Squirrel.Mac needs a Developer ID
//   signature, docs/PACKAGING.md);
// - Ayarlar → Gelişmiş's IPC: the host's health (`/api/health` components), the tools Studio
//   does not carry and the Chromium install, the worker's keys (names only), runtime facts.
import { join } from "node:path";
import { app, crashReporter, type IpcMain, powerSaveBlocker } from "electron";
import type { DesktopSettings } from "../shared/ipc.ts";
import {
  type ChromiumStatus,
  type HostHealth,
  type LoginItemState,
  type RuntimeInfo,
  SYSTEM_IPC,
  type ToolsReport,
  type WorkerEnvView,
} from "../shared/system-ipc.ts";
import type { CreatedHost } from "./host/create-host.ts";
import { loginShellPath, which } from "./host/environment.ts";
import { ChromiumInstaller, detectTools } from "./host/tools.ts";
import { EDITABLE_WORKER_ENV } from "./host/worker-env.ts";

/**
 * Updates are off until Studio is signed with a Developer ID (S8): Squirrel.Mac refuses an
 * update whose signature does not match the running app's, and ad-hoc signatures change with
 * every build. To turn them on: set `enabled` and `feedUrl` here, and STUDIO_UPDATE_URL when
 * packaging (electron-builder then writes app-update.yml), see docs/PACKAGING.md.
 */
export const UPDATES: { readonly enabled: boolean; readonly feedUrl: string } = {
  enabled: false,
  feedUrl: "",
};

export function startCrashReporter(dir: string): void {
  try {
    app.setPath("crashDumps", dir);
    crashReporter.start({ uploadToServer: false, compress: true, submitURL: "" });
  } catch {
    // never stops the app
  }
}

// --- login item -----------------------------------------------------------------------------------

export function loginItemState(): LoginItemState {
  if (!app.isPackaged || process.platform !== "darwin") {
    return {
      supported: false,
      enabled: false,
      needsApproval: false,
      note: "Yalnızca paketlenmiş Studio uygulamasında (Studio.app) açılabilir.",
    };
  }
  const s = app.getLoginItemSettings({ type: "mainAppService" });
  const needsApproval = s.status === "requires-approval";
  return {
    supported: true,
    enabled: s.openAtLogin || s.status === "enabled",
    needsApproval,
    note: needsApproval
      ? "macOS onay bekliyor: Sistem Ayarları → Genel → Giriş Öğeleri'nde Studio'yu aç."
      : "Mac açılınca Studio arka planda başlar; sunucu ve zamanlanmış yayınlar çalışır.",
  };
}

export function setLoginItem(enabled: boolean): LoginItemState {
  if (app.isPackaged && process.platform === "darwin") {
    app.setLoginItemSettings({ openAtLogin: enabled, type: "mainAppService" });
  }
  return loginItemState();
}

// --- keep awake -----------------------------------------------------------------------------------

export interface KeepAwakeInput {
  /** Jobs running or waiting, and the earliest pending schedule (null: none). */
  busy(): Promise<{ jobs: number; nextScheduleAt: number | null } | null>;
  enabled(): boolean;
  now?: () => number;
  start?: () => number;
  stop?: (id: number) => void;
  log?: (message: string) => void;
}

/** Holds a "prevent app suspension" blocker while there is work now or within the hour. */
export class KeepAwake {
  private id: number | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  reason: string | null = null;

  constructor(private readonly o: KeepAwakeInput) {}

  get active(): boolean {
    return this.id !== null;
  }

  start(intervalMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), intervalMs);
    this.timer.unref?.();
    void this.check();
  }

  stopAll(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.release();
  }

  /** Decides from the current work; exported for tests. */
  async check(): Promise<void> {
    if (!this.o.enabled()) return this.release();
    const now = (this.o.now ?? Date.now)();
    let busy: Awaited<ReturnType<KeepAwakeInput["busy"]>> = null;
    try {
      busy = await this.o.busy();
    } catch {
      busy = null;
    }
    let reason: string | null = null;
    if (busy && busy.jobs > 0) reason = `${busy.jobs} iş sürüyor ya da bekliyor`;
    else if (busy?.nextScheduleAt !== null && busy?.nextScheduleAt !== undefined) {
      if (busy.nextScheduleAt - now <= 60 * 60_000)
        reason = "bir saat içinde zamanlanmış yayın var";
    }
    if (reason) this.hold(reason);
    else this.release();
  }

  private hold(reason: string): void {
    this.reason = reason;
    if (this.id !== null) return;
    this.id = (this.o.start ?? (() => powerSaveBlocker.start("prevent-app-suspension")))();
    this.o.log?.(`Mac uyanık tutuluyor: ${reason}`);
  }

  private release(): void {
    this.reason = null;
    if (this.id === null) return;
    (this.o.stop ?? ((id: number) => powerSaveBlocker.stop(id)))(this.id);
    this.id = null;
  }
}

// --- wiring ---------------------------------------------------------------------------------------

export interface SystemServicesInput {
  ipcMain: IpcMain;
  created: CreatedHost;
  stateDir: string;
  ownerSecret: () => string;
  settings: () => DesktopSettings;
  onSettingsChange: (listener: (settings: DesktopSettings) => void) => void;
  send: (channel: string, ...args: unknown[]) => boolean;
  log: (level: "info" | "warn" | "error", message: string) => void;
}

export interface SystemServices {
  keepAwake: KeepAwake;
  stop(): void;
}

export function setupSystemServices(input: SystemServicesInput): SystemServices {
  const { created, ipcMain } = input;
  const host = created.host;

  async function ownerJson<T>(path: string): Promise<T | null> {
    const port = host.apiPort;
    if (port === null) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { accept: "application/json", "X-Studio-Owner": input.ownerSecret() },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  const keepAwake = new KeepAwake({
    enabled: () => input.settings().keepAwake,
    log: (message) => input.log("info", message),
    busy: async () => {
      if (!host.isUp) return null;
      const presence = await ownerJson<{ currentJobs: unknown[]; queueLength: number }>(
        "/api/workers/presence",
      );
      const now = Date.now();
      const schedules = await ownerJson<{ items: { scheduledAt: string }[] }>(
        `/api/schedules?status=pending&from=${encodeURIComponent(new Date(now - 6 * 3_600_000).toISOString())}&to=${encodeURIComponent(new Date(now + 3_600_000).toISOString())}&limit=1`,
      );
      const next = schedules?.items[0]?.scheduledAt;
      return {
        jobs: (presence?.currentJobs.length ?? 0) + (presence?.queueLength ?? 0),
        nextScheduleAt: next ? Date.parse(next) : null,
      };
    },
  });
  keepAwake.start();
  input.onSettingsChange(() => void keepAwake.check());

  const chromium = new ChromiumInstaller({
    stateDir: input.stateDir,
    layout: () => created.layout(),
    runtime: (layout) => created.runtime(layout),
    onChange: (status: ChromiumStatus) => input.send(SYSTEM_IPC.chromiumChanged, status),
    log: (message) => input.log("info", message),
  });

  let toolsCache: { at: number; report: ToolsReport["tools"] } | null = null;
  ipcMain.handle(SYSTEM_IPC.tools, async (_e, refresh: unknown): Promise<ToolsReport> => {
    if (!toolsCache || refresh === true || Date.now() - toolsCache.at > 60_000) {
      toolsCache = { at: Date.now(), report: detectTools(await loginShellPath(), which) };
    }
    return { tools: toolsCache.report, chromium: chromium.current() };
  });
  ipcMain.handle(SYSTEM_IPC.chromiumInstall, async () => {
    const status = await chromium.install();
    // The worker reads PLAYWRIGHT_BROWSERS_PATH at start: a fresh install needs a restart only
    // when it changed where Chromium is.
    if (status.state === "ready" && host.ownsChildren) void host.restart();
    return status;
  });

  ipcMain.handle(SYSTEM_IPC.health, async (): Promise<HostHealth> => {
    const body = await ownerJson<{
      components?: HostHealth["components"];
      migrations?: HostHealth["migrations"];
    }>("/api/health");
    return {
      reachable: body !== null,
      components: body?.components ?? [],
      migrations: body?.migrations ?? null,
      checkedAt: new Date().toISOString(),
    };
  });

  const view = (): WorkerEnvView => ({
    ...created.workerEnv.summary(),
    editable: EDITABLE_WORKER_ENV.map((e) => ({ ...e })),
  });
  ipcMain.handle(SYSTEM_IPC.workerEnv, () => view());
  ipcMain.handle(SYSTEM_IPC.workerEnvSet, (_e, name: unknown, value: unknown) => {
    if (typeof name !== "string" || typeof value !== "string") return view();
    if (!EDITABLE_WORKER_ENV.some((e) => e.name === name)) return view();
    created.workerEnv.set(name, value);
    return view();
  });
  ipcMain.handle(SYSTEM_IPC.workerEnvRemove, (_e, name: unknown) => {
    if (typeof name === "string") created.workerEnv.remove(name);
    return view();
  });

  ipcMain.handle(SYSTEM_IPC.loginItem, () => loginItemState());
  ipcMain.handle(SYSTEM_IPC.loginItemSet, (_e, enabled: unknown) => setLoginItem(enabled === true));

  ipcMain.handle(
    SYSTEM_IPC.runtime,
    (): RuntimeInfo => ({
      mode: created.mode,
      root: created.layout()?.root ?? null,
      keepAwake: {
        enabled: input.settings().keepAwake,
        active: keepAwake.active,
        reason: keepAwake.reason,
      },
      updates: {
        enabled: UPDATES.enabled,
        note: UPDATES.enabled
          ? "Güncellemeler otomatik denetlenir."
          : "Otomatik güncelleme kapalı: Apple Developer imzası gelene kadar yeni sürümü elle kur.",
      },
      crashesDir: join(input.stateDir, "logs", "crashes"),
    }),
  );

  startUpdates(input.log);

  return {
    keepAwake,
    stop() {
      keepAwake.stopAll();
    },
  };
}

/** electron-updater behind `UPDATES.enabled` (off: nothing is loaded or contacted). */
function startUpdates(log: SystemServicesInput["log"]): void {
  if (!UPDATES.enabled || !app.isPackaged) return;
  void import("electron-updater")
    .then(({ autoUpdater }) => {
      if (UPDATES.feedUrl) autoUpdater.setFeedURL({ provider: "generic", url: UPDATES.feedUrl });
      autoUpdater.autoDownload = true;
      autoUpdater.on("error", (error) => log("warn", `güncelleme: ${error.message}`));
      return autoUpdater.checkForUpdatesAndNotify();
    })
    .catch((error: unknown) =>
      log(
        "warn",
        `güncelleme denetlenemedi: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
}
