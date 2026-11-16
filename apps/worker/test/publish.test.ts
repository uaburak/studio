import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Content, ContentVersion, Job, Schedule, SocialAccount } from "@studio/contract";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { silentLogger } from "../src/log.ts";
import { createSchedulePublishHandler, type SchedulePublishDeps } from "../src/publish/handler.ts";
import { SchedulePoller } from "../src/publish/poller.ts";
import type { JobContext } from "../src/registry.ts";
import type { RenderCapable } from "../src/render/handler.ts";
import { createFakeApi, fakeBrand, NOW } from "./fake-api.ts";

const KIT_FIXTURES = fileURLToPath(
  new URL("../../../packages/design-kit/test/fixtures/", import.meta.url),
);
const typographicHtml = readFileSync(path.join(KIT_FIXTURES, "slides/typographic.html"), "utf8");

async function slideJpeg(): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp({ create: { width: 1080, height: 1350, channels: 3, background: "#FFFFFF" } })
      .jpeg()
      .toBuffer(),
  );
}

const fakeRenderer: RenderCapable = {
  async render(req) {
    const png = new Uint8Array(
      await sharp({
        create: { width: req.width, height: req.height, channels: 3, background: "#FFFFFF" },
      })
        .png()
        .toBuffer(),
    );
    return {
      png,
      pixelWidth: req.width,
      pixelHeight: req.height,
      deviceScaleFactor: 1,
      network: { blocked: [], missing: [] },
      served: [],
      timings: {
        contextMs: 1,
        loadMs: 1,
        assetsMs: 1,
        screenshotMs: 1,
        encodeMs: 1,
        totalMs: 5,
      },
    };
  },
  async renderAndLint() {
    throw new Error("unused");
  },
};

function seedApprovedSchedule(input: {
  state: ReturnType<typeof createFakeApi>["state"];
  platform: "instagram" | "facebook" | "linkedin";
  externalId: string;
  contentType?: Content["type"];
  slideBytes?: Uint8Array[];
  scheduledAt?: string;
}) {
  const slidesCount = input.slideBytes?.length ?? 1;
  const renderedIds: (string | null)[] = [];
  if (input.slideBytes) {
    input.slideBytes.forEach((bytes, idx) => {
      const id = `asset_slide_${idx + 1}`;
      input.state.assets.set(id, { bytes, contentType: "image/jpeg" });
      renderedIds.push(id);
    });
  } else {
    renderedIds.push(null);
  }

  const hash = "c".repeat(64);
  const version: ContentVersion = {
    id: "ver_pub_1",
    contentId: "cnt_pub_1",
    version: 1,
    origin: "generated",
    contentHash: hash,
    slideCount: slidesCount,
    note: "Temiz",
    jobId: null,
    createdAt: NOW,
    updatedAt: NOW,
    slides: Array.from({ length: slidesCount }, (_, idx) => ({
      html: typographicHtml,
      width: 1080,
      height: 1350,
      renderedAssetId: renderedIds[idx] ?? null,
    })),
  };
  input.state.versions.push(version);

  const content: Content = {
    id: "cnt_pub_1",
    brandId: "brand_1",
    type: input.contentType ?? (slidesCount > 1 ? "carousel" : "post"),
    title: "Kasım Duyurusu",
    brief: "Duyuru",
    status: "scheduled",
    targetPlatforms: [input.platform],
    caption: "Kasım ayı uygulamaları hazır. #mtmagro",
    currentVersion: { id: version.id, version: 1, contentHash: hash },
    approval: { versionId: version.id, contentHash: hash, approvedAt: NOW },
    createdAt: NOW,
    updatedAt: NOW,
  };
  input.state.contents.set(content.id, content);

  const account: SocialAccount = {
    id: "acc_pub_1",
    brandId: "brand_1",
    platform: input.platform,
    handle: `@mtm_${input.platform}`,
    externalId: input.externalId,
    status: "connected",
    createdAt: NOW,
    updatedAt: NOW,
  };
  input.state.socialAccounts.push(account);

  const schedule: Schedule = {
    id: "sched_pub_1",
    contentId: content.id,
    brandId: "brand_1",
    platform: input.platform,
    socialAccountId: account.id,
    versionId: version.id,
    contentHash: hash,
    scheduledAt: input.scheduledAt ?? "2026-11-16T09:55:00.000Z",
    status: "pending",
    cancelledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  input.state.schedules.push(schedule);
  return { schedule, account, content, version };
}

function makeDeps(
  api: SchedulePublishDeps["api"],
  env: Record<string, string>,
  publisherFetch: typeof fetch,
): SchedulePublishDeps {
  return {
    api,
    gate: new ClaudeGate({
      runner: async () => {
        throw new Error("unused");
      },
    }),
    settings: loadAgentSettings(env),
    logger: silentLogger,
    health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
    stateDir: mkdtempSync(path.join(tmpdir(), "worker-pub-")),
    renderer: () => fakeRenderer,
    publisherFetch,
    publisherSleep: async () => {},
    inFlightSchedules: new Set(),
    now: () => new Date(NOW),
  };
}

function publishJobCtx(scheduleId: string): JobContext {
  const job: Job = {
    id: "job_pub_1",
    type: "schedule.publish",
    status: "running",
    brandId: "brand_1",
    contentId: "cnt_pub_1",
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

describe("Mode A — Cloud Publisher sync & outcome reporting", () => {
  it("pushes pending orders + SHA-256 verified media to Cloud Publisher and syncs published permalink back", async () => {
    const jpeg = await slideJpeg();
    const expectedSha = createHash("sha256").update(jpeg).digest("hex");
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const { schedule } = seedApprovedSchedule({
      state,
      platform: "instagram",
      externalId: "17841400001",
      slideBytes: [jpeg],
      scheduledAt: "2026-11-20T12:00:00.000Z",
    });

    const cloudCalls: { method: string; url: string; auth: string | null; body?: unknown }[] = [];

    const cloudFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const auth = new Headers(init?.headers).get("authorization");

      if (method === "PUT" && url.endsWith(`/v1/orders/${schedule.id}`)) {
        const parsed = JSON.parse(String(init?.body));
        cloudCalls.push({ method, url, auth, body: parsed });
        return new Response(JSON.stringify({ id: schedule.id, status: "awaiting_media" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "PUT" && url.includes(`/v1/orders/${schedule.id}/media/`)) {
        const buf = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        cloudCalls.push({ method, url, auth, body: { bytes: buf.byteLength } });
        return new Response(JSON.stringify({ uploaded: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (method === "GET" && url.includes("/v1/orders")) {
        cloudCalls.push({ method, url, auth });
        return new Response(
          JSON.stringify({
            items: [
              {
                id: schedule.id,
                contentId: "cnt_pub_1",
                versionId: "ver_pub_1",
                contentHash: "c".repeat(64),
                scheduledAt: "2026-11-20T12:00:00.000Z",
                status: "published",
                caption: "Kasım ayı uygulamaları hazır. #mtmagro",
                title: "Kasım Duyurusu",
                isAiGenerated: false,
                media: [
                  {
                    id: "slide-1.jpg",
                    kind: "image",
                    mimeType: "image/jpeg",
                    bytes: jpeg.byteLength,
                    sha256: expectedSha,
                    width: 1080,
                    height: 1350,
                    uploaded: true,
                  },
                ],
                targets: [
                  {
                    id: schedule.id,
                    platform: "instagram",
                    kind: "instagram.image",
                    accountExternalId: "17841400001",
                    status: "published",
                    attempts: 1,
                    nextRunAt: null,
                    externalId: "ig_media_99",
                    postId: null,
                    permalink: "https://www.instagram.com/p/C9XYZ/",
                    publishedAt: NOW,
                    error: null,
                  },
                ],
                cancelledAt: null,
                createdAt: NOW,
                updatedAt: "2026-11-16T10:05:00.000Z",
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      throw new Error(`Unexpected cloud request: ${method} ${url}`);
    };

    const deps = makeDeps(
      api,
      {
        STUDIO_CLOUD_PUBLISHER_URL: "https://cloud-pub.studio.example",
        STUDIO_CLOUD_PUBLISHER_TOKEN: "cloud-secret-token",
      },
      cloudFetch,
    );

    const poller = new SchedulePoller(deps);
    await poller.tick();

    expect(cloudCalls.map((c) => [c.method, c.url])).toEqual([
      ["PUT", `https://cloud-pub.studio.example/v1/orders/${schedule.id}`],
      ["PUT", `https://cloud-pub.studio.example/v1/orders/${schedule.id}/media/slide-1.jpg`],
      ["GET", "https://cloud-pub.studio.example/v1/orders?limit=50"],
    ]);
    expect(cloudCalls[0]?.auth).toBe("Bearer cloud-secret-token");
    const putBody = cloudCalls[0]?.body as { media: { sha256: string }[] };
    expect(putBody.media[0]?.sha256).toBe(expectedSha);

    expect(state.scheduleOutcomes).toEqual([
      {
        id: schedule.id,
        outcome: {
          status: "published",
          attempt: 1,
          externalPostId: "ig_media_99",
          permalink: "https://www.instagram.com/p/C9XYZ/",
        },
      },
    ]);
    expect(state.schedules[0]?.status).toBe("published");
    expect(state.schedules[0]?.permalink).toBe("https://www.instagram.com/p/C9XYZ/");
    expect(state.contents.get("cnt_pub_1")?.status).toBe("published");
  });
});

describe("Mode B — Local Direct Publisher (@studio/publishers)", () => {
  it("publishes due Instagram posts locally via Graph API and records published permalink", async () => {
    const jpeg = await slideJpeg();
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const { schedule } = seedApprovedSchedule({
      state,
      platform: "instagram",
      externalId: "17841400001",
      slideBytes: [jpeg],
    });

    const graphFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";

      if (url.pathname.endsWith("/content_publishing_limit")) {
        return new Response(
          JSON.stringify({
            data: [{ quota_usage: 2, config: { quota_total: 50, quota_duration: 86400 } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "POST" && url.pathname.endsWith("/17841400001/media")) {
        return new Response(JSON.stringify({ id: "creation_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.pathname.endsWith("/creation_123")) {
        return new Response(JSON.stringify({ id: "creation_123", status_code: "FINISHED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.pathname.endsWith("/17841400001/media")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "POST" && url.pathname.endsWith("/17841400001/media_publish")) {
        return new Response(JSON.stringify({ id: "ig_post_777" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (method === "GET" && url.pathname.endsWith("/ig_post_777")) {
        return new Response(
          JSON.stringify({ id: "ig_post_777", permalink: "https://www.instagram.com/p/IG777/" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unhandled Graph request: ${method} ${url.toString()}`);
    };

    const deps = makeDeps(api, {}, graphFetch);
    const handler = createSchedulePublishHandler(deps);
    const out = await handler.run({ scheduleId: schedule.id }, publishJobCtx(schedule.id));

    expect(out).toMatchObject({
      mode: "local",
      scheduleId: schedule.id,
      status: "published",
      kind: "instagram.image",
      externalPostId: "ig_post_777",
      permalink: "https://www.instagram.com/p/IG777/",
    });
    expect(state.scheduleOutcomes.map((o) => o.outcome.status)).toEqual([
      "publishing",
      "published",
    ]);
  });

  it("automatically generates multi-page PDF and publishes LinkedIn carousel as linkedin.document", async () => {
    const jpeg1 = await slideJpeg();
    const jpeg2 = await slideJpeg();
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    seedApprovedSchedule({
      state,
      platform: "linkedin",
      externalId: "urn:li:person:burak123",
      contentType: "carousel",
      slideBytes: [jpeg1, jpeg2],
    });

    let uploadedPdfHeader = "";
    const linkedinFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (method === "POST" && url.includes("/rest/documents?action=initializeUpload")) {
        return new Response(
          JSON.stringify({
            value: {
              document: "urn:li:document:doc_42",
              uploadUrl: "https://www.linkedin.com/dms-uploads/doc_42",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (method === "PUT" && url.includes("/dms-uploads/doc_42")) {
        const bytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        uploadedPdfHeader = new TextDecoder().decode(bytes.subarray(0, 8));
        return new Response("", { status: 201 });
      }
      if (method === "POST" && url.endsWith("/rest/posts")) {
        return new Response("", {
          status: 201,
          headers: { "x-restli-id": "urn:li:ugcPost:987654" },
        });
      }
      throw new Error(`Unhandled LinkedIn request: ${method} ${url}`);
    };

    const deps = makeDeps(api, {}, linkedinFetch);
    const poller = new SchedulePoller(deps);
    await poller.tick();

    expect(uploadedPdfHeader.startsWith("%PDF-")).toBe(true);
    expect(state.schedules[0]?.status).toBe("published");
    expect(state.schedules[0]?.permalink).toBe(
      "https://www.linkedin.com/feed/update/urn:li:ugcPost:987654/",
    );
  });

  it("marks accountNeedsReauth=true when Meta returns an invalid/expired OAuth token (code 190)", async () => {
    const jpeg = await slideJpeg();
    const { api, state } = createFakeApi({ brands: [fakeBrand()] });
    const { schedule } = seedApprovedSchedule({
      state,
      platform: "instagram",
      externalId: "17841400001",
      slideBytes: [jpeg],
    });

    const expiredTokenFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Error validating access token: Session has expired.",
            type: "OAuthException",
            code: 190,
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );

    const deps = makeDeps(api, {}, expiredTokenFetch);
    const handler = createSchedulePublishHandler(deps);
    await expect(
      handler.run({ scheduleId: schedule.id }, publishJobCtx(schedule.id)),
    ).rejects.toThrow();

    expect(state.scheduleOutcomes.at(-1)?.outcome).toMatchObject({
      status: "failed",
      accountNeedsReauth: true,
    });
    expect(state.socialAccounts[0]?.status).toBe("needs_reauth");
  });
});
