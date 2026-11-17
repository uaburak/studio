import {
  createExecutionContext,
  createScheduledController,
  runDurableObjectAlarm,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CloudOrder, CloudOrderList, CloudPublishLog } from "@studio/contract";
import {
  CloudOrderList as CloudOrderListSchema,
  CloudOrder as CloudOrderSchema,
  CloudPublishLog as CloudPublishLogSchema,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { mediaKey } from "../src/scheduler.ts";
import {
  api,
  createReadyOrder,
  expectError,
  fakeJpeg,
  HOUR,
  IG,
  nextAlarm,
  orderBody,
  PAGE,
  runUntilIdle,
  scheduler,
  setup,
  sha256Hex,
  T0,
  target,
  USER_TOKEN,
  upload,
} from "./helpers.ts";

const img = (n: number) => ({ id: `slide-${n}.jpg`, bytes: fakeJpeg(n) });

async function cron() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "*/5 * * * *" }), env, ctx);
  await waitOnExecutionContext(ctx);
}

describe("order lifecycle", () => {
  it("create -> upload -> publish at the scheduled time via the cron handler", async () => {
    const h = await setup();
    const created = await api<CloudOrder>(
      "PUT",
      "/v1/orders/o-1",
      await orderBody([img(1)], [target("instagram.image")]),
    );
    expect(created.status, created.text).toBe(201);
    CloudOrderSchema.parse(created.body);
    expect(created.body.status).toBe("awaiting_media");
    expect(created.body.media[0]?.uploaded).toBe(false);
    expect(created.body.targets[0]).toMatchObject({
      platform: "instagram",
      status: "pending",
      attempts: 0,
      nextRunAt: new Date(T0 + HOUR).toISOString(),
    });

    const up = await upload("o-1", img(1));
    expect(up.status, up.text).toBe(200);
    expect(up.body.status).toBe("scheduled");
    expect(await nextAlarm()).toBe(T0 + HOUR);

    // Before the time: the cron wakes the scheduler but nothing is published.
    h.clock.t = T0 + HOUR - 60_000;
    await cron();
    expect(h.fake.igPublishedMedia(IG)).toHaveLength(0);
    expect((await api<CloudOrder>("GET", "/v1/orders/o-1")).body.status).toBe("scheduled");

    // At the time: keep waking through the cron (container polling waits included).
    h.clock.t = T0 + HOUR;
    for (let i = 0; i < 20; i++) {
      await cron();
      const order = (await api<CloudOrder>("GET", "/v1/orders/o-1")).body;
      if (order.status === "published") break;
      const next = await nextAlarm();
      if (next !== null) h.clock.t = Math.max(h.clock.t, next);
    }

    const order = (await api<CloudOrder>("GET", "/v1/orders/o-1")).body;
    expect(order.status).toBe("published");
    const [t] = order.targets;
    const [media] = h.fake.igPublishedMedia(IG);
    expect(t).toMatchObject({ status: "published", attempts: 1, error: null, nextRunAt: null });
    expect(t?.externalId).toBe(media?.id);
    expect(t?.permalink).toBe(media?.permalink);
    expect(t?.publishedAt).toBeTruthy();

    // Meta got a signed URL on this Worker, with the caption and alt text.
    const create = h.fake.routeCalls("ig.media.create")[0];
    expect(create?.form.image_url ?? create?.query.image_url).toMatch(
      /^https:\/\/publisher\.test\/media\/o-1\/\d+\/[A-Za-z0-9_-]+\/slide-1\.jpg$/,
    );

    const log = await api<CloudPublishLog>("GET", "/v1/orders/o-1/log");
    CloudPublishLogSchema.parse(log.body);
    expect(log.body.items.map((e) => e.event)).toEqual(["started", "succeeded"]);
    expect(log.body.items[1]).toMatchObject({
      targetId: "instagram.image",
      attempt: 1,
      externalId: media?.id,
      permalink: media?.permalink,
      error: null,
    });
  });

  it("publishes to Instagram and a Facebook Page from one order via the alarm", async () => {
    const h = await setup();
    await createReadyOrder(
      "o-2",
      [img(1), img(2)],
      [target("instagram.carousel"), target("facebook.multi_photo")],
    );
    h.clock.t = T0 + HOUR;
    expect(await runDurableObjectAlarm(scheduler())).toBe(true);
    await runUntilIdle(h);

    const order = (await api<CloudOrder>("GET", "/v1/orders/o-2")).body;
    expect(order.status).toBe("published");
    expect(order.targets.map((t) => t.status)).toEqual(["published", "published"]);
    expect(h.fake.igPublishedMedia(IG)).toHaveLength(1);
    expect(h.fake.pagePosts(PAGE)).toHaveLength(1);
    expect(order.targets[1]?.postId).toBe(h.fake.pagePosts(PAGE)[0]?.id);
    expect(h.fake.stats.duplicatePublishAttempts).toBe(0);
  });

  it("fails a target whose media was never uploaded", async () => {
    const h = await setup();
    await api("PUT", "/v1/orders/o-3", await orderBody([img(1)], [target("facebook.photo")]));
    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);
    const order = (await api<CloudOrder>("GET", "/v1/orders/o-3")).body;
    expect(order.status).toBe("failed");
    expect(order.targets[0]?.error?.code).toBe("MEDIA_MISSING");
    expect(h.fake.pagePosts(PAGE)).toHaveLength(0);
  });

  it("marks a permanent failure (revoked token) and stops", async () => {
    const h = await setup();
    await createReadyOrder("o-4", [img(1)], [target("instagram.image")]);
    h.fake.expireToken(`EAAuser${"A".repeat(40)}`);
    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);
    const order = (await api<CloudOrder>("GET", "/v1/orders/o-4")).body;
    expect(order.status).toBe("failed");
    expect(order.targets[0]?.error).toMatchObject({ code: "TOKEN_INVALID", action: "reauth" });
    expect(order.targets[0]?.nextRunAt).toBeNull();
    const log = (await api<CloudPublishLog>("GET", "/v1/orders/o-4/log")).body;
    expect(log.items.at(-1)).toMatchObject({ event: "failed", error: { code: "TOKEN_INVALID" } });
  });

  it("retries transient Graph errors and still publishes once", async () => {
    const h = await setup();
    await createReadyOrder("o-5", [img(1)], [target("facebook.photo")]);
    h.fake.failNext(
      "fb.photos.create",
      { status: 500, code: 2, message: "Service temporarily unavailable", isTransient: true },
      3,
    );
    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);
    const order = (await api<CloudOrder>("GET", "/v1/orders/o-5")).body;
    expect(order.status).toBe("published");
    expect(h.fake.pagePosts(PAGE)).toHaveLength(1);
    expect(h.fake.stats.duplicatePublishAttempts).toBe(0);
  });

  it("resumes after the state machine gives up polling (driver-level retry)", async () => {
    // Meta takes 12 minutes; the machine polls for at most 5, then fails retryably.
    const h = await setup({ imageProcessingMs: 12 * 60_000 });
    await createReadyOrder("o-6", [img(1)], [target("instagram.image")]);
    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);
    const order = (await api<CloudOrder>("GET", "/v1/orders/o-6")).body;
    expect(order.status).toBe("published");
    expect(order.targets[0]?.attempts).toBe(2);
    const log = (await api<CloudPublishLog>("GET", "/v1/orders/o-6/log")).body;
    expect(log.items.map((e) => e.event)).toEqual(["started", "retry_scheduled", "succeeded"]);
    expect(log.items[1]?.error?.code).toBe("PROCESSING_TIMEOUT");
    expect(log.items[1]?.retryAt).toBeTruthy();
    expect(h.fake.igPublishedMedia(IG)).toHaveLength(1);
  });
});

describe("replace and cancel", () => {
  it("replaces an order before it starts, keeping unchanged uploads", async () => {
    const h = await setup();
    await createReadyOrder("o-r", [img(1), img(2)], [target("instagram.carousel")]);
    const oldSha = await sha256Hex(img(2).bytes);
    expect(await env.MEDIA.head(mediaKey("o-r", oldSha))).not.toBeNull();

    const changed = { id: "slide-2.jpg", bytes: fakeJpeg(99) };
    const replaced = await api<CloudOrder>(
      "PUT",
      "/v1/orders/o-r",
      await orderBody([img(1), changed], [target("instagram.carousel")], T0 + 2 * HOUR, {
        caption: "Yeni metin",
      }),
    );
    expect(replaced.status, replaced.text).toBe(200);
    expect(replaced.body.status).toBe("awaiting_media");
    expect(replaced.body.caption).toBe("Yeni metin");
    expect(replaced.body.media.map((m) => m.uploaded)).toEqual([true, false]);
    expect(await env.MEDIA.head(mediaKey("o-r", oldSha))).toBeNull();
    expect(await nextAlarm()).toBe(T0 + 2 * HOUR);

    expect((await upload("o-r", changed)).body.status).toBe("scheduled");

    // Nothing happens at the old time.
    h.clock.t = T0 + HOUR;
    await scheduler().tick();
    expect(h.fake.igPublishedMedia(IG)).toHaveLength(0);

    h.clock.t = T0 + 2 * HOUR;
    await runUntilIdle(h);
    expect((await api<CloudOrder>("GET", "/v1/orders/o-r")).body.status).toBe("published");
    expect(h.fake.igPublishedMedia(IG)[0]?.caption).toBe("Yeni metin");
  });

  it("refuses replace, cancel and uploads once publishing started", async () => {
    const h = await setup();
    await createReadyOrder("o-s", [img(1)], [target("instagram.image")]);
    h.clock.t = T0 + HOUR;
    await scheduler().tick(); // starts, then waits for the container
    const order = (await api<CloudOrder>("GET", "/v1/orders/o-s")).body;
    expect(order.status).toBe("publishing");

    const body = await orderBody([img(1)], [target("instagram.image")], T0 + 3 * HOUR);
    expectError(await api("PUT", "/v1/orders/o-s", body), 409, "conflict");
    expectError(await api("POST", "/v1/orders/o-s/cancel"), 409, "conflict");
    const up = await upload("o-s", img(1));
    expect(up.status).toBe(409);

    await runUntilIdle(h);
    expect((await api<CloudOrder>("GET", "/v1/orders/o-s")).body.status).toBe("published");
  });

  it("replaces a failed order in place for a retry: attempts continue, purged media is re-uploaded", async () => {
    const h = await setup();
    await createReadyOrder("o-f", [img(1)], [target("instagram.image")]);
    h.fake.expireToken(USER_TOKEN);
    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);
    const failed = (await api<CloudOrder>("GET", "/v1/orders/o-f")).body;
    expect(failed.status).toBe("failed");
    expect(failed.targets[0]).toMatchObject({ status: "failed", attempts: 1 });

    // Days later the finished order's media is purged.
    h.clock.t = T0 + HOUR + 4 * 24 * HOUR;
    await scheduler().tick();
    const sha = await sha256Hex(img(1).bytes);
    expect(await env.MEDIA.head(mediaKey("o-f", sha))).toBeNull();

    // The owner reconnects and retries: same order id, nothing new is created.
    h.fake.addUserToken(USER_TOKEN);
    const retryAt = h.clock.t + HOUR;
    const replaced = await api<CloudOrder>(
      "PUT",
      "/v1/orders/o-f",
      await orderBody([img(1)], [target("instagram.image")], retryAt),
    );
    expect(replaced.status, replaced.text).toBe(200);
    expect(replaced.body.status).toBe("awaiting_media");
    expect(replaced.body.media[0]?.uploaded).toBe(false);
    expect(replaced.body.targets[0]).toMatchObject({ status: "pending", attempts: 1, error: null });
    expect((await upload("o-f", img(1))).body.status).toBe("scheduled");
    expect(await nextAlarm()).toBe(retryAt);

    h.clock.t = retryAt;
    await runUntilIdle(h);
    const order = (await api<CloudOrder>("GET", "/v1/orders/o-f")).body;
    expect(order.status).toBe("published");
    expect(order.targets[0]).toMatchObject({ status: "published", attempts: 2 });
    expect(h.fake.igPublishedMedia(IG)).toHaveLength(1);
    const log = (await api<CloudPublishLog>("GET", "/v1/orders/o-f/log")).body;
    expect(log.items.map((e) => `${e.event}:${e.attempt}`)).toEqual([
      "started:1",
      "failed:1",
      "started:2",
      "succeeded:2",
    ]);
    const list = (await api<CloudOrderList>("GET", "/v1/orders?limit=50")).body;
    expect(list.items.map((o) => o.id)).toEqual(["o-f"]);

    // A published order is never replaced.
    expectError(
      await api(
        "PUT",
        "/v1/orders/o-f",
        await orderBody([img(1)], [target("instagram.image")], h.clock.t + HOUR),
      ),
      409,
      "conflict",
    );
  });

  it("cancels before start: nothing is published, media is deleted", async () => {
    const h = await setup();
    await createReadyOrder("o-c", [img(1)], [target("facebook.photo")]);
    const res = await api<CloudOrder>("POST", "/v1/orders/o-c/cancel");
    expect(res.status, res.text).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect(res.body.cancelledAt).toBeTruthy();
    expect(res.body.targets[0]?.status).toBe("cancelled");
    expect(await env.MEDIA.head(mediaKey("o-c", await sha256Hex(img(1).bytes)))).toBeNull();
    expect(await nextAlarm()).toBeNull();

    // Idempotent; replacing or uploading to a cancelled order is refused.
    expect((await api("POST", "/v1/orders/o-c/cancel")).status).toBe(200);
    expectError(
      await api("PUT", "/v1/orders/o-c", await orderBody([img(1)], [target("facebook.photo")])),
      409,
      "conflict",
    );

    h.clock.t = T0 + 2 * HOUR;
    await scheduler().tick();
    expect(h.fake.pagePosts(PAGE)).toHaveLength(0);
    const log = (await api<CloudPublishLog>("GET", "/v1/orders/o-c/log")).body;
    expect(log.items.map((e) => e.event)).toEqual(["cancelled"]);
  });

  it("returns 404 for unknown orders", async () => {
    await setup();
    expectError(await api("GET", "/v1/orders/nope"), 404, "not_found");
    expectError(await api("GET", "/v1/orders/nope/log"), 404, "not_found");
    expectError(await api("POST", "/v1/orders/nope/cancel"), 404, "not_found");
  });
});

describe("validation", () => {
  it("rejects malformed bodies, past times and unpublishable content", async () => {
    await setup();
    const bad = await api("PUT", "/v1/orders/v-1", { contentId: "x" });
    expectError(bad, 400, "validation_error");
    expect((bad.body as { error: { issues: unknown[] } }).error.issues.length).toBeGreaterThan(0);

    const past = await orderBody([img(1)], [target("instagram.image")], T0 - 1000);
    expectError(await api("PUT", "/v1/orders/v-1", past), 400, "validation_error");

    // Pre-flight with @studio/publishers rules: a carousel needs at least two items.
    const carousel = await orderBody([img(1)], [target("instagram.carousel")]);
    const res = await api<{ error: { issues: { path: string }[] } }>(
      "PUT",
      "/v1/orders/v-1",
      carousel,
    );
    expectError(res, 400, "validation_error");
    expect(res.body.error.issues[0]?.path).toMatch(/^targets\.0/);

    const dupTargets = await orderBody(
      [img(1)],
      [target("instagram.image", "t"), target("facebook.photo", "t")],
    );
    expectError(await api("PUT", "/v1/orders/v-1", dupTargets), 400, "validation_error");
  });

  it("verifies uploads against the declared type, size and hash", async () => {
    await setup();
    await api("PUT", "/v1/orders/u-1", await orderBody([img(1)], [target("instagram.image")]));
    expect((await upload("u-1", img(1), "image/png")).status).toBe(415);
    expect((await upload("u-1", { id: "slide-1.jpg", bytes: fakeJpeg(1, 100) })).status).toBe(400);
    const tampered = fakeJpeg(1);
    tampered[100] = (tampered[100] ?? 0) ^ 0xff;
    const bad = await upload("u-1", { id: "slide-1.jpg", bytes: tampered });
    expect(bad.status, bad.text).toBe(400);
    expect((await upload("u-1", { id: "other.jpg", bytes: fakeJpeg(1) })).status).toBe(404);
    expect((await api<CloudOrder>("GET", "/v1/orders/u-1")).body.status).toBe("awaiting_media");
    expect((await upload("u-1", img(1))).status).toBe(200);
  });
});

describe("listing", () => {
  it("lists by updatedAt with status filter, updatedSince and cursor paging", async () => {
    const h = await setup();
    for (const id of ["l-1", "l-2", "l-3"]) {
      await api("PUT", `/v1/orders/${id}`, await orderBody([img(1)], [target("facebook.photo")]));
      h.clock.advance(1000);
    }
    await upload("l-2", img(1));

    const page1 = await api<CloudOrderList>("GET", "/v1/orders?limit=2");
    CloudOrderListSchema.parse(page1.body);
    expect(page1.body.items.map((o) => o.id)).toEqual(["l-1", "l-3"]);
    expect(page1.body.nextCursor).toBeTruthy();
    const page2 = await api<CloudOrderList>(
      "GET",
      `/v1/orders?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor ?? "")}`,
    );
    expect(page2.body.items.map((o) => o.id)).toEqual(["l-2"]);
    expect(page2.body.nextCursor).toBeNull();

    const scheduled = await api<CloudOrderList>("GET", "/v1/orders?status=scheduled");
    expect(scheduled.body.items.map((o) => o.id)).toEqual(["l-2"]);

    const since = new Date(T0 + 2000).toISOString();
    const recent = await api<CloudOrderList>("GET", `/v1/orders?updatedSince=${since}`);
    expect(recent.body.items.map((o) => o.id)).toEqual(["l-3", "l-2"]);

    expectError(await api("GET", "/v1/orders?cursor=garbage"), 400, "validation_error");
    expectError(await api("GET", "/v1/orders?status=nope"), 400, "validation_error");
  });
});
