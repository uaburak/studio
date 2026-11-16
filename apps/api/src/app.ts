import { createRoute } from "@hono/zod-openapi";
import { DemoEchoPayload, HealthResponse } from "@studio/contract";
import { eq, sql } from "drizzle-orm";
import { createDb } from "./db/client.ts";
import { toJob } from "./db/mappers.ts";
import { jobs } from "./db/schema.ts";
import { errorBody, handleError } from "./lib/errors.ts";
import { createRouter } from "./lib/router.ts";
import { accessControl } from "./middleware/access.ts";
import { assetRoutes } from "./routes/assets.ts";
import { brandProfileRoutes } from "./routes/brand-profiles.ts";
import { brandRoutes } from "./routes/brands.ts";
import { contentRoutes } from "./routes/contents.ts";
import { conversationRoutes } from "./routes/conversations.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { hubRoutes } from "./routes/hub.ts";
import { createJob, hubStub, jobRoutes } from "./routes/jobs.ts";
import { agentRunRoutes, planRoutes } from "./routes/plans.ts";
import { scheduleRoutes } from "./routes/schedules.ts";
import { socialAccountRoutes } from "./routes/social-accounts.ts";
import { workerRunRoutes } from "./routes/worker-runs.ts";
import { workerScheduleRoutes } from "./routes/worker-schedules.ts";
import { API_VERSION } from "./version.ts";

const app = createRouter();

app.onError(handleError);
app.notFound((c) =>
  c.json(errorBody("not_found", `no route for ${c.req.method} ${c.req.path}`), 404),
);

// Authentication seam: local Mac, worker token or paired device (middleware/access.ts).
app.use("/api/*", accessControl);

// --- GET /api/health --------------------------------------------------------

const healthRoute = createRoute({
  method: "get",
  path: "/api/health",
  tags: ["System"],
  summary: "Health check",
  responses: {
    200: {
      description: "Service is reachable.",
      content: { "application/json": { schema: HealthResponse } },
    },
  },
});

app.openapi(healthRoute, async (c) => {
  let db: "ok" | "error" = "ok";
  try {
    await createDb(c.env.DB).run(sql`select 1`);
  } catch {
    db = "error";
  }
  // Validate our own output against the shared contract before sending it.
  const body = HealthResponse.parse({
    status: db === "ok" ? "ok" : "degraded",
    service: "studio-api",
    version: API_VERSION,
    time: new Date().toISOString(),
    checks: { db },
    ...(c.env.STUDIO_INSTANCE_ID ? { instance: c.env.STUDIO_INSTANCE_ID } : {}),
  });
  return c.json(body, 200);
});

// --- Core resources (F1-1) ------------------------------------------------------

app.route("/", brandRoutes);
app.route("/", brandProfileRoutes);
app.route("/", socialAccountRoutes);
app.route("/", assetRoutes);
app.route("/", contentRoutes);
app.route("/", jobRoutes);
app.route("/", scheduleRoutes);
app.route("/", hubRoutes); // /api/hub (worker WebSocket), /api/workers/presence

// --- Chat (A2): conversations, agent runs, plans, the worker's turn API -------------

app.route("/", conversationRoutes);
app.route("/", agentRunRoutes);
app.route("/", planRoutes);
app.route("/", workerRunRoutes); // /api/worker/* (worker token)
app.route("/", workerScheduleRoutes); // /api/worker/schedules/* (worker token)

// --- Devices (L1): pairing and paired-device management --------------------------

app.route("/", deviceRoutes);

// --- GET /api/openapi.json --------------------------------------------------

app.doc31("/api/openapi.json", {
  openapi: "3.1.0",
  info: { title: "Studio API", version: API_VERSION },
});

// --- /api/dev/* — local development helpers only ------------------------------
// Thin aliases over the real job path (D1 + Hub), kept for quick manual tests.
// Prefer POST /api/jobs and GET /api/jobs/{id}.

app.use("/api/dev/*", async (c, next) => {
  if (c.env.ENVIRONMENT !== "development") return c.notFound();
  await next();
});

app.post("/api/dev/jobs/demo", async (c) => {
  const parsed = DemoEchoPayload.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "body must be { text: string }" }, 400);
  const job = await createJob(c.env, { type: "demo.echo", payload: parsed.data });
  return c.json(job, 202);
});

app.get("/api/dev/jobs/:id", async (c) => {
  const row = await createDb(c.env.DB).query.jobs.findFirst({
    where: eq(jobs.id, c.req.param("id")),
  });
  return row ? c.json(toJob(row)) : c.json({ error: "not found" }, 404);
});

app.get("/api/dev/hub", async (c) => {
  const workers = await hubStub(c.env).connectedWorkers();
  return c.json({ connectedWorkers: workers });
});

export { app };
