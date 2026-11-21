// The Mac side of the host settings bridge (contract host-settings.ts): every few seconds the
// main process sends its non-secret settings to the local API (`POST /api/host/settings/sync`,
// with the owner secret) together with the results of the changes it applied, and gets back the
// changes a paired phone queued. It applies each one here (desktop-settings.json, the login item,
// the worker's keys, the tunnel token, the Meta / LinkedIn app credentials), reports the results
// on the next sync, and only then restarts what has to restart (the host for local network or
// remote access, the tunnel for its token), so a change is never applied twice.
//
// No Electron import: app.ts passes the real ports; tests pass fakes.
import {
  type HostInfo,
  type HostKeyChange,
  type HostKeyName,
  type HostKeyState,
  type HostSettingsPendingChange,
  type HostSettingsResult,
  type HostSettingsState,
  HostSettingsSyncResult,
} from "@studio/contract";
import type { DesktopSettings, HostSnapshot, ServicePhase, SettingsPatch } from "../shared/ipc.ts";
import type { LoginItemState } from "../shared/system-ipc.ts";

/** Worker keys the phone may set (names and labels as in Ayarlar → Gelişmiş → Worker). */
export const WORKER_KEY_NAMES = [
  "GEMINI_API_KEY",
  "ELEVENLABS_API_KEY",
  "STUDIO_ELEVENLABS_VOICE_ID",
  "STUDIO_CLOUD_PUBLISHER_URL",
  "STUDIO_CLOUD_PUBLISHER_TOKEN",
] as const satisfies readonly HostKeyName[];

/** The default chat choice when the Mac has none yet (renderer/lib/models.ts FALLBACK_CHOICE). */
const FALLBACK_CHOICE = { model: "gemini-flash-lite", effort: "medium" };

export interface WorkerEnvPort {
  summary(): {
    entries: { name: string; source: "env-file" | "settings" }[];
    sealed: boolean;
  };
  set(name: string, value: string): void;
  remove(name: string): void;
  editable: readonly { name: string; label: string; secret: boolean }[];
}

export interface AccountsPort {
  apps(): Promise<{
    meta: { appId: string; hasSecret: boolean };
    linkedIn: { clientId: string; hasSecret: boolean };
  }>;
  saveMetaApp(input: {
    appId: string;
    secret?: string;
  }): Promise<{ ok: true } | { ok: false; message: string }>;
  saveLinkedInApp(input: {
    clientId: string;
    secret?: string;
  }): Promise<{ ok: true } | { ok: false; message: string }>;
  forgetMetaSecret(): Promise<unknown>;
  forgetLinkedInSecret(): Promise<void>;
}

export interface TunnelTokenPort {
  has(): Promise<boolean>;
  /** Validates (throws a Turkish Error) and stores. */
  save(value: string): Promise<void>;
  remove(): Promise<void>;
}

export interface HostSettingsPorts {
  settings: { get(): DesktopSettings; update(patch: SettingsPatch): void };
  host: {
    snapshot(): HostSnapshot;
    macName(): string;
    tunnel(): HostInfo["tunnel"];
  };
  loginItem: { get(): LoginItemState; set(enabled: boolean): LoginItemState };
  keepAwake(): { active: boolean; reason: string | null };
  workerEnv: WorkerEnvPort;
  accounts: AccountsPort;
  tunnelToken: TunnelTokenPort;
  appVersion: string;
  mode: "dev" | "packaged";
  updatesNote: string;
}

/** What a change needs restarted once its result was reported. */
export type Restart = "host" | "tunnel" | null;

export interface ApplyOutcome {
  result: HostSettingsResult;
  restart: Restart;
}

const SERVICE_LABELS: Record<string, string> = {
  api: "API",
  gateway: "Yerel ağ",
  worker: "Worker",
  tunnel: "Tünel",
};

function phaseText(phase: ServicePhase): string {
  switch (phase.kind) {
    case "running":
      return "çalışıyor";
    case "failed":
      return "durdu";
    case "restarting":
      return "yeniden başlıyor";
    default:
      return "bekliyor";
  }
}

/** The host's state in one Turkish line (Ayarlar → Gelişmiş → Durum). */
export function hostStatusLine(host: HostSnapshot): { text: string; error: boolean } {
  let text: string;
  switch (host.status.kind) {
    case "running":
      text = "Çalışıyor";
      break;
    case "attached":
      text = "Bu Mac'te zaten çalışan Studio sunucusuna bağlı";
      break;
    case "starting":
      text = `Başlatılıyor: ${host.status.message}`;
      break;
    case "error":
      text = `Hata: ${host.status.message}`;
      break;
    default:
      text = "Durdu";
  }
  const phases = (["api", "gateway", "worker", "tunnel"] as const)
    .filter((s) => host.services[s])
    .map((s) => `${SERVICE_LABELS[s]}: ${phaseText(host.services[s] as ServicePhase)}`)
    .join(" · ");
  if (phases) text += ` · ${phases}`;
  return { text: text.slice(0, 300), error: host.status.kind === "error" };
}

/** The non-secret state the phone sees (values, which keys are saved, facts). */
export async function buildHostState(ports: HostSettingsPorts): Promise<HostSettingsState> {
  const s = ports.settings.get();
  const snapshot = ports.host.snapshot();
  const login = ports.loginItem.get();
  const awake = ports.keepAwake();
  const env = ports.workerEnv.summary();
  const [apps, tunnelSaved] = await Promise.all([ports.accounts.apps(), ports.tunnelToken.has()]);
  const status = hostStatusLine(snapshot);
  const keys: HostKeyState[] = [
    {
      name: "CLOUDFLARE_TUNNEL_TOKEN",
      label: "Tünel anahtarı (CLOUDFLARE_TUNNEL_TOKEN)",
      group: "tunnel",
      secret: true,
      saved: tunnelSaved,
      source: tunnelSaved ? "settings" : null,
    },
    ...ports.workerEnv.editable
      .filter((e) => (WORKER_KEY_NAMES as readonly string[]).includes(e.name))
      .map((e): HostKeyState => {
        const entry = env.entries.find((x) => x.name === e.name);
        return {
          name: e.name as HostKeyName,
          label: e.label.slice(0, 120),
          group: "worker",
          secret: e.secret,
          saved: entry !== undefined,
          source: entry?.source ?? null,
        };
      }),
    {
      name: "META_APP_SECRET",
      label: "Meta App Secret",
      group: "accounts",
      secret: true,
      saved: apps.meta.hasSecret,
      source: apps.meta.hasSecret ? "settings" : null,
    },
    {
      name: "LINKEDIN_CLIENT_SECRET",
      label: "LinkedIn Client Secret",
      group: "accounts",
      secret: true,
      saved: apps.linkedIn.hasSecret,
      source: apps.linkedIn.hasSecret ? "settings" : null,
    },
  ];
  return {
    values: {
      lanEnabled: s.lanEnabled,
      remoteControlEnabled: s.remoteControlEnabled,
      remoteHostname: s.remoteHostname.slice(0, 253),
      keepAwake: s.keepAwake,
      notificationsEnabled: s.notificationsEnabled,
      appearance: s.appearance,
      ownerName: s.ownerName.slice(0, 80),
      loginItem: login.enabled,
      defaultModel: s.agent.last?.model.slice(0, 64) ?? null,
      defaultEffort: s.agent.last?.effort.slice(0, 32) ?? null,
      metaAppId: apps.meta.appId.slice(0, 64),
      linkedInClientId: apps.linkedIn.clientId.slice(0, 128),
    },
    keys,
    info: {
      macName: ports.host.macName().slice(0, 120) || "Mac",
      appVersion: ports.appVersion.slice(0, 40),
      mode: ports.mode,
      hostEnabled: s.hostEnabled,
      hostStatus: status.text,
      hostError: status.error,
      apiPort: snapshot.apiPort,
      lanPort: snapshot.lanPort,
      lanUrls: snapshot.lanUrls.slice(0, 8).map((u) => u.slice(0, 200)),
      tunnel: ports.host.tunnel(),
      loginItemSupported: login.supported,
      loginItemNote: login.note.slice(0, 300),
      keepAwakeActive: awake.active,
      keepAwakeReason: awake.reason?.slice(0, 200) ?? null,
      keysSealed: env.sealed,
      updatesNote: ports.updatesNote.slice(0, 300),
    },
  };
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}

/**
 * Apply one queued change. Values first (one settings update), then the login item, the app
 * credentials and the keys. Each failure is noted; the change is `ok` only when all parts were.
 */
export async function applyHostChange(
  change: HostSettingsPendingChange,
  ports: HostSettingsPorts,
): Promise<ApplyOutcome> {
  const v = change.values;
  const before = ports.settings.get();
  const failures: string[] = [];
  const notes: string[] = [];
  let restart: Restart = null;

  const patch: SettingsPatch = {};
  if (v.lanEnabled !== undefined) patch.lanEnabled = v.lanEnabled;
  if (v.remoteControlEnabled !== undefined) patch.remoteControlEnabled = v.remoteControlEnabled;
  if (v.remoteHostname !== undefined) patch.remoteHostname = v.remoteHostname;
  if (v.keepAwake !== undefined) patch.keepAwake = v.keepAwake;
  if (v.notificationsEnabled !== undefined) patch.notificationsEnabled = v.notificationsEnabled;
  if (v.appearance !== undefined) patch.appearance = v.appearance;
  if (v.ownerName !== undefined) patch.ownerName = v.ownerName;
  if (v.defaultModel !== undefined || v.defaultEffort !== undefined) {
    const last = before.agent.last ?? FALLBACK_CHOICE;
    patch.agent = {
      last: { model: v.defaultModel ?? last.model, effort: v.defaultEffort ?? last.effort },
    };
  }
  if (Object.keys(patch).length > 0) {
    try {
      ports.settings.update(patch);
    } catch (error) {
      failures.push(`Ayarlar kaydedilemedi: ${errorText(error)}`);
    }
  }
  if (
    (v.lanEnabled !== undefined && v.lanEnabled !== before.lanEnabled) ||
    (v.remoteControlEnabled !== undefined && v.remoteControlEnabled !== before.remoteControlEnabled)
  ) {
    restart = "host";
    notes.push("Sunucu yeniden başlatılıyor.");
  }

  if (v.loginItem !== undefined) {
    const state = ports.loginItem.set(v.loginItem);
    if (!state.supported) failures.push(state.note);
    else if (state.needsApproval) notes.push(state.note);
  }

  // Meta / LinkedIn: the ID and the secret are saved together on the Mac.
  const keyByName = new Map<HostKeyName, HostKeyChange>(change.keys.map((k) => [k.name, k]));
  const metaSecret = keyByName.get("META_APP_SECRET");
  const linkedInSecret = keyByName.get("LINKEDIN_CLIENT_SECRET");
  if (v.metaAppId !== undefined || metaSecret?.value) {
    const apps = await ports.accounts.apps();
    const saved = await ports.accounts.saveMetaApp({
      appId: v.metaAppId ?? apps.meta.appId,
      ...(metaSecret?.value ? { secret: metaSecret.value } : {}),
    });
    if (!saved.ok) failures.push(saved.message);
  }
  if (metaSecret && metaSecret.value === null) await ports.accounts.forgetMetaSecret();
  if (v.linkedInClientId !== undefined || linkedInSecret?.value) {
    const apps = await ports.accounts.apps();
    const saved = await ports.accounts.saveLinkedInApp({
      clientId: v.linkedInClientId ?? apps.linkedIn.clientId,
      ...(linkedInSecret?.value ? { secret: linkedInSecret.value } : {}),
    });
    if (!saved.ok) failures.push(saved.message);
  }
  if (linkedInSecret && linkedInSecret.value === null) await ports.accounts.forgetLinkedInSecret();

  const tunnel = keyByName.get("CLOUDFLARE_TUNNEL_TOKEN");
  if (tunnel) {
    try {
      if (tunnel.value === null) await ports.tunnelToken.remove();
      else await ports.tunnelToken.save(tunnel.value);
      if (restart === null) restart = "tunnel";
    } catch (error) {
      failures.push(errorText(error));
    }
  }

  let workerKeysChanged = false;
  for (const k of change.keys) {
    if (!(WORKER_KEY_NAMES as readonly string[]).includes(k.name)) continue;
    try {
      if (k.value === null) ports.workerEnv.remove(k.name);
      else ports.workerEnv.set(k.name, k.value);
      workerKeysChanged = true;
    } catch (error) {
      failures.push(`${k.name}: ${errorText(error)}`);
    }
  }
  if (v.restartHost) {
    restart = "host";
    notes.push("Sunucu yeniden başlatılıyor.");
  } else if (workerKeysChanged) {
    notes.push("Worker anahtarları sunucu yeniden başlayınca kullanılır.");
  }

  const ok = failures.length === 0;
  const message = [...failures, ...(ok ? notes : [])].join(" ").trim();
  return {
    result: {
      id: change.id,
      ok,
      message: message ? message.slice(0, 500) : ok ? "Uygulandı." : null,
    },
    restart,
  };
}

export interface BridgeInput {
  ports: HostSettingsPorts;
  /** The local API and the owner secret (null while the host is down). */
  target(): { port: number; ownerSecret: string } | null;
  restartHost(): void;
  restartTunnel(): void;
  fetch?: typeof fetch;
  log?: (message: string) => void;
  intervalMs?: number;
}

/** The sync loop. One sync at a time; results are kept until a sync carried them. */
export class HostSettingsBridge {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<void> | null = null;
  private results: HostSettingsResult[] = [];
  private lastError = "";

  constructor(private readonly input: BridgeInput) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.sync(), this.input.intervalMs ?? 3_000);
    this.timer.unref?.();
    void this.sync();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Sync now (also used by tests); waits for a sync already under way. */
  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async post(): Promise<HostSettingsSyncResult["pending"] | null> {
    const target = this.input.target();
    if (!target) return null;
    const state = await buildHostState(this.input.ports);
    const results = [...this.results];
    try {
      const res = await (this.input.fetch ?? fetch)(
        `http://127.0.0.1:${target.port}/api/host/settings/sync`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "X-Studio-Owner": target.ownerSecret,
          },
          body: JSON.stringify({ state, results }),
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!res.ok) {
        // An older API without the bridge answers 404: stay quiet.
        await res.body?.cancel();
        this.note(res.status === 404 ? "" : `ayar eşitleme: HTTP ${res.status}`);
        return null;
      }
      const parsed = HostSettingsSyncResult.safeParse(await res.json());
      // The API took the results (even if its answer cannot be read).
      this.results = this.results.filter((r) => !results.some((x) => x.id === r.id));
      if (!parsed.success) {
        this.note("ayar eşitleme: beklenmeyen yanıt");
        return null;
      }
      this.note("");
      return parsed.data.pending;
    } catch (error) {
      this.note(`ayar eşitleme: ${errorText(error)}`);
      return null;
    }
  }

  private note(message: string): void {
    if (message && message !== this.lastError) this.input.log?.(message);
    this.lastError = message;
  }

  private async run(): Promise<void> {
    const pending = await this.post();
    if (!pending || pending.length === 0) return;
    const restarts = new Set<Exclude<Restart, null>>();
    for (const change of pending) {
      if (this.results.some((r) => r.id === change.id)) continue;
      try {
        const outcome = await applyHostChange(change, this.input.ports);
        this.results.push(outcome.result);
        if (outcome.restart) restarts.add(outcome.restart);
      } catch (error) {
        this.results.push({ id: change.id, ok: false, message: errorText(error) });
      }
    }
    // Report before anything restarts (the API goes away with the host).
    await this.post();
    if (restarts.has("host")) this.input.restartHost();
    else if (restarts.has("tunnel")) this.input.restartTunnel();
  }
}
