// Composer logic (pure): `@` mention queries and suggestions, inserting a mention, alias
// allocation for attached images, and what a send contains.
import {
  autoAlias,
  type MentionCandidate as ContractMentionCandidate,
  slugify,
} from "@studio/contract";
import type { OutgoingMessage } from "./transcript.ts";

const WORD_BEFORE = /[\p{L}\p{N}\p{M}_.+\-@/\\=&%#~]/u;

/**
 * The `@query` being typed at `caret` (start = index of `@`), or null. Letters of any language
 * count (`@böro` finds `@boro`); the names themselves are ASCII.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0 && /[\p{L}\p{N}-]/u.test(text[i] ?? "")) i--;
  if (i < 0 || text[i] !== "@") return null;
  if (i > 0 && WORD_BEFORE.test(text[i - 1] ?? "")) return null;
  return { start: i, query: text.slice(i + 1, caret).toLocaleLowerCase("tr") };
}

/** What `@` can name: a file of the chat (or one being attached), a product, a post. */
export type MentionKind = "file" | "product" | "content";

export interface MentionCandidate {
  /** The name inserted after `@` (a file alias or a product's / post's mention name). */
  alias: string;
  assetId: string | null;
  previewUrl: string | null;
  isDraft: boolean;
  /** Default `file`. */
  kind?: MentionKind;
  /** Products and posts: the name / title (also searched). */
  label?: string;
  /** Products: the category; posts: the status. */
  detail?: string;
}

/** Folded for matching: Turkish letters to ASCII, spaces to `-` (`"Venta Böro"` → `venta-boro`). */
export function foldMention(text: string): string {
  return slugify(text);
}

/**
 * Prefix matches of the name first, then names containing the query and products / posts whose
 * label contains it; files, then products, then posts within each group (the order a sent
 * `@name` resolves in).
 */
export function mentionSuggestions(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = foldMention(query) || query.toLowerCase();
  if (!q) return candidates;
  const rank = (c: MentionCandidate) => (c.kind === "product" ? 1 : c.kind === "content" ? 2 : 0);
  const byKind = (list: MentionCandidate[]) =>
    list.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i);
  const prefix = candidates.filter((c) => c.alias.startsWith(q));
  const other = candidates.filter(
    (c) =>
      !c.alias.startsWith(q) &&
      (c.alias.includes(q) || (c.label !== undefined && foldMention(c.label).includes(q))),
  );
  return [...byKind(prefix), ...byKind(other)].map((x) => x.c);
}

/**
 * The brand's products and posts as composer candidates; names a file of the chat already uses
 * are left out (the file wins when the message is sent).
 */
export function entityCandidates(
  items: readonly ContractMentionCandidate[],
  fileAliases: ReadonlySet<string>,
): MentionCandidate[] {
  return items
    .filter((item) => !fileAliases.has(item.slug))
    .map((item) => ({
      alias: item.slug,
      assetId: item.imageAssetId,
      previewUrl: null,
      isDraft: false,
      kind: item.kind,
      label: item.label,
      detail: item.detail,
    }));
}

/**
 * What `@` offers in a chat that takes no new files (the post dock): the conversation's files,
 * then the brand's products and posts.
 */
export function chatMentionCandidates(
  aliases: readonly { alias: string; assetId: string }[],
  entities: readonly ContractMentionCandidate[],
): MentionCandidate[] {
  const files: MentionCandidate[] = aliases.map((a) => ({
    alias: a.alias,
    assetId: a.assetId,
    previewUrl: null,
    isDraft: false,
  }));
  return [...files, ...entityCandidates(entities, new Set(files.map((f) => f.alias)))];
}

/** Replace `@query` (start…caret) with `@alias ` and return the new text and caret. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  alias: string,
): { text: string; caret: number } {
  let tail = text.slice(caret);
  if (tail.startsWith(" ")) tail = tail.slice(1);
  const head = text.slice(0, start);
  const token = `@${alias} `;
  return { text: head + token + tail, caret: head.length + token.length };
}

/** Next free alias of `base` ("image", "image-1", …) not in `used`. */
export function allocateAlias(base: string, used: ReadonlySet<string>): string {
  for (let n = 0; n < 10_000; n++) {
    const candidate = autoAlias(base, n);
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export type DraftState =
  | { kind: "uploading" }
  | { kind: "uploaded"; assetId: string }
  | { kind: "failed"; error: string };

export interface Draft {
  id: string;
  alias: string;
  previewUrl: string;
  filename: string;
  state: DraftState;
  /** The brand the image was (or is being) uploaded to; the API takes only the chat's brand. */
  brandId?: string | null;
}

export function canSend(text: string, drafts: Draft[]): boolean {
  if (drafts.some((d) => d.state.kind === "uploading")) return false;
  return text.trim().length > 0 || drafts.some((d) => d.state.kind === "uploaded");
}

/**
 * Why the message cannot go as it is (null: it can): an image that failed to upload would be
 * dropped silently — and the text may name it with its @alias.
 */
export function sendProblem(text: string, drafts: Draft[]): string | null {
  const failed = drafts.filter((d) => d.state.kind === "failed");
  if (failed.length === 0) return null;
  const named = failed.filter((d) => new RegExp(`@${d.alias}(?![A-Za-z0-9-])`).test(text));
  const list = (named.length > 0 ? named : failed).map((d) => `@${d.alias}`).join(", ");
  return named.length > 0
    ? `${list} yüklenemedi ama mesajda geçiyor. Görseli kaldırıp yeniden ekle.`
    : `${list} yüklenemedi. Göndermek için görseli kaldır ya da yeniden ekle.`;
}

export function makeMessage(
  text: string,
  drafts: Draft[],
  clientMessageId: string,
): OutgoingMessage {
  return {
    clientMessageId,
    text: text.trim(),
    attachments: drafts.flatMap((d) =>
      d.state.kind === "uploaded" ? [{ assetId: d.state.assetId, alias: d.alias }] : [],
    ),
  };
}

/** What the send button shows: send (accent), stop (a reply runs, nothing typed) or idle. */
export function sendButtonMode(hasContent: boolean, working: boolean): "send" | "stop" | "idle" {
  if (hasContent) return "send";
  return working ? "stop" : "idle";
}
