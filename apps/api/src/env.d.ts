// Optional runtime settings that are not declared in wrangler.jsonc. Pass them with
// `wrangler dev --var NAME:value` (tests, private instances) or .dev.vars.
// TOKEN_ENCRYPTION_KEY is a declared secret (see wrangler.jsonc / worker-configuration.d.ts).
interface Env {
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  /** Graph API origin override (FakeGraph in tests). Default https://graph.facebook.com. */
  META_GRAPH_BASE_URL?: string;
  /** LinkedIn OAuth origin override. Default https://www.linkedin.com. */
  LINKEDIN_OAUTH_BASE_URL?: string;
  /** LinkedIn API origin override. Default https://api.linkedin.com. */
  LINKEDIN_API_BASE_URL?: string;
  /**
   * "1" lets Instagram/Facebook image posts be scheduled without a cloud publisher
   * (Meta cannot fetch media from this Mac). Only for FakeGraph runs.
   */
  STUDIO_ALLOW_PRIVATE_MEDIA_URLS?: string;
}
declare namespace Cloudflare {
  interface Env {
    META_APP_ID?: string;
    META_APP_SECRET?: string;
    META_GRAPH_BASE_URL?: string;
    LINKEDIN_OAUTH_BASE_URL?: string;
    LINKEDIN_API_BASE_URL?: string;
    STUDIO_ALLOW_PRIVATE_MEDIA_URLS?: string;
  }
}
