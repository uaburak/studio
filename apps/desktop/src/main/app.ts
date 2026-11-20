// Electron main process: the window (Claude Code style: hidden inset title bar, traffic lights
// in the unified top bar, sidebar vibrancy), the local host supervisor, settings, the menu,
// notifications, backups and the typed IPC the preload exposes. Started by index.ts only in the
// copy of the app that holds the single-instance lock.
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  session,
  shell,
} from "electron";
import { ACCOUNTS_IPC } from "../shared/accounts-ipc.ts";
import { CANVAS_RUNNER_PAGE } from "../shared/canvas-runner.ts";
import { DRAFTS_IPC } from "../shared/drafts.ts";
import { FONTS_IPC } from "../shared/fonts.ts";
import {
  type DesktopSettings,
  IPC,
  type MenuCommand,
  type NoticeInput,
  type SettingsPatch,
} from "../shared/ipc.ts";
import { createSecretStore, safeStorageCipher, setupAccounts } from "./accounts/setup.ts";
import { ActivityNotices, getOwnerJson, nodeActivitySocket } from "./activity-notices.ts";
import { BackupService } from "./backup-service.ts";
import { CanvasExecutor, nodeHubSocket } from "./canvas/executor.ts";
import { CanvasRunnerWindow } from "./canvas/runner-window.ts";
import { DraftStore } from "./drafts.ts";
import { RendererFlush } from "./flush.ts";
import { FontFiles, FontLister } from "./fonts.ts";
import { createHost } from "./host/create-host.ts";
import { defaultRepoPath, macUserName, stateDirectory } from "./host/environment.ts";
import type { HostConfiguration } from "./host/local-host.ts";
import {
  loadOrCreateHostSecrets,
  loadOrCreateInstanceId,
  loadOrCreateOwnerSecret,
  writeHostSecrets,
  writeInstanceId,
  writeOwnerSecret,
} from "./host/secrets.ts";
import { installMainLog, MainLog } from "./main-log.ts";
import { buildMenu } from "./menu.ts";
import { NoticeLog, Notifier } from "./notifications.ts";
import { permissionAllowed } from "./permissions.ts";
import { setupPostFiles } from "./post-files-ipc.ts";
import { APP_ORIGIN, handleAppProtocol, OWNER_HEADER } from "./protocol.ts";
import { needsOwnerHeader, originOf } from "./protocol-paths.ts";
import { PublishingSync } from "./publishing-sync.ts";
import { RendererLink, watchRenderer } from "./renderer-link.ts";
import { defaultSettings, SettingsStore } from "./settings.ts";
import { type SystemServices, setupSystemServices } from "./system-services.ts";

export function startApp(): void {
  const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
  const devOrigin =
    isDev && process.env.ELECTRON_RENDERER_URL ? originOf(process.env.ELECTRON_RENDERER_URL) : null;
  /** Pages that are this app (permissions, owner secret). */
  const appOrigins = [APP_ORIGIN, ...(devOrigin ? [devOrigin] : [])];
  const stateDir = stateDirectory();
  // The app's own log (A11): warnings, errors, unhandled rejections, renderer crashes.
  const mainLog = new MainLog(join(stateDir, "logs", "desktop.log"));
  installMainLog(mainLog);
  mainLog.write("info", `Studio ${app.getVersion()} açılıyor`);
  // The Mac user's full name (the greeting's fallback), read in the background.
  let macUser = "";
  void macUserName().then((name) => {
    macUser = name;
  });

  const settings = new SettingsStore(
    join(stateDir, "desktop-settings.json"),
    defaultSettings(defaultRepoPath(app.getAppPath())),
  );

  function hostConfiguration(): HostConfiguration {
    const s = settings.get();
    return {
      hostEnabled: s.hostEnabled,
      repoPath: s.repoPath,
      lanEnabled: s.lanEnabled,
      remoteControlEnabled: s.remoteControlEnabled,
      remoteHostname: s.remoteHostname,
      preferredAPIPort: 8790,
      preferredLANPort: 8791,
    };
  }

  // Meta / LinkedIn app secrets and the tunnel token (safeStorage).
  const secrets = createSecretStore(stateDir);

  // Proves to the API that a request is this app's own (G1). Replaced by a restore.
  let ownerSecret = loadOrCreateOwnerSecret(stateDir);
  const currentOwnerSecret = () => ownerSecret;

  // Dev: the repo this build runs from; packaged: Contents/Resources/host (host/layout.ts).
  const created = createHost({
    stateDir,
    configuration: hostConfiguration,
    cipher: safeStorageCipher,
    ownerSecret: currentOwnerSecret,
    executable: process.execPath,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    version: app.getVersion(),
    hostDirOverride: process.env.STUDIO_HOST_DIR,
    readTunnelToken: () => secrets.load("cloudflare-tunnel-token"),
    log: (message) => mainLog.write("info", message),
  });
  const host = created.host;

  let mainWindow: BrowserWindow | null = null;

  function send(channel: string, ...args: unknown[]): boolean {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed())
      return false;
    mainWindow.webContents.send(channel, ...args);
    return true;
  }

  /** Notice clicks and app notices reach the page only once it listens (A8 handshake). */
  const rendererLink = new RendererLink(send);

  // Close / quit: the page writes the open post's draft first (E14), within a short wait.
  const rendererFlush = new RendererFlush({
    send: (id) => {
      const w = mainWindow;
      if (!w || w.isDestroyed() || w.webContents.isDestroyed() || w.webContents.isCrashed())
        return false;
      w.webContents.send(DRAFTS_IPC.flushRequest, id);
      return true;
    },
    onDone: (listener) => {
      const handler = (_event: unknown, id: unknown) => {
        if (typeof id === "number") listener(id);
      };
      ipcMain.on(DRAFTS_IPC.flushDone, handler);
      return () => ipcMain.removeListener(DRAFTS_IPC.flushDone, handler);
    },
    timeoutMs: 2000,
  });
  /** The page was asked to flush for this quit (the windows then close without asking again). */
  let flushedForQuit = false;

  // Shown notifications are kept until clicked or closed: an object the garbage collector took
  // would no longer deliver its click.
  const shownNotices = new Set<Notification>();
  const notifier = new Notifier(
    {
      isSupported: () => Notification.isSupported(),
      show(notice, onClick) {
        const n = new Notification({ title: notice.title, body: notice.body, silent: false });
        shownNotices.add(n);
        const forget = () => shownNotices.delete(n);
        n.on("click", () => {
          forget();
          onClick();
        });
        n.on("close", forget);
        n.on("failed", forget);
        n.show();
        // Never more than a screenful kept.
        if (shownNotices.size > 50) {
          const oldest = shownNotices.values().next().value;
          if (oldest) shownNotices.delete(oldest);
        }
      },
    },
    new NoticeLog(join(stateDir, "desktop-notices.json")),
    () => settings.get().notificationsEnabled,
    (route) => {
      if (!mainWindow) createWindow();
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
      // A window that was just made gets the route once its page listens.
      if (route) rendererLink.openRoute(route);
    },
  );

  // Job, publish and consent notices come from here, also while the window is closed (A8).
  const activity = new ActivityNotices({
    target: () => {
      const snapshot = host.snapshot();
      const up = snapshot.status.kind === "running" || snapshot.status.kind === "attached";
      return up && snapshot.apiPort !== null
        ? { port: snapshot.apiPort, ownerSecret: currentOwnerSecret() }
        : null;
    },
    socket: nodeActivitySocket,
    getJson: getOwnerJson,
    post: (notice) => void notifier.post(notice),
    windowFocused: () =>
      mainWindow !== null &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible() &&
      mainWindow.isFocused(),
    currentRoute: () => settings.get().session.route,
    log: (message) => mainLog.write("warn", message),
  });

  function applyAppearance(value: DesktopSettings["appearance"]): void {
    nativeTheme.themeSource = value;
  }

  /**
   * The session of the app's pages: the owner secret on their own API requests and WebSockets
   * (G1), and web permissions denied except the few the app uses (G7).
   */
  function secureSession(): void {
    const ses = session.defaultSession;
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (needsOwnerHeader(details.url, host.apiPort, devOrigin)) {
        callback({ requestHeaders: { ...details.requestHeaders, [OWNER_HEADER]: ownerSecret } });
      } else {
        callback({});
      }
    });
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(permissionAllowed(permission, details.requestingUrl, appOrigins));
    });
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      permissionAllowed(permission, requestingOrigin, appOrigins),
    );
  }

  function createWindow(): void {
    const window = new BrowserWindow({
      width: 1424,
      height: 949,
      minWidth: 880,
      minHeight: 560,
      title: "Studio",
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 18, y: 16 },
      vibrancy: "sidebar",
      visualEffectState: "followWindow",
      backgroundColor: "#00000000",
      show: false,
      webPreferences: {
        preload: join(import.meta.dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });
    mainWindow = window;
    rendererLink.reset();
    window.once("ready-to-show", () => window.show());
    // Each load (a reload too) must say it is ready before notice routes are delivered.
    window.webContents.on("did-start-loading", () => rendererLink.reset());
    // A crashed or hung page is reloaded, with a short notice once it is back (A11).
    watchRenderer(window.webContents, {
      link: rendererLink,
      log: (message) => mainLog.write("error", message),
    });
    const pushState = () =>
      send(IPC.windowState, { fullScreen: window.isFullScreen(), focused: window.isFocused() });
    for (const event of ["enter-full-screen", "leave-full-screen", "focus", "blur"] as const) {
      window.on(event as "focus", pushState);
    }
    window.webContents.on("did-finish-load", pushState);
    // Back / forward from the trackpad ("swipe": macOS, when "Swipe between pages" uses three
    // fingers) and from mouse buttons on other platforms ("app-command"). The renderer also
    // reads two-finger swipes from wheel events and keeps one step per gesture.
    window.on("swipe", (_event, direction) => {
      if (direction === "left") send(IPC.menuCommand, "swipe-back" satisfies MenuCommand);
      else if (direction === "right") send(IPC.menuCommand, "swipe-forward" satisfies MenuCommand);
    });
    window.on("app-command", (_event, command) => {
      if (command === "browser-backward") send(IPC.menuCommand, "swipe-back" satisfies MenuCommand);
      else if (command === "browser-forward")
        send(IPC.menuCommand, "swipe-forward" satisfies MenuCommand);
    });
    // Links open in the browser, never inside the app.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
      const allowed = isDev ? (process.env.ELECTRON_RENDERER_URL ?? "") : APP_ORIGIN;
      if (!url.startsWith(allowed)) {
        event.preventDefault();
        if (/^https?:/i.test(url)) void shell.openExternal(url);
      }
    });
    // The red button / ⌘W: the open post's draft is written before the page goes.
    let closeFlushed = false;
    window.on("close", (event) => {
      if (closeFlushed || flushedForQuit) return;
      event.preventDefault();
      void rendererFlush.run().finally(() => {
        closeFlushed = true;
        if (!window.isDestroyed()) window.close();
      });
    });
    window.on("closed", () => {
      if (mainWindow === window) mainWindow = null;
    });
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
      void window.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void window.loadURL(`${APP_ORIGIN}/index.html`);
    }
  }

  const backups = new BackupService({
    stateDir,
    version: app.getVersion(),
    withStoppedHost: (message, task) => host.withStopped(message, task),
    readSecrets: () => {
      const sealed = loadOrCreateHostSecrets(stateDir, safeStorageCipher);
      return {
        workerToken: sealed.workerToken,
        vaultKey: sealed.vaultKey,
        ownerSecret,
        instanceId: loadOrCreateInstanceId(stateDir),
      };
    },
    applySecrets: (restored) => {
      writeHostSecrets(
        stateDir,
        { workerToken: restored.workerToken, vaultKey: restored.vaultKey },
        safeStorageCipher,
      );
      writeOwnerSecret(stateDir, restored.ownerSecret);
      writeInstanceId(stateDir, restored.instanceId);
      ownerSecret = restored.ownerSecret;
    },
    chooseDestination: async (defaultName) => {
      const options = {
        title: "Yedeği kaydet",
        buttonLabel: "Kaydet",
        defaultPath: join(app.getPath("documents"), defaultName),
        filters: [{ name: "Studio yedeği", extensions: ["zip"] }],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    chooseBackup: async () => {
      const options = {
        title: "Geri yüklenecek yedeği seç",
        buttonLabel: "Geri yükle",
        properties: ["openFile" as const],
        filters: [{ name: "Studio yedeği", extensions: ["zip"] }],
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });

  let systemServices: SystemServices | null = null;

  function registerIpc(): void {
    ipcMain.handle(IPC.hostGet, () => host.snapshot());
    ipcMain.handle(IPC.hostRestart, () => host.restart());
    ipcMain.handle(IPC.settingsGet, () => settings.get());
    ipcMain.handle(IPC.settingsUpdate, (_event, patch: SettingsPatch) => settings.update(patch));
    ipcMain.handle(IPC.notify, (_event, notice: NoticeInput) => {
      notifier.post(notice);
    });
    ipcMain.on(IPC.rendererReady, (event) => {
      if (mainWindow && event.sender === mainWindow.webContents) rendererLink.markReady();
    });
    ipcMain.handle(IPC.openExternal, (_event, url: string) => {
      if (/^https?:/i.test(url)) return shell.openExternal(url);
    });
    // Fonts installed on this Mac (Marka Kiti, the post editor), cached until a font folder changes.
    const fonts = new FontLister();
    ipcMain.handle(FONTS_IPC.list, (_event, options?: { refresh?: boolean }) =>
      fonts.list({ refresh: options?.refresh === true }),
    );
    const fontFiles = new FontFiles();
    ipcMain.handle(FONTS_IPC.read, (_event, postscriptName: unknown) =>
      typeof postscriptName === "string" ? fontFiles.read(postscriptName) : null,
    );
    // The post editor's working drafts (S5): local, one per post, never the API's.
    const drafts = new DraftStore(join(stateDir, "drafts"));
    ipcMain.handle(DRAFTS_IPC.save, (_event, draft: unknown) => {
      drafts.save(draft);
    });
    ipcMain.on(DRAFTS_IPC.saveSync, (event, draft: unknown) => {
      try {
        drafts.save(draft);
        event.returnValue = true;
      } catch {
        event.returnValue = false;
      }
    });
    ipcMain.handle(DRAFTS_IPC.load, (_event, contentId: unknown) =>
      typeof contentId === "string" ? drafts.load(contentId) : null,
    );
    ipcMain.handle(DRAFTS_IPC.remove, (_event, contentId: unknown) => {
      if (typeof contentId === "string") drafts.remove(contentId);
    });
    // Post export (save dialog, share menu, Finder) and the cloud sync when Studio comes forward.
    const apiTarget = () =>
      host.apiPort === null ? null : { port: host.apiPort, ownerSecret: currentOwnerSecret() };
    setupPostFiles({ window: () => mainWindow, target: apiTarget });
    const publishingSync = new PublishingSync({
      target: apiTarget,
      log: (message) => mainLog.write("warn", message),
    });
    app.on("browser-window-focus", (_event, window) => {
      if (window === mainWindow) void publishingSync.focused();
    });
    ipcMain.handle(ACCOUNTS_IPC.backupCreate, () => backups.backup());
    ipcMain.handle(ACCOUNTS_IPC.backupRestore, () => backups.restore());
    host.onChange((snapshot) => send(IPC.hostChanged, snapshot));
    setupAccounts({
      stateDir,
      logsDir: host.logsDir,
      secrets,
      apiPort: () => host.apiPort,
      ownerSecret: currentOwnerSecret,
      userName: () => macUser,
      // A new or removed tunnel token restarts only the tunnel, not the jobs (A9).
      onTunnelTokenChange: () => void host.restartTunnel(),
      send,
    });
    // Health, tools, worker keys, login item, keeping the Mac awake (P1, P2, P9).
    systemServices = setupSystemServices({
      ipcMain,
      created,
      stateDir,
      ownerSecret: currentOwnerSecret,
      settings: () => settings.get(),
      onSettingsChange: (listener) => settings.onChange(listener),
      send,
      log: (level, message) => mainLog.write(level, message),
    });
    let tunnelHostname = settings.get().remoteHostname;
    settings.onChange((value) => {
      applyAppearance(value.appearance);
      send(IPC.settingsChanged, value);
      if (value.remoteHostname !== tunnelHostname) {
        tunnelHostname = value.remoteHostname;
        void host.restartTunnel();
      }
    });
  }

  // The canvas runner (S1): the chat agent's canvas jobs run in a hidden page with Wecra's engine,
  // also while no window has the post open (canvas/executor.ts, canvas/runner-window.ts).
  let canvasRunner: CanvasRunnerWindow | null = null;
  let canvasExecutor: CanvasExecutor | null = null;

  function startCanvasRunner(): void {
    const log = (message: string) => console.warn(message);
    canvasRunner = new CanvasRunnerWindow({
      url: () =>
        isDev && process.env.ELECTRON_RENDERER_URL
          ? `${process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "")}/${CANVAS_RUNNER_PAGE}`
          : `${APP_ORIGIN}/${CANVAS_RUNNER_PAGE}`,
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      log,
    });
    canvasExecutor = new CanvasExecutor({
      workerId: "studio-canvas",
      version: app.getVersion(),
      target: () => {
        const snapshot = host.snapshot();
        const up = snapshot.status.kind === "running" || snapshot.status.kind === "attached";
        if (!up || snapshot.apiPort === null) return null;
        return {
          url: `ws://127.0.0.1:${snapshot.apiPort}/api/hub`,
          token: loadOrCreateHostSecrets(stateDir, safeStorageCipher).workerToken,
        };
      },
      socket: nodeHubSocket,
      runner: canvasRunner,
      log,
    });
    canvasExecutor.start();
    host.onChange(() => canvasExecutor?.refresh());
  }

  function stopCanvasRunner(): void {
    canvasExecutor?.stop();
    canvasRunner?.close();
    canvasExecutor = null;
    canvasRunner = null;
  }

  let quitting = false;

  async function shutdown(): Promise<void> {
    if (quitting) return;
    quitting = true;
    systemServices?.stop();
    stopCanvasRunner();
    activity.stop();
    try {
      // All services at once, one deadline (A11: it was 8 s per service, one after another).
      // SIGKILL after 5 s; the app goes at 7 s whatever is left (a child that cannot be reaped).
      if (host.ownsChildren) {
        await Promise.race([
          host.stop({ graceMs: 5_000, message: "Kapatılıyor…" }),
          new Promise((resolve) => setTimeout(resolve, 7_000)),
        ]);
      } else {
        host.releaseHostFile();
      }
    } catch (error) {
      mainLog.write("error", `shutdown: ${(error as Error).message}`);
    } finally {
      app.exit(0);
    }
  }

  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on("before-quit", (event) => {
    if (quitting) return;
    // ⌘Q: the open post's draft is written first (a short wait at most), then the quit goes on.
    if (!flushedForQuit) {
      event.preventDefault();
      void rendererFlush.run().finally(() => {
        flushedForQuit = true;
        app.quit();
      });
      return;
    }
    if (host.ownsChildren) {
      event.preventDefault();
      void shutdown();
    } else {
      stopCanvasRunner();
      activity.stop();
      host.releaseHostFile();
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown());
  }

  app.on("window-all-closed", () => {
    // macOS: the app (and the host) keeps running until quit.
  });

  app.on("activate", () => {
    if (!mainWindow) createWindow();
  });

  void app.whenReady().then(() => {
    applyAppearance(settings.get().appearance);
    secureSession();
    handleAppProtocol(
      join(import.meta.dirname, "../renderer"),
      () => host.apiPort,
      currentOwnerSecret,
    );
    registerIpc();
    Menu.setApplicationMenu(
      buildMenu((command: MenuCommand) => send(IPC.menuCommand, command), {
        isDev,
        getWindow: () => mainWindow,
      }),
    );
    createWindow();
    void host.start();
    startCanvasRunner();
    activity.start();
    host.onChange(() => activity.refresh());
  });
}
