/**
 * Platform limits used by pre-flight validation, with their sources.
 * Checked against the official docs on 2026-11-16 (Graph API v27.0).
 */

const MiB = 1024 * 1024;

/**
 * Instagram (Facebook Login). Sources:
 * - https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
 * - https://developers.facebook.com/docs/instagram-platform/content-publishing
 * - https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes
 */
export const INSTAGRAM_LIMITS = {
  caption: { maxChars: 2200, maxHashtags: 30, maxMentions: 20 },
  altText: { maxChars: 1000 },
  collaborators: { max: 3 },
  image: {
    mimeTypes: ["image/jpeg"],
    /** "8 MB" in the spec; error 2207004 says "8 MiB". */
    maxBytes: 8 * MiB,
    minAspect: 4 / 5,
    maxAspect: 1.91,
    /** Outside this range Meta rescales; we only warn. */
    minWidth: 320,
    maxWidth: 1440,
  },
  carousel: { minItems: 2, maxItems: 20 },
  reel: {
    mimeTypes: ["video/mp4", "video/quicktime"],
    maxBytes: 300 * MiB,
    minDurationMs: 3_000,
    maxDurationMs: 15 * 60_000,
    minFps: 23,
    maxFps: 60,
    maxColumns: 1920,
    minAspect: 0.01,
    maxAspect: 10,
    recommendedAspect: 9 / 16,
  },
  storyImage: { mimeTypes: ["image/jpeg"], maxBytes: 8 * MiB, recommendedAspect: 9 / 16 },
  storyVideo: {
    mimeTypes: ["video/mp4", "video/quicktime"],
    maxBytes: 100 * MiB,
    minDurationMs: 3_000,
    maxDurationMs: 60_000,
    minFps: 23,
    maxFps: 60,
    maxColumns: 1920,
    minAspect: 0.1,
    maxAspect: 10,
    recommendedAspect: 9 / 16,
  },
  cover: { mimeTypes: ["image/jpeg"], maxBytes: 8 * MiB },
} as const;

/**
 * Facebook Pages. Sources:
 * - https://developers.facebook.com/docs/graph-api/reference/page/photos
 * - https://developers.facebook.com/docs/video-api/guides/reels-publishing
 * - https://developers.facebook.com/docs/page-stories-api
 */
export const FACEBOOK_LIMITS = {
  photo: {
    mimeTypes: ["image/jpeg", "image/bmp", "image/png", "image/gif", "image/tiff"],
    maxBytes: 10 * MiB,
    /** Docs: keep PNGs under ~1 MB or they may look pixelated. */
    pngSoftMaxBytes: 1 * MiB,
  },
  multiPhoto: {
    minItems: 2,
    /** Not documented; above this we warn so a human double-checks. */
    softMaxItems: 10,
  },
  reel: {
    minDurationMs: 3_000,
    maxDurationMs: 90_000,
    minWidth: 540,
    minHeight: 960,
    minFps: 24,
    maxFps: 60,
    recommendedAspect: 9 / 16,
    /** Error docs: valid ratios span 16:9 to 9:16. */
    minAspect: 9 / 16,
    maxAspect: 16 / 9,
    /** Reels publishing guide: a Page publishes at most 30 API Reels in any 24-hour period. */
    maxPerDay: 30,
  },
  storyVideo: {
    minDurationMs: 3_000,
    maxDurationMs: 60_000,
    minWidth: 540,
    minHeight: 960,
    minFps: 24,
    maxFps: 60,
    recommendedAspect: 9 / 16,
  },
  video: {
    /** No hard limits are documented on /{page-id}/videos; warn on unusual containers. */
    recommendedMimeTypes: ["video/mp4", "video/quicktime"],
  },
} as const;

/**
 * LinkedIn REST Posts / Images / Documents / Videos API. Sources:
 * - https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
 * - https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api
 * - https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api
 * - https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
 */
export const LINKEDIN_LIMITS = {
  commentary: { maxChars: 3000 },
  title: { maxChars: 400 },
  altText: { maxChars: 4086 },
  image: {
    mimeTypes: ["image/jpeg", "image/png", "image/gif"],
    maxBytes: 36 * MiB,
  },
  multiImage: {
    minItems: 2,
    maxItems: 20,
  },
  document: {
    mimeTypes: ["application/pdf"],
    maxBytes: 100 * MiB,
  },
  video: {
    mimeTypes: ["video/mp4", "video/quicktime"],
    maxBytes: 200 * MiB,
    minDurationMs: 3_000,
    maxDurationMs: 30 * 60_000,
  },
} as const;
