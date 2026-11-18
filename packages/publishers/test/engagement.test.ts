/**
 * N13 first comment and detail params, N15 insights, N16 comments against the fake Graph API.
 */
import { describe, expect, it } from "vitest";
import {
  classifyEngagementError,
  deleteComment,
  EngagementCallError,
  findReply,
  GraphError,
  listInstagramCommentCounts,
  type PublishRequest,
  parseInsightRows,
  readComments,
  readFacebookCommentCount,
  readFacebookPostInsights,
  readFollowerCount,
  readInstagramMediaInsights,
  replyToComment,
  setCommentHidden,
  validateRequest,
} from "../src/index.ts";
import { drive, IG, PAGE, PAGE_TOKEN, requests, setup, USER_TOKEN } from "./helpers.ts";

async function publish(env: ReturnType<typeof setup>, req: PublishRequest) {
  const { out, outcomes } = await drive(env, env.publisher.start(req), env.ctxFor(req));
  if (out.status !== "done") throw new Error(`not done: ${JSON.stringify(out)}`);
  return { result: out.result, outcomes };
}

describe("first comment (N13)", () => {
  it("instagram: posts the first comment after the permalink and returns its id", async () => {
    const env = setup();
    const req = { ...requests.igImage(), firstComment: "#tarım #hasat" } as PublishRequest;
    const { result } = await publish(env, req);
    const mediaId = result.externalId as string;
    const comments = env.fake.commentsOf(mediaId);
    expect(comments).toHaveLength(1);
    expect(comments[0]?.text).toBe("#tarım #hasat");
    expect(comments[0]?.own).toBe(true);
    expect(result.firstCommentId).toBe(comments[0]?.id);
    expect(result.warnings.some((w) => w.code === "FIRST_COMMENT_FAILED")).toBe(false);
    // The comment comes after the publish and the permalink.
    const names = env.fake.calls.map((c) => c.route);
    expect(names.lastIndexOf("comments.create")).toBeGreaterThan(
      names.lastIndexOf("ig.media_publish"),
    );
  });

  it("without a first comment nothing is read or posted", async () => {
    const env = setup();
    await publish(env, requests.igImage());
    expect(env.fake.routeCalls("comments.list")).toHaveLength(0);
    expect(env.fake.routeCalls("comments.create")).toHaveLength(0);
  });

  it("a failed comment is a warning; the post stays published", async () => {
    const env = setup();
    env.fake.failNext("comments.create", { code: 10, message: "(#10) permission" });
    const req = { ...requests.igCarousel(), firstComment: "İlk yorum" } as PublishRequest;
    const { result } = await publish(env, req);
    expect(result.externalId).toBeTruthy();
    expect(result.firstCommentId).toBeNull();
    const w = result.warnings.find((x) => x.code === "FIRST_COMMENT_FAILED");
    expect(w?.message).toMatch(/ilk yorum eklenemedi \(yorum izni yok/);
    expect(env.fake.igPublishedMedia(IG)).toHaveLength(1);
  });

  it("a lost response is reconciled: the comment is not posted twice", async () => {
    const env = setup();
    env.fake.dropResponse("comments.create");
    const req = { ...requests.igImage(), firstComment: "Kaydırın 👉" } as PublishRequest;
    const start = env.publisher.start(req);
    // Run until first_comment fails (lost response → warning), then re-run the same step from
    // the persisted state before it, as a crashed worker would.
    let s = start;
    let beforeComment = s;
    for (let i = 0; i < 100; i++) {
      if ((s as { phase: string }).phase === "first_comment") beforeComment = s;
      const out = await env.publisher.step(s, env.igCtx);
      s = JSON.parse(JSON.stringify(out.state));
      if (out.status === "done") break;
      if (out.status === "wait") env.clock.advance(out.resumeAt - env.clock.now());
    }
    const mediaId = (s as { mediaId: string }).mediaId;
    expect(env.fake.commentsOf(mediaId)).toHaveLength(1);
    const again = await env.publisher.step(beforeComment, env.igCtx);
    expect(again.status).toBe("done");
    expect(env.fake.commentsOf(mediaId)).toHaveLength(1);
    if (again.status === "done") expect(again.result.firstCommentId).toBeTruthy();
  });

  it("facebook: comments on the post id (photo) and on the video (reel)", async () => {
    const env = setup();
    const photo = await publish(env, {
      ...requests.fbPhoto(),
      firstComment: "Detaylar yorumda",
    } as PublishRequest);
    const postId = photo.result.postId as string;
    expect(env.fake.commentsOf(postId).map((c) => c.text)).toEqual(["Detaylar yorumda"]);
    const reel = await publish(env, {
      ...requests.fbReelUrl(),
      firstComment: "Reels yorumu",
    } as PublishRequest);
    const target = reel.result.postId ?? reel.result.externalId;
    expect(env.fake.commentsOf(target as string).map((c) => c.text)).toEqual(["Reels yorumu"]);
  });
});

describe("detail params (N13)", () => {
  it("carousel image items carry their own user tags and alt text", async () => {
    const env = setup();
    const req: PublishRequest = {
      kind: "instagram.carousel",
      igUserId: IG,
      items: [
        {
          kind: "image",
          url: "https://media.example.com/a.jpg",
          mimeType: "image/jpeg",
          width: 1080,
          height: 1350,
          bytes: 1000,
          altText: "Birinci kare",
          userTags: [{ username: "ciftci.ali", x: 0.5, y: 0.25 }],
        },
        {
          kind: "image",
          url: "https://media.example.com/b.jpg",
          mimeType: "image/jpeg",
          width: 1080,
          height: 1350,
          bytes: 1000,
        },
      ],
      caption: "x",
      locationId: "110011001100",
      collaborators: ["ortak.marka"],
    };
    await publish(env, req);
    const creates = env.fake.routeCalls("ig.media.create");
    expect(creates[0]?.form.user_tags).toBe('[{"username":"ciftci.ali","x":0.5,"y":0.25}]');
    expect(creates[0]?.form.alt_text).toBe("Birinci kare");
    expect(creates[1]?.form.user_tags).toBeUndefined();
    const parent = creates.find((c) => c.form.media_type === "CAROUSEL");
    expect(parent?.form).toMatchObject({
      location_id: "110011001100",
      collaborators: '["ortak.marka"]',
    });
  });

  it("reels: user tags go without positions, cover and share_to_feed are sent", async () => {
    const env = setup();
    const req = {
      ...requests.igReelUrl(),
      userTags: [{ username: "ciftci.ali", x: 0.3, y: 0.3 }],
      shareToFeed: false,
    } as PublishRequest;
    await publish(env, req);
    const create = env.fake.routeCalls("ig.media.create")[0];
    expect(create?.form.user_tags).toBe('[{"username":"ciftci.ali"}]');
    expect(create?.form.share_to_feed).toBe("false");
    expect(create?.form.thumb_offset).toBe("2000");
  });

  it("validates first comments, user tags and usernames", () => {
    const long = "a".repeat(2201);
    const ig = validateRequest({ ...requests.igImage(), firstComment: long });
    expect(ig.errors.map((e) => e.code)).toContain("FIRST_COMMENT_TOO_LONG");
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    expect(
      validateRequest({ ...requests.igImage(), firstComment: tags }).errors.map((e) => e.code),
    ).toContain("TOO_MANY_HASHTAGS");
    const fb = validateRequest({ ...requests.fbPhoto(), firstComment: "b".repeat(8001) });
    expect(fb.errors.map((e) => e.code)).toContain("FIRST_COMMENT_TOO_LONG");
    expect(validateRequest({ ...requests.fbPhoto(), firstComment: "b".repeat(5000) }).ok).toBe(
      true,
    );
    const many = Array.from({ length: 21 }, (_, i) => ({ username: `u${i}`, x: 0.1, y: 0.1 }));
    expect(
      validateRequest({ ...requests.igImage(), userTags: many }).errors.map((e) => e.code),
    ).toContain("TOO_MANY_USER_TAGS");
    expect(
      validateRequest({
        ...requests.igImage(),
        userTags: [{ username: "boşluklu ad", x: 0.1, y: 0.1 }],
      }).errors.map((e) => e.code),
    ).toContain("USERNAME_INVALID");
    expect(
      validateRequest({ ...requests.igImage(), collaborators: ["a", "b", "c", "d"] }).errors.map(
        (e) => e.code,
      ),
    ).toContain("TOO_MANY_COLLABORATORS");
    expect(
      validateRequest({ ...requests.igImage(), userTags: [{ username: "ali" }] }).errors.map(
        (e) => e.code,
      ),
    ).toContain("USER_TAG_POSITION_REQUIRED");
    // Reels need no positions.
    expect(validateRequest({ ...requests.igReelUrl(), userTags: [{ username: "ali" }] }).ok).toBe(
      true,
    );
  });
});

describe("insights (N15)", () => {
  it("instagram feed: counts plus reach, saves, shares, views, interactions", async () => {
    const env = setup();
    const { result } = await publish(env, requests.igImage());
    const id = result.externalId as string;
    env.fake.likes.set(id, 40);
    env.fake.addComment(id, { text: "Harika" });
    env.fake.insights.set(id, {
      reach: 900,
      saved: 12,
      shares: 5,
      views: 1500,
      total_interactions: 58,
    });
    const read = await readInstagramMediaInsights(env.publisher.graph, id, USER_TOKEN);
    expect(read.status).toBe("ok");
    expect(read.productType).toBe("FEED");
    expect(read.metrics).toEqual({
      likes: 40,
      comments: 1,
      reach: 900,
      saves: 12,
      shares: 5,
      views: 1500,
      interactions: 58,
    });
    // Retired metrics are never asked for.
    const metricQuery = env.fake.routeCalls("insights.read")[0]?.query.metric ?? "";
    expect(metricQuery).not.toMatch(/impressions|plays/);
  });

  it("instagram reels: plays are the views; watch time is read", async () => {
    const env = setup();
    const { result } = await publish(env, requests.igReelUrl());
    const id = result.externalId as string;
    env.fake.insights.set(id, { views: 3000, reach: 2000, ig_reels_avg_watch_time: 4200 });
    const read = await readInstagramMediaInsights(env.publisher.graph, id, USER_TOKEN);
    expect(read.metrics).toMatchObject({ views: 3000, plays: 3000, reach: 2000, avgWatchMs: 4200 });
  });

  it("falls back to a smaller metric set when Meta refuses one", async () => {
    const env = setup();
    const { result } = await publish(env, requests.igImage());
    const id = result.externalId as string;
    env.fake.refusedMetrics.add("total_interactions");
    env.fake.insights.set(id, { reach: 10, saved: 1, shares: 2 });
    const read = await readInstagramMediaInsights(env.publisher.graph, id, USER_TOKEN);
    expect(read.status).toBe("ok");
    expect(read.metrics).toMatchObject({ reach: 10, saves: 1, shares: 2 });
    expect(env.fake.routeCalls("insights.read")).toHaveLength(2);
  });

  it("without instagram_manage_insights: counts only, partial, with a reconnect note", async () => {
    const env = setup();
    const { result } = await publish(env, requests.igImage());
    const id = result.externalId as string;
    env.fake.revokeScope(USER_TOKEN, "instagram_manage_insights");
    env.fake.likes.set(id, 3);
    const read = await readInstagramMediaInsights(env.publisher.graph, id, USER_TOKEN);
    expect(read.status).toBe("partial");
    expect(read.metrics).toEqual({ likes: 3, comments: 0 });
    expect(read.error?.kind).toBe("permission");
    expect(read.note).toMatch(/yeniden bağlayıp/);
  });

  it("a deleted media is a status, not an error", async () => {
    const env = setup();
    const { result } = await publish(env, requests.igImage());
    env.fake.deleteObject(result.externalId as string);
    const read = await readInstagramMediaInsights(
      env.publisher.graph,
      result.externalId as string,
      USER_TOKEN,
    );
    expect(read.status).toBe("deleted");
  });

  it("rate limits and expired tokens stop the account (thrown)", async () => {
    const env = setup();
    const { result } = await publish(env, requests.igImage());
    const id = result.externalId as string;
    env.fake.failNext(
      "insights.read",
      { code: 4, message: "Application request limit reached", isTransient: true },
      10,
    );
    const err = await readInstagramMediaInsights(env.publisher.graph, id, USER_TOKEN).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(EngagementCallError);
    expect(classifyEngagementError(err).kind).toBe("rate_limit");
    expect(classifyEngagementError(err).retryAfterMs).toBeGreaterThan(0);

    env.fake.expireToken(USER_TOKEN);
    const auth = await readInstagramMediaInsights(env.publisher.graph, id, USER_TOKEN).catch(
      (e: unknown) => e,
    );
    expect(auth).toBeInstanceOf(GraphError);
    expect(classifyEngagementError(auth).kind).toBe("auth");
  });

  it("facebook post: reactions, comments, shares, views and reach; old metric names as fallback", async () => {
    const env = setup();
    const { result } = await publish(env, requests.fbPhoto());
    const postId = result.postId as string;
    env.fake.likes.set(postId, 7);
    env.fake.shares.set(postId, 2);
    env.fake.addComment(postId, { text: "Fiyat?" });
    env.fake.insights.set(postId, {
      post_media_view: 500,
      post_total_media_view_unique: 320,
      post_clicks: 9,
      post_impressions: 480,
      post_impressions_unique: 300,
    });
    const read = await readFacebookPostInsights(env.publisher.graph, postId, PAGE_TOKEN, "post");
    expect(read.metrics).toEqual({
      likes: 7,
      comments: 1,
      shares: 2,
      views: 500,
      reach: 320,
      clicks: 9,
      interactions: 10,
    });
    env.fake.refusedMetrics.add("post_media_view");
    const old = await readFacebookPostInsights(env.publisher.graph, postId, PAGE_TOKEN, "post");
    expect(old.metrics).toMatchObject({ views: 480, reach: 300 });
  });

  it("facebook reel: plays from video_insights", async () => {
    const env = setup();
    const { result } = await publish(env, requests.fbReelUrl());
    const videoId = result.externalId as string;
    env.fake.insights.set(videoId, { blue_reels_play_count: 77, post_impressions_unique: 50 });
    const read = await readFacebookPostInsights(env.publisher.graph, videoId, PAGE_TOKEN, "reel");
    expect(read.status).toBe("ok");
    expect(read.metrics).toMatchObject({ plays: 77, views: 77, reach: 50 });
  });

  it("follower counts of both account kinds", async () => {
    const env = setup();
    env.fake.followers.set(IG, 1234);
    env.fake.followers.set(PAGE, 567);
    expect(await readFollowerCount(env.publisher.graph, "instagram", IG, USER_TOKEN)).toBe(1234);
    expect(await readFollowerCount(env.publisher.graph, "facebook", PAGE, PAGE_TOKEN)).toBe(567);
  });

  it("parses lifetime values and total_value rows", () => {
    expect(
      parseInsightRows([
        { name: "reach", values: [{ value: 5 }] },
        { name: "views", total_value: { value: 9 } },
        { name: "post_reactions_by_type_total", values: [{ value: { like: 2, love: 1 } }] },
        { name: "broken", values: [{ value: "x" }] },
      ]),
    ).toEqual({ reach: 5, views: 9, post_reactions_by_type_total: 3 });
  });
});

describe("comments (N16)", () => {
  it("instagram: counts, comments with replies, reply, reconcile, hide, delete", async () => {
    const env = setup();
    const { result } = await publish(env, requests.igImage());
    const id = result.externalId as string;
    const graph = env.publisher.graph;
    const c1 = env.fake.addComment(id, { text: "Fiyatı ne kadar?", author: "ayse" });
    env.fake.addComment(id, { text: "Teşekkürler", author: "ali", parentId: c1.id });
    env.fake.addComment(id, { text: "Süper", author: "veli" });

    const counts = await listInstagramCommentCounts(graph, IG, USER_TOKEN);
    expect(counts.find((m) => m.id === id)?.comments).toBe(3);

    const list = await readComments(graph, "instagram", id, USER_TOKEN);
    expect(list.map((c) => [c.text, c.author, c.parentId === null])).toEqual([
      ["Fiyatı ne kadar?", "ayse", true],
      ["Teşekkürler", "ali", false],
      ["Süper", "veli", true],
    ]);

    expect(await findReply(graph, "instagram", c1.id, "DM attık", USER_TOKEN)).toBeNull();
    const replyId = await replyToComment(graph, "instagram", c1.id, "DM attık", USER_TOKEN);
    expect(replyId).toBeTruthy();
    expect(env.fake.routeCalls("comments.create").at(-1)?.path).toBe(`/${c1.id}/replies`);
    expect(await findReply(graph, "instagram", c1.id, "  DM   attık ", USER_TOKEN)).toBe(replyId);

    await setCommentHidden(graph, "instagram", c1.id, true, USER_TOKEN);
    expect(env.fake.comments.get(c1.id)?.hidden).toBe(true);
    expect(env.fake.routeCalls("comment.update").at(-1)?.form).toEqual({ hide: "true" });

    await deleteComment(graph, c1.id, USER_TOKEN);
    expect(env.fake.comments.get(c1.id)?.deleted).toBe(true);
    const err = await deleteComment(graph, c1.id, USER_TOKEN).catch((e: unknown) => e);
    expect(classifyEngagementError(err).kind).toBe("deleted");
  });

  it("instagram without instagram_manage_comments: permission", async () => {
    const env = setup();
    const { result } = await publish(env, requests.igImage());
    env.fake.revokeScope(USER_TOKEN, "instagram_manage_comments");
    const err = await readComments(
      env.publisher.graph,
      "instagram",
      result.externalId as string,
      USER_TOKEN,
    ).catch((e: unknown) => e);
    expect(classifyEngagementError(err).kind).toBe("permission");
  });

  it("facebook: count, flat stream with parents, reply via /comments, hide", async () => {
    const env = setup();
    const { result } = await publish(env, requests.fbPhoto());
    const postId = result.postId as string;
    const graph = env.publisher.graph;
    const top = env.fake.addComment(postId, { text: "Stok var mı?", author: "Ayşe Y." });
    env.fake.addComment(postId, { text: "Evet", parentId: top.id, author: "MTM Agro", own: true });
    expect(await readFacebookCommentCount(graph, postId, PAGE_TOKEN)).toBe(2);
    const list = await readComments(graph, "facebook", postId, PAGE_TOKEN);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ text: "Stok var mı?", author: "Ayşe Y.", parentId: null });
    expect(list[1]).toMatchObject({ text: "Evet", parentId: top.id });

    const reply = await replyToComment(graph, "facebook", top.id, "Mesaj attık", PAGE_TOKEN);
    expect(reply).toBeTruthy();
    expect(env.fake.routeCalls("comments.create").at(-1)?.path).toBe(`/${top.id}/comments`);
    expect(await findReply(graph, "facebook", top.id, "Mesaj attık", PAGE_TOKEN)).toBe(reply);
    await setCommentHidden(graph, "facebook", top.id, true, PAGE_TOKEN);
    expect(env.fake.routeCalls("comment.update").at(-1)?.form).toEqual({ is_hidden: "true" });
  });

  it("pages through long comment lists", async () => {
    const env = setup();
    const { result } = await publish(env, requests.igImage());
    const id = result.externalId as string;
    for (let i = 0; i < 120; i++) env.fake.addComment(id, { text: `c${i}`, at: 1_000 + i });
    const list = await readComments(env.publisher.graph, "instagram", id, USER_TOKEN);
    expect(list).toHaveLength(120);
    expect(env.fake.routeCalls("comments.list").length).toBe(3);
    const capped = await readComments(env.publisher.graph, "instagram", id, USER_TOKEN, {
      max: 60,
    });
    expect(capped).toHaveLength(60);
  });

  it("uses the page token for facebook and never puts tokens in URLs", async () => {
    const env = setup();
    const { result } = await publish(env, requests.fbPhoto());
    await readComments(env.publisher.graph, "facebook", result.postId as string, PAGE_TOKEN);
    for (const call of env.fake.calls) {
      expect(JSON.stringify(call.query)).not.toContain("EAA");
    }
    expect(PAGE).toBeTruthy();
  });
});
