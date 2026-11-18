// OAuth URLs and callbacks of the connect flows (StudioKit's MetaLogin / LinkedInLogin /
// OAuthLoopback): the login page opens in the system browser, the redirect comes back to the
// loopback listener on :8793, and the API exchanges the code.
import { randomBytes } from "node:crypto";
import {
  LINKEDIN_CALLBACK_PATH,
  LINKEDIN_REDIRECT_URI,
  META_CALLBACK_PATH,
  META_REDIRECT_URI,
} from "../../shared/accounts-ipc.ts";

export { LINKEDIN_CALLBACK_PATH, LINKEDIN_REDIRECT_URI, META_CALLBACK_PATH, META_REDIRECT_URI };

export const META_GRAPH_VERSION = "v27.0";
/**
 * Pages + Instagram publishing (Facebook Login), plus statistics and comments (N15, N16):
 * `read_insights`, `pages_read_user_content`, `pages_manage_engagement`,
 * `instagram_manage_insights`, `instagram_manage_comments`. Accounts connected before these were
 * added keep publishing; their statistics and comments need a reconnect.
 */
export const META_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "read_insights",
  "pages_read_user_content",
  "pages_manage_engagement",
  "instagram_manage_insights",
  "instagram_manage_comments",
  "business_management",
];
/** Sign In with LinkedIn (OpenID Connect) + Share on LinkedIn. */
export const LINKEDIN_SCOPES = ["openid", "profile", "w_member_social"];

export class OAuthCallbackError extends Error {
  constructor(
    readonly reason: "denied" | "state_mismatch" | "missing_code",
    detail = "",
  ) {
    super(
      reason === "denied"
        ? `Giriş tamamlanmadı: ${detail}`
        : reason === "state_mismatch"
          ? "Giriş yanıtı bu oturuma ait değil; yeniden deneyin."
          : "Giriş yanıtında yetki kodu yok; yeniden deneyin.",
    );
    this.name = "OAuthCallbackError";
  }
}

/** Random `state` (CSRF guard): 16 bytes as hex. */
export function newState(): string {
  return randomBytes(16).toString("hex");
}

/** Query and fragment parameters of a callback URL (the fragment wins on duplicates). */
export function callbackParams(url: URL | string): Record<string, string> {
  const parsed = typeof url === "string" ? new URL(url) : url;
  const out: Record<string, string> = {};
  for (const part of [parsed.search.slice(1), parsed.hash.slice(1)]) {
    if (!part) continue;
    for (const [key, value] of new URLSearchParams(part)) out[key] = value;
  }
  return out;
}

/** Code flow with an App Secret (long-lived tokens), token flow without one. */
export function metaAuthorizeUrl(appId: string, state: string, hasSecret: boolean): string {
  const url = new URL(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", META_REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", META_SCOPES.join(","));
  url.searchParams.set("response_type", hasSecret ? "code" : "token");
  return url.toString();
}

export function linkedInAuthorizeUrl(clientId: string, state: string): string {
  const url = new URL("https://www.linkedin.com/oauth/v2/authorization");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", LINKEDIN_REDIRECT_URI);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", LINKEDIN_SCOPES.join(" "));
  return url.toString();
}

export type MetaCallback = { code: string } | { accessToken: string; expiresIn: number | null };

export function parseMetaCallback(url: URL | string, expectedState: string): MetaCallback {
  const p = callbackParams(url);
  const error = p.error_description ?? p.error_reason ?? p.error;
  if (error !== undefined) throw new OAuthCallbackError("denied", error.replace(/\+/g, " "));
  if (p.state !== expectedState) throw new OAuthCallbackError("state_mismatch");
  if (p.code) return { code: p.code };
  if (p.access_token) {
    const expires = Number(p.expires_in);
    return { accessToken: p.access_token, expiresIn: Number.isFinite(expires) ? expires : null };
  }
  throw new OAuthCallbackError("missing_code");
}

export function parseLinkedInCallback(url: URL | string, expectedState: string): string {
  const p = callbackParams(url);
  const error = p.error_description ?? p.error;
  if (error !== undefined) throw new OAuthCallbackError("denied", error.replace(/\+/g, " "));
  if (p.state !== expectedState) throw new OAuthCallbackError("state_mismatch");
  if (!p.code) throw new OAuthCallbackError("missing_code");
  return p.code;
}
