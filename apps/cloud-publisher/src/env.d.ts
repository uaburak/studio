// Optional secret, deliberately not in wrangler.jsonc "secrets.required":
// only needed when "Require App Secret" is enabled in the Meta app.
interface Env {
  META_APP_SECRET?: string;
}
declare namespace Cloudflare {
  interface Env {
    META_APP_SECRET?: string;
  }
}
