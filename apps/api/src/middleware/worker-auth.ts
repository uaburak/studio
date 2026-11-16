import type { MiddlewareHandler } from "hono";
import { authenticateWorker } from "../hub/auth.ts";
import type { AppEnv } from "../lib/router.ts";

/**
 * Guards the worker-facing turn API (`/api/worker/*`) with the same shared
 * secret and constant-time check as the worker WebSocket (`/api/hub`, see
 * hub/auth.ts). Answers like that route: 503 when no secret is configured,
 * 401 with `WWW-Authenticate: Bearer` otherwise (plain text: the contract
 * has no `unauthorized` error code yet).
 */
export const requireWorkerToken: MiddlewareHandler<AppEnv> = async (c, next) => {
  const auth = await authenticateWorker(c.env.WORKER_TOKEN, c.req.header("Authorization"));
  if (auth === "not_configured") {
    console.error("api: WORKER_TOKEN is not set; refusing worker requests");
    return c.text("worker authentication is not configured", 503);
  }
  if (auth === "denied") {
    return c.text("invalid or missing worker token", 401, { "WWW-Authenticate": "Bearer" });
  }
  await next();
};
