// Persisted preferences of the desktop app: one JSON file in the state directory
// (`desktop-settings.json`), written atomically. Unknown or broken values fall back to the
// defaults, so an older or hand-edited file never stops the app.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentChoiceValue,
  Appearance,
  DesktopSettings,
  SessionState,
  SettingsPatch,
} from "../shared/ipc.ts";
import { DEFAULT_REMOTE_HOSTNAME } from "./host/guards.ts";

export function defaultSettings(repoPath: string): DesktopSettings {
  return {
    hostEnabled: true,
    lanEnabled: true,
    repoPath,
    remoteControlEnabled: false,
    remoteHostname: DEFAULT_REMOTE_HOSTNAME,
    ownerName: "",
    appearance: "system",
    notificationsEnabled: true,
    keepAwake: true,
    agent: { last: null, conversations: {} },
    session: {
      sidebarPresented: true,
      sidebarWidth: 265,
      panelPresented: false,
      panelPane: "details",
      panelExpanded: false,
      panelWidth: 357,
      route: "new",
      currentBrandId: null,
      collapsedGroups: [],
    },
    settingsSection: "",
    onboarding: { completed: false, skipped: false, step: "welcome" },
  };
}

const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
const str = (value: unknown, fallback: string) => (typeof value === "string" ? value : fallback);
/** A whole number within [min, max], else the fallback (side panel widths). */
const width = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.round(Math.min(max, Math.max(min, value)))
    : fallback;

function choice(value: unknown): AgentChoiceValue | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  return typeof v.model === "string" && typeof v.effort === "string"
    ? { model: v.model, effort: v.effort }
    : null;
}

/** Keep what is valid, default the rest. */
export function normalizeSettings(raw: unknown, defaults: DesktopSettings): DesktopSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const appearance: Appearance = ["system", "light", "dark"].includes(r.appearance as string)
    ? (r.appearance as Appearance)
    : defaults.appearance;
  const agentRaw = (r.agent && typeof r.agent === "object" ? r.agent : {}) as Record<
    string,
    unknown
  >;
  const conversations: Record<string, AgentChoiceValue> = {};
  if (agentRaw.conversations && typeof agentRaw.conversations === "object") {
    for (const [id, value] of Object.entries(agentRaw.conversations as Record<string, unknown>)) {
      const c = choice(value);
      if (c) conversations[id] = c;
    }
  }
  const s = (r.session && typeof r.session === "object" ? r.session : {}) as Record<
    string,
    unknown
  >;
  const d = defaults.session;
  const session: SessionState = {
    sidebarPresented: bool(s.sidebarPresented, d.sidebarPresented),
    sidebarWidth: width(s.sidebarWidth, d.sidebarWidth, 200, 420),
    panelPresented: bool(s.panelPresented, d.panelPresented),
    panelPane: str(s.panelPane, d.panelPane),
    panelExpanded: bool(s.panelExpanded, d.panelExpanded),
    panelWidth: width(s.panelWidth, d.panelWidth, 300, 720),
    route: str(s.route, d.route),
    currentBrandId: typeof s.currentBrandId === "string" ? s.currentBrandId : null,
    collapsedGroups: Array.isArray(s.collapsedGroups)
      ? s.collapsedGroups.filter((x): x is string => typeof x === "string")
      : [],
  };
  return {
    hostEnabled: bool(r.hostEnabled, defaults.hostEnabled),
    lanEnabled: bool(r.lanEnabled, defaults.lanEnabled),
    repoPath: str(r.repoPath, defaults.repoPath) || defaults.repoPath,
    remoteControlEnabled: bool(r.remoteControlEnabled, defaults.remoteControlEnabled),
    remoteHostname: str(r.remoteHostname, defaults.remoteHostname),
    ownerName: str(r.ownerName, defaults.ownerName),
    appearance,
    notificationsEnabled: bool(r.notificationsEnabled, defaults.notificationsEnabled),
    keepAwake: bool(r.keepAwake, defaults.keepAwake),
    agent: { last: choice(agentRaw.last), conversations },
    session,
    settingsSection: str(r.settingsSection, defaults.settingsSection),
    onboarding: onboardingState(r.onboarding, defaults.onboarding),
  };
}

function onboardingState(
  value: unknown,
  fallback: DesktopSettings["onboarding"],
): DesktopSettings["onboarding"] {
  const o = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    completed: bool(o.completed, fallback.completed),
    skipped: bool(o.skipped, fallback.skipped),
    step: str(o.step, fallback.step),
  };
}

export function applyPatch(current: DesktopSettings, patch: SettingsPatch): DesktopSettings {
  const { agent, session, ...rest } = patch;
  return {
    ...current,
    ...rest,
    agent: {
      last: agent?.last !== undefined ? agent.last : current.agent.last,
      conversations: agent?.conversations
        ? { ...current.agent.conversations, ...agent.conversations }
        : current.agent.conversations,
    },
    session: { ...current.session, ...session },
  };
}

export class SettingsStore {
  private value: DesktopSettings;
  private listeners = new Set<(settings: DesktopSettings) => void>();

  constructor(
    private readonly file: string,
    private readonly defaults: DesktopSettings,
  ) {
    let raw: unknown = {};
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      raw = {};
    }
    this.value = normalizeSettings(raw, defaults);
  }

  get(): DesktopSettings {
    return this.value;
  }

  update(patch: SettingsPatch): DesktopSettings {
    this.value = normalizeSettings(applyPatch(this.value, patch), this.defaults);
    this.save();
    for (const listener of this.listeners) listener(this.value);
    return this.value;
  }

  onChange(listener: (settings: DesktopSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.value, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
}
