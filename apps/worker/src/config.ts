import { hostname } from "node:os";
import { z } from "zod";

/** Worker configuration, read from environment variables (see .env.example). */
const ConfigSchema = z.object({
  STUDIO_HUB_URL: z.url({ protocol: /^wss?$/ }).default("ws://127.0.0.1:8787/api/hub"),
  STUDIO_WORKER_ID: z.string().min(1).max(128).optional(),
  STUDIO_RECONNECT_BASE_MS: z.coerce.number().int().positive().default(500),
  STUDIO_RECONNECT_MAX_MS: z.coerce.number().int().positive().default(30_000),
  STUDIO_RECONNECT_JITTER: z.coerce.number().min(0).max(1).default(0.2),
  STUDIO_PING_INTERVAL_S: z.coerce.number().positive().default(25),
  STUDIO_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export interface WorkerConfig {
  hubUrl: string;
  workerId: string;
  backoff: { baseMs: number; maxMs: number; jitter: number };
  pingIntervalMs: number;
  logLevel: "debug" | "info" | "warn" | "error";
}

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
    workerId: c.STUDIO_WORKER_ID ?? hostname(),
    backoff: {
      baseMs: c.STUDIO_RECONNECT_BASE_MS,
      maxMs: Math.max(c.STUDIO_RECONNECT_MAX_MS, c.STUDIO_RECONNECT_BASE_MS),
      jitter: c.STUDIO_RECONNECT_JITTER,
    },
    pingIntervalMs: c.STUDIO_PING_INTERVAL_S * 1000,
    logLevel: c.STUDIO_LOG_LEVEL,
  };
}
