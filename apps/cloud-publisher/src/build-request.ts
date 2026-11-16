/**
 * Turn a stored order + one of its targets into a `@studio/publishers`
 * request. Every media file is referenced by a signed URL on this Worker:
 * Meta pulls images (and videos) from there.
 */

import type { CloudOrderMedia, CloudPublishKind } from "@studio/contract";
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

function image(m: CloudOrderMedia, url: string): ImageMedia {
  return {
    kind: "image",
    url,
    ...meta(m),
    ...(m.altText ? { altText: m.altText } : {}),
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

const any = (m: CloudOrderMedia, url: string): AnyMedia =>
  m.kind === "image" ? image(m, url) : video(m, url);

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
  if (target.kind === "linkedin.text") {
    return {
      kind: "linkedin.text",
      authorUrn,
      commentary: order.caption ?? "",
    };
  }

  const [first] = order.media;
  if (!first) throw new Error("order has no media");
  const firstUrl = urlOf(first.id);
  const ai = order.isAiGenerated ? { isAiGenerated: true } : {};
  const igUserId = target.accountExternalId;
  const pageId = target.accountExternalId;

  switch (target.kind) {
    case "instagram.image":
      return { kind: target.kind, igUserId, image: image(first, firstUrl), caption, ...ai };
    case "instagram.carousel":
      return {
        kind: target.kind,
        igUserId,
        items: order.media.map((m) => any(m, urlOf(m.id))),
        caption,
        ...ai,
      };
    case "instagram.reel":
      return {
        kind: target.kind,
        igUserId,
        video: video(first, firstUrl),
        caption,
        shareToFeed: true,
        ...ai,
      };
    case "instagram.story":
      return { kind: target.kind, igUserId, media: any(first, firstUrl), ...ai };
    case "facebook.photo":
      return { kind: target.kind, pageId, image: image(first, firstUrl), caption };
    case "facebook.multi_photo":
      return {
        kind: target.kind,
        pageId,
        images: order.media.map((m) => image(m, urlOf(m.id))),
        message: caption,
      };
    case "facebook.video":
      return {
        kind: target.kind,
        pageId,
        video: video(first, firstUrl),
        title: order.title ?? undefined,
        description: caption,
      };
    case "facebook.reel":
      return {
        kind: target.kind,
        pageId,
        video: video(first, firstUrl),
        title: order.title ?? undefined,
        description: caption,
        ...ai,
      };
    case "facebook.story":
      return { kind: target.kind, pageId, media: any(first, firstUrl), ...ai };
    case "linkedin.image":
      return {
        kind: target.kind,
        authorUrn,
        image: image(first, firstUrl),
        ...(caption !== undefined ? { commentary: caption } : {}),
      };
    case "linkedin.multi_image":
      return {
        kind: target.kind,
        authorUrn,
        images: order.media.map((m) => image(m, urlOf(m.id))),
        ...(caption !== undefined ? { commentary: caption } : {}),
      };
    case "linkedin.document":
      return {
        kind: target.kind,
        authorUrn,
        document: document(first, firstUrl, order.title),
        title: order.title ?? first.altText ?? first.id,
        ...(caption !== undefined ? { commentary: caption } : {}),
      };
    case "linkedin.video":
      return {
        kind: target.kind,
        authorUrn,
        video: video(first, firstUrl),
        ...(order.title ? { title: order.title } : {}),
        ...(caption !== undefined ? { commentary: caption } : {}),
      };
  }
}
