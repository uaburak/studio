/**
 * Crash safety: for several content types, kill the driver right after each
 * step's Graph calls happened but before its result was persisted, then let
 * the next wake-up resume from storage. Nothing may be published twice and
 * every run must still finish.
 */

import type { CloudOrder } from "@studio/contract";
import { describe, expect, it } from "vitest";
import {
  api,
  createReadyOrder,
  fakeJpeg,
  type Harness,
  HOUR,
  IG,
  type Kind,
  PAGE,
  runUntilIdle,
  setup,
  T0,
  target,
} from "./helpers.ts";

const img = (n: number) => ({ id: `slide-${n}.jpg`, bytes: fakeJpeg(n) });

const CASES: { kind: Kind; files: number }[] = [
  { kind: "instagram.image", files: 1 },
  { kind: "instagram.carousel", files: 2 },
  { kind: "facebook.photo", files: 1 },
  { kind: "facebook.multi_photo", files: 3 },
];

function publishedCount(h: Harness, kind: Kind) {
  return kind.startsWith("instagram.")
    ? h.fake.igPublishedMedia(IG).length
    : h.fake.pagePosts(PAGE).length;
}

async function publishOnce(kind: Kind, files: number, crashAt: number | null) {
  const h = await setup();
  const media = Array.from({ length: files }, (_, i) => img(i + 1));
  await createReadyOrder("crash", media, [target(kind)]);
  h.hooks.beforePersist = () => {
    if (h.steps - 1 === crashAt) throw new Error("simulated crash");
  };
  h.clock.t = T0 + HOUR;
  const crashes = await runUntilIdle(h);
  const order = (await api<CloudOrder>("GET", "/v1/orders/crash")).body;
  return { h, order, crashes };
}

describe("resume after a crash at each step", () => {
  it.each(CASES)("$kind", async ({ kind, files }) => {
    const baseline = await publishOnce(kind, files, null);
    expect(baseline.order.status).toBe("published");
    const total = baseline.h.steps;
    expect(total).toBeGreaterThan(1);

    for (let crashAt = 0; crashAt < total; crashAt++) {
      const { h, order, crashes } = await publishOnce(kind, files, crashAt);
      const label = `${kind} crash@${crashAt}`;
      expect(crashes, label).toBe(1);
      expect(order.status, label).toBe("published");
      expect(publishedCount(h, kind), label).toBe(1);
      expect(h.fake.stats.duplicatePublishAttempts, label).toBe(0);
      expect(order.targets[0]?.externalId, label).toBeTruthy();
    }
  });
});

describe("lost response on the publish call", () => {
  it("reconciles instead of publishing again", async () => {
    const h = await setup();
    await createReadyOrder("lost", [img(1)], [target("instagram.image")]);
    h.fake.dropResponse("ig.media_publish");
    h.clock.t = T0 + HOUR;
    await runUntilIdle(h);
    const order = (await api<CloudOrder>("GET", "/v1/orders/lost")).body;
    expect(order.status).toBe("published");
    expect(h.fake.igPublishedMedia(IG)).toHaveLength(1);
    expect(h.fake.routeCalls("ig.media_publish")).toHaveLength(1);
    expect(order.targets[0]?.externalId).toBe(h.fake.igPublishedMedia(IG)[0]?.id);
  });
});
