import path from "node:path";
import type { AgentRuntime } from "./agent-runtime.ts";
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
 * `content.generate` when an agent runtime (headless Claude) is given.
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
   * Claude-backed handlers. Its health decides which job types are announced; on a
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
  const claudeTypes = new Set(["chat.turn", "content.generate"]);
  const baseTypes = registry.types().filter((t) => !agent || !claudeTypes.has(t));
  const outbox = options.outbox ?? new FileOutbox(path.join(config.stateDir, "outbox.json"));
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
      sendUsage();
    },
    onMessage: (message) => runner.handle(message),
    logger,
    ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
  });
  if (outbox.size > 0) logger.info(`${outbox.size} result(s) from a previous run will be resent`);
  runner.start();
  connection.start();

  const conn = connection;
  agent?.usage.onUpdate(() => sendUsage());
  agent?.onHealthChange(() => {
    logger.info("claude health changed: re-announcing capabilities to the hub");
    conn.reannounce();
  });
  return {
    connection: conn,
    runner,
    get state() {
      return conn.state;
    },
    async shutdown() {
      await runner.shutdown(config.shutdownTimeoutMs);
      conn.stop();
      await agent?.stop();
    },
    stop() {
      runner.stop();
      conn.stop();
      void agent?.stop();
    },
  };
}
