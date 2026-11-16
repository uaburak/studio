import { describe, expect, it } from "vitest";
import type { InstagramState } from "../src/index.ts";
import {
  drive,
  IG,
  PAGE,
  publishedCount,
  type RequestName,
  requests,
  setup,
  VIDEO_BYTES,
} from "./helpers.ts";

const ALL = Object.keys(requests) as RequestName[];

describe("happy path for every content type", () => {
  it.each(ALL)("%s publishes once and returns ids and a permalink", async (name) => {
    const env = setup();
    const req = requests[name]();
    const state = env.publisher.start(req);
    const { out } = await drive(env, state, env.ctxFor(req));
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(out.result.kind).toBe(req.kind);
    expect(out.result.externalId).toBeTruthy();
    expect(out.result.permalink).toMatch(/^https:\/\/www\.(instagram|facebook)\.com\//);
    expect(out.result.reconciled).toBe(false);
    expect(publishedCount(env, req.kind)).toBe(1);
    expect(env.fake.stats.duplicatePublishAttempts).toBe(0);
  });
});

describe("instagram details", () => {
  it("sends the documented container params and surfaces quota", async () => {
    const env = setup();
    const { out } = await drive(env, env.publisher.start(requests.igImage()), env.igCtx);
    const create = env.fake.routeCalls("ig.media.create")[0];
    expect(create?.form).toMatchObject({
      image_url: "https://media.example.com/post-1.jpg",
      caption: "Hasat zamanı #tarım #buğday @mtmagro",
      alt_text: "Tarlada buğday başakları",
      collaborators: '["partner.brand"]',
      is_ai_generated: "true",
    });
    expect(out.status === "done" && out.result.quota).toMatchObject({
      usage: 0,
      total: 50,
      durationSeconds: 86400,
    });
    // Token goes in the Authorization header, never in the URL.
    for (const call of env.fake.calls) {
      expect(call.headers.authorization).toMatch(/^OAuth /);
      expect(JSON.stringify(call.query)).not.toContain("EAA");
    }
  });

  it("puts is_ai_generated on the carousel container only and children in order", async () => {
    const env = setup();
    await drive(env, env.publisher.start(requests.igCarousel()), env.igCtx);
    const creates = env.fake.routeCalls("ig.media.create");
    expect(creates).toHaveLength(4);
    const [a, b, c, parent] = creates.map((x) => x.form);
    expect(a).toMatchObject({ is_carousel_item: "true" });
    expect(a?.is_ai_generated).toBeUndefined();
    expect(c).toMatchObject({
      media_type: "VIDEO",
      video_url: "https://media.example.com/reel.mp4",
    });
    expect(parent).toMatchObject({
      media_type: "CAROUSEL",
      is_ai_generated: "true",
      caption: "Üç adımda ekim",
    });
    expect(JSON.parse(parent?.children ?? "[]")).toHaveLength(3);
    expect(b?.image_url).toContain("post-2");
  });

  it("encodes trial reels, thumb offset and share_to_feed", async () => {
    const env = setup();
    await drive(env, env.publisher.start(requests.igReelUrl()), env.igCtx);
    expect(env.fake.routeCalls("ig.media.create")[0]?.form).toMatchObject({
      media_type: "REELS",
      share_to_feed: "true",
      thumb_offset: "2000",
      trial_params: '{"graduation_strategy":"SS_PERFORMANCE"}',
    });
  });

  it("polls container status once per minute (documented cadence)", async () => {
    const env = setup({ videoProcessingMs: 150_000 });
    const { outcomes } = await drive(env, env.publisher.start(requests.igReelUrl()), env.igCtx);
    const waits = outcomes.filter((o) => o.status === "wait");
    expect(waits.length).toBe(3);
    for (const w of waits) {
      if (w.status === "wait") {
        expect(w.reason).toBe("poll");
      }
    }
    const statusReads = env.fake.routeCalls("node.get").map((c) => c.at);
    const gaps = statusReads.slice(1, 4).map((t, i) => t - (statusReads[i] as number));
    expect(gaps.every((g) => g === 60_000)).toBe(true);
  });

  it("fails with PROCESSING_TIMEOUT after 5 minutes but stays resumable", async () => {
    const env = setup({ videoProcessingMs: 20 * 60_000 });
    const { out, state } = await drive(env, env.publisher.start(requests.igReelUrl()), env.igCtx);
    expect(out.status).toBe("failed");
    if (out.status !== "failed") return;
    expect(out.error.code).toBe("PROCESSING_TIMEOUT");
    expect(out.error.retryable).toBe(true);
    expect(state.phase).toBe("wait_items");
    env.clock.advance(20 * 60_000);
    const again = await drive(env, state, env.igCtx);
    expect(again.out.status).toBe("done");
    expect(publishedCount(env, "instagram.reel")).toBe(1);
  });

  it("uploads pushed video bytes to rupload with offset/file_size headers", async () => {
    const env = setup();
    await drive(env, env.publisher.start(requests.igReelUpload()), env.igCtx);
    const create = env.fake.routeCalls("ig.media.create")[0];
    expect(create?.query.upload_type).toBe("resumable");
    expect(create?.form.video_url).toBeUndefined();
    const up = env.fake.routeCalls("ig.upload");
    expect(up).toHaveLength(1);
    expect(up[0]?.headers).toMatchObject({ offset: "0", file_size: String(VIDEO_BYTES.length) });
    expect(up[0]?.bodyBytes).toBe(VIDEO_BYTES.length);
    expect(up[0]?.host).toBe("rupload.facebook.com");
    const containerId = [...env.fake.containers.keys()][0];
    expect(up[0]?.path).toBe(`/ig-api-upload/v27.0/${containerId}`);
  });

  it("resumes an interrupted upload from Meta's bytes_transferred", async () => {
    const env = setup();
    env.fake.interruptUploadAfterBytes = 4_000;
    const { out } = await drive(env, env.publisher.start(requests.igReelUpload()), env.igCtx);
    expect(out.status).toBe("done");
    const ups = env.fake.routeCalls("ig.upload");
    expect(ups.map((u) => u.headers.offset)).toEqual(["0", "4000"]);
    expect(ups[1]?.bodyBytes).toBe(VIDEO_BYTES.length - 4_000);
    expect(env.media.reads.map((r) => r.offset)).toEqual([0, 4000]);
  });

  it("supports chunked pushed uploads when configured", async () => {
    const env = setup({ publisher: { machine: { uploadChunkBytes: 3_000 } } });
    const { out } = await drive(env, env.publisher.start(requests.igReelUpload()), env.igCtx);
    expect(out.status).toBe("done");
    expect(env.fake.routeCalls("ig.upload").map((u) => u.headers.offset)).toEqual([
      "0",
      "3000",
      "6000",
      "9000",
    ]);
  });

  it("reports config_issue as a partial success warning", async () => {
    const env = setup();
    const u = env.fake.igUsers.get(IG);
    if (u) u.nextConfigIssue = "CAPTION_NOT_ATTACHED";
    const { out } = await drive(env, env.publisher.start(requests.igImage()), env.igCtx);
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(out.result.externalId).toBeTruthy();
    expect(out.result.warnings).toContainEqual({
      code: "CONFIG_ISSUE_CAPTION_NOT_ATTACHED",
      message: expect.stringContaining("açıklama eklenemedi"),
    });
  });

  it("stops before creating containers when the quota is used up", async () => {
    const env = setup({ quotaTotal: 2 });
    const u = env.fake.igUsers.get(IG);
    u?.publishTimes.push(env.clock.now() - 1000, env.clock.now() - 2000);
    const { out, state } = await drive(env, env.publisher.start(requests.igImage()), env.igCtx);
    expect(out.status).toBe("failed");
    if (out.status !== "failed") return;
    expect(out.error).toMatchObject({
      code: "QUOTA_EXCEEDED",
      action: "wait_quota",
      retryable: true,
    });
    expect(out.error.message).toContain("2/2");
    expect(env.fake.routeCalls("ig.media.create")).toHaveLength(0);
    // Resumable after the 24h window moves on.
    env.clock.advance(24 * 3600_000);
    expect((await drive(env, state, env.igCtx)).out.status).toBe("done");
  });

  it("maps a quota error from media_publish (race with another publisher)", async () => {
    const env = setup();
    env.fake.failNext("ig.media_publish", {
      code: 9,
      subcode: 2207042,
      message:
        "You reached maximum number of posts that is allowed to be published by Content Publishing API.",
    });
    const { out } = await drive(env, env.publisher.start(requests.igImage()), env.igCtx);
    expect(out.status === "failed" && out.error.code).toBe("QUOTA_EXCEEDED");
    expect(out.status === "failed" && out.error.graph?.subcode).toBe(2207042);
  });

  it("recreates a container that failed with a retryable subcode, once", async () => {
    const env = setup();
    env.fake.nextContainerError = "Error: Media upload has failed with error code 2207053";
    const { out } = await drive(env, env.publisher.start(requests.igImage()), env.igCtx);
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(out.result.warnings.map((w) => w.code)).toContain("CONTAINER_RECREATED");
    expect(env.fake.routeCalls("ig.media.create")).toHaveLength(2);
  });

  it("fails permanently on a non-retryable container error", async () => {
    const env = setup();
    env.fake.nextContainerError = "Error: Media upload has failed with error code 2207026";
    const { out, state } = await drive(env, env.publisher.start(requests.igReelUrl()), env.igCtx);
    expect(out.status === "failed" && out.error).toMatchObject({
      code: "CONTAINER_FAILED",
      action: "fix_content",
    });
    expect(out.status === "failed" && out.error.message).toContain("2207026");
    expect(state.phase).toBe("failed");
  });

  it("recreates expired containers (24h) before publishing", async () => {
    const env = setup();
    let state = env.publisher.start(requests.igImage());
    // Run until armed, then let the container sit for a day.
    for (let i = 0; i < 20 && state.phase !== "publish"; i++) {
      const out = await env.publisher.step(state, env.igCtx);
      state = out.state;
      if (out.status === "wait") env.clock.advance(out.resumeAt - env.clock.now());
    }
    env.clock.advance(25 * 3600_000);
    const { out } = await drive(env, state, env.igCtx);
    expect(out.status).toBe("done");
    expect(env.fake.routeCalls("ig.media.create")).toHaveLength(2);
    expect(publishedCount(env, "instagram.image")).toBe(1);
  });

  it("maps media errors from Meta to Turkish messages", async () => {
    const env = setup();
    const req = requests.igImage();
    if (req.kind === "instagram.image") req.image.url = "https://unreachable.example.com/a.jpg";
    const { out } = await drive(env, env.publisher.start(req), env.igCtx);
    expect(out.status === "failed" && out.error).toMatchObject({
      code: "MEDIA_REJECTED",
      action: "fix_content",
      message: expect.stringContaining("herkese açık"),
    });
  });
});

describe("facebook details", () => {
  it("multi-photo uploads unpublished photos then one feed post with attached_media[i]", async () => {
    const env = setup();
    const { out } = await drive(env, env.publisher.start(requests.fbMultiPhoto()), env.fbCtx);
    const uploads = env.fake.routeCalls("fb.photos.create");
    expect(uploads).toHaveLength(3);
    expect(uploads.every((u) => u.form.published === "false")).toBe(true);
    const feed = env.fake.routeCalls("fb.feed.create")[0];
    expect(Object.keys(feed?.form ?? {}).filter((k) => k.startsWith("attached_media"))).toEqual([
      "attached_media[0]",
      "attached_media[1]",
      "attached_media[2]",
    ]);
    expect(JSON.parse(feed?.form["attached_media[0]"] ?? "{}")).toHaveProperty("media_fbid");
    expect(out.status === "done" && out.result.postId).toMatch(new RegExp(`^${PAGE}_`));
  });

  it("photo post passes caption and alt_text_custom", async () => {
    const env = setup();
    await drive(env, env.publisher.start(requests.fbPhoto()), env.fbCtx);
    expect(env.fake.routeCalls("fb.photos.create")[0]?.form).toMatchObject({
      caption: "Yeni ürün",
      alt_text_custom: "Ürün fotoğrafı",
      published: "true",
    });
  });

  it("chunked video upload follows Meta's start/end offsets", async () => {
    const env = setup({ fbChunkSize: 4096 });
    const { out } = await drive(env, env.publisher.start(requests.fbVideoUpload()), env.fbCtx);
    expect(out.status).toBe("done");
    const transfers = env.fake.routeCalls("fb.videos.transfer");
    expect(transfers.map((t) => t.form.start_offset)).toEqual(["0", "4096", "8192"]);
    expect(transfers.every((t) => t.host === "graph-video.facebook.com")).toBe(true);
    expect(env.fake.routeCalls("fb.videos.finish")).toHaveLength(1);
  });

  it("reel: start, rupload by file_url, finish with video_state=PUBLISHED, poll until published", async () => {
    const env = setup();
    const { out } = await drive(env, env.publisher.start(requests.fbReelUrl()), env.fbCtx);
    expect(out.status).toBe("done");
    const up = env.fake.routeCalls("fb.video.upload")[0];
    expect(up?.headers.file_url).toBe("https://media.example.com/reel.mp4");
    expect(env.fake.routeCalls("fb.reel_or_story.finish")[0]?.form).toMatchObject({
      upload_phase: "finish",
      video_state: "PUBLISHED",
      description: "Facebook Reels #tarım",
      is_ai_generated: "true",
    });
  });

  it("reel with pushed bytes resumes from bytes_transfered", async () => {
    const env = setup();
    env.fake.interruptUploadAfterBytes = 2_500;
    const { out } = await drive(env, env.publisher.start(requests.fbReelUpload()), env.fbCtx);
    expect(out.status).toBe("done");
    expect(env.fake.routeCalls("fb.video.upload").map((u) => u.headers.offset)).toEqual([
      "0",
      "2500",
    ]);
  });

  it("photo story returns the story post id", async () => {
    const env = setup();
    const { out } = await drive(env, env.publisher.start(requests.fbStoryPhoto()), env.fbCtx);
    expect(out.status === "done" && out.result.postId).toBe(env.fake.stories[0]?.postId);
  });
});

describe("tokens", () => {
  it("expired token fails with reauth and resumes after reconnecting", async () => {
    const env = setup();
    let state = env.publisher.start(requests.igImage()) as InstagramState;
    const first = await env.publisher.step(state, env.igCtx);
    state = first.state as InstagramState;
    env.fake.expireToken(env.igCtx.accessToken);
    const { out, state: after } = await drive(env, state, env.igCtx);
    expect(out.status).toBe("failed");
    if (out.status !== "failed") return;
    expect(out.error).toMatchObject({ code: "TOKEN_INVALID", action: "reauth" });
    expect(out.error.graph).toMatchObject({ code: 190, subcode: 463, fbtraceId: "AfakeTrace123" });
    expect(after.phase).toBe("create_items");
    env.fake.addUserToken("EAAnewtoken0000000000000000000000000");
    const resumed = await drive(env, after, {
      ...env.igCtx,
      accessToken: "EAAnewtoken0000000000000000000000000",
    });
    expect(resumed.out.status).toBe("done");
  });
});

describe("validation gate", () => {
  it("start() refuses invalid content with all issues listed", () => {
    const env = setup();
    const req = requests.igImage();
    if (req.kind === "instagram.image") {
      req.image.mimeType = "image/png";
      req.image.url = "https://media.example.com/a.png";
      req.caption = "#a ".repeat(31);
    }
    expect(() => env.publisher.start(req)).toThrowError(/JPEG/);
    try {
      env.publisher.start(req);
    } catch (e) {
      const data = (e as { data: { code: string; issues: { code: string }[] } }).data;
      expect(data.code).toBe("VALIDATION_FAILED");
      expect(data.issues.map((i) => i.code).sort()).toEqual([
        "IMAGE_FORMAT_UNSUPPORTED",
        "TOO_MANY_HASHTAGS",
      ]);
    }
  });
});
