/**
 * Publish safety on the Mac (Faz 2: Y4, Y5, Y9, Y12, Y14): a schedule is published at most
 * once, never after it was cancelled or handed to the cloud, never far too late, a crashed
 * publish resumes from its saved state, and a reconnected account's cloud orders are pushed
 * again with the new token.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ApiError,
  type Content,
  type ContentVersion,
  type Job,
  type Schedule,
  type SocialAccount,
  type WorkerScheduleDelivery,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  createPublisher,
  type LinkedInState,
  toLittleText,
} from "../../../packages/publishers/src/index.ts";
import { FakeLinkedIn } from "../../../packages/publishers/src/testing/index.ts";
import { loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { silentLogger } from "../src/log.ts";
import {
  createSchedulePublishHandler,
  publishScheduleLocally,
  type SchedulePublishDeps,
} from "../src/publish/handler.ts";
import { SchedulePoller } from "../src/publish/poller.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const AUTHOR = "urn:li:person:deniz123";
type FakeState = ReturnType<typeof createFakeApi>["state"];

function seedLinkedIn(state: FakeState, overrides: Partial<Schedule> = {}) {
  const hash = "e".repeat(64);
  state.assets.set("asset_li_1", {
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]),
    contentType: "image/jpeg",
  });
  const version: ContentVersion = {
    id: "ver_li_1",
    contentId: "cnt_li_1",
    version: 1,
    origin: "generated",
    contentHash: hash,
    slideCount: 1,
    note: null,
    jobId: null,
    createdAt: NOW,
    updatedAt: NOW,
    slides: [{ html: "<html></html>", width: 1080, height: 1350, renderedAssetId: "asset_li_1" }],
  };
  state.versions.push(version);
  const content: Content = {
    id: "cnt_li_1",
    brandId: "brand_1",
    type: "post",
    title: "Hasat",
    brief: "",
    status: "scheduled",
    targetPlatforms: ["linkedin"],
    caption: "Hasat başladı (2026) #tarım",
    currentVersion: { id: version.id, version: 1, contentHash: hash },
    approval: { versionId: version.id, contentHash: hash, approvedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.contents.set(content.id, content);
  const account: SocialAccount = {
    id: "acc_li",
    brandId: "brand_1",
    platform: "linkedin",
    handle: "Deniz",
    externalId: AUTHOR,
    status: "connected",
    createdAt: NOW,
    updatedAt: NOW,
  };
  state.socialAccounts.push(account);
  const schedule: Schedule = {
    id: "sched_li_1",
    contentId: content.id,
    brandId: "brand_1",
    platform: "linkedin",
    socialAccountId: account.id,
    versionId: version.id,
    contentHash: hash,
    scheduledAt: "2026-11-16T09:59:00.000Z",
    status: "pending",
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
  state.schedules.push(schedule);
  return schedule;
}

function makeDeps(
  api: SchedulePublishDeps["api"],
  fetchImpl: typeof fetch,
  env: Record<string, string> = {},
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
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-safety-")),
    renderer: () => {
      throw new Error("no render in these tests");
    },
    publisherFetch: fetchImpl,
    publisherSleep: async () => {},
    inFlightSchedules: new Set(),
    now: () => new Date(NOW),
  };
}

function jobCtx(scheduleId: string): JobContext {
  const job: Job = {
    id: "job_safety",
    type: "schedule.publish",
    status: "running",
    brandId: "brand_1",
    contentId: "cnt_li_1",
    payload: { scheduleId },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    jobId: job.id,
    job,
    attempt: 1,
    workerId: "mac",
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
  };
}

/** The real API's status guard on credentials (the fake only checks the approval). */
function guardCredentials(state: FakeState, api: SchedulePublishDeps["api"]) {
  const ws = (api.client as unknown as { workerSchedules: Record<string, unknown> })
    .workerSchedules;
  const original = ws.credentials as (id: string) => Promise<unknown>;
  ws.credentials = async (id: string) => {
    const s = state.schedules.find((x) => x.id === id);
    if (s && s.status !== "pending" && s.status !== "publishing") {
      throw new ApiError(`schedule is ${s.status}`, 409, "invalid_transition");
    }
    return original(id);
  };
}

describe("local publishing never publishes what it must not (Y4)", () => {
  it.each(["cancelled", "published"] as const)(
    "a queued job of a %s schedule publishes nothing",
    async (status) => {
      const { api, state } = createFakeApi({ brands: [fakeBrand()] });
      const s = seedLinkedIn(state, { status });
      const linkedin = new FakeLinkedIn();
      const out = await createSchedulePublishHandler(makeDeps(api, linkedin.fetch)).run(
        { scheduleId: s.id },
        jobCtx(s.id),
      );
      expect(out).toMatchObject({ mode: "local", status: "skipped" });
      expect(linkedin.calls).toHaveLength(0);
      expect(state.scheduleOutcomes).toHaveLength(0);
      expect(state.schedules[0]?.status).toBe(status);
    },
  );

  it("a second job for a schedule another worker is publishing does nothing", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const s = seedLinkedIn(state);
    guardCredentials(state, api);
    const linkedin = new FakeLinkedIn();
    const deps = makeDeps(api, linkedin.fetch);
    const first = await publishScheduleLocally({
      scheduleId: s.id,
      deps,
      signal: new AbortController().signal,
    });
    expect(first.status).toBe("published");
    // The same job retried (or the poller) after it succeeded.
    const again = await createSchedulePublishHandler(deps).run({ scheduleId: s.id }, jobCtx(s.id));
    expect(again).toMatchObject({ status: "skipped" });
    expect(linkedin.posts).toHaveLength(1);
    expect(linkedin.postCalls()).toHaveLength(1);
  });

  it("a crash after the post call resumes from the saved state: one post, published", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const s = seedLinkedIn(state);
    guardCredentials(state, api);
    const linkedin = new FakeLinkedIn();
    const deps = makeDeps(api, linkedin.fetch);

    // The state after the post call cannot be saved (API down): the run stops, no outcome.
    let apiDown = true;
    const ws = (api.client as unknown as { workerSchedules: Record<string, unknown> })
      .workerSchedules;
    const save = ws.publishState as (id: string, input: unknown) => Promise<unknown>;
    ws.publishState = async (id: string, input: { state: { phase?: string } }) => {
      if (apiDown && input.state.phase === "done") throw new Error("api down");
      return save(id, input);
    };
    await expect(
      publishScheduleLocally({ scheduleId: s.id, deps, signal: new AbortController().signal }),
    ).rejects.toThrow(/kaydedilemedi/);
    expect(linkedin.posts).toHaveLength(1);
    expect(state.schedules[0]?.status).toBe("publishing");
    expect(state.scheduleOutcomes).toHaveLength(0);

    // Twenty-one minutes later the poller finds the stale claim and resumes it.
    apiDown = false;
    (state.publishing as NonNullable<FakeState["publishing"]>).now = new Date(
      Date.parse(NOW) + 21 * 60_000,
    ).toISOString();
    await new SchedulePoller(deps).tick();

    expect(linkedin.posts).toHaveLength(1);
    expect(state.schedules[0]?.status).toBe("published");
    expect(state.schedules[0]?.permalink).toBe(
      `https://www.linkedin.com/feed/update/${linkedin.posts[0]?.urn}/`,
    );
    expect(state.publishing?.claims.map((c) => [c.claimed, c.resumed])).toEqual([
      [true, false],
      [true, true],
    ]);
  });

  it("a schedule far past its time is not published (missed, S6)", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedLinkedIn(state, { scheduledAt: "2026-11-16T06:00:00.000Z" });
    const linkedin = new FakeLinkedIn();
    await new SchedulePoller(makeDeps(api, linkedin.fetch)).tick();
    expect(linkedin.posts).toHaveLength(0);
    expect(state.schedules[0]).toMatchObject({ status: "failed" });
    expect(state.schedules[0]?.lastError).toMatch(/^Mac kapalıyken kaçtı/);
  });
});

describe("a retried failed schedule and its saved state (Y4, Y7)", () => {
  /** The state an earlier try left behind: image uploaded, a post call whose answer was lost. */
  function earlierState(commentary: string): Record<string, unknown> {
    const publisher = createPublisher({ fetch: async () => new Response(null, { status: 500 }) });
    const state = publisher.start({
      kind: "linkedin.image",
      authorUrn: AUTHOR,
      image: {
        kind: "image",
        url: "http://fake/api/assets/asset_li_1/content",
        mimeType: "image/jpeg",
        bytes: 8,
      },
      commentary,
    }) as LinkedInState;
    state.phase = "create_post";
    state.intentAt = Date.parse(NOW) - 3_600_000;
    state.postCalls = 1;
    state.uploads = [
      {
        assetUrn: "urn:li:image:earlier",
        uploadUrl: null,
        uploadToken: null,
        parts: [],
        uploaded: true,
      },
    ];
    return JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
  }

  async function retry(savedCaption: string) {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const s = seedLinkedIn(state);
    const linkedin = new FakeLinkedIn();
    // Touch the fake's publishing state, then put the earlier try's state in.
    await api.client.workerSchedules.stale();
    state.publishing?.states.set(s.id, earlierState(savedCaption));
    const out = await publishScheduleLocally({
      scheduleId: s.id,
      deps: makeDeps(api, linkedin.fetch),
      signal: new AbortController().signal,
    });
    return { out, linkedin, content: state.contents.get("cnt_li_1") as Content };
  }

  it("resumes (no new upload) while the caption is the same", async () => {
    const { out, linkedin, content } = await retry("Hasat başladı (2026) #tarım");
    expect(out).toMatchObject({ status: "published", resumed: true });
    expect(linkedin.calls.some((c) => c.path.includes("initializeUpload"))).toBe(false);
    expect(linkedin.posts[0]?.body).toMatchObject({
      commentary: toLittleText(content.caption),
      content: { media: { id: "urn:li:image:earlier" } },
    });
  });

  it("starts again when the caption changed since (it must not post the old text)", async () => {
    const { out, linkedin, content } = await retry("Eski metin");
    expect(out).toMatchObject({ status: "published", resumed: false });
    expect(linkedin.calls.some((c) => c.path.includes("initializeUpload"))).toBe(true);
    expect(linkedin.posts).toHaveLength(1);
    expect(linkedin.posts[0]?.body.commentary).toBe(toLittleText(content.caption));
  });
});

describe("cloud-held schedules are never published by the Mac (Y5)", () => {
  it("local mode leaves out schedules handed to the cloud publisher", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedLinkedIn(state, { delivery: "cloud", cloudSyncedAt: NOW });
    const linkedin = new FakeLinkedIn();
    await new SchedulePoller(makeDeps(api, linkedin.fetch)).tick();
    expect(linkedin.calls).toHaveLength(0);
    expect(state.schedules[0]?.status).toBe("pending");
  });

  it("an unreadable cloud token stops publishing instead of switching to local", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedLinkedIn(state);
    const reports: { ok: boolean; error?: string | null }[] = [];
    (api.client as unknown as Record<string, unknown>).workerPublishing = {
      config: async () => {
        throw new ApiError(
          "/api/worker/publishing/config: Bulut yayıncı anahtarı çözülemedi",
          409,
          "conflict",
        );
      },
      report: async (input: { ok: boolean; error?: string | null }) => {
        reports.push(input);
        return { cloud: null, syncRequestedAt: null };
      },
    };
    const linkedin = new FakeLinkedIn();
    const deps = makeDeps(api, linkedin.fetch);
    await new SchedulePoller(deps).tick();
    expect(linkedin.calls).toHaveLength(0);
    expect(reports.at(-1)).toMatchObject({ ok: false });
    expect(reports.at(-1)?.error).toContain("çözülemedi");
    // The job path refuses too (retried later), it does not publish locally.
    await expect(
      createSchedulePublishHandler(deps).run({ scheduleId: "sched_li_1" }, jobCtx("sched_li_1")),
    ).rejects.toThrow(/çözülemedi/);
    expect(linkedin.calls).toHaveLength(0);
  });
});

/** Minimal cloud publisher: orders, cancel (409 once publishing started), GET. */
function cloudWith(order: { targetStatus: string; permalink?: string } | null) {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    if (method === "POST" && url.pathname.endsWith("/cancel")) {
      return order
        ? Response.json(
            { error: { code: "conflict", message: "order already started publishing" } },
            { status: 409 },
          )
        : Response.json({ id: "x", status: "cancelled" });
    }
    if (method === "GET" && url.pathname === "/v1/orders") {
      return Response.json({ items: [], nextCursor: null });
    }
    if (method === "GET" && url.pathname.startsWith("/v1/orders/") && order) {
      return Response.json({
        id: "sched_li_1",
        contentId: "cnt_li_1",
        versionId: "ver_li_1",
        contentHash: "e".repeat(64),
        scheduledAt: NOW,
        status: order.targetStatus,
        caption: null,
        title: null,
        isAiGenerated: false,
        media: [],
        targets: [
          {
            id: "sched_li_1",
            platform: "linkedin",
            kind: "linkedin.image",
            accountExternalId: AUTHOR,
            status: order.targetStatus,
            attempts: 1,
            nextRunAt: null,
            externalId: "urn:li:share:9",
            postId: "urn:li:share:9",
            permalink: order.permalink ?? null,
            publishedAt: NOW,
            error: null,
          },
        ],
        cancelledAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    if (method === "PUT") return Response.json({ id: "x", status: "awaiting_media" });
    return new Response("unexpected", { status: 500 });
  };
  return { calls, fetchImpl };
}

function withCloud(api: SchedulePublishDeps["api"], state: FakeState) {
  const deliveries: { id: string; input: WorkerScheduleDelivery }[] = [];
  const client = api.client as unknown as Record<string, Record<string, unknown>>;
  client.workerPublishing = {
    config: async () => ({
      cloud: { url: "https://cloud.example", token: "cloud-token-xyz" },
      syncRequestedAt: null,
      maxLatenessMs: 2 * 3600_000,
    }),
    report: async () => ({ cloud: null, syncRequestedAt: null }),
  };
  const ws = client.workerSchedules as Record<string, unknown>;
  ws.delivery = async (id: string, input: WorkerScheduleDelivery) => {
    deliveries.push({ id, input });
    const idx = state.schedules.findIndex((s) => s.id === id);
    const cur = state.schedules[idx] as Schedule;
    state.schedules[idx] = {
      ...cur,
      delivery: input.delivery,
      ...(input.cloudSyncedAt !== undefined ? { cloudSyncedAt: input.cloudSyncedAt } : {}),
    };
    return state.schedules[idx];
  };
  ws.cancelled = async () => ({
    items: state.schedules.filter(
      (s) => s.status === "cancelled" && s.delivery === "cloud" && s.cloudSyncedAt,
    ),
  });
  return deliveries;
}

describe("cancel that came too late at the cloud (Y9)", () => {
  it("records the cloud's published outcome instead of leaving it cancelled", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedLinkedIn(state, { status: "cancelled", delivery: "cloud", cloudSyncedAt: NOW });
    withCloud(api, state);
    const cloud = cloudWith({
      targetStatus: "published",
      permalink: "https://www.linkedin.com/feed/update/urn:li:share:9/",
    });
    await new SchedulePoller(makeDeps(api, cloud.fetchImpl)).tick();
    expect(cloud.calls).toContain("GET /v1/orders/sched_li_1");
    expect(state.scheduleOutcomes.at(-1)).toMatchObject({
      id: "sched_li_1",
      outcome: { status: "published", externalPostId: "urn:li:share:9" },
    });
    expect(state.schedules[0]).toMatchObject({
      status: "published",
      permalink: "https://www.linkedin.com/feed/update/urn:li:share:9/",
      cloudSyncedAt: null,
    });
  });
});

describe("reconnected account (Y14)", () => {
  it("pushes an order again when the API cleared its cloudSyncedAt", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const s = seedLinkedIn(state, { scheduledAt: "2026-11-20T09:00:00.000Z" });
    withCloud(api, state);
    const cloud = cloudWith(null);
    const deps = makeDeps(api, cloud.fetchImpl);
    const poller = new SchedulePoller(deps);
    await poller.tick();
    expect(cloud.calls.filter((c) => c === `PUT /v1/orders/${s.id}`)).toHaveLength(1);

    // Same version and time; the account got a new token, so the API cleared cloudSyncedAt.
    await poller.tick();
    expect(cloud.calls.filter((c) => c === `PUT /v1/orders/${s.id}`)).toHaveLength(1);
    const idx = state.schedules.findIndex((x) => x.id === s.id);
    state.schedules[idx] = { ...(state.schedules[idx] as Schedule), cloudSyncedAt: null };
    await poller.tick();
    expect(cloud.calls.filter((c) => c === `PUT /v1/orders/${s.id}`)).toHaveLength(2);
  });

  it("does not hand over a schedule that is already past the maximum lateness", async () => {
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const s = seedLinkedIn(state, { scheduledAt: "2026-11-16T06:00:00.000Z" });
    withCloud(api, state);
    const cloud = cloudWith(null);
    await new SchedulePoller(makeDeps(api, cloud.fetchImpl)).tick();
    expect(cloud.calls.filter((c) => c.startsWith("PUT"))).toHaveLength(0);
    expect(state.scheduleOutcomes.find((o) => o.id === s.id)?.outcome).toMatchObject({
      status: "failed",
    });
    expect(state.schedules[0]?.lastError).toMatch(/^Mac kapalıyken kaçtı/);
  });
});
