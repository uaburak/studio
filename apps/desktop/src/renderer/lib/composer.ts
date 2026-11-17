// Composer logic (pure): `@` mention queries and suggestions, inserting a mention, alias
// allocation for attached images, and what a send contains.
import { autoAlias } from "@studio/contract";
import type { OutgoingMessage } from "./transcript.ts";

const WORD_BEFORE = /[\p{L}\p{N}\p{M}_.+\-@/\\=&%#~]/u;

/** The `@query` being typed at `caret` (start = index of `@`), or null. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  let i = caret - 1;
  while (i >= 0 && /[A-Za-z0-9-]/.test(text[i] ?? "")) i--;
  if (i < 0 || text[i] !== "@") return null;
  if (i > 0 && WORD_BEFORE.test(text[i - 1] ?? "")) return null;
  return { start: i, query: text.slice(i + 1, caret).toLowerCase() };
}

export interface MentionCandidate {
  alias: string;
  assetId: string | null;
  previewUrl: string | null;
  isDraft: boolean;
}

/** Prefix matches first, then other matches. */
export function mentionSuggestions(
  candidates: MentionCandidate[],
  query: string,
): MentionCandidate[] {
  const q = query.toLowerCase();
  if (!q) return candidates;
  return [
    ...candidates.filter((c) => c.alias.startsWith(q)),
    ...candidates.filter((c) => !c.alias.startsWith(q) && c.alias.includes(q)),
  ];
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
}

export function canSend(text: string, drafts: Draft[]): boolean {
  if (drafts.some((d) => d.state.kind === "uploading")) return false;
  return text.trim().length > 0 || drafts.some((d) => d.state.kind === "uploaded");
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
