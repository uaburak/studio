/**
 * End-to-end smoke check against a running local API (`pnpm dev`):
 * 1. starts a worker in-process and waits until it is connected to the hub,
 * 2. creates a demo.echo job through the real API (POST /api/jobs),
 * 3. polls the job until the worker has reported its result.
 * Needs STUDIO_WORKER_TOKEN (apps/worker/.env) matching WORKER_TOKEN (apps/api/.dev.vars); the
 * job calls use the same token (127.0.0.1 alone no longer counts as the Mac).
 * Exits 0 on success, 1 on failure/timeout.
 */
import { createApiClient } from "@studio/contract";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { MemoryOutbox } from "../src/outbox.ts";
import { startWorker } from "../src/worker.ts";

const config = loadConfig({ ...process.env, STUDIO_WORKER_ID: "smoke-test" });
const apiBase = config.hubUrl.replace(/^ws/, "http").replace(/\/api\/hub$/, "");
const api = createApiClient({
  baseUrl: apiBase,
  ...(config.token ? { workerToken: config.token } : {}),
});
const logger = createLogger("info");

function fail(message: string): never {
  logger.error(`SMOKE FAILED: ${message}`);
  process.exit(1);
}

if (!config.token) fail("STUDIO_WORKER_TOKEN is not set (see apps/worker/.env.example)");
const timeout = setTimeout(() => fail("timed out after 15s"), 15_000);

const connected = new Promise<void>((resolve) => {
  const worker = startWorker({
    config,
    logger,
    outbox: new MemoryOutbox(),
    onStateChange: (state) => state === "connected" && resolve(),
  });
  process.once("exit", () => worker.stop());
});
await connected;

const job = await api.jobs.create({ type: "demo.echo", payload: { text: "Merhaba Studio" } });
logger.info(`created job ${job.id} (status: ${job.status})`);

for (;;) {
  const current = await api.jobs.get(job.id);
  if (current.status === "succeeded") {
    logger.info(`job finished: ${JSON.stringify(current.output)}`);
    break;
  }
  if (current.status === "failed" || current.status === "cancelled") {
    fail(`job ${current.status}: ${current.error ?? ""}`);
  }
  await new Promise((r) => setTimeout(r, 100));
}

clearTimeout(timeout);
logger.info("SMOKE OK");
process.exit(0);
