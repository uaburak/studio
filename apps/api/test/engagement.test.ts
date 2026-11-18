/**
 * N13 publish details, N15 statistics and N16 comment inbox on the API: details do not revoke the
 * approval and re-push cloud orders; a published outcome opens the statistics row; the worker's
 * targets and reports; performance, best times and the planning summary; sync scheduling; the
 * comment threads, counts, reply / moderation actions and "Yanıt öner".
 */
import { env } from "cloudflare:workers";
import {
  BestTimes,
  BrandPerformance,
  CommentList,
  CommentSummary,
  CommentThread,
  Content,
  ContentPerformance,
  Job,
  KnownLocationList,
  PerformanceSummary,
  PlanningContext,
  Schedule,
  SchedulePreflight,
  WorkerCommentContext,
  WorkerCommentsAck,
  WorkerEngagementTargets,
  WorkerInsightsAck,
} from "@studio/contract";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/db/client.ts";
import { commentActions, jobs, postInsights, schedules } from "../src/db/schema.ts";
import { dueEngagementJobs } from "../src/lib/insights.ts";
import {
  api,
  approvedContent,
  BASE,
  createAccount,
  createBrand,
  createContent,
  expectError,
  inOneHour,
  localFetch,
  uniq,
} from "./helpers.ts";

const AUTH = () => ({ Authorization: `Bearer ${env.WORKER_TOKEN}` });
const H = 3_600_000;

async function worker<T>(method: string, path: string, body?: unknown) {
  const res = await localFetch(`${BASE}${path}`, {
    method,
    headers: { ...AUTH(), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

/** An Instagram (or Facebook) account with an id and a token in the vault. */
async function connectedAccount(brandId: string, platform: "instagram" | "facebook" = "instagram") {
  const externalId = `${Math.floor(Math.random() * 1e12)}`;
  const account = await createAccount(brandId, {
    platform,
    handle: platform === "instagram" ? "@mtmagro" : "MTM Agro",
    externalId,
  });
  const res = await api("PUT", `/api/social-accounts/${account.id}/token`, {
    accessToken: `EAAtoken${uniq("x")}`,
    externalId,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { ...account, externalId };
}

/** Approve, schedule and report `published` from the worker (media id `externalPostId`). */
async function published(
  brandId: string,
  accountId: string,
  opts: {
    externalPostId?: string;
    publishedAgoMs?: number;
    platform?: "instagram" | "facebook";
  } = {},
) {
  const { content } = await approvedContent(brandId, {
    targetPlatforms: [opts.platform ?? "instagram"],
  });
  const created = await api("POST", "/api/schedules", {
    contentId: content.id,
    socialAccountId: accountId,
    scheduledAt: inOneHour(),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const s = Schedule.parse(created.body);
  const externalPostId = opts.externalPostId ?? `1789${Math.floor(Math.random() * 1e9)}`;
  const out = await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
    status: "published",
    attempt: 1,
    externalPostId,
    permalink: `https://www.instagram.com/p/${externalPostId}/`,
  });
  expect(out.status, JSON.stringify(out.body)).toBe(200);
  if (opts.publishedAgoMs) {
    const at = new Date(Date.now() - opts.publishedAgoMs);
    const db = createDb(env.DB);
    await db.update(schedules).set({ publishedAt: at }).where(eq(schedules.id, s.id));
    await db
      .update(postInsights)
      .set({ nextSyncAt: new Date(at.getTime() + H) })
      .where(eq(postInsights.scheduleId, s.id));
  }
  return { content, schedule: s, externalPostId };
}

describe("publish details (N13)", () => {
  it("are saved without revoking the approval and bump pending schedules", async () => {
    const brand = await createBrand();
    const account = await connectedAccount(brand.id);
    const { content } = await approvedContent(brand.id, { targetPlatforms: ["instagram"] });
    const s = Schedule.parse(
      (
        await api("POST", "/api/schedules", {
          contentId: content.id,
          socialAccountId: account.id,
          scheduledAt: inOneHour(),
        })
      ).body,
    );
    expect(s.detailsRevision).toBeUndefined();
    const res = await api("PUT", `/api/contents/${content.id}/publish-details`, {
      firstComment: "  #tarım #hasat ",
      altTexts: ["Tarlada buğday", null],
      altTextSources: ["auto", null],
      location: { id: "110011001100", name: "Konya Ovası" },
      collaborators: ["ortak.marka", "ortak.marka"],
      userTags: [{ slide: 0, username: "ciftci.ali", x: 0.5, y: 0.4 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const saved = Content.parse(res.body);
    expect(saved.status).toBe("scheduled");
    expect(saved.approval).not.toBeNull();
    expect(saved.publishDetails).toEqual({
      firstComment: "#tarım #hasat",
      altTexts: ["Tarlada buğday", null],
      altTextSources: ["auto", null],
      location: { id: "110011001100", name: "Konya Ovası" },
      collaborators: ["ortak.marka"],
      userTags: [{ slide: 0, username: "ciftci.ali", x: 0.5, y: 0.4 }],
    });
    const after = Schedule.parse((await api("GET", `/api/schedules/${s.id}`)).body);
    expect(after.detailsRevision).toBe(1);
    expect(after.status).toBe("pending");

    const locations = KnownLocationList.parse(
      (await api("GET", `/api/brands/${brand.id}/publish-locations`)).body,
    );
    expect(locations.items).toEqual([
      expect.objectContaining({ id: "110011001100", name: "Konya Ovası", source: "used" }),
    ]);
    const added = KnownLocationList.parse(
      (
        await api("POST", `/api/brands/${brand.id}/publish-locations`, {
          id: "220022",
          name: "Ofis",
        })
      ).body,
    );
    expect(added.items.map((l) => l.id).sort()).toEqual(["110011001100", "220022"]);
    expect(
      (await api("POST", `/api/brands/${brand.id}/publish-locations`, { id: "abc", name: "x" }))
        .status,
    ).toBe(400);

    // Clearing them.
    const cleared = Content.parse(
      (await api("PUT", `/api/contents/${content.id}/publish-details`, {})).body,
    );
    expect(cleared.publishDetails).toBeUndefined();
  });

  it("refuses a Reels cover on a post, bad usernames, and changes after publishing", async () => {
    const brand = await createBrand();
    const account = await connectedAccount(brand.id);
    const content = await createContent(brand.id);
    expectError(
      await api("PUT", `/api/contents/${content.id}/publish-details`, {
        reelCover: { kind: "frame", offsetMs: 500 },
      }),
      400,
      "validation_error",
    );
    expectError(
      await api("PUT", `/api/contents/${content.id}/publish-details`, {
        collaborators: ["@ali"],
      }),
      400,
      "validation_error",
    );
    const { content: live } = await published(brand.id, account.id);
    expectError(
      await api("PUT", `/api/contents/${live.id}/publish-details`, { firstComment: "x" }),
      409,
      "conflict",
    );
  });

  it("preflight: unsupported details are warnings, platform limits are errors", async () => {
    const brand = await createBrand();
    const ig = await connectedAccount(brand.id, "instagram");
    const fb = await connectedAccount(brand.id, "facebook");
    const content = await createContent(brand.id, { targetPlatforms: ["instagram", "facebook"] });
    await api("POST", `/api/contents/${content.id}/versions`, {
      origin: "generated",
      slides: [{ html: "<html><body>x</body></html>", width: 1080, height: 1350 }],
    });
    await api("PUT", `/api/contents/${content.id}/publish-details`, {
      firstComment: "a".repeat(2300),
      location: { id: "123", name: "Yer" },
    });
    const res = await api("POST", "/api/schedules/preflight", {
      contentId: content.id,
      socialAccountIds: [ig.id, fb.id],
    });
    const pre = SchedulePreflight.parse(res.body);
    const igT = pre.targets.find((t) => t.platform === "instagram");
    const fbT = pre.targets.find((t) => t.platform === "facebook");
    expect(igT?.errors.map((e) => e.code)).toContain("FIRST_COMMENT_TOO_LONG");
    expect(fbT?.errors.map((e) => e.code)).not.toContain("FIRST_COMMENT_TOO_LONG");
    expect(fbT?.warnings.find((w) => w.code === "DETAILS_NOT_SUPPORTED")?.message).toMatch(
      /^Konum bu Facebook paylaşımında desteklenmiyor/,
    );
  });
});

describe("published outcome (N13, N15)", () => {
  it("keeps the post id, time and warnings and opens the statistics row", async () => {
    const brand = await createBrand();
    const account = await connectedAccount(brand.id);
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
    const before = Date.now();
    const out = await worker<Schedule>("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "published",
      attempt: 1,
      externalPostId: "17890001",
      permalink: "https://www.instagram.com/p/X/",
      warnings: [{ code: "FIRST_COMMENT_FAILED", message: "İlk yorum eklenemedi." }],
    });
    const done = Schedule.parse(out.body);
    expect(done.externalPostId).toBe("17890001");
    expect(Date.parse(done.publishedAt as string)).toBeGreaterThanOrEqual(before - 1000);
    expect(done.warnings).toEqual([
      { code: "FIRST_COMMENT_FAILED", message: "İlk yorum eklenemedi." },
    ]);
    const row = await createDb(env.DB).query.postInsights.findFirst({
      where: eq(postInsights.scheduleId, s.id),
    });
    expect(row?.status).toBe("pending");
    expect(row?.externalPostId).toBe("17890001");
    const wait = (row?.nextSyncAt?.getTime() ?? 0) - Date.parse(done.publishedAt as string);
    expect(wait).toBe(H);
  });

  it("LinkedIn posts get no statistics row", async () => {
    const brand = await createBrand();
    const li = await createAccount(brand.id, {
      platform: "linkedin",
      handle: "Ayşe",
      externalId: "urn:li:person:abc",
    });
    await api("PUT", `/api/social-accounts/${li.id}/token`, { accessToken: "AQVtoken123456" });
    const { content } = await approvedContent(brand.id, { targetPlatforms: ["linkedin"] });
    const s = Schedule.parse(
      (
        await api("POST", "/api/schedules", {
          contentId: content.id,
          socialAccountId: li.id,
          scheduledAt: inOneHour(),
        })
      ).body,
    );
    await worker("POST", `/api/worker/schedules/${s.id}/outcome`, {
      status: "published",
      externalPostId: "urn:li:share:1",
    });
    const row = await createDb(env.DB).query.postInsights.findFirst({
      where: eq(postInsights.scheduleId, s.id),
    });
    expect(row).toBeUndefined();
  });
});

describe("statistics (N15)", () => {
  it("worker targets, reports, history, performance page, best times and planning", async () => {
    const brand = await createBrand();
    const account = await connectedAccount(brand.id);
    const a = await published(brand.id, account.id, { publishedAgoMs: 2 * H });
    const b = await published(brand.id, account.id, { publishedAgoMs: 30 * H });

    const targets = WorkerEngagementTargets.parse(
      (await worker("GET", `/api/worker/engagement/targets?kind=insights&brandId=${brand.id}`))
        .body,
    );
    expect(targets.posts.map((p) => p.scheduleId).sort()).toEqual(
      [a.schedule.id, b.schedule.id].sort(),
    );
    const acc = targets.accounts.find((x) => x.socialAccountId === account.id);
    expect(acc?.accessToken).toMatch(/^EAAtoken/);
    expect(acc?.followersDue).toBe(true);

    const ack = WorkerInsightsAck.parse(
      (
        await worker("POST", "/api/worker/engagement/insights", {
          posts: [
            {
              scheduleId: a.schedule.id,
              status: "ok",
              metrics: {
                reach: 1000,
                likes: 50,
                comments: 5,
                saves: 10,
                shares: 5,
                interactions: 70,
                bogus: 3,
              },
            },
            {
              scheduleId: b.schedule.id,
              status: "partial",
              metrics: { likes: 4, comments: 1 },
              note: "Yalnızca beğeni ve yorum sayıları okundu.",
            },
          ],
          accounts: [
            {
              socialAccountId: account.id,
              status: "ok",
              followers: 1234,
              pageLocation: { id: "998877", name: "MTM Agro Merkez" },
            },
          ],
        })
      ).body,
    );
    expect(ack).toEqual({ posts: 2, snapshots: 2 });

    // Not due again until the next checkpoint; the account's followers are read for today.
    const again = WorkerEngagementTargets.parse(
      (await worker("GET", `/api/worker/engagement/targets?kind=insights&brandId=${brand.id}`))
        .body,
    );
    expect(again.posts).toEqual([]);
    expect(again.accounts).toEqual([]);

    const perf = ContentPerformance.parse(
      (await api("GET", `/api/contents/${a.content.id}/performance`)).body,
    );
    expect(perf.posts).toHaveLength(1);
    expect(perf.posts[0]?.metrics).toEqual({
      reach: 1000,
      likes: 50,
      comments: 5,
      saves: 10,
      shares: 5,
      interactions: 70,
    });
    expect(perf.posts[0]?.engagementRate).toBe(0.07);
    expect(perf.posts[0]?.snapshots).toHaveLength(1);
    expect(perf.posts[0]?.snapshots[0]?.hoursAfterPublish).toBeCloseTo(2, 0);
    expect(perf.posts[0]?.accountHandle).toBe("@mtmagro");
    // Next read at the 24 h checkpoint.
    const next = Date.parse(perf.posts[0]?.nextSyncAt as string);
    const pub = Date.parse(perf.posts[0]?.publishedAt as string);
    expect(next - pub).toBe(24 * H);

    const page = BrandPerformance.parse(
      (await api("GET", `/api/brands/${brand.id}/performance?days=30`)).body,
    );
    expect(page.posts).toBe(2);
    expect(page.topPosts[0]?.contentId).toBe(a.content.id);
    expect(page.byFormat.map((g) => g.key)).toEqual(["post"]);
    expect(page.followers[0]?.points.at(-1)?.followers).toBe(1234);
    expect(page.bestTimes.basis).toBe("general");
    expect(page.accounts[0]?.needsReconnect).toBe(false);

    const best = BestTimes.parse((await api("GET", `/api/brands/${brand.id}/best-times`)).body);
    expect(best.sampleSize).toBe(2);
    expect(best.suggestions.length).toBeGreaterThan(0);

    const summary = PerformanceSummary.parse(
      (await api("GET", `/api/brands/${brand.id}/performance-summary`)).body,
    );
    expect(summary.posts).toBe(2);
    expect(summary.top[0]?.title).toBe("Hasat duyurusu");

    const locations = KnownLocationList.parse(
      (await api("GET", `/api/brands/${brand.id}/publish-locations`)).body,
    );
    expect(locations.items[0]).toMatchObject({ id: "998877", source: "page" });

    const today = new Date(Date.now() + 3 * H).toISOString().slice(0, 10);
    const ctx = PlanningContext.parse(
      (
        await api(
          "GET",
          `/api/brands/${brand.id}/planning-context?periodStart=${today}&periodEnd=${today}`,
        )
      ).body,
    );
    expect(ctx.performance?.posts).toBe(2);
    const entry = ctx.history.entries.find((e) => e.contentId === a.content.id);
    expect(entry?.performance?.index).toBeGreaterThan(0);
  });

  it("a post missing twice is deleted; errors retry later; rate limits pause the account", async () => {
    const brand = await createBrand();
    const account = await connectedAccount(brand.id);
    const p = await published(brand.id, account.id, { publishedAgoMs: 5 * H });
    const db = createDb(env.DB);
    await worker("POST", "/api/worker/engagement/insights", {
      posts: [{ scheduleId: p.schedule.id, status: "missing" }],
    });
    let row = await db.query.postInsights.findFirst({
      where: eq(postInsights.scheduleId, p.schedule.id),
    });
    expect(row?.status).toBe("pending");
    expect(row?.missCount).toBe(1);
    await worker("POST", "/api/worker/engagement/insights", {
      posts: [{ scheduleId: p.schedule.id, status: "missing" }],
    });
    row = await db.query.postInsights.findFirst({
      where: eq(postInsights.scheduleId, p.schedule.id),
    });
    expect(row?.status).toBe("deleted");
    expect(row?.nextSyncAt).toBeNull();

    const q = await published(brand.id, account.id, { publishedAgoMs: 5 * H });
    await worker("POST", "/api/worker/engagement/insights", {
      posts: [{ scheduleId: q.schedule.id, status: "error", error: "Meta'ya ulaşılamadı." }],
      accounts: [
        {
          socialAccountId: account.id,
          status: "rate_limited",
          error: "Meta istek sınırı",
          retryAt: new Date(Date.now() + H).toISOString(),
        },
      ],
    });
    row = await db.query.postInsights.findFirst({
      where: eq(postInsights.scheduleId, q.schedule.id),
    });
    expect(row?.status).toBe("error");
    expect((row?.nextSyncAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(2 * H);
    const paused = WorkerEngagementTargets.parse(
      (
        await worker(
          "GET",
          `/api/worker/engagement/targets?kind=insights&brandId=${brand.id}&force=true`,
        )
      ).body,
    );
    expect(paused.posts).toEqual([]);
    const page = BrandPerformance.parse(
      (await api("GET", `/api/brands/${brand.id}/performance`)).body,
    );
    expect(page.accounts[0]?.retryAt).not.toBeNull();
  });

  it("an invalid token marks the account for reconnecting", async () => {
    const brand = await createBrand();
    const account = await connectedAccount(brand.id);
    await worker("POST", "/api/worker/engagement/insights", {
      posts: [],
      accounts: [{ socialAccountId: account.id, status: "auth", error: "Token geçersiz." }],
    });
    const acc = (await api<{ status: string }>("GET", `/api/social-accounts/${account.id}`)).body;
    expect(acc.status).toBe("needs_reauth");
    const page = BrandPerformance.parse(
      (await api("GET", `/api/brands/${brand.id}/performance`)).body,
    );
    expect(page.accounts[0]?.needsReconnect).toBe(true);
  });

  it("read now queues insights.sync with force", async () => {
    const brand = await createBrand();
    const res = await api("POST", "/api/insights/sync", { brandId: brand.id });
    expect(res.status).toBe(202);
    const job = Job.parse(res.body);
    expect(job.type).toBe("insights.sync");
    expect(job.payload).toEqual({ brandId: brand.id, force: true });
  });
});

describe("sync scheduling (N15, N16)", () => {
  it("queues insights when a read is due and comments every 15 minutes, never twice", async () => {
    const db = createDb(env.DB);
    // Other tests leave rows behind: look at this test's own schedule only through due times.
    const brand = await createBrand();
    const account = await connectedAccount(brand.id);
    await published(brand.id, account.id, { publishedAgoMs: 3 * H });
    // Clear queued engagement jobs other tests made.
    await db
      .update(jobs)
      .set({ status: "cancelled" })
      .where(and(eq(jobs.status, "queued")));
    const now = new Date();
    const due = await dueEngagementJobs(db, now, 0);
    expect(due).toEqual({ insights: true, comments: true });
    // Comments only every 15 minutes.
    expect((await dueEngagementJobs(db, now, now.getTime() - 5 * 60_000)).comments).toBe(false);
    // A queued job of the type blocks another.
    await db.insert(jobs).values({
      id: uniq("job"),
      type: "insights.sync",
      status: "queued",
      payload: {},
      createdAt: now,
      updatedAt: now,
    });
    expect((await dueEngagementJobs(db, now, 0)).insights).toBe(false);
  });
});

describe("comment inbox (N16)", () => {
  it("stores threads, counts unread, replies through the worker and moderates", async () => {
    const brand = await createBrand();
    const account = await connectedAccount(brand.id);
    const p = await published(brand.id, account.id, { publishedAgoMs: 2 * H });
    const t0 = new Date(Date.now() - H).toISOString();

    const ack = WorkerCommentsAck.parse(
      (
        await worker("POST", "/api/worker/engagement/comments", {
          posts: [
            {
              scheduleId: p.schedule.id,
              commentCount: 3,
              complete: true,
              comments: [
                {
                  externalId: "c1",
                  parentExternalId: null,
                  text: "Fiyatı ne kadar?",
                  author: "ayse",
                  authorId: "ayse",
                  createdAt: t0,
                  likeCount: 1,
                  hidden: false,
                },
                {
                  externalId: "c2",
                  parentExternalId: "c1",
                  text: "Ben de merak ettim",
                  author: "veli",
                  authorId: "veli",
                  createdAt: t0,
                  likeCount: 0,
                  hidden: false,
                },
                {
                  externalId: "c3",
                  parentExternalId: null,
                  text: "#tarım",
                  author: "mtmagro",
                  authorId: "mtmagro",
                  createdAt: t0,
                  likeCount: 0,
                  hidden: false,
                },
              ],
            },
          ],
          accounts: [{ socialAccountId: account.id, status: "ok" }],
        })
      ).body,
    );
    expect(ack).toEqual({
      created: 3,
      updated: 0,
      newUnread: 2,
      sample: { author: "ayse", text: "Fiyatı ne kadar?" },
    });

    let summary = CommentSummary.parse(
      (await api("GET", `/api/comments/summary?brandId=${brand.id}`)).body,
    );
    expect(summary.unread).toBe(2);
    expect(summary.brands).toEqual([{ brandId: brand.id, unread: 2, unanswered: 1 }]);
    expect(summary.contents).toEqual([{ contentId: p.content.id, unread: 2 }]);
    expect(summary.lastSyncAt).not.toBeNull();

    const list = CommentList.parse(
      (await api("GET", `/api/comments?brandId=${brand.id}&filter=unanswered`)).body,
    );
    expect(list.items).toHaveLength(1);
    const thread = list.items[0] as CommentThread;
    expect(thread.text).toBe("Fiyatı ne kadar?");
    expect(thread.replies.map((r) => r.text)).toEqual(["Ben de merak ettim"]);
    expect(thread.contentTitle).toBe("Hasat duyurusu");
    expect(thread.answered).toBe(false);

    // Reply: queued, marked read, a comments.sync job waits.
    const replied = CommentThread.parse(
      (await api("POST", `/api/comments/${thread.id}/reply`, { text: "DM'den yazdık 🙏" })).body,
    );
    expect(replied.answered).toBe(true);
    expect(replied.pendingAction).toMatchObject({ kind: "reply", status: "pending" });
    expect(replied.readAt).not.toBeNull();
    const queued = await createDb(env.DB)
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, "comments.sync"), eq(jobs.brandId, brand.id)));
    expect(queued.at(-1)?.payload).toEqual({ brandId: brand.id, actionsOnly: true });
    expectError(
      await api("POST", `/api/comments/${thread.id}/reply`, { text: "x".repeat(2201) }),
      400,
      "validation_error",
    );

    const targets = WorkerEngagementTargets.parse(
      (await worker("GET", `/api/worker/engagement/targets?kind=comments&brandId=${brand.id}`))
        .body,
    );
    const action = targets.actions.find((x) => x.commentId === thread.id);
    expect(action).toMatchObject({
      kind: "reply",
      externalCommentId: "c1",
      text: "DM'den yazdık 🙏",
    });
    expect(targets.posts.map((x) => x.scheduleId)).toContain(p.schedule.id);

    await worker("POST", `/api/worker/engagement/actions/${action?.id}`, { status: "sending" });
    await worker("POST", `/api/worker/engagement/actions/${action?.id}`, {
      status: "done",
      externalId: "r1",
    });
    const sent = CommentThread.parse((await api("GET", `/api/comments/${thread.id}`)).body);
    expect(sent.pendingAction).toBeNull();
    expect(sent.replies.map((r) => [r.text, r.own])).toEqual([
      ["Ben de merak ettim", false],
      ["DM'den yazdık 🙏", true],
    ]);

    // The next read sees our reply (by its id): it stays one row, own.
    const second = WorkerCommentsAck.parse(
      (
        await worker("POST", "/api/worker/engagement/comments", {
          posts: [
            {
              scheduleId: p.schedule.id,
              complete: true,
              comments: [
                {
                  externalId: "c1",
                  parentExternalId: null,
                  text: "Fiyatı ne kadar?",
                  author: "ayse",
                  authorId: "ayse",
                  createdAt: t0,
                  likeCount: 2,
                  hidden: false,
                },
                {
                  externalId: "r1",
                  parentExternalId: "c1",
                  text: "DM'den yazdık 🙏",
                  author: "mtmagro",
                  authorId: "mtmagro",
                  createdAt: t0,
                  likeCount: 0,
                  hidden: false,
                },
              ],
            },
          ],
        })
      ).body,
    );
    // c2 and c3 disappeared (complete read), c1 got a like.
    expect(second).toMatchObject({ created: 0, newUnread: 0 });
    summary = CommentSummary.parse(
      (await api("GET", `/api/comments/summary?brandId=${brand.id}`)).body,
    );
    expect(summary.unread).toBe(0);
    const after = CommentThread.parse((await api("GET", `/api/comments/${thread.id}`)).body);
    expect(after.likeCount).toBe(2);
    expect(after.replies.map((r) => r.text)).toEqual(["DM'den yazdık 🙏"]);

    // Hide → the worker reports done → hidden.
    const hidden = CommentThread.parse(
      (await api("POST", `/api/comments/${thread.id}/moderate`, { action: "hide" })).body,
    );
    expect(hidden.pendingAction).toMatchObject({ kind: "hide", status: "pending" });
    const hideAction = await createDb(env.DB)
      .select()
      .from(commentActions)
      .where(and(eq(commentActions.commentId, thread.id), eq(commentActions.kind, "hide")));
    await worker("POST", `/api/worker/engagement/actions/${hideAction[0]?.id}`, {
      status: "done",
    });
    expect(CommentThread.parse((await api("GET", `/api/comments/${thread.id}`)).body).hidden).toBe(
      true,
    );

    // A failed delete can be retried.
    await api("POST", `/api/comments/${thread.id}/moderate`, { action: "delete" });
    const del = await createDb(env.DB)
      .select()
      .from(commentActions)
      .where(and(eq(commentActions.commentId, thread.id), eq(commentActions.kind, "delete")));
    await worker("POST", `/api/worker/engagement/actions/${del[0]?.id}`, {
      status: "failed",
      error: "Meta istek sınırı",
    });
    const failed = CommentThread.parse((await api("GET", `/api/comments/${thread.id}`)).body);
    expect(failed.pendingAction).toMatchObject({ kind: "delete", status: "failed" });
    const retried = CommentThread.parse(
      (await api("POST", `/api/comments/${thread.id}/retry`)).body,
    );
    expect(retried.pendingAction?.status).toBe("pending");
    await worker("POST", `/api/worker/engagement/actions/${del[0]?.id}`, { status: "done" });
    const gone = CommentThread.parse((await api("GET", `/api/comments/${thread.id}`)).body);
    expect(gone.deletedAt).not.toBeNull();
    const visible = CommentList.parse((await api("GET", `/api/comments?brandId=${brand.id}`)).body);
    expect(visible.items).toEqual([]);
  });

  it('read marks, "Yanıt öner" and its context', async () => {
    const brand = await createBrand({ name: "MTM Agro" });
    const account = await connectedAccount(brand.id);
    const p = await published(brand.id, account.id);
    await worker("POST", "/api/worker/engagement/comments", {
      posts: [
        {
          scheduleId: p.schedule.id,
          comments: [
            {
              externalId: "x1",
              parentExternalId: null,
              text: "Bayi var mı?",
              author: "can",
              authorId: "can",
              createdAt: null,
              likeCount: null,
              hidden: null,
            },
          ],
        },
      ],
    });
    const list = CommentList.parse(
      (await api("GET", `/api/comments?brandId=${brand.id}&filter=unread`)).body,
    );
    const id = list.items[0]?.id as string;
    expect(
      (await api<{ updated: number }>("POST", "/api/comments/read", { brandId: brand.id })).body
        .updated,
    ).toBe(1);
    expect(
      CommentList.parse((await api("GET", `/api/comments?brandId=${brand.id}&filter=unread`)).body)
        .items,
    ).toEqual([]);
    await api("POST", "/api/comments/read", { ids: [id], unread: true });
    expect(
      CommentSummary.parse((await api("GET", `/api/comments/summary?brandId=${brand.id}`)).body)
        .unread,
    ).toBe(1);

    const job = Job.parse(
      (await api("POST", `/api/comments/${id}/suggest`, { instruction: "kısa olsun" })).body,
    );
    expect(job.type).toBe("comments.suggest");
    expect(job.brandId).toBe(brand.id);
    expect(job.payload).toEqual({ commentId: id, instruction: "kısa olsun" });

    const ctx = WorkerCommentContext.parse(
      (await worker("GET", `/api/worker/comments/${id}/context`)).body,
    );
    expect(ctx).toMatchObject({
      brandName: "MTM Agro",
      platform: "instagram",
      contentTitle: "Hasat duyurusu",
      maxChars: 2200,
    });
    expect(ctx.thread.text).toBe("Bayi var mı?");
    const withDraft = CommentThread.parse(
      (await worker("PUT", `/api/worker/comments/${id}/suggestion`, { text: "Evet, DM atın." }))
        .body,
    );
    expect(withDraft.suggestion).toBe("Evet, DM atın.");
    // A draft is never sent by itself.
    const actions = await createDb(env.DB)
      .select()
      .from(commentActions)
      .where(eq(commentActions.commentId, id));
    expect(actions).toEqual([]);
  });

  it("worker routes need the worker token", async () => {
    const res = await api("GET", "/api/worker/engagement/targets?kind=comments");
    expect(res.status).toBe(401);
  });
});
