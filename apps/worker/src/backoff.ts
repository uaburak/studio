export interface BackoffOptions {
  /** Delay for the first retry (attempt 0). */
  baseMs: number;
  /** Upper bound for any delay. */
  maxMs: number;
  /** Growth factor per attempt. Default 2. */
  factor?: number;
  /**
   * Fraction of the delay that is randomized, 0..1. With jitter 0.2 the delay
   * is uniformly picked from [0.8 * d, d]. Spreads reconnect storms.
   */
  jitter?: number;
  /** Injectable RNG for tests; returns [0, 1). */
  random?: () => number;
}

/** Exponential backoff with a ceiling and proportional jitter. */
export function backoffDelay(attempt: number, options: BackoffOptions): number {
  const { baseMs, maxMs, factor = 2, jitter = 0, random = Math.random } = options;
  const n = Math.max(0, Math.floor(attempt));
  const exp = Math.min(maxMs, baseMs * factor ** n);
  const j = Math.min(1, Math.max(0, jitter));
  return Math.round(exp * (1 - j) + exp * j * random());
}
