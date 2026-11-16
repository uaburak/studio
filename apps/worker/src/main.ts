import { loadAgentSettings } from "./agent.ts";
import { AgentRuntime } from "./agent-runtime.ts";
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
const settings = loadAgentSettings();
let agent: AgentRuntime | undefined;
if (settings.enabled) {
  agent = new AgentRuntime({ config, settings, logger });
  // Self-test before connecting, so the first `hello` announces only what can run.
  const health = await agent.start();
  if (health.state === "unauthenticated" || health.state === "error") {
    logger.error(
      "Claude job types (chat.turn, content.generate) are NOT announced until this is fixed; " +
        "such jobs wait in the queue. The worker re-checks every 5 minutes.",
    );
  }
} else {
  logger.warn("STUDIO_CLAUDE_ENABLED=0: running without the Claude-backed job types");
}
const worker = startWorker({ config, logger, ...(agent ? { agent } : {}) });

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
