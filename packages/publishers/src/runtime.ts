/**
 * Injectable runtime primitives. Everything that touches the outside world
 * (network, time, randomness) goes through these so tests are fast and
 * deterministic and the package runs unchanged in workerd, Node and browsers.
 */

/** Minimal `fetch` signature; `globalThis.fetch` satisfies it. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

export type Sleep = (ms: number) => Promise<void>;

/** Returns a float in [0, 1). Used for backoff jitter. */
export type Random = () => number;

/**
 * Structured, already-redacted log events. Tokens never reach the logger:
 * the Graph client only reports method, host, path (ids, no query string),
 * status and timing.
 */
export interface LogEvent {
  level: "debug" | "info" | "warn" | "error";
  event: string;
  data?: Record<string, unknown>;
}
export type Logger = (event: LogEvent) => void;

export const systemClock: Clock = { now: () => Date.now() };

export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

export const defaultRandom: Random = () => Math.random();

export const noopLogger: Logger = () => {};

/** Lazily bind the global fetch so a test can still swap `globalThis.fetch`. */
export const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);
