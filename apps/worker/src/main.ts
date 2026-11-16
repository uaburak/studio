import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { startWorker, WORKER_VERSION } from "./worker.ts";

const config = loadConfig();
const logger = createLogger(config.logLevel);

if (!config.token) {
  logger.error(
    "STUDIO_WORKER_TOKEN is not set. Copy apps/worker/.env.example to apps/worker/.env and use the " +
      "same value as WORKER_TOKEN in apps/api/.dev.vars (or the deployed secret).",
  );
  process.exit(1);
}

logger.info(
  `studio worker ${WORKER_VERSION} (id: ${config.workerId}, concurrency: ${config.concurrency})`,
);
const worker = startWorker({ config, logger });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) {
    logger.warn(`${signal} again: exiting now`);
    process.exit(1);
  }
  stopping = true;
  logger.info(`${signal} received: handing back running jobs, then exiting`);
  // Hard cap in case something hangs; a second signal exits immediately.
  setTimeout(() => process.exit(1), config.shutdownTimeoutMs + 5000).unref();
  try {
    await worker.shutdown();
  } catch (error) {
    logger.error("shutdown failed", error);
  }
  // Give the close frame a moment to leave.
  setTimeout(() => process.exit(0), 200).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
