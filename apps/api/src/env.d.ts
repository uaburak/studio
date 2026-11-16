// Optional runtime secrets for the local token vault and Meta OAuth token exchange.
interface Env {
  TOKEN_ENCRYPTION_KEY?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
}
declare namespace Cloudflare {
  interface Env {
    TOKEN_ENCRYPTION_KEY?: string;
    META_APP_ID?: string;
    META_APP_SECRET?: string;
  }
}
