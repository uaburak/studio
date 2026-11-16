import path from "node:path";
import type { WorkerConfig } from "./config.ts";
import { type ConnectionState, HubConnection } from "./connection.ts";
import { demoEcho } from "./jobs/demo-echo.ts";
import type { Logger } from "./log.ts";
import { FileOutbox, type Outbox } from "./outbox.ts";
import { JobRegistry } from "./registry.ts";
import { JobRunner } from "./runner.ts";
import { nodeSocketFactory, type SocketFactory } from "./socket.ts";

export const WORKER_VERSION = "0.0.0";

/** The job types this worker can run. Real generation handlers arrive with F1-3 / F1-4. */
export function createDefaultRegistry(): JobRegistry {
  return new JobRegistry().register("demo.echo", demoEcho);
}

export interface StartWorkerOptions {
  config: WorkerConfig;
  logger: Logger;
  socketFactory?: SocketFactory;
  registry?: JobRegistry;
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
  const registry = options.registry ?? createDefaultRegistry();
  const outbox = options.outbox ?? new FileOutbox(path.join(config.stateDir, "outbox.json"));
  let connection: HubConnection | undefined;

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
    workerVersion: WORKER_VERSION,
    capabilities: registry.types(),
    backoff: config.backoff,
    pingIntervalMs: config.pingIntervalMs,
    socketFactory: options.socketFactory ?? nodeSocketFactory,
    helloFields: () => runner.helloFields(),
    onReady: () => runner.onConnected(),
    onMessage: (message) => runner.handle(message),
    logger,
    ...(options.onStateChange ? { onStateChange: options.onStateChange } : {}),
  });
  if (outbox.size > 0) logger.info(`${outbox.size} result(s) from a previous run will be resent`);
  runner.start();
  connection.start();

  const conn = connection;
  return {
    connection: conn,
    runner,
    get state() {
      return conn.state;
    },
    async shutdown() {
      await runner.shutdown(config.shutdownTimeoutMs);
      conn.stop();
    },
    stop() {
      runner.stop();
      conn.stop();
    },
  };
}
