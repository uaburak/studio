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
 *                 -> upload_binary (PUT parts + optional finalizeUpload) -> create_post
 *
 * All LinkedIn REST calls carry `Authorization: Bearer <token>`,
 * `LinkedIn-Version: 202604`, and `X-Restli-Protocol-Version: 2.0.0`.
 */

import { PublishError, publishError } from "../errors.ts";
import { retryAfterFromHeaders } from "../graph/client.ts";
import {
  assertValid,
  type BaseState,
  fail,
  initialBase,
  iso,
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

export const LINKEDIN_API_VERSION = "202604";
export const DEFAULT_LINKEDIN_BASE_URL = "https://api.linkedin.com";

export type LinkedInPhase = "init_upload" | "upload_binary" | "create_post";

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
}

export interface LinkedInPublisherOptions {
  baseUrl?: string | undefined;
  version?: string | undefined;
  fetch?: FetchLike | undefined;
  logger?: Logger | undefined;
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

  constructor(
    private readonly deps: PublisherDeps,
    options: LinkedInPublisherOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_LINKEDIN_BASE_URL).replace(/\/+$/, "");
    this.version = options.version ?? LINKEDIN_API_VERSION;
    this.fetchImpl = options.fetch ?? globalFetch;
    this.logger = options.logger ?? noopLogger;
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
          await this.uploadImage(slot, req.image, token);
        } else if (req.kind === "linkedin.multi_image") {
          const img = req.images[index];
          if (!img) fail("INVALID_STATE", "Görsel bulunamadı.");
          await this.uploadImage(slot, img, token);
        } else if (req.kind === "linkedin.document") {
          await this.uploadDocument(slot, req.document, ctx, token);
        } else if (req.kind === "linkedin.video") {
          await this.uploadVideo(slot, req.video, ctx, token);
        }

        if (s.uploads.every((u) => u.uploaded)) {
          s.phase = "create_post";
        }
        return;
      }

      case "create_post": {
        s.intentAt ??= this.deps.clock.now();
        const body = this.buildPostBody(s);
        const res = await this.rest<{ id?: string }>("POST", "/rest/posts", token, body);
        const urn =
          res.headers.get("x-restli-id")?.trim() ||
          (typeof res.data?.id === "string" ? res.data.id.trim() : "");
        if (!urn) {
          fail("GRAPH_ERROR", "LinkedIn gönderi kimliği (x-restli-id) döndürmedi.");
        }
        const now = this.deps.clock.now();
        s.externalId = urn;
        s.publishedAt = now;
        const result: PublishResult = {
          platform: "linkedin",
          kind: req.kind,
          externalId: urn,
          postId: urn,
          permalink: linkedinPermalink(urn),
          publishedAt: iso(now),
          warnings: s.warnings,
          reconciled: false,
        };
        s.result = result;
        s.phase = "done";
        return;
      }
    }
  }

  private buildPostBody(s: LinkedInState): Record<string, unknown> {
    const req = s.request;
    const base: Record<string, unknown> = {
      author: req.authorUrn,
      commentary: req.commentary ?? "",
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

  private async uploadImage(slot: LinkedInUploadSlot, img: ImageMedia, token: string) {
    if (!slot.uploadUrl) fail("INVALID_STATE", "Görsel yükleme adresi bulunamadı.");
    const fetched = await this.fetchSourceBytes(img.url, token);
    await this.putBinary(
      slot.uploadUrl,
      fetched.bytes,
      img.mimeType ?? fetched.contentType ?? "image/jpeg",
      token,
    );
    slot.uploaded = true;
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
      body = await readRange(ctx, doc.source.key, 0, doc.bytes ?? 0);
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
            ? await readRange(ctx, video.source.key, part.firstByte, length)
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
        ? await readRange(ctx, video.source.key, 0, video.bytes ?? 0)
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
      res = await this.fetchImpl(url, { method: "GET" });
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
    const init: RequestInit & { duplex?: "half" } = { method: "PUT", headers, body };
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
    const url = `${this.baseUrl}${pathWithQuery.startsWith("/") ? pathWithQuery : `/${pathWithQuery}`}`;
    const parsedUrl = new URL(url);
    const label = `${method} ${parsedUrl.host}${parsedUrl.pathname}`;
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "LinkedIn-Version": this.version,
      "X-Restli-Protocol-Version": "2.0.0",
    });
    const init: RequestInit = { method, headers };
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
    if (res.ok) {
      this.logger({
        level: "debug",
        event: "linkedin.request",
        data: { request: label, status: res.status, ms },
      });
      return { data: data as T, status: res.status, headers: res.headers };
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
