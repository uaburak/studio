/**
 * Facebook Page publisher. All calls use the Page access token.
 *
 *   photo         arm -> publish (POST /{page}/photos) -> permalink
 *   multi_photo   upload_photos (POST /{page}/photos published=false, one per step)
 *                 -> arm -> publish (POST /{page}/feed attached_media) -> permalink
 *   video (url)   arm -> publish (POST graph-video /{page}/videos file_url) -> permalink
 *   video (bytes) start_upload (upload_phase=start) -> transfer (one chunk per step)
 *                 -> arm -> publish (upload_phase=finish) -> permalink
 *   reel          start_upload (POST /{page}/video_reels upload_phase=start) -> upload (rupload)
 *                 -> wait_upload -> arm -> publish (upload_phase=finish, video_state=PUBLISHED)
 *                 -> wait_publish -> permalink
 *   story video   same as reel with /{page}/video_stories
 *   story photo   upload_photos (published=false) -> arm -> publish (POST /{page}/photo_stories) -> permalink
 *
 * Every publish step first looks for the post on the Page (reconcile), so
 * re-running it after a crash never publishes twice. When a post cannot be
 * attributed with certainty the step fails with PUBLISH_UNCERTAIN instead of
 * guessing.
 *
 * Docs: https://developers.facebook.com/docs/graph-api/reference/page/photos ,
 * https://developers.facebook.com/docs/video-api/guides/reels-publishing ,
 * https://developers.facebook.com/docs/page-stories-api
 */

import { GraphError } from "../errors.ts";
import type { Params } from "../graph/encode.ts";
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
  parseMetaTime,
  readRange,
  readRangeBlob,
  runStep,
  type StepContext,
  type StepOutcome,
} from "../machine.ts";
import {
  FacebookRequest,
  type ImageMedia,
  type PublishResult,
  type VideoMedia,
} from "../models.ts";
import { validateRequest } from "../validation/index.ts";

export type FacebookPhase =
  | "upload_photos"
  | "start_upload"
  | "transfer"
  | "upload"
  | "wait_upload"
  | "arm_publish"
  | "publish"
  | "wait_publish"
  | "fetch_permalink";

export interface FacebookState
  extends BaseState<FacebookRequest["kind"], FacebookRequest, FacebookPhase> {
  /** Unpublished photo ids (multi-photo, photo story), aligned with the request's images. */
  photoIds: (string | null)[];
  videoId: string | null;
  /** rupload URL returned by `upload_phase=start` (Reels, video stories). */
  uploadUrl: string | null;
  /** Chunked `/videos` upload session. */
  uploadSessionId: string | null;
  /** Next byte range Meta asked for in a chunked `/videos` upload. */
  nextRange: { start: number; end: number } | null;
  uploadedBytes: number;
  externalId: string | null;
  postId: string | null;
  publishedAt: number | null;
  reconciled: boolean;
}

interface VideoStatus {
  status?: {
    video_status?: string;
    uploading_phase?: { status?: string; bytes_transfered?: number; bytes_transferred?: number };
    processing_phase?: { status?: string; error?: { message?: string } };
    publishing_phase?: { status?: string; publish_status?: string; error?: { message?: string } };
  };
}

interface PagePost {
  id: string;
  message?: string;
  created_time?: string;
  attachments?: {
    data?: {
      target?: { id?: string };
      subattachments?: { data?: { target?: { id?: string } }[] };
    }[];
  };
}

type FbVideoKind = "facebook.reel" | "facebook.story";

function videoOf(req: FacebookRequest): VideoMedia | null {
  if (req.kind === "facebook.video" || req.kind === "facebook.reel") return req.video;
  if (req.kind === "facebook.story" && req.media.kind === "video") return req.media;
  return null;
}

function photosOf(req: FacebookRequest): ImageMedia[] {
  if (req.kind === "facebook.multi_photo") return req.images;
  if (req.kind === "facebook.story" && req.media.kind === "image") return [req.media];
  return [];
}

function initialPhase(req: FacebookRequest): FacebookPhase {
  switch (req.kind) {
    case "facebook.photo":
      return "arm_publish";
    case "facebook.multi_photo":
      return "upload_photos";
    case "facebook.video":
      return req.video.source.type === "url" ? "arm_publish" : "start_upload";
    case "facebook.reel":
      return "start_upload";
    case "facebook.story":
      return req.media.kind === "image" ? "upload_photos" : "start_upload";
  }
}

/** `/xyz/videos/123` -> `https://www.facebook.com/xyz/videos/123`. */
function absolutePermalink(p: string | undefined): string | null {
  if (!p) return null;
  return p.startsWith("/") ? `https://www.facebook.com${p}` : p;
}

const unix = (ms: number) => Math.floor(ms / 1000);

export class FacebookPublisher implements Publisher<FacebookRequest, FacebookState> {
  readonly platform = "facebook" as const;

  constructor(private readonly deps: PublisherDeps) {}

  validate(request: unknown) {
    return validateRequest(request);
  }

  start(input: FacebookRequest): FacebookState {
    const report = assertValid(input);
    const request = FacebookRequest.parse(input);
    const now = this.deps.clock.now();
    return {
      ...initialBase(request.kind, request, initialPhase(request), now, report),
      photoIds: photosOf(request).map(() => null),
      videoId: null,
      uploadUrl: null,
      uploadSessionId: null,
      nextRange: null,
      uploadedBytes: 0,
      externalId: null,
      postId: null,
      publishedAt: null,
      reconciled: false,
    };
  }

  step(state: FacebookState, ctx: StepContext): Promise<StepOutcome<FacebookState>> {
    return runStep(this.deps, state, ctx, (s) => this.advance(s, ctx));
  }

  private async advance(s: FacebookState, ctx: StepContext): Promise<void> {
    const { graph, clock } = this.deps;
    const token = ctx.accessToken;
    const req = s.request;
    const page = req.pageId;

    switch (s.phase) {
      case "upload_photos": {
        const photos = photosOf(req);
        const i = s.photoIds.indexOf(null);
        if (i === -1) {
          s.phase = "arm_publish";
          return;
        }
        const img = photos[i] as ImageMedia;
        // Unpublished photos are harmless if orphaned by a crash.
        const res = await graph.request<{ id?: string }>({
          method: "POST",
          path: `/${page}/photos`,
          form: { url: img.url, published: false, alt_text_custom: img.altText },
          accessToken: token,
          idempotent: false,
        });
        if (!res.data?.id) fail("GRAPH_ERROR", "Facebook fotoğraf kimliği döndürmedi.");
        s.photoIds[i] = res.data.id;
        if (s.photoIds.every((id) => id !== null)) s.phase = "arm_publish";
        return;
      }

      case "start_upload": {
        const video = videoOf(req);
        if (!video) fail("INVALID_STATE", "Video bulunamadı.");
        if (req.kind === "facebook.video") {
          const res = await graph.request<{
            video_id?: string;
            upload_session_id?: string;
            start_offset?: string | number;
            end_offset?: string | number;
          }>({
            method: "POST",
            host: "graphVideo",
            path: `/${page}/videos`,
            form: { upload_phase: "start", file_size: video.bytes },
            accessToken: token,
            idempotent: false,
          });
          const d = res.data;
          if (!d?.video_id || !d.upload_session_id)
            fail("GRAPH_ERROR", "Facebook yükleme oturumu açılamadı.");
          s.videoId = d.video_id;
          s.uploadSessionId = d.upload_session_id;
          s.nextRange = { start: Number(d.start_offset ?? 0), end: Number(d.end_offset ?? 0) };
          s.phase = "transfer";
          return;
        }
        const edge = req.kind === "facebook.reel" ? "video_reels" : "video_stories";
        const res = await graph.request<{ video_id?: string; upload_url?: string }>({
          method: "POST",
          path: `/${page}/${edge}`,
          form: { upload_phase: "start" },
          accessToken: token,
          idempotent: false,
        });
        if (!res.data?.video_id) fail("GRAPH_ERROR", "Facebook yükleme oturumu açılamadı.");
        s.videoId = res.data.video_id;
        s.uploadUrl = res.data.upload_url ?? null;
        s.phase = "upload";
        return;
      }

      case "transfer": {
        const video = videoOf(req) as VideoMedia;
        const range = s.nextRange;
        if (!range || video.source.type !== "upload")
          fail("INVALID_STATE", "Yükleme aralığı bilinmiyor.");
        if (range.start >= range.end) {
          s.phase = "arm_publish";
          return;
        }
        const chunk = await readRangeBlob(
          ctx,
          video.source.key,
          range.start,
          range.end - range.start,
        );
        const res = await graph.request<{
          start_offset?: string | number;
          end_offset?: string | number;
        }>({
          method: "POST",
          host: "graphVideo",
          path: `/${page}/videos`,
          multipart: {
            upload_phase: "transfer",
            upload_session_id: s.uploadSessionId as string,
            start_offset: String(range.start),
            video_file_chunk: chunk,
          },
          accessToken: token,
          // Addressed by start_offset; Meta answers with the next range.
          idempotent: true,
        });
        s.uploadedBytes = range.end;
        s.nextRange = {
          start: Number(res.data?.start_offset ?? range.end),
          end: Number(res.data?.end_offset ?? range.end),
        };
        if (s.nextRange.start >= s.nextRange.end) s.phase = "arm_publish";
        return;
      }

      case "upload": {
        const video = videoOf(req) as VideoMedia;
        const url =
          s.uploadUrl ?? `${graph.hosts.rupload}/video-upload/${graph.version}/${s.videoId}`;
        if (video.source.type === "url") {
          await graph.request({
            method: "POST",
            path: url,
            headers: { file_url: video.source.url },
            accessToken: token,
            idempotent: true,
          });
          s.phase = "wait_upload";
          return;
        }
        const size = video.bytes as number;
        const st = await this.videoStatus(s.videoId as string, token);
        const up = st.status?.uploading_phase;
        const offset = up?.bytes_transfered ?? up?.bytes_transferred ?? 0;
        if (up?.status === "complete" || offset >= size) {
          s.uploadedBytes = size;
          s.phase = "wait_upload";
          return;
        }
        const length = Math.min(size - offset, this.deps.options.uploadChunkBytes ?? size);
        const body = await readRange(ctx, video.source.key, offset, length);
        await graph.request({
          method: "POST",
          path: url,
          headers: { offset: String(offset), file_size: String(size) },
          body,
          accessToken: token,
          // No inline retry: the next step resumes from Meta's bytes_transfered.
          idempotent: true,
          retry: { maxAttempts: 1 },
        });
        s.uploadedBytes = offset + length;
        if (s.uploadedBytes >= size) s.phase = "wait_upload";
        return;
      }

      case "wait_upload": {
        const st = (await this.videoStatus(s.videoId as string, token)).status;
        const vs = st?.video_status;
        if (vs === "upload_failed") {
          // Pushed bytes can be resumed from Meta's offset; a URL pull is retried whole.
          s.phase = "upload";
          fail("UPLOAD_FAILED", "Video Facebook'a yüklenemedi; yeniden denenecek.");
        }
        if (vs === "error" || vs === "expired") {
          fail("UPLOAD_FAILED", "Facebook videoyu işleyemedi. Dosyanın biçimini kontrol edin.", {
            action: "fix_content",
          });
        }
        if (
          st?.uploading_phase?.status === "complete" ||
          vs === "upload_complete" ||
          vs === "processing" ||
          vs === "ready"
        ) {
          s.phase = "arm_publish";
          return;
        }
        throw new PollSignal("upload");
      }

      case "arm_publish": {
        s.intentAt ??= clock.now();
        s.phase = "publish";
        return;
      }

      case "publish": {
        await this.publish(s, token);
        return;
      }

      case "wait_publish": {
        const st = (await this.videoStatus(s.videoId as string, token)).status;
        const pub = st?.publishing_phase;
        if (
          st?.video_status === "error" ||
          pub?.status === "error" ||
          st?.processing_phase?.status === "error"
        ) {
          fail("UPLOAD_FAILED", "Facebook videoyu yayınlayamadı. Dosyanın biçimini kontrol edin.", {
            action: "fix_content",
          });
        }
        if (pub?.publish_status === "published" || pub?.status === "complete") {
          s.phase = "fetch_permalink";
          return;
        }
        throw new PollSignal("publish");
      }

      case "fetch_permalink": {
        let permalink: string | null = null;
        const target = s.postId ?? s.externalId;
        if (target) {
          try {
            const r = await graph.get<{ permalink_url?: string }>(
              `/${target}`,
              { fields: "permalink_url" },
              token,
            );
            permalink = absolutePermalink(r?.permalink_url);
          } catch (err) {
            if (!(err instanceof GraphError)) throw err;
            s.warnings.push({
              code: "PERMALINK_UNAVAILABLE",
              message: "Gönderi yayınlandı ama bağlantısı alınamadı.",
            });
          }
        }
        const result: PublishResult = {
          platform: "facebook",
          kind: req.kind,
          externalId: s.externalId,
          postId: s.postId,
          permalink,
          publishedAt: iso(s.publishedAt ?? clock.now()),
          warnings: s.warnings,
          reconciled: s.reconciled,
        };
        s.result = result;
        s.phase = "done";
        return;
      }
    }
  }

  private async publish(s: FacebookState, token: string) {
    const { graph, clock } = this.deps;
    const req = s.request;
    const page = req.pageId;
    const done = (
      fields: { externalId: string | null; postId?: string | null },
      next: FacebookPhase = "fetch_permalink",
    ) => {
      s.externalId = fields.externalId;
      s.postId = fields.postId ?? s.postId;
      s.publishedAt ??= clock.now();
      s.phase = next;
    };

    switch (req.kind) {
      case "facebook.photo": {
        const found = await this.findFeedPost(s, token, { text: req.caption, attachmentIds: [] });
        if (found) return done({ externalId: found.id, postId: found.id });
        const res = await graph.request<{ id?: string; post_id?: string }>({
          method: "POST",
          path: `/${page}/photos`,
          form: {
            url: req.image.url,
            caption: req.caption,
            alt_text_custom: req.image.altText,
            published: true,
          },
          accessToken: token,
          idempotent: false,
        });
        if (!res.data?.id) fail("GRAPH_ERROR", "Facebook fotoğraf kimliği döndürmedi.");
        return done({ externalId: res.data.id, postId: res.data.post_id ?? null });
      }

      case "facebook.multi_photo": {
        const ids = s.photoIds as string[];
        const found = await this.findFeedPost(s, token, { text: req.message, attachmentIds: ids });
        if (found) return done({ externalId: found.id, postId: found.id });
        const res = await graph.request<{ id?: string }>({
          method: "POST",
          path: `/${page}/feed`,
          form: { message: req.message, attached_media: ids.map((id) => ({ media_fbid: id })) },
          indexedArrays: ["attached_media"],
          accessToken: token,
          idempotent: false,
        });
        if (!res.data?.id) fail("GRAPH_ERROR", "Facebook gönderi kimliği döndürmedi.");
        return done({ externalId: res.data.id, postId: res.data.id });
      }

      case "facebook.video": {
        if (req.video.source.type === "upload") {
          // Chunked upload: the video id is known; its status tells whether finish already ran.
          if (await this.videoPublishStarted(s.videoId as string, token)) {
            s.reconciled = true;
            return done({ externalId: s.videoId });
          }
          await graph.request({
            method: "POST",
            host: "graphVideo",
            path: `/${page}/videos`,
            form: {
              upload_phase: "finish",
              upload_session_id: s.uploadSessionId,
              title: req.title,
              description: req.description,
            },
            accessToken: token,
            idempotent: false,
          });
          return done({ externalId: s.videoId });
        }
        const found = await this.findPageVideo(s, token);
        if (found) return done({ externalId: found });
        const res = await graph.request<{ id?: string }>({
          method: "POST",
          host: "graphVideo",
          path: `/${page}/videos`,
          form: { file_url: req.video.source.url, title: req.title, description: req.description },
          accessToken: token,
          idempotent: false,
        });
        if (!res.data?.id) fail("GRAPH_ERROR", "Facebook video kimliği döndürmedi.");
        return done({ externalId: res.data.id });
      }

      case "facebook.reel":
      case "facebook.story": {
        if (req.kind === "facebook.story" && req.media.kind === "image") {
          const photoId = s.photoIds[0] as string;
          const story = await this.findStory(s, token, photoId);
          if (story) {
            s.reconciled = true;
            return done({ externalId: photoId, postId: story });
          }
          const res = await graph.request<{ success?: boolean; post_id?: string }>({
            method: "POST",
            path: `/${page}/photo_stories`,
            form: { photo_id: photoId },
            accessToken: token,
            idempotent: false,
          });
          return done({ externalId: photoId, postId: res.data?.post_id ?? null });
        }
        return this.finishVideo(s, req.kind, token, done);
      }
    }
  }

  private async finishVideo(
    s: FacebookState,
    kind: FbVideoKind,
    token: string,
    done: (f: { externalId: string | null; postId?: string | null }, next?: FacebookPhase) => void,
  ) {
    const { graph } = this.deps;
    const req = s.request as FacebookRequest & { kind: FbVideoKind };
    const videoId = s.videoId as string;
    if (await this.videoPublishStarted(videoId, token)) {
      s.reconciled = true;
      const postId = kind === "facebook.story" ? await this.findStory(s, token, videoId) : null;
      return done({ externalId: videoId, postId }, "wait_publish");
    }
    const form: Params =
      kind === "facebook.reel"
        ? {
            upload_phase: "finish",
            video_id: videoId,
            video_state: "PUBLISHED",
            title: (req as { title?: string }).title,
            description: (req as { description?: string }).description,
            ...(req.isAiGenerated ? { is_ai_generated: true } : {}),
          }
        : {
            upload_phase: "finish",
            video_id: videoId,
            ...(req.isAiGenerated ? { is_ai_generated: true } : {}),
          };
    const res = await graph.request<{ success?: boolean; post_id?: string }>({
      method: "POST",
      path: `/${req.pageId}/${kind === "facebook.reel" ? "video_reels" : "video_stories"}`,
      form,
      accessToken: token,
      idempotent: false,
    });
    if (res.data?.success === false) fail("GRAPH_ERROR", "Facebook videoyu yayınlamayı reddetti.");
    return done({ externalId: videoId, postId: res.data?.post_id ?? null }, "wait_publish");
  }

  private videoStatus(videoId: string, token: string) {
    return this.deps.graph.get<VideoStatus>(`/${videoId}`, { fields: "status" }, token);
  }

  /** True once `upload_phase=finish` has been accepted for this video. */
  private async videoPublishStarted(videoId: string, token: string): Promise<boolean> {
    const pub = (await this.videoStatus(videoId, token)).status?.publishing_phase;
    if (!pub) return false;
    return (
      (pub.status !== undefined && pub.status !== "not_started") ||
      pub.publish_status === "published"
    );
  }

  /**
   * Look for a feed post we may already have created. Strong match: one of
   * our photo ids is attached, or the message is identical. If there are
   * posts we cannot attribute and the request has no text to match on,
   * refuse to guess (PUBLISH_UNCERTAIN) rather than risk a duplicate.
   */
  private async findFeedPost(
    s: FacebookState,
    token: string,
    match: { text: string | undefined; attachmentIds: string[] },
  ): Promise<PagePost | null> {
    const since = (s.intentAt ?? s.createdAt) - this.deps.options.reconcileSkewMs;
    const res = await this.deps.graph.get<{ data?: PagePost[] }>(
      `/${s.request.pageId}/published_posts`,
      {
        fields: "id,message,created_time,attachments{target{id},subattachments{target{id}}}",
        since: unix(since),
        limit: 25,
      },
      token,
    );
    const posts = (res?.data ?? []).filter((p) => (parseMetaTime(p.created_time) ?? 0) >= since);
    const text = normaliseText(match.text);
    const ids = new Set(match.attachmentIds);
    const attached = (p: PagePost) =>
      (p.attachments?.data ?? []).flatMap((a) => [
        a.target?.id,
        ...(a.subattachments?.data ?? []).map((x) => x.target?.id),
      ]);
    const strong = posts.find(
      (p) =>
        attached(p).some((id) => id && ids.has(id)) || (text && normaliseText(p.message) === text),
    );
    if (strong) {
      s.reconciled = true;
      return strong;
    }
    if (!text && ids.size === 0 && posts.some((p) => !normaliseText(p.message))) this.uncertain();
    return null;
  }

  private async findPageVideo(s: FacebookState, token: string): Promise<string | null> {
    const req = s.request as FacebookRequest & { kind: "facebook.video" };
    const since = (s.intentAt ?? s.createdAt) - this.deps.options.reconcileSkewMs;
    const res = await this.deps.graph.get<{
      data?: { id: string; title?: string; description?: string; created_time?: string }[];
    }>(
      `/${req.pageId}/videos`,
      { fields: "id,title,description,created_time", since: unix(since), limit: 25 },
      token,
    );
    const vids = (res?.data ?? []).filter((v) => (parseMetaTime(v.created_time) ?? 0) >= since);
    const title = normaliseText(req.title);
    const desc = normaliseText(req.description);
    const strong = vids.find(
      (v) =>
        (title || desc) &&
        normaliseText(v.title) === title &&
        normaliseText(v.description) === desc,
    );
    if (strong) {
      s.reconciled = true;
      return strong.id;
    }
    if (!title && !desc && vids.length > 0) this.uncertain();
    return null;
  }

  private async findStory(
    s: FacebookState,
    token: string,
    mediaId: string,
  ): Promise<string | null> {
    const since = (s.intentAt ?? s.createdAt) - this.deps.options.reconcileSkewMs;
    const res = await this.deps.graph.get<{ data?: { post_id?: string; media_id?: string }[] }>(
      `/${s.request.pageId}/stories`,
      { since: unix(since) },
      token,
    );
    return (res?.data ?? []).find((st) => st.media_id === mediaId)?.post_id ?? null;
  }

  private uncertain(): never {
    fail(
      "PUBLISH_UNCERTAIN",
      "Bu gönderinin daha önce yayınlanıp yayınlanmadığı kesin olarak anlaşılamadı; çift paylaşım olmaması için durduruldu. Sayfayı kontrol edin.",
    );
  }
}
