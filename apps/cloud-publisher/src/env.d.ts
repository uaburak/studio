// Optional secret, deliberately not in wrangler.jsonc "secrets.required":
// only needed when "Require App Secret" is enabled in the Meta app.
// LINKEDIN_VERSION: optional override of the LinkedIn-Version header (YYYYMM), for when the
// built-in one is retired before a release (see LINKEDIN_API_VERSION in @studio/publishers).
interface Env {
  META_APP_SECRET?: string;
  LINKEDIN_VERSION?: string;
}
declare namespace Cloudflare {
  interface Env {
    META_APP_SECRET?: string;
    LINKEDIN_VERSION?: string;
  }
}
