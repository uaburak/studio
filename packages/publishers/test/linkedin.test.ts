import { describe, expect, it } from "vitest";
import {
  createPublisher,
  LINKEDIN_API_VERSION,
  LINKEDIN_LIMITS,
  type LogEvent,
  type PublishRequest,
  type PublishState,
  type StepContext,
  type StepOutcome,
  validateRequest,
} from "../src/index.ts";
import { FakeClock, memoryMediaReader } from "../src/testing/index.ts";

const AUTHOR = "urn:li:person:burak123";
const VALID_TOKEN = "AQVsecretLinkedInAccessToken999999999999";
const EXPIRED_TOKEN = "AQVexpiredLinkedInAccessToken00000000000";

interface RecordedLinkedInCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  json: unknown;
  bytes: Uint8Array;
}

class FakeLinkedInServer {
  readonly calls: RecordedLinkedInCall[] = [];
  readonly posts: { urn: string; body: Record<string, unknown> }[] = [];
  readonly uploadedBytes = new Map<string, Uint8Array>();
  readonly finalizedVideos: { video: string; uploadToken: string; uploadedPartIds: string[] }[] =
    [];
  private seq = 0;
  private rateLimitRemaining = 0;
  private retryAfterSec = 45;

  rateLimitNext(times = 1, retryAfterSec = 45) {
    this.rateLimitRemaining = times;
    this.retryAfterSec = retryAfterSec;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(rawUrl);
    const method = (init?.method ?? "GET").toUpperCase();
    const headersObj: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headersObj[k.toLowerCase()] = v;
    });

    // Serve fake external media assets for URL-based media sources.
    if (u.hostname === "media.example.com") {
      const ext = u.pathname.split(".").pop();
      const content =
        ext === "pdf"
          ? new TextEncoder().encode("%PDF-1.7 fake carousel")
          : new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
      const type = ext === "pdf" ? "application/pdf" : ext === "mp4" ? "video/mp4" : "image/jpeg";
      return new Response(content, { status: 200, headers: { "content-type": type } });
    }

    let rawBytes: Uint8Array = new Uint8Array(0);
    if (init?.body !== undefined && init.body !== null) {
      rawBytes = new Uint8Array(await new Response(init.body).arrayBuffer());
    }
    let parsedJson: unknown = null;
    if (headersObj["content-type"]?.includes("application/json") && rawBytes.byteLength > 0) {
      parsedJson = JSON.parse(new TextDecoder().decode(rawBytes));
    }

    this.calls.push({
      method,
      url: rawUrl,
      path: `${u.pathname}${u.search}`,
      headers: headersObj,
      json: parsedJson,
      bytes: rawBytes,
    });

    // Verify mandatory LinkedIn headers on REST calls.
    const auth = headersObj.authorization ?? "";
    if (!auth.startsWith("Bearer ") || auth === `Bearer ${EXPIRED_TOKEN}`) {
      return new Response(
        JSON.stringify({
          status: 401,
          code: "REVOKED_ACCESS_TOKEN",
          message: `Token ${auth.replace(/^Bearer\s+/i, "")} has expired or been revoked`,
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    if (this.rateLimitRemaining > 0) {
      this.rateLimitRemaining--;
      return new Response(
        JSON.stringify({ status: 429, message: "Application rate limit reached" }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": String(this.retryAfterSec),
          },
        },
      );
    }

    // Binary upload PUTs
    if (method === "PUT" && u.pathname.startsWith("/dms-uploads/")) {
      const prev = this.uploadedBytes.get(u.pathname);
      const merged = new Uint8Array((prev?.byteLength ?? 0) + rawBytes.byteLength);
      if (prev) merged.set(prev, 0);
      merged.set(rawBytes, prev?.byteLength ?? 0);
      this.uploadedBytes.set(u.pathname, merged);
      return new Response(null, {
        status: 201,
        headers: { etag: `"etag-${++this.seq}"` },
      });
    }

    if (
      method === "POST" &&
      u.pathname === "/rest/images" &&
      u.searchParams.get("action") === "initializeUpload"
    ) {
      const id = ++this.seq;
      return Response.json({
        value: {
          image: `urn:li:image:img-${id}`,
          uploadUrl: `https://api.linkedin.com/dms-uploads/image-${id}`,
        },
      });
    }

    if (
      method === "POST" &&
      u.pathname === "/rest/documents" &&
      u.searchParams.get("action") === "initializeUpload"
    ) {
      const id = ++this.seq;
      return Response.json({
        value: {
          document: `urn:li:document:doc-${id}`,
          uploadUrl: `https://api.linkedin.com/dms-uploads/doc-${id}`,
        },
      });
    }

    if (
      method === "POST" &&
      u.pathname === "/rest/videos" &&
      u.searchParams.get("action") === "initializeUpload"
    ) {
      const id = ++this.seq;
      const reqBody = parsedJson as { initializeUploadRequest?: { fileSizeBytes?: number } };
      const size = reqBody?.initializeUploadRequest?.fileSizeBytes ?? 8;
      const mid = Math.floor(size / 2);
      return Response.json({
        value: {
          video: `urn:li:video:vid-${id}`,
          uploadToken: `tok-${id}`,
          uploadInstructions:
            size > 4
              ? [
                  {
                    uploadUrl: `https://api.linkedin.com/dms-uploads/vid-${id}`,
                    firstByte: 0,
                    lastByte: mid - 1,
                  },
                  {
                    uploadUrl: `https://api.linkedin.com/dms-uploads/vid-${id}`,
                    firstByte: mid,
                    lastByte: size - 1,
                  },
                ]
              : [
                  {
                    uploadUrl: `https://api.linkedin.com/dms-uploads/vid-${id}`,
                    firstByte: 0,
                    lastByte: size - 1,
                  },
                ],
        },
      });
    }

    if (
      method === "POST" &&
      u.pathname === "/rest/videos" &&
      u.searchParams.get("action") === "finalizeUpload"
    ) {
      const body = (
        parsedJson as {
          finalizeUploadRequest: { video: string; uploadToken: string; uploadedPartIds: string[] };
        }
      ).finalizeUploadRequest;
      this.finalizedVideos.push(body);
      return new Response(null, { status: 202 });
    }

    if (method === "POST" && u.pathname === "/rest/posts") {
      const urn = `urn:li:share:post-${++this.seq}`;
      this.posts.push({ urn, body: parsedJson as Record<string, unknown> });
      return new Response(null, {
        status: 201,
        headers: { "x-restli-id": urn },
      });
    }

    return new Response("not found", { status: 404 });
  };
}

function makeEnv() {
  const clock = new FakeClock();
  const server = new FakeLinkedInServer();
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
