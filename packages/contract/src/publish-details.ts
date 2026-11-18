import { z } from "zod";
import { EntityId } from "./common.ts";
import type { PublishKindName } from "./publishing.ts";

/**
 * Publish details of a post (N13): first comment, alternative texts, location, collaborators,
 * people tags, the Reels cover and "also in the feed". They live on the post (`Content`), apply to
 * every account it is published to as far as that platform allows (`PUBLISH_DETAIL_SUPPORT`) and
 * do not revoke the approval: like the publish time they are publishing metadata, frozen into a
 * cloud order when it is pushed (a change pushes the order again).
 *
 * Platform rules (Graph API v27, conservative):
 * - Instagram feed image / carousel: first comment, alt text per image (≤ 1,000 characters),
 *   location (a Facebook Page id with a location), up to 3 collaborators, people tags with an
 *   x / y position (0–1) per image (≤ 20 per image).
 * - Instagram Reels: first comment, location, collaborators, people tags without positions, a
 *   cover (a frame of the video, or a JPEG), share to feed (default on). No alt text.
 * - Instagram / Facebook stories: none of these.
 * - Facebook photos: first comment (≤ 8,000 characters) and alt text; videos and Reels: first
 *   comment only. Facebook's own location and people tagging need user ids: not offered.
 * - LinkedIn images: alt text only (no first comment, location or tags).
 */

/** Instagram usernames: letters, numbers, dots and underscores, at most 30 (without `@`). */
export const IG_USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;

export const PUBLISH_DETAIL_LIMITS = {
  firstComment: { instagram: 2200, facebook: 8000 },
  firstCommentHashtags: 30,
  altText: 1000,
  collaborators: 3,
  userTagsPerSlide: 20,
  slides: 20,
} as const;

export const IgUsername = z.string().regex(IG_USERNAME_RE, "geçersiz Instagram kullanıcı adı");

/** A person tagged on a slide (`slide` = 0-based position). Reels ignore the position. */
export const PublishUserTag = z
  .object({
    slide: z
      .number()
      .int()
      .min(0)
      .max(PUBLISH_DETAIL_LIMITS.slides - 1),
    username: IgUsername,
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
  })
  .meta({ id: "PublishUserTag" });
export type PublishUserTag = z.infer<typeof PublishUserTag>;

/** The Reels cover: a frame of the video (`offsetMs`) or a picture of the brand (JPEG on send). */
export const ReelCover = z
  .discriminatedUnion("kind", [
    z.object({
      kind: z.literal("frame"),
      offsetMs: z
        .number()
        .int()
        .min(0)
        .max(15 * 60_000),
    }),
    z.object({ kind: z.literal("image"), assetId: EntityId }),
  ])
  .meta({ id: "ReelCover" });
export type ReelCover = z.infer<typeof ReelCover>;

/**
 * A location: the id of a Facebook Page that has an address (what Instagram's `location_id`
 * takes) and its name. Searching every place needs Meta's "Page Public Metadata Access"; Studio
 * offers the brand's own Pages with an address and the locations used or entered before.
 */
export const PublishLocation = z
  .object({
    id: z.string().regex(/^\d{1,30}$/, "konum bir Facebook sayfa kimliği olmalı (yalnızca rakam)"),
    name: z.string().trim().min(1).max(200),
  })
  .meta({ id: "PublishLocation" });
export type PublishLocation = z.infer<typeof PublishLocation>;

/** A known location of a brand: its own Page with an address, entered, or used before. */
export const KnownLocation = PublishLocation.extend({
  source: z.enum(["page", "manual", "used"]),
  lastUsedAt: z.iso.datetime().nullable(),
}).meta({ id: "KnownLocation" });
export type KnownLocation = z.infer<typeof KnownLocation>;

export const KnownLocationList = z
  .object({ items: z.array(KnownLocation) })
  .meta({ id: "KnownLocationList" });
export type KnownLocationList = z.infer<typeof KnownLocationList>;

/** Body of `POST /api/brands/{id}/publish-locations` (a location entered by hand). */
export const KnownLocationCreate = PublishLocation.meta({ id: "KnownLocationCreate" });
export type KnownLocationCreate = z.input<typeof KnownLocationCreate>;

export const AltTextSource = z.enum(["auto", "manual"]).meta({ id: "AltTextSource" });
export type AltTextSource = z.infer<typeof AltTextSource>;

export const PublishDetails = z
  .object({
    firstComment: z.string().max(PUBLISH_DETAIL_LIMITS.firstComment.facebook).nullable().optional(),
    /** One entry per slide (index = position); null or missing: none. */
    altTexts: z
      .array(z.string().max(PUBLISH_DETAIL_LIMITS.altText).nullable())
      .max(PUBLISH_DETAIL_LIMITS.slides)
      .optional(),
    /** Who wrote each alt text: filled automatically from the slide, or edited by the owner. */
    altTextSources: z.array(AltTextSource.nullable()).max(PUBLISH_DETAIL_LIMITS.slides).optional(),
    location: PublishLocation.nullable().optional(),
    collaborators: z.array(IgUsername).max(PUBLISH_DETAIL_LIMITS.collaborators).optional(),
    userTags: z
      .array(PublishUserTag)
      .max(PUBLISH_DETAIL_LIMITS.slides * PUBLISH_DETAIL_LIMITS.userTagsPerSlide)
      .optional(),
    reelCover: ReelCover.nullable().optional(),
    /** Instagram Reels: also show it in the feed (default true). */
    shareToFeed: z.boolean().optional(),
  })
  .meta({ id: "PublishDetails" });
export type PublishDetails = z.infer<typeof PublishDetails>;

/** Body of `PUT /api/contents/{id}/publish-details` (replaces them; `{}` clears them). */
export const PublishDetailsPut = PublishDetails.meta({ id: "PublishDetailsPut" });
export type PublishDetailsPut = z.input<typeof PublishDetailsPut>;

export const PUBLISH_DETAIL_FIELDS = [
  "firstComment",
  "altText",
  "location",
  "collaborators",
  "userTags",
  "reelCover",
  "shareToFeed",
] as const;
export type PublishDetailField = (typeof PUBLISH_DETAIL_FIELDS)[number];

export const PUBLISH_DETAIL_LABEL: Record<PublishDetailField, string> = {
  firstComment: "İlk yorum",
  altText: "Alternatif metin",
  location: "Konum",
  collaborators: "Ortak paylaşım",
  userTags: "Kişi etiketleri",
  reelCover: "Reels kapağı",
  shareToFeed: "Akışta da göster",
};

/** Which details each publish flow sends (everything else is left out for that account). */
export const PUBLISH_DETAIL_SUPPORT: Record<PublishKindName, readonly PublishDetailField[]> = {
  "instagram.image": ["firstComment", "altText", "location", "collaborators", "userTags"],
  "instagram.carousel": ["firstComment", "altText", "location", "collaborators", "userTags"],
  "instagram.reel": [
    "firstComment",
    "location",
    "collaborators",
    "userTags",
    "reelCover",
    "shareToFeed",
  ],
  "instagram.story": [],
  "facebook.photo": ["firstComment", "altText"],
  "facebook.multi_photo": ["firstComment", "altText"],
  "facebook.video": ["firstComment"],
  "facebook.reel": ["firstComment"],
  "facebook.story": [],
  "linkedin.text": [],
  "linkedin.image": ["altText"],
  "linkedin.multi_image": ["altText"],
  "linkedin.document": [],
  "linkedin.video": [],
};

export function supportsDetail(kind: PublishKindName, field: PublishDetailField): boolean {
  return PUBLISH_DETAIL_SUPPORT[kind].includes(field);
}

/** The details that hold something. */
export function detailFieldsSet(details: PublishDetails | null | undefined): PublishDetailField[] {
  if (!details) return [];
  const out: PublishDetailField[] = [];
  if (details.firstComment?.trim()) out.push("firstComment");
  if (details.altTexts?.some((t) => t?.trim())) out.push("altText");
  if (details.location) out.push("location");
  if (details.collaborators?.length) out.push("collaborators");
  if (details.userTags?.length) out.push("userTags");
  if (details.reelCover) out.push("reelCover");
  if (details.shareToFeed === false) out.push("shareToFeed");
  return out;
}

const HASHTAG_RE = /(^|[^\p{L}\p{N}_&#])#[\p{L}\p{N}_]+/gu;
const chars = (s: string) => [...s].length;

export interface PublishDetailIssue {
  code: string;
  path: string;
  /** Turkish, user-presentable. */
  message: string;
}

/**
 * Problems of the details for one publish flow: errors block scheduling on that account (a
 * limit Meta would refuse), warnings say what is left out there (unsupported on the platform).
 */
export function publishDetailIssues(
  details: PublishDetails | null | undefined,
  kind: PublishKindName,
  slideCount: number,
  opts: { videoDurationMs?: number | null } = {},
): { errors: PublishDetailIssue[]; warnings: PublishDetailIssue[] } {
  const errors: PublishDetailIssue[] = [];
  const warnings: PublishDetailIssue[] = [];
  if (!details) return { errors, warnings };
  const platform = kind.split(".")[0] as "instagram" | "facebook" | "linkedin";
  const platformName =
    platform === "instagram" ? "Instagram" : platform === "facebook" ? "Facebook" : "LinkedIn";
  const ignored = detailFieldsSet(details).filter((f) => !supportsDetail(kind, f));
  if (ignored.length) {
    warnings.push({
      code: "DETAILS_NOT_SUPPORTED",
      path: "publishDetails",
      message: `${ignored.map((f) => PUBLISH_DETAIL_LABEL[f]).join(", ")} bu ${platformName} paylaşımında desteklenmiyor; bu hesaba gönderilmeyecek.`,
    });
  }
  const comment = details.firstComment?.trim();
  if (comment && supportsDetail(kind, "firstComment")) {
    const max =
      platform === "instagram"
        ? PUBLISH_DETAIL_LIMITS.firstComment.instagram
        : PUBLISH_DETAIL_LIMITS.firstComment.facebook;
    if (chars(comment) > max)
      errors.push({
        code: "FIRST_COMMENT_TOO_LONG",
        path: "publishDetails.firstComment",
        message: `${platformName} ilk yorumu en fazla ${max.toLocaleString("tr-TR")} karakter olabilir (şu an ${chars(comment).toLocaleString("tr-TR")}).`,
      });
    if (platform === "instagram") {
      const tags = [...comment.matchAll(HASHTAG_RE)].length;
      if (tags > PUBLISH_DETAIL_LIMITS.firstCommentHashtags)
        errors.push({
          code: "TOO_MANY_HASHTAGS",
          path: "publishDetails.firstComment",
          message: `İlk yorumda en fazla ${PUBLISH_DETAIL_LIMITS.firstCommentHashtags} hashtag olabilir (şu an ${tags}).`,
        });
    }
  }
  if (supportsDetail(kind, "userTags") && details.userTags?.length) {
    const reel = kind === "instagram.reel";
    const perSlide = new Map<number, number>();
    for (const t of details.userTags) {
      const slide = reel ? 0 : t.slide;
      perSlide.set(slide, (perSlide.get(slide) ?? 0) + 1);
      if (!reel && t.slide >= slideCount)
        warnings.push({
          code: "USER_TAG_SLIDE_MISSING",
          path: "publishDetails.userTags",
          message: `${t.slide + 1}. karede etiket var ama postta ${slideCount} kare var; bu etiket gönderilmeyecek.`,
        });
    }
    for (const [slide, n] of perSlide)
      if (n > PUBLISH_DETAIL_LIMITS.userTagsPerSlide)
        errors.push({
          code: "TOO_MANY_USER_TAGS",
          path: "publishDetails.userTags",
          message: `${reel ? "Reels'te" : `${slide + 1}. karede`} en fazla ${PUBLISH_DETAIL_LIMITS.userTagsPerSlide} kişi etiketlenebilir (şu an ${n}).`,
        });
  }
  const cover = details.reelCover;
  if (
    cover?.kind === "frame" &&
    supportsDetail(kind, "reelCover") &&
    typeof opts.videoDurationMs === "number" &&
    cover.offsetMs >= opts.videoDurationMs
  )
    errors.push({
      code: "THUMB_OFFSET_OUT_OF_RANGE",
      path: "publishDetails.reelCover",
      message: "Kapak karesi videonun süresi içinde olmalı.",
    });
  return { errors, warnings };
}

/** The details one publish flow sends, already filtered to what the platform supports. */
export interface ResolvedPublishDetails {
  firstComment?: string;
  /** Per slide (index), only non-empty. */
  altTexts: (string | undefined)[];
  locationId?: string;
  collaborators?: string[];
  /** Per slide (index); Reels use slide 0 and no positions. */
  userTags: { username: string; x: number; y: number }[][];
  reelCover?: ReelCover;
  /** Instagram Reels only (defaults to true there). */
  shareToFeed?: boolean;
}

export function resolvePublishDetails(
  details: PublishDetails | null | undefined,
  kind: PublishKindName,
  slideCount: number,
): ResolvedPublishDetails {
  const out: ResolvedPublishDetails = { altTexts: [], userTags: [] };
  if (kind === "instagram.reel") out.shareToFeed = details?.shareToFeed ?? true;
  if (!details) return out;
  const has = (f: PublishDetailField) => supportsDetail(kind, f);
  const comment = details.firstComment?.trim();
  if (comment && has("firstComment")) out.firstComment = comment;
  if (has("altText"))
    out.altTexts = Array.from({ length: slideCount }, (_, i) => {
      const text = details.altTexts?.[i]?.trim();
      return text ? text : undefined;
    });
  if (details.location && has("location")) out.locationId = details.location.id;
  if (details.collaborators?.length && has("collaborators"))
    out.collaborators = [...new Set(details.collaborators)];
  if (details.userTags?.length && has("userTags")) {
    const reel = kind === "instagram.reel";
    const slides = reel ? 1 : slideCount;
    out.userTags = Array.from({ length: slides }, () => []);
    for (const t of details.userTags) {
      const i = reel ? 0 : t.slide;
      const list = out.userTags[i];
      if (!list || list.some((x) => x.username === t.username)) continue;
      if (list.length < PUBLISH_DETAIL_LIMITS.userTagsPerSlide)
        list.push({ username: t.username, x: t.x, y: t.y });
    }
  }
  if (details.reelCover && has("reelCover")) out.reelCover = details.reelCover;
  return out;
}

/**
 * An alt text from a slide's text (the canvas facts): its visible words in reading order, short.
 * The desktop fills empty alt texts with it; the owner edits.
 */
export function altTextFromSlideText(text: string, opts: { brand?: string } = {}): string | null {
  const clean = text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return null;
  const words = clean.length > 300 ? `${clean.slice(0, 297).replace(/\s+\S*$/, "")}…` : clean;
  const prefix = opts.brand ? `${opts.brand} paylaşımı: ` : "Görselde yazan: ";
  return `${prefix}${words}`.slice(0, PUBLISH_DETAIL_LIMITS.altText);
}
