/**
 * Everything the Claude-backed handlers share in one worker process: the API client,
 * the Claude runner and gate, the self-test / health state, and the Chromium renderer.
 *
 * Health decides what the worker announces to the hub:
 * - `ok` / `limited`: `chat.turn` and `content.generate` are announced (limited = calls park);
 * - `unauthenticated` / `error`: they are not; such jobs wait in the hub queue (never lost),
 *   presence shows the worker without them and its version carries `+claude.<state>`.
 * Unhealthy states are re-checked every few minutes; on recovery the worker re-announces.
 */
import path from "node:path";
import { createRenderer, type Renderer } from "@studio/design-kit/render";
import { type AgentSettings, claudeLogDir } from "./agent.ts";
import { apiBaseFromHubUrl, createStudioApi, type StudioApi } from "./api.ts";
import { createChatTurnHandler } from "./chat/turn.ts";
import { ClaudeError, ClaudeUsageLimitError } from "./claude/errors.ts";
import { ClaudeGate } from "./claude/gate.ts";
import { type ClaudeHealth, claudeSelfTest } from "./claude/health.ts";
import { type ClaudeRunner, createClaudeRunner } from "./claude/runner.ts";
import { UsageTracker, usageFromLimitError, usageFromRateLimit } from "./claude/usage.ts";
import type { WorkerConfig } from "./config.ts";
import { type ContentGenerateDeps, createContentGenerateHandler } from "./generate/handler.ts";
import type { Logger } from "./log.ts";
import type { JobRegistry } from "./registry.ts";

export const CLAUDE_JOB_TYPES = ["chat.turn", "content.generate"] as const;

export interface AgentRuntimeOptions {
  config: WorkerConfig;
  settings: AgentSettings;
  logger: Logger;
  /** Test seams. */
  runner?: ClaudeRunner;
  api?: StudioApi;
  selfTest?: () => Promise<ClaudeHealth>;
  recheckIntervalMs?: number;
}

export class AgentRuntime {
  readonly api: StudioApi;
  readonly gate: ClaudeGate;
  readonly deps: ContentGenerateDeps;
  /** Latest subscription usage windows seen in any call (reported to the hub as `worker.usage`). */
  readonly usage: UsageTracker;
  private current: ClaudeHealth = {
    state: "error",
    message: "Claude öz sınaması henüz çalışmadı.",
    checkedAt: new Date(0).toISOString(),
  };
  private renderer: Renderer | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private onChange: (() => void) | undefined;
  private checking: Promise<ClaudeHealth> | undefined;
  private readonly runSelfTest: () => Promise<ClaudeHealth>;

  constructor(private readonly options: AgentRuntimeOptions) {
    const { config, settings, logger } = options;
    this.api =
      options.api ??
      createStudioApi({
        baseUrl: settings.apiUrl ?? apiBaseFromHubUrl(config.hubUrl),
        workerToken: config.token,
      });
    const baseRunner =
      options.runner ??
      createClaudeRunner({
        bin: settings.claudeBin,
        env: {
          configDir: settings.claudeConfigDir,
          oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        },
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
        if (res.rateLimit) this.usage.update(usageFromRateLimit(res.rateLimit, new Date()));
        return res;
      } catch (error) {
        if (error instanceof ClaudeUsageLimitError) {
          this.usage.update(usageFromLimitError(error, new Date()));
        }
        throw error;
      }
    };
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
    this.runSelfTest =
      options.selfTest ??
      (() =>
        claudeSelfTest({
          bin: settings.claudeBin,
          env: {
            configDir: settings.claudeConfigDir,
            oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          },
          runner: tracked,
          model: settings.model,
          callMode: settings.selfTest,
          stateDir: config.stateDir,
        }));
    this.deps = {
      api: this.api,
      gate: this.gate,
      settings,
      logger,
      health: () => this.current,
      stateDir: config.stateDir,
      renderer: () => {
        this.renderer ??= createRenderer({ timeoutMs: 60_000 });
        return this.renderer;
      },
    };
  }

  health(): ClaudeHealth {
    return this.current;
  }

  /** Claude job types are announced only while Claude can be used. */
  claudeAvailable(): boolean {
    return this.current.state === "ok" || this.current.state === "limited";
  }

  capabilities(base: readonly string[]): string[] {
    return this.claudeAvailable() ? [...base, ...CLAUDE_JOB_TYPES] : [...base];
  }

  versionSuffix(): string {
    return this.current.state === "ok" ? "" : `+claude.${this.current.state}`;
  }

  register(registry: JobRegistry): JobRegistry {
    return registry
      .register("chat.turn", createChatTurnHandler(this.deps))
      .register("content.generate", createContentGenerateHandler(this.deps));
  }

  /** Called when the health state changes (the worker re-announces itself). */
  onHealthChange(fn: () => void): void {
    this.onChange = fn;
  }

  /** Run the self-test now and start the periodic re-check. */
  async start(onChange?: () => void): Promise<ClaudeHealth> {
    if (onChange) this.onChange = onChange;
    await this.usage.load();
    const health = await this.check();
    const interval = this.options.recheckIntervalMs ?? 5 * 60_000;
    if (interval > 0) {
      this.timer = setInterval(() => {
        if (this.current.state === "ok") return;
        void this.check();
      }, interval);
      this.timer.unref?.();
    }
    return health;
  }

  async check(): Promise<ClaudeHealth> {
    this.checking ??= (async () => {
      try {
        const health = await this.runSelfTest();
        this.apply(health);
        return health;
      } finally {
        this.checking = undefined;
      }
    })();
    return this.checking;
  }

  markUnauthenticated(detail: string): void {
    if (this.current.state === "unauthenticated") return;
    this.options.logger.error(`claude: authentication lost (${detail})`);
    this.apply({
      state: "unauthenticated",
      message: "Claude oturumu yok/süresi doldu: Mac'te `claude auth login` çalıştırın.",
      checkedAt: new Date().toISOString(),
    });
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    const r = this.renderer;
    this.renderer = undefined;
    await r?.close().catch(() => undefined);
  }

  private apply(health: ClaudeHealth): void {
    const before = this.claudeAvailable();
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
    if (before !== this.claudeAvailable() || previous !== health.state) this.onChange?.();
  }
}
