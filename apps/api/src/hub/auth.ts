/**
 * Worker authentication for /api/hub (shared secret).
 *
 * The Mac worker sends `Authorization: Bearer <WORKER_TOKEN>`; the API
 * compares it with the `WORKER_TOKEN` secret in constant time. Fails closed:
 * when the secret is not configured nobody can connect as a worker.
 *
 * WHEN CLOUDFLARE ACCESS ARRIVES (PLAN.md §4): the worker will also send an
 * Access service token (`CF-Access-Client-Id` / `CF-Access-Client-Secret`),
 * Access validates it at the edge and forwards `Cf-Access-Jwt-Assertion`,
 * which `middleware/access.ts` verifies for every /api/* route. This check
 * can then stay as defence in depth (a leaked Access token alone cannot
 * impersonate the worker) or be dropped; it is the only place to change.
 */

export type WorkerAuthResult = "ok" | "not_configured" | "denied";

const encoder = new TextEncoder();

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/**
 * Constant-time comparison: both sides are hashed first so the lengths are
 * equal and `timingSafeEqual` leaks nothing about the expected token.
 */
export async function tokensMatch(expected: string, provided: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(expected), digest(provided)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

export async function authenticateWorker(
  expected: string | undefined,
  authorization: string | undefined | null,
): Promise<WorkerAuthResult> {
  if (!expected) return "not_configured";
  const provided = bearerToken(authorization);
  if (provided === null) return "denied";
  return (await tokensMatch(expected, provided)) ? "ok" : "denied";
}
