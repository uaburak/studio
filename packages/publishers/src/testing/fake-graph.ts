/**
 * In-process fake of the Meta Graph API, as a `fetch` handler.
 *
 * It models what the publishers depend on: IG containers with status
 * transitions and expiry, resumable rupload, the publishing quota,
 * config_issue partial successes, Facebook photos/feed/videos/Reels/stories,
 * chunked video uploads, /me/accounts, token exchange and debug_token.
 * Fault injection covers transient errors, rate limits, lost responses
 * (applied server-side, then the connection drops) and interrupted uploads.
 *
 * It is deliberately stricter than needed in one place: it counts every
 * attempt to publish something twice (`stats.duplicatePublishAttempts`).
 */

import type { Clock, FetchLike } from "../runtime.ts";

const H24 = 24 * 3600_000;

export class FakeClock implements Clock {
  constructor(public t = Date.UTC(2026, 10, 16, 9, 0, 0)) {}
  now = () => this.t;
  advance = (ms: number) => {
    this.t += Math.max(0, ms);
  };
  sleep = async (ms: number) => {
    this.advance(ms);
  };
}

export interface FakeCall {
  method: string;
  host: string;
  /** Path without the version prefix, e.g. `/123/media`. */
  path: string;
  /** Route name the fake matched, e.g. `ig.media.create`. */
  route: string;
  query: Record<string, string>;
  form: Record<string, string>;
  headers: Record<string, string>;
  bodyBytes: number;
  at: number;
}

export interface FakeErrorSpec {
  status?: number;
  code?: number;
  subcode?: number;
  message?: string;
  type?: string;
  isTransient?: boolean;
  headers?: Record<string, string>;
}

interface Fault {
  route: string | RegExp;
  times: number;
  /** "error": reject without applying. "drop": apply, then fail the connection (lost response). "network": fail without applying. */
  mode: "error" | "drop" | "network";
  error?: FakeErrorSpec;
}

interface TokenRecord {
  kind: "user" | "page" | "app";
  appId: string;
  userId: string;
  profileId?: string;
  scopes: string[];
  /** Epoch ms; 0 = never. */
  expiresAt: number;
  dataAccessExpiresAt: number;
  revoked?: boolean;
}

interface Container {
  id: string;
  igUserId: string;
  params: Record<string, string>;
  createdAt: number;
  resumable: boolean;
  isVideo: boolean;
  fileSize: number | null;
  uploadedBytes: number;
  uploadComplete: boolean;
  readyAt: number | null;
  error: string | null;
  publishedMediaId: string | null;
}

interface IgMedia {
  id: string;
  igUserId: string;
  caption: string | undefined;
  timestamp: number;
  productType: "FEED" | "REELS" | "STORY";
  mediaType: string;
  permalink: string;
  containerId: string;
}

interface FbPhoto {
  id: string;
  pageId: string;
  url: string;
  published: boolean;
  usedBy: string | null;
}

interface FbPost {
  id: string;
  pageId: string;
  message: string | undefined;
  createdAt: number;
  attachmentIds: string[];
  multi: boolean;
}

interface FbVideo {
  id: string;
  pageId: string;
  kind: "video" | "reel" | "story";
  title?: string;
  description?: string;
  createdAt: number;
  size: number | null;
  uploadedBytes: number;
  uploadComplete: boolean;
  processedAt: number | null;
  finished: boolean;
  postId: string | null;
  sessionId?: string;
  chunkSize?: number;
}

interface FbStory {
  postId: string;
  pageId: string;
  mediaId: string;
  mediaType: "photo" | "video";
  createdAt: number;
}

export interface FakeGraphOptions {
  clock?: FakeClock;
  version?: string;
  /** Time a container needs before FINISHED. */
  imageProcessingMs?: number;
  videoProcessingMs?: number;
  /** Chunk size the fake asks for in chunked /videos uploads. */
  fbChunkSize?: number;
  quotaTotal?: number;
  appId?: string;
  appSecret?: string;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

function graphError(spec: FakeErrorSpec): Response {
  return json(
    {
      error: {
        message: spec.message ?? "An unknown error has occurred.",
        type: spec.type ?? "OAuthException",
        code: spec.code ?? 1,
        ...(spec.subcode !== undefined ? { error_subcode: spec.subcode } : {}),
        is_transient: spec.isTransient ?? false,
        fbtrace_id: "AfakeTrace123",
      },
    },
    spec.status ?? 400,
    spec.headers,
  );
}

/** Instagram timestamp format: `2026-11-16T09:00:00+0000`. */
const igTime = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+0000");

export class FakeGraph {
  readonly clock: FakeClock;
  readonly version: string;
  readonly opts: Required<Omit<FakeGraphOptions, "clock" | "version">>;
  readonly calls: FakeCall[] = [];
  readonly stats = { duplicatePublishAttempts: 0 };

  readonly tokens = new Map<string, TokenRecord>();
  readonly igUsers = new Map<
    string,
    { publishTimes: number[]; quotaTotal: number; nextConfigIssue?: string }
  >();
  readonly containers = new Map<string, Container>();
  readonly igMedia = new Map<string, IgMedia>();
  readonly pages = new Map<string, { name: string; igUserId?: string; tasks: string[] }>();
  readonly photos = new Map<string, FbPhoto>();
  readonly posts = new Map<string, FbPost>();
  readonly videos = new Map<string, FbVideo>();
  readonly stories: FbStory[] = [];

  /** Next created IG container ends in ERROR with this status text. */
  nextContainerError: string | null = null;
  /** Interrupt the next pushed upload after this many bytes (connection drops). */
  interruptUploadAfterBytes: number | null = null;

  private faults: Fault[] = [];
  private seq = 1000;

  constructor(options: FakeGraphOptions = {}) {
    this.clock = options.clock ?? new FakeClock();
    this.version = options.version ?? "v27.0";
    this.opts = {
      imageProcessingMs: options.imageProcessingMs ?? 5_000,
      videoProcessingMs: options.videoProcessingMs ?? 90_000,
      fbChunkSize: options.fbChunkSize ?? 4096,
      quotaTotal: options.quotaTotal ?? 50,
      appId: options.appId ?? "1234567890",
      appSecret: options.appSecret ?? "fake-app-secret-value-0001",
    };
  }

  // --- setup helpers ---------------------------------------------------------------

  addUserToken(token: string, opts: Partial<TokenRecord> = {}) {
    const now = this.clock.now();
    this.tokens.set(token, {
      kind: "user",
      appId: this.opts.appId,
      userId: "10001",
      scopes: [
        "instagram_basic",
        "instagram_content_publish",
        "pages_show_list",
        "pages_read_engagement",
        "pages_manage_posts",
      ],
      expiresAt: now + 60 * 24 * 3600_000,
      dataAccessExpiresAt: now + 90 * 24 * 3600_000,
      ...opts,
    });
  }

  addPage(
    pageId: string,
    pageToken: string,
    opts: { name?: string; igUserId?: string; tasks?: string[] } = {},
  ) {
    this.pages.set(pageId, {
      name: opts.name ?? `Page ${pageId}`,
      tasks: opts.tasks ?? [
        "ADVERTISE",
        "ANALYZE",
        "CREATE_CONTENT",
        "MESSAGING",
        "MODERATE",
        "MANAGE",
      ],
      ...(opts.igUserId ? { igUserId: opts.igUserId } : {}),
    });
    this.addUserToken(pageToken, { kind: "page", profileId: pageId, expiresAt: 0 });
    if (opts.igUserId)
      this.igUsers.set(opts.igUserId, { publishTimes: [], quotaTotal: this.opts.quotaTotal });
  }

  expireToken(token: string) {
    const t = this.tokens.get(token);
    if (t) t.expiresAt = this.clock.now() - 1;
  }

  /** Fail the next `times` calls to `route` (name or regex). */
  failNext(route: string | RegExp, error: FakeErrorSpec, times = 1) {
    this.faults.push({ route, times, mode: "error", error });
  }

  /** Apply the next call to `route`, then drop the connection (the client never sees the response). */
  dropResponse(route: string | RegExp, times = 1) {
    this.faults.push({ route, times, mode: "drop" });
  }

  /** Fail the next call with a network error before it reaches the server. */
  networkError(route: string | RegExp, times = 1) {
    this.faults.push({ route, times, mode: "network" });
  }

  routeCalls(route: string) {
    return this.calls.filter((c) => c.route === route);
  }

  igPublishedMedia(igUserId?: string) {
    return [...this.igMedia.values()].filter((m) => !igUserId || m.igUserId === igUserId);
  }

  pagePosts(pageId?: string) {
    return [...this.posts.values()].filter((p) => !pageId || p.pageId === pageId);
  }

  // --- fetch ---------------------------------------------------------------------------

  readonly fetch: FetchLike = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const query = Object.fromEntries(url.searchParams);
    const ct = headers["content-type"] ?? "";
    let form: Record<string, string> = {};
    let bytes: Uint8Array = new Uint8Array();
    let files: Record<string, Blob> = {};
    if (request.method !== "GET" && request.body) {
      if (ct.includes("application/x-www-form-urlencoded")) {
        // Decode bytes explicitly: workerd warns on .text() for non-text content types.
        const text = new TextDecoder().decode(await request.arrayBuffer());
        form = Object.fromEntries(new URLSearchParams(text));
      } else if (ct.includes("multipart/form-data")) {
        const fd = await request.formData();
        const f: Record<string, string> = {};
        files = {};
        fd.forEach((v, k) => {
          if (typeof v === "string") f[k] = v;
          else files[k] = v;
        });
        form = f;
      } else if (ct.includes("application/json")) {
        form = Object.fromEntries(
          Object.entries((await request.json()) as Record<string, unknown>).map(([k, v]) => [
            k,
            typeof v === "string" ? v : JSON.stringify(v),
          ]),
        );
      } else {
        bytes = new Uint8Array(await request.arrayBuffer());
      }
    }
    const versionPrefix = `/${this.version}`;
    const rawPath = url.pathname;
    const path = url.hostname.startsWith("rupload.")
      ? rawPath
      : rawPath.startsWith(versionPrefix)
        ? rawPath.slice(versionPrefix.length)
        : rawPath;
    const call: FakeCall = {
      method: request.method,
      host: url.hostname,
      path,
      route: "unknown",
      query,
      form,
      headers,
      bodyBytes: bytes.length + Object.values(files).reduce((n, f) => n + f.size, 0),
      at: this.clock.now(),
    };
    const route = this.match(call);
    call.route = route?.name ?? "unknown";
    this.calls.push(call);

    const fault = this.takeFault(call.route);
    if (fault?.mode === "network") throw new TypeError("fetch failed: connection reset");
    if (fault?.mode === "error") return graphError(fault.error ?? {});
    if (!route) return graphError({ status: 404, code: 100, message: `Unknown path ${path}` });

    if (route.name !== "oauth.exchange") {
      const authErr = this.checkAuth(headers.authorization, route.name);
      if (authErr) return authErr;
    }
    const params = { ...query, ...form };
    const response = await route.handle({ call, params, bytes, files, ids: route.ids, headers });
    if (fault?.mode === "drop") throw new TypeError("fetch failed: socket hang up");
    return response;
  };

  private takeFault(route: string): Fault | undefined {
    const i = this.faults.findIndex((f) =>
      typeof f.route === "string" ? f.route === route : f.route.test(route),
    );
    if (i === -1) return undefined;
    const f = this.faults[i] as Fault;
    f.times -= 1;
    if (f.times <= 0) this.faults.splice(i, 1);
    return f;
  }

  private checkAuth(header: string | undefined, route: string): Response | null {
    const token = header?.replace(/^OAuth\s+/, "");
    if (!token)
      return graphError({
        code: 104,
        message: "An access token is required to request this resource.",
      });
    if (route === "debug_token") {
      return token === `${this.opts.appId}|${this.opts.appSecret}`
        ? null
        : graphError({
            code: 190,
            message: "Invalid OAuth access token - Cannot parse access token",
          });
    }
    const rec = this.tokens.get(token);
    if (!rec)
      return graphError({
        code: 190,
        message: "Invalid OAuth access token - Cannot parse access token",
      });
    const now = this.clock.now();
    if (rec.revoked || (rec.expiresAt !== 0 && rec.expiresAt <= now)) {
      return graphError({
        code: 190,
        subcode: 463,
        message: `Error validating access token: Session has expired on ${new Date(rec.expiresAt).toUTCString()}.`,
      });
    }
    return null;
  }

  // --- routing -----------------------------------------------------------------------------

  private match(call: FakeCall): { name: string; ids: string[]; handle: Handler } | null {
    const isRupload = call.host.startsWith("rupload.");
    const isVideoHost = call.host.startsWith("graph-video.");
    for (const r of this.routes) {
      if (r.method !== call.method) continue;
      if ((r.host ?? "graph") !== (isRupload ? "rupload" : isVideoHost ? "graphVideo" : "graph"))
        continue;
      const m = r.re.exec(call.path);
      if (!m) continue;
      if (r.when && !r.when(call)) continue;
      return { name: r.name, ids: m.slice(1), handle: r.handle };
    }
    return null;
  }

  private id(prefix = "") {
    this.seq += 1;
    return `${prefix}${17_900_000_000_000 + this.seq}`;
  }

  private igStatus(c: Container): { code: string; status: string } {
    const now = this.clock.now();
    if (c.publishedMediaId) return { code: "PUBLISHED", status: "Published" };
    if (c.error) return { code: "ERROR", status: c.error };
    if (now - c.createdAt >= H24) return { code: "EXPIRED", status: "Expired" };
    if (c.readyAt !== null && now >= c.readyAt)
      return {
        code: "FINISHED",
        status: "Finished: Media has been uploaded and it is ready to be published.",
      };
    return { code: "IN_PROGRESS", status: "In Progress: Media is still being processed." };
  }

  private quotaUsage(igUserId: string) {
    const u = this.igUsers.get(igUserId);
    const now = this.clock.now();
    return u ? u.publishTimes.filter((t) => now - t < H24).length : 0;
  }

  private readonly routes: Route[] = [
    // ---------------------------------------------------------------- Instagram
    {
      name: "ig.quota",
      method: "GET",
      re: /^\/(\d+)\/content_publishing_limit$/,
      handle: ({ ids }) => {
        const igUserId = ids[0] as string;
        const u = this.igUsers.get(igUserId);
        if (!u) return graphError({ code: 100, subcode: 33, message: "Unsupported get request." });
        return json({
          data: [
            {
              quota_usage: this.quotaUsage(igUserId),
              config: { quota_total: u.quotaTotal, quota_duration: 86400 },
            },
          ],
        });
      },
    },
    {
      name: "ig.media.create",
      method: "POST",
      re: /^\/(\d+)\/media$/,
      handle: ({ ids, params }) => {
        const igUserId = ids[0] as string;
        if (!this.igUsers.has(igUserId))
          return graphError({ code: 100, message: "Invalid IG user" });
        const mediaType = params.media_type;
        if (params.image_url) {
          if (/unreachable/.test(params.image_url))
            return graphError({
              code: 9004,
              subcode: 2207052,
              message: `The media could not be fetched from this uri: ${params.image_url}`,
            });
          if (!/\.jpe?g($|\?)/i.test(params.image_url))
            return graphError({
              code: 36001,
              subcode: 2207005,
              message: "The image format is not supported. Supported formats are: jpeg.",
            });
        }
        if (mediaType === "CAROUSEL") {
          const children = JSON.parse(params.children ?? "[]") as string[];
          if (children.length < 2 || children.length > 20)
            return graphError({
              code: 100,
              subcode: 2207028,
              message: "Your post won't work as a carousel.",
            });
          for (const child of children) {
            const c = this.containers.get(child);
            if (!c || this.igStatus(c).code !== "FINISHED")
              return graphError({ code: 100, message: `Child ${child} is not ready` });
          }
          if (
            params.is_ai_generated &&
            children.some((ch) => this.containers.get(ch)?.params.is_ai_generated)
          )
            return graphError({
              code: 100,
              message: "is_ai_generated not allowed on carousel children",
            });
        }
        if (params.is_carousel_item === "true" && params.is_ai_generated)
          return graphError({
            code: 100,
            message: "is_ai_generated not allowed on carousel children",
          });
        const now = this.clock.now();
        const resumable = params.upload_type === "resumable";
        const isVideo =
          mediaType === "REELS" ||
          mediaType === "VIDEO" ||
          (mediaType === "STORIES" && !params.image_url);
        const c: Container = {
          id: this.id(),
          igUserId,
          params,
          createdAt: now,
          resumable,
          isVideo,
          fileSize: null,
          uploadedBytes: 0,
          uploadComplete: !resumable,
          readyAt: resumable
            ? null
            : now +
              (mediaType === "CAROUSEL"
                ? 0
                : isVideo
                  ? this.opts.videoProcessingMs
                  : this.opts.imageProcessingMs),
          error: this.nextContainerError,
          publishedMediaId: null,
        };
        this.nextContainerError = null;
        this.containers.set(c.id, c);
        return json(
          resumable
            ? {
                id: c.id,
                uri: `https://rupload.facebook.com/ig-api-upload/${this.version}/${c.id}`,
              }
            : { id: c.id },
        );
      },
    },
    {
      name: "ig.upload",
      method: "POST",
      host: "rupload",
      re: /^\/ig-api-upload\/[^/]+\/(\d+)$/,
      handle: ({ ids, headers, bytes }) => {
        const c = this.containers.get(ids[0] as string);
        if (!c?.resumable)
          return json(
            { debug_info: { retriable: false, type: "NotFound", message: "Container not found" } },
            400,
          );
        const now = this.clock.now();
        if (headers.file_url) {
          c.uploadComplete = true;
          c.readyAt = now + this.opts.videoProcessingMs;
          return json({ success: true, message: "Upload successful." });
        }
        const offset = Number(headers.offset ?? "0");
        const size = Number(headers.file_size ?? "0");
        if (offset > c.uploadedBytes)
          return json(
            {
              debug_info: {
                retriable: false,
                type: "OffsetError",
                message: `Bad offset ${offset}`,
              },
            },
            400,
          );
        c.fileSize = size;
        let received = bytes.length;
        const interrupt = this.interruptUploadAfterBytes;
        if (interrupt !== null) {
          this.interruptUploadAfterBytes = null;
          received = Math.min(received, interrupt);
          c.uploadedBytes = offset + received;
          throw new TypeError("fetch failed: upload interrupted");
        }
        c.uploadedBytes = offset + received;
        if (c.uploadedBytes >= size) {
          c.uploadComplete = true;
          c.readyAt = now + this.opts.videoProcessingMs;
        }
        return json({ success: true, message: "Upload successful." });
      },
    },
    {
      name: "ig.media_publish",
      method: "POST",
      re: /^\/(\d+)\/media_publish$/,
      handle: ({ ids, params }) => {
        const igUserId = ids[0] as string;
        const u = this.igUsers.get(igUserId);
        const c = this.containers.get(params.creation_id ?? "");
        if (!u || !c)
          return graphError({ code: 24, subcode: 2207006, message: "The media cannot be found" });
        const st = this.igStatus(c);
        if (st.code === "PUBLISHED") {
          this.stats.duplicatePublishAttempts += 1;
          return graphError({
            code: 24,
            subcode: 2207008,
            message: "The media builder does not exist or has been expired.",
          });
        }
        if (st.code === "IN_PROGRESS")
          return graphError({
            code: 9007,
            subcode: 2207027,
            message: "The media is not ready for publishing, please wait for a moment",
          });
        if (st.code !== "FINISHED")
          return graphError({
            code: 24,
            subcode: 2207008,
            message: "The media builder does not exist or has been expired.",
          });
        if (this.quotaUsage(igUserId) >= u.quotaTotal)
          return graphError({
            code: 9,
            subcode: 2207042,
            message:
              "You reached maximum number of posts that is allowed to be published by Content Publishing API.",
          });
        const now = this.clock.now();
        const type = c.params.media_type;
        const media: IgMedia = {
          id: this.id(),
          igUserId,
          caption: c.params.caption,
          timestamp: now,
          productType: type === "REELS" ? "REELS" : type === "STORIES" ? "STORY" : "FEED",
          mediaType: type === "CAROUSEL" ? "CAROUSEL_ALBUM" : c.isVideo ? "VIDEO" : "IMAGE",
          permalink: `https://www.instagram.com/p/FAKE${this.seq}/`,
          containerId: c.id,
        };
        this.igMedia.set(media.id, media);
        c.publishedMediaId = media.id;
        u.publishTimes.push(now);
        const issue = u.nextConfigIssue;
        u.nextConfigIssue = undefined;
        return json({ id: media.id, ...(issue ? { config_issue: issue } : {}) });
      },
    },
    {
      name: "ig.media.list",
      method: "GET",
      re: /^\/(\d+)\/(media|stories)$/,
      when: (call) => this.igUsers.has(call.path.split("/")[1] as string),
      handle: ({ ids }) => {
        const [igUserId, edge] = ids as [string, string];
        const data = this.igPublishedMedia(igUserId)
          .filter((m) =>
            edge === "stories" ? m.productType === "STORY" : m.productType !== "STORY",
          )
          .sort((a, b) => b.timestamp - a.timestamp)
          .map((m) => ({
            id: m.id,
            caption: m.caption,
            timestamp: igTime(m.timestamp),
            media_product_type: m.productType,
            permalink: m.permalink,
          }));
        return json({ data });
      },
    },

    // ---------------------------------------------------------------- Facebook
    {
      name: "fb.photos.create",
      method: "POST",
      re: /^\/(\d+)\/photos$/,
      handle: ({ ids, params }) => {
        const pageId = ids[0] as string;
        if (!this.pages.has(pageId)) return graphError({ code: 100, message: "Invalid page" });
        if (!params.url) return graphError({ code: 324, message: "Requires upload file" });
        if (/unreachable/.test(params.url))
          return graphError({ code: 324, message: "Missing or invalid image file" });
        const published = params.published !== "false";
        const photo: FbPhoto = { id: this.id(), pageId, url: params.url, published, usedBy: null };
        this.photos.set(photo.id, photo);
        if (!published) return json({ id: photo.id });
        const post = this.createPost(pageId, params.caption, [photo.id], false);
        photo.usedBy = post.id;
        return json({ id: photo.id, post_id: post.id });
      },
    },
    {
      name: "fb.feed.create",
      method: "POST",
      re: /^\/(\d+)\/feed$/,
      handle: ({ ids, params }) => {
        const pageId = ids[0] as string;
        const media = Object.entries(params)
          .filter(([k]) => /^attached_media\[\d+\]$/.test(k))
          .map(([, v]) => (JSON.parse(v) as { media_fbid: string }).media_fbid);
        for (const id of media) {
          const p = this.photos.get(id);
          if (!p || p.pageId !== pageId || p.published)
            return graphError({ code: 100, message: `Invalid media_fbid ${id}` });
          if (p.usedBy) {
            this.stats.duplicatePublishAttempts += 1;
            return graphError({ code: 100, message: "Photo already attached to a post" });
          }
        }
        const post = this.createPost(pageId, params.message, media, media.length > 1);
        for (const id of media) (this.photos.get(id) as FbPhoto).usedBy = post.id;
        return json({ id: post.id });
      },
    },
    {
      name: "fb.published_posts",
      method: "GET",
      re: /^\/(\d+)\/published_posts$/,
      handle: ({ ids, params }) => {
        const since = params.since ? Number(params.since) * 1000 : 0;
        const data = this.pagePosts(ids[0])
          .filter((p) => p.createdAt >= since)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((p) => ({
            id: p.id,
            ...(p.message !== undefined ? { message: p.message } : {}),
            created_time: igTime(p.createdAt),
            attachments: {
              data: p.multi
                ? [{ subattachments: { data: p.attachmentIds.map((id) => ({ target: { id } })) } }]
                : p.attachmentIds.map((id) => ({ target: { id } })),
            },
          }));
        return json({ data });
      },
    },
    {
      name: "fb.videos.create",
      method: "POST",
      host: "graphVideo",
      re: /^\/(\d+)\/videos$/,
      when: (call) => !call.form.upload_phase,
      handle: ({ ids, params }) => {
        const pageId = ids[0] as string;
        if (!params.file_url) return graphError({ code: 100, message: "file_url required" });
        const v = this.newVideo(pageId, "video", params);
        v.uploadComplete = true;
        v.processedAt = this.clock.now();
        v.finished = true;
        v.postId = this.createPost(pageId, params.description, [v.id], false).id;
        return json({ id: v.id });
      },
    },
    {
      name: "fb.videos.start",
      method: "POST",
      host: "graphVideo",
      re: /^\/(\d+)\/videos$/,
      when: (call) => call.form.upload_phase === "start",
      handle: ({ ids, params }) => {
        const v = this.newVideo(ids[0] as string, "video", params);
        v.size = Number(params.file_size);
        v.sessionId = this.id();
        v.chunkSize = this.opts.fbChunkSize;
        return json({
          video_id: v.id,
          upload_session_id: v.sessionId,
          start_offset: "0",
          end_offset: String(Math.min(v.chunkSize, v.size)),
        });
      },
    },
    {
      name: "fb.videos.transfer",
      method: "POST",
      host: "graphVideo",
      re: /^\/(\d+)\/videos$/,
      when: (call) => call.form.upload_phase === "transfer",
      handle: ({ params, files }) => {
        const v = [...this.videos.values()].find((x) => x.sessionId === params.upload_session_id);
        const chunk = files.video_file_chunk;
        if (!v || !chunk || v.size === null)
          return graphError({ code: 100, message: "Invalid upload session" });
        const start = Number(params.start_offset);
        if (start > v.uploadedBytes)
          return graphError({ code: 100, subcode: 1363037, message: "Unexpected start offset" });
        v.uploadedBytes = Math.max(v.uploadedBytes, start + chunk.size);
        const next = v.uploadedBytes;
        if (next >= v.size) v.uploadComplete = true;
        return json({
          start_offset: String(next),
          end_offset: String(Math.min(next + (v.chunkSize ?? 4096), v.size)),
        });
      },
    },
    {
      name: "fb.videos.finish",
      method: "POST",
      host: "graphVideo",
      re: /^\/(\d+)\/videos$/,
      when: (call) => call.form.upload_phase === "finish",
      handle: ({ params }) => {
        const v = [...this.videos.values()].find((x) => x.sessionId === params.upload_session_id);
        if (!v?.uploadComplete) return graphError({ code: 100, message: "Upload not complete" });
        if (v.finished) {
          this.stats.duplicatePublishAttempts += 1;
          return json({ success: true });
        }
        v.finished = true;
        v.title = params.title;
        v.description = params.description;
        v.processedAt = this.clock.now();
        v.postId = this.createPost(v.pageId, params.description, [v.id], false).id;
        return json({ success: true });
      },
    },
    {
      name: "fb.videos.list",
      method: "GET",
      re: /^\/(\d+)\/videos$/,
      handle: ({ ids, params }) => {
        const since = params.since ? Number(params.since) * 1000 : 0;
        const data = [...this.videos.values()]
          .filter((v) => v.pageId === ids[0] && v.finished && v.createdAt >= since)
          .map((v) => ({
            id: v.id,
            title: v.title,
            description: v.description,
            created_time: igTime(v.createdAt),
          }));
        return json({ data });
      },
    },
    {
      name: "fb.reel_or_story.start",
      method: "POST",
      re: /^\/(\d+)\/(video_reels|video_stories)$/,
      when: (call) => call.form.upload_phase === "start",
      handle: ({ ids, params }) => {
        const v = this.newVideo(
          ids[0] as string,
          ids[1] === "video_reels" ? "reel" : "story",
          params,
        );
        return json({
          video_id: v.id,
          upload_url: `https://rupload.facebook.com/video-upload/${this.version}/${v.id}`,
        });
      },
    },
    {
      name: "fb.video.upload",
      method: "POST",
      host: "rupload",
      re: /^\/video-upload\/[^/]+\/(\d+)$/,
      handle: ({ ids, headers, bytes }) => {
        const v = this.videos.get(ids[0] as string);
        if (!v)
          return json(
            { debug_info: { retriable: false, type: "NotFound", message: "Video not found" } },
            400,
          );
        const now = this.clock.now();
        if (headers.file_url) {
          v.uploadComplete = true;
          v.processedAt = now + this.opts.videoProcessingMs;
          return json({ success: true });
        }
        const offset = Number(headers.offset ?? "0");
        v.size = Number(headers.file_size ?? "0");
        if (offset > v.uploadedBytes)
          return json(
            {
              debug_info: {
                retriable: false,
                type: "OffsetError",
                message: `Bad offset ${offset}`,
              },
            },
            400,
          );
        let received = bytes.length;
        const interrupt = this.interruptUploadAfterBytes;
        if (interrupt !== null) {
          this.interruptUploadAfterBytes = null;
          received = Math.min(received, interrupt);
          v.uploadedBytes = offset + received;
          throw new TypeError("fetch failed: upload interrupted");
        }
        v.uploadedBytes = offset + received;
        if (v.uploadedBytes >= v.size) {
          v.uploadComplete = true;
          v.processedAt = now + this.opts.videoProcessingMs;
        }
        return json({ success: true });
      },
    },
    {
      name: "fb.reel_or_story.finish",
      method: "POST",
      re: /^\/(\d+)\/(video_reels|video_stories)$/,
      when: (call) => call.form.upload_phase === "finish",
      handle: ({ ids, params }) => {
        const v = this.videos.get(params.video_id ?? "");
        if (!v?.uploadComplete)
          return graphError({ code: 100, message: "Video upload not complete" });
        if (v.finished) {
          this.stats.duplicatePublishAttempts += 1;
          return json({ success: true });
        }
        if (ids[1] === "video_reels" && params.video_state !== "PUBLISHED")
          return graphError({ code: 100, message: "video_state must be PUBLISHED in this fake" });
        v.finished = true;
        v.title = params.title;
        v.description = params.description;
        if (ids[1] === "video_stories") {
          const postId = `${v.pageId}_${this.id()}`;
          v.postId = postId;
          this.stories.push({
            postId,
            pageId: v.pageId,
            mediaId: v.id,
            mediaType: "video",
            createdAt: this.clock.now(),
          });
          return json({ success: true, post_id: postId });
        }
        return json({ success: true });
      },
    },
    {
      name: "fb.photo_stories",
      method: "POST",
      re: /^\/(\d+)\/photo_stories$/,
      handle: ({ ids, params }) => {
        const p = this.photos.get(params.photo_id ?? "");
        if (!p || p.published) return graphError({ code: 100, message: "Invalid photo_id" });
        if (p.usedBy) {
          this.stats.duplicatePublishAttempts += 1;
          return graphError({
            code: 100,
            message: "The media can not have been used in a previously published post.",
          });
        }
        const postId = `${ids[0]}_${this.id()}`;
        p.usedBy = postId;
        this.stories.push({
          postId,
          pageId: ids[0] as string,
          mediaId: p.id,
          mediaType: "photo",
          createdAt: this.clock.now(),
        });
        return json({ success: true, post_id: postId });
      },
    },
    {
      name: "fb.stories.list",
      method: "GET",
      re: /^\/(\d+)\/stories$/,
      handle: ({ ids, params }) => {
        const since = params.since ? Number(params.since) * 1000 : 0;
        const data = this.stories
          .filter((s) => s.pageId === ids[0] && s.createdAt >= since)
          .map((s) => ({
            post_id: s.postId,
            status: "PUBLISHED",
            creation_time: String(Math.floor(s.createdAt / 1000)),
            media_type: s.mediaType,
            media_id: s.mediaId,
          }));
        return json({ data });
      },
    },

    // ---------------------------------------------------------------- Accounts
    {
      name: "me.accounts",
      method: "GET",
      re: /^\/me\/accounts$/,
      handle: ({ params }) => {
        const all = [...this.pages.entries()];
        const start = Number(params.after ?? "0");
        const limit = Number(params.limit ?? "25");
        const slice = all.slice(start, start + limit);
        const pageToken = (pageId: string) =>
          [...this.tokens.entries()].find(
            ([, r]) => r.kind === "page" && r.profileId === pageId,
          )?.[0];
        const data = slice.map(([id, p]) => ({
          id,
          name: p.name,
          category: "Brand",
          access_token: pageToken(id),
          tasks: p.tasks,
          ...(p.igUserId
            ? { instagram_business_account: { id: p.igUserId, username: `ig_${p.igUserId}` } }
            : {}),
        }));
        const more = start + limit < all.length;
        return json({
          data,
          paging: {
            cursors: { before: String(start), after: String(start + limit) },
            ...(more
              ? {
                  next: `https://graph.facebook.com/${this.version}/me/accounts?after=${start + limit}`,
                }
              : {}),
          },
        });
      },
    },
    {
      name: "oauth.exchange",
      method: "GET",
      re: /^\/oauth\/access_token$/,
      handle: ({ params }) => {
        if (params.client_secret !== this.opts.appSecret || params.client_id !== this.opts.appId)
          return graphError({ code: 1, message: "Error validating client secret." });
        const short = this.tokens.get(params.fb_exchange_token ?? "");
        if (!short)
          return graphError({
            code: 190,
            message: "Invalid OAuth access token - Cannot parse access token",
          });
        const token = `EAAlong${this.id()}${"x".repeat(24)}`;
        this.addUserToken(token, { scopes: short.scopes });
        return json({ access_token: token, token_type: "bearer", expires_in: 5183944 });
      },
    },
    {
      name: "debug_token",
      method: "GET",
      re: /^\/debug_token$/,
      handle: ({ params }) => {
        const rec = this.tokens.get(params.input_token ?? "");
        if (!rec)
          return json({
            data: {
              is_valid: false,
              error: { code: 190, message: "Invalid OAuth access token.", subcode: 467 },
              scopes: [],
            },
          });
        const now = this.clock.now();
        const valid = !rec.revoked && (rec.expiresAt === 0 || rec.expiresAt > now);
        return json({
          data: {
            app_id: rec.appId,
            type: rec.kind === "page" ? "PAGE" : "USER",
            application: "Studio",
            data_access_expires_at: Math.floor(rec.dataAccessExpiresAt / 1000),
            expires_at: rec.expiresAt === 0 ? 0 : Math.floor(rec.expiresAt / 1000),
            is_valid: valid,
            issued_at: Math.floor(now / 1000) - 3600,
            scopes: rec.scopes,
            user_id: rec.userId,
            ...(rec.profileId ? { profile_id: rec.profileId } : {}),
          },
        });
      },
    },

    // ---------------------------------------------------------------- Node reads (last: most generic)
    {
      name: "node.get",
      method: "GET",
      re: /^\/([\d_]+)$/,
      handle: ({ ids }) => this.readNode(ids[0] as string),
    },
  ];

  private newVideo(pageId: string, kind: FbVideo["kind"], params: Record<string, string>): FbVideo {
    const v: FbVideo = {
      id: this.id(),
      pageId,
      kind,
      ...(params.title !== undefined ? { title: params.title } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      createdAt: this.clock.now(),
      size: null,
      uploadedBytes: 0,
      uploadComplete: false,
      processedAt: null,
      finished: false,
      postId: null,
    };
    this.videos.set(v.id, v);
    return v;
  }

  private createPost(
    pageId: string,
    message: string | undefined,
    attachmentIds: string[],
    multi: boolean,
  ): FbPost {
    const post: FbPost = {
      id: `${pageId}_${this.id()}`,
      pageId,
      message,
      createdAt: this.clock.now(),
      attachmentIds,
      multi,
    };
    this.posts.set(post.id, post);
    return post;
  }

  private readNode(id: string): Response {
    const now = this.clock.now();
    const c = this.containers.get(id);
    if (c) {
      const st = this.igStatus(c);
      return json({
        id: c.id,
        status_code: st.code,
        status: st.status,
        ...(c.resumable
          ? {
              video_status: {
                uploading_phase: {
                  status: c.uploadComplete
                    ? "complete"
                    : c.uploadedBytes > 0
                      ? "in_progress"
                      : "not_started",
                  bytes_transferred: c.uploadedBytes,
                },
                processing_phase: { status: st.code === "FINISHED" ? "complete" : "not_started" },
              },
            }
          : {}),
      });
    }
    const m = this.igMedia.get(id);
    if (m)
      return json({
        id: m.id,
        permalink: m.permalink,
        media_product_type: m.productType,
        timestamp: igTime(m.timestamp),
      });
    const post = this.posts.get(id);
    if (post)
      return json({
        id: post.id,
        permalink_url: `https://www.facebook.com/${post.id.replace("_", "/posts/")}`,
      });
    const photo = this.photos.get(id);
    if (photo) return json({ id: photo.id, permalink_url: `/photo/?fbid=${photo.id}` });
    const story = this.stories.find((s) => s.postId === id);
    if (story)
      return json({ id, permalink_url: `https://www.facebook.com/stories/${story.pageId}/` });
    const v = this.videos.get(id);
    if (v) {
      const processed = v.processedAt !== null && now >= v.processedAt;
      const videoStatus = !v.uploadComplete ? "uploading" : processed ? "ready" : "processing";
      return json({
        id: v.id,
        permalink_url: `/${v.pageId}/videos/${v.id}/`,
        status: {
          video_status: videoStatus,
          uploading_phase: {
            status: v.uploadComplete
              ? "complete"
              : v.uploadedBytes > 0
                ? "in_progress"
                : "not_started",
            bytes_transfered: v.uploadedBytes,
          },
          processing_phase: {
            status: processed ? "complete" : v.uploadComplete ? "in_progress" : "not_started",
          },
          publishing_phase: {
            status: !v.finished ? "not_started" : processed ? "complete" : "in_progress",
            ...(v.finished && processed
              ? { publish_status: "published", publish_time: Math.floor(now / 1000) }
              : {}),
          },
        },
      });
    }
    return graphError({
      code: 100,
      subcode: 33,
      message: `Unsupported get request. Object with ID '${id}' does not exist.`,
    });
  }
}

type Handler = (args: {
  call: FakeCall;
  params: Record<string, string>;
  bytes: Uint8Array;
  files: Record<string, Blob>;
  ids: string[];
  headers: Record<string, string>;
}) => Response | Promise<Response>;

interface Route {
  name: string;
  method: string;
  host?: "graph" | "graphVideo" | "rupload";
  re: RegExp;
  when?: (call: FakeCall) => boolean;
  handle: Handler;
}
