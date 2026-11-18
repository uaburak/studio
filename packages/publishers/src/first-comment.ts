/**
 * The first comment (N13): posted under a post right after it is published, as its own step.
 *
 * - Instagram: `POST /{ig-media-id}/comments` (`message`), Facebook: `POST /{object-id}/comments`
 *   on the post (or the photo / video when Meta returned no post id).
 * - Before posting, the object's recent comments are read: a step that ran before a crash (the
 *   comment reached Meta, the state was not saved) finds its comment instead of posting twice.
 * - Any failure is a warning, never a failed publish: the post itself is live.
 *
 * Docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments ,
 * https://developers.facebook.com/docs/graph-api/reference/object/comments
 */

import { GraphError } from "./errors.ts";
import type { GraphClient } from "./graph/client.ts";
import { normaliseText } from "./machine.ts";
import type { PublishRequest, PublishWarning } from "./models.ts";

export interface FirstCommentState {
  /** Set (and persisted) before the comment can reach Meta. */
  intentAt: number | null;
  /** The comment's id once posted or found; null when it could not be posted. */
  id: string | null;
}

/** The request's first comment, trimmed (null: none, or the kind has no comments). */
export function firstCommentOf(request: PublishRequest): string | null {
  const text = (request as { firstComment?: unknown }).firstComment;
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

interface CommentRow {
  id?: string;
  text?: string;
  message?: string;
}

const WHERE_TR: Record<"instagram" | "facebook", string> = {
  instagram: "Instagram'da",
  facebook: "Facebook'ta",
};

/** Turkish warning text; `why` is a short reason in parentheses (or empty). */
export function firstCommentFailedMessage(platform: "instagram" | "facebook", why = ""): string {
  return `Gönderi yayınlandı ama ilk yorum eklenemedi${why}; yorumu ${WHERE_TR[platform]} elle ekleyin.`;
}

function reason(err: unknown): string {
  if (err instanceof GraphError) {
    const c = err.info.category;
    if (c === "permission" || c === "auth") return " (yorum izni yok; hesabı yeniden bağlayın)";
    if (c === "rate_limit") return " (Meta istek sınırı)";
    if (c === "spam_block") return " (Meta spam şüphesiyle engelledi)";
  }
  return "";
}

/**
 * Post the first comment, or find the one an earlier run posted. Returns its id; on any error a
 * `FIRST_COMMENT_FAILED` warning is pushed onto `warnings` and null is returned.
 */
export async function postFirstComment(
  graph: GraphClient,
  args: {
    platform: "instagram" | "facebook";
    objectId: string;
    message: string;
    accessToken: string;
    warnings: PublishWarning[];
  },
): Promise<string | null> {
  const { platform, objectId, message, accessToken } = args;
  const wanted = normaliseText(message);
  try {
    const listed = await graph.get<{ data?: CommentRow[] }>(
      `/${objectId}/comments`,
      platform === "instagram"
        ? { fields: "id,text", limit: 50 }
        : { fields: "id,message", limit: 50, order: "reverse_chronological" },
      accessToken,
    );
    const found = (listed?.data ?? []).find(
      (c) => c.id && normaliseText(c.text ?? c.message) === wanted,
    );
    if (found?.id) return found.id;
    const res = await graph.request<{ id?: string }>({
      method: "POST",
      path: `/${objectId}/comments`,
      form: { message },
      accessToken,
      idempotent: false,
    });
    if (res.data?.id) return res.data.id;
    args.warnings.push({
      code: "FIRST_COMMENT_FAILED",
      message: firstCommentFailedMessage(platform),
    });
    return null;
  } catch (err) {
    args.warnings.push({
      code: "FIRST_COMMENT_FAILED",
      message: firstCommentFailedMessage(platform, reason(err)),
    });
    return null;
  }
}
