/**
 * In-memory fake of the LinkedIn REST endpoints the publisher uses (Posts, Images, Documents,
 * Videos and their upload URLs), for this package's tests and its consumers' (the cloud
 * publisher's scheduler). Behaviour that matters for publishing safely is modelled:
 *
 * - uploads are stored per upload URL; videos report PROCESSING for a while, then AVAILABLE,
 * - `POST /rest/posts` refuses identical content by the same author with LinkedIn's 422
 *   "Content is a duplicate of urn:li:share:…",
 * - the answer of a post call can be lost after the post was created (network error or 504),
 * - `GET /rest/posts?q=author` is refused (403) unless enabled: personal profiles usually lack
 *   the permission to read posts back,
 * - revoked tokens get 401, rate limits 429 with Retry-After.
 */

import type { Clock } from "../runtime.ts";

export interface FakeLinkedInCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  json: unknown;
  bytes: Uint8Array;
}

export interface FakeLinkedInPost {
  urn: string;
  body: Record<string, unknown>;
  createdAt: number;
}

export interface FakeLinkedInOptions {
  clock?: Clock;
  /** Tokens answered with 401 (REVOKED_ACCESS_TOKEN). */
  revokedTokens?: Iterable<string>;
  /** `GET /rest/posts?q=author` works (true) or is refused with 403 (default). */
  allowAuthorLookup?: boolean;
  /** How many status reads of a new video answer PROCESSING before AVAILABLE (default 0). */
  videoProcessingPolls?: number;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

export class FakeLinkedIn {
  readonly calls: FakeLinkedInCall[] = [];
  readonly posts: FakeLinkedInPost[] = [];
  readonly uploadedBytes = new Map<string, Uint8Array>();
  readonly finalizedVideos: { video: string; uploadToken: string; uploadedPartIds: string[] }[] =
    [];
  readonly revokedTokens: Set<string>;
  allowAuthorLookup: boolean;
  videoProcessingPolls: number;
  /** Status reads per video URN. */
  readonly videoReads = new Map<string, number>();
  failVideoProcessing = false;
  private seq = 0;
  private rateLimitRemaining = 0;
  private retryAfterSec = 45;
  private loseNextPost: "network" | "504" | null = null;
  private readonly clock: Clock;

  constructor(options: FakeLinkedInOptions = {}) {
    this.clock = options.clock ?? { now: () => Date.now() };
    this.revokedTokens = new Set(options.revokedTokens ?? []);
    this.allowAuthorLookup = options.allowAuthorLookup ?? false;
    this.videoProcessingPolls = options.videoProcessingPolls ?? 0;
  }

  rateLimitNext(times = 1, retryAfterSec = 45) {
    this.rateLimitRemaining = times;
    this.retryAfterSec = retryAfterSec;
  }

  /** The next post is created, but its answer is lost (network error or a 504). */
  loseNextPostResponse(mode: "network" | "504" = "network") {
    this.loseNextPost = mode;
  }

  /** Posts created by `POST /rest/posts` (not counting refused duplicates). */
  postCalls(): FakeLinkedInCall[] {
    return this.calls.filter((c) => c.method === "POST" && c.path === "/rest/posts");
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

    // Fake external media for URL-based sources.
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

    const auth = headersObj.authorization ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!auth.startsWith("Bearer ") || this.revokedTokens.has(token)) {
      return json(
        {
          status: 401,
          code: "REVOKED_ACCESS_TOKEN",
          message: `Token ${token} has expired or been revoked`,
        },
        401,
      );
    }

    if (this.rateLimitRemaining > 0) {
      this.rateLimitRemaining--;
      return json({ status: 429, message: "Application rate limit reached" }, 429, {
        "retry-after": String(this.retryAfterSec),
      });
    }

    // Binary upload PUTs.
    if (method === "PUT" && u.pathname.startsWith("/dms-uploads/")) {
      const prev = this.uploadedBytes.get(u.pathname);
      const merged = new Uint8Array((prev?.byteLength ?? 0) + rawBytes.byteLength);
      if (prev) merged.set(prev, 0);
      merged.set(rawBytes, prev?.byteLength ?? 0);
      this.uploadedBytes.set(u.pathname, merged);
      return new Response(null, { status: 201, headers: { etag: `"etag-${++this.seq}"` } });
    }

    const action = u.searchParams.get("action");
    if (method === "POST" && u.pathname === "/rest/images" && action === "initializeUpload") {
      const id = ++this.seq;
      return json({
        value: {
          image: `urn:li:image:img-${id}`,
          uploadUrl: `https://api.linkedin.com/dms-uploads/image-${id}`,
        },
      });
    }

    if (method === "POST" && u.pathname === "/rest/documents" && action === "initializeUpload") {
      const id = ++this.seq;
      return json({
        value: {
          document: `urn:li:document:doc-${id}`,
          uploadUrl: `https://api.linkedin.com/dms-uploads/doc-${id}`,
        },
      });
    }

    if (method === "POST" && u.pathname === "/rest/videos" && action === "initializeUpload") {
      const id = ++this.seq;
      const reqBody = parsedJson as { initializeUploadRequest?: { fileSizeBytes?: number } };
      const size = reqBody?.initializeUploadRequest?.fileSizeBytes ?? 8;
      const mid = Math.floor(size / 2);
      const uploadUrl = `https://api.linkedin.com/dms-uploads/vid-${id}`;
      return json({
        value: {
          video: `urn:li:video:vid-${id}`,
          uploadToken: `tok-${id}`,
          uploadInstructions:
            size > 4
              ? [
                  { uploadUrl, firstByte: 0, lastByte: mid - 1 },
                  { uploadUrl, firstByte: mid, lastByte: size - 1 },
                ]
              : [{ uploadUrl, firstByte: 0, lastByte: size - 1 }],
        },
      });
    }

    if (method === "POST" && u.pathname === "/rest/videos" && action === "finalizeUpload") {
      const body = (
        parsedJson as {
          finalizeUploadRequest: { video: string; uploadToken: string; uploadedPartIds: string[] };
        }
      ).finalizeUploadRequest;
      this.finalizedVideos.push(body);
      return new Response(null, { status: 202 });
    }

    if (method === "GET" && u.pathname.startsWith("/rest/videos/")) {
      const urn = decodeURIComponent(u.pathname.slice("/rest/videos/".length));
      const reads = (this.videoReads.get(urn) ?? 0) + 1;
      this.videoReads.set(urn, reads);
      const status = this.failVideoProcessing
        ? "PROCESSING_FAILED"
        : reads <= this.videoProcessingPolls
          ? "PROCESSING"
          : "AVAILABLE";
      return json({ id: urn, status });
    }

    if (method === "GET" && u.pathname === "/rest/posts" && u.searchParams.get("q") === "author") {
      if (!this.allowAuthorLookup) {
        return json({ status: 403, message: "Not enough permissions to access: posts" }, 403);
      }
      const author = u.searchParams.get("author");
      const elements = this.posts
        .filter((p) => p.body.author === author)
        .slice()
        .reverse()
        .map((p) => ({ id: p.urn, createdAt: p.createdAt, ...p.body }));
      return json({ elements });
    }

    if (method === "POST" && u.pathname === "/rest/posts") {
      const body = parsedJson as Record<string, unknown>;
      const same = this.posts.find(
        (p) =>
          p.body.author === body.author &&
          p.body.commentary === body.commentary &&
          JSON.stringify(p.body.content ?? null) === JSON.stringify(body.content ?? null),
      );
      if (same) {
        return json(
          {
            status: 422,
            message: `Content is a duplicate of ${same.urn}`,
            errorDetailType: "com.linkedin.common.error.BadRequest",
          },
          422,
        );
      }
      const urn = `urn:li:share:post-${++this.seq}`;
      this.posts.push({ urn, body, createdAt: this.clock.now() });
      const lost = this.loseNextPost;
      this.loseNextPost = null;
      if (lost === "network") throw new TypeError("fetch failed: connection reset");
      if (lost === "504") return new Response("upstream timeout", { status: 504 });
      return new Response(null, { status: 201, headers: { "x-restli-id": urn } });
    }

    return new Response("not found", { status: 404 });
  };
}

/** True for hosts the fake LinkedIn answers (REST API, upload URLs, fake media). */
export function isFakeLinkedInHost(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "api.linkedin.com" || host === "www.linkedin.com" || host === "media.example.com";
}
