// `window.studio` from the preload. Outside Electron (the gallery in a browser, headless render
// checks, tests) a small in-memory stand-in keeps the UI working.
import type { Draft, DraftsBridge } from "../../shared/drafts.ts";
import type {
  DesktopSettings,
  HostSnapshot,
  MenuCommand,
  SettingsPatch,
  StudioBridge,
  WindowState,
} from "../../shared/ipc.ts";

declare global {
  interface Window {
    studio?: StudioBridge;
  }
}

export const defaultSession: DesktopSettings["session"] = {
  sidebarPresented: true,
  sidebarWidth: 265,
  panelPresented: false,
  panelPane: "details",
  panelExpanded: false,
  panelWidth: 357,
  route: "new",
  currentBrandId: null,
  collapsedGroups: [],
};

export function fallbackSettings(): DesktopSettings {
  return {
    hostEnabled: true,
    lanEnabled: true,
    repoPath: "",
    remoteControlEnabled: false,
    remoteHostname: "social.burakkoc.net",
    ownerName: "",
    appearance: "system",
    notificationsEnabled: true,
    keepAwake: true,
    agent: { last: null, conversations: {} },
    session: { ...defaultSession },
    settingsSection: "",
    onboarding: { completed: false, skipped: false, step: "welcome" },
  };
}

/** Drafts kept in this page's memory (the browser stand-in, tests). */
export function memoryDrafts(): DraftsBridge & { items: Map<string, Draft> } {
  const items = new Map<string, Draft>();
  const copy = (d: Draft): Draft => ({ ...d, bundle: d.bundle.slice() });
  return {
    items,
    save: async (draft) => {
      items.set(draft.contentId, copy(draft));
    },
    saveSync: (draft) => {
      items.set(draft.contentId, copy(draft));
      return true;
    },
    load: async (contentId) => {
      const d = items.get(contentId);
      return d ? copy(d) : null;
    },
    remove: async (contentId) => {
      items.delete(contentId);
    },
  };
}

/** Browser stand-in: the API is assumed on the page's own origin (Vite proxy), port 8790. */
export function createFallbackBridge(apiPort = 8790): StudioBridge {
  let settings = fallbackSettings();
  const settingsListeners = new Set<(s: DesktopSettings) => void>();
  const snapshot: HostSnapshot = {
    status: { kind: "attached" },
    apiPort,
    lanPort: null,
    instance: null,
    lanUrls: [],
    tunnelUrl: null,
    tunnelNote: null,
    services: {},
    ownsChildren: false,
  };
  return {
    platform: "browser",
    host: {
      get: async () => snapshot,
      restart: async () => undefined,
      onChange: () => () => undefined,
    },
    settings: {
      get: async () => settings,
      update: async (patch: SettingsPatch) => {
        settings = {
          ...settings,
          ...patch,
          agent: {
            last: patch.agent?.last !== undefined ? patch.agent.last : settings.agent.last,
            conversations: { ...settings.agent.conversations, ...patch.agent?.conversations },
          },
          session: { ...settings.session, ...patch.session },
        } as DesktopSettings;
        for (const l of settingsListeners) l(settings);
        return settings;
      },
      onChange: (listener) => {
        settingsListeners.add(listener);
        return () => settingsListeners.delete(listener);
      },
    },
    notify: async () => undefined,
    onNoticeClicked: () => () => undefined,
    openExternal: async (url: string) => {
      window.open(url, "_blank", "noopener");
    },
    onMenuCommand: (_listener: (c: MenuCommand) => void) => () => undefined,
    onWindowState: (_listener: (s: WindowState) => void) => () => undefined,
    drafts: memoryDrafts(),
  };
}

let current: StudioBridge | undefined;

export function bridge(): StudioBridge {
  if (!current) current = window.studio ?? createFallbackBridge();
  return current;
}

/** Tests replace the bridge. */
export function setBridge(next: StudioBridge | undefined): void {
  current = next;
}

export const isElectron = (): boolean => window.studio !== undefined;
