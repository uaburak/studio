/**
 * Turn a stored order + one of its targets into a `@studio/publishers`
 * request. Every media file is referenced by a signed URL on this Worker:
 * Meta pulls images (and videos) from there. LinkedIn uploads are pushed by
 * the publisher itself, so LinkedIn media also names the file's media id as
 * an upload source: the scheduler's media reader serves the bytes straight
 * from storage (no request from this Worker to its own public URL).
 *
 * Publish details (N13) come with the order: the first comment (Instagram, Facebook), location,
 * collaborators, people tags, Reels cover / frame and share-to-feed (Instagram). Each kind takes
 * what it supports. A medium with `role: "cover"` is the Reels cover picture, not a post medium.
 */

import type { CloudOrderDetails, CloudOrderMedia, CloudPublishKind } from "@studio/contract";
import type {
  AnyMedia,
  DocumentMedia,
  ImageMedia,
  PublishKind,
  PublishRequest,
  VideoMedia,
} from "@studio/publishers";

// The contract enum must list exactly the publishers' kinds.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const kindsMatch: Same<CloudPublishKind, PublishKind> = true;
void kindsMatch;

export interface RequestInput {
  caption: string | null;
  title: string | null;
  isAiGenerated: boolean;
  media: CloudOrderMedia[];
  details?: CloudOrderDetails | null;
}

export interface TargetInput {
  kind: CloudPublishKind;
  accountExternalId: string;
}

function meta(m: CloudOrderMedia) {
  return {
    mimeType: m.mimeType,
    bytes: m.bytes,
    ...(m.width !== undefined ? { width: m.width } : {}),
    ...(m.height !== undefined ? { height: m.height } : {}),
  };
}

function image(m: CloudOrderMedia, url: string, opts: { tags?: boolean } = {}): ImageMedia {
  return {
    kind: "image",
    url,
    ...meta(m),
    ...(m.altText ? { altText: m.altText } : {}),
    ...(opts.tags && m.userTags?.length ? { userTags: m.userTags } : {}),
  };
}

function video(m: CloudOrderMedia, url: string): VideoMedia {
  return {
    kind: "video",
    source: { type: "url", url },
    ...meta(m),
    ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
    ...(m.frameRate !== undefined ? { frameRate: m.frameRate } : {}),
  };
}

function document(m: CloudOrderMedia, url: string, title: string | null): DocumentMedia {
  return {
    kind: "document",
    url,
    mimeType: m.mimeType,
    bytes: m.bytes,
    ...(title ? { title } : {}),
  };
}

/** LinkedIn: the publisher reads the file from storage by its media id. */
function stored(img: ImageMedia, m: CloudOrderMedia): ImageMedia {
  return { ...img, source: { type: "upload", key: m.id } };
}

const any = (m: CloudOrderMedia, url: string, opts: { tags?: boolean } = {}): AnyMedia =>
  m.kind === "image" ? image(m, url, opts) : video(m, url);

/**
 * `urlOf(mediaId)` gives the public URL of each file. Single-media kinds use
 * the first file; validation (`validateRequest`) reports a wrong type.
 */
export function buildRequest(
  order: RequestInput,
  target: TargetInput,
  urlOf: (mediaId: string) => string,
): PublishRequest {
  const caption = order.caption ?? undefined;
  const authorUrn = target.accountExternalId;
  const d = order.details ?? {};
  const comment = d.firstComment ? { firstComment: d.firstComment } : {};
  const igExtras = {
    ...comment,
    ...(d.collaborators?.length ? { collaborators: d.collaborators } : {}),
    ...(d.locationId ? { locationId: d.locationId } : {}),
  };
  if (target.kind === "linkedin.text") {
    return {
      kind: "linkedin.text",
      authorUrn,
      commentary: order.caption ?? "",
    };
  }

  const cover = order.media.find((m) => m.role === "cover");
  const media = order.media.filter((m) => m.role !== "cover");
  const [first] = media;
  if (!first) throw new Error("order has no media");
  const firstUrl = urlOf(first.id);
  const ai = order.isAiGenerated ? { isAiGenerated: true } : {};
  const igUserId = target.accountExternalId;
  const pageId = target.accountExternalId;

  switch (target.kind) {
    case "instagram.image":
      return {
        kind: target.kind,
        igUserId,
        image: image(first, firstUrl),
        caption,
        ...ai,
        ...igExtras,
        ...(first.userTags?.length ? { userTags: first.userTags } : {}),
      };
    case "instagram.carousel":
      return {
        kind: target.kind,
        igUserId,
        items: media.map((m) => any(m, urlOf(m.id), { tags: true })),
        caption,
        ...ai,
        ...igExtras,
      };
    case "instagram.reel":
      return {
        kind: target.kind,
        igUserId,
        video: video(first, firstUrl),
        caption,
        shareToFeed: d.shareToFeed ?? true,
        ...ai,
        ...igExtras,
        ...(d.reelUserTags?.length
          ? { userTags: d.reelUserTags.map((username) => ({ username })) }
          : {}),
        // A cover picture wins over a frame (Meta ignores the frame then).
        ...(cover
          ? { coverUrl: urlOf(cover.id) }
          : d.thumbOffsetMs !== undefined
            ? { thumbOffsetMs: d.thumbOffsetMs }
            : {}),
      };
    case "instagram.story":
      return { kind: target.kind, igUserId, media: any(first, firstUrl), ...ai };
    case "facebook.photo":
      return { kind: target.kind, pageId, image: image(first, firstUrl), caption, ...comment };
    case "facebook.multi_photo":
      return {
        kind: target.kind,
        pageId,
        images: media.map((m) => image(m, urlOf(m.id))),
        message: caption,
        ...comment,
      };
    case "facebook.video":
      return {
        kind: target.kind,
        pageId,
        video: video(first, firstUrl),
        title: order.title ?? undefined,
        description: caption,
        ...comment,
      };
    case "facebook.reel":
      return {
        kind: target.kind,
        pageId,
        video: video(first, firstUrl),
        title: order.title ?? undefined,
        description: caption,
        ...ai,
        ...comment,
      };
    case "facebook.story":
      return { kind: target.kind, pageId, media: any(first, firstUrl), ...ai };
    case "linkedin.image":
      return {
        kind: target.kind,
        authorUrn,
        image: stored(image(first, firstUrl), first),
        ...(caption !== undefined ? { commentary: caption } : {}),
      };
    case "linkedin.multi_image":
      return {
        kind: target.kind,
        authorUrn,
        images: media.map((m) => stored(image(m, urlOf(m.id)), m)),
        ...(caption !== undefined ? { commentary: caption } : {}),
      };
    case "linkedin.document":
      return {
        kind: target.kind,
        authorUrn,
        document: {
          ...document(first, firstUrl, order.title),
          source: { type: "upload", key: first.id },
        },
        title: order.title ?? first.altText ?? first.id,
        ...(caption !== undefined ? { commentary: caption } : {}),
      };
    case "linkedin.video":
      return {
        kind: target.kind,
        authorUrn,
        video: { ...video(first, firstUrl), source: { type: "upload", key: first.id } },
        ...(order.title ? { title: order.title } : {}),
        ...(caption !== undefined ? { commentary: caption } : {}),
      };
  }
}
