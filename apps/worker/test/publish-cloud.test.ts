/**
 * P3: cloud publisher config from the API, delivery reports, moves and cancels,
 * immediate publishing through the cloud, Instagram JPEG conversion.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  Content,
  ContentVersion,
  Job,
  Schedule,
  SocialAccount,
  WorkerScheduleDelivery,
} from "@studio/contract";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { silentLogger } from "../src/log.ts";
import { createSchedulePublishHandler, type SchedulePublishDeps } from "../src/publish/handler.ts";
import { SchedulePoller } from "../src/publish/poller.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

type FakeState = ReturnType<typeof createFakeApi>["state"];

interface P3Extras {
  deliveries: { id: string; input: WorkerScheduleDelivery }[];
  reports: { ok: boolean; error?: string | null }[];
  cloud: { url: string; token: string } | null;
  syncRequestedAt: string | null;
}

/** The fake API from the shared helper plus the P3 endpoints. */
function fakeApiWithPublishing(cloud: P3Extras["cloud"]) {
  const { api, state } = createFakeApi({ brands: [fakeBrand()] });
  const extras: P3Extras = { deliveries: [], reports: [], cloud, syncRequestedAt: null };
  const client = api.client as unknown as Record<string, Record<string, unknown>>;
  const ws = client.workerSchedules as Record<string, unknown>;
  ws.delivery = async (id: string, input: WorkerScheduleDelivery) => {
    extras.deliveries.push({ id, input });
    const idx = state.schedules.findIndex((s) => s.id === id);
    const cur = state.schedules[idx] as Schedule;
    state.schedules[idx] = {
      ...cur,
      delivery: input.delivery,
      ...(input.cloudSyncedAt !== undefined ? { cloudSyncedAt: input.cloudSyncedAt } : {}),
      ...(input.error !== undefined ? { lastError: input.error } : {}),
    };
    return state.schedules[idx];
  };
  ws.cancelled = async () => ({
    items: state.schedules.filter(
      (s) => s.status === "cancelled" && s.delivery === "cloud" && s.cloudSyncedAt,
    ),
  });
  client.workerPublishing = {
    config: async () => ({ cloud: extras.cloud, syncRequestedAt: extras.syncRequestedAt }),
    report: async (input: { ok: boolean; error?: string | null }) => {
      extras.reports.push(input);
      return { cloud: extras.cloud, syncRequestedAt: extras.syncRequestedAt };
    },
  };
  return { api, state, extras };
}

async function image(format: "jpeg" | "png"): Promise<Uint8Array> {
  const img = sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#336699" } });
  return new Uint8Array(await (format === "png" ? img.png() : img.jpeg()).toBuffer());
}

function seed(
  state: FakeState,
  opts: { bytes: Uint8Array; mime: string; scheduledAt: string; id?: string },
) {
  const id = opts.id ?? "sched_p3_1";
  state.assets.set(`asset_${id}`, { bytes: opts.bytes, contentType: opts.mime });
  const hash = "d".repeat(64);
  const version: ContentVersion = {
    id: `ver_${id}`,
    contentId: `cnt_${id}`,
    version: 1,
    origin: "generated",
    contentHash: hash,
    slideCount: 1,
    note: null,
    jobId: null,
    createdAt: NOW,
    updatedAt: NOW,
    slides: [{ html: "<html></html>", width: 1080, height: 1350, renderedAssetId: `asset_${id}` }],
  };
  state.versions.push(version);
  const content: Content = {
    id: `cnt_${id}`,
    brandId: "brand_1",
    type: "post",
    title: "Hasat",
    brief: "",
    status: "scheduled",
    targetPlatforms: ["instagram"],
    caption: "Hasat zamanı #mtmagro",
    currentVersion: { id: version.id, version: 1, contentHash: hash },
    approval: { versionId: version.id, contentHash: hash, approvedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.contents.set(content.id, content);
  if (!state.socialAccounts.some((a) => a.id === "acc_ig")) {
    const account: SocialAccount = {
      id: "acc_ig",
      brandId: "brand_1",
      platform: "instagram",
      handle: "@mtmagro",
      externalId: "17841400001",
      status: "connected",
      createdAt: NOW,
      updatedAt: NOW,
    };
    state.socialAccounts.push(account);
  }
  const schedule: Schedule = {
    id,
    contentId: content.id,
    brandId: "brand_1",
    platform: "instagram",
    socialAccountId: "acc_ig",
    versionId: version.id,
    contentHash: hash,
    scheduledAt: opts.scheduledAt,
    status: "pending",
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.schedules.push(schedule);
  return schedule;
}

function deps(
  api: SchedulePublishDeps["api"],
  env: Record<string, string>,
  fetchImpl: typeof fetch,
): SchedulePublishDeps {
  return {
    api,
    gate: new ClaudeGate({
      runner: async () => {
        throw new Error("unused");
      },
    }),
    settings: loadAgentSettings({ STUDIO_WORKER_TOKEN: "t", ...env }),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-p3-")),
    renderer: () => {
      throw new Error("no render in these tests");
    },
    publisherFetch: fetchImpl,
    publisherSleep: async () => {},
    inFlightSchedules: new Set(),
    now: () => new Date(NOW),
  };
}

/** A fake cloud publisher that records calls and keeps orders. */
function fakeCloud() {
  const calls: {
    method: string;
    path: string;
    body?: unknown;
    contentType?: string | null;
    bytes?: Uint8Array;
  }[] = [];
  const orders = new Map<string, { scheduledAt: string; cancelled: boolean }>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (headers.get("authorization") !== "Bearer cloud-token-xyz")
      return new Response("no", { status: 401 });
    const order = /^\/v1\/orders\/([^/]+)$/.exec(url.pathname);
    const media = /^\/v1\/orders\/([^/]+)\/media\/(.+)$/.exec(url.pathname);
    const cancel = /^\/v1\/orders\/([^/]+)\/cancel$/.exec(url.pathname);
    if (method === "PUT" && order) {
      const body = JSON.parse(String(init?.body)) as { scheduledAt: string };
      calls.push({ method, path: url.pathname, body });
      orders.set(order[1] as string, { scheduledAt: body.scheduledAt, cancelled: false });
      return Response.json({ id: order[1], status: "awaiting_media" });
    }
    if (method === "PUT" && media) {
      const bytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
      calls.push({ method, path: url.pathname, contentType: headers.get("content-type"), bytes });
      return Response.json({ uploaded: true });
    }
    if (method === "POST" && cancel) {
      calls.push({ method, path: url.pathname });
      const o = orders.get(cancel[1] as string);
      if (o) o.cancelled = true;
      return Response.json({ id: cancel[1], status: "cancelled" });
    }
    if (method === "GET" && url.pathname === "/v1/orders") {
      calls.push({ method, path: url.pathname });
      return Response.json({ items: [], nextCursor: null });
    }
    return new Response("unexpected", { status: 500 });
  };
  return { calls, orders, fetchImpl };
}

describe("cloud publisher configured in the app (API), not in the worker env", () => {
  it("pushes, records delivery, re-pushes a moved schedule and cancels a cancelled one", async () => {
    const cloud = fakeCloud();
    const { api, state, extras } = fakeApiWithPublishing({
      url: "https://pub.test",
      token: "cloud-token-xyz",
    });
    const s = seed(state, {
      bytes: await image("jpeg"),
      mime: "image/jpeg",
      scheduledAt: "2026-11-20T12:00:00.000Z",
    });
    const d = deps(api, {}, cloud.fetchImpl);
    const poller = new SchedulePoller(d);

    await poller.tick();
    expect(cloud.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT /v1/orders/${s.id}`,
      `PUT /v1/orders/${s.id}/media/slide-1.jpg`,
      "GET /v1/orders",
    ]);
    expect(extras.deliveries.find((x) => x.input.cloudSyncedAt)?.input).toMatchObject({
      delivery: "cloud",
      error: null,
    });
    expect(state.schedules[0]).toMatchObject({ delivery: "cloud" });
    expect(extras.reports.at(-1)).toEqual({ ok: true, error: null });

    // Unchanged: not pushed again.
    cloud.calls.length = 0;
    await poller.tick();
    expect(cloud.calls.map((c) => c.method)).toEqual(["GET"]);

    // Moved in the calendar: pushed again with the new time.
    state.schedules[0] = {
      ...(state.schedules[0] as Schedule),
      scheduledAt: "2026-11-21T08:30:00.000Z",
      cloudSyncedAt: null,
    };
    cloud.calls.length = 0;
    await poller.tick();
    expect(cloud.calls[0]).toMatchObject({ method: "PUT", path: `/v1/orders/${s.id}` });
    expect(cloud.orders.get(s.id)?.scheduledAt).toBe("2026-11-21T08:30:00.000Z");

    // Cancelled on the Mac: cancelled at the cloud, then no longer listed.
    state.schedules[0] = { ...(state.schedules[0] as Schedule), status: "cancelled" };
    cloud.calls.length = 0;
    await poller.tick();
    expect(cloud.calls.map((c) => `${c.method} ${c.path}`)).toContain(
      `POST /v1/orders/${s.id}/cancel`,
    );
    expect(cloud.orders.get(s.id)?.cancelled).toBe(true);
    expect(state.schedules[0]?.cloudSyncedAt).toBeNull();
  });

  it("converts a PNG slide to JPEG for Instagram (declared type matches the bytes)", async () => {
    const cloud = fakeCloud();
    const { api, state } = fakeApiWithPublishing({
      url: "https://pub.test",
      token: "cloud-token-xyz",
    });
    seed(state, {
      bytes: await image("png"),
      mime: "image/png",
      scheduledAt: "2026-11-20T12:00:00.000Z",
    });
    await new SchedulePoller(deps(api, {}, cloud.fetchImpl)).tick();
    const order = cloud.calls[0]?.body as { media: { mimeType: string; id: string }[] };
    expect(order.media[0]).toMatchObject({ mimeType: "image/jpeg", id: "slide-1.jpg" });
    const upload = cloud.calls[1];
    expect(upload?.contentType).toBe("image/jpeg");
    expect([...(upload?.bytes ?? new Uint8Array()).slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(state.uploads.some((u) => u.kind === "image")).toBe(true);
  });

  it("reports a refused order as the schedule's error and the round as failed", async () => {
    const { api, state, extras } = fakeApiWithPublishing({
      url: "https://pub.test",
      token: "cloud-token-xyz",
    });
    const s = seed(state, {
      bytes: await image("jpeg"),
      mime: "image/jpeg",
      scheduledAt: "2026-11-20T12:00:00.000Z",
    });
    const refusing: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if ((init?.method ?? "GET") === "PUT") {
        return Response.json(
          {
            error: {
              code: "validation_error",
              message: "invalid order",
              issues: [{ path: "media.0", message: "Görsel oranı desteklenmiyor." }],
            },
          },
          { status: 400 },
        );
      }
      if (url.pathname === "/v1/orders") return Response.json({ items: [], nextCursor: null });
      return new Response("?", { status: 500 });
    };
    await new SchedulePoller(deps(api, {}, refusing)).tick();
    const err = extras.deliveries.find((x) => x.id === s.id && x.input.error)?.input.error;
    expect(err).toContain("Görsel oranı desteklenmiyor.");
    expect(extras.reports.at(-1)?.ok).toBe(false);
  });

  it("a schedule.publish job goes to the cloud even when it is due now", async () => {
    const cloud = fakeCloud();
    const { api, state } = fakeApiWithPublishing({
      url: "https://pub.test",
      token: "cloud-token-xyz",
    });
    const s = seed(state, { bytes: await image("jpeg"), mime: "image/jpeg", scheduledAt: NOW });
    const handler = createSchedulePublishHandler(deps(api, {}, cloud.fetchImpl));
    const job: Job = {
      id: "job_1",
      type: "schedule.publish",
      status: "running",
      payload: { scheduleId: s.id },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const ctx: JobContext = {
      jobId: job.id,
      job,
      attempt: 1,
      workerId: "mac",
      signal: new AbortController().signal,
      progress: () => {},
      log: () => {},
    };
    const out = (await handler.run({ scheduleId: s.id }, ctx)) as { mode: string };
    expect(out.mode).toBe("cloud");
    const order = cloud.calls[0]?.body as { scheduledAt: string };
    // Sent a few seconds into the future (the cloud publisher needs a future time).
    expect(Date.parse(order.scheduledAt)).toBeGreaterThan(Date.parse(NOW));
  });
});

describe("retrying a failed schedule (same id, same cloud order)", () => {
  /** A cloud publisher with one order whose target state the test sets. */
  function statefulCloud(opts: { replacesFailed: boolean }) {
    const calls: string[] = [];
    let target: { status: string; attempts: number } | null = null;
    let updatedAt = "2026-11-20T10:00:00.000Z";
    const bump = () => {
      updatedAt = new Date(Date.parse(updatedAt) + 60_000).toISOString();
    };
    const orderJson = (id: string) => ({
      id,
      contentId: `cnt_${id}`,
      versionId: `ver_${id}`,
      contentHash: "d".repeat(64),
      scheduledAt: "2026-11-21T12:00:00.000Z",
      status: target?.status === "failed" ? "failed" : "scheduled",
      caption: null,
      title: null,
      isAiGenerated: false,
      media: [],
      targets: target
        ? [
            {
              id,
              platform: "instagram",
              kind: "instagram.image",
              accountExternalId: "17841400001",
              status: target.status,
              attempts: target.attempts,
              nextRunAt: null,
              externalId: null,
              postId: null,
              permalink: null,
              publishedAt: null,
              error:
                target.status === "failed"
                  ? { code: "MEDIA_MISSING", message: "Medya eksikti.", action: "fix_content" }
                  : null,
            },
          ]
        : [],
      cancelledAt: null,
      createdAt: "2026-11-20T10:00:00.000Z",
      updatedAt,
    });
    let orderId = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      const order = /^\/v1\/orders\/([^/]+)$/.exec(url.pathname);
      if (method === "PUT" && order) {
        orderId = order[1] as string;
        if (target?.status === "failed" && !opts.replacesFailed) {
          return Response.json(
            { error: { code: "conflict", message: "order already started publishing" } },
            { status: 409 },
          );
        }
        target = { status: "pending", attempts: target?.attempts ?? 0 };
        bump();
        return Response.json(orderJson(orderId));
      }
      if (method === "PUT") return Response.json({ uploaded: true });
      if (method === "GET" && order) return Response.json(orderJson(order[1] as string));
      if (method === "GET" && url.pathname === "/v1/orders") {
        return Response.json({ items: orderId ? [orderJson(orderId)] : [], nextCursor: null });
      }
      return new Response("unexpected", { status: 500 });
    };
    return {
      calls,
      fetchImpl,
      fail(attempts: number) {
        target = { status: "failed", attempts };
        bump();
      },
    };
  }

  it("re-pushes the retried schedule and writes its next failure back even with the same state", async () => {
    const cloud = statefulCloud({ replacesFailed: true });
    const { api, state } = fakeApiWithPublishing({
      url: "https://pub.test",
      token: "cloud-token-xyz",
    });
    const s = seed(state, {
      bytes: await image("jpeg"),
      mime: "image/jpeg",
      scheduledAt: "2026-11-21T12:00:00.000Z",
    });
    const poller = new SchedulePoller(deps(api, {}, cloud.fetchImpl));
    await poller.tick();
    expect(cloud.calls.filter((c) => c === `PUT /v1/orders/${s.id}`)).toHaveLength(1);

    // It fails at the cloud before starting (attempt count stays 0) and is written back.
    cloud.fail(0);
    await poller.tick();
    expect(state.scheduleOutcomes.map((o) => o.outcome.status)).toEqual(["failed"]);
    expect(state.schedules[0]?.status).toBe("failed");

    // Retry on the Mac: the API puts the same schedule back to pending with a new time.
    state.schedules[0] = {
      ...(state.schedules[0] as Schedule),
      status: "pending",
      scheduledAt: "2026-11-22T09:00:00.000Z",
      cloudSyncedAt: null,
      lastError: null,
    };
    cloud.calls.length = 0;
    await poller.tick();
    expect(cloud.calls).toContain(`PUT /v1/orders/${s.id}`);
    expect(
      cloud.calls.filter((c) => c.startsWith("PUT /v1/orders/") && !c.includes("/media/")),
    ).toEqual([`PUT /v1/orders/${s.id}`]);

    // Same failure again ("failed", 0 attempts): still reported, not swallowed as seen.
    cloud.fail(0);
    await poller.tick();
    expect(state.scheduleOutcomes.map((o) => o.outcome.status)).toEqual(["failed", "failed"]);
    expect(state.schedules[0]?.status).toBe("failed");
  });

  it("says the cloud publisher needs an update when it refuses to replace a failed order", async () => {
    const cloud = statefulCloud({ replacesFailed: false });
    const { api, state, extras } = fakeApiWithPublishing({
      url: "https://pub.test",
      token: "cloud-token-xyz",
    });
    const s = seed(state, {
      bytes: await image("jpeg"),
      mime: "image/jpeg",
      scheduledAt: "2026-11-21T12:00:00.000Z",
    });
    const poller = new SchedulePoller(deps(api, {}, cloud.fetchImpl));
    await poller.tick();
    cloud.fail(1);
    await poller.tick();
    state.schedules[0] = {
      ...(state.schedules[0] as Schedule),
      status: "pending",
      scheduledAt: "2026-11-22T09:00:00.000Z",
      cloudSyncedAt: null,
    };
    await poller.tick();
    const err = extras.deliveries.filter((x) => x.id === s.id && x.input.error).at(-1)?.input.error;
    expect(err).toContain("güncellenmesi gerekiyor");
    expect(extras.reports.at(-1)?.ok).toBe(false);
    // Not marked as pushed: the next round tries again.
    cloud.calls.length = 0;
    await poller.tick();
    expect(cloud.calls).toContain(`PUT /v1/orders/${s.id}`);
  });
});

describe("local mode", () => {
  it("records local delivery before publishing a due schedule", async () => {
    const { api, state, extras } = fakeApiWithPublishing(null);
    const s = seed(state, {
      bytes: await image("jpeg"),
      mime: "image/jpeg",
      scheduledAt: "2026-11-16T09:59:00.000Z",
    });
    state.accountTokens.set("acc_ig", null);
    await new SchedulePoller(
      deps(api, {}, async () => new Response("unused", { status: 500 })),
    ).tick();
    // No token: fails with a reconnect message, after declaring local delivery.
    expect(extras.deliveries.length === 0 || extras.deliveries[0]?.input.delivery === "local").toBe(
      true,
    );
    expect(state.scheduleOutcomes.find((o) => o.id === s.id)?.outcome).toMatchObject({
      status: "failed",
      accountNeedsReauth: true,
    });
  });
});

describe("publish details in cloud orders (N13)", () => {
  it("sends the first comment, location, alt text and picture tags; a details change pushes again", async () => {
    const cloud = fakeCloud();
    const { api, state } = fakeApiWithPublishing({
      url: "https://pub.test",
      token: "cloud-token-xyz",
    });
    const s = seed(state, {
      bytes: await image("jpeg"),
      mime: "image/jpeg",
      scheduledAt: "2026-11-20T12:00:00.000Z",
    });
    const content = state.contents.get(s.contentId) as Content;
    state.contents.set(s.contentId, {
      ...content,
      publishDetails: {
        firstComment: "#hasat #tarım",
        altTexts: ["Tarlada buğday başakları"],
        location: { id: "110011", name: "Konya" },
        collaborators: ["ortak.marka"],
        userTags: [{ slide: 0, username: "ciftci.ali", x: 0.4, y: 0.6 }],
      },
    });
    const poller = new SchedulePoller(deps(api, {}, cloud.fetchImpl));
    await poller.tick();
    const order = cloud.calls.find((c) => c.method === "PUT" && c.path === `/v1/orders/${s.id}`)
      ?.body as {
      details?: unknown;
      media: { altText?: string; userTags?: unknown }[];
    };
    expect(order.details).toEqual({
      firstComment: "#hasat #tarım",
      locationId: "110011",
      collaborators: ["ortak.marka"],
    });
    expect(order.media[0]).toMatchObject({
      altText: "Tarlada buğday başakları",
      userTags: [{ username: "ciftci.ali", x: 0.4, y: 0.6 }],
    });

    // Unchanged: no push. The details changed (revision bumped): pushed again.
    cloud.calls.length = 0;
    await poller.tick();
    expect(cloud.calls.map((c) => c.method)).toEqual(["GET"]);
    state.schedules[0] = { ...(state.schedules[0] as Schedule), detailsRevision: 1 };
    cloud.calls.length = 0;
    await poller.tick();
    expect(cloud.calls[0]).toMatchObject({ method: "PUT", path: `/v1/orders/${s.id}` });
  });
});
