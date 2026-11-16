import { createRoute } from "@hono/zod-openapi";
import { DemoEchoPayload, HealthResponse } from "@studio/contract";
import { sql } from "drizzle-orm";
import { createDb } from "./db/client.ts";
import { errorBody, handleError } from "./lib/errors.ts";
import { createRouter } from "./lib/router.ts";
import { cloudflareAccess } from "./middleware/access.ts";
import { assetRoutes } from "./routes/assets.ts";
import { brandProfileRoutes } from "./routes/brand-profiles.ts";
import { brandRoutes } from "./routes/brands.ts";
import { contentRoutes } from "./routes/contents.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { scheduleRoutes } from "./routes/schedules.ts";
import { socialAccountRoutes } from "./routes/social-accounts.ts";
import { API_VERSION } from "./version.ts";

const app = createRouter();

app.onError(handleError);
app.notFound((c) =>
  c.json(errorBody("not_found", `no route for ${c.req.method} ${c.req.path}`), 404),
);

// Authentication seam (no-op until Cloudflare Access is configured).
app.use("/api/*", cloudflareAccess);

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

// --- GET /api/openapi.json --------------------------------------------------

app.doc31("/api/openapi.json", {
  openapi: "3.1.0",
  info: { title: "Studio API", version: API_VERSION },
});

// --- GET /api/hub (WebSocket) -------------------------------------------------
// Mac worker connects here. NOTE: no auth yet; Cloudflare Access service
// tokens will guard this route before anything is deployed (PLAN.md §4).

app.get("/api/hub", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  return c.env.HUB.getByName("main").fetch(c.req.raw);
});

// --- /api/dev/* — local development helpers only ------------------------------

app.use("/api/dev/*", async (c, next) => {
  if (c.env.ENVIRONMENT !== "development") return c.notFound();
  await next();
});

app.post("/api/dev/jobs/demo", async (c) => {
  const parsed = DemoEchoPayload.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "body must be { text: string }" }, 400);
  const job = await c.env.HUB.getByName("main").enqueueDemoJob(parsed.data);
  return c.json(job, 202);
});

app.get("/api/dev/jobs/:id", async (c) => {
  const job = await c.env.HUB.getByName("main").getJob(c.req.param("id"));
  return job ? c.json(job) : c.json({ error: "not found" }, 404);
});

app.get("/api/dev/hub", async (c) => {
  const workers = await c.env.HUB.getByName("main").connectedWorkers();
  return c.json({ connectedWorkers: workers });
});

export { app };
