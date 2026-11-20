import { z } from "zod";
import { slugify } from "./brand.ts";
import { MAX_ALIAS_LENGTH, scanAliasTokens } from "./chat-alias.ts";
import { EntityId } from "./common.ts";

/*
 * `@product` and `@post` mentions (docs/URETIM-RESIM.md §6–7).
 *
 * Files dropped, pasted or uploaded into a chat get `@image`, `@image-1`… aliases
 * (chat-alias.ts). Things that already have a name are called by it: a product of the
 * conversation's brand by its mention name (`@boro`, `@venta-boro`), a post by its title's
 * (`@hasat-bayrami`). Mention names are derived from the name (Turkish letters folded, see
 * `slugify`), unique per brand across products and posts: products first (oldest first), then
 * posts (oldest first); a name already taken gets `-2`, `-3`… Names that look like file aliases
 * (`image`, `video-2`…) get `-urun` / `-post` so files keep their names.
 *
 * Resolution order of a `@name` in a user message: the conversation's file aliases, then
 * products, then posts. The server stores product / post hits as `Message.entityMentions`
 * (file hits stay in `Message.mentions`).
 */

export const MentionEntityKind = z.enum(["product", "content"]).meta({ id: "MentionEntityKind" });
export type MentionEntityKind = z.infer<typeof MentionEntityKind>;

/**
 * One resolved `@name` of a product or post in a user message's text: UTF-16 offsets like
 * `MessageMention` (`end` exclusive, covering `@` and the name).
 */
export const MessageEntityMention = z
  .object({
    kind: MentionEntityKind,
    /** Product id (`kind: product`) or content id (`kind: content`). */
    id: EntityId,
    /** The name as written (lower-cased, without `@`). */
    name: z.string(),
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  })
  .meta({ id: "MessageEntityMention" });
export type MessageEntityMention = z.infer<typeof MessageEntityMention>;

/** A product or post the composer can offer after `@` (`GET /api/brands/{id}/mention-candidates`). */
export const MentionCandidate = z
  .object({
    kind: MentionEntityKind,
    id: EntityId,
    /** The mention name without `@`: `boro`, `venta-boro`. */
    slug: z.string(),
    /** Display name: the product's name or the post's title. */
    label: z.string(),
    /** Cover picture (product: first photo; post: first rendered slide), null when none. */
    imageAssetId: EntityId.nullable(),
    /** Products: the category ("" when none); posts: the post's status. */
    detail: z.string(),
    /** Posts: approval requests still waiting (0 for products). */
    pendingApprovals: z.number().int().min(0),
  })
  .meta({ id: "MentionCandidate" });
export type MentionCandidate = z.infer<typeof MentionCandidate>;

/** Products (oldest first), then posts (newest first, at most `MAX_MENTION_POSTS`). */
export const MentionCandidateList = z
  .object({ items: z.array(MentionCandidate) })
  .meta({ id: "MentionCandidateList" });
export type MentionCandidateList = z.infer<typeof MentionCandidateList>;

/** Posts offered by the candidates list (the newest ones; older posts still resolve). */
export const MAX_MENTION_POSTS = 200;

const FILE_ALIAS = /^(image|video|audio|file)(-\d+)?$/;

/** The mention name a name would like to have (before uniqueness): `"Venta Boro"` → `venta-boro`. */
export function mentionBase(name: string, kind: MentionEntityKind): string {
  const tag = kind === "product" ? "urun" : "post";
  let base = slugify(name).slice(0, MAX_ALIAS_LENGTH).replace(/-+$/g, "");
  if (!base) return tag;
  if (!/^[a-z]/.test(base)) base = `${tag}-${base}`;
  if (FILE_ALIAS.test(base)) base = `${base}-${tag}`;
  return base.slice(0, MAX_ALIAS_LENGTH).replace(/-+$/g, "");
}

/**
 * Give each item a unique mention name, in the given order; `taken` (lower-case) is extended with
 * the names given. Returns id → name.
 */
export function allocateMentionSlugs(
  items: readonly { id: string; name: string }[],
  kind: MentionEntityKind,
  taken: Set<string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    const base = mentionBase(item.name, kind);
    let slug = base;
    for (let n = 2; taken.has(slug); n++) {
      const suffix = `-${n}`;
      slug = `${base.slice(0, MAX_ALIAS_LENGTH - suffix.length).replace(/-+$/g, "")}${suffix}`;
    }
    taken.add(slug);
    out.set(item.id, slug);
  }
  return out;
}

/** What entity mention resolution needs: name → product / post. */
export interface MentionTarget {
  kind: MentionEntityKind;
  id: string;
  slug: string;
}

/**
 * Resolve `@name` tokens against products and posts, skipping names in `skip` (the
 * conversation's file aliases, which win). Every occurrence is listed, in text order.
 */
export function resolveEntityMentions(
  text: string,
  targets: Iterable<MentionTarget>,
  skip: ReadonlySet<string> = new Set(),
): MessageEntityMention[] {
  const bySlug = new Map<string, MentionTarget>();
  for (const t of targets) if (!bySlug.has(t.slug)) bySlug.set(t.slug, t);
  const out: MessageEntityMention[] = [];
  for (const token of scanAliasTokens(text)) {
    if (skip.has(token.alias)) continue;
    const target = bySlug.get(token.alias);
    if (!target) continue;
    out.push({
      kind: target.kind,
      id: target.id,
      name: token.alias,
      start: token.start,
      end: token.end,
    });
  }
  return out;
}

// --- product photo angles ------------------------------------------------------------------

const word = (alternatives: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])(${alternatives})([^\\p{L}\\p{N}]|$)`, "iu");

/** Words (in a file name, a tag or a caption) that say which side of a product a photo shows. */
const ANGLES: Array<[RegExp, string]> = [
  [word("on|ön|front|onden|önden"), "ön"],
  [word("arka|back|rear|arkadan"), "arka"],
  [word("sol|left|soldan"), "sol"],
  [word("sag|sağ|right|sagdan|sağdan"), "sağ"],
  [word("yan|side|profil|profile|yandan"), "yan"],
  [word("ust|üst|top|kapak"), "üst"],
  [word("alt|bottom|taban"), "alt"],
  [word("etiket|label"), "etiket"],
  [word("detay|detail|yakın|yakin|closeup|close-up"), "yakın plan"],
];

/**
 * Which side a product photo shows ("ön", "arka, etiket"), read from its file name, tags and
 * caption; null when nothing says it.
 */
export function productPhotoAngle(
  ...sources: ReadonlyArray<string | null | undefined>
): string | null {
  const text = sources.filter(Boolean).join(" ").replace(/[_.]/g, " ");
  const found = ANGLES.filter(([re]) => re.test(text)).map(([, label]) => label);
  return found.length > 0 ? [...new Set(found)].join(", ") : null;
}
