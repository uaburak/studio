import { env, exports } from "cloudflare:workers";
import {
  AgentEffort,
  AssetKind,
  AssetSource,
  BrandProfileStatus,
  BrandStatus,
  ContentStatus,
  ContentType,
  ContentVersionOrigin,
  decodeMessage,
  encodeMessage,
  HealthResponse,
  type Job,
  JobStatus,
  Platform,
  PublishLogStatus,
  ScheduleStatus,
  SocialAccountStatus,
  TokenHealthStatus,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import { ENUMS } from "../src/db/schema.ts";
import * as entry from "../src/index.ts";
import { LATEST_MIGRATION } from "../src/lib/health.ts";
import { BASE, localFetch } from "./helpers.ts";

describe("worker entry module", () => {
  // workerd refuses to start if the entry exports anything that is not a
  // handler or Durable Object class (the Vitest plugin does not catch this).
  it("exports only the fetch handler and Durable Object classes", () => {
    expect(Object.keys(entry).sort()).toEqual(["Hub", "default"]);
  });
});

describe("GET /api/health", () => {
  it("returns a contract-valid healthy response", async () => {
    const res = await localFetch(`${BASE}/api/health`);
    expect(res.status).toBe(200);
    const body = HealthResponse.parse(await res.json());
    expect(body.status).toBe("ok");
    expect(body.checks.db).toBe("ok");
  });

  it("reports every part of the host to the Mac itself (P9)", async () => {
    const res = await localFetch(`${BASE}/api/health`);
    const body = HealthResponse.parse(await res.json());
    const byId = Object.fromEntries((body.components ?? []).map((c) => [c.id, c]));
    expect(Object.keys(byId).sort()).toEqual(
      ["canvas", "cloud", "db", "migrations", "storage", "tunnel", "vault", "worker"].sort(),
    );
    expect(byId.db?.state).toBe("ok");
    expect(byId.storage?.state).toBe("ok");
    expect(byId.migrations?.state).toBe("ok");
    expect(body.migrations?.last).toBe(LATEST_MIGRATION);
    expect(byId.vault?.state).toBe("ok");
    // No worker in the test runtime: the Mac sees it, with a Turkish label.
    expect(byId.worker?.state).toBe("fail");
    expect(byId.worker?.label).toBe("Worker");
    expect(byId.tunnel?.state).toBe("ok");
  });

  it("gives anonymous callers the summary only", async () => {
    const res = await exports.default.fetch(`${BASE}/api/health`, {
      headers: { "CF-Connecting-IP": "192.168.1.50" },
    });
    const body = HealthResponse.parse(await res.json());
    expect(body.status).toBe("ok");
    expect(body.components).toBeUndefined();
    expect(body.migrations).toBeUndefined();
  });

  it("knows the last migration this build ships", () => {
    const files = env.TEST_MIGRATIONS.map((m) => m.name).sort();
    expect(files.at(-1)).toBe(LATEST_MIGRATION);
  });
});

describe("GET /api/openapi.json", () => {
  it("documents the health route with the contract schema", async () => {
    const res = await localFetch(`${BASE}/api/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components?: { schemas?: Record<string, unknown> };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.paths).toHaveProperty("/api/health");
    expect(doc.components?.schemas).toHaveProperty("HealthResponse");
  });
});

describe("D1 + Drizzle", () => {
  it("has the initial migration applied", async () => {
    const row = await env.DB.prepare(
      "select name from sqlite_master where type = 'table' and name = 'app_meta'",
    ).first<{ name: string }>();
    expect(row?.name).toBe("app_meta");
  });

  it("has the core model tables", async () => {
    const { results } = await env.DB.prepare(
      "select name from sqlite_master where type = 'table' order by name",
    ).all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        "brands",
        "social_accounts",
        "brand_profiles",
        "assets",
        "contents",
        "content_versions",
        "content_version_slides",
        "jobs",
        "schedules",
        "publish_logs",
      ]),
    );
  });

  it("enforces foreign keys", async () => {
    await expect(
      env.DB.prepare(
        "insert into social_accounts (id, brand_id, platform, handle, status, created_at, updated_at) values ('x', 'no-such-brand', 'instagram', 'h', 'pending', 0, 0)",
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("keeps CHECK enums in sync with the contract", () => {
    const pairs: Array<[readonly string[], readonly string[]]> = [
      [ENUMS.brandStatus, BrandStatus.options],
      [ENUMS.platform, Platform.options],
      [ENUMS.socialAccountStatus, SocialAccountStatus.options],
      [ENUMS.brandProfileStatus, BrandProfileStatus.options],
      [ENUMS.assetKind, AssetKind.options],
      [ENUMS.assetSource, AssetSource.options],
      [ENUMS.contentType, ContentType.options],
      [ENUMS.contentStatus, ContentStatus.options],
      [ENUMS.versionOrigin, ContentVersionOrigin.options],
      [ENUMS.jobStatus, JobStatus.options],
      [ENUMS.scheduleStatus, ScheduleStatus.options],
      [ENUMS.publishLogStatus, PublishLogStatus.options],
      [ENUMS.agentEffort, AgentEffort.options],
      [ENUMS.tokenHealth, TokenHealthStatus.options],
    ];
    for (const [db, contract] of pairs) expect([...db]).toEqual([...contract]);
  });
});

describe("OpenAPI document", () => {
  it("documents the core resources with contract schemas", async () => {
    const res = await localFetch(`${BASE}/api/openapi.json`);
    const doc = (await res.json()) as {
      paths: Record<string, Record<string, unknown>>;
      components?: { schemas?: Record<string, unknown> };
    };
    for (const path of [
      "/api/brands",
      "/api/brands/{id}",
      "/api/brands/{brandId}/profiles",
      "/api/brands/{brandId}/profiles/current",
      "/api/brands/{brandId}/profiles/{version}/approve",
      "/api/social-accounts",
      "/api/assets",
      "/api/assets/{id}/content",
      "/api/contents",
      "/api/contents/{id}/approve",
      "/api/contents/{id}/transition",
      "/api/contents/{id}/versions",
      "/api/contents/{id}/versions/{version}",
      "/api/jobs",
      "/api/schedules",
      "/api/schedules/{id}/cancel",
      "/api/schedules/{id}/logs",
    ]) {
      expect(doc.paths, path).toHaveProperty([path]);
    }
    expect(doc.paths["/api/assets"]).toHaveProperty("post");
    expect(doc.components?.schemas).toHaveProperty("ApiErrorBody");
    expect(doc.components?.schemas).toHaveProperty("Content");
    expect(doc.components?.schemas).toHaveProperty("ContentVersion");
  });
});

/** Open a WebSocket to the hub through the Worker and collect decoded frames. */
async function connectHub() {
  const res = await localFetch(`${BASE}/api/hub`, {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${env.WORKER_TOKEN}` },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("no webSocket on response");
  ws.accept();
  const inbox: unknown[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener("message", (event) => {
    const decoded = decodeMessage(event.data);
    inbox.push(decoded.ok ? decoded.message : decoded);
    for (const wake of waiters.splice(0)) wake();
  });
  async function next(): Promise<unknown> {
    while (inbox.length === 0) await new Promise<void>((r) => waiters.push(r));
    return inbox.shift();
  }
  return { ws, next };
}

describe("Hub Durable Object", () => {
  it("rejects non-upgrade requests", async () => {
    const res = await localFetch(`${BASE}/api/hub`);
    expect(res.status).toBe(426);
  });

  it("answers protocol ping with pong", async () => {
    const { ws, next } = await connectHub();
    ws.send(encodeMessage({ type: "ping", ts: 42 }));
    expect(await next()).toEqual({ type: "pong", ts: 42 });
    ws.close(1000, "done");
  });

  it("dispatches a demo job to a connected worker and records the result", async () => {
    const { ws, next } = await connectHub();
    ws.send(
      encodeMessage({
        type: "hello",
        protocolVersion: 1,
        workerId: "test-worker",
        capabilities: ["demo.echo"],
      }),
    );

    const created = await localFetch(`${BASE}/api/dev/jobs/demo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "merhaba" }),
    });
    expect(created.status).toBe(202);
    const job = (await created.json()) as Job;

    const dispatch = (await next()) as { type: string; job: Job };
    expect(dispatch.type).toBe("job.dispatch");
    expect(dispatch.job.id).toBe(job.id);

    ws.send(encodeMessage({ type: "job.progress", jobId: job.id, progress: 0.5 }));
    ws.send(
      encodeMessage({
        type: "job.result",
        jobId: job.id,
        status: "succeeded",
        output: { text: "merhaba" },
      }),
    );
    // F1-6: the hub acknowledges every result so the worker can drop it from its outbox.
    expect(await next()).toEqual({ type: "job.result.ack", jobId: job.id });
    // Round-trip a ping so we know the hub processed the frames above.
    ws.send(encodeMessage({ type: "ping", ts: 1 }));
    expect(await next()).toEqual({ type: "pong", ts: 1 });

    const res = await localFetch(`${BASE}/api/dev/jobs/${job.id}`);
    const finished = (await res.json()) as Job;
    expect(finished.status).toBe("succeeded");
    expect(finished.output).toEqual({ text: "merhaba" });
    ws.close(1000, "done");
  });
});
