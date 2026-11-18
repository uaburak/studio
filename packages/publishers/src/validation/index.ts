/**
 * Pre-flight validation. Each issue has a stable machine `code`, a Turkish
 * user-presentable `message`, a dotted `path` into the request and a
 * severity. Errors block publishing; warnings are shown but do not block
 * (e.g. metadata missing, Meta will rescale, aspect not the recommended one).
 */

import {
  type AnyMedia,
  type DocumentMedia,
  type FacebookRequest,
  type ImageMedia,
  type InstagramRequest,
  type LinkedInRequest,
  PublishRequest,
  type VideoMedia,
} from "../models.ts";
import { FACEBOOK_LIMITS, INSTAGRAM_LIMITS, LINKEDIN_LIMITS } from "./rules.ts";

export type ValidationCode =
  | "SCHEMA_INVALID"
  | "CAPTION_TOO_LONG"
  | "COMMENTARY_EMPTY"
  | "TITLE_TOO_LONG"
  | "TOO_MANY_HASHTAGS"
  | "TOO_MANY_MENTIONS"
  | "ALT_TEXT_TOO_LONG"
  | "ALT_TEXT_NOT_SUPPORTED"
  | "TOO_MANY_COLLABORATORS"
  | "USER_TAG_POSITION_REQUIRED"
  | "TOO_MANY_USER_TAGS"
  | "USERNAME_INVALID"
  | "FIRST_COMMENT_TOO_LONG"
  | "IMAGE_FORMAT_UNSUPPORTED"
  | "IMAGE_TOO_LARGE"
  | "IMAGE_PNG_LARGE"
  | "DOCUMENT_FORMAT_UNSUPPORTED"
  | "DOCUMENT_TOO_LARGE"
  | "ASPECT_RATIO_OUT_OF_RANGE"
  | "ASPECT_RATIO_NOT_RECOMMENDED"
  | "IMAGE_WILL_BE_RESCALED"
  | "CAROUSEL_TOO_FEW_ITEMS"
  | "CAROUSEL_TOO_MANY_ITEMS"
  | "CAROUSEL_ASPECT_MISMATCH"
  | "MULTI_PHOTO_TOO_FEW"
  | "MULTI_PHOTO_MANY"
  | "VIDEO_FORMAT_UNSUPPORTED"
  | "VIDEO_FORMAT_NOT_RECOMMENDED"
  | "VIDEO_TOO_LARGE"
  | "VIDEO_TOO_SHORT"
  | "VIDEO_TOO_LONG"
  | "FRAME_RATE_OUT_OF_RANGE"
  | "VIDEO_TOO_WIDE"
  | "RESOLUTION_TOO_LOW"
  | "THUMB_OFFSET_OUT_OF_RANGE"
  | "COVER_OVERRIDES_THUMB_OFFSET"
  | "COVER_FORMAT_UNSUPPORTED"
  | "METADATA_MISSING";

export interface ValidationIssue {
  code: ValidationCode;
  severity: "error" | "warning";
  /** Dotted path into the request, e.g. `items.2.width`. */
  path: string;
  /** Turkish, user-presentable. */
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

// --- helpers ---------------------------------------------------------------------

/** Turkish thousands separator: 2200 -> "2.200". */
const n = (v: number) => String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const mb = (bytes: number) => `${n(bytes / (1024 * 1024))} MB`;
const sec = (ms: number) => {
  const s = ms / 1000;
  return s >= 60 && s % 60 === 0 ? `${s / 60} dk` : `${Math.round(s * 10) / 10} sn`;
};
const ratio = (r: number) => (Math.round(r * 100) / 100).toString().replace(".", ",");

/** Unicode code points, which is how a person counts characters (emoji = 1). */
export function charCount(text: string): number {
  return [...text].length;
}

const HASHTAG_RE = /(^|[^\p{L}\p{N}_&#])#[\p{L}\p{N}_]+/gu;
const MENTION_RE = /(^|[^\p{L}\p{N}_.@])@[A-Za-z0-9._]+/gu;

export function countHashtags(text: string): number {
  return [...text.matchAll(HASHTAG_RE)].length;
}

export function countMentions(text: string): number {
  return [...text.matchAll(MENTION_RE)].length;
}

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  heic: "image/heic",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  pdf: "application/pdf",
};

/** Mime type from metadata, else from the URL extension, else undefined. */
export function guessMime(media: AnyMedia | DocumentMedia): string | undefined {
  if (media.mimeType) return media.mimeType.split(";")[0]?.trim().toLowerCase();
  const url =
    media.kind === "image"
      ? media.url
      : media.kind === "document"
        ? (media.url ?? (media.source?.type === "url" ? media.source.url : null))
        : media.source.type === "url"
          ? media.source.url
          : null;
  if (!url) return undefined;
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
    return EXT_MIME[ext];
  } catch {
    return undefined;
  }
}

const EPS = 0.005;

class Collector {
  readonly errors: ValidationIssue[] = [];
  readonly warnings: ValidationIssue[] = [];
  error(code: ValidationCode, path: string, message: string) {
    this.errors.push({ code, severity: "error", path, message });
  }
  warn(code: ValidationCode, path: string, message: string) {
    this.warnings.push({ code, severity: "warning", path, message });
  }
  report(): ValidationReport {
    return { ok: this.errors.length === 0, errors: this.errors, warnings: this.warnings };
  }
}

const join = (base: string, key: string | number) => (base ? `${base}.${key}` : String(key));

// --- shared checks -------------------------------------------------------------------

function checkIgCaption(c: Collector, path: string, caption: string | undefined) {
  if (!caption) return;
  const L = INSTAGRAM_LIMITS.caption;
  const chars = charCount(caption);
  if (chars > L.maxChars)
    c.error(
      "CAPTION_TOO_LONG",
      path,
      `Açıklama en fazla ${n(L.maxChars)} karakter olabilir (şu an ${n(chars)}).`,
    );
  const tags = countHashtags(caption);
  if (tags > L.maxHashtags)
    c.error(
      "TOO_MANY_HASHTAGS",
      path,
      `En fazla ${L.maxHashtags} hashtag kullanılabilir (şu an ${tags}).`,
    );
  const mentions = countMentions(caption);
  if (mentions > L.maxMentions)
    c.error(
      "TOO_MANY_MENTIONS",
      path,
      `En fazla ${L.maxMentions} @ etiketi kullanılabilir (şu an ${mentions}).`,
    );
}

function checkCollaborators(c: Collector, path: string, list: string[] | undefined) {
  if (list && list.length > INSTAGRAM_LIMITS.collaborators.max)
    c.error(
      "TOO_MANY_COLLABORATORS",
      path,
      `En fazla ${INSTAGRAM_LIMITS.collaborators.max} ortak hesap eklenebilir (şu an ${list.length}).`,
    );
  list?.forEach((name, i) => {
    if (!INSTAGRAM_LIMITS.username.test(name))
      c.error("USERNAME_INVALID", join(path, i), `Geçersiz Instagram kullanıcı adı: ${name}`);
  });
}

/** The first comment on Instagram: the caption's limits. */
function checkIgComment(c: Collector, path: string, text: string | undefined) {
  if (!text) return;
  const L = INSTAGRAM_LIMITS.comment;
  const chars = charCount(text);
  if (chars > L.maxChars)
    c.error(
      "FIRST_COMMENT_TOO_LONG",
      path,
      `İlk yorum en fazla ${n(L.maxChars)} karakter olabilir (şu an ${n(chars)}).`,
    );
  const tags = countHashtags(text);
  if (tags > L.maxHashtags)
    c.error(
      "TOO_MANY_HASHTAGS",
      path,
      `İlk yorumda en fazla ${L.maxHashtags} hashtag kullanılabilir (şu an ${tags}).`,
    );
  const mentions = countMentions(text);
  if (mentions > L.maxMentions)
    c.error(
      "TOO_MANY_MENTIONS",
      path,
      `İlk yorumda en fazla ${L.maxMentions} @ etiketi kullanılabilir (şu an ${mentions}).`,
    );
}

function checkFbComment(c: Collector, path: string, text: string | undefined) {
  if (!text) return;
  const chars = charCount(text);
  if (chars > FACEBOOK_LIMITS.comment.maxChars)
    c.error(
      "FIRST_COMMENT_TOO_LONG",
      path,
      `İlk yorum en fazla ${n(FACEBOOK_LIMITS.comment.maxChars)} karakter olabilir (şu an ${n(chars)}).`,
    );
}

/** User tags of one picture: count, usernames and (for pictures) the x / y position. */
function checkUserTags(
  c: Collector,
  path: string,
  tags: { username: string; x?: number | undefined; y?: number | undefined }[] | undefined,
  opts: { positions: boolean },
) {
  if (!tags) return;
  if (tags.length > INSTAGRAM_LIMITS.userTags.maxPerMedia)
    c.error(
      "TOO_MANY_USER_TAGS",
      path,
      `Bir görselde en fazla ${INSTAGRAM_LIMITS.userTags.maxPerMedia} kişi etiketlenebilir (şu an ${tags.length}).`,
    );
  tags.forEach((t, i) => {
    if (!INSTAGRAM_LIMITS.username.test(t.username))
      c.error("USERNAME_INVALID", join(path, i), `Geçersiz Instagram kullanıcı adı: ${t.username}`);
    if (opts.positions && (t.x === undefined || t.y === undefined))
      c.error(
        "USER_TAG_POSITION_REQUIRED",
        join(path, i),
        "Görselde kişi etiketi için x ve y konumu gerekli.",
      );
  });
}

/** One warning listing every metadata field we could not check. `mimeType` counts as known if the URL extension tells. */
function checkMissing(
  c: Collector,
  path: string,
  media: AnyMedia | DocumentMedia,
  fields: string[],
) {
  const record = media as Record<string, unknown>;
  const missing = fields.filter((f) =>
    f === "mimeType" ? guessMime(media) === undefined : record[f] === undefined,
  );
  if (missing.length)
    c.warn(
      "METADATA_MISSING",
      path,
      `Medya bilgisi eksik (${missing.join(", ")}); bu kurallar yayından önce denetlenemedi.`,
    );
}

function aspectOf(m: {
  width?: number | undefined;
  height?: number | undefined;
}): number | undefined {
  return m.width && m.height ? m.width / m.height : undefined;
}

function checkIgImage(c: Collector, path: string, img: ImageMedia, opts: { feed: boolean }) {
  const L = opts.feed ? INSTAGRAM_LIMITS.image : INSTAGRAM_LIMITS.storyImage;
  const mime = guessMime(img);
  if (mime !== undefined && !(L.mimeTypes as readonly string[]).includes(mime))
    c.error(
      "IMAGE_FORMAT_UNSUPPORTED",
      join(path, "mimeType"),
      "Instagram yalnızca JPEG görsel kabul ediyor.",
    );
  if (img.bytes !== undefined && img.bytes > L.maxBytes)
    c.error(
      "IMAGE_TOO_LARGE",
      join(path, "bytes"),
      `Görsel en fazla ${mb(L.maxBytes)} olabilir (şu an ${mb(img.bytes)}).`,
    );
  checkMissing(c, path, img, ["mimeType", "width", "height", "bytes"]);
  const a = aspectOf(img);
  if (opts.feed) {
    const F = INSTAGRAM_LIMITS.image;
    if (a !== undefined && (a < F.minAspect - EPS || a > F.maxAspect + EPS))
      c.error(
        "ASPECT_RATIO_OUT_OF_RANGE",
        path,
        `Görselin en-boy oranı 4:5 (0,8) ile 1,91:1 arasında olmalı (şu an ${ratio(a)}).`,
      );
    if (img.width !== undefined && (img.width < F.minWidth || img.width > F.maxWidth))
      c.warn(
        "IMAGE_WILL_BE_RESCALED",
        join(path, "width"),
        `Genişlik ${n(F.minWidth)}–${n(F.maxWidth)} piksel dışında; Instagram görseli yeniden boyutlandıracak.`,
      );
    if (img.altText !== undefined && charCount(img.altText) > INSTAGRAM_LIMITS.altText.maxChars)
      c.error(
        "ALT_TEXT_TOO_LONG",
        join(path, "altText"),
        `Alternatif metin en fazla ${n(INSTAGRAM_LIMITS.altText.maxChars)} karakter olabilir.`,
      );
  } else {
    if (a !== undefined && Math.abs(a - 9 / 16) > 0.02)
      c.warn(
        "ASPECT_RATIO_NOT_RECOMMENDED",
        path,
        "Story için önerilen oran 9:16; görsel kırpılabilir.",
      );
    if (img.altText)
      c.error(
        "ALT_TEXT_NOT_SUPPORTED",
        join(path, "altText"),
        "Instagram Story'de alternatif metin desteklenmiyor.",
      );
  }
}

interface VideoLimits {
  mimeTypes?: readonly string[];
  maxBytes?: number;
  minDurationMs: number;
  maxDurationMs: number;
  minFps: number;
  maxFps: number;
  maxColumns?: number;
  minWidth?: number;
  minHeight?: number;
  minAspect?: number;
  maxAspect?: number;
  recommendedAspect?: number;
  /** Warn when metadata needed by these limits is missing (default true). */
  reportMissing?: boolean;
}

function checkVideo(c: Collector, path: string, v: VideoMedia, L: VideoLimits, platform: string) {
  const mime = guessMime(v);
  if (L.mimeTypes) {
    if (mime !== undefined && !L.mimeTypes.includes(mime))
      c.error(
        "VIDEO_FORMAT_UNSUPPORTED",
        join(path, "mimeType"),
        `${platform} yalnızca MP4 ya da MOV video kabul ediyor.`,
      );
  } else if (mime !== undefined && mime !== "video/mp4") {
    c.warn(
      "VIDEO_FORMAT_NOT_RECOMMENDED",
      join(path, "mimeType"),
      `${platform} için MP4 öneriliyor.`,
    );
  }
  if (L.reportMissing !== false)
    checkMissing(c, path, v, [
      ...(L.mimeTypes ? ["mimeType"] : []),
      "durationMs",
      "width",
      "height",
      "frameRate",
      ...(L.maxBytes ? ["bytes"] : []),
    ]);
  if (L.maxBytes !== undefined && v.bytes !== undefined && v.bytes > L.maxBytes)
    c.error(
      "VIDEO_TOO_LARGE",
      join(path, "bytes"),
      `Video en fazla ${mb(L.maxBytes)} olabilir (şu an ${mb(v.bytes)}).`,
    );
  if (v.durationMs !== undefined) {
    if (v.durationMs < L.minDurationMs)
      c.error(
        "VIDEO_TOO_SHORT",
        join(path, "durationMs"),
        `Video en az ${sec(L.minDurationMs)} olmalı (şu an ${sec(v.durationMs)}).`,
      );
    if (v.durationMs > L.maxDurationMs)
      c.error(
        "VIDEO_TOO_LONG",
        join(path, "durationMs"),
        `Video en fazla ${sec(L.maxDurationMs)} olabilir (şu an ${sec(v.durationMs)}).`,
      );
  }
  if (v.frameRate !== undefined && (v.frameRate < L.minFps || v.frameRate > L.maxFps))
    c.error(
      "FRAME_RATE_OUT_OF_RANGE",
      join(path, "frameRate"),
      `Kare hızı ${L.minFps}–${L.maxFps} fps arasında olmalı (şu an ${v.frameRate}).`,
    );
  if (L.maxColumns !== undefined && v.width !== undefined && v.width > L.maxColumns)
    c.error(
      "VIDEO_TOO_WIDE",
      join(path, "width"),
      `Video genişliği en fazla ${n(L.maxColumns)} piksel olabilir (şu an ${n(v.width)}).`,
    );
  if (
    L.minWidth !== undefined &&
    L.minHeight !== undefined &&
    v.width !== undefined &&
    v.height !== undefined &&
    Math.min(v.width, v.height) < Math.min(L.minWidth, L.minHeight)
  )
    c.error(
      "RESOLUTION_TOO_LOW",
      path,
      `Çözünürlük en az ${L.minWidth}x${L.minHeight} olmalı (şu an ${v.width}x${v.height}).`,
    );
  const a = aspectOf(v);
  if (a !== undefined) {
    if (
      (L.minAspect !== undefined && a < L.minAspect - EPS) ||
      (L.maxAspect !== undefined && a > L.maxAspect + EPS)
    )
      c.error(
        "ASPECT_RATIO_OUT_OF_RANGE",
        path,
        `Videonun en-boy oranı desteklenmiyor (şu an ${ratio(a)}).`,
      );
    else if (L.recommendedAspect !== undefined && Math.abs(a - L.recommendedAspect) > 0.02)
      c.warn(
        "ASPECT_RATIO_NOT_RECOMMENDED",
        path,
        "Önerilen oran 9:16; video kırpılabilir ya da kenar boşluklu görünebilir.",
      );
  }
}

// --- per request ---------------------------------------------------------------------

function validateInstagram(c: Collector, r: InstagramRequest) {
  switch (r.kind) {
    case "instagram.image":
      checkIgImage(c, "image", r.image, { feed: true });
      checkIgCaption(c, "caption", r.caption);
      checkCollaborators(c, "collaborators", r.collaborators);
      checkUserTags(c, "userTags", r.userTags, { positions: true });
      checkIgComment(c, "firstComment", r.firstComment);
      return;
    case "instagram.carousel": {
      const L = INSTAGRAM_LIMITS.carousel;
      if (r.items.length < L.minItems)
        c.error(
          "CAROUSEL_TOO_FEW_ITEMS",
          "items",
          `Carousel en az ${L.minItems} öğe içermeli (şu an ${r.items.length}).`,
        );
      if (r.items.length > L.maxItems)
        c.error(
          "CAROUSEL_TOO_MANY_ITEMS",
          "items",
          `Carousel en fazla ${L.maxItems} öğe içerebilir (şu an ${r.items.length}).`,
        );
      const first = r.items[0] ? aspectOf(r.items[0]) : undefined;
      r.items.forEach((item, i) => {
        const p = `items.${i}`;
        if (item.kind === "image") {
          checkIgImage(c, p, item, { feed: true });
          checkUserTags(c, join(p, "userTags"), item.userTags, { positions: true });
        } else checkVideo(c, p, item, INSTAGRAM_LIMITS.reel, "Instagram");
        const a = aspectOf(item);
        if (i > 0 && first !== undefined && a !== undefined && Math.abs(a - first) > 0.01)
          c.warn(
            "CAROUSEL_ASPECT_MISMATCH",
            p,
            "Carousel öğeleri ilk öğenin oranına kırpılır; oranlar farklı.",
          );
      });
      checkIgCaption(c, "caption", r.caption);
      checkCollaborators(c, "collaborators", r.collaborators);
      checkIgComment(c, "firstComment", r.firstComment);
      return;
    }
    case "instagram.reel": {
      checkVideo(c, "video", r.video, INSTAGRAM_LIMITS.reel, "Instagram");
      checkIgCaption(c, "caption", r.caption);
      checkCollaborators(c, "collaborators", r.collaborators);
      checkUserTags(c, "userTags", r.userTags, { positions: false });
      checkIgComment(c, "firstComment", r.firstComment);
      if (r.coverUrl && r.thumbOffsetMs !== undefined)
        c.warn(
          "COVER_OVERRIDES_THUMB_OFFSET",
          "thumbOffsetMs",
          "Kapak görseli verildiği için kapak karesi (thumb offset) yok sayılacak.",
        );
      if (r.coverUrl) {
        const ext = new URL(r.coverUrl).pathname.split(".").pop()?.toLowerCase();
        if (ext && EXT_MIME[ext] && EXT_MIME[ext] !== "image/jpeg")
          c.error("COVER_FORMAT_UNSUPPORTED", "coverUrl", "Reels kapak görseli JPEG olmalı.");
      }
      if (
        r.thumbOffsetMs !== undefined &&
        r.video.durationMs !== undefined &&
        r.thumbOffsetMs >= r.video.durationMs
      )
        c.error(
          "THUMB_OFFSET_OUT_OF_RANGE",
          "thumbOffsetMs",
          "Kapak karesi video süresinin içinde olmalı.",
        );
      return;
    }
    case "instagram.story":
      if (r.media.kind === "image") checkIgImage(c, "media", r.media, { feed: false });
      else checkVideo(c, "media", r.media, INSTAGRAM_LIMITS.storyVideo, "Instagram");
      r.userTags?.forEach((t, i) => {
        if (r.media.kind === "image" && (t.x === undefined) !== (t.y === undefined))
          c.error(
            "USER_TAG_POSITION_REQUIRED",
            `userTags.${i}`,
            "Kişi etiketinde x ve y birlikte verilmeli.",
          );
      });
      return;
  }
}

function checkFbPhoto(c: Collector, path: string, img: ImageMedia) {
  const L = FACEBOOK_LIMITS.photo;
  const mime = guessMime(img);
  if (mime !== undefined && !(L.mimeTypes as readonly string[]).includes(mime))
    c.error(
      "IMAGE_FORMAT_UNSUPPORTED",
      join(path, "mimeType"),
      "Facebook yalnızca JPEG, PNG, GIF, BMP ve TIFF görsel kabul ediyor.",
    );
  checkMissing(c, path, img, ["mimeType", "bytes"]);
  if (img.bytes === undefined) return;
  if (img.bytes > L.maxBytes)
    c.error(
      "IMAGE_TOO_LARGE",
      join(path, "bytes"),
      `Görsel en fazla ${mb(L.maxBytes)} olabilir (şu an ${mb(img.bytes)}).`,
    );
  else if (mime === "image/png" && img.bytes > L.pngSoftMaxBytes)
    c.warn(
      "IMAGE_PNG_LARGE",
      join(path, "bytes"),
      "1 MB'tan büyük PNG'ler Facebook'ta pikselli görünebilir; JPEG önerilir.",
    );
}

function validateFacebook(c: Collector, r: FacebookRequest) {
  switch (r.kind) {
    case "facebook.photo":
      checkFbPhoto(c, "image", r.image);
      checkFbComment(c, "firstComment", r.firstComment);
      return;
    case "facebook.multi_photo": {
      const L = FACEBOOK_LIMITS.multiPhoto;
      if (r.images.length < L.minItems)
        c.error(
          "MULTI_PHOTO_TOO_FEW",
          "images",
          `Çoklu fotoğraf için en az ${L.minItems} görsel gerekli (şu an ${r.images.length}).`,
        );
      if (r.images.length > L.softMaxItems)
        c.warn(
          "MULTI_PHOTO_MANY",
          "images",
          `${L.softMaxItems}'dan fazla görsel var; Facebook'un üst sınırı belgelenmemiş.`,
        );
      r.images.forEach((img, i) => {
        checkFbPhoto(c, `images.${i}`, img);
      });
      checkFbComment(c, "firstComment", r.firstComment);
      return;
    }
    case "facebook.video":
      // No hard limits are documented for plain Page videos; only the format hint applies.
      checkVideo(
        c,
        "video",
        r.video,
        {
          minDurationMs: 0,
          maxDurationMs: Number.POSITIVE_INFINITY,
          minFps: 0,
          maxFps: Number.POSITIVE_INFINITY,
          reportMissing: false,
        },
        "Facebook",
      );
      checkFbComment(c, "firstComment", r.firstComment);
      return;
    case "facebook.reel":
      checkVideo(c, "video", r.video, FACEBOOK_LIMITS.reel, "Facebook");
      checkFbComment(c, "firstComment", r.firstComment);
      return;
    case "facebook.story":
      if (r.media.kind === "image") checkFbPhoto(c, "media", r.media);
      else checkVideo(c, "media", r.media, FACEBOOK_LIMITS.storyVideo, "Facebook");
      return;
  }
}

function checkLiCommentary(c: Collector, path: string, commentary: string | undefined) {
  if (!commentary) return;
  const chars = charCount(commentary);
  if (chars > LINKEDIN_LIMITS.commentary.maxChars) {
    c.error(
      "CAPTION_TOO_LONG",
      path,
      `Açıklama en fazla ${n(LINKEDIN_LIMITS.commentary.maxChars)} karakter olabilir (şu an ${n(chars)}).`,
    );
  }
}

function checkLiTitle(c: Collector, path: string, title: string | undefined) {
  if (!title) return;
  const chars = charCount(title);
  if (chars > LINKEDIN_LIMITS.title.maxChars) {
    c.error(
      "TITLE_TOO_LONG",
      path,
      `Başlık en fazla ${n(LINKEDIN_LIMITS.title.maxChars)} karakter olabilir (şu an ${n(chars)}).`,
    );
  }
}

function checkLiImage(c: Collector, path: string, img: ImageMedia) {
  const L = LINKEDIN_LIMITS.image;
  const mime = guessMime(img);
  if (mime !== undefined && !(L.mimeTypes as readonly string[]).includes(mime)) {
    c.error(
      "IMAGE_FORMAT_UNSUPPORTED",
      join(path, "mimeType"),
      "LinkedIn yalnızca JPEG, PNG ya da GIF görsel kabul ediyor.",
    );
  }
  if (img.bytes !== undefined && img.bytes > L.maxBytes) {
    c.error(
      "IMAGE_TOO_LARGE",
      join(path, "bytes"),
      `Görsel en fazla ${mb(L.maxBytes)} olabilir (şu an ${mb(img.bytes)}).`,
    );
  }
  if (img.altText !== undefined && charCount(img.altText) > LINKEDIN_LIMITS.altText.maxChars) {
    c.error(
      "ALT_TEXT_TOO_LONG",
      join(path, "altText"),
      `Alternatif metin en fazla ${n(LINKEDIN_LIMITS.altText.maxChars)} karakter olabilir.`,
    );
  }
  checkMissing(c, path, img, ["mimeType", "bytes"]);
}

function checkLiDocument(c: Collector, path: string, doc: DocumentMedia) {
  const L = LINKEDIN_LIMITS.document;
  const mime = guessMime(doc);
  if (mime !== undefined && !(L.mimeTypes as readonly string[]).includes(mime)) {
    c.error(
      "DOCUMENT_FORMAT_UNSUPPORTED",
      join(path, "mimeType"),
      "LinkedIn belge carousel paylaşımı yalnızca PDF kabul ediyor.",
    );
  }
  if (doc.bytes !== undefined && doc.bytes > L.maxBytes) {
    c.error(
      "DOCUMENT_TOO_LARGE",
      join(path, "bytes"),
      `PDF dosyası en fazla ${mb(L.maxBytes)} olabilir (şu an ${mb(doc.bytes)}).`,
    );
  }
  checkMissing(c, path, doc, ["mimeType", "bytes"]);
}

function validateLinkedIn(c: Collector, r: LinkedInRequest) {
  checkLiCommentary(c, "commentary", r.commentary);
  switch (r.kind) {
    case "linkedin.text":
      if (r.commentary.trim().length === 0) {
        c.error("COMMENTARY_EMPTY", "commentary", "Metin paylaşımı boş olamaz.");
      }
      return;
    case "linkedin.image":
      checkLiImage(c, "image", r.image);
      return;
    case "linkedin.multi_image": {
      const L = LINKEDIN_LIMITS.multiImage;
      if (r.images.length < L.minItems) {
        c.error(
          "CAROUSEL_TOO_FEW_ITEMS",
          "images",
          `Çoklu görsel paylaşımı en az ${L.minItems} görsel içermeli (şu an ${r.images.length}).`,
        );
      }
      if (r.images.length > L.maxItems) {
        c.error(
          "CAROUSEL_TOO_MANY_ITEMS",
          "images",
          `Çoklu görsel paylaşımı en fazla ${L.maxItems} görsel içerebilir (şu an ${r.images.length}).`,
        );
      }
      r.images.forEach((img, i) => {
        checkLiImage(c, `images.${i}`, img);
      });
      return;
    }
    case "linkedin.document":
      checkLiTitle(c, "title", r.title);
      checkLiDocument(c, "document", r.document);
      return;
    case "linkedin.video": {
      checkLiTitle(c, "title", r.title);
      const L = LINKEDIN_LIMITS.video;
      const mime = guessMime(r.video);
      if (mime !== undefined && !(L.mimeTypes as readonly string[]).includes(mime)) {
        c.error(
          "VIDEO_FORMAT_UNSUPPORTED",
          "video.mimeType",
          "LinkedIn yalnızca MP4 ya da MOV video kabul ediyor.",
        );
      }
      if (r.video.bytes !== undefined && r.video.bytes > L.maxBytes) {
        c.error(
          "VIDEO_TOO_LARGE",
          "video.bytes",
          `Video en fazla ${mb(L.maxBytes)} olabilir (şu an ${mb(r.video.bytes)}).`,
        );
      }
      if (r.video.durationMs !== undefined) {
        if (r.video.durationMs < L.minDurationMs) {
          c.error(
            "VIDEO_TOO_SHORT",
            "video.durationMs",
            `Video en az ${sec(L.minDurationMs)} olmalı (şu an ${sec(r.video.durationMs)}).`,
          );
        }
        if (r.video.durationMs > L.maxDurationMs) {
          c.error(
            "VIDEO_TOO_LONG",
            "video.durationMs",
            `Video en fazla ${sec(L.maxDurationMs)} olabilir (şu an ${sec(r.video.durationMs)}).`,
          );
        }
      }
      checkMissing(c, "video", r.video, ["mimeType", "bytes", "durationMs"]);
      return;
    }
  }
}

/**
 * Validate a request. Accepts unknown input: schema problems come back as
 * `SCHEMA_INVALID` issues instead of throwing.
 */
export function validateRequest(input: unknown): ValidationReport {
  const c = new Collector();
  const parsed = PublishRequest.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      c.error(
        "SCHEMA_INVALID",
        issue.path.join("."),
        `Geçersiz alan: ${issue.path.join(".") || "istek"} (${issue.message}).`,
      );
    }
    return c.report();
  }
  const r = parsed.data;
  if (r.kind.startsWith("instagram.")) validateInstagram(c, r as InstagramRequest);
  else if (r.kind.startsWith("facebook.")) validateFacebook(c, r as FacebookRequest);
  else validateLinkedIn(c, r as LinkedInRequest);
  return c.report();
}
