// Packaging-era system services between the main process and Ayarlar → Gelişmiş (P1, P2, P9):
// the host's health, the tools Studio does not carry (Chromium, ffmpeg, whisper, CLIs), the
// worker's keys from the app's secure settings, the login item, keeping the Mac awake, updates.
// Only plain JSON values cross it.

export type HealthState = "ok" | "warn" | "fail";

export interface HealthItem {
  id: string;
  state: HealthState;
  label: string;
  detail: string;
}

export interface HostHealth {
  /** false: the API did not answer (the host is stopped or starting). */
  reachable: boolean;
  components: HealthItem[];
  migrations: { applied: number; last: string | null; expected: string } | null;
  checkedAt: string;
}

export type ToolState = "ok" | "missing";

export interface ToolInfo {
  id: string;
  label: string;
  state: ToolState;
  path: string | null;
  /** What it is for, or what to do when it is missing (Turkish). */
  detail: string;
  /** The one-line install (`brew install ffmpeg`) when missing. */
  install: string | null;
}

export interface ChromiumStatus {
  state: "ready" | "missing" | "installing" | "failed";
  revision: string | null;
  /** PLAYWRIGHT_BROWSERS_PATH the worker gets; null: Playwright's default cache. */
  browsersPath: string | null;
  location: "state" | "cache" | null;
  /** 0–100 while installing. */
  progress: number | null;
  message: string;
}

export interface ToolsReport {
  tools: ToolInfo[];
  chromium: ChromiumStatus;
}

export interface WorkerEnvView {
  /** Stored names (never values) and where each came from. */
  entries: { name: string; source: "env-file" | "settings" }[];
  /** The dev build's last import from the repo `.env`. */
  imported: { from: string; at: string; count: number } | null;
  /** false: no Keychain access, values are plain 0600 files. */
  sealed: boolean;
  /** Names Settings lets the owner set. */
  editable: { name: string; label: string; secret: boolean }[];
}

export interface LoginItemState {
  /** Only the packaged app can register itself. */
  supported: boolean;
  enabled: boolean;
  /** macOS asks for approval in System Settings → General → Login Items. */
  needsApproval: boolean;
  note: string;
}

export interface RuntimeInfo {
  mode: "dev" | "packaged";
  /** dev: the repo; packaged: the app's host folder. */
  root: string | null;
  keepAwake: { enabled: boolean; active: boolean; reason: string | null };
  updates: { enabled: boolean; note: string };
  crashesDir: string;
}

export const SYSTEM_IPC = {
  health: "system:health",
  tools: "system:tools",
  chromiumInstall: "system:chromium-install",
  chromiumChanged: "system:chromium-changed",
  workerEnv: "system:worker-env",
  workerEnvSet: "system:worker-env-set",
  workerEnvRemove: "system:worker-env-remove",
  loginItem: "system:login-item",
  loginItemSet: "system:login-item-set",
  runtime: "system:runtime",
} as const;

/** `window.studio.packaging` (absent outside Electron and in an older app). */
export interface PackagingBridge {
  health(): Promise<HostHealth>;
  tools(refresh?: boolean): Promise<ToolsReport>;
  installChromium(): Promise<ChromiumStatus>;
  onChromium(listener: (status: ChromiumStatus) => void): () => void;
  workerEnv: {
    get(): Promise<WorkerEnvView>;
    set(name: string, value: string): Promise<WorkerEnvView>;
    remove(name: string): Promise<WorkerEnvView>;
  };
  loginItem: {
    get(): Promise<LoginItemState>;
    set(enabled: boolean): Promise<LoginItemState>;
  };
  runtime(): Promise<RuntimeInfo>;
}
