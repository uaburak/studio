import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { startWorker, WORKER_VERSION } from "./worker.ts";

const config = loadConfig();
const logger = createLogger(config.logLevel);

logger.info(`studio worker ${WORKER_VERSION} (id: ${config.workerId})`);
const connection = startWorker({ config, logger });

function shutdown(signal: string) {
  logger.info(`${signal} received, shutting down`);
  connection.stop();
  // Give the close frame a moment, then exit even if something lingers.
  setTimeout(() => process.exit(0), 1000).unref();
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
