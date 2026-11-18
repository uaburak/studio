import path from "node:path";
import type { WorkerCommand } from "@studio/contract";
import { type AgentRuntime, AI_JOB_TYPES } from "./agent-runtime.ts";
import type { WorkerConfig } from "./config.ts";
import { type ConnectionState, HubConnection } from "./connection.ts";
import { demoEcho } from "./jobs/demo-echo.ts";
import type { Logger } from "./log.ts";
import { FileOutbox, type Outbox } from "./outbox.ts";
import { JobRegistry } from "./registry.ts";
import { JobRunner } from "./runner.ts";
import { nodeSocketFactory, type SocketFactory } from "./socket.ts";
import { encodableUsageFrame } from "./usage-report.ts";

export const WORKER_VERSION = "0.1.0";

/**
 * The job types this worker can run: `demo.echo`, plus `chat.turn` and
 * `content.generate` when an agent runtime (Claude / Gemini) is given.
 */
export function createDefaultRegistry(agent?: AgentRuntime): JobRegistry {
  const registry = new JobRegistry().register("demo.echo", demoEcho);
  return agent ? agent.register(registry) : registry;
}

export interface StartWorkerOptions {
  config: WorkerConfig;
  logger: Logger;
  socketFactory?: SocketFactory;
  registry?: JobRegistry;
  /**
   * AI-backed handlers. Readiness decides which job types are announced; on a
   * change the worker reconnects to announce the new set.
   */
  agent?: AgentRuntime;
  /** Defaults to a FileOutbox in `config.stateDir`. */
  outbox?: Outbox;
  onStateChange?: (state: ConnectionState) => void;
}

export interface RunningWorker {
  readonly connection: HubConnection;
  readonly runner: JobRunner;
  readonly state: ConnectionState;
  /** Graceful: hand back running jobs, flush results, then disconnect. */
  shutdown(): Promise<void>;
  /** Immediate disconnect (no hand-back). */
  stop(): void;
}

/** Wire config + registry + runner + hub connection together and start connecting. */
export function startWorker(options: StartWorkerOptions): RunningWorker {
  const { config, logger } = options;
  const agent = options.agent;
  const registry = options.registry ?? createDefaultRegistry(agent);
  const aiTypes = new Set<string>(AI_JOB_TYPES);
  const baseTypes = registry.types().filter((t) => !agent || !aiTypes.has(t));
  const outbox =
    options.outbox ?? new FileOutbox(path.join(config.stateDir, "outbox.json"), { logger });
  let connection: HubConnection | undefined;
  let usageUnsupported = false;

  /** Latest subscription usage to the hub (`worker.usage`), when the contract knows the frame. */
  const sendUsage = () => {
    const report = agent?.usage.latest();
    if (!report || !connection) return;
    const frame = encodableUsageFrame(report);
    if (!frame) {
      if (!usageUnsupported) logger.debug("worker.usage is not in the contract yet; not sent");
      usageUnsupported = true;
      return;
    }
    connection.send(frame);
  };

  const sendClaude = () => {
    if (!agent || !connection) return;
    connection.send({ type: "worker.claude", account: agent.claudeAccount() });
  };

  const sendGemini = () => {
    if (!agent || !connection) return;
    connection.send({ type: "worker.gemini", account: agent.geminiAccount() });
  };

  const sendProviders = () => {
    if (!agent || !connection) return;
    connection.send({ type: "worker.providers", providers: agent.providerStatuses() });
  };

  const handleWorkerCommand = async (command: WorkerCommand) => {
    if (!agent) {
      logger.debug(`ignoring worker.command (${command}): agent runtime disabled`);
      return;
    }
    logger.info(`hub command received: ${command}`);
    switch (command) {
      case "claude.status":
        await agent.refreshClaudeStatus();
        return;
      case "claude.login":
        agent.startClaudeLogin();
        return;
      case "gemini.status":
        await agent.refreshGeminiStatus();
        return;
      case "providers.status":
        await agent.refreshProviders();
        sendProviders();
        return;
      case "codex.login":
        agent.providers.startCodexLogin();
        return;
      case "antigravity.login":
        agent.providers.startAntigravityLogin();
        return;
      case "ai.credentials":
        // Keys changed, or (S7) the Claude-limit choice / answer or the budget.
        await agent.refreshCredentials();
        await agent.refreshAiSettings();
        sendProviders();
        return;
    }
  };

  const runner = new JobRunner({
    workerId: config.workerId,
    registry,
    outbox,
    concurrency: config.concurrency,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    logger,
    send: (message) => {
      if (connection?.send(message)) return true;
      logger.debug(`not connected; did not send ${message.type}`);
      return false;
    },
  });

  connection = new HubConnection({
    url: config.hubUrl,
    token: config.token,
    workerId: config.workerId,
    capabilities: () => (agent ? agent.capabilities(baseTypes) : registry.types()),
    workerVersion: () => `${WORKER_VERSION}${agent?.versionSuffix() ?? ""}`,
    backoff: config.backoff,
    pingIntervalMs: config.pingIntervalMs,
    socketFactory: options.socketFactory ?? nodeSocketFactory,
    helloFields: () => runner.helloFields(),
    onReady: () => {
      runner.onConnected();
      sendClaude();
      sendGemini();
      sendProviders();
      sendUsage();
    },
    onMessage: (message) => {
      if (message.type === "worker.command") {
        void handleWorkerCommand(message.command).catch((err: unknown) =>
          logger.error(`worker.command ${message.command} failed`, err),
        );
        return;
      }
      runner.handle(message);
    },
    logger,
    ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
  });
  if (outbox.size > 0) logger.info(`${outbox.size} result(s) from a previous run will be resent`);
  runner.start();
  connection.start();

  const conn = connection;
  const unsubUsage = agent?.usage.onUpdate(() => sendUsage());
  const unsubClaude = agent?.onClaudeAccountChange((account) => {
    conn.send({ type: "worker.claude", account });
  });
  const unsubGemini = agent?.onGeminiAccountChange((account) => {
    conn.send({ type: "worker.gemini", account });
  });
  const unsubProviders = agent?.onProvidersChange((providers) => {
    conn.send({ type: "worker.providers", providers });
  });
  agent?.onHealthChange(() => {
    logger.info("agent health changed: re-announcing capabilities to the hub");
    conn.reannounce();
  });

  return {
    connection: conn,
    runner,
    get state() {
      return conn.state;
    },
    async shutdown() {
      unsubUsage?.();
      unsubClaude?.();
      unsubGemini?.();
      unsubProviders?.();
      await runner.shutdown(config.shutdownTimeoutMs);
      conn.stop();
      await agent?.stop();
    },
    stop() {
      unsubUsage?.();
      unsubClaude?.();
      unsubGemini?.();
      unsubProviders?.();
      runner.stop();
      conn.stop();
      void agent?.stop();
    },
  };
}
