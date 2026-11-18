/**
 * Comments on published posts (N16): read, reply, hide, delete.
 *
 * Instagram (`instagram_basic`, `instagram_manage_comments`):
 *   GET    /{ig-user-id}/media?fields=id,comments_count,timestamp     which media have new comments
 *   GET    /{ig-media-id}/comments?fields=id,text,username,timestamp,like_count,hidden,replies{…}
 *   POST   /{ig-comment-id}/replies   message=…
 *   POST   /{ig-comment-id}           hide=true|false
 *   DELETE /{ig-comment-id}
 * Facebook Pages (`pages_read_engagement`, `pages_read_user_content`, `pages_manage_engagement`):
 *   GET    /{object-id}?fields=comments.limit(0).summary(true)        how many comments
 *   GET    /{object-id}/comments?filter=stream&fields=id,message,from,created_time,like_count,is_hidden,parent{id}
 *   POST   /{comment-id}/comments     message=…   (a reply)
 *   POST   /{comment-id}              is_hidden=true|false
 *   DELETE /{comment-id}
 *
 * Polling only: webhooks need a public endpoint (possible later through the Cloudflare tunnel).
 *
 * Docs: https://developers.facebook.com/docs/instagram-platform/comment-moderation ,
 * https://developers.facebook.com/docs/graph-api/reference/object/comments
 */

import type { GraphClient } from "../graph/client.ts";
import { normaliseText, parseMetaTime } from "../machine.ts";

export type CommentPlatform = "instagram" | "facebook";

export interface PlatformComment {
  /** Platform comment id. */
  id: string;
  /** Parent comment id for replies, null for top-level comments. */
  parentId: string | null;
  text: string;
  /** Instagram username / Facebook name (null when Meta does not say). */
  author: string | null;
  /** Instagram: same as `author`; Facebook: the commenter's id (when Meta returns it). */
  authorId: string | null;
  /** ISO time. */
  createdAt: string | null;
  likeCount: number | null;
  hidden: boolean | null;
}

const IG_FIELDS =
  "id,text,username,timestamp,like_count,hidden,replies{id,text,username,timestamp,like_count,hidden}";
const FB_FIELDS = "id,message,from{id,name},created_time,like_count,is_hidden,parent{id}";

function iso(value: unknown): string | null {
  const t = parseMetaTime(value);
  return t === null ? null : new Date(t).toISOString();
}

interface IgCommentRow {
  id?: string;
  text?: string;
  username?: string;
  timestamp?: string;
  like_count?: number;
  hidden?: boolean;
  replies?: { data?: IgCommentRow[] };
}

interface FbCommentRow {
  id?: string;
  message?: string;
  from?: { id?: string; name?: string };
  created_time?: string;
  like_count?: number;
  is_hidden?: boolean;
  parent?: { id?: string };
}

interface Paged<T> {
  data?: T[];
  paging?: { next?: string; cursors?: { after?: string } };
}

function igComment(row: IgCommentRow, parentId: string | null): PlatformComment | null {
  if (!row.id) return null;
  return {
    id: row.id,
    parentId,
    text: row.text ?? "",
    author: row.username ?? null,
    authorId: row.username ?? null,
    createdAt: iso(row.timestamp),
    likeCount: typeof row.like_count === "number" ? row.like_count : null,
    hidden: typeof row.hidden === "boolean" ? row.hidden : null,
  };
}

function fbComment(row: FbCommentRow, objectId: string): PlatformComment | null {
  if (!row.id) return null;
  const parent = row.parent?.id;
  return {
    id: row.id,
    parentId: parent && parent !== objectId ? parent : null,
    text: row.message ?? "",
    author: row.from?.name ?? null,
    authorId: row.from?.id ?? null,
    createdAt: iso(row.created_time),
    likeCount: typeof row.like_count === "number" ? row.like_count : null,
    hidden: typeof row.is_hidden === "boolean" ? row.is_hidden : null,
  };
}

/** Follow `after` cursors until `max` rows or the end. */
async function pages<T>(
  graph: GraphClient,
  path: string,
  query: Record<string, string | number>,
  token: string,
  max: number,
): Promise<T[]> {
  const out: T[] = [];
  let after: string | undefined;
  for (let i = 0; i < 20 && out.length < max; i++) {
    const res = await graph.get<Paged<T>>(path, { ...query, ...(after ? { after } : {}) }, token);
    out.push(...(res?.data ?? []));
    after = res?.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out.slice(0, max);
}

/** Recent Instagram media of the account with their comment counts (newest first). */
export async function listInstagramCommentCounts(
  graph: GraphClient,
  igUserId: string,
  token: string,
  opts: { limit?: number } = {},
): Promise<{ id: string; comments: number; timestamp: string | null }[]> {
  const rows = await pages<{ id?: string; comments_count?: number; timestamp?: string }>(
    graph,
    `/${igUserId}/media`,
    { fields: "id,comments_count,timestamp", limit: Math.min(opts.limit ?? 50, 50) },
    token,
    opts.limit ?? 50,
  );
  return rows
    .filter((r): r is typeof r & { id: string } => typeof r.id === "string")
    .map((r) => ({
      id: r.id,
      comments: typeof r.comments_count === "number" ? r.comments_count : 0,
      timestamp: iso(r.timestamp),
    }));
}

/** How many comments a Facebook post / video has (Meta's summary count). */
export async function readFacebookCommentCount(
  graph: GraphClient,
  objectId: string,
  token: string,
): Promise<number> {
  const res = await graph.get<{ comments?: { summary?: { total_count?: number } } }>(
    `/${objectId}`,
    { fields: "id,comments.limit(0).summary(true)" },
    token,
  );
  return res?.comments?.summary?.total_count ?? 0;
}

/** Every comment and reply of a post, flat (replies carry `parentId`), oldest first. */
export async function readComments(
  graph: GraphClient,
  platform: CommentPlatform,
  objectId: string,
  token: string,
  opts: { max?: number } = {},
): Promise<PlatformComment[]> {
  const max = opts.max ?? 500;
  const out: PlatformComment[] = [];
  if (platform === "instagram") {
    const rows = await pages<IgCommentRow>(
      graph,
      `/${objectId}/comments`,
      { fields: IG_FIELDS, limit: 50 },
      token,
      max,
    );
    for (const row of rows) {
      const top = igComment(row, null);
      if (!top) continue;
      out.push(top);
      for (const reply of row.replies?.data ?? []) {
        const r = igComment(reply, top.id);
        if (r) out.push(r);
      }
    }
  } else {
    const rows = await pages<FbCommentRow>(
      graph,
      `/${objectId}/comments`,
      { fields: FB_FIELDS, filter: "stream", limit: 100 },
      token,
      max,
    );
    for (const row of rows) {
      const c = fbComment(row, objectId);
      if (c) out.push(c);
    }
  }
  return out.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
}

/**
 * A reply we may already have sent (a crash after Meta accepted it): a reply under `commentId`
 * with the same text.
 */
export async function findReply(
  graph: GraphClient,
  platform: CommentPlatform,
  commentId: string,
  message: string,
  token: string,
): Promise<string | null> {
  const wanted = normaliseText(message);
  const res = await graph.get<Paged<IgCommentRow & FbCommentRow>>(
    platform === "instagram" ? `/${commentId}/replies` : `/${commentId}/comments`,
    platform === "instagram"
      ? { fields: "id,text,username,timestamp", limit: 50 }
      : { fields: "id,message,created_time", limit: 50 },
    token,
  );
  const hit = (res?.data ?? []).find((r) => r.id && normaliseText(r.text ?? r.message) === wanted);
  return hit?.id ?? null;
}

/** Reply to a comment. Not idempotent: call `findReply` first after an uncertain attempt. */
export async function replyToComment(
  graph: GraphClient,
  platform: CommentPlatform,
  commentId: string,
  message: string,
  token: string,
): Promise<string | null> {
  const res = await graph.request<{ id?: string }>({
    method: "POST",
    path: platform === "instagram" ? `/${commentId}/replies` : `/${commentId}/comments`,
    form: { message },
    accessToken: token,
    idempotent: false,
  });
  return res.data?.id ?? null;
}

/** Hide or show a comment (repeating it is harmless). */
export async function setCommentHidden(
  graph: GraphClient,
  platform: CommentPlatform,
  commentId: string,
  hidden: boolean,
  token: string,
): Promise<void> {
  await graph.request({
    method: "POST",
    path: `/${commentId}`,
    form: platform === "instagram" ? { hide: hidden } : { is_hidden: hidden },
    accessToken: token,
    idempotent: true,
  });
}

/** Delete a comment. A comment already gone answers "does not exist" (treat as done). */
export async function deleteComment(
  graph: GraphClient,
  commentId: string,
  token: string,
): Promise<void> {
  await graph.request({
    method: "DELETE",
    path: `/${commentId}`,
    accessToken: token,
    idempotent: true,
  });
}
