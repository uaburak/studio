/**
 * Instagram publisher (Instagram API with Facebook Login, graph.facebook.com).
 *
 * Flow per request, one remote mutation per step:
 *
 *   check_quota      GET  /{ig}/content_publishing_limit
 *   create_items     POST /{ig}/media                 (one container per step)
 *   upload_items     POST rupload /ig-api-upload/...  (pushed videos only, resumable by offset)
 *   wait_items       GET  /{container}?fields=status_code   (poll)
 *   create_parent    POST /{ig}/media media_type=CAROUSEL   (carousel only)
 *   wait_parent      GET  /{carousel}?fields=status_code    (poll)
 *   arm_publish      GET  content_publishing_limit; persist `intentAt`
 *   publish          GET status first: PUBLISHED -> reconcile, FINISHED -> POST /{ig}/media_publish
 *   fetch_permalink  GET  /{media-id}?fields=permalink
 *
 * Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
 */

import { GraphError } from "../errors.ts";
import type { GraphClient } from "../graph/client.ts";
import type { Params, ParamValue } from "../graph/encode.ts";
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
  runStep,
  type StepContext,
  type StepOutcome,
} from "../machine.ts";
import {
  type AnyMedia,
  InstagramRequest,
  type PublishingQuota,
  type PublishResult,
  type PublishWarning,
  type VideoMedia,
} from "../models.ts";
import { validateRequest } from "../validation/index.ts";

export type InstagramPhase =
  | "check_quota"
  | "create_items"
  | "upload_items"
  | "wait_items"
  | "create_parent"
  | "wait_parent"
  | "arm_publish"
  | "publish"
  | "fetch_permalink";

export interface InstagramItemState {
  containerId: string | null;
  /** Bytes Meta has acknowledged for pushed uploads. */
  uploadedBytes: number;
  /** URL sources are "uploaded" as soon as the container exists. */
  uploaded: boolean;
  /** `status_code` FINISHED was observed. */
  ready: boolean;
}

export interface InstagramState
  extends BaseState<InstagramRequest["kind"], InstagramRequest, InstagramPhase> {
  /** One entry per media: the single image/video, or each carousel child. */
  items: InstagramItemState[];
  /** Carousel container id. */
  parentContainerId: string | null;
  mediaId: string | null;
  publishedAt: number | null;
  reconciled: boolean;
  quota: PublishingQuota | null;
  /** Times expired/failed containers were recreated. */
  recreations: number;
}

type ContainerStatusCode = "EXPIRED" | "ERROR" | "FINISHED" | "IN_PROGRESS" | "PUBLISHED";

interface ContainerStatus {
  id?: string;
  status_code?: ContainerStatusCode;
  status?: string;
  video_status?: {
    uploading_phase?: { status?: string; bytes_transferred?: number; bytes_transfered?: number };
    processing_phase?: { status?: string };
  };
}

const CONFIG_ISSUE_TR: Record<string, string> = {
  CAPTION_NOT_ATTACHED:
    "Gönderi yayınlandı ama açıklama eklenemedi; açıklamayı Instagram'da elle ekleyin.",
  USER_TAGGING_FAILURE: "Gönderi yayınlandı ama kişi etiketleri eklenemedi.",
  POLL_CREATION_FAILURE: "Gönderi yayınlandı ama anket eklenemedi.",
  PROMPT_CREATION_FAILURE: "Gönderi yayınlandı ama yorum istemi eklenemedi.",
};

/** Subcodes after which Meta says to create a new container and retry. */
const RECREATE_SUBCODES = new Set([2207001, 2207003, 2207020, 2207032, 2207053]);

const PRODUCT_TYPE: Record<InstagramRequest["kind"], string> = {
  "instagram.image": "FEED",
  "instagram.carousel": "FEED",
  "instagram.reel": "REELS",
  "instagram.story": "STORY",
};

function mediaList(req: InstagramRequest): AnyMedia[] {
  switch (req.kind) {
    case "instagram.image":
      return [req.image];
    case "instagram.carousel":
      return req.items;
    case "instagram.reel":
      return [req.video];
    case "instagram.story":
      return [req.media];
  }
}

const isPushed = (m: AnyMedia): m is VideoMedia & { source: { type: "upload"; key: string } } =>
  m.kind === "video" && m.source.type === "upload";

function tags(
  list: { username: string; x?: number | undefined; y?: number | undefined }[] | undefined,
) {
  return list?.map((t) => ({
    username: t.username,
    ...(t.x !== undefined ? { x: t.x } : {}),
    ...(t.y !== undefined ? { y: t.y } : {}),
  }));
}

function videoParams(v: VideoMedia): Params {
  return v.source.type === "url" ? { video_url: v.source.url } : {};
}

/** Params for the container of item `i` (the single media or a carousel child). */
export function itemContainerParams(req: InstagramRequest, i: number): Params {
  const ai = req.isAiGenerated ? { is_ai_generated: true } : {};
  switch (req.kind) {
    case "instagram.image":
      return {
        image_url: req.image.url,
        caption: req.caption,
        alt_text: req.image.altText,
        collaborators: req.collaborators as ParamValue,
        location_id: req.locationId,
        user_tags: tags(req.userTags),
        ...ai,
      };
    case "instagram.carousel": {
      const m = req.items[i];
      if (!m) throw new Error(`carousel item ${i} missing`);
      // is_ai_generated goes on the parent only; Meta errors on children.
      return m.kind === "image"
        ? { image_url: m.url, is_carousel_item: true, alt_text: m.altText }
        : { media_type: "VIDEO", is_carousel_item: true, ...videoParams(m) };
    }
    case "instagram.reel":
      return {
        media_type: "REELS",
        ...videoParams(req.video),
        caption: req.caption,
        cover_url: req.coverUrl,
        thumb_offset: req.thumbOffsetMs,
        share_to_feed: req.shareToFeed,
        audio_name: req.audioName,
        collaborators: req.collaborators as ParamValue,
        location_id: req.locationId,
        user_tags: tags(req.userTags),
        trial_params: req.trial ? { graduation_strategy: req.trial.graduationStrategy } : undefined,
        ...ai,
      };
    case "instagram.story":
      return {
        media_type: "STORIES",
        ...(req.media.kind === "image" ? { image_url: req.media.url } : videoParams(req.media)),
        user_tags: tags(req.userTags),
        ...ai,
      };
  }
}

function parentParams(
  req: InstagramRequest & { kind: "instagram.carousel" },
  children: string[],
): Params {
  return {
    media_type: "CAROUSEL",
    children,
    caption: req.caption,
    collaborators: req.collaborators as ParamValue,
    location_id: req.locationId,
    ...(req.isAiGenerated ? { is_ai_generated: true } : {}),
  };
}

export async function readPublishingQuota(
  graph: GraphClient,
  igUserId: string,
  accessToken: string,
  now: number,
): Promise<PublishingQuota | null> {
  const res = await graph.get<{
    data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[];
  }>(`/${igUserId}/content_publishing_limit`, { fields: "quota_usage,config" }, accessToken);
  const row = res?.data?.[0];
  if (!row || typeof row.quota_usage !== "number" || typeof row.config?.quota_total !== "number")
    return null;
  return {
    usage: row.quota_usage,
    total: row.config.quota_total,
    durationSeconds: row.config.quota_duration ?? 86_400,
    checkedAt: now,
  };
}

export class InstagramPublisher implements Publisher<InstagramRequest, InstagramState> {
  readonly platform = "instagram" as const;

  constructor(private readonly deps: PublisherDeps) {}

  validate(request: unknown) {
    return validateRequest(request);
  }

  start(input: InstagramRequest): InstagramState {
    const report = assertValid(input);
    const request = InstagramRequest.parse(input);
    const now = this.deps.clock.now();
    return {
      ...initialBase(request.kind, request, "check_quota" as InstagramPhase, now, report),
      items: mediaList(request).map(() => ({
        containerId: null,
        uploadedBytes: 0,
        uploaded: false,
        ready: false,
      })),
      parentContainerId: null,
      mediaId: null,
      publishedAt: null,
      reconciled: false,
      quota: null,
      recreations: 0,
    };
  }

  step(state: InstagramState, ctx: StepContext): Promise<StepOutcome<InstagramState>> {
    return runStep(this.deps, state, ctx, (s) => this.advance(s, ctx));
  }

  private async advance(s: InstagramState, ctx: StepContext): Promise<void> {
    const { graph, clock } = this.deps;
    const token = ctx.accessToken;
    const req = s.request;
    switch (s.phase) {
      case "check_quota": {
        await this.checkQuota(s, token);
        s.phase = "create_items";
        return;
      }

      case "create_items": {
        const i = s.items.findIndex((it) => it.containerId === null);
        if (i === -1) {
          s.phase = s.items.some((it) => !it.uploaded) ? "upload_items" : "wait_items";
          return;
        }
        const media = mediaList(req)[i] as AnyMedia;
        const pushed = isPushed(media);
        const res = await graph.request<{ id?: string }>({
          method: "POST",
          path: `/${req.igUserId}/media`,
          // Docs put upload_type in the query string.
          query: pushed ? { upload_type: "resumable" } : undefined,
          form: itemContainerParams(req, i),
          accessToken: token,
          idempotent: false,
        });
        const id = res.data?.id;
        if (!id) fail("GRAPH_ERROR", "Instagram konteyner kimliği döndürmedi.");
        const item = s.items[i] as InstagramItemState;
        item.containerId = id;
        item.uploaded = !pushed;
        if (s.items.every((it) => it.containerId !== null))
          s.phase = s.items.some((it) => !it.uploaded) ? "upload_items" : "wait_items";
        return;
      }

      case "upload_items": {
        const i = s.items.findIndex((it) => !it.uploaded);
        if (i === -1) {
          s.phase = "wait_items";
          return;
        }
        await this.uploadItem(s, i, ctx);
        if (s.items.every((it) => it.uploaded)) s.phase = "wait_items";
        return;
      }

      case "wait_items": {
        let pending = false;
        for (let i = 0; i < s.items.length; i++) {
          const item = s.items[i] as InstagramItemState;
          if (item.ready) continue;
          const st = await this.status(item.containerId as string, token);
          if (st.status_code === "FINISHED") item.ready = true;
          else if (st.status_code === "PUBLISHED") {
            // Only possible for single-media kinds after a publish we lost track of.
            s.phase = "publish";
            return;
          } else if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
            this.containerFailed(s, st);
            return;
          } else pending = true;
        }
        if (pending) throw new PollSignal("items");
        s.phase = req.kind === "instagram.carousel" ? "create_parent" : "arm_publish";
        return;
      }

      case "create_parent": {
        if (req.kind !== "instagram.carousel") {
          s.phase = "arm_publish";
          return;
        }
        const children = s.items.map((it) => it.containerId as string);
        const res = await graph.request<{ id?: string }>({
          method: "POST",
          path: `/${req.igUserId}/media`,
          form: parentParams(req, children),
          accessToken: token,
          idempotent: false,
        });
        if (!res.data?.id) fail("GRAPH_ERROR", "Instagram carousel kimliği döndürmedi.");
        s.parentContainerId = res.data.id;
        s.phase = "wait_parent";
        return;
      }

      case "wait_parent": {
        const st = await this.status(s.parentContainerId as string, token);
        if (st.status_code === "FINISHED") s.phase = "arm_publish";
        else if (st.status_code === "PUBLISHED") s.phase = "publish";
        else if (st.status_code === "ERROR" || st.status_code === "EXPIRED")
          this.containerFailed(s, st);
        else throw new PollSignal("parent");
        return;
      }

      case "arm_publish": {
        await this.checkQuota(s, token);
        s.intentAt ??= clock.now();
        s.phase = "publish";
        return;
      }

      case "publish": {
        const cid = this.publishContainerId(s);
        const st = await this.status(cid, token);
        if (st.status_code === "PUBLISHED") {
          await this.reconcile(s, token);
          s.phase = "fetch_permalink";
          return;
        }
        if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
          this.containerFailed(s, st);
          return;
        }
        if (st.status_code !== "FINISHED") throw new PollSignal("publish");
        let res: { id?: string; config_issue?: string; caption_add_on_attachment_status?: string };
        try {
          res = (
            await graph.request<typeof res>({
              method: "POST",
              path: `/${req.igUserId}/media_publish`,
              form: { creation_id: cid },
              accessToken: token,
              idempotent: false,
            })
          ).data;
        } catch (err) {
          if (err instanceof GraphError && err.info.category === "not_ready")
            throw new PollSignal("publish");
          throw err;
        }
        if (!res?.id) fail("GRAPH_ERROR", "Instagram yayın kimliği döndürmedi.");
        s.mediaId = res.id;
        s.publishedAt = clock.now();
        for (const issue of [res.config_issue, res.caption_add_on_attachment_status]) {
          if (issue) s.warnings.push(this.issueWarning(issue));
        }
        s.phase = "fetch_permalink";
        return;
      }

      case "fetch_permalink": {
        let permalink: string | null = null;
        if (s.mediaId) {
          try {
            const m = await graph.get<{ permalink?: string }>(
              `/${s.mediaId}`,
              { fields: "id,permalink" },
              token,
            );
            permalink = m?.permalink ?? null;
          } catch (err) {
            if (!(err instanceof GraphError)) throw err;
            s.warnings.push({
              code: "PERMALINK_UNAVAILABLE",
              message: "Gönderi yayınlandı ama bağlantısı alınamadı.",
            });
          }
        }
        const result: PublishResult = {
          platform: "instagram",
          kind: req.kind,
          externalId: s.mediaId,
          postId: null,
          permalink,
          publishedAt: iso(s.publishedAt ?? clock.now()),
          warnings: s.warnings,
          reconciled: s.reconciled,
          ...(s.quota ? { quota: s.quota } : {}),
        };
        s.result = result;
        s.phase = "done";
        return;
      }
    }
  }

  private publishContainerId(s: InstagramState): string {
    const id =
      s.request.kind === "instagram.carousel" ? s.parentContainerId : s.items[0]?.containerId;
    if (!id) fail("INVALID_STATE", "Yayınlanacak konteyner bulunamadı.");
    return id;
  }

  private async checkQuota(s: InstagramState, token: string) {
    const quota = await readPublishingQuota(
      this.deps.graph,
      s.request.igUserId,
      token,
      this.deps.clock.now(),
    );
    if (!quota) {
      if (!s.warnings.some((w) => w.code === "QUOTA_UNKNOWN"))
        s.warnings.push({
          code: "QUOTA_UNKNOWN",
          message: "Instagram paylaşım kotası okunamadı; yine de deneniyor.",
        });
      return;
    }
    s.quota = quota;
    if (quota.usage >= quota.total) {
      fail(
        "QUOTA_EXCEEDED",
        `Günlük Instagram paylaşım sınırı doldu (${quota.usage}/${quota.total}, son ${Math.round(
          quota.durationSeconds / 3600,
        )} saat).`,
      );
    }
  }

  private async status(containerId: string, token: string): Promise<ContainerStatus> {
    return this.deps.graph.get<ContainerStatus>(
      `/${containerId}`,
      { fields: "id,status_code,status" },
      token,
    );
  }

  private async uploadItem(s: InstagramState, i: number, ctx: StepContext) {
    const { graph, options } = this.deps;
    const item = s.items[i] as InstagramItemState;
    const media = mediaList(s.request)[i];
    if (!media || !isPushed(media) || media.bytes === undefined) {
      item.uploaded = true;
      return;
    }
    const size = media.bytes;
    // Ask Meta how much it already has; this is what makes the upload resumable.
    const st = await graph.get<ContainerStatus>(
      `/${item.containerId}`,
      { fields: "id,status,status_code,video_status" },
      ctx.accessToken,
    );
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") {
      this.containerFailed(s, st);
      return;
    }
    const up = st.video_status?.uploading_phase;
    const offset = up?.bytes_transferred ?? up?.bytes_transfered ?? 0;
    if (up?.status === "complete" || offset >= size) {
      item.uploadedBytes = size;
      item.uploaded = true;
      return;
    }
    const length = Math.min(size - offset, options.uploadChunkBytes ?? size);
    const body = await readRange(ctx, media.source.key, offset, length);
    await graph.request({
      method: "POST",
      host: "rupload",
      versioned: false,
      path: `/ig-api-upload/${graph.version}/${item.containerId}`,
      headers: { offset: String(offset), file_size: String(size) },
      body,
      accessToken: ctx.accessToken,
      // Addressed by offset: repeating it is harmless. No inline retry: the
      // next step asks Meta for bytes_transferred and resumes from there.
      idempotent: true,
      retry: { maxAttempts: 1 },
    });
    item.uploadedBytes = offset + length;
    if (item.uploadedBytes >= size) item.uploaded = true;
  }

  /** A container ended in ERROR/EXPIRED: recreate everything once, or fail. */
  private containerFailed(s: InstagramState, st: ContainerStatus) {
    const subcode = Number(/\b(2207\d{3})\b/.exec(st.status ?? "")?.[1] ?? Number.NaN);
    const expired = st.status_code === "EXPIRED";
    const recreatable = expired || RECREATE_SUBCODES.has(subcode);
    if (recreatable && s.recreations < this.deps.options.maxRecreations) {
      s.recreations += 1;
      s.items = s.items.map(() => ({
        containerId: null,
        uploadedBytes: 0,
        uploaded: false,
        ready: false,
      }));
      s.parentContainerId = null;
      s.phase = "create_items";
      s.warnings.push({
        code: "CONTAINER_RECREATED",
        message: expired
          ? "Yükleme kabının süresi dolmuştu; yeniden oluşturuldu."
          : "Instagram medyayı işleyemedi; yükleme yeniden başlatıldı.",
      });
      return;
    }
    const detail = Number.isNaN(subcode) ? "" : ` (kod ${subcode})`;
    fail(
      expired ? "CONTAINER_EXPIRED" : "CONTAINER_FAILED",
      expired
        ? "Instagram yükleme kabının süresi doldu (24 saat)."
        : `Instagram medyayı işleyemedi${detail}. Dosyanın biçimini ve boyutlarını kontrol edin.`,
      { action: expired ? "retry" : "fix_content", retryable: expired },
    );
  }

  /**
   * The container is PUBLISHED but we lost the publish response (crash or
   * timeout). Find the media id among recent posts instead of publishing again.
   */
  private async reconcile(s: InstagramState, token: string) {
    const { graph, options, clock } = this.deps;
    s.reconciled = true;
    s.publishedAt ??= clock.now();
    const edge = s.request.kind === "instagram.story" ? "stories" : "media";
    const since = (s.intentAt ?? s.createdAt) - options.reconcileSkewMs;
    const caption =
      s.request.kind === "instagram.story"
        ? ""
        : normaliseText((s.request as { caption?: string }).caption);
    const res = await graph.get<{
      data?: { id: string; caption?: string; timestamp?: string; media_product_type?: string }[];
    }>(
      `/${s.request.igUserId}/${edge}`,
      { fields: "id,caption,timestamp,media_product_type", limit: 25 },
      token,
    );
    const wanted = PRODUCT_TYPE[s.request.kind];
    const matches = (res?.data ?? [])
      .map((m) => ({ ...m, t: parseMetaTime(m.timestamp) }))
      .filter((m) => m.t !== null && m.t >= since)
      .filter((m) => !m.media_product_type || m.media_product_type === wanted)
      .filter((m) => !caption || normaliseText(m.caption) === caption)
      .sort((a, b) => (a.t as number) - (b.t as number));
    const found = matches[0];
    if (found) {
      s.mediaId = found.id;
      s.publishedAt = found.t ?? s.publishedAt;
    } else {
      s.warnings.push({
        code: "RECONCILED_WITHOUT_ID",
        message: "Gönderi yayınlanmış görünüyor ama kimliği bulunamadı; Instagram'da kontrol edin.",
      });
    }
  }

  private issueWarning(issue: string): PublishWarning {
    return {
      code: `CONFIG_ISSUE_${issue}`,
      message:
        CONFIG_ISSUE_TR[issue] ?? `Gönderi yayınlandı ama bir kısmı uygulanamadı (${issue}).`,
    };
  }
}
