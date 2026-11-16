import { z } from "zod";
import { AssetKind } from "./asset.ts";
import { EntityId, Timestamp } from "./common.ts";

/*
 * Attachment aliases and @mentions (task A2b).
 *
 * Every attachment of a conversation gets an alias, unique inside the
 * conversation: images are `image`, `image-1`, `image-2`, ... (videos
 * `video…`, audio `audio…`, anything else `file…`). The owner refers to an
 * attachment in a prompt with `@alias` ("@image-1 görselini ürün postunda
 * kullan"). The server resolves those tokens when it stores a user message
 * and keeps the result as `Message.mentions`, so the agent gets an exact
 * alias -> asset mapping.
 *
 * Rules:
 * - an alias is 1-40 chars of `a-z`, `0-9` and `-`, starts with a letter and
 *   does not end with `-`; input is lower-cased, so comparison is
 *   case-insensitive;
 * - an alias points at one asset, and one asset has one alias per
 *   conversation: attaching the same asset again reuses its first alias;
 * - a name, once used in a conversation, is never given to another asset
 *   (not after a rename, not after the message is gone). Old names keep
 *   resolving to their asset (`previousAliases`);
 * - every alias has a stable `id`; mentions and attachment parts carry it,
 *   so clients show the current name even after a rename.
 */

export const MAX_ALIAS_LENGTH = 40;
const ALIAS_RE = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

/** An alias as clients send it (lower-cased before validation). */
export const AttachmentAlias = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(MAX_ALIAS_LENGTH)
  .regex(ALIAS_RE, "letters a-z, digits and '-'; start with a letter, do not end with '-'")
  .meta({ id: "AttachmentAlias" });

export function isValidAlias(name: string): boolean {
  return name.length <= MAX_ALIAS_LENGTH && ALIAS_RE.test(name);
}

/** Base name of auto-allocated aliases, by mime type. */
export function aliasBaseFor(mimeType: string): "image" | "video" | "audio" | "file" {
  const type = mimeType.split("/")[0]?.trim().toLowerCase();
  if (type === "image" || type === "video" || type === "audio") return type;
  return "file";
}

/** The n-th auto alias of a base: `image`, `image-1`, `image-2`, ... */
export function autoAlias(base: string, n: number): string {
  return n === 0 ? base : `${base}-${n}`;
}

/** URL path that streams an asset (Range and ETag supported). */
export function assetContentPath(assetId: string): string {
  return `/api/assets/${encodeURIComponent(assetId)}/content`;
}

// --- mentions ------------------------------------------------------------------------

/**
 * One resolved `@alias` in a user message's text. `start` / `end` are UTF-16
 * code-unit offsets into the message's text part (JavaScript string indices;
 * Swift: `NSRange` / `String.utf16`), `end` exclusive, covering `@` and the
 * name. `alias` is the name as written (lower-cased), which may be an older
 * name of the alias; `aliasId` identifies it for good.
 */
export const MessageMention = z
  .object({
    alias: z.string(),
    aliasId: EntityId,
    assetId: EntityId,
    start: z.number().int().min(0),
    end: z.number().int().min(1),
  })
  .meta({ id: "MessageMention" });
export type MessageMention = z.infer<typeof MessageMention>;

/** A candidate `@name` token in text (not yet resolved against aliases). */
export interface AliasToken {
  /** Lower-cased name without `@`. */
  alias: string;
  start: number;
  end: number;
}

/** Characters that, right before `@`, make it part of a word (e-mail, handle, URL), not a mention. */
const WORD_BEFORE = /[\p{L}\p{N}\p{M}_.+\-@/\\=&%#~]/u;
/** Characters that, right after the name, mean the token goes on (so it is a different word). */
const WORD_AFTER = /[\p{L}\p{N}\p{M}_]/u;
const NAME_CHAR = /[A-Za-z0-9-]/;

/**
 * Find `@name` tokens. A token starts at `@` that is at the start of the text
 * or follows whitespace / punctuation (so `a@image` in an e-mail never
 * matches), takes the longest run of `A-Z a-z 0-9 -` (so `@image-10` is
 * `image-10`, never `image-1`), drops trailing `-`, and must not be followed
 * directly by another letter or digit (`@imageım` is not `@image`).
 * Punctuation after it is fine: `@image,` `@image-1'i` `(@image)`.
 */
export function scanAliasTokens(text: string): AliasToken[] {
  const out: AliasToken[] = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at === -1) break;
    i = at + 1;
    if (at > 0 && WORD_BEFORE.test(text[at - 1] ?? "")) continue;
    let j = at + 1;
    while (j < text.length && NAME_CHAR.test(text[j] ?? "")) j++;
    let end = j;
    while (end > at + 1 && text[end - 1] === "-") end--;
    const name = text.slice(at + 1, end).toLowerCase();
    i = j;
    if (!name || name.length > MAX_ALIAS_LENGTH || !/^[a-z]/.test(name)) continue;
    if (end === j && j < text.length && WORD_AFTER.test(text[j] ?? "")) continue;
    out.push({ alias: name, start: at, end });
  }
  return out;
}

/** What mention resolution needs to know about an alias. */
export interface AliasTarget {
  id: string;
  alias: string;
  previousAliases?: readonly string[];
  assetId: string;
}

/**
 * Resolve `@name` tokens against a conversation's aliases (current and
 * previous names). Unknown names stay plain text and are not listed; every
 * occurrence of a known name is listed, in text order. Clients can use this
 * while composing to highlight mentions; the server's result is stored.
 */
export function resolveAliasMentions(
  text: string,
  aliases: Iterable<AliasTarget>,
): MessageMention[] {
  const list = [...aliases];
  const byName = new Map<string, AliasTarget>();
  for (const a of list) {
    for (const old of a.previousAliases ?? []) if (!byName.has(old)) byName.set(old, a);
  }
  for (const a of list) byName.set(a.alias, a);
  const out: MessageMention[] = [];
  for (const token of scanAliasTokens(text)) {
    const target = byName.get(token.alias);
    if (!target) continue;
    out.push({
      alias: token.alias,
      aliasId: target.id,
      assetId: target.assetId,
      start: token.start,
      end: token.end,
    });
  }
  return out;
}

// --- aliases API -------------------------------------------------------------------------

export const ConversationAlias = z
  .object({
    /** Stable id; survives renames. Mentions and attachment parts carry it. */
    id: EntityId,
    conversationId: EntityId,
    /** Current name. */
    alias: z.string(),
    /** Earlier names, oldest first. They still resolve in new text and are never reused. */
    previousAliases: z.array(z.string()),
    assetId: EntityId,
    kind: AssetKind,
    mimeType: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    filename: z.string().nullable(),
    /** Path that streams the file: `GET` it on the API origin. */
    contentPath: z.string(),
    /** The message whose attachment introduced the alias (null if that message is gone). */
    messageId: EntityId.nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "ConversationAlias" });
export type ConversationAlias = z.infer<typeof ConversationAlias>;

/** All aliases of a conversation, oldest first (not paginated). */
export const ConversationAliasList = z
  .object({ items: z.array(ConversationAlias) })
  .meta({ id: "ConversationAliasList" });
export type ConversationAliasList = z.infer<typeof ConversationAliasList>;

/** Rename an alias. 409 when the name is (or was) used by another alias of the conversation. */
export const ConversationAliasUpdate = z
  .object({ alias: AttachmentAlias })
  .meta({ id: "ConversationAliasUpdate" });
export type ConversationAliasUpdate = z.input<typeof ConversationAliasUpdate>;

/** An alias as the agent sees it in the turn context: plus the R2 object key. */
export const TurnAlias = ConversationAlias.extend({
  /** R2 object key inside the MEDIA bucket. */
  objectKey: z.string(),
}).meta({ id: "TurnAlias" });
export type TurnAlias = z.infer<typeof TurnAlias>;
