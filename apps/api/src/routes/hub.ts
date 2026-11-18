import { createRoute } from "@hono/zod-openapi";
import {
  AiProvidersControl,
  ApiErrorBody,
  ClaudeControl,
  GeminiControl,
  WorkerPresence,
} from "@studio/contract";
import { authenticateWorker } from "../hub/auth.ts";
import { conflict } from "../lib/errors.ts";
import { createRouter, errors, json } from "../lib/router.ts";
import { requireLocal } from "../middleware/access.ts";
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

// --- The Mac's Claude sign-in (A5) ------------------------------------------------------------
// The worker reports `claude auth status` as `worker.claude` (also in presence as `claude`);
// the Mac app asks it to start `claude auth login` (the sign-in page opens in the Mac's
// browser) or to read the status again. The worker never sees a password.

hubRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/workers/claude",
    tags: ["Workers"],
    summary: "The Mac's Claude sign-in as the worker last reported it",
    responses: {
      200: json(ClaudeControl, "Latest report (account null until a worker sent one)."),
    },
  }),
  async (c) => {
    const result = ClaudeControl.parse(await hubStub(c.env).claudeControl());
    return c.json(result, 200);
  },
);

hubRoutes.use("/api/workers/claude/login", requireLocal);

hubRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/workers/claude/login",
    tags: ["Workers"],
    summary: "Start the Claude sign-in on the Mac (the Mac itself only)",
    description:
      "The worker runs `claude auth login --claudeai` in the background: the sign-in page opens in " +
      "the Mac's browser and the CLI waits for it (at most 10 minutes). Follow presence `claude` " +
      "(`signing_in`, then `signed_in`). 409 when no worker is connected.",
    responses: {
      200: json(ClaudeControl, "Sent to the connected worker(s)."),
      403: json(ApiErrorBody, "Not the Mac itself (`forbidden`)."),
      409: errors[409],
    },
  }),
  async (c) => {
    const result = ClaudeControl.parse(await hubStub(c.env).claudeControl("claude.login"));
    if (result.sent === 0) throw conflict("the Mac worker is not connected");
    return c.json(result, 200);
  },
);

hubRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/workers/claude/status",
    tags: ["Workers"],
    summary: "Ask the worker to read `claude auth status` again",
    description: "The answer arrives as presence `claude`. 409 when no worker is connected.",
    responses: {
      200: json(ClaudeControl, "Sent to the connected worker(s)."),
      409: errors[409],
    },
  }),
  async (c) => {
    const result = ClaudeControl.parse(await hubStub(c.env).claudeControl("claude.status"));
    if (result.sent === 0) throw conflict("the Mac worker is not connected");
    return c.json(result, 200);
  },
);

// --- The Mac's Gemini connection (A5) ---------------------------------------------------------

hubRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/workers/gemini",
    tags: ["Workers"],
    summary: "The Mac's Gemini API / CLI readiness as the worker last reported it",
    responses: {
      200: json(GeminiControl, "Latest report (account null until a worker sent one)."),
    },
  }),
  async (c) => {
    const result = GeminiControl.parse(await hubStub(c.env).geminiControl());
    return c.json(result, 200);
  },
);

hubRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/workers/gemini/status",
    tags: ["Workers"],
    summary: "Ask the worker to re-check Gemini API key and CLI readiness",
    description: "The answer arrives as presence `gemini`. 409 when no worker is connected.",
    responses: {
      200: json(GeminiControl, "Sent to the connected worker(s)."),
      409: errors[409],
    },
  }),
  async (c) => {
    const result = GeminiControl.parse(await hubStub(c.env).geminiControl("gemini.status"));
    if (result.sent === 0) throw conflict("the Mac worker is not connected");
    return c.json(result, 200);
  },
);

// --- The Mac's other AI providers (roadmap 7): Codex CLI, OpenAI API, Antigravity CLI ----------

hubRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/workers/providers",
    tags: ["Workers"],
    summary: "Codex CLI, OpenAI API and Antigravity CLI as the worker last reported them",
    responses: { 200: json(AiProvidersControl, "Latest report (empty until a worker sent one).") },
  }),
  async (c) => {
    const result = AiProvidersControl.parse(await hubStub(c.env).providersControl());
    return c.json(result, 200);
  },
);

hubRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/workers/providers/status",
    tags: ["Workers"],
    summary: "Ask the worker to re-check Codex, OpenAI and Antigravity",
    description: "The answer arrives as presence `providers`. 409 when no worker is connected.",
    responses: {
      200: json(AiProvidersControl, "Sent to the connected worker(s)."),
      409: errors[409],
    },
  }),
  async (c) => {
    const result = AiProvidersControl.parse(
      await hubStub(c.env).providersControl("providers.status"),
    );
    if (result.sent === 0) throw conflict("the Mac worker is not connected");
    return c.json(result, 200);
  },
);

hubRoutes.use("/api/workers/codex/login", requireLocal);

hubRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/workers/codex/login",
    tags: ["Workers"],
    summary: "Start the Codex CLI sign-in (ChatGPT account) on the Mac (the Mac itself only)",
    description:
      "The worker runs `codex login` in the background: the sign-in page opens in the Mac's " +
      "browser and the CLI waits for it (at most 10 minutes). Follow presence `providers` " +
      "(`codex`: `signing_in`, then `ready`). 409 when no worker is connected.",
    responses: {
      200: json(AiProvidersControl, "Sent to the connected worker(s)."),
      403: json(ApiErrorBody, "Not the Mac itself (`forbidden`)."),
      409: errors[409],
    },
  }),
  async (c) => {
    const result = AiProvidersControl.parse(await hubStub(c.env).providersControl("codex.login"));
    if (result.sent === 0) throw conflict("the Mac worker is not connected");
    return c.json(result, 200);
  },
);

hubRoutes.use("/api/workers/antigravity/login", requireLocal);

hubRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/workers/antigravity/login",
    tags: ["Workers"],
    summary: "Start the Antigravity CLI sign-in (Google account) on the Mac (the Mac itself only)",
    description:
      "The worker runs `agy acp --login` in the background (sign-in page in the Mac's browser, " +
      "at most 10 minutes). Follow presence `providers` (`antigravity`). 409 when no worker is connected.",
    responses: {
      200: json(AiProvidersControl, "Sent to the connected worker(s)."),
      403: json(ApiErrorBody, "Not the Mac itself (`forbidden`)."),
      409: errors[409],
    },
  }),
  async (c) => {
    const result = AiProvidersControl.parse(
      await hubStub(c.env).providersControl("antigravity.login"),
    );
    if (result.sent === 0) throw conflict("the Mac worker is not connected");
    return c.json(result, 200);
  },
);
