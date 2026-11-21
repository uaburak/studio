// The tools Studio uses on the Mac (ffmpeg, Claude Code, Python …): their status as the worker
// reported it (`worker.tools`, also presence `tools`) and the jobs that install / remove them on
// the Mac from their official sources (`tool.install`, `tool.uninstall`; contract tools.ts).
// Callable from the Mac app, the iPhone and the chat agent alike: the work always runs on the Mac.
import { createRoute, z } from "@hono/zod-openapi";
import {
  Job,
  ToolId,
  ToolInstallRequest,
  type ToolStatus,
  ToolsControl,
  toolManifest,
} from "@studio/contract";
import { and, inArray } from "drizzle-orm";
import { createDb } from "../db/client.ts";
import { toJob } from "../db/mappers.ts";
import { jobs } from "../db/schema.ts";
import { conflict } from "../lib/errors.ts";
import { createRouter, errors, json, jsonBody } from "../lib/router.ts";
import { createJob, hubStub } from "./jobs.ts";

const tags = ["Tools"];
const ToolParams = z.object({ id: ToolId });

export const toolRoutes = createRouter();

/** A tool job of this tool that is queued or running (a second click returns it). */
async function activeToolJob(env: Env, toolId: string): Promise<Job | null> {
  const db = createDb(env.DB);
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        inArray(jobs.type, ["tool.install", "tool.uninstall"]),
        inArray(jobs.status, ["queued", "running"]),
      ),
    );
  const row = rows.find((r) => r.payload.toolId === toolId);
  return row ? toJob(row) : null;
}

async function reported(env: Env, id: string): Promise<ToolStatus | null> {
  const control = ToolsControl.parse(await hubStub(env).toolsControl());
  return control.tools.find((t) => t.id === id) ?? null;
}

toolRoutes.openapi(
  createRoute({
    method: "get",
    path: "/api/tools",
    tags,
    summary: "The tools Studio uses on the Mac, as the worker last reported them",
    description:
      "One row per tool (ffmpeg, Claude Code, Gemini CLI, Chromium, Python, cloudflared, " +
      "whisper.cpp): state, version, path, Studio's own copy or the Mac's, source and size. " +
      "The same list arrives live as presence `tools` on /api/jobs/stream. Empty until a worker " +
      "reported it.",
    responses: { 200: json(ToolsControl, "Latest report.") },
  }),
  async (c) => c.json(ToolsControl.parse(await hubStub(c.env).toolsControl()), 200),
);

toolRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/tools/refresh",
    tags,
    summary: "Ask the worker to look for the tools again",
    description: "The answer arrives as presence `tools`. 409 when no worker is connected.",
    responses: { 200: json(ToolsControl, "Sent to the connected worker(s)."), 409: errors[409] },
  }),
  async (c) => {
    const result = ToolsControl.parse(await hubStub(c.env).toolsControl(true));
    if (result.sent === 0) throw conflict("the Mac worker is not connected");
    return c.json(result, 200);
  },
);

toolRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/tools/{id}/install",
    tags,
    summary: "Install (or update) a tool on the Mac from its official source",
    description:
      "Queues a `tool.install` job (follow it on /api/jobs/stream; presence `tools` shows the " +
      "progress). The download is verified (SHA-256 / npm integrity / Developer ID signature) " +
      "before anything is unpacked. A tool the Mac already has (`location: system`) is never " +
      "installed over (409), nor one that cannot be installed in the app (409). A second " +
      "request while one runs returns the running job.",
    request: {
      params: ToolParams,
      body: { ...jsonBody(ToolInstallRequest), required: false },
    },
    responses: {
      202: json(Job, "The install job (queued or already running)."),
      400: errors[400],
      409: errors[409],
    },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const body = (c.req.valid("json") as ToolInstallRequest | undefined) ?? {};
    const running = await activeToolJob(c.env, id);
    if (running) return c.json(running, 202);
    const manifest = toolManifest(id);
    const status = await reported(c.env, id);
    if (status) {
      if (!status.installable) {
        throw conflict(status.note ?? `${manifest.label} cannot be installed in the app`);
      }
      if (status.location === "system" && status.state === "installed") {
        throw conflict(`${manifest.label} is already installed on the Mac (${status.path})`);
      }
      if (status.location === "studio" && status.state === "installed" && !body.update) {
        throw conflict(`${manifest.label} is already installed; send { "update": true } to update`);
      }
    } else if (manifest.kind === "none" && !manifest.extra) {
      throw conflict(manifest.note ?? `${manifest.label} cannot be installed in the app`);
    }
    const job = await createJob(c.env, {
      type: "tool.install",
      payload: { toolId: id, ...(body.update ? { update: true } : {}) },
      maxAttempts: 1,
    });
    return c.json(job, 202);
  },
);

toolRoutes.openapi(
  createRoute({
    method: "post",
    path: "/api/tools/{id}/uninstall",
    tags,
    summary: "Remove Studio's own copy of a tool",
    description:
      "Queues a `tool.uninstall` job. A copy the Mac already had (Homebrew, PATH) is never " +
      "touched: 409 when Studio has no copy of its own.",
    request: { params: ToolParams },
    responses: { 202: json(Job, "The uninstall job."), 409: errors[409] },
  }),
  async (c) => {
    const { id } = c.req.valid("param");
    const running = await activeToolJob(c.env, id);
    if (running) {
      if (running.type === "tool.uninstall") return c.json(running, 202);
      throw conflict(`${toolManifest(id).label} is being installed`);
    }
    const status = await reported(c.env, id);
    if (status && !status.removable) {
      throw conflict(`Studio has no copy of ${toolManifest(id).label} to remove`);
    }
    const job = await createJob(c.env, {
      type: "tool.uninstall",
      payload: { toolId: id },
      maxAttempts: 1,
    });
    return c.json(job, 202);
  },
);
