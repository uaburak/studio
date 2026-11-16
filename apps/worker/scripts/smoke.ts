/**
 * End-to-end smoke check against a running local API (`pnpm dev`):
 * 1. starts a worker in-process and waits until it is connected to the hub,
 * 2. asks the API to enqueue a demo.echo job (/api/dev/jobs/demo),
 * 3. polls the job until the worker has reported its result.
 * Exits 0 on success, 1 on failure/timeout.
 */
import type { Job } from "@studio/contract";
import { loadConfig } from "../src/config.ts";
import { createLogger } from "../src/log.ts";
import { startWorker } from "../src/worker.ts";

const config = loadConfig({ ...process.env, STUDIO_WORKER_ID: "smoke-test" });
const apiBase = config.hubUrl.replace(/^ws/, "http").replace(/\/api\/hub$/, "");
const logger = createLogger("info");

function fail(message: string): never {
  logger.error(`SMOKE FAILED: ${message}`);
  process.exit(1);
}

const timeout = setTimeout(() => fail("timed out after 15s"), 15_000);

const connected = new Promise<void>((resolve) => {
  const connection = startWorker({
    config,
    logger,
    onStateChange: (state) => state === "connected" && resolve(),
  });
  process.once("exit", () => connection.stop());
});
await connected;
// Let the hub process our `hello` before enqueuing.
await new Promise((r) => setTimeout(r, 200));

const created = await fetch(`${apiBase}/api/dev/jobs/demo`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: "Merhaba Studio" }),
});
if (created.status !== 202) fail(`enqueue returned HTTP ${created.status}`);
const job = (await created.json()) as Job;
logger.info(`enqueued job ${job.id} (status: ${job.status})`);

for (;;) {
  const res = await fetch(`${apiBase}/api/dev/jobs/${job.id}`);
  const current = (await res.json()) as Job;
  if (current.status === "succeeded") {
    logger.info(`job finished: ${JSON.stringify(current.output)}`);
    break;
  }
  if (current.status === "failed") fail(`job failed: ${current.error}`);
  await new Promise((r) => setTimeout(r, 100));
}

clearTimeout(timeout);
logger.info("SMOKE OK");
process.exit(0);
