// Electron main process: the window (Claude Code style: hidden inset title bar, traffic lights
// in the unified top bar, sidebar vibrancy), the local host supervisor, settings, the menu,
// notifications and the typed IPC the preload exposes.
import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, Notification, nativeTheme, shell } from "electron";
import {
  type DesktopSettings,
  IPC,
  type MenuCommand,
  type NoticeInput,
  type SettingsPatch,
} from "../shared/ipc.ts";
import { DnsSdAdvertiser } from "./host/bonjour.ts";
import { defaultRepoPath, stateDirectory } from "./host/environment.ts";
import { defaultHostDeps, type HostConfiguration, LocalHost } from "./host/local-host.ts";
import { SpawnLauncher } from "./host/process.ts";
import { buildMenu } from "./menu.ts";
import { NoticeLog, Notifier } from "./notifications.ts";
import { APP_ORIGIN, handleAppProtocol, registerSchemePrivileges } from "./protocol.ts";
import { defaultSettings, SettingsStore } from "./settings.ts";

const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
const stateDir = stateDirectory();

app.setName("Studio");
// Chromium's own data stays in a sub folder; the host's files live next to it (shared with
// the AppKit app).
app.setPath("userData", join(stateDir, "desktop"));
registerSchemePrivileges();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

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

const host = new LocalHost(
  defaultHostDeps({ stateDir, launcher: new SpawnLauncher(), advertiser: new DnsSdAdvertiser() }),
  hostConfiguration,
);

let mainWindow: BrowserWindow | null = null;

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
}

const notifier = new Notifier(
  {
    isSupported: () => Notification.isSupported(),
    show(notice, onClick) {
      const n = new Notification({ title: notice.title, body: notice.body, silent: false });
      n.on("click", onClick);
      n.show();
    },
  },
  new NoticeLog(join(stateDir, "desktop-notices.json")),
  () => settings.get().notificationsEnabled,
  (route) => {
    if (!mainWindow) createWindow();
    mainWindow?.show();
    mainWindow?.focus();
    if (route) send(IPC.noticeClicked, route);
  },
);

function applyAppearance(value: DesktopSettings["appearance"]): void {
  nativeTheme.themeSource = value;
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
  window.once("ready-to-show", () => window.show());
  const pushState = () =>
    send(IPC.windowState, { fullScreen: window.isFullScreen(), focused: window.isFocused() });
  for (const event of ["enter-full-screen", "leave-full-screen", "focus", "blur"] as const) {
    window.on(event as "focus", pushState);
  }
  window.webContents.on("did-finish-load", pushState);
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
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadURL(`${APP_ORIGIN}/index.html`);
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.hostGet, () => host.snapshot());
  ipcMain.handle(IPC.hostRestart, () => host.restart());
  ipcMain.handle(IPC.settingsGet, () => settings.get());
  ipcMain.handle(IPC.settingsUpdate, (_event, patch: SettingsPatch) => settings.update(patch));
  ipcMain.handle(IPC.notify, (_event, notice: NoticeInput) => {
    notifier.post(notice);
  });
  ipcMain.handle(IPC.openExternal, (_event, url: string) => {
    if (/^https?:/i.test(url)) return shell.openExternal(url);
  });
  host.onChange((snapshot) => send(IPC.hostChanged, snapshot));
  settings.onChange((value) => {
    applyAppearance(value.appearance);
    send(IPC.settingsChanged, value);
  });
}

let quitting = false;

async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  try {
    if (host.ownsChildren) await host.stop();
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
  if (host.ownsChildren) {
    event.preventDefault();
    void shutdown();
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
  handleAppProtocol(join(import.meta.dirname, "../renderer"), () => host.apiPort);
  registerIpc();
  Menu.setApplicationMenu(
    buildMenu((command: MenuCommand) => send(IPC.menuCommand, command), {
      isDev,
      getWindow: () => mainWindow,
    }),
  );
  createWindow();
  void host.start();
});
