/**
 * Gemini "too many requests" (HTTP 429, `RESOURCE_EXHAUSTED`) is usually a per-minute quota: the
 * request is worth repeating after the delay Google names (U4). Bulk generation used to fail its
 * posts for good on the first 429.
 */

/** Tries of one request on 429 before it counts as a real quota problem. */
export const GEMINI_RATE_LIMIT_TRIES = 4;
/** Longest single wait for a 429; a longer announced delay is a daily quota (not worth waiting). */
export const GEMINI_RATE_LIMIT_MAX_WAIT_MS = 90_000;

/**
 * How long to wait before repeating a 429'd request: the `Retry-After` header, else the
 * `google.rpc.RetryInfo` `retryDelay` of the error body ("17s", "1.5s"), else exponential
 * backoff from 2 s. Null when the announced delay is longer than `maxWaitMs`.
 */
export function rateLimitDelayMs(
  headers: Pick<Headers, "get"> | undefined,
  bodyText: string,
  attempt: number,
  maxWaitMs = GEMINI_RATE_LIMIT_MAX_WAIT_MS,
): number | null {
  const announced =
    retryAfterHeaderMs(headers?.get("retry-after") ?? null) ?? retryInfoMs(bodyText);
  if (announced !== null) {
    if (announced > maxWaitMs) return null;
    return Math.max(500, announced + 250);
  }
  return Math.min(maxWaitMs, 2_000 * 2 ** attempt);
}

function retryAfterHeaderMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function retryInfoMs(bodyText: string): number | null {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { details?: { "@type"?: string; retryDelay?: string }[] };
    };
    for (const d of parsed.error?.details ?? []) {
      if (!d["@type"]?.endsWith("RetryInfo") || typeof d.retryDelay !== "string") continue;
      const m = /^(\d+(?:\.\d+)?)s$/.exec(d.retryDelay.trim());
      if (m?.[1]) return Math.round(Number(m[1]) * 1000);
    }
  } catch {
    // not JSON
  }
  return null;
}
