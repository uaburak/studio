import { describe, expect, it } from "vitest";
import {
  createPublisher,
  LINKEDIN_API_VERSION,
  LINKEDIN_LIMITS,
  type LinkedInState,
  type LogEvent,
  type PublishRequest,
  type PublishState,
  type StepContext,
  type StepOutcome,
  toLittleText,
  validateRequest,
} from "../src/index.ts";
import { FakeClock, FakeLinkedIn, memoryMediaReader } from "../src/testing/index.ts";

const AUTHOR = "urn:li:person:deniz123";
const VALID_TOKEN = "AQVsecretLinkedInAccessToken999999999999";
const EXPIRED_TOKEN = "AQVexpiredLinkedInAccessToken00000000000";

function makeEnv() {
  const clock = new FakeClock();
  const server = new FakeLinkedIn({ clock, revokedTokens: [EXPIRED_TOKEN] });
  const logs: LogEvent[] = [];
  const publisher = createPublisher({
    fetch: server.fetch,
    clock,
    sleep: clock.sleep,
    logger: (e) => logs.push(e),
  });
  const pdfBytes = new TextEncoder().encode("%PDF-1.7 uploaded carousel bytes");
  const videoBytes = new Uint8Array(12).map((_, i) => i + 10);
  const media = memoryMediaReader({
    "docs/carousel.pdf": pdfBytes,
    "videos/demo.mp4": videoBytes,
  });
  const ctx: StepContext = { accessToken: VALID_TOKEN, media };
  return { clock, server, publisher, logs, media, ctx, pdfBytes, videoBytes };
}

async function driveToEnd(
  env: ReturnType<typeof makeEnv>,
  initial: PublishState,
  ctx = env.ctx,
): Promise<{
  out: StepOutcome<PublishState>;
  outcomes: StepOutcome<PublishState>[];
  state: PublishState;
}> {
  const outcomes: StepOutcome<PublishState>[] = [];
  let s = initial;
  for (let i = 0; i < 50; i++) {
    const out = await env.publisher.step(s, ctx);
    outcomes.push(out);
    s = JSON.parse(JSON.stringify(out.state)) as PublishState;
    if (out.status === "done" || out.status === "failed") return { out, outcomes, state: s };
    if (out.status === "wait") env.clock.advance(Math.max(0, out.resumeAt - env.clock.now()));
  }
  throw new Error("exceeded max steps");
}

describe("LinkedInPublisher", () => {
  it("publishes a text post and constructs permalink from x-restli-id", async () => {
    const env = makeEnv();
    const req: PublishRequest = {
      kind: "linkedin.text",
      authorUrn: AUTHOR,
      commentary: "Yeni tarım teknolojileri üzerine notlar.",
    };
    const state = env.publisher.start(req);
    expect(state.phase).toBe("create_post");

    const { out } = await driveToEnd(env, state);
    expect(out.status).toBe("done");
    if (out.status !== "done") return;

    expect(out.result).toMatchObject({
      platform: "linkedin",
      kind: "linkedin.text",
      externalId: "urn:li:share:post-1",
      postId: "urn:li:share:post-1",
      permalink: "https://www.linkedin.com/feed/update/urn:li:share:post-1/",
    });

    const postCall = env.server.calls[0];
    expect(postCall?.headers["linkedin-version"]).toBe(LINKEDIN_API_VERSION);
    expect(postCall?.headers["x-restli-protocol-version"]).toBe("2.0.0");
    expect(postCall?.headers.authorization).toBe(`Bearer ${VALID_TOKEN}`);
    expect(env.server.posts[0]?.body).toMatchObject({
      author: AUTHOR,
      commentary: "Yeni tarım teknolojileri üzerine notlar.",
      visibility: "PUBLIC",
      lifecycleState: "PUBLISHED",
    });
  });

  it("publishes a single image post through init_upload -> upload_binary -> create_post", async () => {
    const env = makeEnv();
    const req: PublishRequest = {
      kind: "linkedin.image",
      authorUrn: AUTHOR,
      image: {
        kind: "image",
        url: "https://media.example.com/hero.jpg",
        mimeType: "image/jpeg",
        bytes: 8,
        altText: "Traktör görseli",
      },
      commentary: "Hasat hazırlığı",
    };
    const state = env.publisher.start(req);
    expect(state.phase).toBe("init_upload");

    const { out, outcomes } = await driveToEnd(env, state);
    expect(out.status).toBe("done");
    expect(outcomes.map((o) => o.state.phase)).toEqual(["upload_binary", "create_post", "done"]);
    expect(env.server.posts[0]?.body).toMatchObject({
      author: AUTHOR,
      commentary: "Hasat hazırlığı",
      content: {
        media: {
          id: "urn:li:image:img-1",
          altText: "Traktör görseli",
        },
      },
    });
  });

  it("publishes a multi-image post in display order", async () => {
    const env = makeEnv();
    const req: PublishRequest = {
      kind: "linkedin.multi_image",
      authorUrn: AUTHOR,
      images: [
        {
          kind: "image",
          url: "https://media.example.com/1.jpg",
          mimeType: "image/jpeg",
          bytes: 8,
          altText: "Bir",
        },
        {
          kind: "image",
          url: "https://media.example.com/2.jpg",
          mimeType: "image/png",
          bytes: 8,
          altText: "İki",
        },
        { kind: "image", url: "https://media.example.com/3.jpg", mimeType: "image/jpeg", bytes: 8 },
      ],
      commentary: "Üç karede fuar",
    };
    const { out } = await driveToEnd(env, env.publisher.start(req));
    expect(out.status).toBe("done");
    expect(env.server.posts[0]?.body).toMatchObject({
      content: {
        multiImage: {
          images: [
            { id: "urn:li:image:img-1", altText: "Bir" },
            { id: "urn:li:image:img-2", altText: "İki" },
            { id: "urn:li:image:img-3" },
          ],
        },
      },
    });
  });

  it("publishes a LinkedIn PDF document carousel", async () => {
    const env = makeEnv();
    const req: PublishRequest = {
      kind: "linkedin.document",
      authorUrn: AUTHOR,
      document: {
        kind: "document",
        source: { type: "upload", key: "docs/carousel.pdf" },
        mimeType: "application/pdf",
        bytes: env.pdfBytes.byteLength,
      },
      title: "2026 Tarım Raporu",
      commentary: "Kaydırarak inceleyin",
    };
    const { out } = await driveToEnd(env, env.publisher.start(req));
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(out.result.permalink).toBe("https://www.linkedin.com/feed/update/urn:li:share:post-3/");
    expect(env.server.uploadedBytes.get("/dms-uploads/doc-1")).toEqual(env.pdfBytes);
    expect(env.server.posts[0]?.body).toMatchObject({
      content: {
        media: {
          title: "2026 Tarım Raporu",
          id: "urn:li:document:doc-1",
        },
      },
    });
  });

  it("publishes a video post with multipart uploadInstructions and finalizeUpload", async () => {
    const env = makeEnv();
    const req: PublishRequest = {
      kind: "linkedin.video",
      authorUrn: AUTHOR,
      video: {
        kind: "video",
        source: { type: "upload", key: "videos/demo.mp4" },
        mimeType: "video/mp4",
        bytes: env.videoBytes.byteLength,
        durationMs: 15_000,
      },
      title: "Saha Videosu",
      commentary: "Yeni sezon",
    };
    const { out } = await driveToEnd(env, env.publisher.start(req));
    expect(out.status).toBe("done");
    expect(env.server.uploadedBytes.get("/dms-uploads/vid-1")).toEqual(env.videoBytes);
    expect(env.server.finalizedVideos).toEqual([
      {
        video: "urn:li:video:vid-1",
        uploadToken: "tok-1",
        uploadedPartIds: ['"etag-2"', '"etag-3"'],
      },
    ]);
    expect(env.server.posts[0]?.body).toMatchObject({
      content: {
        media: {
          title: "Saha Videosu",
          id: "urn:li:video:vid-1",
        },
      },
    });
  });

  it("maps 401 to TOKEN_INVALID (reauth), redacts the token, and resumes with a fresh token", async () => {
    const env = makeEnv();
    const req: PublishRequest = {
      kind: "linkedin.image",
      authorUrn: AUTHOR,
      image: {
        kind: "image",
        url: "https://media.example.com/hero.jpg",
        mimeType: "image/jpeg",
        bytes: 8,
      },
      commentary: "Test",
    };
    const initial = env.publisher.start(req);
    const failed = await driveToEnd(env, initial, { ...env.ctx, accessToken: EXPIRED_TOKEN });
    expect(failed.out.status).toBe("failed");
    if (failed.out.status !== "failed") return;

    expect(failed.out.error).toMatchObject({
      code: "TOKEN_INVALID",
      action: "reauth",
      retryable: false,
    });
    expect(JSON.stringify(failed.out.error)).not.toContain(EXPIRED_TOKEN);
    expect(JSON.stringify(env.logs)).not.toContain(EXPIRED_TOKEN);
    expect(failed.state.phase).toBe("init_upload");

    // Reconnect and resume from persisted state.
    const resumed = await driveToEnd(env, failed.state, env.ctx);
    expect(resumed.out.status).toBe("done");
  });

  it("maps 429 to RATE_LIMITED wait outcome respecting Retry-After and succeeds on retry", async () => {
    const env = makeEnv();
    env.server.rateLimitNext(1, 60);
    const req: PublishRequest = {
      kind: "linkedin.text",
      authorUrn: AUTHOR,
      commentary: "Hız sınırı testi",
    };
    const initial = env.publisher.start(req);
    const first = await env.publisher.step(initial, env.ctx);
    expect(first.status).toBe("wait");
    if (first.status !== "wait") return;
    expect(first.reason).toBe("retry");
    expect(first.resumeAt - env.clock.now()).toBe(60_000);
    expect(first.state.lastError?.code).toBe("RATE_LIMITED");

    env.clock.advance(60_000);
    const second = await env.publisher.step(first.state, env.ctx);
    expect(second.status).toBe("done");
  });

  it("enforces LINKEDIN_LIMITS in pre-flight validation", () => {
    expect(
      validateRequest({
        kind: "linkedin.text",
        authorUrn: AUTHOR,
        commentary: "x".repeat(LINKEDIN_LIMITS.commentary.maxChars + 1),
      }).errors.map((e) => e.code),
    ).toContain("CAPTION_TOO_LONG");

    expect(
      validateRequest({
        kind: "linkedin.multi_image",
        authorUrn: AUTHOR,
        images: [
          {
            kind: "image",
            url: "https://media.example.com/1.jpg",
            mimeType: "image/jpeg",
            bytes: 100,
          },
        ],
      }).errors.map((e) => e.code),
    ).toContain("CAROUSEL_TOO_FEW_ITEMS");

    expect(
      validateRequest({
        kind: "linkedin.document",
        authorUrn: AUTHOR,
        title: "Rapor",
        document: {
          kind: "document",
          url: "https://media.example.com/big.pdf",
          mimeType: "application/pdf",
          bytes: LINKEDIN_LIMITS.document.maxBytes + 1,
        },
      }).errors.map((e) => e.code),
    ).toContain("DOCUMENT_TOO_LARGE");

    expect(
      validateRequest({
        kind: "linkedin.video",
        authorUrn: AUTHOR,
        video: {
          kind: "video",
          source: { type: "url", url: "https://media.example.com/big.mp4" },
          mimeType: "video/mp4",
          bytes: LINKEDIN_LIMITS.video.maxBytes + 1,
          durationMs: 10_000,
        },
      }).errors.map((e) => e.code),
    ).toContain("VIDEO_TOO_LARGE");
  });
});

describe("LinkedIn publishing safety (Y7, Y15)", () => {
  it("escapes little-text reserved characters and keeps #hashtags as hashtag templates", async () => {
    const caption =
      "Fiyat (KDV dahil) [yeni] @mtm *özel* _not_ ~ <b> {x} | a\\b #hasat #mtm_agro C#";
    expect(toLittleText(caption)).toBe(
      "Fiyat \\(KDV dahil\\) \\[yeni\\] \\@mtm \\*özel\\* \\_not\\_ \\~ \\<b\\> \\{x\\} \\| a\\\\b " +
        "{hashtag|\\#|hasat} \\#mtm\\_agro C\\#",
    );
    expect(toLittleText("Şimdi #Tarım2026!")).toBe("Şimdi {hashtag|\\#|Tarım2026}!");

    const env = makeEnv();
    const { out } = await driveToEnd(
      env,
      env.publisher.start({ kind: "linkedin.text", authorUrn: AUTHOR, commentary: caption }),
    );
    expect(out.status).toBe("done");
    expect(env.server.posts[0]?.body.commentary).toBe(toLittleText(caption));
  });

  it("does not post twice when a post call's answer is lost: the duplicate refusal links the post", async () => {
    const env = makeEnv();
    env.server.loseNextPostResponse("network");
    const state = env.publisher.start({
      kind: "linkedin.text",
      authorUrn: AUTHOR,
      commentary: "Hasat başladı",
    });
    const { out, outcomes } = await driveToEnd(env, state);
    // The lost answer was a retryable network error, not a failure.
    expect(outcomes[0]?.status).toBe("wait");
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(env.server.posts).toHaveLength(1);
    expect(out.result).toMatchObject({
      externalId: env.server.posts[0]?.urn,
      reconciled: true,
    });
    expect(out.result.warnings.map((w) => w.code)).not.toContain("LINKEDIN_DUPLICATE_LINKED");
  });

  it("finds the post among the author's posts (when readable) before posting again", async () => {
    const env = makeEnv();
    env.server.allowAuthorLookup = true;
    env.server.loseNextPostResponse("504");
    const req: PublishRequest = {
      kind: "linkedin.image",
      authorUrn: AUTHOR,
      image: {
        kind: "image",
        url: "https://media.example.com/hero.jpg",
        mimeType: "image/jpeg",
        bytes: 8,
      },
      commentary: "Yeni sezon (2026)",
    };
    const { out } = await driveToEnd(env, env.publisher.start(req));
    expect(out.status).toBe("done");
    if (out.status !== "done") return;
    expect(env.server.postCalls()).toHaveLength(1);
    expect(env.server.posts).toHaveLength(1);
    expect(out.result).toMatchObject({ externalId: env.server.posts[0]?.urn, reconciled: true });
  });

  it("resumes a state saved after a lost answer without a second post (crash safety)", async () => {
    const env = makeEnv();
    env.server.loseNextPostResponse("network");
    const first = await env.publisher.step(
      env.publisher.start({ kind: "linkedin.text", authorUrn: AUTHOR, commentary: "Tek sefer" }),
      env.ctx,
    );
    expect(first.status).toBe("wait");
    expect((first.state as LinkedInState).postCalls).toBe(1);
    // A different process picks the saved state up later.
    const saved = JSON.parse(JSON.stringify(first.state)) as PublishState;
    const { out } = await driveToEnd(env, saved);
    expect(out.status).toBe("done");
    expect(env.server.posts).toHaveLength(1);
  });

  it("waits for the video to be AVAILABLE before creating the post", async () => {
    const env = makeEnv();
    env.server.videoProcessingPolls = 2;
    const req: PublishRequest = {
      kind: "linkedin.video",
      authorUrn: AUTHOR,
      video: {
        kind: "video",
        source: { type: "upload", key: "videos/demo.mp4" },
        mimeType: "video/mp4",
        bytes: env.videoBytes.byteLength,
        durationMs: 15_000,
      },
      commentary: "Saha",
    };
    const { out, outcomes } = await driveToEnd(env, env.publisher.start(req));
    expect(out.status).toBe("done");
    expect(outcomes.filter((o) => o.status === "wait" && o.reason === "poll")).toHaveLength(2);
    const paths = env.server.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    const lastStatusRead = paths.lastIndexOf("GET /rest/videos/urn%3Ali%3Avideo%3Avid-1");
    expect(lastStatusRead).toBeGreaterThan(-1);
    expect(paths.indexOf("POST /rest/posts")).toBeGreaterThan(lastStatusRead);
    expect(env.server.videoReads.get("urn:li:video:vid-1")).toBe(3);
  });

  it("fails (no post) when LinkedIn cannot process the video", async () => {
    const env = makeEnv();
    env.server.failVideoProcessing = true;
    const { out } = await driveToEnd(
      env,
      env.publisher.start({
        kind: "linkedin.video",
        authorUrn: AUTHOR,
        video: {
          kind: "video",
          source: { type: "upload", key: "videos/demo.mp4" },
          mimeType: "video/mp4",
          bytes: env.videoBytes.byteLength,
          durationMs: 15_000,
        },
      }),
    );
    expect(out.status).toBe("failed");
    if (out.status !== "failed") return;
    expect(out.error.code).toBe("MEDIA_REJECTED");
    expect(env.server.posts).toHaveLength(0);
  });

  it("reads image bytes through the MediaReader when the request names an upload source", async () => {
    const env = makeEnv();
    const bytes = new Uint8Array([9, 8, 7, 6, 5]);
    const ctx: StepContext = {
      accessToken: VALID_TOKEN,
      media: memoryMediaReader({ "slide-1.jpg": bytes }),
    };
    const req: PublishRequest = {
      kind: "linkedin.image",
      authorUrn: AUTHOR,
      // Not served by anything: the publisher must not download its own public URL.
      image: {
        kind: "image",
        url: "https://publisher.test/media/o-1/999/sig/slide-1.jpg",
        source: { type: "upload", key: "slide-1.jpg" },
        mimeType: "image/jpeg",
        bytes: bytes.byteLength,
      },
      commentary: "Bulut",
    };
    const { out } = await driveToEnd(env, env.publisher.start(req), ctx);
    expect(out.status).toBe("done");
    expect(env.server.uploadedBytes.get("/dms-uploads/image-1")).toEqual(bytes);
    expect(env.server.calls.some((c) => c.url.includes("publisher.test"))).toBe(false);
  });
});
