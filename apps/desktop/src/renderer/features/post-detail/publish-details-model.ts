// "Yayın ayrıntıları" as data (N13, pure): which fields a post shows (its platforms and type), the
// first comment's limits, alternative texts filled from the slides, usernames, a people tag's
// position from a click, the platform notes, and the payload saved with
// `PUT /api/contents/{id}/publish-details` (it does not revoke the approval).
import {
  altTextFromSlideText,
  type Content,
  IG_USERNAME_RE,
  PUBLISH_DETAIL_LIMITS,
  PUBLISH_DETAIL_SUPPORT,
  type PublishDetailField,
  type PublishDetails,
  type PublishKindName,
  publishDetailIssues,
  selectPublishKind,
} from "@studio/contract";
import { layersInHtml } from "../posts/slides.ts";

export type DetailFields = Record<PublishDetailField, boolean>;

/** The publish flows of the post: one per target platform. */
export function publishKinds(
  content: Pick<Content, "type" | "targetPlatforms">,
  slideCount: number,
): PublishKindName[] {
  return content.targetPlatforms.map((p) => selectPublishKind(p, content.type, slideCount));
}

/** A field is shown when at least one of the post's platforms takes it. */
export function detailFields(kinds: readonly PublishKindName[]): DetailFields {
  const has = (f: PublishDetailField) => kinds.some((k) => PUBLISH_DETAIL_SUPPORT[k].includes(f));
  return {
    firstComment: has("firstComment"),
    altText: has("altText"),
    location: has("location"),
    collaborators: has("collaborators"),
    userTags: has("userTags"),
    reelCover: has("reelCover"),
    shareToFeed: has("shareToFeed"),
  };
}

export function anyField(fields: DetailFields): boolean {
  return Object.values(fields).some(Boolean);
}

/** People tags carry a position on pictures; Reels take usernames only. */
export function tagsHavePositions(kinds: readonly PublishKindName[]): boolean {
  return kinds.some((k) => k === "instagram.image" || k === "instagram.carousel");
}

const HASHTAG_RE = /(^|[^\p{L}\p{N}_&#])#[\p{L}\p{N}_]+/gu;
const chars = (s: string) => [...s].length;

export interface CommentUsage {
  chars: number;
  max: number;
  hashtags: number;
  /** Instagram counts hashtags (30); null when only Facebook takes the comment. */
  hashtagLimit: number | null;
  over: boolean;
  /** "123 / 2.200 karakter · 3/30 etiket". */
  label: string;
}

/** The first comment against the strictest platform that takes it (Instagram 2.200, Facebook 8.000). */
export function commentUsage(text: string, kinds: readonly PublishKindName[]): CommentUsage {
  const instagram = kinds.some(
    (k) => k.startsWith("instagram.") && PUBLISH_DETAIL_SUPPORT[k].includes("firstComment"),
  );
  const max = instagram
    ? PUBLISH_DETAIL_LIMITS.firstComment.instagram
    : PUBLISH_DETAIL_LIMITS.firstComment.facebook;
  const n = chars(text.trim());
  const hashtags = [...text.matchAll(HASHTAG_RE)].length;
  const hashtagLimit = instagram ? PUBLISH_DETAIL_LIMITS.firstCommentHashtags : null;
  const over = n > max || (hashtagLimit !== null && hashtags > hashtagLimit);
  const tr = (v: number) => v.toLocaleString("tr-TR");
  return {
    chars: n,
    max,
    hashtags,
    hashtagLimit,
    over,
    label: `${tr(n)} / ${tr(max)} karakter${hashtagLimit !== null ? ` · ${hashtags}/${hashtagLimit} etiket` : ""}`,
  };
}

/** `@Ali.Veli ` → `ali.veli`; null when it is not an Instagram username. */
export function normalizeUsername(raw: string): string | null {
  const name = raw.trim().replace(/^@+/, "").toLowerCase();
  return IG_USERNAME_RE.test(name) ? name : null;
}

/** "ali, @veli  ayse" → usernames (unique, in order) and what could not be read. */
export function parseUsernames(text: string): { usernames: string[]; invalid: string[] } {
  const usernames: string[] = [];
  const invalid: string[] = [];
  for (const part of text.split(/[\s,;]+/)) {
    if (!part.trim()) continue;
    const name = normalizeUsername(part);
    if (!name) invalid.push(part.trim());
    else if (!usernames.includes(name)) usernames.push(name);
  }
  return { usernames, invalid };
}

/** Where a click fell on a picture, 0–1 from the top left (3 decimals). */
export function tagPosition(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const clamp = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  return {
    x: clamp(rect.width > 0 ? (clientX - rect.left) / rect.width : 0),
    y: clamp(rect.height > 0 ? (clientY - rect.top) / rect.height : 0),
  };
}

/** The words a slide shows: its visible text layers, else the body's text. */
export function slideText(html: string): string {
  const layers = layersInHtml(html).filter((l) => l.kind === "text" && !l.hidden && l.text.trim());
  if (layers.length) return layers.map((l) => l.text.replace(/\s+/g, " ").trim()).join(" ");
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return body
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fill the alternative texts the owner has not written from the slides' text (marked "auto").
 * Texts the owner wrote or edited (`manual`) stay. `force` rewrites the automatic ones too.
 */
export function autoAltTexts(
  details: PublishDetails,
  slides: readonly { html: string }[],
  opts: { force?: boolean } = {},
): PublishDetails {
  const texts = [...(details.altTexts ?? [])];
  const sources = [...(details.altTextSources ?? [])];
  let changed = false;
  slides.forEach((s, i) => {
    const manual = sources[i] === "manual" && texts[i]?.trim();
    if (manual) return;
    if (texts[i]?.trim() && !opts.force) return;
    const auto = altTextFromSlideText(slideText(s.html));
    if (!auto || auto === texts[i]) return;
    texts[i] = auto;
    sources[i] = "auto";
    changed = true;
  });
  if (!changed) return details;
  const n = Math.max(texts.length, sources.length);
  return {
    ...details,
    altTexts: Array.from({ length: n }, (_, i) => texts[i] ?? null),
    altTextSources: Array.from({ length: n }, (_, i) => sources[i] ?? null),
  };
}

/** The owner edits slide `i`'s alternative text: it is theirs from now on. */
export function editAltText(details: PublishDetails, i: number, text: string): PublishDetails {
  const n = Math.max(i + 1, details.altTexts?.length ?? 0);
  return {
    ...details,
    altTexts: Array.from({ length: n }, (_, k) =>
      k === i ? text : (details.altTexts?.[k] ?? null),
    ),
    altTextSources: Array.from({ length: n }, (_, k) =>
      k === i ? "manual" : (details.altTextSources?.[k] ?? null),
    ),
  };
}

/** What is sent: trimmed, empty parts dropped (`{}` clears everything). */
export function detailsPayload(d: PublishDetails): PublishDetails {
  const out: PublishDetails = {};
  const comment = d.firstComment?.trim();
  if (comment) out.firstComment = comment;
  if (d.altTexts?.some((t) => t?.trim())) {
    out.altTexts = d.altTexts.map((t) => (t?.trim() ? t.trim() : null));
    if (d.altTextSources?.length)
      out.altTextSources = d.altTexts.map((_, i) => d.altTextSources?.[i] ?? null);
  }
  if (d.location) out.location = d.location;
  if (d.collaborators?.length) out.collaborators = [...new Set(d.collaborators)];
  if (d.userTags?.length) out.userTags = d.userTags;
  if (d.reelCover) out.reelCover = d.reelCover;
  if (d.shareToFeed === false) out.shareToFeed = false;
  return out;
}

export function sameDetails(
  a: PublishDetails | null | undefined,
  b: PublishDetails | null | undefined,
) {
  return JSON.stringify(detailsPayload(a ?? {})) === JSON.stringify(detailsPayload(b ?? {}));
}

export interface IssueLine {
  tone: "danger" | "warning";
  text: string;
}

/** Each platform's errors (blocking there) and notes (left out there), without repeats. */
export function issueLines(
  details: PublishDetails,
  kinds: readonly PublishKindName[],
  slideCount: number,
  videoDurationMs?: number | null,
): IssueLine[] {
  const seen = new Set<string>();
  const out: IssueLine[] = [];
  for (const kind of kinds) {
    const r = publishDetailIssues(details, kind, slideCount, {
      videoDurationMs: videoDurationMs ?? null,
    });
    for (const [tone, list] of [
      ["danger", r.errors],
      ["warning", r.warnings],
    ] as const) {
      for (const issue of list) {
        if (seen.has(issue.message)) continue;
        seen.add(issue.message);
        out.push({ tone, text: issue.message });
      }
    }
  }
  return out.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "danger" ? -1 : 1));
}

/** One line for the schedule sheet: what is set ("İlk yorum · 2 alternatif metin · Konum: Konya"). */
export function detailsSummary(d: PublishDetails | null | undefined, fields: DetailFields): string {
  if (!d) return "Eklenmedi";
  const parts: string[] = [];
  if (fields.firstComment && d.firstComment?.trim()) parts.push("İlk yorum");
  const alt = d.altTexts?.filter((t) => t?.trim()).length ?? 0;
  if (fields.altText && alt) parts.push(`${alt} alternatif metin`);
  if (fields.location && d.location) parts.push(`Konum: ${d.location.name}`);
  if (fields.collaborators && d.collaborators?.length)
    parts.push(`${d.collaborators.length} ortak hesap`);
  if (fields.userTags && d.userTags?.length) parts.push(`${d.userTags.length} kişi etiketi`);
  if (fields.reelCover && d.reelCover)
    parts.push(d.reelCover.kind === "image" ? "Kapak görseli" : "Kapak karesi");
  if (fields.shareToFeed && d.shareToFeed === false) parts.push("Akışta gösterilmez");
  return parts.length ? parts.join(" · ") : "Eklenmedi";
}

/** "1,5 sn". */
export function secondsLabel(ms: number): string {
  return `${(Math.round(ms / 100) / 10).toLocaleString("tr-TR")} sn`;
}
