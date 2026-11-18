/**
 * LinkedIn REST API publisher (Posts, Images, Documents, Videos).
 *
 *   text          create_post (POST /rest/posts)
 *   image         init_upload (POST /rest/images?action=initializeUpload)
 *                 -> upload_binary (PUT uploadUrl) -> create_post
 *   multi_image   init_upload (one per image) -> upload_binary (one per image) -> create_post
 *   document      init_upload (POST /rest/documents?action=initializeUpload)
 *                 -> upload_binary (PUT uploadUrl, PDF) -> create_post
 *   video         init_upload (POST /rest/videos?action=initializeUpload)
 *                 -> upload_binary (PUT parts + optional finalizeUpload)
 *                 -> wait_video (GET /rest/videos/{urn} until AVAILABLE) -> create_post
 *
 * `create_post` is not idempotent on LinkedIn's side. A post call whose answer was lost
 * (timeout, network error, 5xx) may have created the post, so before posting again the
 * machine looks for it among the author's recent posts, and a "duplicate" refusal that names
 * the existing post is taken as that post (reconciled) instead of a failure.
 *
 * Commentary is sent in LinkedIn's "little text format": reserved characters are escaped and
 * `#hashtags` become hashtag templates, so `( ) [ ] @ * _` in a caption cannot cut it short.
 *
 * All LinkedIn REST calls carry `Authorization: Bearer <token>`,
 * `LinkedIn-Version: LINKEDIN_API_VERSION`, and `X-Restli-Protocol-Version: 2.0.0`.
 */

import { PublishError, publishError } from "../errors.ts";
import { retryAfterFromHeaders } from "../graph/client.ts";
import {
  assertValid,
  type BaseState,
  fail,
  initialBase,
  iso,
  normaliseText,
  PollSignal,
  type Publisher,
  type PublisherDeps,
  readRange,
  runStep,
  type StepContext,
  type StepOutcome,
} from "../machine.ts";
import {
  type DocumentMedia,
  type ImageMedia,
  LinkedInRequest,
  type PublishResult,
  type VideoMedia,
} from "../models.ts";
import { redact } from "../redact.ts";
import { type FetchLike, globalFetch, type Logger, noopLogger } from "../runtime.ts";
import { validateRequest } from "../validation/index.ts";

/**
 * The one `LinkedIn-Version` header value (YYYYMM) every LinkedIn call sends.
 *
 * LinkedIn supports each monthly version for about a year, then answers 426 ("version no
 * longer supported"): 202604 is expected to stop working around April 2027. Before that,
 * move this to a newer version (read the LinkedIn Posts/Images/Videos/Documents changelogs)
 * and rerun the tests; both runtimes can also override it without a release
 * (`STUDIO_LINKEDIN_VERSION` for the Mac worker, `LINKEDIN_VERSION` for the cloud publisher).
 */
export const LINKEDIN_API_VERSION = "202604";
export const DEFAULT_LINKEDIN_BASE_URL = "https://api.linkedin.com";

/** LinkedIn REST calls give up after this long; binary uploads after `LINKEDIN_UPLOAD_TIMEOUT_MS`. */
export const LINKEDIN_TIMEOUT_MS = 60_000;
export const LINKEDIN_UPLOAD_TIMEOUT_MS = 10 * 60_000;

export type LinkedInPhase = "init_upload" | "upload_binary" | "wait_video" | "create_post";

export interface LinkedInUploadPart {
  uploadUrl: string;
  firstByte: number;
  lastByte: number;
  etag: string | null;
}

export interface LinkedInUploadSlot {
  assetUrn: string | null;
  uploadUrl: string | null;
  uploadToken: string | null;
  parts: LinkedInUploadPart[];
  uploaded: boolean;
}

export interface LinkedInState
  extends BaseState<LinkedInRequest["kind"], LinkedInRequest, LinkedInPhase> {
  uploads: LinkedInUploadSlot[];
  externalId: string | null;
  publishedAt: number | null;
  /**
   * `POST /rest/posts` calls sent so far (saved with the step's result, also when the call
   * failed). Above zero, an earlier call may have created the post although its answer was
   * lost: the next try first looks for it. Absent in states saved by older versions.
   */
  postCalls?: number;
}

export interface LinkedInPublisherOptions {
  baseUrl?: string | undefined;
  version?: string | undefined;
  fetch?: FetchLike | undefined;
  logger?: Logger | undefined;
  /** Per-call timeouts (ms); defaults `LINKEDIN_TIMEOUT_MS` / `LINKEDIN_UPLOAD_TIMEOUT_MS`. */
  timeoutMs?: number | undefined;
  uploadTimeoutMs?: number | undefined;
}

// --- little text format (commentary) -------------------------------------------------

/** Characters LinkedIn's "little text format" reserves; escaped with a backslash. */
const LITTLE_TEXT_RESERVED = /[\\|{}@[\]()<>#*_~]/g;
/** `#tag` at a word start, letters and digits only (Turkish letters included). */
const HASHTAG = /(^|[^\p{L}\p{N}_])#([\p{L}\p{N}]+)(?![\p{L}\p{N}_])/gu;

function escapeLittleText(text: string): string {
  return text.replace(LITTLE_TEXT_RESERVED, (ch) => `\\${ch}`);
}

/**
 * Plain caption -> LinkedIn commentary ("little text format"): every reserved character is
 * escaped so it shows as typed (an unescaped `(`, `[` or `@` can cut the text short or start a
 * mention), and `#hashtags` become `{hashtag|\#|tag}` templates so they stay hashtags.
 */
export function toLittleText(caption: string): string {
  let out = "";
  let last = 0;
  for (const m of caption.matchAll(HASHTAG)) {
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    out += escapeLittleText(caption.slice(last, start));
    out += `{hashtag|\\#|${m[2]}}`;
    last = start + 1 + (m[2]?.length ?? 0);
  }
  return out + escapeLittleText(caption.slice(last));
}

/** `urn:li:share:…` / `urn:li:ugcPost:…` named in a LinkedIn "duplicate" refusal. */
function duplicatePostUrn(text: string): string | null {
  return /urn:li:(?:share|ugcPost):[A-Za-z0-9_-]+/.exec(text)?.[0] ?? null;
}

interface LinkedInRestResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

function emptySlot(): LinkedInUploadSlot {
  return {
    assetUrn: null,
    uploadUrl: null,
    uploadToken: null,
    parts: [],
    uploaded: false,
  };
}

function slotCount(req: LinkedInRequest): number {
  switch (req.kind) {
    case "linkedin.text":
      return 0;
    case "linkedin.image":
    case "linkedin.document":
    case "linkedin.video":
      return 1;
    case "linkedin.multi_image":
      return req.images.length;
  }
}

function initialPhase(req: LinkedInRequest): LinkedInPhase {
  return req.kind === "linkedin.text" ? "create_post" : "init_upload";
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function linkedinPermalink(postUrn: string): string {
  return `https://www.linkedin.com/feed/update/${postUrn}/`;
}

export class LinkedInPublisher implements Publisher<LinkedInRequest, LinkedInState> {
  readonly platform = "linkedin" as const;
  readonly baseUrl: string;
  readonly version: string;
  private readonly fetchImpl: FetchLike;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;

  constructor(
    private readonly deps: PublisherDeps,
    options: LinkedInPublisherOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_LINKEDIN_BASE_URL).replace(/\/+$/, "");
    this.version = options.version ?? LINKEDIN_API_VERSION;
    this.fetchImpl = options.fetch ?? globalFetch;
    this.logger = options.logger ?? noopLogger;
    this.timeoutMs = options.timeoutMs ?? LINKEDIN_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? LINKEDIN_UPLOAD_TIMEOUT_MS;
  }

  validate(request: unknown) {
    return validateRequest(request);
  }

  start(input: LinkedInRequest): LinkedInState {
    const report = assertValid(input);
    const request = LinkedInRequest.parse(input);
    const now = this.deps.clock.now();
    return {
      ...initialBase(request.kind, request, initialPhase(request), now, report),
      uploads: Array.from({ length: slotCount(request) }, emptySlot),
      externalId: null,
      publishedAt: null,
      postCalls: 0,
    };
  }

  step(state: LinkedInState, ctx: StepContext): Promise<StepOutcome<LinkedInState>> {
    return runStep(this.deps, state, ctx, (s) => this.advance(s, ctx));
  }

  private async advance(s: LinkedInState, ctx: StepContext): Promise<void> {
    const token = ctx.accessToken;
    const req = s.request;

    switch (s.phase) {
      case "init_upload": {
        const index = s.uploads.findIndex((u) => u.assetUrn === null);
        if (index === -1) {
          s.phase = "upload_binary";
          return;
        }
        const slot = s.uploads[index];
        if (!slot) fail("INVALID_STATE", "Yükleme yuvası bulunamadı.");

        if (req.kind === "linkedin.image" || req.kind === "linkedin.multi_image") {
          const res = await this.rest<{
            value?: { image?: string; uploadUrl?: string };
          }>("POST", "/rest/images?action=initializeUpload", token, {
            initializeUploadRequest: { owner: req.authorUrn },
          });
          const urn = res.data?.value?.image;
          const uploadUrl = res.data?.value?.uploadUrl;
          if (!urn || !uploadUrl) {
            fail("GRAPH_ERROR", "LinkedIn görsel yükleme oturumu başlatılamadı.");
          }
          slot.assetUrn = urn;
          slot.uploadUrl = uploadUrl;
        } else if (req.kind === "linkedin.document") {
          const res = await this.rest<{
            value?: { document?: string; uploadUrl?: string };
          }>("POST", "/rest/documents?action=initializeUpload", token, {
            initializeUploadRequest: { owner: req.authorUrn },
          });
          const urn = res.data?.value?.document;
          const uploadUrl = res.data?.value?.uploadUrl;
          if (!urn || !uploadUrl) {
            fail("GRAPH_ERROR", "LinkedIn PDF yükleme oturumu başlatılamadı.");
          }
          slot.assetUrn = urn;
          slot.uploadUrl = uploadUrl;
        } else if (req.kind === "linkedin.video") {
          const fileSizeBytes = await this.resolveVideoBytes(req.video, token);
          const res = await this.rest<{
            value?: {
              video?: string;
              uploadToken?: string;
              uploadUrl?: string;
              uploadInstructions?: {
                uploadUrl?: string;
                firstByte?: number;
                lastByte?: number;
              }[];
            };
          }>("POST", "/rest/videos?action=initializeUpload", token, {
            initializeUploadRequest: {
              owner: req.authorUrn,
              fileSizeBytes,
              uploadCaptions: false,
              uploadThumbnail: false,
            },
          });
          const v = res.data?.value;
          if (!v?.video) {
            fail("GRAPH_ERROR", "LinkedIn video yükleme oturumu başlatılamadı.");
          }
          slot.assetUrn = v.video;
          slot.uploadToken = v.uploadToken ?? null;
          const instructions = (v.uploadInstructions ?? []).filter(
            (p): p is { uploadUrl: string; firstByte?: number; lastByte?: number } =>
              typeof p.uploadUrl === "string" && p.uploadUrl.length > 0,
          );
          if (instructions.length > 0) {
            slot.parts = instructions.map((p) => ({
              uploadUrl: p.uploadUrl,
              firstByte: p.firstByte ?? 0,
              lastByte: p.lastByte ?? Math.max(0, fileSizeBytes - 1),
              etag: null,
            }));
          } else if (v.uploadUrl) {
            slot.uploadUrl = v.uploadUrl;
          } else {
            fail("GRAPH_ERROR", "LinkedIn video yükleme adresi döndürmedi.");
          }
        }

        if (s.uploads.every((u) => u.assetUrn !== null)) {
          s.phase = "upload_binary";
        }
        return;
      }

      case "upload_binary": {
        const index = s.uploads.findIndex((u) => !u.uploaded);
        if (index === -1) {
          s.phase = "create_post";
          return;
        }
        const slot = s.uploads[index];
        if (!slot?.assetUrn) fail("INVALID_STATE", "Yükleme yuvası hazır değil.");

        if (req.kind === "linkedin.image") {
          await this.uploadImage(slot, req.image, ctx, token);
        } else if (req.kind === "linkedin.multi_image") {
          const img = req.images[index];
          if (!img) fail("INVALID_STATE", "Görsel bulunamadı.");
          await this.uploadImage(slot, img, ctx, token);
        } else if (req.kind === "linkedin.document") {
          await this.uploadDocument(slot, req.document, ctx, token);
        } else if (req.kind === "linkedin.video") {
          await this.uploadVideo(slot, req.video, ctx, token);
        }

        if (s.uploads.every((u) => u.uploaded)) {
          s.phase = req.kind === "linkedin.video" ? "wait_video" : "create_post";
        }
        return;
      }

      case "wait_video": {
        // A post that points at a video LinkedIn is still processing is refused (or shows
        // nothing): wait until the video is AVAILABLE.
        const urn = s.uploads[0]?.assetUrn;
        if (!urn) fail("INVALID_STATE", "Video URN bulunamadı.");
        const res = await this.rest<{ status?: string }>(
          "GET",
          `/rest/videos/${encodeURIComponent(urn)}`,
          token,
        );
        const status = res.data?.status;
        if (status === "AVAILABLE") {
          s.phase = "create_post";
          return;
        }
        if (status === "PROCESSING_FAILED") {
          fail("MEDIA_REJECTED", "LinkedIn videoyu işleyemedi; video dosyasını kontrol edin.", {
            action: "fix_content",
          });
        }
        throw new PollSignal("video");
      }

      case "create_post": {
        s.intentAt ??= this.deps.clock.now();
        const earlierCalls = s.postCalls ?? 0;
        if (earlierCalls > 0) {
          // An earlier call may have created the post although its answer was lost.
          const existing = await this.findPublishedPost(s, token);
          if (existing) {
            this.finish(s, existing, true);
            return;
          }
        }
        const body = this.buildPostBody(s);
        // Counted before the call: saved with this step's result even when the call fails.
        s.postCalls = earlierCalls + 1;
        const res = await this.restAllowing<{ id?: string }>(
          "POST",
          "/rest/posts",
          token,
          body,
          422,
        );
        if (res.status === 422) {
          const urn = duplicatePostUrn(res.text);
          if (!urn || !/duplicate/i.test(res.text)) {
            throw this.httpFailure(422, res.headers, res.text, "POST /rest/posts", token);
          }
          // LinkedIn refuses the same content twice and names the post that already has it:
          // that is ours when an earlier call's answer was lost (or the media is ours).
          if (earlierCalls === 0) {
            s.warnings.push({
              code: "LINKEDIN_DUPLICATE_LINKED",
              message:
                "LinkedIn bu içeriği bu hesapta zaten paylaşılmış buldu; o gönderi bağlandı.",
            });
          }
          this.finish(s, urn, true);
          return;
        }
        const urn =
          res.headers.get("x-restli-id")?.trim() ||
          (typeof res.data?.id === "string" ? res.data.id.trim() : "");
        if (!urn) {
          fail("GRAPH_ERROR", "LinkedIn gönderi kimliği (x-restli-id) döndürmedi.");
        }
        this.finish(s, urn, false);
        return;
      }
    }
  }

  private finish(s: LinkedInState, urn: string, reconciled: boolean) {
    const now = this.deps.clock.now();
    s.externalId = urn;
    s.publishedAt = now;
    const result: PublishResult = {
      platform: "linkedin",
      kind: s.request.kind,
      externalId: urn,
      postId: urn,
      permalink: linkedinPermalink(urn),
      publishedAt: iso(now),
      warnings: s.warnings,
      reconciled,
    };
    s.result = result;
    s.phase = "done";
  }

  /**
   * The post an earlier, unanswered `create_post` may have made: among the author's recent
   * posts, one created after the intent with the same commentary (and our media). Best
   * effort: reading posts needs a permission a personal profile may not grant; any error
   * means "not found" and the duplicate check of the next call is the safety net.
   */
  private async findPublishedPost(s: LinkedInState, token: string): Promise<string | null> {
    const req = s.request;
    const since = (s.intentAt ?? s.createdAt) - this.deps.options.reconcileSkewMs;
    const commentary = normaliseText(toLittleText(req.commentary ?? ""));
    const mediaIds = new Set(
      s.uploads.map((u) => u.assetUrn).filter((u): u is string => typeof u === "string"),
    );
    let elements: {
      id?: string;
      commentary?: string;
      createdAt?: number;
      content?: {
        media?: { id?: string };
        multiImage?: { images?: { id?: string }[] };
      };
    }[];
    try {
      const res = await this.rest<{ elements?: typeof elements }>(
        "GET",
        `/rest/posts?author=${encodeURIComponent(req.authorUrn)}&q=author&count=10&sortBy=LAST_MODIFIED`,
        token,
      );
      elements = res.data?.elements ?? [];
    } catch {
      return null;
    }
    const found = elements.find((p) => {
      if (typeof p.id !== "string") return false;
      if (typeof p.createdAt === "number" && p.createdAt < since) return false;
      if (normaliseText(p.commentary) !== commentary) return false;
      if (mediaIds.size === 0) return true;
      const ids = [
        p.content?.media?.id,
        ...(p.content?.multiImage?.images ?? []).map((i) => i.id),
      ].filter((v): v is string => typeof v === "string");
      return ids.some((id) => mediaIds.has(id));
    });
    return found?.id ?? null;
  }

  private buildPostBody(s: LinkedInState): Record<string, unknown> {
    const req = s.request;
    const base: Record<string, unknown> = {
      author: req.authorUrn,
      commentary: toLittleText(req.commentary ?? ""),
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };

    switch (req.kind) {
      case "linkedin.text":
        return base;
      case "linkedin.image": {
        const assetUrn = s.uploads[0]?.assetUrn;
        if (!assetUrn) fail("INVALID_STATE", "Görsel URN bulunamadı.");
        return {
          ...base,
          content: {
            media: {
              id: assetUrn,
              ...(req.image.altText ? { altText: req.image.altText } : {}),
            },
          },
        };
      }
      case "linkedin.multi_image":
        return {
          ...base,
          content: {
            multiImage: {
              images: s.uploads.map((u, idx) => {
                if (!u.assetUrn) fail("INVALID_STATE", "Görsel URN bulunamadı.");
                const alt = req.images[idx]?.altText;
                return {
                  id: u.assetUrn,
                  ...(alt ? { altText: alt } : {}),
                };
              }),
            },
          },
        };
      case "linkedin.document": {
        const assetUrn = s.uploads[0]?.assetUrn;
        if (!assetUrn) fail("INVALID_STATE", "PDF belge URN bulunamadı.");
        return {
          ...base,
          content: {
            media: {
              title: req.title,
              id: assetUrn,
            },
          },
        };
      }
      case "linkedin.video": {
        const assetUrn = s.uploads[0]?.assetUrn;
        if (!assetUrn) fail("INVALID_STATE", "Video URN bulunamadı.");
        return {
          ...base,
          content: {
            media: {
              ...(req.title ? { title: req.title } : {}),
              id: assetUrn,
            },
          },
        };
      }
    }
  }

  private async uploadImage(
    slot: LinkedInUploadSlot,
    img: ImageMedia,
    ctx: StepContext,
    token: string,
  ) {
    if (!slot.uploadUrl) fail("INVALID_STATE", "Görsel yükleme adresi bulunamadı.");
    if (img.source?.type === "upload" && ctx.media) {
      // The caller has the bytes (the cloud publisher's storage): no download of its own URL.
      const bytes = await this.readBytes(ctx, img.source.key, 0, img.bytes);
      await this.putBinary(slot.uploadUrl, bytes, img.mimeType ?? "image/jpeg", token);
      slot.uploaded = true;
      return;
    }
    const fetched = await this.fetchSourceBytes(img.url, token);
    await this.putBinary(
      slot.uploadUrl,
      fetched.bytes,
      img.mimeType ?? fetched.contentType ?? "image/jpeg",
      token,
    );
    slot.uploaded = true;
  }

  /**
   * Bytes from the caller's MediaReader as one buffer: uploads are sent with a known length
   * (a stream body would go out chunked, which upload URLs may refuse).
   */
  private async readBytes(
    ctx: StepContext,
    key: string,
    offset: number,
    length: number | undefined,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const body =
      length !== undefined && length > 0
        ? await readRange(ctx, key, offset, length)
        : await (async () => {
            if (!ctx.media) fail("MEDIA_SOURCE_MISSING", "Medya okunamadı (MediaReader yok).");
            return (await ctx.media.read(key, { offset })) as BodyInit;
          })();
    return new Uint8Array(await new Response(body).arrayBuffer());
  }

  private async uploadDocument(
    slot: LinkedInUploadSlot,
    doc: DocumentMedia,
    ctx: StepContext,
    token: string,
  ) {
    if (!slot.uploadUrl) fail("INVALID_STATE", "PDF yükleme adresi bulunamadı.");
    let body: BodyInit;
    if (doc.source?.type === "upload") {
      body = await this.readBytes(ctx, doc.source.key, 0, doc.bytes);
    } else {
      const url = doc.url ?? (doc.source?.type === "url" ? doc.source.url : undefined);
      if (!url) fail("MEDIA_SOURCE_MISSING", "PDF kaynağı belirtilmedi.");
      body = (await this.fetchSourceBytes(url, token)).bytes;
    }
    await this.putBinary(slot.uploadUrl, body, doc.mimeType ?? "application/pdf", token);
    slot.uploaded = true;
  }

  private async uploadVideo(
    slot: LinkedInUploadSlot,
    video: VideoMedia,
    ctx: StepContext,
    token: string,
  ) {
    if (slot.parts.length > 0) {
      let urlBytes: Uint8Array<ArrayBuffer> | null = null;
      if (video.source.type === "url") {
        urlBytes = (await this.fetchSourceBytes(video.source.url, token)).bytes;
      }
      for (const part of slot.parts) {
        if (part.etag !== null) continue;
        const length = part.lastByte - part.firstByte + 1;
        const body: BodyInit =
          video.source.type === "upload"
            ? await this.readBytes(ctx, video.source.key, part.firstByte, length)
            : (urlBytes as Uint8Array<ArrayBuffer>).slice(part.firstByte, part.lastByte + 1);
        const headers = await this.putBinary(
          part.uploadUrl,
          body,
          "application/octet-stream",
          token,
        );
        part.etag = headers.get("etag") ?? "";
      }
      if (slot.uploadToken !== null) {
        await this.rest("POST", "/rest/videos?action=finalizeUpload", token, {
          finalizeUploadRequest: {
            video: slot.assetUrn,
            uploadToken: slot.uploadToken,
            uploadedPartIds: slot.parts.map((p) => p.etag).filter((e): e is string => Boolean(e)),
          },
        });
      }
      slot.uploaded = true;
      return;
    }

    if (!slot.uploadUrl) fail("INVALID_STATE", "Video yükleme adresi bulunamadı.");
    const body: BodyInit =
      video.source.type === "upload"
        ? await this.readBytes(ctx, video.source.key, 0, video.bytes)
        : (await this.fetchSourceBytes(video.source.url, token)).bytes;
    await this.putBinary(slot.uploadUrl, body, video.mimeType ?? "video/mp4", token);
    slot.uploaded = true;
  }

  private async resolveVideoBytes(video: VideoMedia, token: string): Promise<number> {
    if (video.bytes !== undefined && video.bytes > 0) return video.bytes;
    if (video.source.type === "url") {
      const fetched = await this.fetchSourceBytes(video.source.url, token);
      return fetched.bytes.byteLength;
    }
    fail("MEDIA_SOURCE_MISSING", "Video boyutu (bytes) bilinmiyor.");
  }

  private async fetchSourceBytes(
    url: string,
    token: string,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string | null }> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(this.uploadTimeoutMs),
      });
    } catch (err) {
      const detail = redact(err instanceof Error ? err.message : String(err), [token]);
      throw new PublishError({
        ...publishError("TRANSIENT", "Medya dosyası indirilirken ağ hatası oluştu.", {
          action: "retry",
        }),
        detail,
      });
    }
    if (!res.ok) {
      throw new PublishError(
        publishError(
          res.status >= 500 ? "TRANSIENT" : "MEDIA_REJECTED",
          `Medya dosyası verilen adresten alınamadı (HTTP ${res.status}).`,
          { action: res.status >= 500 ? "retry" : "fix_content" },
        ),
      );
    }
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: res.headers.get("content-type"),
    };
  }

  private isLinkedInHost(targetUrl: string): boolean {
    try {
      const targetHost = new URL(targetUrl).hostname.toLowerCase();
      const baseHost = new URL(this.baseUrl).hostname.toLowerCase();
      return (
        targetHost === baseHost ||
        targetHost === "linkedin.com" ||
        targetHost.endsWith(".linkedin.com")
      );
    } catch {
      return false;
    }
  }

  private async putBinary(
    uploadUrl: string,
    body: BodyInit,
    contentType: string,
    token: string,
  ): Promise<Headers> {
    const headers = new Headers({
      "Content-Type": contentType,
      "LinkedIn-Version": this.version,
      "X-Restli-Protocol-Version": "2.0.0",
    });
    if (this.isLinkedInHost(uploadUrl)) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const init: RequestInit & { duplex?: "half" } = {
      method: "PUT",
      headers,
      body,
      signal: AbortSignal.timeout(this.uploadTimeoutMs),
    };
    if (body instanceof ReadableStream) init.duplex = "half";

    const started = this.deps.clock.now();
    const u = new URL(uploadUrl);
    const label = `PUT ${u.host}${u.pathname}`;
    let res: Response;
    try {
      res = await this.fetchImpl(uploadUrl, init);
    } catch (err) {
      this.logger({ level: "warn", event: "linkedin.network_error", data: { request: label } });
      throw this.networkFailure(err, token);
    }
    const ms = this.deps.clock.now() - started;
    if (res.ok) {
      this.logger({
        level: "debug",
        event: "linkedin.upload",
        data: { request: label, status: res.status, ms },
      });
      return res.headers;
    }
    const text = await res.text();
    throw this.httpFailure(res.status, res.headers, text, label, token);
  }

  private async rest<T>(
    method: "GET" | "POST",
    pathWithQuery: string,
    token: string,
    json?: unknown,
  ): Promise<LinkedInRestResponse<T>> {
    const res = await this.restAllowing<T>(method, pathWithQuery, token, json);
    return { data: res.data, status: res.status, headers: res.headers };
  }

  /** A REST call; a non-2xx answer throws, except `allowStatus`, which is returned as is. */
  private async restAllowing<T>(
    method: "GET" | "POST",
    pathWithQuery: string,
    token: string,
    json?: unknown,
    allowStatus?: number,
  ): Promise<LinkedInRestResponse<T> & { text: string }> {
    const url = `${this.baseUrl}${pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`}`;
    const parsedUrl = new URL(url);
    const label = `${method} ${parsedUrl.host}${parsedUrl.pathname}`;
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": this.version,
      "X-Restli-Protocol-Version": "2.0.0",
    });
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (json !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(json);
    }

    const started = this.deps.clock.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      this.logger({ level: "warn", event: "linkedin.network_error", data: { request: label } });
      throw this.networkFailure(err, token);
    }

    const text = await res.text();
    const data = parseJson(text);
    const ms = this.deps.clock.now() - started;
    if (res.ok || res.status === allowStatus) {
      this.logger({
        level: "debug",
        event: "linkedin.request",
        data: { request: label, status: res.status, ms },
      });
      return { data: data as T, status: res.status, headers: res.headers, text };
    }

    throw this.httpFailure(res.status, res.headers, text, label, token, data);
  }

  private networkFailure(err: unknown, token: string): PublishError {
    const detail = redact(err instanceof Error ? err.message : String(err), [token]);
    return new PublishError({
      ...publishError("TRANSIENT", "LinkedIn'e bağlanılamadı; yeniden denenecek.", {
        action: "retry",
      }),
      detail,
    });
  }

  private httpFailure(
    status: number,
    headers: Headers,
    rawText: string,
    label: string,
    token: string,
    parsedBody?: unknown,
  ): PublishError {
    const bodyObj =
      parsedBody && typeof parsedBody === "object"
        ? (parsedBody as Record<string, unknown>)
        : (parseJson(rawText) as Record<string, unknown> | null);
    const rawMsg =
      typeof bodyObj?.message === "string" ? bodyObj.message : rawText.slice(0, 300).trim();
    const detail = redact(`${label} -> HTTP ${status}${rawMsg ? `: ${rawMsg}` : ""}`, [token]);
    const retryAfterMs = retryAfterFromHeaders(headers);

    this.logger({
      level: "warn",
      event: "linkedin.error",
      data: { request: label, status },
    });

    if (status === 401 || status === 403) {
      return new PublishError({
        ...publishError(
          "TOKEN_INVALID",
          "LinkedIn hesabının erişim izni geçersiz ya da süresi dolmuş; hesabı yeniden bağlayın.",
          { action: "reauth" },
        ),
        detail,
      });
    }

    if (status === 429) {
      return new PublishError({
        ...publishError(
          "RATE_LIMITED",
          "LinkedIn istek sınırına ulaşıldı; biraz sonra yeniden denenecek.",
          { action: "retry", retryAfterMs },
        ),
        detail,
      });
    }

    if (status >= 500) {
      return new PublishError({
        ...publishError(
          "TRANSIENT",
          "LinkedIn tarafında geçici bir hata oluştu; yeniden denenecek.",
          {
            action: "retry",
            retryAfterMs,
          },
        ),
        detail,
      });
    }

    if (status === 422 && /duplicate/i.test(rawMsg)) {
      return new PublishError({
        ...publishError(
          "DUPLICATE_POST",
          "Aynı içerik LinkedIn'de art arda paylaşılamaz; içeriği değiştirin.",
          { action: "fix_content" },
        ),
        detail,
      });
    }

    return new PublishError({
      ...publishError("INVALID_REQUEST", "LinkedIn isteği geçersiz buldu.", {
        action: "fix_content",
      }),
      detail,
    });
  }
}
