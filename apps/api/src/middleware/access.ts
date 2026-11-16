import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../lib/router.ts";

/**
 * AUTH SEAM — the single place where request authentication will go.
 *
 * Cloudflare Access will front the whole app (PLAN.md §4): browsers log in
 * through Access, the iOS app and the Mac worker use Access service tokens.
 * When that is set up, verify the `Cf-Access-Jwt-Assertion` header here
 * (signature against the team's JWKS, `aud` = the application tag) and
 * reject with 401 otherwise. Until then this is intentionally a no-op:
 * everything runs locally and nothing is deployed.
 */
export const cloudflareAccess: MiddlewareHandler<AppEnv> = async (_c, next) => {
  await next();
};
