import type { MetaDiscoveredPage } from "@studio/contract";
import { ApiProblem } from "./errors.ts";

export const META_GRAPH_VERSION = "v27.0";
export const META_GRAPH_BASE_URL = "https://graph.facebook.com";

/** LinkedIn OAuth access tokens default to 60 days (PLAN.md §3.3). */
export const LINKEDIN_DEFAULT_EXPIRES_SECONDS = 60 * 86_400;

export const LINKEDIN_DEFAULT_SCOPES = ["openid", "profile", "w_member_social"] as const;
export const META_FACEBOOK_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
] as const;
export const META_INSTAGRAM_SCOPES = [
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "pages_read_engagement",
] as const;

function redactSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join("[REDACTED]");
  }
  return out.replace(/\b(EAA|AQV)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

interface MetaErrorEnvelope {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
  };
}

export async function exchangeMetaLongLivedToken(args: {
  appId: string;
  appSecret: string;
  shortLivedToken: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  now?: number;
}): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const doFetch = args.fetch ?? globalThis.fetch.bind(globalThis);
  const base = (args.baseUrl ?? META_GRAPH_BASE_URL).replace(/\/+$/, "");
  const url = new URL(`${base}/${META_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set("grant_type", "fb_exchange_token");
  url.searchParams.set("client_id", args.appId);
  url.searchParams.set("client_secret", args.appSecret);
  url.searchParams.set("fb_exchange_token", args.shortLivedToken);

  const secrets = [args.appSecret, args.shortLivedToken];
  let res: Response;
  try {
    res = await doFetch(url.toString(), { method: "GET" });
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    throw new ApiProblem("validation_error", `Meta token exchange failed: ${msg}`);
  }

  const body = (await res.json().catch(() => null)) as
    | ({ access_token?: string; expires_in?: number } & MetaErrorEnvelope)
    | null;
  if (!res.ok || !body?.access_token) {
    const msg = redactSecrets(body?.error?.message ?? `HTTP ${res.status}`, secrets);
    throw new ApiProblem("validation_error", `Meta token exchange failed: ${msg}`);
  }

  const now = args.now ?? Date.now();
  const expiresAt =
    typeof body.expires_in === "number" && body.expires_in > 0
      ? new Date(now + body.expires_in * 1000)
      : null;
  return { accessToken: body.access_token, expiresAt };
}

interface AccountsPageResponse extends MetaErrorEnvelope {
  data?: {
    id: string;
    name?: string;
    access_token?: string;
    tasks?: string[];
    instagram_business_account?: {
      id: string;
      username?: string;
    };
  }[];
  paging?: {
    cursors?: { after?: string };
    next?: string;
  };
}

export async function discoverMetaPages(args: {
  userAccessToken: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  maxPages?: number;
}): Promise<MetaDiscoveredPage[]> {
  const doFetch = args.fetch ?? globalThis.fetch.bind(globalThis);
  const base = (args.baseUrl ?? META_GRAPH_BASE_URL).replace(/\/+$/, "");
  const out: MetaDiscoveredPage[] = [];
  let after: string | undefined;

  for (let i = 0; i < (args.maxPages ?? 10); i++) {
    const url = new URL(`${base}/${META_GRAPH_VERSION}/me/accounts`);
    url.searchParams.set(
      "fields",
      "id,name,access_token,tasks,instagram_business_account{id,username}",
    );
    url.searchParams.set("limit", "100");
    if (after) url.searchParams.set("after", after);

    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method: "GET",
        headers: { Authorization: `OAuth ${args.userAccessToken}` },
      });
    } catch (err) {
      const msg = redactSecrets(err instanceof Error ? err.message : String(err), [
        args.userAccessToken,
      ]);
      throw new ApiProblem("validation_error", `Meta page discovery failed: ${msg}`);
    }

    const body = (await res.json().catch(() => null)) as AccountsPageResponse | null;
    if (!res.ok || body?.error) {
      const msg = redactSecrets(body?.error?.message ?? `HTTP ${res.status}`, [
        args.userAccessToken,
      ]);
      throw new ApiProblem("validation_error", `Meta page discovery failed: ${msg}`);
    }

    for (const p of body?.data ?? []) {
      const tasks = p.tasks ?? [];
      const canPublish = tasks.includes("CREATE_CONTENT") || tasks.includes("MANAGE");
      const ig = p.instagram_business_account;
      out.push({
        pageId: p.id,
        pageName: p.name ?? p.id,
        canPublish,
        ...(p.access_token ? { pageAccessToken: p.access_token } : {}),
        instagram: ig
          ? {
              igUserId: ig.id,
              username: ig.username ?? ig.id,
            }
          : null,
      });
    }

    after = body?.paging?.next ? body.paging.cursors?.after : undefined;
    if (!after) break;
  }

  return out;
}
