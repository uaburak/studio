/**
 * Scheduler reliability: media that arrives after the publish time ("publish now"), the
 * maximum lateness (`notAfter`), one broken target not stopping the others, and the refusal
 * to run with the development PUBLIC_BASE_URL on a real hostname.
 */

import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { CloudOrder } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { app, deploymentProblem } from "../src/app.ts";
import { MEDIA_GRACE_MS, type Scheduler } from "../src/scheduler.ts";
import {
  AUTH,
  api,
  createReadyOrder,
  fakeJpeg,
  HOUR,
  IG,
  orderBody,
  PAGE,
  runUntilIdle,
  scheduler,
  setup,
  T0,
  target,
  upload,
} from "./helpers.ts";

const img = (n: number) => ({ id: `slide-${n}.jpg`, bytes: fakeJpeg(n) });

async function tick() {
  await runInDurableObject(scheduler(), (instance: Scheduler) => instance.tick());
}

describe("media arriving after the publish time (Y8)", () => {
  it("waits for the upload instead of failing, then publishes", async () => {
    const h = await setup();
    const created = await api("PUT", "/v1/orders/late-media", {
      ...(await orderBody([img(1)], [target("instagram.image")])),
    });
    expect(created.status).toBe(201);

    // Due, but the Mac is still uploading: the target waits.
    h.clock.t = T0 + HOUR + 30_000;
    await tick();
    let order = (await api<CloudOrder>("GET", "/v1/orders/late-media")).body;
    expect(order.status).toBe("awaiting_media");
    expect(order.targets[0]).toMatchObject({ status: "pending", error: null });

    expect((await upload("late-media", img(1))).status).toBe(200);
    await runUntilIdle(h);
    order = (await api<CloudOrder>("GET", "/v1/orders/late-media")).body;
    expect(order.status).toBe("published");
    expect(h.fake.igPublishedMedia(IG)).toHaveLength(1);
  });

  it("gives up only after the bounded grace", async () => {
    const h = await setup();
    await api("PUT", "/v1/orders/never", await orderBody([img(1)], [target("facebook.photo")]));
    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);
    const order = (await api<CloudOrder>("GET", "/v1/orders/never")).body;
    expect(order.targets[0]?.error?.code).toBe("MEDIA_MISSING");
    const log = (
      await api<{ items: { event: string; at: string }[] }>("GET", "/v1/orders/never/log")
    ).body.items;
    const failedAt = Date.parse(log.find((e) => e.event === "failed")?.at ?? "");
    expect(failedAt).toBeGreaterThanOrEqual(T0 + HOUR + MEDIA_GRACE_MS);
    expect(h.fake.pagePosts(PAGE)).toHaveLength(0);
  });
});

describe("maximum lateness (Y12)", () => {
  it("does not publish an order whose notAfter passed (the publisher was down)", async () => {
    const h = await setup();
    const body = await orderBody([img(1)], [target("instagram.image")], T0 + HOUR, {
      notAfter: new Date(T0 + 3 * HOUR).toISOString(),
    });
    expect((await api("PUT", "/v1/orders/missed", body)).status).toBe(201);
    expect((await upload("missed", img(1))).status).toBe(200);

    // The scheduler wakes up four hours after the publish time.
    h.clock.t = T0 + 5 * HOUR;
    await tick();
    const order = (await api<CloudOrder>("GET", "/v1/orders/missed")).body;
    expect(order.status).toBe("failed");
    expect(order.targets[0]?.error).toMatchObject({ code: "MISSED", action: "manual_check" });
    expect(h.fake.igPublishedMedia(IG)).toHaveLength(0);
  });

  it("still publishes within the limit", async () => {
    const h = await setup();
    await createReadyOrder("in-time", [img(1)], [target("instagram.image")]);
    h.clock.t = T0 + HOUR + 30 * 60_000;
    await runUntilIdle(h);
    expect((await api<CloudOrder>("GET", "/v1/orders/in-time")).body.status).toBe("published");
  });
});

describe("one broken target (Y11)", () => {
  it("fails only the target whose token cannot be decrypted; the others publish", async () => {
    const h = await setup();
    await createReadyOrder("broken", [img(1)], [target("instagram.image")]);
    await createReadyOrder("healthy", [img(2)], [target("facebook.photo")]);
    // A token sealed with another key (or corrupted) in the first order.
    await runInDurableObject(scheduler(), (_i: Scheduler, state) => {
      state.storage.sql.exec(
        "UPDATE targets SET token = ? WHERE order_id = 'broken'",
        "djE.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAA",
      );
    });
    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);

    const broken = (await api<CloudOrder>("GET", "/v1/orders/broken")).body;
    expect(broken.targets[0]).toMatchObject({ status: "failed" });
    expect(broken.targets[0]?.error?.code).toBe("TOKEN_UNREADABLE");
    const healthy = (await api<CloudOrder>("GET", "/v1/orders/healthy")).body;
    expect(healthy.status).toBe("published");
    expect(h.fake.pagePosts(PAGE)).toHaveLength(1);
  });
});

describe("deployment check (Y16)", () => {
  it("refuses a real hostname with the development PUBLIC_BASE_URL", async () => {
    const devEnv = { ...env, PUBLIC_BASE_URL: "http://127.0.0.1:8788" };
    const health = await app.fetch(
      new Request("https://studio-publisher.example.workers.dev/health"),
      devEnv,
    );
    expect(health.status).toBe(503);
    const orders = await app.fetch(
      new Request("https://studio-publisher.example.workers.dev/v1/orders", { headers: AUTH }),
      devEnv,
    );
    expect(orders.status).toBe(503);
    expect(await orders.text()).not.toContain("test-publisher-token");
  });

  it("runs locally (wrangler dev) and with an https base", async () => {
    const devEnv = { ...env, PUBLIC_BASE_URL: "http://127.0.0.1:8788" };
    expect((await app.fetch(new Request("http://127.0.0.1:8788/health"), devEnv)).status).toBe(200);
    expect(
      deploymentProblem(
        { PUBLIC_BASE_URL: "https://publisher.example.com" },
        "https://publisher.example.com/health",
      ),
    ).toBeNull();
    expect(
      deploymentProblem(
        { PUBLIC_BASE_URL: "http://publisher.example.com" },
        "https://publisher.example.com/health",
      ),
    ).toMatch(/https/);
  });
});
