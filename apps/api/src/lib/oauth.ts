import type { MetaDiscoveredPage } from "@studio/contract";
import { classifyTokenHealth, GraphClient, inspectToken } from "@studio/publishers";
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
  baseUrl?: string | undefined;
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
  baseUrl?: string | undefined;
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

// --- Origins (overridable for FakeGraph / private test instances) -----------------

export interface OAuthEnv {
  META_GRAPH_BASE_URL?: string | undefined;
  LINKEDIN_OAUTH_BASE_URL?: string | undefined;
  LINKEDIN_API_BASE_URL?: string | undefined;
}

export const LINKEDIN_OAUTH_BASE_URL = "https://www.linkedin.com";
export const LINKEDIN_API_BASE_URL = "https://api.linkedin.com";

const trimSlash = (v: string) => v.replace(/\/+$/, "");

export function metaGraphBase(env: OAuthEnv): string {
  return trimSlash(env.META_GRAPH_BASE_URL?.trim() || META_GRAPH_BASE_URL);
}

export function linkedInOAuthBase(env: OAuthEnv): string {
  return trimSlash(env.LINKEDIN_OAUTH_BASE_URL?.trim() || LINKEDIN_OAUTH_BASE_URL);
}

export function linkedInApiBase(env: OAuthEnv): string {
  return trimSlash(env.LINKEDIN_API_BASE_URL?.trim() || LINKEDIN_API_BASE_URL);
}

/** Scopes the Mac asks for in Facebook Login (Pages + Instagram publishing). */
export const META_LOGIN_SCOPES = [
  ...new Set([...META_FACEBOOK_SCOPES, ...META_INSTAGRAM_SCOPES, "business_management"]),
];

// --- Meta: authorization code -> user token ----------------------------------------

/** `GET /oauth/access_token?code=…` (Facebook Login manual flow, code grant). */
export async function exchangeMetaCode(args: {
  appId: string;
  appSecret: string;
  code: string;
  redirectUri: string;
  baseUrl: string;
  now?: number;
  fetch?: typeof fetch;
}): Promise<{ accessToken: string; expiresAt: Date | null }> {
  const doFetch = args.fetch ?? globalThis.fetch.bind(globalThis);
  const url = new URL(`${args.baseUrl}/${META_GRAPH_VERSION}/oauth/access_token`);
  url.searchParams.set("client_id", args.appId);
  url.searchParams.set("client_secret", args.appSecret);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("code", args.code);
  const secrets = [args.appSecret, args.code];
  let res: Response;
  try {
    res = await doFetch(url.toString(), { method: "GET" });
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    throw new ApiProblem("validation_error", `Facebook girişi tamamlanamadı: ${msg}`);
  }
  const body = (await res.json().catch(() => null)) as
    | ({ access_token?: string; expires_in?: number } & MetaErrorEnvelope)
    | null;
  if (!res.ok || !body?.access_token) {
    const msg = redactSecrets(body?.error?.message ?? `HTTP ${res.status}`, secrets);
    throw new ApiProblem("validation_error", `Facebook girişi tamamlanamadı: ${msg}`);
  }
  const now = args.now ?? Date.now();
  return {
    accessToken: body.access_token,
    expiresAt:
      typeof body.expires_in === "number" && body.expires_in > 0
        ? new Date(now + body.expires_in * 1000)
        : null,
  };
}

/** Granted permissions of a user token (`GET /me/permissions`); null when unreadable. */
export async function readMetaGrantedScopes(args: {
  userAccessToken: string;
  baseUrl: string;
  fetch?: typeof fetch;
}): Promise<string[] | null> {
  const doFetch = args.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(`${args.baseUrl}/${META_GRAPH_VERSION}/me/permissions`, {
      headers: { Authorization: `OAuth ${args.userAccessToken}` },
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      data?: { permission?: string; status?: string }[];
    } | null;
    if (!body?.data) return null;
    return body.data
      .filter((p) => p.status === "granted" && typeof p.permission === "string")
      .map((p) => p.permission as string);
  } catch {
    return null;
  }
}

/**
 * Live Meta token health with `debug_token` (needs the app token `appId|appSecret`).
 * Returns null when it cannot be decided (no app secret, network error).
 */
export async function inspectMetaTokenHealth(args: {
  token: string;
  appId: string;
  appSecret: string;
  requiredScopes: readonly string[];
  targetId?: string | undefined;
  baseUrl: string;
  now?: number;
  fetch?: typeof fetch;
}): Promise<{
  status: "valid" | "expiring_soon" | "invalid" | "missing_scopes";
  expiresAt: Date | null;
  scopes: string[];
  message: string;
} | null> {
  const graph = new GraphClient({
    hosts: { graph: args.baseUrl },
    ...(args.fetch ? { fetch: args.fetch } : {}),
    retry: { maxAttempts: 2, baseDelayMs: 200, maxDelayMs: 500, maxInlineWaitMs: 1000 },
  });
  try {
    const info = await inspectToken(graph, {
      inputToken: args.token,
      appAccessToken: `${args.appId}|${args.appSecret}`,
    });
    const health = classifyTokenHealth(info, {
      requiredScopes: args.requiredScopes,
      now: args.now ?? Date.now(),
      ...(args.targetId ? { targetId: args.targetId } : {}),
    });
    const deadline = health.deadline;
    return {
      status: health.status,
      expiresAt: deadline !== null ? new Date(deadline) : null,
      scopes: info.scopes,
      message: health.message,
    };
  } catch {
    return null;
  }
}

// --- LinkedIn: authorization code -> member token ---------------------------------

export async function exchangeLinkedInCode(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  oauthBase: string;
  apiBase: string;
  fetch?: typeof fetch;
}): Promise<{
  accessToken: string;
  expiresInSeconds: number;
  scopes: string[];
  personUrn: string;
  name: string;
}> {
  const doFetch = args.fetch ?? globalThis.fetch.bind(globalThis);
  const secrets = [args.clientSecret, args.code];
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    client_id: args.clientId,
    client_secret: args.clientSecret,
  });
  let res: Response;
  try {
    res = await doFetch(`${args.oauthBase}/oauth/v2/accessToken`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : String(err), secrets);
    throw new ApiProblem("validation_error", `LinkedIn girişi tamamlanamadı: ${msg}`);
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  } | null;
  if (!res.ok || !body?.access_token) {
    const msg = redactSecrets(
      body?.error_description ?? body?.error ?? `HTTP ${res.status}`,
      secrets,
    );
    throw new ApiProblem("validation_error", `LinkedIn girişi tamamlanamadı: ${msg}`);
  }
  const accessToken = body.access_token;
  const member = await readLinkedInMember({ accessToken, apiBase: args.apiBase, fetch: doFetch });
  if (member === "invalid" || member === null) {
    throw new ApiProblem(
      "validation_error",
      "LinkedIn üye bilgisi okunamadı; uygulamada 'Sign In with LinkedIn using OpenID Connect' ürününün ekli olduğundan emin olun.",
    );
  }
  return {
    accessToken,
    expiresInSeconds:
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : LINKEDIN_DEFAULT_EXPIRES_SECONDS,
    scopes: body.scope ? body.scope.split(/[\s,]+/).filter(Boolean) : [...LINKEDIN_DEFAULT_SCOPES],
    personUrn: member.personUrn,
    name: member.name,
  };
}

/** OIDC `GET /v2/userinfo`: the member behind a token, "invalid" on 401, null when unknown. */
export async function readLinkedInMember(args: {
  accessToken: string;
  apiBase: string;
  fetch?: typeof fetch;
}): Promise<{ personUrn: string; name: string } | "invalid" | null> {
  const doFetch = args.fetch ?? globalThis.fetch.bind(globalThis);
  try {
    const res = await doFetch(`${args.apiBase}/v2/userinfo`, {
      headers: { Authorization: `Bearer ${args.accessToken}` },
    });
    if (res.status === 401) return "invalid";
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as {
      sub?: string;
      name?: string;
      given_name?: string;
      family_name?: string;
    } | null;
    if (!body?.sub) return null;
    const name =
      body.name ?? ([body.given_name, body.family_name].filter(Boolean).join(" ") || body.sub);
    return { personUrn: `urn:li:person:${body.sub}`, name };
  } catch {
    return null;
  }
}
