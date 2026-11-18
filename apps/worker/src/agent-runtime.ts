/**
 * Everything the AI- and media-backed handlers share in one worker process: the API client,
 * Claude runner/gate/auth, Gemini API/CLI readiness, the Chromium renderer, and the
 * background schedule sync poller.
 *
 * Readiness decides what the worker announces to the hub:
 * - `content.render`, `schedule.publish` and `content.check` are ALWAYS announced (the checks'
 *   model pass is skipped without Claude / Gemini);
 * - `chat.turn`, `content.generate`, `brand.analyze`, and `image.generate` are announced
 *   whenever `claudeAvailable() || geminiAvailable()`.
 */
import type { spawn as nodeSpawn } from "node:child_process";
import path from "node:path";
import type {
  AiProviderStatus,
  ClaudeAccount,
  ClaudeLimitState,
  GeminiAccount,
} from "@studio/contract";
import { createRenderer, type Renderer } from "@studio/design-kit/render";
import { type AgentSettings, claudeLogDir } from "./agent.ts";
import { AiPolicy } from "./ai/policy.ts";
import { AiUsageRecorder } from "./ai/usage-recorder.ts";
import { apiBaseFromHubUrl, createStudioApi, type StudioApi } from "./api.ts";
import { createBrandAnalyzeHandler } from "./brand/handler.ts";
import { createBrandSkillDraftHandler } from "./brand/skill-draft.ts";
import { findSkillsDir, loadSkills } from "./chat/skills.ts";
import { createChatTurnHandler } from "./chat/turn.ts";
import { createContentCheckHandler } from "./checks/handler.ts";
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
import { geminiKeySource, getGeminiApiKey } from "./gemini/json-call.ts";
import { type ContentGenerateDeps, createContentGenerateHandler } from "./generate/handler.ts";
import { createImageGenerateHandler } from "./image/handler.ts";
import type { Logger } from "./log.ts";
import { StudioMcpServer } from "./mcp/server.ts";
import type { AntigravityProbe } from "./providers/antigravity.ts";
import type { CodexProbe } from "./providers/codex.ts";
import { ProvidersController } from "./providers/status.ts";
import { createSchedulePublishHandler, type SchedulePublishDeps } from "./publish/handler.ts";
import { SchedulePoller } from "./publish/poller.ts";
import type { JobRegistry } from "./registry.ts";
import { createContentRenderHandler } from "./render/handler.ts";
import { createMediaAnalyzeHandler } from "./vision/analyze.ts";
import {
  createVisionHelper,
  findVisionHelper,
  missingVisionHelper,
  VISION_HELPER_MISSING,
  type VisionHelper,
} from "./vision/helper.ts";

/** `media.analyze` runs without AI: Vision on the Mac (colours and shape even without it). */
export const ALWAYS_JOB_TYPES = [
  "content.render",
  "schedule.publish",
  "content.check",
  "media.analyze",
] as const;
export const AI_JOB_TYPES = [
  "chat.turn",
  "content.generate",
  "brand.analyze",
  "image.generate",
  "brand.skill_draft",
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
  /** Codex / Antigravity probes (default: run the CLIs; unit tests with `selfTest` never do). */
  codexProbe?: () => Promise<CodexProbe>;
  antigravityProbe?: () => Promise<AntigravityProbe>;
  providerLoginSpawn?: typeof nodeSpawn;
  codexSpawn?: typeof nodeSpawn;
  antigravitySpawn?: typeof nodeSpawn;
  openaiFetch?: typeof globalThis.fetch;
  /** How often to read the stored AI keys again (default 5 min; 0 = only on command). */
  credentialsIntervalMs?: number;
  /** Apple Vision helper (default: `studio-vision` found on disk; none in hermetic tests). */
  vision?: VisionHelper;
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
  /** Codex CLI / OpenAI API / Antigravity CLI readiness and sign-ins (`worker.providers`). */
  readonly providers: ProvidersController;
  /** Paid AI calls (Gemini, OpenAI, ElevenLabs spend) to the API; the budget check. */
  readonly aiUsage: AiUsageRecorder;
  /** The owner's Claude-limit choice and budget (S7), read from the API. */
  readonly aiPolicy: AiPolicy;
  /** Apple Vision on this Mac (`studio-vision`): tagging (N12) and label preservation (U9). */
  readonly vision: VisionHelper;
  private readonly claudeListeners = new Set<(account: ClaudeAccount) => void>();
  private lastLimit = "null";

  private current: ClaudeHealth = {
    state: "error",
    message: "Claude öz sınaması henüz çalışmadı.",
    checkedAt: new Date(0).toISOString(),
  };
  private gemini: GeminiAccount;
  private renderer: Renderer | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private credentialsTimer: ReturnType<typeof setInterval> | undefined;
  private onChange: (() => void) | undefined;
  private readonly geminiListeners = new Set<(account: GeminiAccount) => void>();
  private checking: Promise<ClaudeHealth> | undefined;
  private readonly runSelfTest: () => Promise<ClaudeHealth>;
  private readonly runGeminiCheck: () => Promise<GeminiAccount>;

  constructor(private readonly options: AgentRuntimeOptions) {
    const { config, settings, logger } = options;
    settings.vault ??= {};
    const hasKey = Boolean(getGeminiApiKey(settings));
    this.gemini = {
      status: hasKey && settings.geminiMode !== "cli" ? "ready" : "not_configured",
      mode: hasKey ? "api" : "none",
      apiKeyConfigured: hasKey,
      keySource: geminiKeySource(settings),
      cliVersion: null,
      defaultModel: settings.geminiModels["gemini-flash-lite"],
      detail: hasKey
        ? `Gemini API anahtarı hazır · doğrudan API (${settings.geminiModels["gemini-flash-lite"]})`
        : "Gemini API anahtarı yok: Ayarlar → Yapay zekâ'dan girin (ya da .env GEMINI_API_KEY)",
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

    this.aiPolicy = new AiPolicy({ logger });
    this.gate = new ClaudeGate({
      runner,
      concurrency: settings.claudeConcurrency,
      logger,
      // S7: what a call does at the usage limit ("Sor" / "Gemini'ye geç" / "Bekle").
      limitChoice: () => this.aiPolicy.limitChoice(),
    });
    // A new answer or mode: parked calls look again; the app sees the limit state.
    this.aiPolicy.onChange(() => {
      this.gate.wake();
      this.emitClaude();
    });
    this.gate.onStatus(() => this.emitClaude());

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
          apiKey: getGeminiApiKey(settings),
          keySource: geminiKeySource(settings),
          bin: settings.geminiBin,
          preferredMode: settings.geminiMode,
          defaultModel: settings.geminiModels["gemini-flash-lite"],
          parentEnv: settings.parentEnv,
        }));

    this.aiUsage = new AiUsageRecorder({ api: this.api, logger, policy: this.aiPolicy });
    const hermetic = Boolean(options.selfTest);
    this.vision =
      options.vision ??
      (hermetic
        ? missingVisionHelper()
        : createVisionHelper({ bin: findVisionHelper(settings.parentEnv), logger }));
    this.providers = new ProvidersController({
      settings,
      logger,
      ...(options.codexProbe
        ? { probeCodex: options.codexProbe }
        : hermetic
          ? {
              probeCodex: async () => ({
                installed: false,
                version: null,
                loggedIn: false,
                method: null,
                error: null,
              }),
            }
          : {}),
      ...(options.antigravityProbe
        ? { probeAntigravity: options.antigravityProbe }
        : hermetic
          ? {
              probeAntigravity: async () => ({
                installed: false,
                version: null,
                loggedIn: false,
                models: [],
                error: null,
              }),
            }
          : {}),
      ...(options.providerLoginSpawn ? { loginSpawn: options.providerLoginSpawn } : {}),
    });

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
      aiUsage: this.aiUsage,
      aiPolicy: this.aiPolicy,
      providers: () => this.providers.list(),
      refreshUsage: () => void this.usagePoller.refresh(),
      mcpServer: this.mcpServer,
      skills: () => loadSkills(skillsDir),
      stateDir: config.stateDir,
      vision: this.vision,
      inFlightSchedules,
      ...(options.geminiFetch ? { geminiFetch: options.geminiFetch } : {}),
      ...(options.geminiCliSpawn ? { geminiCliSpawn: options.geminiCliSpawn } : {}),
      ...(options.codexSpawn ? { codexSpawn: options.codexSpawn } : {}),
      ...(options.antigravitySpawn ? { antigravitySpawn: options.antigravitySpawn } : {}),
      ...(options.openaiFetch ? { openaiFetch: options.openaiFetch } : {}),
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

  /** The Claude sign-in plus, while work waits for the usage limit, the limit state (S7). */
  claudeAccount(): ClaudeAccount {
    return { ...this.claudeAuth.latest(), limit: this.limitState() };
  }

  /** Claude's usage window is used up: when it resets, the owner's choice, who waits (S7). */
  limitState(): ClaudeLimitState | null {
    const status = this.gate.status();
    if (!status.parkedUntil) return null;
    return {
      resetsAt: status.parkedUntil.toISOString(),
      mode: this.aiPolicy.claudeLimitMode(),
      decision: this.aiPolicy.limitDecision(),
      waiting: status.parked,
      geminiReady: Boolean(getGeminiApiKey(this.options.settings)),
    };
  }

  /** Tell the hub when the limit state changed (presence `claude.limit`). */
  private emitClaude(): void {
    const limit = JSON.stringify(this.limitState());
    if (limit === this.lastLimit) return;
    this.lastLimit = limit;
    const account = this.claudeAccount();
    for (const fn of this.claudeListeners) fn(account);
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

  /** Codex CLI, the OpenAI API key or Antigravity CLI can answer chat turns. */
  otherChatAvailable(): boolean {
    return (
      this.providers.codexReady() ||
      this.providers.openaiReady() ||
      this.providers.antigravityReady()
    );
  }

  /** Chat turns run on any ready provider. */
  chatAvailable(): boolean {
    return this.aiAvailable() || this.otherChatAvailable();
  }

  providerStatuses(): AiProviderStatus[] {
    return this.providers.list();
  }

  onProvidersChange(fn: (providers: AiProviderStatus[]) => void): () => void {
    return this.providers.onChange(fn);
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
    } else if (this.otherChatAvailable() && !out.includes("chat.turn")) {
      // Structured jobs need Claude or Gemini; chat turns also run on Codex / OpenAI / Antigravity.
      out.push("chat.turn");
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
      .register("image.generate", createImageGenerateHandler(this.deps))
      .register("brand.skill_draft", createBrandSkillDraftHandler(this.deps))
      .register("content.check", createContentCheckHandler(this.deps))
      .register("media.analyze", createMediaAnalyzeHandler({ ...this.deps, vision: this.vision }));
  }

  /**
   * N12: once per start, queue tagging of the pictures not read yet and redo the ones read
   * without the Vision helper. Without the helper there is no backfill (a colours-only pass over
   * the whole library would be redone anyway); new uploads still get colours and shape. Best
   * effort; the API keeps at most one waiting job.
   */
  async startMediaBackfill(): Promise<void> {
    const { logger } = this.options;
    try {
      if (!(await this.vision.available())) {
        logger.warn(`media tagging without Vision (no backfill): ${VISION_HELPER_MISSING}`);
        return;
      }
      const res = await this.api.client.assets.backfillAnalysis({ includePartial: true });
      if (res.pending > 0) {
        logger.info(`media: ${res.pending} picture(s) to tag (job ${res.jobId ?? "none"})`);
      }
    } catch (error) {
      logger.debug(`media backfill not queued: ${(error as Error).message}`);
    }
  }

  /** Called when capabilities or health state change (the worker re-announces itself). */
  onHealthChange(fn: () => void): void {
    this.onChange = fn;
  }

  onClaudeAccountChange(fn: (account: ClaudeAccount) => void): () => void {
    this.claudeListeners.add(fn);
    const off = this.claudeAuth.onUpdate(() => fn(this.claudeAccount()));
    return () => {
      this.claudeListeners.delete(fn);
      off();
    };
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
    await this.refreshCredentials({ silent: true });
    await this.refreshAiSettings();
    // Subscription usage without a model call (`claude -p /usage`), in the background.
    void this.usagePoller.refresh();
    await this.refreshGeminiStatus({ silentReannounce: true });
    // `agy models` asks Google: in the background, re-announcing if chat becomes possible.
    const beforeChat = this.chatAvailable();
    void this.providers
      .refresh()
      .then(() => {
        if (beforeChat !== this.chatAvailable()) this.onChange?.();
      })
      .catch((error: unknown) =>
        this.options.logger.warn(`providers: check failed: ${(error as Error).message}`),
      );
    const health = await this.check();
    const interval = this.options.recheckIntervalMs ?? 5 * 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        if (this.current.state === "ok") return;
        void this.check();
      }, interval);
      this.timer.unref?.();
    }

    const credentialsInterval =
      this.options.credentialsIntervalMs ?? (this.options.recheckIntervalMs === 0 ? 0 : 5 * 60_000);
    if (credentialsInterval > 0) {
      this.credentialsTimer = setInterval(() => {
        void this.refreshCredentials();
        void this.refreshAiSettings();
      }, credentialsInterval);
      this.credentialsTimer.unref?.();
    }

    const scheduleInterval =
      this.options.schedulePollIntervalMs ??
      (this.options.recheckIntervalMs === 0 ? 0 : this.options.settings.schedulePollIntervalMs);
    if (scheduleInterval > 0) {
      this.schedulePoller.start(scheduleInterval);
    }
    if (this.options.recheckIntervalMs !== 0) void this.startMediaBackfill();
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

  /**
   * Read the stored AI keys from the API (`worker.command ai.credentials`, start, every 5 min).
   * A failed read keeps the last keys. Never logs a key.
   */
  async refreshCredentials(opts: { silent?: boolean } = {}): Promise<void> {
    const { settings, logger } = this.options;
    let next: {
      gemini?: { apiKey: string; models: string[] };
      openai?: { apiKey: string; models: string[] };
    };
    try {
      const remote = await this.api.client.workerAi.credentials();
      next = {
        ...(remote.gemini ? { gemini: remote.gemini } : {}),
        ...(remote.openai ? { openai: remote.openai } : {}),
      };
    } catch (error) {
      logger.debug(`ai credentials: not read (${(error as Error).message})`);
      return;
    }
    settings.vault ??= {};
    const vault = settings.vault;
    const fingerprint = (v: typeof next) =>
      JSON.stringify([
        v.gemini?.apiKey.slice(-6),
        v.gemini?.models.length,
        v.openai?.apiKey.slice(-6),
        v.openai?.models.length,
      ]);
    const changed = fingerprint(vault) !== fingerprint(next);
    vault.gemini = next.gemini;
    vault.openai = next.openai;
    if (!changed) return;
    const beforeChat = this.chatAvailable();
    logger.info(
      `ai credentials: gemini ${next.gemini ? "stored key" : "no stored key"}, openai ${next.openai ? "stored key" : "no stored key"}`,
    );
    this.providers.vaultChanged();
    await this.refreshGeminiStatus({ silentReannounce: opts.silent === true });
    if (!opts.silent && beforeChat !== this.chatAvailable()) this.onChange?.();
  }

  /**
   * Read the owner's AI preferences again (S7): the Claude-limit choice and answer, the budget.
   * The spend still queued here counts on top of the API's figure.
   */
  async refreshAiSettings(): Promise<void> {
    try {
      const settings = await this.api.client.workerAi.settings({
        tzOffset: new Date().getTimezoneOffset(),
      });
      this.aiPolicy.apply(settings, this.aiUsage.pendingCostUsd());
    } catch (error) {
      this.options.logger.debug(`ai settings: not read (${(error as Error).message})`);
    }
  }

  /** Handle `worker.command` `providers.status`. */
  async refreshProviders(): Promise<AiProviderStatus[]> {
    const before = this.chatAvailable();
    const list = await this.providers.refresh();
    if (before !== this.chatAvailable()) this.onChange?.();
    return list;
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
    clearInterval(this.credentialsTimer);
    this.credentialsTimer = undefined;
    this.providers.stop();
    await this.aiUsage.stop();
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
