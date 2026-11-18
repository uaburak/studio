/**
 * Request and result models.
 *
 * Requests are plain JSON (validated with zod) so they can be stored inside
 * the workflow state. Images are referenced by public URL (Meta fetches them).
 * Videos are referenced either by public URL or by an opaque storage `key`
 * whose bytes the caller provides at step time through a `MediaReader`
 * (e.g. backed by R2), which enables resumable uploads.
 *
 * Optional metadata (mimeType, width, height, bytes, durationMs, frameRate)
 * feeds pre-flight validation. Missing metadata yields warnings, not errors.
 */

import { z } from "zod";

const PublicUrl = z
  .url({ protocol: /^https?$/ })
  .describe("Publicly reachable URL; Meta downloads the media from here.");

const MediaMeta = {
  mimeType: z.string().min(1).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  /** File size in bytes. */
  bytes: z.number().int().nonnegative().optional(),
};

export const ImageMedia = z.object({
  kind: z.literal("image"),
  url: PublicUrl,
  /**
   * Optional: the same bytes through the caller's `MediaReader`. Publishers that push the file
   * themselves (LinkedIn) read it from there instead of downloading `url`; Meta still pulls `url`.
   */
  source: z.object({ type: z.literal("upload"), key: z.string().min(1) }).optional(),
  ...MediaMeta,
  /** Accessibility text (Instagram feed/carousel images, Facebook photos). */
  altText: z.string().optional(),
});
export type ImageMedia = z.infer<typeof ImageMedia>;

export const VideoSource = z.discriminatedUnion("type", [
  /** Meta pulls the file from this URL. */
  z.object({ type: z.literal("url"), url: PublicUrl }),
  /** We push the bytes (resumable upload); read via `MediaReader.read(key, range)`. */
  z.object({ type: z.literal("upload"), key: z.string().min(1) }),
]);
export type VideoSource = z.infer<typeof VideoSource>;

export const VideoMedia = z
  .object({
    kind: z.literal("video"),
    source: VideoSource,
    ...MediaMeta,
    durationMs: z.number().int().positive().optional(),
    frameRate: z.number().positive().optional(),
  })
  .refine((v) => v.source.type !== "upload" || v.bytes !== undefined, {
    message: "bytes is required for upload sources",
    path: ["bytes"],
  });
export type VideoMedia = z.infer<typeof VideoMedia>;

export const AnyMedia = z.union([ImageMedia, VideoMedia]);
export type AnyMedia = z.infer<typeof AnyMedia>;

export const DocumentSource = VideoSource;
export type DocumentSource = z.infer<typeof DocumentSource>;

export const DocumentMedia = z
  .object({
    kind: z.literal("document"),
    url: PublicUrl.optional(),
    source: DocumentSource.optional(),
    title: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
    bytes: z.number().int().nonnegative().optional(),
  })
  .refine((d) => d.url !== undefined || d.source !== undefined, {
    message: "url or source is required",
    path: ["url"],
  })
  .refine((d) => d.source?.type !== "upload" || d.bytes !== undefined, {
    message: "bytes is required for upload sources",
    path: ["bytes"],
  });
export type DocumentMedia = z.infer<typeof DocumentMedia>;

const IgUserTag = z.object({
  username: z.string().min(1),
  x: z.number().min(0).max(1).optional(),
  y: z.number().min(0).max(1).optional(),
});

const IgCommon = {
  /** Instagram professional account id (IG User id). */
  igUserId: z.string().min(1),
  /** Sends `is_ai_generated=true` (Meta's AI info label). */
  isAiGenerated: z.boolean().optional(),
};

export const InstagramImageRequest = z.object({
  kind: z.literal("instagram.image"),
  ...IgCommon,
  image: ImageMedia,
  caption: z.string().optional(),
  collaborators: z.array(z.string().min(1)).optional(),
  locationId: z.string().min(1).optional(),
  userTags: z.array(IgUserTag).optional(),
});

export const InstagramCarouselRequest = z.object({
  kind: z.literal("instagram.carousel"),
  ...IgCommon,
  items: z.array(AnyMedia),
  caption: z.string().optional(),
  collaborators: z.array(z.string().min(1)).optional(),
  locationId: z.string().min(1).optional(),
});

export const InstagramReelRequest = z.object({
  kind: z.literal("instagram.reel"),
  ...IgCommon,
  video: VideoMedia,
  caption: z.string().optional(),
  /** Public JPEG cover; overrides `thumbOffsetMs` when both are set. */
  coverUrl: PublicUrl.optional(),
  thumbOffsetMs: z.number().int().nonnegative().optional(),
  /** Also show the Reel in the Feed tab. */
  shareToFeed: z.boolean().optional(),
  audioName: z.string().min(1).optional(),
  collaborators: z.array(z.string().min(1)).optional(),
  locationId: z.string().min(1).optional(),
  userTags: z.array(IgUserTag).optional(),
  /** Trial Reel: shown to non-followers first. */
  trial: z.object({ graduationStrategy: z.enum(["MANUAL", "SS_PERFORMANCE"]) }).optional(),
});

export const InstagramStoryRequest = z.object({
  kind: z.literal("instagram.story"),
  ...IgCommon,
  media: AnyMedia,
  userTags: z.array(IgUserTag).optional(),
});

const FbCommon = { pageId: z.string().min(1) };

export const FacebookPhotoRequest = z.object({
  kind: z.literal("facebook.photo"),
  ...FbCommon,
  image: ImageMedia,
  caption: z.string().optional(),
});

export const FacebookMultiPhotoRequest = z.object({
  kind: z.literal("facebook.multi_photo"),
  ...FbCommon,
  images: z.array(ImageMedia),
  message: z.string().optional(),
});

export const FacebookVideoRequest = z.object({
  kind: z.literal("facebook.video"),
  ...FbCommon,
  video: VideoMedia,
  title: z.string().optional(),
  description: z.string().optional(),
});

export const FacebookReelRequest = z.object({
  kind: z.literal("facebook.reel"),
  ...FbCommon,
  video: VideoMedia,
  title: z.string().optional(),
  description: z.string().optional(),
  isAiGenerated: z.boolean().optional(),
});

export const FacebookStoryRequest = z.object({
  kind: z.literal("facebook.story"),
  ...FbCommon,
  media: AnyMedia,
  isAiGenerated: z.boolean().optional(),
});

const AuthorUrn = z
  .string()
  .regex(/^urn:li:[A-Za-z]+:\S+$/, "expected a LinkedIn URN (e.g. urn:li:person:...)");

const LiCommon = {
  /** LinkedIn author URN, e.g. `urn:li:person:...` or `urn:li:organization:...`. */
  authorUrn: AuthorUrn,
};

export const LinkedInTextRequest = z.object({
  kind: z.literal("linkedin.text"),
  ...LiCommon,
  commentary: z.string().min(1),
});
export type LinkedInTextRequest = z.infer<typeof LinkedInTextRequest>;

export const LinkedInImageRequest = z.object({
  kind: z.literal("linkedin.image"),
  ...LiCommon,
  image: ImageMedia,
  commentary: z.string().optional(),
});
export type LinkedInImageRequest = z.infer<typeof LinkedInImageRequest>;

export const LinkedInMultiImageRequest = z.object({
  kind: z.literal("linkedin.multi_image"),
  ...LiCommon,
  images: z.array(ImageMedia),
  commentary: z.string().optional(),
});
export type LinkedInMultiImageRequest = z.infer<typeof LinkedInMultiImageRequest>;

export const LinkedInDocumentRequest = z.object({
  kind: z.literal("linkedin.document"),
  ...LiCommon,
  document: DocumentMedia,
  title: z.string().min(1),
  commentary: z.string().optional(),
});
export type LinkedInDocumentRequest = z.infer<typeof LinkedInDocumentRequest>;

export const LinkedInVideoRequest = z.object({
  kind: z.literal("linkedin.video"),
  ...LiCommon,
  video: VideoMedia,
  title: z.string().optional(),
  commentary: z.string().optional(),
});
export type LinkedInVideoRequest = z.infer<typeof LinkedInVideoRequest>;

export const InstagramRequest = z.discriminatedUnion("kind", [
  InstagramImageRequest,
  InstagramCarouselRequest,
  InstagramReelRequest,
  InstagramStoryRequest,
]);
export type InstagramRequest = z.infer<typeof InstagramRequest>;

export const FacebookRequest = z.discriminatedUnion("kind", [
  FacebookPhotoRequest,
  FacebookMultiPhotoRequest,
  FacebookVideoRequest,
  FacebookReelRequest,
  FacebookStoryRequest,
]);
export type FacebookRequest = z.infer<typeof FacebookRequest>;

export const LinkedInRequest = z.discriminatedUnion("kind", [
  LinkedInTextRequest,
  LinkedInImageRequest,
  LinkedInMultiImageRequest,
  LinkedInDocumentRequest,
  LinkedInVideoRequest,
]);
export type LinkedInRequest = z.infer<typeof LinkedInRequest>;

export const PublishRequest = z.discriminatedUnion("kind", [
  InstagramImageRequest,
  InstagramCarouselRequest,
  InstagramReelRequest,
  InstagramStoryRequest,
  FacebookPhotoRequest,
  FacebookMultiPhotoRequest,
  FacebookVideoRequest,
  FacebookReelRequest,
  FacebookStoryRequest,
  LinkedInTextRequest,
  LinkedInImageRequest,
  LinkedInMultiImageRequest,
  LinkedInDocumentRequest,
  LinkedInVideoRequest,
]);
export type PublishRequest = z.infer<typeof PublishRequest>;
export type PublishKind = PublishRequest["kind"];
export type PublishPlatform = "instagram" | "facebook" | "linkedin";

export function platformOf(kind: PublishKind): PublishPlatform {
  if (kind.startsWith("instagram.")) return "instagram";
  if (kind.startsWith("facebook.")) return "facebook";
  return "linkedin";
}

/** A non-fatal problem: something Meta dropped, or something we could not confirm. */
export interface PublishWarning {
  code: string;
  /** Turkish, user-presentable. */
  message: string;
}

export interface PublishResult {
  platform: PublishPlatform;
  kind: PublishKind;
  /**
   * Platform id of what was published: IG media id; FB photo/video id or
   * post id. `null` only when a crash-recovery reconciliation proved the
   * post exists but could not identify it.
   */
  externalId: string | null;
  /** Facebook post id (`{page-id}_{post-id}`) when the API returns one. */
  postId: string | null;
  permalink: string | null;
  /** ISO time the publish call succeeded (our clock). */
  publishedAt: string;
  warnings: PublishWarning[];
  /** True when the result was recovered after a crash instead of returned by the publish call. */
  reconciled: boolean;
  /** Instagram only: publishing quota as read right before publishing. */
  quota?: PublishingQuota;
}

/** From `GET /{ig-user-id}/content_publishing_limit`. */
export interface PublishingQuota {
  usage: number;
  total: number;
  durationSeconds: number;
  /** Epoch ms when it was read. */
  checkedAt: number;
}

/**
 * Supplies bytes for `{ type: "upload" }` video sources. Return the range
 * `[offset, offset + length)` (`length` omitted: to the end). A stream is
 * preferred for large files; it must have a known length if the runtime
 * requires one for request bodies (R2 object bodies do).
 */
export interface MediaReader {
  read(
    key: string,
    range: { offset: number; length?: number },
  ): Promise<ReadableStream<Uint8Array> | Uint8Array | ArrayBuffer | Blob>;
}
