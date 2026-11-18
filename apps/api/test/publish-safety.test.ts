/**
 * Faz 2 publish safety on the API side: what was approved is what is published (Y3), a
 * schedule is claimed and finished with compare-and-set rules (Y4), the Mac never takes what
 * the cloud holds (Y5), deleting waits for cloud cancels (Y6), cancel/approval loss sync at
 * once and a too-late cancel records the truth (Y9), publish-now checks every account first
 * (Y10), the maximum lateness (Y12), token expiry against the publish time (Y13), a
 * reconnected account's orders are pushed again (Y14), Instagram expiry (Y16), https only (G12).
 */
import { env } from "cloudflare:workers";
import {
  Asset,
  Content,
  ContentVersion,
  PublishingStatus,
  PublishNowResult,
  Schedule,
  SchedulePreflight,
  type SocialAccount,
  WorkerDueSchedules,
  WorkerPublishingConfig,
  WorkerScheduleClaimResult,
} from "@studio/contract";
import { FakeGraph } from "@studio/publishers/testing";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.ts";
import { publishingSettings, schedules } from "../src/db/schema.ts";
import {
  addVersion,
  api,
  approvedContent,
  BASE,
  createAccount,
  createBrand,
  createContent,
  expectError,
  inOneHour,
  localFetch,
  slide,
} from "./helpers.ts";

const AUTH = () => ({ Authorization: `Bearer ${env.WORKER_TOKEN}` });

async function worker<T>(method: string, path: string, body?: unknown) {
  const res = await localFetch(`${BASE}${path}`, {
    method,
    headers: { ...AUTH(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

async function uploadImage(brandId: string): Promise<Asset> {
  const form = new FormData();
  form.set("brandId", brandId);
  form.set("file", new File([PNG], "render.png", { type: "image/png" }));
  const res = await localFetch(`${BASE}/api/assets`, { method: "POST", body: form });
  expect(res.status).toBe(201);
  return Asset.parse(await res.json());
}

async function schedule(contentId: string, socialAccountId: string, scheduledAt = inOneHour()) {
  const res = await api("POST", "/api/schedules", { contentId, socialAccountId, scheduledAt });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return Schedule.parse(res.body);
}

async function scheduled() {
  const brand = await createBrand();
  const account = await createAccount(brand.id);
  const { content, version } = await approvedContent(brand.id);
  const s = await schedule(content.id, account.id);
  return { brand, account, content, version, s };
}

async function syncRequestedAt(): Promise<string | null> {
  return PublishingStatus.parse((await api("GET", "/api/publishing/status")).body).cloud
    .syncRequestedAt;
}

/** Move a schedule's time (past times cannot be set through the API). */
async function setScheduledAt(id: string, at: Date) {
  await createDb(env.DB).update(schedules).set({ scheduledAt: at }).where(eq(schedules.id, id));
}

describe("approved renders are frozen (Y3)", () => {
  it("refuses to replace a render of the approved version; fills, layouts and other versions pass", async () => {
    const brand = await createBrand();
    const account = await createAccount(brand.id);
    const content = await createContent(brand.id);
    const approvedRender = await uploadImage(brand.id);
    const other = await uploadImage(brand.id);
    const v = await addVersion(content.id, {
      slides: [slide("<html><body>onay</body></html>")],
      renderedAssetIds: [approvedRender.id],
    });
    expect(
      (await api("POST", `/api/contents/${content.id}/approve`, { hash: v.contentHash })).status,
    ).toBe(200);
    const s = await schedule(content.id, account.id);

    const swap = await api("PATCH", `/api/contents/${content.id}/versions/${v.version}`, {
      renderedAssetIds: [other.id],
    });
    expectError(swap, 409, "invalid_transition");
    const removed = await api("PATCH", `/api/contents/${content.id}/versions/${v.version}`, {
      renderedAssetIds: [null],
    });
    expectError(removed, 409, "invalid_transition");
    // Nothing changed: same render, still scheduled and approved.
    const kept = ContentVersion.parse(
      (await api("GET", `/api/contents/${content.id}/versions/${v.version}`)).body,
    );
    expect(kept.slides[0]?.renderedAssetId).toBe(approvedRender.id);
    expect(Content.parse((await api("GET", `/api/contents/${content.id}`)).body).status).toBe(
      "scheduled",
    );
    expect(Schedule.parse((await api("GET", `/api/schedules/${s.id}`)).body).status).toBe(
      "pending",
    );

    // The same render with measured layouts, and the note, are fine.
    const same = await api("PATCH", `/api/contents/${content.id}/versions/${v.version}`, {
      renderedAssetIds: [approvedRender.id],
      layouts: [null],
      note: "ölçüldü",
    });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
  });

  it("lets a missing render of the approved version be filled in", async () => {
    const brand = await createBrand();
    const { content, version } = await approvedContent(brand.id);
    expect(version.slides[0]?.renderedAssetId).toBeNull();
    const render = await uploadImage(brand.id);
    const filled = await api("PATCH", `/api/contents/${content.id}/versions/${version.version}`, {
      renderedAssetIds: [render.id],
    });
    expect(filled.status, JSON.stringify(filled.body)).toBe(200);
    // Not on an older, unapproved version either: that one changes freely.
    const v2 = await addVersion(content.id, { slides: [slide("<html><body>v2</body></html>")] });
    expect(v2.version).toBe(version.version + 1);
    const other = await uploadImage(brand.id);
    const old = await api("PATCH", `/api/contents/${content.id}/versions/${version.version}`, {
      renderedAssetIds: [other.id],
    });
    expect(old.status, JSON.stringify(old.body)).toBe(200);
  });
});

describe("claims and outcomes (Y4)", () => {
  it("refuses credentials for a cancelled schedule", async () => {
    const { s } = await scheduled();
    expect((await worker("GET", `/api/worker/schedules/${s.id}/credentials`)).status).toBe(200);
    await api("POST", `/api/schedules/${s.id}/cancel`);
    const res = await worker<{ error: { code: string } }>(
      "GET",
      `/api/worker/schedules/${s.id}/credentials`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("invalid_transition");
  });

  it("claims once, saves the publisher state and lets a stale claim resume it", async () => {
    const { s } = await scheduled();
    await setScheduledAt(s.id, new Date(Date.now() - 60_000));
    const first = WorkerScheduleClaimResult.parse(
      (await worker("POST", `/api/worker/schedules/${s.id}/claim`, { attempt: 1 })).body,
    );
    expect(first).toMatchObject({
      claimed: true,
      resumed: false,
      publishState: null,
      schedule: { status: "publishing", delivery: "local" },
    });
    const second = WorkerScheduleClaimResult.parse(
      (await worker("POST", `/api/worker/schedules/${s.id}/claim`, {})).body,
    );
    expect(second).toMatchObject({ claimed: false, reason: "in_progress" });

    const saved = await worker("PUT", `/api/worker/schedules/${s.id}/publish-state`, {
      state: { v: 1, phase: "publish", intentAt: 1 },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain("intentAt");

    const stale = WorkerDueSchedules.parse(
      (await worker("GET", "/api/worker/schedules/stale?staleAfterMs=0")).body,
    );
    expect(stale.items.map((i) => i.id)).toContain(s.id);
    const resumed = WorkerScheduleClaimResult.parse(
      (await worker("POST", `/api/worker/schedules/${s.id}/claim`, { staleAfterMs: 0 })).body,
    );
    expect(resumed).toMatchObject({
      claimed: true,
      resumed: true,
      publishState: { v: 1, phase: "publish", intentAt: 1 },
      attempt: first.attempt,
    });

    const done = await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "published",
      attempt: resumed.attempt,
      externalPostId: "urn:li:share:1",
    });
    expect(Schedule.parse(done.body).status).toBe("published");
    // Published is final: a late failure or another claim changes nothing.
    const late = await worker<{ error: { code: string } }>(
      "POST",
      `/api/worker/schedules/${s.id}/outcome`,
      { status: "failed", attempt: 1, error: "x" },
    );
    expect(late.status).toBe(409);
    const again = WorkerScheduleClaimResult.parse(
      (await worker("POST", `/api/worker/schedules/${s.id}/claim`, { staleAfterMs: 0 })).body,
    );
    expect(again).toMatchObject({ claimed: false, reason: "published" });
    expect(
      (await worker("PUT", `/api/worker/schedules/${s.id}/publish-state`, { state: { v: 1 } }))
        .status,
    ).toBe(409);
  });

  it("refuses to claim a schedule handed to the cloud, and a cancelled local one takes no outcome", async () => {
    const { s } = await scheduled();
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: new Date().toISOString(),
    });
    const claim = WorkerScheduleClaimResult.parse(
      (await worker("POST", `/api/worker/schedules/${s.id}/claim`, {})).body,
    );
    expect(claim).toMatchObject({ claimed: false, reason: "cloud" });

    const other = await scheduled();
    await api("POST", `/api/schedules/${other.s.id}/cancel`);
    const res = await worker<{ error: { code: string } }>(
      "POST",
      `/api/worker/schedules/${other.s.id}/outcome`,
      { status: "published", attempt: 1 },
    );
    expect(res.status).toBe(409);
  });

  it("does not restart a publish left half-way by a worker from before claims existed", async () => {
    const { s } = await scheduled();
    await createDb(env.DB)
      .update(schedules)
      .set({ status: "publishing", delivery: null, claimedAt: null })
      .where(eq(schedules.id, s.id));
    const stale = WorkerDueSchedules.parse(
      (await worker("GET", "/api/worker/schedules/stale")).body,
    );
    expect(stale.items.map((i) => i.id)).toContain(s.id);
    const claim = WorkerScheduleClaimResult.parse(
      (await worker("POST", `/api/worker/schedules/${s.id}/claim`, {})).body,
    );
    expect(claim).toMatchObject({
      claimed: false,
      reason: "failed",
      schedule: { status: "failed" },
    });
    expect(claim.schedule.lastError).toMatch(/platformda kontrol edin/);
  });

  it("keeps the saved state when a failed schedule is retried with the same design", async () => {
    const { content, account, s } = await scheduled();
    await setScheduledAt(s.id, new Date(Date.now() - 60_000));
    await worker("POST", `/api/worker/schedules/${s.id}/claim`, {});
    await worker("PUT", `/api/worker/schedules/${s.id}/publish-state`, {
      state: { v: 1, phase: "create_post", intentAt: 5, postCalls: 1 },
    });
    await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "failed",
      attempt: 1,
      error: "LinkedIn'e bağlanılamadı",
    });
    const retried = await schedule(
      content.id,
      account.id,
      new Date(Date.now() + 5_000).toISOString(),
    );
    expect(retried.id).toBe(s.id);
    await setScheduledAt(s.id, new Date(Date.now() - 1_000));
    const claim = WorkerScheduleClaimResult.parse(
      (await worker("POST", `/api/worker/schedules/${s.id}/claim`, {})).body,
    );
    expect(claim).toMatchObject({
      claimed: true,
      publishState: { phase: "create_post", postCalls: 1 },
    });
  });
});

describe("cloud-held schedules and an unreadable cloud token (Y5)", () => {
  it("leaves schedules handed to the cloud out of the local due list", async () => {
    const { s } = await scheduled();
    const before = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const q = `/api/worker/schedules/due?mode=local&before=${encodeURIComponent(before)}`;
    expect(
      WorkerDueSchedules.parse((await worker("GET", q)).body).items.map((i) => i.id),
    ).toContain(s.id);
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: new Date().toISOString(),
    });
    expect(
      WorkerDueSchedules.parse((await worker("GET", q)).body).items.map((i) => i.id),
    ).not.toContain(s.id);
    // The cloud push loop still sees it.
    expect(
      WorkerDueSchedules.parse((await worker("GET", "/api/worker/schedules/due")).body).items.map(
        (i) => i.id,
      ),
    ).toContain(s.id);
  });

  it("answers 409 instead of 'no cloud publisher' when the cloud token cannot be read", async () => {
    await createDb(env.DB)
      .insert(publishingSettings)
      .values({
        id: "main",
        cloudUrl: "https://publish.example.test",
        cloudTokenCiphertext: "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0",
        cloudTokenIv: "AAAAAAAAAAAAAAAA",
        cloudTokenKeyVersion: 2,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: publishingSettings.id,
        set: {
          cloudUrl: "https://publish.example.test",
          cloudTokenCiphertext: "bm90LWEtcmVhbC1jaXBoZXJ0ZXh0",
          cloudTokenIv: "AAAAAAAAAAAAAAAA",
          cloudTokenKeyVersion: 2,
        },
      });
    const res = await worker<{ error: { code: string; message: string } }>(
      "GET",
      "/api/worker/publishing/config",
    );
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain("çözülemedi");
    // The worker can still report that round's failure.
    const report = await worker("POST", "/api/worker/publishing/report", {
      ok: false,
      error: "çözülemedi",
    });
    expect(report.status).toBe(200);
    await createDb(env.DB).delete(publishingSettings).where(eq(publishingSettings.id, "main"));
  });

  it("refuses to forget the cloud publisher while it holds schedules (unless forced)", async () => {
    const { s } = await scheduled();
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: new Date().toISOString(),
    });
    const refused = await api("DELETE", "/api/publishing/cloud");
    expect(expectError(refused, 409, "conflict").message).toMatch(/Bulut yayıncıda \d+ zamanlama/);
    const forced = await api("DELETE", "/api/publishing/cloud?force=true");
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
  });
});

describe("delete waits for the cloud cancel (Y6) and cancels sync at once (Y9)", () => {
  it("refuses to delete content while a cancelled schedule's cloud order is not cancelled yet", async () => {
    const { content, s } = await scheduled();
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: new Date().toISOString(),
    });
    const before = Date.now();
    expect((await api("POST", `/api/schedules/${s.id}/cancel`)).status).toBe(200);
    expect(Date.parse((await syncRequestedAt()) ?? "")).toBeGreaterThanOrEqual(before);

    const refused = await api("DELETE", `/api/contents/${content.id}`);
    expect(expectError(refused, 409, "conflict").message).toMatch(/bulut yayıncıya henüz/);
    // The worker cancelled it there.
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: null,
    });
    expect((await api("DELETE", `/api/contents/${content.id}`)).status).toBe(204);
  });

  it("records the cloud's outcome of a schedule cancelled too late", async () => {
    const { content, s } = await scheduled();
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: new Date().toISOString(),
    });
    await api("POST", `/api/schedules/${s.id}/cancel`);
    const res = await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "published",
      attempt: 1,
      externalPostId: "17890001",
      permalink: "https://www.instagram.com/p/LATE/",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Schedule.parse(res.body)).toMatchObject({
      status: "published",
      permalink: "https://www.instagram.com/p/LATE/",
    });
    expect(Content.parse((await api("GET", `/api/contents/${content.id}`)).body).status).toBe(
      "published",
    );
  });

  it("asks for a sync when approval is lost (a new version cancels the schedules)", async () => {
    const { content, s } = await scheduled();
    // Pin the last request in the past, so the new one is clearly this edit's.
    await createDb(env.DB)
      .update(publishingSettings)
      .set({ syncRequestedAt: new Date(0) })
      .where(eq(publishingSettings.id, "main"));
    const before = Date.now();
    await addVersion(content.id, { slides: [slide("<html><body>yeni</body></html>")] });
    expect(Schedule.parse((await api("GET", `/api/schedules/${s.id}`)).body).status).toBe(
      "cancelled",
    );
    expect(Date.parse((await syncRequestedAt()) ?? "")).toBeGreaterThanOrEqual(before);
  });
});

describe("publish now checks every account first (Y10)", () => {
  it("creates nothing when one of the accounts is refused", async () => {
    const brand = await createBrand();
    const ig = await createAccount(brand.id);
    const fb = await createAccount(brand.id, { platform: "facebook", handle: "MTM" });
    const { content } = await approvedContent(brand.id); // targets Instagram only
    const res = await api("POST", "/api/schedules/publish-now", {
      contentId: content.id,
      socialAccountIds: [ig.id, fb.id],
    });
    expect(res.status).toBe(409);
    const list = (await api<{ items: Schedule[] }>("GET", `/api/schedules?contentId=${content.id}`))
      .body.items;
    expect(list).toHaveLength(0);
    // Both valid: both queued.
    const ok = await api("POST", "/api/schedules/publish-now", {
      contentId: content.id,
      socialAccountIds: [ig.id],
    });
    expect(PublishNowResult.parse(ok.body).jobs).toHaveLength(1);
  });
});

describe("maximum lateness (Y12)", () => {
  it("marks a schedule claimed far past its time as missed instead of publishing it", async () => {
    const { content, s } = await scheduled();
    await setScheduledAt(s.id, new Date(Date.now() - 3 * 3_600_000));
    const claim = WorkerScheduleClaimResult.parse(
      (await worker("POST", `/api/worker/schedules/${s.id}/claim`, {})).body,
    );
    expect(claim).toMatchObject({
      claimed: false,
      reason: "missed",
      schedule: { status: "failed" },
    });
    expect(claim.schedule.lastError).toMatch(/^Mac kapalıyken kaçtı: paylaşım saatinden 2 saatten/);
    const logs = (
      await api<{ items: { status: string; error: string | null }[] }>(
        "GET",
        `/api/schedules/${s.id}/logs`,
      )
    ).body.items;
    expect(logs.map((l) => l.status)).toEqual(["failed"]);
    expect(Content.parse((await api("GET", `/api/contents/${content.id}`)).body).status).toBe(
      "failed",
    );
  });

  it("is a setting the worker receives", async () => {
    const saved = await api("PATCH", "/api/publishing/settings", { maxLatenessMinutes: 30 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(PublishingStatus.parse(saved.body).maxLatenessMinutes).toBe(30);
    const cfg = WorkerPublishingConfig.parse(
      (await worker("GET", "/api/worker/publishing/config")).body,
    );
    expect(cfg.maxLatenessMs).toBe(30 * 60_000);
    expectError(
      await api("PATCH", "/api/publishing/settings", { maxLatenessMinutes: 1 }),
      400,
      "validation_error",
    );
    await api("PATCH", "/api/publishing/settings", { maxLatenessMinutes: 120 });
  });
});

describe("token expiry and reconnects (Y13, Y14)", () => {
  it("refuses a schedule whose token runs out before the publish time", async () => {
    const brand = await createBrand();
    const account = await createAccount(brand.id);
    const expiresAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    expect(
      (
        await api("PUT", `/api/social-accounts/${account.id}/token`, {
          accessToken: "EAAtoken0000000000000001",
          expiresAt,
        })
      ).status,
    ).toBe(200);
    const { content } = await approvedContent(brand.id);
    const pf = async (at: string) =>
      SchedulePreflight.parse(
        (
          await api("POST", "/api/schedules/preflight", {
            contentId: content.id,
            socialAccountIds: [account.id],
            scheduledAt: at,
          })
        ).body,
      );
    const late = await pf(new Date(Date.now() + 5 * 86_400_000).toISOString());
    expect(late.ok).toBe(false);
    expect(late.targets[0]?.errors.map((e) => e.code)).toContain("TOKEN_EXPIRES_BEFORE_PUBLISH");
    const soon = await pf(inOneHour());
    expect(soon.targets[0]?.errors.map((e) => e.code)).not.toContain(
      "TOKEN_EXPIRES_BEFORE_PUBLISH",
    );
    expect(soon.targets[0]?.warnings.map((w) => w.code)).toContain("TOKEN_EXPIRING");
  });

  it("marks a reconnected account's cloud orders for a push with the new token", async () => {
    const { account, s } = await scheduled();
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: new Date().toISOString(),
    });
    const res = await api("PUT", `/api/social-accounts/${account.id}/token`, {
      accessToken: "EAAnewtoken00000000000002",
    });
    expect(res.status).toBe(200);
    expect(Schedule.parse((await api("GET", `/api/schedules/${s.id}`)).body)).toMatchObject({
      status: "pending",
      delivery: "cloud",
      cloudSyncedAt: null,
    });
  });
});

describe("Instagram token expiry follows the Page token (Y16)", () => {
  it("stores no expiry for an Instagram account connected with a long-lived login", async () => {
    const fake = new FakeGraph({ imageProcessingMs: 0 });
    fake.clock.now = () => Date.now();
    fake.addPage("5101", "EAApage510100000000000000001", { name: "MTM", igUserId: "1785101" });
    const user = "EAAlonglived0000000000000001";
    fake.addUserToken(user);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "graph.facebook.com") return fake.fetch(input as string, init);
      return realFetch(input, init);
    }) as typeof fetch;
    const brand = await createBrand();
    const disc = await api("POST", "/api/social-accounts/meta/discover", {
      brandId: brand.id,
      userAccessToken: user,
      userTokenExpiresAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      autoConnect: true,
    });
    expect(disc.status, JSON.stringify(disc.body)).toBe(200);
    const accounts = (disc.body as { connectedAccounts: SocialAccount[] }).connectedAccounts;
    const ig = accounts.find((a) => a.platform === "instagram");
    const fb = accounts.find((a) => a.platform === "facebook");
    expect(fb?.tokenExpiresAt ?? null).toBeNull();
    expect(ig?.tokenExpiresAt ?? null).toBeNull();
  });
});

describe("cloud publisher URL must be https (G12)", () => {
  it("refuses http:// except for this machine", async () => {
    const res = await api("PUT", "/api/publishing/cloud", {
      url: "http://publish.example.test",
      token: "cloud-token-0123456789abcdef",
    });
    expectError(res, 400, "validation_error");
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "127.0.0.1" && url.port === "8788") {
        if (url.pathname === "/health") return Response.json({ ok: true });
        return Response.json({ items: [], nextCursor: null });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const local = await api("PUT", "/api/publishing/cloud", {
      url: "http://127.0.0.1:8788",
      token: "cloud-token-0123456789abcdef",
    });
    expect(local.status, JSON.stringify(local.body)).toBe(200);
    await api("DELETE", "/api/publishing/cloud?force=true");
  });
});
