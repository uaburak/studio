/**
 * Everything the AI- and media-backed handlers share in one worker process: the API client,
 * Claude runner/gate/auth, Gemini API/CLI readiness, the Chromium renderer, and the
 * background schedule sync poller.
 *
 * Readiness decides what the worker announces to the hub:
 * - `content.render` and `schedule.publish` are ALWAYS announced;
 * - `chat.turn`, `content.generate`, `brand.analyze`, and `image.generate` are announced
 *   whenever `claudeAvailable() || geminiAvailable()`.
 */
import type { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import type { ClaudeAccount, GeminiAccount } from "@studio/contract";
import { createRenderer, type Renderer } from "@studio/design-kit/render";
import { type AgentSettings, claudeLogDir } from "./agent.ts";
import { apiBaseFromHubUrl, createStudioApi, type StudioApi } from "./api.ts";
import { createBrandAnalyzeHandler } from "./brand/handler.ts";
import { findSkillsDir, loadSkills } from "./chat/skills.ts";
import { createChatTurnHandler } from "./chat/turn.ts";
import { buildClaudeEnv } from "./claude/args.ts";
import { ClaudeAuthController, type RawClaudeAuthInfo } from "./claude/auth.ts";
import { ClaudeError, ClaudeUsageLimitError } from "./claude/errors.ts";
import { ClaudeGate } from "./claude/gate.ts";
import { type ClaudeHealth, claudeSelfTest } from "./claude/health.ts";
import { type ClaudeRunner, createClaudeRunner } from "./claude/runner.ts";
import {
  type UsageReport,
  UsageTracker,
  usageFromLimitError,
  usageFromRateLimit,
} from "./claude/usage.ts";
import { readCliUsage, UsagePoller } from "./claude/usage-cli.ts";
import type { WorkerConfig } from "./config.ts";
import { checkGeminiHealth } from "./gemini/health.ts";
import { type ContentGenerateDeps, createContentGenerateHandler } from "./generate/handler.ts";
import { createImageGenerateHandler } from "./image/handler.ts";
import type { Logger } from "./log.ts";
import { StudioMcpServer } from "./mcp/server.ts";
import { createSchedulePublishHandler, type SchedulePublishDeps } from "./publish/handler.ts";
import { SchedulePoller } from "./publish/poller.ts";
import type { JobRegistry } from "./registry.ts";
import { createContentRenderHandler } from "./render/handler.ts";

export const ALWAYS_JOB_TYPES = ["content.render", "schedule.publish"] as const;
export const AI_JOB_TYPES = [
  "chat.turn",
  "content.generate",
  "brand.analyze",
  "image.generate",
] as const;
export const CLAUDE_JOB_TYPES = AI_JOB_TYPES;

export interface AgentRuntimeOptions {
  config: WorkerConfig;
  settings: AgentSettings;
  logger: Logger;
  /** Test seams. */
  runner?: ClaudeRunner;
  api?: StudioApi;
  selfTest?: () => Promise<ClaudeHealth>;
  claudeProbe?: () => Promise<RawClaudeAuthInfo>;
  claudeLoginSpawn?: typeof nodeSpawn;
  claudeLoginTimeoutMs?: number;
  geminiHealthCheck?: () => Promise<GeminiAccount>;
  geminiFetch?: typeof globalThis.fetch;
  geminiCliSpawn?: typeof nodeSpawn;
  publisherFetch?: typeof globalThis.fetch;
  recheckIntervalMs?: number;
  schedulePollIntervalMs?: number;
  /** `claude -p /usage` reader (default: run the CLI; tests inject one). */
  usageReader?: () => Promise<UsageReport | null>;
}

export class AgentRuntime {
  readonly api: StudioApi;
  readonly gate: ClaudeGate;
  readonly deps: ContentGenerateDeps & SchedulePublishDeps;
  /** Latest subscription usage windows seen in any call (reported to the hub as `worker.usage`). */
  readonly usage: UsageTracker;
  readonly claudeAuth: ClaudeAuthController;
  readonly schedulePoller: SchedulePoller;
  /** Studio's MCP server for chat turns (127.0.0.1, a token per run). */
  readonly mcpServer: StudioMcpServer;
  /** `claude -p /usage` at startup and after each chat turn (≥ 60 s apart). */
  readonly usagePoller: UsagePoller;

  private current: ClaudeHealth = {
    state: "error",
    message: "Claude öz sınaması henüz çalışmadı.",
    checkedAt: new Date(0).toISOString(),
  };
  private gemini: GeminiAccount;
  private renderer: Renderer | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private onChange: (() => void) | undefined;
  private readonly geminiListeners = new Set<(account: GeminiAccount) => void>();
  private checking: Promise<ClaudeHealth> | undefined;
  private readonly runSelfTest: () => Promise<ClaudeHealth>;
  private readonly runGeminiCheck: () => Promise<GeminiAccount>;

  constructor(private readonly options: AgentRuntimeOptions) {
    const { config, settings, logger } = options;
    this.gemini = {
      status: settings.geminiApiKey && settings.geminiMode !== "cli" ? "ready" : "not_configured",
      mode: settings.geminiApiKey ? "api" : "none",
      apiKeyConfigured: Boolean(settings.geminiApiKey),
      cliVersion: null,
      defaultModel: settings.geminiModels["gemini-flash-lite"],
      detail: settings.geminiApiKey
        ? `GEMINI_API_KEY hazır · doğrudan API (${settings.geminiModels["gemini-flash-lite"]})`
        : ".env dosyasında GEMINI_API_KEY tanımlı değil",
      checkedAt: new Date(0).toISOString(),
    };

    this.api =
      options.api ??
      createStudioApi({
        baseUrl: settings.apiUrl ?? apiBaseFromHubUrl(config.hubUrl),
        workerToken: config.token,
      });

    const claudeEnv = {
      configDir: settings.claudeConfigDir,
      oauthToken: settings.parentEnv.CLAUDE_CODE_OAUTH_TOKEN,
    };

    const baseRunner =
      options.runner ??
      createClaudeRunner({
        bin: settings.claudeBin,
        env: claudeEnv,
        parentEnv: settings.parentEnv,
        workRoot: path.join(config.stateDir, "claude-work"),
        ...(settings.logStreams ? { logDir: claudeLogDir(config.stateDir) } : {}),
        defaultModel: settings.model,
        defaultTimeoutMs: settings.claudeTimeoutMs,
        fallbackResetMs: settings.usageLimitFallbackMs,
      });

    this.usage = new UsageTracker(path.join(config.stateDir, "claude-usage.json"));

    // Every call (self-test included) reports the usage windows its stream carried.
    const tracked: ClaudeRunner = async (call) => {
      try {
        const res = await baseRunner(call);
        if (res.rateLimit) this.usage.merge(usageFromRateLimit(res.rateLimit, new Date()));
        return res;
      } catch (error) {
        if (error instanceof ClaudeUsageLimitError) {
          this.usage.merge(usageFromLimitError(error, new Date()));
        }
        throw error;
      }
    };
    this.usagePoller = new UsagePoller({
      tracker: this.usage,
      logger,
      read:
        options.usageReader ??
        (options.selfTest
          ? async () => null // unit tests with an injected self-test never spawn `claude`
          : () =>
              readCliUsage({
                bin: settings.claudeBin,
                env: buildClaudeEnv(settings.parentEnv, claudeEnv),
              })),
    });
    this.mcpServer = new StudioMcpServer({ logger });
    const skillsDir = findSkillsDir(undefined, settings.skillsDir);

    // An auth failure in a real job takes the Claude job types off the hub announcement.
    const runner: ClaudeRunner = async (call) => {
      try {
        return await tracked(call);
      } catch (error) {
        if (error instanceof ClaudeError && error.code === "auth")
          this.markUnauthenticated(error.message);
        throw error;
      }
    };

    this.gate = new ClaudeGate({ runner, concurrency: settings.claudeConcurrency, logger });

    this.claudeAuth = new ClaudeAuthController({
      bin: settings.claudeBin,
      env: claudeEnv,
      parentEnv: settings.parentEnv,
      logger,
      ...(options.claudeLoginSpawn ? { spawn: options.claudeLoginSpawn } : {}),
      ...(options.claudeLoginTimeoutMs !== undefined
        ? { loginTimeoutMs: options.claudeLoginTimeoutMs }
        : {}),
      ...(options.claudeProbe
        ? { probe: options.claudeProbe }
        : options.selfTest
          ? {
              // Keep unit tests that inject `selfTest` hermetic without spawning `claude`.
              probe: async () => ({
                cliVersion: this.current.cliVersion ?? "test",
                loggedIn: this.current.state === "ok" || this.current.state === "limited",
                subscriptionType: this.current.subscriptionType ?? null,
              }),
            }
          : {}),
      onLoginComplete: async () => {
        await this.check();
      },
    });

    this.runSelfTest =
      options.selfTest ??
      (() =>
        claudeSelfTest({
          bin: settings.claudeBin,
          env: claudeEnv,
          parentEnv: settings.parentEnv,
          runner: tracked,
          model: settings.model,
          callMode: settings.selfTest,
          stateDir: config.stateDir,
        }));

    this.runGeminiCheck =
      options.geminiHealthCheck ??
      (() =>
        checkGeminiHealth({
          apiKey: settings.parentEnv.GEMINI_API_KEY ?? settings.geminiApiKey,
          bin: settings.geminiBin,
          preferredMode: settings.geminiMode,
          defaultModel: settings.geminiModels["gemini-flash-lite"],
          parentEnv: settings.parentEnv,
        }));

    const inFlightSchedules = new Set<string>();

    this.deps = {
      api: this.api,
      gate: this.gate,
      settings,
      logger,
      health: () => this.current,
      claudeAccount: () => this.claudeAuth.latest(),
      geminiAccount: () => this.gemini,
      usage: this.usage,
      refreshUsage: () => void this.usagePoller.refresh(),
      mcpServer: this.mcpServer,
      skills: () => loadSkills(skillsDir),
      stateDir: config.stateDir,
      inFlightSchedules,
      ...(options.geminiFetch ? { geminiFetch: options.geminiFetch } : {}),
      ...(options.geminiCliSpawn ? { geminiCliSpawn: options.geminiCliSpawn } : {}),
      ...(options.publisherFetch ? { publisherFetch: options.publisherFetch } : {}),
      renderer: () => {
        this.renderer ??= createRenderer({ timeoutMs: 60_000 });
        return this.renderer;
      },
    };

    this.schedulePoller = new SchedulePoller(this.deps);
  }

  health(): ClaudeHealth {
    return this.current;
  }

  claudeAccount(): ClaudeAccount {
    return this.claudeAuth.latest();
  }

  geminiAccount(): GeminiAccount {
    return this.gemini;
  }

  /** Claude is available while signed in (`ok`) or parked on usage limit (`limited`). */
  claudeAvailable(): boolean {
    return this.current.state === "ok" || this.current.state === "limited";
  }

  /** Gemini is available when GEMINI_API_KEY or `gemini` CLI is ready. */
  geminiAvailable(): boolean {
    return this.gemini.status === "ready";
  }

  /** All AI job types are active whenever either Claude or Gemini is ready! */
  chatAvailable(): boolean {
    return this.claudeAvailable() || this.geminiAvailable();
  }

  aiAvailable(): boolean {
    return this.claudeAvailable() || this.geminiAvailable();
  }

  capabilities(base: readonly string[]): string[] {
    const out = [...base];
    for (const t of ALWAYS_JOB_TYPES) {
      if (!out.includes(t)) out.push(t);
    }
    if (this.aiAvailable()) {
      for (const t of AI_JOB_TYPES) {
        if (!out.includes(t)) out.push(t);
      }
    }
    return out;
  }

  versionSuffix(): string {
    return this.current.state === "ok" ? "" : `+claude.${this.current.state}`;
  }

  register(registry: JobRegistry): JobRegistry {
    return registry
      .register("content.render", createContentRenderHandler(this.deps))
      .register("schedule.publish", createSchedulePublishHandler(this.deps))
      .register("chat.turn", createChatTurnHandler(this.deps))
      .register("content.generate", createContentGenerateHandler(this.deps))
      .register("brand.analyze", createBrandAnalyzeHandler(this.deps))
      .register("image.generate", createImageGenerateHandler(this.deps));
  }

  /** Called when capabilities or health state change (the worker re-announces itself). */
  onHealthChange(fn: () => void): void {
    this.onChange = fn;
  }

  onClaudeAccountChange(fn: (account: ClaudeAccount) => void): () => void {
    return this.claudeAuth.onUpdate(fn);
  }

  onGeminiAccountChange(fn: (account: GeminiAccount) => void): () => void {
    this.geminiListeners.add(fn);
    return () => this.geminiListeners.delete(fn);
  }

  /** Run Claude & Gemini checks now and start periodic re-checks + due-schedule sync. */
  async start(onChange?: () => void): Promise<ClaudeHealth> {
    if (onChange) this.onChange = onChange;
    await this.usage.load();
    await this.mcpServer.start();
    // Subscription usage without a model call (`claude -p /usage`), in the background.
    void this.usagePoller.refresh();
    await this.refreshGeminiStatus({ silentReannounce: true });
    const health = await this.check();
    const interval = this.options.recheckIntervalMs ?? 5 * 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        if (this.current.state === "ok") return;
        void this.check();
      }, interval);
      this.timer.unref?.();
    }

    const scheduleInterval =
      this.options.schedulePollIntervalMs ??
      (this.options.recheckIntervalMs === 0 ? 0 : this.options.settings.schedulePollIntervalMs);
    if (scheduleInterval > 0) {
      this.schedulePoller.start(scheduleInterval);
    }
    return health;
  }

  async check(): Promise<ClaudeHealth> {
    this.checking ??= (async () => {
      try {
        const health = await this.runSelfTest();
        this.apply(health);
        await this.claudeAuth.refresh();
        return health;
      } finally {
        this.checking = undefined;
      }
    })();
    return this.checking;
  }

  /** Handle `worker.command` `claude.status`. */
  async refreshClaudeStatus(): Promise<ClaudeAccount> {
    await this.check();
    return this.claudeAuth.refresh();
  }

  /** Handle `worker.command` `claude.login`. */
  startClaudeLogin(): ClaudeAccount {
    return this.claudeAuth.startLogin();
  }

  /** Handle `worker.command` `gemini.status`. */
  async refreshGeminiStatus(opts: { silentReannounce?: boolean } = {}): Promise<GeminiAccount> {
    const beforeAi = this.aiAvailable();
    const next = await this.runGeminiCheck();
    const changed = JSON.stringify(this.gemini) !== JSON.stringify(next);
    this.gemini = next;
    const log = next.status === "ready" ? this.options.logger.info : this.options.logger.debug;
    log.call(this.options.logger, `gemini: ${next.status} (${next.mode}) — ${next.detail ?? ""}`);
    if (changed) {
      for (const fn of this.geminiListeners) fn(next);
    }
    if (!opts.silentReannounce && beforeAi !== this.aiAvailable()) {
      this.onChange?.();
    }
    return next;
  }

  markUnauthenticated(detail: string): void {
    if (this.current.state === "unauthenticated") return;
    this.options.logger.error(`claude: authentication lost (${detail})`);
    this.claudeAuth.markSignedOut(
      "Claude oturumu yok/süresi doldu: Ayarlar'dan giriş yapın ya da `claude auth login` çalıştırın.",
    );
    this.apply({
      state: "unauthenticated",
      message: "Claude oturumu yok/süresi doldu: Mac'te `claude auth login` çalıştırın.",
      checkedAt: new Date().toISOString(),
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.schedulePoller.stop();
    this.claudeAuth.stop();
    await this.mcpServer.stop();
    const r = this.renderer;
    this.renderer = undefined;
    await r?.close().catch(() => undefined);
  }

  private apply(health: ClaudeHealth): void {
    const beforeClaude = this.claudeAvailable();
    const beforeAi = this.aiAvailable();
    const previous = this.current.state;
    this.current = health;
    const log = health.state === "ok" ? this.options.logger.info : this.options.logger.error;
    log.call(
      this.options.logger,
      `claude: ${health.state} — ${health.message}${health.cliVersion ? ` (CLI ${health.cliVersion}${health.subscriptionType ? `, ${health.subscriptionType}` : ""})` : ""}`,
    );
    if (health.state === "limited" && health.resetsAt) {
      this.gate.park(new Date(health.resetsAt), "usage limit (self-test)", "rate_limit_event");
    }
    if (
      beforeClaude !== this.claudeAvailable() ||
      beforeAi !== this.aiAvailable() ||
      previous !== health.state
    ) {
      this.onChange?.();
    }
  }
}
