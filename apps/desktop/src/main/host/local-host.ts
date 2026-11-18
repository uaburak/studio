// Runs the Studio back end on this Mac (port of StudioMac/Host/LocalHost.swift): the API
// (wrangler dev / workerd, state under ~/Library/Application Support/Studio), the LAN gateway
// and the worker, as supervised child processes. Applies D1 migrations first, restarts crashed
// children with backoff, keeps logs, advertises the gateway with Bonjour, publishes where
// phones can reach the Mac, and stops everything on quit.
//
// If the API port already answers /api/health with this host's instance id and the app that
// started it is still alive (the AppKit app, another copy of this app), it attaches instead of
// starting a second copy. Children left behind by a crashed app are stopped and started fresh.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostSnapshot, HostStatus, ServiceName, ServicePhase } from "../../shared/ipc.ts";
import type { Advertiser } from "./bonjour.ts";
import * as env from "./environment.ts";
import * as guards from "./guards.ts";
import {
  type ProcessLauncher,
  type ProcessSpec,
  type RunningProcess,
  waitOneShot,
} from "./process.ts";
import * as secrets from "./secrets.ts";
import { ServiceSupervisor, type SupervisorDeps } from "./supervisor.ts";

export interface HostConfiguration {
  /** Run the children; false: only attach to a host that already runs. */
  hostEnabled: boolean;
  repoPath: string;
  lanEnabled: boolean;
  remoteControlEnabled: boolean;
  remoteHostname: string;
  preferredAPIPort: number;
  preferredLANPort: number;
}

export interface HealthInfo {
  instance?: string;
}

/** Everything the host touches outside itself (real implementations in `defaultHostDeps`). */
export interface HostDeps {
  stateDir: string;
  launcher: ProcessLauncher;
  advertiser: Advertiser;
  ownPid: number;
  health(port: number): Promise<HealthInfo | null>;
  isAlive(pid: number): boolean;
  stopLeftovers(repoPath: string): Promise<void>;
  loginShellPath(): string;
  which(tool: string, path: string): string | null;
  fileExists(path: string): boolean;
  isPortFree(port: number, address: string): Promise<boolean>;
  freePort(address: string): Promise<number | null>;
  lanAddresses(): string[];
  computerName(): string;
  checkRepoAccess(
    probe: string,
    onWaiting: () => void,
    signal: AbortSignal,
  ): Promise<guards.RepoAccessOutcome>;
  readTunnelToken(): Promise<string | null>;
  publishRoutes(port: number, routes: MacRoutesInput): Promise<boolean>;
  tail(file: string, lines?: number): string;
  rotate(file: string): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  supervisor?: SupervisorDeps;
  /** How long a one-shot `d1 migrations apply` may take. */
  migrationTimeoutMs?: number;
  /** How long the API may take to answer after it was started. */
  apiReadyTimeoutMs?: number;
  /** Health polling interval while attached; three misses take over. */
  attachPollMs?: number;
  /** Interval of the LAN address check (Wi-Fi changes). */
  networkPollMs?: number;
}

export interface MacRoutesInput {
  macName: string;
  macId: string | null;
  lanAddresses: string[];
  lanPort: number | null;
  bonjourName: string | null;
  tunnelUrl: string | null;
}

const SERVICE_LABELS: Record<ServiceName, string> = {
  api: "API",
  gateway: "Yerel ağ geçidi",
  worker: "Worker",
  tunnel: "Uzaktan erişim tüneli",
};

/** Builds the environment and arguments of every child (pure, tested on its own). */
export function buildSpecs(input: {
  node: string;
  repo: string;
  stateDir: string;
  base: Record<string, string>;
  token: string;
  vaultKey: string;
  instance: string;
  apiPort: number;
  claude: string | null;
  gemini: string | null;
  /** Codex CLI / Antigravity CLI (`agy`) when installed (optional: older callers omit them). */
  codex?: string | null;
  antigravity?: string | null;
}) {
  const apiDir = join(input.repo, "apps", "api");
  const workerDir = join(input.repo, "apps", "worker");
  const logs = join(input.stateDir, "logs");
  const persist = ["--persist-to", join(input.stateDir, "api", "state")];
  const wrangler = join(apiDir, "node_modules", "wrangler", "bin", "wrangler.js");
  const gatewayScript = join(apiDir, "scripts", "lan-gateway.mjs");
  const wranglerEnv: Record<string, string> = {
    ...input.base,
    WORKER_TOKEN: input.token,
    TOKEN_ENCRYPTION_KEY: input.vaultKey,
    STUDIO_INSTANCE_ID: input.instance,
    WRANGLER_SEND_METRICS: "false",
    NO_COLOR: "1",
  };
  const migrate: ProcessSpec = {
    name: "migrate",
    executable: input.node,
    args: [wrangler, "d1", "migrations", "apply", "DB", "--local", ...persist],
    env: { ...wranglerEnv, CI: "1" },
    cwd: apiDir,
    logFile: join(logs, "migrate.log"),
  };
  const api: ProcessSpec = {
    name: "api",
    executable: input.node,
    args: [
      wrangler,
      "dev",
      "--ip",
      "127.0.0.1",
      "--port",
      String(input.apiPort),
      "--inspector-port",
      "0",
      "--env-file",
      join(input.stateDir, "api", "no-dev-vars.env"),
      "--show-interactive-dev-session=false",
      ...persist,
    ],
    env: wranglerEnv,
    cwd: apiDir,
    logFile: join(logs, "api.log"),
  };
  const gateway = (host: string, port: number): ProcessSpec => ({
    name: "gateway",
    executable: input.node,
    args: [gatewayScript],
    env: {
      ...input.base,
      STUDIO_GATEWAY_HOST: host,
      STUDIO_GATEWAY_PORT: String(port),
      STUDIO_API_PORT: String(input.apiPort),
    },
    cwd: apiDir,
    logFile: join(logs, "gateway.log"),
  });
  const workerEnv: Record<string, string> = {
    ...input.base,
    STUDIO_HUB_URL: `ws://127.0.0.1:${input.apiPort}/api/hub`,
    STUDIO_WORKER_TOKEN: input.token,
    STUDIO_STATE_DIR: join(input.stateDir, "worker"),
    STUDIO_SHUTDOWN_TIMEOUT_S: "5",
  };
  if (input.claude) workerEnv.STUDIO_CLAUDE_BIN = input.claude;
  if (input.gemini) workerEnv.STUDIO_GEMINI_BIN = input.gemini;
  if (input.codex) workerEnv.STUDIO_CODEX_BIN = input.codex;
  if (input.antigravity) workerEnv.STUDIO_ANTIGRAVITY_BIN = input.antigravity;
  const worker: ProcessSpec = {
    name: "worker",
    executable: input.node,
    // Node loads the repo `.env` (e.g. GEMINI_API_KEY) itself; the app never reads it.
    args: [`--env-file-if-exists=${join(input.repo, ".env")}`, "--import", "tsx", "src/main.ts"],
    env: workerEnv,
    cwd: workerDir,
    logFile: join(logs, "worker.log"),
  };
  return {
    migrate,
    api,
    gateway,
    worker,
    required: [
      wrangler,
      gatewayScript,
      join(workerDir, "node_modules", "tsx"),
      join(workerDir, "src", "main.ts"),
    ],
    probe: join(apiDir, "package.json"),
  };
}

type Listener = (snapshot: HostSnapshot) => void;

export class LocalHost {
  private statusValue: HostStatus = { kind: "stopped" };
  apiPort: number | null = null;
  lanPort: number | null = null;
  instance: string | null = null;
  tunnelUrl: string | null = null;
  tunnelNote: string | null = null;
  private phases: Partial<Record<ServiceName, ServicePhase>> = {};
  private supervisors: Partial<Record<ServiceName, ServiceSupervisor>> = {};
  private startPromise: Promise<void> | undefined;
  private startAbort: AbortController | undefined;
  private attachAbort: AbortController | undefined;
  private networkTimer: ReturnType<typeof setInterval> | undefined;
  private publishedAddresses: string[] | null = null;
  private macName = "";
  private listeners = new Set<Listener>();
  /** Bumped each time the routes were published. */
  routesRevision = 0;

  constructor(
    private readonly deps: HostDeps,
    private readonly configuration: () => HostConfiguration,
  ) {}

  // --- state ---------------------------------------------------------------------------------

  get status(): HostStatus {
    return this.statusValue;
  }

  private set status(value: HostStatus) {
    this.statusValue = value;
    this.emit();
  }

  get isUp(): boolean {
    return this.statusValue.kind === "running" || this.statusValue.kind === "attached";
  }

  /** Children are running under this app (so quitting must stop them). */
  get ownsChildren(): boolean {
    return (
      this.startPromise !== undefined ||
      Object.values(this.supervisors).some((s) => s?.isActive === true)
    );
  }

  get logsDir(): string {
    return join(this.deps.stateDir, "logs");
  }

  logFile(name: string): string {
    return join(this.logsDir, `${name}.log`);
  }

  get lanUrls(): string[] {
    if (this.lanPort === null || this.phases.gateway?.kind !== "running") return [];
    return this.deps.lanAddresses().map((ip) => `http://${ip}:${this.lanPort}`);
  }

  snapshot(): HostSnapshot {
    return {
      status: this.statusValue,
      apiPort: this.apiPort,
      lanPort: this.lanPort,
      instance: this.instance,
      lanUrls: this.lanUrls,
      tunnelUrl: this.tunnelUrl,
      tunnelNote: this.tunnelNote,
      services: { ...this.phases },
      ownsChildren: this.ownsChildren,
    };
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  // --- lifecycle -----------------------------------------------------------------------------

  /** Start (or attach). Resolves when the API answers, or with an error status. */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.isUp) return Promise.resolve();
    const abort = new AbortController();
    this.startAbort = abort;
    const promise = this.performStart(abort.signal).finally(() => {
      if (this.startPromise === promise) {
        this.startPromise = undefined;
        this.startAbort = undefined;
      }
      this.emit();
    });
    this.startPromise = promise;
    return promise;
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /** Stop the children: tunnel & worker first, then gateway and API. Cancels a start first. */
  async stop(): Promise<void> {
    const pending = this.startPromise;
    if (pending) {
      this.startAbort?.abort();
      this.startPromise = undefined;
      await pending.catch(() => undefined);
    }
    this.attachAbort?.abort();
    this.attachAbort = undefined;
    if (this.networkTimer) clearInterval(this.networkTimer);
    this.networkTimer = undefined;
    this.publishedAddresses = null;
    this.deps.advertiser.stop();
    for (const service of ["tunnel", "worker", "gateway", "api"] as const) {
      await this.supervisors[service]?.stop();
    }
    this.supervisors = {};
    this.phases = {};
    this.tunnelNote = null;
    this.tunnelUrl = null;
    if (this.statusValue.kind !== "stopped") this.status = { kind: "stopped" };
  }

  private async performStart(signal: AbortSignal): Promise<void> {
    const { deps } = this;
    const config = this.configuration();
    this.status = { kind: "starting", message: "Hazırlanıyor" };
    const stateDir = deps.stateDir;
    try {
      for (const dir of [this.logsDir, join(stateDir, "api", "state"), join(stateDir, "worker")]) {
        mkdirSync(dir, { recursive: true });
      }
      const emptyEnv = join(stateDir, "api", "no-dev-vars.env");
      if (!deps.fileExists(emptyEnv)) {
        writeFileSync(
          emptyEnv,
          "# Empty on purpose: the host passes secrets through the environment.\n",
        );
      }
    } catch (error) {
      return this.fail(`Durum klasörü oluşturulamadı: ${(error as Error).message}`);
    }
    const instance = secrets.loadOrCreateInstanceId(stateDir);
    this.instance = instance;
    this.macName = deps.computerName();
    const repo = env.expandTilde(config.repoPath);

    // 1. Attach to our own running copy, but only if the app that started it is still alive.
    //    Children left behind by a force-quit run old code against an old database
    //    (migrations never ran), so they are stopped and started fresh.
    const previous = secrets.readHostFile(stateDir);
    if (
      previous &&
      previous.pid !== deps.ownPid &&
      !deps.isAlive(previous.pid) &&
      config.hostEnabled
    ) {
      await deps.stopLeftovers(repo);
      if (signal.aborted) return;
    }
    const ownerAlive = previous
      ? previous.pid !== deps.ownPid && deps.isAlive(previous.pid)
      : false;
    const candidates = new Set<number>();
    if (ownerAlive && previous) candidates.add(previous.apiPort);
    if (ownerAlive || !config.hostEnabled) candidates.add(config.preferredAPIPort);
    for (const port of candidates) {
      const health = await deps.health(port);
      if (signal.aborted) return;
      if (health?.instance === instance) {
        this.apiPort = port;
        this.lanPort = ownerAlive && previous?.lanPort ? previous.lanPort : null;
        this.status = { kind: "attached" };
        this.monitorAttached(port, instance);
        return;
      }
    }
    if (!config.hostEnabled) {
      return this.fail("Studio sunucusu çalışmıyor. Ayarlar → Mac sunucusu'ndan sunucuyu aç.");
    }

    // 2. Tools and sources.
    const path = deps.loginShellPath();
    const node = deps.which("node", path);
    if (!node) return this.fail(`node bulunamadı. PATH: ${path}`);
    const claude = deps.which("claude", path);
    const gemini = deps.which("gemini", path);
    const codex = deps.which("codex", path);
    const antigravity = deps.which("agy", path);

    // 3. Secrets (shared with the AppKit app).
    let token: string;
    let vaultKey: string;
    try {
      token = secrets.loadOrCreateWorkerToken(stateDir);
      vaultKey = secrets.loadOrCreateVaultKey(stateDir);
    } catch (error) {
      return this.fail(`Anahtar dosyaları oluşturulamadı: ${(error as Error).message}`);
    }

    // 4. Ports: the preferred ones when free (a hand-started `wrangler dev` may hold them).
    const apiFree =
      (await deps.isPortFree(config.preferredAPIPort, "127.0.0.1")) &&
      (await deps.isPortFree(config.preferredAPIPort, "0.0.0.0"));
    const apiPort = apiFree ? config.preferredAPIPort : await deps.freePort("127.0.0.1");
    if (apiPort === null) return this.fail("Boş port bulunamadı.");
    let lan: number | null = null;
    if (config.lanEnabled) {
      lan =
        config.preferredLANPort !== apiPort &&
        (await deps.isPortFree(config.preferredLANPort, "0.0.0.0"))
          ? config.preferredLANPort
          : await deps.freePort("0.0.0.0");
    }
    // Remote Control must always go through the gateway: traffic sent straight to workerd on
    // 127.0.0.1 counts as the Mac itself. With LAN access off, run the gateway on loopback.
    let tunnelGateway: number | null = null;
    if (config.remoteControlEnabled && lan === null) {
      tunnelGateway = await deps.freePort("127.0.0.1");
    }
    if (signal.aborted) return;

    const specs = buildSpecs({
      node,
      repo,
      stateDir,
      base: env.baseEnvironment(path),
      token,
      vaultKey,
      instance,
      apiPort,
      claude,
      gemini,
      codex,
      antigravity,
    });
    for (const required of specs.required) {
      if (!deps.fileExists(required)) {
        return this.fail(
          `Depo klasörü eksik ya da \`pnpm install\` yapılmamış: ${required} yok. Ayarlar → Gelişmiş → Depo klasörü.`,
        );
      }
    }

    // Privacy protection: read one repo file first and say what to do while macOS asks.
    const access = await deps.checkRepoAccess(
      specs.probe,
      () => {
        if (!signal.aborted)
          this.status = { kind: "starting", message: guards.waitingMessage(repo) };
      },
      signal,
    );
    if (access.kind === "cancelled" || signal.aborted) return;
    if (access.kind !== "readable") {
      return this.fail(guards.accessFailureMessage(access, repo, specs.probe));
    }

    this.apiPort = apiPort;
    this.lanPort = lan;
    secrets.writeHostFile(stateDir, { apiPort, lanPort: lan, pid: deps.ownPid });

    // 5. Migrations (one shot).
    this.status = { kind: "starting", message: "Veritabanı güncelleniyor" };
    for (const name of ["migrate", "api", "gateway", "worker"]) deps.rotate(this.logFile(name));
    let migration: RunningProcess;
    try {
      migration = deps.launcher.launch(specs.migrate);
    } catch (error) {
      return this.fail((error as Error).message, "migrate");
    }
    const timeoutMs = deps.migrationTimeoutMs ?? 120_000;
    const outcome = await waitOneShot(migration, timeoutMs, { signal });
    if (outcome.kind === "cancelled" || signal.aborted) return;
    if (outcome.kind === "timedOut") {
      return this.fail(
        guards.migrationTimeoutMessage(Math.round(timeoutMs / 1000), repo),
        "migrate",
      );
    }
    if (outcome.code !== 0) {
      return this.fail(
        `Veritabanı güncellemesi başarısız (çıkış kodu ${outcome.code}).`,
        "migrate",
      );
    }

    // 6. API, then wait for it to answer.
    this.status = { kind: "starting", message: "API başlatılıyor" };
    this.supervise("api", specs.api);
    const readyTimeout = deps.apiReadyTimeoutMs ?? 120_000;
    const deadline = deps.now() + readyTimeout;
    let ready = false;
    while (deps.now() < deadline) {
      const phase = this.phases.api;
      if (phase?.kind === "failed") return this.fail(phase.message, "api");
      if ((await deps.health(apiPort))?.instance === instance) {
        ready = true;
        break;
      }
      await deps.sleep(500, signal);
      if (signal.aborted || this.statusValue.kind === "stopped") return;
    }
    if (!ready)
      return this.fail(`API ${Math.round(readyTimeout / 1000)} sn içinde yanıt vermedi.`, "api");

    // 7. LAN gateway + Bonjour.
    if (lan !== null) {
      this.supervise("gateway", specs.gateway("0.0.0.0", lan));
      deps.advertiser.start({
        name: this.macName,
        port: lan,
        macId: instance,
        addresses: deps.lanAddresses(),
      });
    } else if (tunnelGateway !== null) {
      this.supervise("gateway", specs.gateway("127.0.0.1", tunnelGateway));
    }

    // 8. Worker.
    this.supervise("worker", specs.worker);

    // 9. Remote Control Cloudflare Tunnel.
    this.tunnelNote = null;
    if (config.remoteControlEnabled) {
      deps.rotate(this.logFile("tunnel"));
      const targetPort = lan ?? tunnelGateway;
      if (targetPort === null) {
        this.tunnelNote = "Tünel için geçit başlatılamadı.";
      } else {
        await this.startTunnel(config, targetPort, path);
      }
    }

    this.status = { kind: "running" };
    this.startNetworkMonitor();
  }

  private async startTunnel(config: HostConfiguration, targetPort: number, path: string) {
    const localTargetURL = `http://127.0.0.1:${targetPort}`;
    const cloudflared = this.deps.which("cloudflared", path);
    if (!cloudflared) {
      this.tunnelNote =
        "cloudflared bulunamadı (`brew install cloudflared` ile kurup Studio'yu yeniden başlat).";
      return;
    }
    const host = guards.normalizedHostname(config.remoteHostname);
    const token = await this.deps.readTunnelToken();
    const base = env.baseEnvironment(path);
    const spec = (args: string[], extra: Record<string, string> = {}): ProcessSpec => ({
      name: "tunnel",
      executable: cloudflared,
      args,
      env: { ...base, ...extra },
      cwd: this.deps.stateDir,
      logFile: this.logFile("tunnel"),
    });
    if (token) {
      this.supervise(
        "tunnel",
        spec(guards.tunnelArguments(token, host, localTargetURL), { TUNNEL_TOKEN: token }),
      );
      this.tunnelNote = `Aktif hedef: https://${host} → ${localTargetURL}`;
      this.tunnelUrl = `https://${host}`;
    } else if (this.deps.fileExists(join(process.env.HOME ?? "", ".cloudflared", "cert.pem"))) {
      this.supervise("tunnel", spec(guards.tunnelArguments(null, host, localTargetURL)));
      this.tunnelNote = `Adlandırılmış tünel çalışıyor: https://${host} → ${localTargetURL}`;
      this.tunnelUrl = `https://${host}`;
    } else {
      this.tunnelNote =
        "CLOUDFLARE_TUNNEL_TOKEN girilmedi. Cloudflare Zero Trust panelinden tünel anahtarını yapıştırıp Kaydet'e tıkla.";
    }
  }

  // --- routes for phones -----------------------------------------------------------------------

  /** Where phones can reach this Mac right now (null unless this app runs the server). */
  routes(): MacRoutesInput | null {
    if (this.statusValue.kind !== "running") return null;
    const lan = this.lanPort === null ? [] : this.deps.lanAddresses().slice(0, 8);
    const name = this.macName || this.deps.computerName();
    return {
      macName: name.slice(0, 120),
      macId: this.instance,
      lanAddresses: lan,
      lanPort: this.lanPort,
      bonjourName: this.deps.advertiser.isAdvertising ? name.slice(0, 63) : null,
      tunnelUrl: this.tunnelUrl,
    };
  }

  /** Tell the API where phones can reach this Mac (`PUT /api/pairing/routes`). */
  async publishRoutes(): Promise<void> {
    const routes = this.routes();
    if (!routes || this.apiPort === null) return;
    if (await this.deps.publishRoutes(this.apiPort, routes)) {
      this.publishedAddresses = routes.lanAddresses;
      this.routesRevision += 1;
    }
  }

  /** Wi-Fi changes: advertise the new addresses with Bonjour and publish them. */
  private startNetworkMonitor(): void {
    if (this.networkTimer) clearInterval(this.networkTimer);
    this.networkTimer = setInterval(
      () => void this.networkChanged(),
      this.deps.networkPollMs ?? 10_000,
    );
    this.networkTimer.unref?.();
    void this.publishRoutes();
  }

  async networkChanged(): Promise<void> {
    const routes = this.routes();
    if (!routes) return;
    if (JSON.stringify(routes.lanAddresses) === JSON.stringify(this.publishedAddresses)) return;
    if (this.lanPort !== null && this.deps.advertiser.isAdvertising) {
      this.deps.advertiser.start({
        name: this.macName,
        port: this.lanPort,
        macId: this.instance,
        addresses: this.deps.lanAddresses(),
      });
    }
    await this.publishRoutes();
  }

  // --- helpers ---------------------------------------------------------------------------------

  private supervise(service: ServiceName, spec: ProcessSpec): void {
    const supervisor = new ServiceSupervisor(
      SERVICE_LABELS[service],
      () => spec,
      this.deps.launcher,
      this.deps.supervisor,
    );
    supervisor.onChange = (phase) => this.update(service, phase);
    this.supervisors[service] = supervisor;
    supervisor.start();
    this.phases[service] = supervisor.phase;
    this.emit();
  }

  private update(service: ServiceName, phase: ServicePhase): void {
    this.phases[service] = phase;
    if (phase.kind === "failed" && this.statusValue.kind === "running") {
      this.status = {
        kind: "error",
        message: phase.message,
        log: this.deps.tail(this.logFile(service)),
      };
      return;
    }
    this.emit();
  }

  private fail(message: string, log?: string): void {
    this.status = { kind: "error", message, log: log ? this.deps.tail(this.logFile(log)) : "" };
    const owned = Object.values(this.supervisors);
    this.supervisors = {};
    void Promise.all(owned.map((s) => s?.stop()));
  }

  /** While attached, take over if the other instance goes away (three missed checks). */
  private monitorAttached(port: number, instance: string): void {
    this.attachAbort?.abort();
    const abort = new AbortController();
    this.attachAbort = abort;
    const poll = this.deps.attachPollMs ?? 10_000;
    void (async () => {
      let misses = 0;
      while (!abort.signal.aborted) {
        await this.deps.sleep(poll, abort.signal);
        if (abort.signal.aborted) return;
        if ((await this.deps.health(port))?.instance === instance) {
          misses = 0;
          continue;
        }
        misses += 1;
        if (misses >= 3) {
          this.attachAbort = undefined;
          this.apiPort = null;
          this.status = { kind: "stopped" };
          await this.start();
          return;
        }
      }
    })();
  }

  /** Log tail for one service (shown on errors). */
  lastLines(service: string, lines = 12): string {
    return this.deps.tail(this.logFile(service), lines);
  }
}

// --- real dependencies ------------------------------------------------------------------------

export async function fetchHealth(port: number): Promise<HealthInfo | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2_000),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { instance?: unknown };
    return typeof body.instance === "string" ? { instance: body.instance } : {};
  } catch {
    return null;
  }
}

export async function putRoutes(port: number, routes: MacRoutesInput): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/pairing/routes`, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(routes),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function defaultHostDeps(input: {
  stateDir: string;
  launcher: ProcessLauncher;
  advertiser: Advertiser;
}): HostDeps {
  return {
    ...input,
    ownPid: process.pid,
    health: fetchHealth,
    isAlive: guards.isAlive,
    stopLeftovers: guards.stopLeftovers,
    loginShellPath: env.loginShellPath,
    which: env.which,
    fileExists: existsSync,
    isPortFree: env.isPortFree,
    freePort: env.freePort,
    lanAddresses: () => env.lanAddresses(),
    computerName: env.computerName,
    checkRepoAccess: (probe, onWaiting, signal) =>
      guards.checkRepoAccess(() => guards.openForReading(probe), {
        noticeAfterMs: 2_000,
        limitMs: 30 * 60_000,
        onWaiting,
        signal,
      }),
    readTunnelToken: guards.readTunnelToken,
    publishRoutes: putRoutes,
    tail: env.tail,
    rotate: (file) => env.rotate(file),
    sleep,
    now: Date.now,
  };
}
