import { env } from "cloudflare:workers";
import {
  Job,
  MetaExchangeResult,
  PublishingStatus,
  PublishLogFeed,
  PublishNowResult,
  Schedule,
  SchedulePreflight,
  SocialAccount,
  WorkerDueSchedules,
  WorkerPublishingConfig,
  WorkerScheduleCredentials,
} from "@studio/contract";
import { FakeGraph } from "@studio/publishers/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../src/db/client.ts";
import { schedules, socialAccountTokens } from "../src/db/schema.ts";
import { busiestDayWith, preflightTargets } from "../src/lib/preflight.ts";
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
} from "./helpers.ts";
import { legacySeal } from "./token-vault.test.ts";

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
  vi.restoreAllMocks();
});

/**
 * Route the API's outbound Graph calls to FakeGraph. FakeGraph does not model the
 * authorization-code grant, so `code=` exchanges are answered here with a fresh
 * short-lived user token registered in the fake.
 */
function installFakeMeta(fake: FakeGraph, code: string) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "graph.facebook.com") {
      if (url.pathname.endsWith("/oauth/access_token") && url.searchParams.has("code")) {
        if (url.searchParams.get("code") !== code) {
          return Response.json(
            { error: { message: "Invalid verification code", code: 100 } },
            { status: 400 },
          );
        }
        const short = "EAAshort000000000000000000001";
        fake.addUserToken(short, { expiresAt: fake.clock.now() + 3600_000 });
        return Response.json({ access_token: short, token_type: "bearer", expires_in: 3600 });
      }
      return fake.fetch(input as Request | string | URL, init);
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

describe("Meta connect: code exchange, page picking, health, disconnect", () => {
  it("exchanges the login code, lists Pages without tokens and connects only the picked account", async () => {
    const fake = new FakeGraph({ imageProcessingMs: 0 });
    fake.clock.now = () => Date.now();
    fake.addPage("5001", "EAApage500100000000000000001", { name: "MTM Agro", igUserId: "1784001" });
    fake.addPage("5002", "EAApage500200000000000000001", { name: "Diğer Sayfa" });
    installFakeMeta(fake, "login-code-1");

    const brand = await createBrand();
    const ex = await api("POST", "/api/social-accounts/meta/exchange", {
      appId: fake.opts.appId,
      appSecret: fake.opts.appSecret,
      code: "login-code-1",
      redirectUri: "http://localhost:8793/meta/callback",
    });
    expect(ex.status, JSON.stringify(ex.body)).toBe(200);
    const exchanged = MetaExchangeResult.parse(ex.body);
    expect(exchanged.longLived).toBe(true);
    expect(exchanged.userAccessToken.startsWith("EAAlong")).toBe(true);
    expect(exchanged.pages.map((p) => p.pageId).sort()).toEqual(["5001", "5002"]);
    expect(JSON.stringify(exchanged.pages)).not.toContain("EAApage");

    // Pick only the Instagram account of the first Page.
    const disc = await api("POST", "/api/social-accounts/meta/discover", {
      brandId: brand.id,
      userAccessToken: exchanged.userAccessToken,
      userTokenExpiresAt: exchanged.expiresAt,
      selections: [{ pageId: "5001", facebook: false, instagram: true }],
    });
    expect(disc.status, JSON.stringify(disc.body)).toBe(200);
    const connected = (disc.body as { connectedAccounts: SocialAccount[] }).connectedAccounts;
    expect(connected).toHaveLength(1);
    expect(connected[0]).toMatchObject({
      platform: "instagram",
      externalId: "1784001",
      handle: "@ig_1784001",
      status: "connected",
      hasToken: true,
      tokenHealth: "valid",
    });
    const ig = connected[0] as SocialAccount;

    // Stored with the per-install key (key_version 2), never in clear.
    const row = await createDb(env.DB).query.socialAccountTokens.findFirst({
      where: (t, { eq }) => eq(t.socialAccountId, ig.id),
    });
    expect(row?.keyVersion).toBe(2);
    expect(row?.ciphertext).not.toContain("EAApage");

    // Live health with the app token (debug_token): valid, then revoked -> needs_reauth.
    const live = await api("POST", `/api/social-accounts/${ig.id}/check`, {
      live: true,
      appId: fake.opts.appId,
      appSecret: fake.opts.appSecret,
    });
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    expect(SocialAccount.parse(live.body).tokenHealth).toBe("valid");
    const pageToken = fake.tokens.get("EAApage500100000000000000001");
    if (pageToken) pageToken.revoked = true;
    const bad = SocialAccount.parse(
      (
        await api("POST", `/api/social-accounts/${ig.id}/check`, {
          live: true,
          appId: fake.opts.appId,
          appSecret: fake.opts.appSecret,
        })
      ).body,
    );
    expect(bad).toMatchObject({ tokenHealth: "invalid", status: "needs_reauth" });

    // Disconnect is refused while a schedule is pending, then deletes the token.
    if (pageToken) pageToken.revoked = false;
    const { content } = await approvedContent(brand.id);
    const sched = Schedule.parse(
      (
        await api("POST", "/api/schedules", {
          contentId: content.id,
          socialAccountId: ig.id,
          scheduledAt: inOneHour(),
        })
      ).body,
    );
    expectError(await api("POST", `/api/social-accounts/${ig.id}/disconnect`), 409, "conflict");
    await api("POST", `/api/schedules/${sched.id}/cancel`);
    const off = await api("POST", `/api/social-accounts/${ig.id}/disconnect`);
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(SocialAccount.parse(off.body)).toMatchObject({ status: "disabled", hasToken: false });
  });

  it("rejects a wrong login code with a Turkish message", async () => {
    const fake = new FakeGraph();
    installFakeMeta(fake, "right-code");
    const res = await api("POST", "/api/social-accounts/meta/exchange", {
      appId: fake.opts.appId,
      appSecret: fake.opts.appSecret,
      code: "wrong-code",
      redirectUri: "http://localhost:8793/meta/callback",
    });
    const err = expectError(res, 400, "validation_error");
    expect(err.message).toContain("Facebook girişi tamamlanamadı");
    expect(err.message).not.toContain(fake.opts.appSecret);
  });

  it("is Mac-only", async () => {
    const res = await localFetch(`${BASE}/api/social-accounts/meta/exchange`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "192.168.1.20",
        ...AUTH(),
      },
      body: JSON.stringify({ appId: "1", accessToken: "EAAxxxxxxxxxxxx" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("LinkedIn OAuth", () => {
  it("exchanges the code, reads the member and vaults a 60-day token", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}`);
      if (url.host === "www.linkedin.com" && url.pathname === "/oauth/v2/accessToken") {
        const form = new URLSearchParams(String(init?.body));
        if (form.get("client_secret") !== "li-secret-1" || form.get("code") !== "li-code") {
          return Response.json({ error: "invalid_request" }, { status: 400 });
        }
        return Response.json({
          access_token: "AQVmember0000000001",
          expires_in: 5184000,
          scope: "openid,profile,w_member_social",
        });
      }
      if (url.host === "api.linkedin.com" && url.pathname === "/v2/userinfo") {
        return Response.json({ sub: "abc123", name: "Burak Koç" });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const brand = await createBrand();
    const res = await api("POST", "/api/social-accounts/linkedin/oauth", {
      brandId: brand.id,
      clientId: "li-client",
      clientSecret: "li-secret-1",
      code: "li-code",
      redirectUri: "http://localhost:8793/linkedin/callback",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const account = SocialAccount.parse(res.body);
    expect(account).toMatchObject({
      platform: "linkedin",
      externalId: "urn:li:person:abc123",
      handle: "Burak Koç",
      hasToken: true,
      tokenScopes: ["openid", "profile", "w_member_social"],
    });
    const days = (Date.parse(account.tokenExpiresAt ?? "") - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(59);
    expect(calls).toContain("POST www.linkedin.com/oauth/v2/accessToken");
  });
});

describe("token vault migration", () => {
  it("re-encrypts legacy rows with the per-install key and the worker can still read them", async () => {
    const brand = await createBrand();
    const account = await createAccount(brand.id, {
      platform: "linkedin",
      handle: "Eski",
      externalId: "urn:li:person:old",
    });
    const legacy = await legacySeal(env.WORKER_TOKEN, account.id, "AQVlegacy-token-00001");
    const now = new Date();
    await createDb(env.DB)
      .insert(socialAccountTokens)
      .values({
        socialAccountId: account.id,
        ...legacy,
        keyVersion: 1,
        scopes: [],
        expiresAt: null,
        health: "valid",
        checkedAt: now,
        createdAt: now,
        updatedAt: now,
      });

    const status = PublishingStatus.parse((await api("GET", "/api/publishing/status")).body);
    expect(status.vaultReady).toBe(true);
    const row = await createDb(env.DB).query.socialAccountTokens.findFirst({
      where: (t, { eq }) => eq(t.socialAccountId, account.id),
    });
    expect(row?.keyVersion).toBe(2);

    const { content } = await approvedContent(brand.id, { targetPlatforms: ["linkedin"] });
    const sched = Schedule.parse(
      (
        await api("POST", "/api/schedules", {
          contentId: content.id,
          socialAccountId: account.id,
          scheduledAt: inOneHour(),
        })
      ).body,
    );
    const creds = await worker("GET", `/api/worker/schedules/${sched.id}/credentials`);
    expect(creds.status).toBe(200);
    expect(WorkerScheduleCredentials.parse(creds.body).accessToken).toBe("AQVlegacy-token-00001");
  });
});

describe("preflight (platform rules, Turkish)", () => {
  it("flags caption and carousel limits per account", async () => {
    const brand = await createBrand();
    const ig = await createAccount(brand.id, { platform: "instagram", handle: "@mtm" });
    const li = await createAccount(brand.id, {
      platform: "linkedin",
      handle: "MTM",
      externalId: "urn:li:person:1",
    });
    const content = await createContent(brand.id, {
      type: "carousel",
      targetPlatforms: ["instagram", "linkedin"],
      caption: "x".repeat(2300),
    });
    // The API stores at most 20 slides (the Instagram limit); here one slide is far too tall.
    const slides = [
      { html: "<html><body>1</body></html>", width: 1080, height: 1350 },
      { html: "<html><body>2</body></html>", width: 1080, height: 3000 },
    ];
    await addVersion(content.id, { slides });
    const res = await api("POST", "/api/schedules/preflight", { contentId: content.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const pf = SchedulePreflight.parse(res.body);
    expect(pf.ok).toBe(false);
    const igT = pf.targets.find((t) => t.socialAccountId === ig.id);
    expect(igT?.kind).toBe("instagram.carousel");
    expect(igT?.errors.map((e) => e.code)).toEqual(
      expect.arrayContaining(["ASPECT_RATIO_OUT_OF_RANGE", "CAPTION_TOO_LONG"]),
    );
    expect(igT?.errors.find((e) => e.code === "CAPTION_TOO_LONG")?.message).toMatch(/karakter/);
    const liT = pf.targets.find((t) => t.socialAccountId === li.id);
    expect(liT?.kind).toBe("linkedin.document");
  });

  it("refuses Instagram/Facebook images in local mode but allows LinkedIn", async () => {
    const db = createDb(env.DB);
    const now = new Date();
    const base = {
      brandId: "b",
      handle: "h",
      status: "connected" as const,
      createdAt: now,
      updatedAt: now,
    };
    const targets = await preflightTargets({
      db,
      content: {
        type: "post",
        title: "T",
        caption: "Merhaba",
        slides: [{ html: "", width: 1080, height: 1350, renderedAssetId: null }],
      },
      accounts: [
        { account: { ...base, id: "a1", platform: "instagram", externalId: "1784" }, token: null },
        {
          account: { ...base, id: "a2", platform: "linkedin", externalId: "urn:li:person:1" },
          token: null,
        },
      ],
      mode: "local",
      allowPrivateMedia: false,
    });
    expect(targets[0]?.errors.map((e) => e.code)).toContain("LOCAL_MEDIA_NOT_PUBLIC");
    expect(targets[0]?.errors[0]?.message).toContain("bulut yayıncı");
    expect(targets[1]?.ok).toBe(true);
    const cloud = await preflightTargets({
      db,
      content: {
        type: "post",
        title: "T",
        caption: "Merhaba",
        slides: [{ html: "", width: 1080, height: 1350, renderedAssetId: null }],
      },
      accounts: [
        { account: { ...base, id: "a1", platform: "instagram", externalId: "1784" }, token: null },
      ],
      mode: "cloud",
      allowPrivateMedia: false,
    });
    expect(cloud[0]?.ok).toBe(true);
  });

  it("counts a Page's Facebook Reels in any 24 hours (30 at most)", async () => {
    const hour = 3_600_000;
    const t = Date.UTC(2031, 0, 10, 12);
    // 29 others in the day before: the 30th fits; a 30th other makes it 31.
    const before = Array.from({ length: 29 }, (_, i) => t - (i + 1) * 30 * 60_000);
    expect(busiestDayWith(before, t)).toBe(30);
    expect(busiestDayWith([...before, t + 2 * hour], t)).toBe(31);
    // 23 h later is in a window with `t`, but not with the 29 before it.
    expect(busiestDayWith([...before, t + 23 * hour], t)).toBe(30);
    // Windows that do not hold `t` do not matter.
    expect(busiestDayWith([...before, t + 25 * hour, t - 25 * hour], t)).toBe(30);
    expect(busiestDayWith([], t)).toBe(1);

    const brand = await createBrand();
    const fb = await createAccount(brand.id, {
      platform: "facebook",
      handle: "MTM Agro",
      externalId: "100200300",
    });
    const reel = { type: "reel" as const, targetPlatforms: ["facebook" as const] };
    const reelSlide = {
      html: '<html><body data-video-asset-id="none" data-duration-ms="20000"></body></html>',
      width: 1080,
      height: 1920,
    };
    const published = await createContent(brand.id, reel);
    const v = await addVersion(published.id, { slides: [reelSlide] });
    const db = createDb(env.DB);
    const now = Date.now();
    for (let i = 0; i < 30; i++) {
      const at = new Date(now - (i + 1) * 20 * 60_000);
      await db.insert(schedules).values({
        id: `fbreel-${brand.id}-${i}`,
        contentId: published.id,
        brandId: brand.id,
        platform: "facebook",
        socialAccountId: fb.id,
        versionId: v.id,
        contentHash: v.contentHash,
        scheduledAt: at,
        status: i === 0 ? "failed" : "published",
        createdAt: at,
        updatedAt: at,
      });
    }
    const next = await createContent(brand.id, reel);
    await addVersion(next.id, { slides: [reelSlide] });
    const check = async (scheduledAt?: string) => {
      const res = await api("POST", "/api/schedules/preflight", {
        contentId: next.id,
        socialAccountIds: [fb.id],
        ...(scheduledAt ? { scheduledAt } : {}),
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return SchedulePreflight.parse(res.body).targets[0]?.errors ?? [];
    };
    // 29 published + 1 failed (does not count): one more still fits.
    expect((await check()).map((e) => e.code)).not.toContain("FB_REELS_DAILY_LIMIT");

    await db.insert(schedules).values({
      id: `fbreel-${brand.id}-extra`,
      contentId: published.id,
      brandId: brand.id,
      platform: "facebook",
      socialAccountId: fb.id,
      versionId: v.id,
      contentHash: v.contentHash,
      scheduledAt: new Date(now - 5 * 60_000),
      status: "published",
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    const full = await check(new Date(now + hour).toISOString());
    const limit = full.find((e) => e.code === "FB_REELS_DAILY_LIMIT");
    expect(limit?.message).toContain("en fazla 30 Reels");
    // The next day is free again.
    expect((await check(new Date(now + 26 * hour).toISOString())).map((e) => e.code)).not.toContain(
      "FB_REELS_DAILY_LIMIT",
    );
  });

  it("refuses a schedule that breaks platform rules with the Turkish reason", async () => {
    const brand = await createBrand();
    const ig = await createAccount(brand.id);
    const content = await createContent(brand.id, { caption: "#a ".repeat(31) });
    const v = await addVersion(content.id);
    await api("POST", `/api/contents/${content.id}/approve`, { hash: v.contentHash });
    const err = expectError(
      await api("POST", "/api/schedules", {
        contentId: content.id,
        socialAccountId: ig.id,
        scheduledAt: inOneHour(),
      }),
      400,
      "validation_error",
    );
    expect(err.message).toMatch(/hashtag/i);
  });
});

describe("reschedule, publish now, logs feed", () => {
  it("moves a pending schedule and clears its cloud copy", async () => {
    const brand = await createBrand();
    const account = await createAccount(brand.id);
    const { content } = await approvedContent(brand.id);
    const s = Schedule.parse(
      (
        await api("POST", "/api/schedules", {
          contentId: content.id,
          socialAccountId: account.id,
          scheduledAt: inOneHour(),
        })
      ).body,
    );
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: new Date().toISOString(),
    });
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const moved = await api("PATCH", `/api/schedules/${s.id}`, { scheduledAt: later });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(Schedule.parse(moved.body)).toMatchObject({
      scheduledAt: later,
      delivery: "cloud",
      cloudSyncedAt: null,
    });
    expectError(
      await api("PATCH", `/api/schedules/${s.id}`, { scheduledAt: "2020-01-01T00:00:00.000Z" }),
      400,
      "validation_error",
    );
    await api("POST", `/api/schedules/${s.id}/cancel`);
    expectError(
      await api("PATCH", `/api/schedules/${s.id}`, { scheduledAt: later }),
      409,
      "invalid_transition",
    );
  });

  it("publish-now creates a schedule and a schedule.publish job; outcomes show in the feed", async () => {
    const brand = await createBrand();
    const account = await createAccount(brand.id);
    const { content } = await approvedContent(brand.id);
    const res = await api("POST", "/api/schedules/publish-now", {
      contentId: content.id,
      socialAccountIds: [account.id],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const out = PublishNowResult.parse(res.body);
    expect(out.schedules).toHaveLength(1);
    expect(Job.parse(out.jobs[0])).toMatchObject({
      type: "schedule.publish",
      payload: { scheduleId: out.schedules[0]?.id },
    });

    const sid = out.schedules[0]?.id as string;
    const since = new Date(Date.now() - 1000).toISOString();
    await worker("POST", `/api/worker/schedules/${sid}/outcome`, {
      status: "publishing",
      attempt: 1,
    });
    await worker("POST", `/api/worker/schedules/${sid}/outcome`, {
      status: "published",
      attempt: 1,
      externalPostId: "17890001",
      permalink: "https://www.instagram.com/p/FAKE1/",
    });
    const feed = PublishLogFeed.parse(
      (
        await api(
          "GET",
          `/api/publish-logs?brandId=${brand.id}&finishedAfter=${encodeURIComponent(since)}`,
        )
      ).body,
    );
    expect(feed.items).toHaveLength(1);
    expect(feed.items[0]).toMatchObject({
      contentTitle: content.title,
      accountHandle: account.handle,
      log: { status: "succeeded", permalink: "https://www.instagram.com/p/FAKE1/" },
      schedule: { status: "published", lastError: null },
    });

    // A failure records the reason on the schedule.
    const { content: c2 } = await approvedContent(brand.id);
    const s2 = PublishNowResult.parse(
      (
        await api("POST", "/api/schedules/publish-now", {
          contentId: c2.id,
          socialAccountIds: [account.id],
        })
      ).body,
    ).schedules[0];
    const failed = await worker("POST", `/api/worker/schedules/${s2?.id}/outcome`, {
      status: "failed",
      attempt: 1,
      error: "Görsel reddedildi.",
    });
    expect(Schedule.parse(failed.body)).toMatchObject({
      status: "failed",
      lastError: "Görsel reddedildi.",
    });
  });
});

describe("retrying a failed schedule", () => {
  async function failedSchedule() {
    const brand = await createBrand();
    const account = await createAccount(brand.id);
    const { content } = await approvedContent(brand.id);
    const s = Schedule.parse(
      (
        await api("POST", "/api/schedules", {
          contentId: content.id,
          socialAccountId: account.id,
          scheduledAt: inOneHour(),
        })
      ).body,
    );
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: new Date().toISOString(),
    });
    await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "publishing",
      attempt: 1,
    });
    await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "failed",
      attempt: 1,
      error: "Görsel reddedildi.",
    });
    return { brand, account, content, s };
  }

  it("reuses the failed schedule (same id, so the same cloud order) instead of adding one", async () => {
    const { brand, account, content, s } = await failedSchedule();
    const later = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const res = await api("POST", "/api/schedules", {
      contentId: content.id,
      socialAccountId: account.id,
      scheduledAt: later,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const retried = Schedule.parse(res.body);
    expect(retried).toMatchObject({
      id: s.id,
      status: "pending",
      scheduledAt: later,
      lastError: null,
      delivery: null,
      cloudSyncedAt: null,
    });
    const all = (await api<{ items: Schedule[] }>("GET", `/api/schedules?contentId=${content.id}`))
      .body.items;
    expect(all.map((x) => x.id)).toEqual([s.id]);
    expect((await api<{ status: string }>("GET", `/api/contents/${content.id}`)).body.status).toBe(
      "scheduled",
    );
    // The worker sees it as pending again (and pushes it to the same order id).
    const due = WorkerDueSchedules.parse((await worker("GET", "/api/worker/schedules/due")).body);
    expect(due.items.map((i) => i.id)).toContain(s.id);

    // A local worker counts from 1 again; the earlier failure stays as attempt 1.
    await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "publishing",
      attempt: 1,
    });
    const done = await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "published",
      attempt: 1,
      externalPostId: "17890002",
      permalink: "https://www.instagram.com/p/RETRY/",
    });
    expect(Schedule.parse(done.body).status).toBe("published");
    const logs = (
      await api<{ items: { attempt: number; status: string; error: string | null }[] }>(
        "GET",
        `/api/schedules/${s.id}/logs`,
      )
    ).body.items;
    expect(logs.map((l) => [l.attempt, l.status])).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
    expect(logs[0]?.error).toBe("Görsel reddedildi.");

    // A published schedule is history: scheduling the post again on the account makes a new one.
    const { content: other } = await approvedContent(brand.id);
    const fresh = Schedule.parse(
      (
        await api("POST", "/api/schedules", {
          contentId: other.id,
          socialAccountId: account.id,
          scheduledAt: later,
        })
      ).body,
    );
    expect(fresh.id).not.toBe(s.id);
  });

  it("publish-now on a failed schedule reuses it too; cloud attempts keep their numbers", async () => {
    const { account, content, s } = await failedSchedule();
    const res = await api("POST", "/api/schedules/publish-now", {
      contentId: content.id,
      socialAccountIds: [account.id],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const out = PublishNowResult.parse(res.body);
    expect(out.schedules.map((x) => x.id)).toEqual([s.id]);
    expect(out.jobs[0]?.payload).toMatchObject({ scheduleId: s.id });

    // The cloud publisher continues counting (attempt 2): no remapping needed.
    await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "failed",
      attempt: 2,
      error: "Yine olmadı.",
    });
    const logs = (
      await api<{ items: { attempt: number; status: string }[] }>(
        "GET",
        `/api/schedules/${s.id}/logs`,
      )
    ).body.items;
    expect(logs.map((l) => [l.attempt, l.status])).toEqual([
      [1, "failed"],
      [2, "failed"],
    ]);
    // A duplicate report of a finished outcome is not a new attempt.
    await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "failed",
      attempt: 2,
      error: "Yine olmadı.",
    });
    expect(
      (await api<{ items: unknown[] }>("GET", `/api/schedules/${s.id}/logs`)).body.items,
    ).toHaveLength(2);
  });
});

describe("cloud publisher settings", () => {
  it("probes, vaults the token for the worker, reports syncs and lists cancelled cloud orders", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.host === "publish.example.test") {
        seen.push(url.pathname);
        if (url.pathname === "/health") return Response.json({ ok: true });
        const auth = new Headers(init?.headers).get("authorization");
        if (auth !== "Bearer cloud-token-0123456789abcdef")
          return new Response("no", { status: 401 });
        return Response.json({ items: [], nextCursor: null });
      }
      return realFetch(input, init);
    }) as typeof fetch;

    const wrong = await api("PUT", "/api/publishing/cloud", {
      url: "https://publish.example.test",
      token: "wrong-token-0123456789",
    });
    expect(expectError(wrong, 400, "validation_error").message).toContain("anahtarı kabul etmedi");

    const ok = await api("PUT", "/api/publishing/cloud", {
      url: "https://publish.example.test/",
      token: "cloud-token-0123456789abcdef",
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const status = PublishingStatus.parse(ok.body);
    expect(status).toMatchObject({
      mode: "cloud",
      cloud: { configured: true, url: "https://publish.example.test" },
    });
    expect(JSON.stringify(status)).not.toContain("cloud-token");

    const cfg = WorkerPublishingConfig.parse(
      (await worker("GET", "/api/worker/publishing/config")).body,
    );
    expect(cfg.cloud).toEqual({
      url: "https://publish.example.test",
      token: "cloud-token-0123456789abcdef",
    });
    expect(cfg.syncRequestedAt).not.toBeNull();
    expect((await api("GET", "/api/worker/publishing/config")).status).toBe(401);

    await worker("POST", "/api/worker/publishing/report", { ok: false, error: "HTTP 500" });
    expect(
      PublishingStatus.parse((await api("GET", "/api/publishing/status")).body).cloud,
    ).toMatchObject({ lastSyncOk: false, lastSyncError: "HTTP 500" });

    // A cancelled schedule that reached the cloud is listed until the worker clears it.
    const brand = await createBrand();
    const account = await createAccount(brand.id);
    const { content } = await approvedContent(brand.id);
    const s = Schedule.parse(
      (
        await api("POST", "/api/schedules", {
          contentId: content.id,
          socialAccountId: account.id,
          scheduledAt: inOneHour(),
        })
      ).body,
    );
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: new Date().toISOString(),
    });
    await api("POST", `/api/schedules/${s.id}/cancel`);
    const list = WorkerDueSchedules.parse(
      (await worker("GET", "/api/worker/schedules/cancelled")).body,
    );
    expect(list.items.map((i) => i.id)).toContain(s.id);
    await worker("POST", `/api/worker/schedules/${s.id}/delivery`, {
      delivery: "cloud",
      cloudSyncedAt: null,
    });
    const after = WorkerDueSchedules.parse(
      (await worker("GET", "/api/worker/schedules/cancelled")).body,
    );
    expect(after.items.map((i) => i.id)).not.toContain(s.id);

    const cleared = PublishingStatus.parse((await api("DELETE", "/api/publishing/cloud")).body);
    expect(cleared).toMatchObject({ mode: "local", cloud: { configured: false } });
  });
});
