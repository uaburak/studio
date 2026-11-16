/**
 * Account helpers (no storage, no OAuth UI): list Pages and linked
 * Instagram accounts, exchange tokens, inspect a token and classify its
 * health.
 *
 * Docs:
 * - https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived
 * - https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/get-started
 * - https://developers.facebook.com/docs/graph-api/reference/v27.0/debug_token
 */

import type { GraphClient } from "./graph/client.ts";

/** Scopes the Instagram flows need (Facebook Login). */
export const INSTAGRAM_PUBLISH_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
] as const;

/** Scopes the Facebook Page flows need. */
export const FACEBOOK_PUBLISH_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
] as const;

/**
 * Sometimes required, depending on how the account is set up:
 * - `business_management`: Pages owned through a Business portfolio / system users.
 * - `ads_management` or `ads_read`: Instagram publishing when the user has a
 *   Business Manager role on the Page (ig-user/media_publish docs).
 * - `publish_video`: listed by the Page posts guide "only for video publishing";
 *   the Reels and video guides do not list it.
 */
export const SITUATIONAL_SCOPES = [
  "business_management",
  "ads_management",
  "ads_read",
  "publish_video",
] as const;

export interface LinkedInstagramAccount {
  id: string;
  username: string | null;
  name: string | null;
}

export interface ManagedPage {
  id: string;
  name: string;
  category: string | null;
  /** Page access token. Long-lived when obtained with a long-lived user token. Treat as a secret. */
  accessToken: string | null;
  tasks: string[];
  /** The user can create content on this Page (CREATE_CONTENT or MANAGE task). */
  canPublish: boolean;
  instagram: LinkedInstagramAccount | null;
}

interface AccountsPage {
  data?: {
    id: string;
    name?: string;
    category?: string;
    access_token?: string;
    tasks?: string[];
    instagram_business_account?: { id: string; username?: string; name?: string };
  }[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/**
 * List the Pages the user can act on, each with its Page token and the
 * linked Instagram professional account (if any). Follows pagination.
 */
export async function listManagedPages(
  graph: GraphClient,
  userAccessToken: string,
  opts: { maxPages?: number } = {},
): Promise<ManagedPage[]> {
  const out: ManagedPage[] = [];
  let after: string | undefined;
  for (let i = 0; i < (opts.maxPages ?? 20); i++) {
    const res = await graph.get<AccountsPage>(
      "/me/accounts",
      {
        fields: "id,name,category,access_token,tasks,instagram_business_account{id,username,name}",
        limit: 100,
        after,
      },
      userAccessToken,
    );
    for (const p of res?.data ?? []) {
      const tasks = p.tasks ?? [];
      out.push({
        id: p.id,
        name: p.name ?? p.id,
        category: p.category ?? null,
        accessToken: p.access_token ?? null,
        tasks,
        canPublish: tasks.includes("CREATE_CONTENT") || tasks.includes("MANAGE"),
        instagram: p.instagram_business_account
          ? {
              id: p.instagram_business_account.id,
              username: p.instagram_business_account.username ?? null,
              name: p.instagram_business_account.name ?? null,
            }
          : null,
      });
    }
    after = res?.paging?.next ? res.paging.cursors?.after : undefined;
    if (!after) break;
  }
  return out;
}

export interface LongLivedToken {
  accessToken: string;
  tokenType: string | null;
  /** Epoch ms, or null when Meta did not say. */
  expiresAt: number | null;
}

/**
 * Exchange a short-lived user token for a long-lived one (~60 days).
 * Server-side only: needs the app secret.
 */
export async function exchangeForLongLivedUserToken(
  graph: GraphClient,
  args: { appId: string; appSecret: string; shortLivedToken: string },
): Promise<LongLivedToken> {
  const res = await graph.request<{
    access_token?: string;
    token_type?: string;
    expires_in?: number;
  }>({
    method: "GET",
    path: "/oauth/access_token",
    query: {
      grant_type: "fb_exchange_token",
      client_id: args.appId,
      client_secret: args.appSecret,
      fb_exchange_token: args.shortLivedToken,
    },
    secrets: [args.appSecret, args.shortLivedToken],
    idempotent: true,
  });
  const d = res.data;
  if (!d?.access_token) throw new Error("Token exchange returned no access_token");
  return {
    accessToken: d.access_token,
    tokenType: d.token_type ?? null,
    expiresAt: typeof d.expires_in === "number" ? graph.clock.now() + d.expires_in * 1000 : null,
  };
}

export interface TokenInfo {
  isValid: boolean;
  appId: string | null;
  userId: string | null;
  /** Page id for Page tokens. */
  profileId: string | null;
  type: string | null;
  scopes: string[];
  granularScopes: { scope: string; targetIds: string[] }[];
  /** Epoch ms; null = never expires (Meta returns 0 for non-expiring tokens). */
  expiresAt: number | null;
  /** Epoch ms when the app's access to the user's data lapses (90-day window). */
  dataAccessExpiresAt: number | null;
  issuedAt: number | null;
  error: { code: number | null; subcode: number | null; message: string | null } | null;
}

/**
 * Inspect a token with `GET /debug_token`. `appAccessToken` is an app token
 * (`{app-id}|{app-secret}`) or a developer's user token for the same app.
 */
export async function inspectToken(
  graph: GraphClient,
  args: { inputToken: string; appAccessToken: string },
): Promise<TokenInfo> {
  const res = await graph.request<{
    data?: {
      is_valid?: boolean;
      app_id?: string;
      user_id?: string;
      profile_id?: string;
      type?: string;
      scopes?: string[];
      granular_scopes?: { scope: string; target_ids?: string[] }[];
      expires_at?: number;
      data_access_expires_at?: number;
      issued_at?: number;
      error?: { code?: number; subcode?: number; message?: string };
    };
  }>({
    method: "GET",
    path: "/debug_token",
    query: { input_token: args.inputToken },
    accessToken: args.appAccessToken,
    secrets: [args.inputToken],
    idempotent: true,
  });
  const d = res.data?.data ?? {};
  const ts = (v: number | undefined) => (typeof v === "number" && v > 0 ? v * 1000 : null);
  return {
    isValid: d.is_valid === true,
    appId: d.app_id ?? null,
    userId: d.user_id ?? null,
    profileId: d.profile_id ?? null,
    type: d.type ?? null,
    scopes: d.scopes ?? [],
    granularScopes: (d.granular_scopes ?? []).map((g) => ({
      scope: g.scope,
      targetIds: g.target_ids ?? [],
    })),
    expiresAt: ts(d.expires_at),
    dataAccessExpiresAt: ts(d.data_access_expires_at),
    issuedAt: ts(d.issued_at),
    error: d.error
      ? {
          code: d.error.code ?? null,
          subcode: d.error.subcode ?? null,
          message: d.error.message ?? null,
        }
      : null,
  };
}

export type TokenHealthStatus = "valid" | "expiring_soon" | "invalid" | "missing_scopes";

export interface TokenHealth {
  status: TokenHealthStatus;
  missingScopes: string[];
  /** Earliest of token expiry and data-access expiry, epoch ms; null = no known deadline. */
  deadline: number | null;
  /** Turkish, user-presentable. */
  message: string;
}

/**
 * Classify a token for the "account health" UI and notifications.
 * Order: invalid > missing_scopes > expiring_soon > valid.
 */
export function classifyTokenHealth(
  info: TokenInfo,
  opts: {
    requiredScopes: readonly string[];
    now: number;
    /** Default 7 days. */
    expiringSoonMs?: number;
    /** Only require scopes to cover these targets (Page / IG ids) when granular scopes are present. */
    targetId?: string;
  },
): TokenHealth {
  const deadlines = [info.expiresAt, info.dataAccessExpiresAt].filter(
    (d): d is number => d !== null,
  );
  const deadline = deadlines.length ? Math.min(...deadlines) : null;
  if (!info.isValid || (deadline !== null && deadline <= opts.now)) {
    return {
      status: "invalid",
      missingScopes: [],
      deadline,
      message: "Hesap bağlantısı geçersiz ya da süresi dolmuş; hesabı yeniden bağlayın.",
    };
  }
  const granted = new Set(info.scopes);
  const missing = opts.requiredScopes.filter((scope) => {
    if (!granted.has(scope)) return true;
    if (!opts.targetId) return false;
    const g = info.granularScopes.find((x) => x.scope === scope);
    // No target list means the permission applies to everything.
    return !!g && g.targetIds.length > 0 && !g.targetIds.includes(opts.targetId);
  });
  if (missing.length) {
    return {
      status: "missing_scopes",
      missingScopes: missing,
      deadline,
      message: `Eksik izinler var (${missing.join(", ")}); hesabı yeniden bağlayıp izinleri onaylayın.`,
    };
  }
  const soon = opts.expiringSoonMs ?? 7 * 24 * 3600_000;
  if (deadline !== null && deadline - opts.now <= soon) {
    const days = Math.max(0, Math.ceil((deadline - opts.now) / (24 * 3600_000)));
    return {
      status: "expiring_soon",
      missingScopes: [],
      deadline,
      message: `Hesap bağlantısının süresi ${days} gün içinde doluyor; yeniden bağlayın.`,
    };
  }
  return { status: "valid", missingScopes: [], deadline, message: "Hesap bağlantısı sağlıklı." };
}
