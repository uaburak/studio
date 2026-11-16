/**
 * Token redaction. Applied to every string that can leave the Graph client
 * (error messages, URLs, log data), so a leaked error object or log line
 * never contains an access token, app secret or proof.
 */

export const REDACTED = "[REDACTED]";

/** Query/form parameters whose values are always secrets. */
const SECRET_PARAMS = [
  "access_token",
  "input_token",
  "fb_exchange_token",
  "client_secret",
  "appsecret_proof",
];

const PARAM_RE = new RegExp(
  `((?:^|[?&\\s"'{,])(?:${SECRET_PARAMS.join("|")})["']?\\s*[=:]\\s*["']?)([^&\\s"',}]+)`,
  "gi",
);
/** `Authorization: OAuth <token>` / `Bearer <token>` in header dumps. */
const AUTH_RE = /\b(OAuth|Bearer)\s+([A-Za-z0-9._|\-~+/=]{8,})/g;
/**
 * Meta user/page/system tokens start with `EAA` followed by a long base62
 * tail; app tokens are `<app-id>|<secret>`. Catch them even when they
 * appear somewhere unexpected.
 */
const META_TOKEN_RE = /\bEAA[A-Za-z0-9]{20,}\b/g;
const APP_TOKEN_RE = /\b\d{6,20}\|[A-Za-z0-9_-]{16,}\b/g;

/**
 * Redact known secrets (exact match, longest first) and anything that looks
 * like a Meta token or a secret-bearing parameter.
 */
export function redact(text: string, secrets: Iterable<string | undefined> = []): string {
  let out = text;
  const exact = [...secrets].filter((s): s is string => typeof s === "string" && s.length >= 4);
  exact.sort((a, b) => b.length - a.length);
  for (const secret of exact) {
    out = out.split(secret).join(REDACTED);
    // Secrets can also appear URL-encoded (e.g. `appId%7Csecret`).
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join(REDACTED);
  }
  out = out.replace(PARAM_RE, (_m, prefix: string) => `${prefix}${REDACTED}`);
  out = out.replace(AUTH_RE, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  out = out.replace(META_TOKEN_RE, REDACTED);
  out = out.replace(APP_TOKEN_RE, REDACTED);
  return out;
}

/** Deep-redact every string inside a JSON-like value. */
export function redactDeep<T>(value: T, secrets: Iterable<string | undefined> = []): T {
  const list = [...secrets];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v, list);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) {
        out[k] = SECRET_PARAMS.includes(k) && typeof inner === "string" ? REDACTED : walk(inner);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}
