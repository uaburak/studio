import { createRoute } from "@hono/zod-openapi";
import { WorkerPresence } from "@studio/contract";
import { authenticateWorker } from "../hub/auth.ts";
import { createRouter, json } from "../lib/router.ts";
import { hubStub } from "./jobs.ts";

export const hubRoutes = createRouter();

// --- GET /api/hub (WebSocket) — the Mac worker connects here ------------------
// Shared-secret auth (hub/auth.ts); Cloudflare Access service tokens will wrap
// or replace it before anything is deployed (PLAN.md §4).

hubRoutes.get("/api/hub", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  const auth = await authenticateWorker(c.env.WORKER_TOKEN, c.req.header("Authorization"));
  if (auth === "not_configured") {
    console.error("api: WORKER_TOKEN is not set; refusing worker connections");
    return c.text("worker authentication is not configured", 503);
  }
  if (auth === "denied") {
    // Plain text like the 426 above: the contract has no `unauthorized` error
    // code yet, and only the worker (not a JSON client) talks to this route.
    return c.text("invalid or missing worker token", 401, { "WWW-Authenticate": "Bearer" });
  }
  return hubStub(c.env).fetch("https://hub.internal/worker", { headers: c.req.raw.headers });
});

// --- GET /api/workers/presence -------------------------------------------------

hubRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/workers/presence",
    tags: ["Workers"],
    summary: "Is the Mac worker online?",
    description:
      "Online/offline, last seen, the jobs running now and the queue length. The same object is " +
      "pushed as `presence` frames on /api/jobs/stream.",
    responses: { 200: json(WorkerPresence, "Current presence.") },
  }),
  async (c) => {
    const presence = WorkerPresence.parse(await hubStub(c.env).presence());
    return c.json(presence, 200);
  },
);
