import { homedir, hostname } from "node:os";
import path from "node:path";
import { z } from "zod";

/** Worker configuration, read from environment variables (see .env.example). */
const ConfigSchema = z.object({
  STUDIO_HUB_URL: z.url({ protocol: /^wss?$/ }).default("ws://127.0.0.1:8787/api/hub"),
  /** Shared secret for the hub (must equal WORKER_TOKEN on the API side). */
  STUDIO_WORKER_TOKEN: z.string().min(1).optional(),
  STUDIO_WORKER_ID: z.string().min(1).max(128).optional(),
  STUDIO_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(1),
  STUDIO_HEARTBEAT_INTERVAL_S: z.coerce.number().positive().default(15),
  STUDIO_SHUTDOWN_TIMEOUT_S: z.coerce.number().positive().default(10),
  STUDIO_STATE_DIR: z.string().min(1).optional(),
  STUDIO_RECONNECT_BASE_MS: z.coerce.number().int().positive().default(500),
  STUDIO_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30_000),
  STUDIO_RECONNECT_JITTER: z.coerce.number().min(0).max(1).default(0.2),
  STUDIO_PING_INTERVAL_S: z.coerce.number().positive().default(25),
  STUDIO_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface WorkerConfig {
  hubUrl: string;
  /** Undefined when not configured; the hub then refuses the connection (main.ts exits early). */
  token: string | undefined;
  workerId: string;
  concurrency: number;
  heartbeatIntervalMs: number;
  shutdownTimeoutMs: number;
  /** Where the result outbox is kept between runs. */
  stateDir: string;
  backoff: { baseMs: number; maxMs: number; jitter: number };
  pingIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

export const DEFAULT_STATE_DIR = path.join(homedir(), ".studio", "worker");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  // Treat empty strings as "unset" so `FOO=` in a .env file falls back to defaults.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = ConfigSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid worker configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  return {
    hubUrl: c.STUDIO_HUB_URL,
    token: c.STUDIO_WORKER_TOKEN,
    workerId: c.STUDIO_WORKER_ID ?? hostname(),
    concurrency: c.STUDIO_CONCURRENCY,
    heartbeatIntervalMs: c.STUDIO_HEARTBEAT_INTERVAL_S * 1000,
    shutdownTimeoutMs: c.STUDIO_SHUTDOWN_TIMEOUT_S * 1000,
    stateDir: c.STUDIO_STATE_DIR ?? DEFAULT_STATE_DIR,
    backoff: {
      baseMs: c.STUDIO_RECONNECT_BASE_MS,
      maxMs: Math.max(c.STUDIO_RECONNECT_MAX_MS, c.STUDIO_RECONNECT_BASE_MS),
      jitter: c.STUDIO_RECONNECT_JITTER,
    },
    pingIntervalMs: c.STUDIO_PING_INTERVAL_S * 1000,
    logLevel: c.STUDIO_LOG_LEVEL,
  };
}
