// Typed contract between the main process and the renderer (through the preload bridge).
// Only plain JSON values cross it.
import type { AccountsBridge, SystemBridge } from "./accounts-ipc.ts";
import type { CanvasRunnerBridge } from "./canvas-runner.ts";
import type { DraftsBridge, LifecycleBridge } from "./drafts.ts";
import type { FontsBridge } from "./fonts.ts";
import type { PostFilesBridge } from "./post-files.ts";

export type ServiceName = "api" | "gateway" | "worker" | "tunnel";

export type ServicePhase =
  | { kind: "idle" }
  | { kind: "running"; pid: number }
  /** Exited with `exitStatus`; relaunching after `delayMs`. */
  | { kind: "restarting"; exitStatus: number; delayMs: number }
  | { kind: "failed"; message: string }
  | { kind: "stopped" };

export type HostStatus =
  | { kind: "stopped" }
  | { kind: "starting"; message: string }
  | { kind: "running" }
  /** Another copy of Studio (e.g. the AppKit app) already serves the API; we use it. */
  | { kind: "attached" }
  | { kind: "error"; message: string; log: string };

export interface HostSnapshot {
  status: HostStatus;
  /** http://127.0.0.1:<apiPort> while up. */
  apiPort: number | null;
  lanPort: number | null;
  /** HealthResponse.instance of this Mac's host. */
  instance: string | null;
  lanUrls: string[];
  tunnelUrl: string | null;
  tunnelNote: string | null;
  services: Partial<Record<ServiceName, ServicePhase>>;
  /** This app runs the children (quitting stops them). */
  ownsChildren: boolean;
}

export type Appearance = "system" | "light" | "dark";

export interface AgentChoiceValue {
  model: string;
  effort: string;
}

export interface SessionState {
  sidebarPresented: boolean;
  /** Left sidebar width in px (dragged by its edge). */
  sidebarWidth: number;
  panelPresented: boolean;
  panelPane: string;
  panelExpanded: boolean;
  /** Right panel width in px (dragged by its edge). */
  panelWidth: number;
  /** Last route: "new", "c:<conversationId>", "brands", "brand:<id>/<tab>" … */
  route: string;
  currentBrandId: string | null;
  collapsedGroups: string[];
}

export interface DesktopSettings {
  /** This app runs the API and worker itself (otherwise it only attaches). */
  hostEnabled: boolean;
  /** LAN gateway + Bonjour ("Yerel ağdan erişim"). */
  lanEnabled: boolean;
  repoPath: string;
  remoteControlEnabled: boolean;
  remoteHostname: string;
  /** "Adın": the sidebar name ("" = the Claude account's name). */
  ownerName: string;
  appearance: Appearance;
  notificationsEnabled: boolean;
  agent: {
    last: AgentChoiceValue | null;
    conversations: Record<string, AgentChoiceValue>;
  };
  session: SessionState;
  /** Ayarlar: the section ⌘, reopens ("" = the default one). */
  settingsSection: string;
  /** First-run guide: finished for good, skipped (resumable), and where it stopped. */
  onboarding: OnboardingState;
}

export interface OnboardingState {
  completed: boolean;
  skipped: boolean;
  step: string;
}

export type SettingsPatch = Partial<Omit<DesktopSettings, "agent" | "session">> & {
  agent?: Partial<DesktopSettings["agent"]>;
  session?: Partial<SessionState>;
};

/** Menu and global shortcuts the main process forwards to the renderer. */
export type MenuCommand =
  | "new-chat"
  | "search"
  | "settings"
  | "toggle-sidebar"
  | "toggle-panel"
  | "back"
  | "forward"
  | "rename"
  | "gallery"
  /** Git: Postlar, Takvim (⇧⌘K), Medya (⇧⌘M), Yeni marka (⇧⌘N), Marka ayarları (⇧⌘B). */
  | "go-posts"
  | "go-calendar"
  | "go-media"
  | "new-brand"
  | "brand-settings"
  /** Yardım: keyboard shortcuts, the first-run guide, the logs folder in Finder. */
  | "help-shortcuts"
  | "help-onboarding"
  | "help-logs"
  /** Trackpad swipe (BrowserWindow "swipe") or mouse back / forward ("app-command"). */
  | "swipe-back"
  | "swipe-forward";

export interface NoticeInput {
  /** Stable id: the same id is never shown twice. */
  id: string;
  title: string;
  body: string;
  /** Renderer route opened when the notice is clicked (e.g. "c:<conversationId>"). */
  route?: string;
}

export const IPC = {
  hostGet: "host:get",
  hostRestart: "host:restart",
  hostChanged: "host:changed",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsChanged: "settings:changed",
  notify: "notify",
  noticeClicked: "notice:clicked",
  /** The page listens (notice clicks, app notices): what waited for it is delivered now. */
  rendererReady: "renderer:ready",
  /** A short message for the page to show (e.g. the window was reloaded after a crash). */
  appNotice: "app:notice",
  openExternal: "open-external",
  menuCommand: "menu:command",
  windowState: "window:state",
} as const;

export interface WindowState {
  fullScreen: boolean;
  focused: boolean;
}

/** What the preload exposes as `window.studio`. */
export interface StudioBridge {
  platform: string;
  host: {
    get(): Promise<HostSnapshot>;
    restart(): Promise<void>;
    onChange(listener: (snapshot: HostSnapshot) => void): () => void;
  };
  settings: {
    get(): Promise<DesktopSettings>;
    update(patch: SettingsPatch): Promise<DesktopSettings>;
    onChange(listener: (settings: DesktopSettings) => void): () => void;
  };
  notify(notice: NoticeInput): Promise<void>;
  onNoticeClicked(listener: (route: string) => void): () => void;
  /**
   * The page's listeners are in place: a notification click that opened the window, or a notice
   * about a reload, is delivered after this (absent outside Electron).
   */
  rendererReady?(): void;
  /** Short app messages from the main process (shown as a toast). */
  onAppNotice?(listener: (message: string) => void): () => void;
  openExternal(url: string): Promise<void>;
  onMenuCommand(listener: (command: MenuCommand) => void): () => void;
  onWindowState(listener: (state: WindowState) => void): () => void;
  /** Ayarlar → Hesaplar: connect flows and app credentials (absent outside Electron). */
  accounts?: AccountsBridge;
  /** Version, folders, tunnel token (absent outside Electron). */
  system?: SystemBridge;
  /** Fonts installed on this Mac (absent outside Electron and in an app started before it). */
  fonts?: FontsBridge;
  /** The post editor's working drafts on this Mac (absent outside Electron). */
  drafts?: DraftsBridge;
  /** Close / quit: the main process asks the page to write its drafts first. */
  lifecycle?: LifecycleBridge;
  /** Export a post's files: save dialog, share menu, Finder (absent outside Electron). */
  postFiles?: PostFilesBridge;
  /** Only in the hidden canvas runner's page (shared/canvas-runner.ts). */
  canvasRunner?: CanvasRunnerBridge;
}
