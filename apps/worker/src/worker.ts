import type { WorkerConfig } from "./config.ts";
import { type ConnectionState, HubConnection } from "./connection.ts";
import { capabilitiesOf, createMessageHandler, type JobHandler } from "./handler.ts";
import { demoEcho } from "./jobs/demo-echo.ts";
import type { Logger } from "./log.ts";
import { nodeSocketFactory, type SocketFactory } from "./socket.ts";

export const WORKER_VERSION = "0.0.0";

export const defaultHandlers: Partial<Record<string, JobHandler>> = {
  "demo.echo": demoEcho,
};

export interface StartWorkerOptions {
  config: WorkerConfig;
  logger: Logger;
  socketFactory?: SocketFactory;
  onStateChange?: (state: ConnectionState) => void;
}

/** Wire config + handlers + hub connection together and start connecting. */
export function startWorker({ config, logger, socketFactory, onStateChange }: StartWorkerOptions) {
  const handlers = defaultHandlers;
  let connection: HubConnection | undefined;

  const handle = createMessageHandler({
    workerId: config.workerId,
    handlers,
    logger,
    send: (message) => {
      if (!connection?.send(message)) {
        logger.warn(`not connected; dropped outgoing ${message.type}`);
      }
    },
  });

  connection = new HubConnection({
    url: config.hubUrl,
    workerId: config.workerId,
    workerVersion: WORKER_VERSION,
    capabilities: capabilitiesOf(handlers),
    backoff: config.backoff,
    pingIntervalMs: config.pingIntervalMs,
    socketFactory: socketFactory ?? nodeSocketFactory,
    onMessage: handle,
    logger,
    ...(onStateChange ? { onStateChange } : {}),
  });
  connection.start();
  return connection;
}
