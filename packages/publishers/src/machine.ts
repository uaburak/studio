/**
 * Resumable state machine plumbing shared by the Instagram and Facebook
 * publishers.
 *
 * Contract for the driver (the future scheduler / durable workflow):
 *
 *   let state = publisher.start(request);          // pure, validates
 *   persist(state);
 *   loop:
 *     const out = await publisher.step(state, ctx);  // at most one remote mutation
 *     persist(out.state);                           // BEFORE acting on `out`
 *     switch (out.status) {
 *       case "continue": run the next step now
 *       case "wait":     run the next step at `out.resumeAt` (epoch ms)
 *       case "done":     record `out.result`
 *       case "failed":   record `out.error`; if `out.error.retryable`, the
 *                        same state can be stepped again later
 *     }
 *
 * Every step takes a JSON state and returns a new JSON state (the input is
 * never mutated). A step performs at most one non-idempotent Graph call, and
 * every publish step first reconciles against the platform, so re-running a
 * step after a crash (with the last persisted state) never publishes twice.
 */

import {
  GraphError,
  PublishError,
  type PublishErrorData,
  publishError,
  toPublishError,
} from "./errors.ts";
import type { GraphClient } from "./graph/client.ts";
import type {
  MediaReader,
  PublishKind,
  PublishPlatform,
  PublishRequest,
  PublishResult,
  PublishWarning,
} from "./models.ts";
import type { Clock, Sleep } from "./runtime.ts";
import { type ValidationReport, validateRequest } from "./validation/index.ts";

export const STATE_VERSION = 1;

export interface StepContext {
  /**
   * Instagram: the user access token (a Page token of the linked Page also
   * works). Facebook: the Page access token. Never stored in state.
   */
  accessToken: string;
  /** Required for `{ type: "upload" }` video sources. */
  media?: MediaReader;
}

export type StepOutcome<S> =
  | { status: "continue"; state: S }
  | { status: "wait"; state: S; resumeAt: number; reason: "poll" | "retry" }
  | { status: "done"; state: S; result: PublishResult }
  | { status: "failed"; state: S; error: PublishErrorData };

export interface MachineOptions {
  /** Container/video status polling cadence. Meta: "once per minute". */
  pollIntervalMs: number;
  /** Give up polling after this long. Meta: "for no more than 5 minutes". */
  pollTimeoutMs: number;
  /** Consecutive transient failures tolerated in one phase before failing. */
  maxStepRetries: number;
  /** Base delay for state-level retries (doubles each time, capped at 15 min). */
  retryDelayMs: number;
  /** How many times an expired/failed container is recreated automatically. */
  maxRecreations: number;
  /** Clock skew allowance when matching posts during crash recovery. */
  reconcileSkewMs: number;
  /**
   * Split pushed uploads (rupload) into requests of at most this many bytes.
   * Default `undefined` sends the remaining bytes in one streamed request,
   * which is what Meta documents. Chunked rupload is not documented.
   */
  uploadChunkBytes?: number;
}

export const DEFAULT_MACHINE_OPTIONS: MachineOptions = {
  pollIntervalMs: 60_000,
  pollTimeoutMs: 5 * 60_000,
  maxStepRetries: 5,
  retryDelayMs: 30_000,
  maxRecreations: 1,
  reconcileSkewMs: 30_000,
};

export interface PublisherDeps {
  graph: GraphClient;
  clock: Clock;
  options: MachineOptions;
}

/** Fields every state carries. Phase-specific data lives in the subtypes. */
export interface BaseState<K extends PublishKind, R extends PublishRequest, P extends string> {
  v: typeof STATE_VERSION;
  kind: K;
  request: R;
  phase: P | "done" | "failed";
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
  /**
   * Set (and persisted) before the first publish call can happen. Its
   * presence means "a publish may already have reached Meta"; recovery
   * matches posts created after it.
   */
  intentAt: number | null;
  poll: { startedAt: number; count: number } | null;
  /** Consecutive transient failures in the current phase. */
  retries: number;
  lastError: PublishErrorData | null;
  warnings: PublishWarning[];
  result: PublishResult | null;
}

export interface Publisher<R extends PublishRequest = PublishRequest, S = unknown> {
  readonly platform: PublishPlatform | "any";
  validate(request: unknown): ValidationReport;
  /** Validate and build the initial state. Throws `PublishError` (VALIDATION_FAILED). */
  start(request: R): S;
  step(state: S, ctx: StepContext): Promise<StepOutcome<S>>;
}

/** Validate input and throw a PublishError listing every blocking issue. */
export function assertValid(request: unknown): ValidationReport {
  const report = validateRequest(request);
  if (!report.ok) {
    throw new PublishError(
      publishError("VALIDATION_FAILED", report.errors.map((e) => e.message).join(" "), {
        issues: report.errors.map(({ code, message, path }) => ({ code, message, path })),
      }),
    );
  }
  return report;
}

export function initialBase<K extends PublishKind, R extends PublishRequest, P extends string>(
  kind: K,
  request: R,
  phase: P,
  now: number,
  report: ValidationReport,
): BaseState<K, R, P> {
  return {
    v: STATE_VERSION,
    kind,
    request,
    phase,
    createdAt: now,
    updatedAt: now,
    intentAt: null,
    poll: null,
    retries: 0,
    lastError: null,
    warnings: report.warnings.map((w) => ({ code: w.code, message: w.message })),
    result: null,
  };
}

/** Thrown by a phase to say "not ready yet, poll again". */
export class PollSignal {
  constructor(readonly reason: string) {}
}

type AnyState = BaseState<PublishKind, PublishRequest, string>;

/**
 * Wrap a phase handler with the shared rules: clone state, terminal phases,
 * polling, error mapping, retry scheduling and phase bookkeeping.
 */
export async function runStep<S extends AnyState>(
  deps: PublisherDeps,
  input: S,
  ctx: StepContext,
  handler: (state: S) => Promise<void>,
): Promise<StepOutcome<S>> {
  if (!input || input.v !== STATE_VERSION) {
    const error = publishError(
      "INVALID_STATE",
      "Yayın durumu okunamadı ya da eski bir sürüme ait.",
    );
    return { status: "failed", state: input, error };
  }
  const state = structuredClone(input);
  const now = deps.clock.now();
  state.updatedAt = now;

  if (state.phase === "done" && state.result)
    return { status: "done", state, result: state.result };
  if (state.phase === "failed") {
    const error =
      state.lastError ?? publishError("INVALID_STATE", "Yayın başarısız olarak işaretlenmiş.");
    return { status: "failed", state, error };
  }

  const phaseBefore = state.phase;
  try {
    await handler(state);
  } catch (err) {
    if (err instanceof PollSignal) return pollOutcome(deps, state, now);
    return errorOutcome(deps, state, err, now, ctx);
  }
  if (state.phase !== phaseBefore) {
    state.retries = 0;
    state.poll = null;
  }
  state.lastError = null;
  if (state.phase === "done" && state.result)
    return { status: "done", state, result: state.result };
  return { status: "continue", state };
}

function pollOutcome<S extends AnyState>(
  deps: PublisherDeps,
  state: S,
  now: number,
): StepOutcome<S> {
  const { pollIntervalMs, pollTimeoutMs } = deps.options;
  state.poll ??= { startedAt: now, count: 0 };
  if (now - state.poll.startedAt >= pollTimeoutMs) {
    // Keep the phase: a later resume gets a fresh polling window.
    state.poll = null;
    const error = publishError(
      "PROCESSING_TIMEOUT",
      "Meta medyayı beklenen sürede işlemedi; daha sonra yeniden denenebilir.",
    );
    state.lastError = error;
    return { status: "failed", state, error };
  }
  state.poll.count += 1;
  state.retries = 0;
  return { status: "wait", state, resumeAt: now + pollIntervalMs, reason: "poll" };
}

function errorOutcome<S extends AnyState>(
  deps: PublisherDeps,
  state: S,
  err: unknown,
  now: number,
  ctx: StepContext,
): StepOutcome<S> {
  const error = toPublishError(err, [ctx.accessToken]);
  state.lastError = error;
  if (error.action === "retry" && error.code !== "PROCESSING_TIMEOUT") {
    if (state.retries < deps.options.maxStepRetries) {
      state.retries += 1;
      const backoff = Math.min(15 * 60_000, deps.options.retryDelayMs * 2 ** (state.retries - 1));
      const wait = Math.max(backoff, error.retryAfterMs ?? 0);
      return { status: "wait", state, resumeAt: now + wait, reason: "retry" };
    }
    // Out of automatic retries: keep the phase so a manual retry resumes here
    // with a fresh retry budget.
    state.retries = 0;
    return { status: "failed", state, error };
  }
  if (error.action === "reauth" || error.action === "wait_quota") {
    // Resumable once the account is reconnected or quota frees up.
    return { status: "failed", state, error };
  }
  state.phase = "failed";
  return { status: "failed", state, error };
}

/** Throw a GraphError-backed failure as-is; anything else becomes a PublishError. */
export function fail(
  code: Parameters<typeof publishError>[0],
  message: string,
  extra?: Parameters<typeof publishError>[2],
): never {
  throw new PublishError(publishError(code, message, extra));
}

export function isGraphError(err: unknown): err is GraphError {
  return err instanceof GraphError;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Parse Meta timestamps such as `2026-11-16T10:00:00+0000`. */
export function parseMetaTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const normalised = value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2");
  const t = Date.parse(normalised);
  return Number.isNaN(t) ? null : t;
}

export function normaliseText(s: string | undefined | null): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

// --- media bytes -------------------------------------------------------------------

/** Read a byte range from the caller's MediaReader as a fetch body. */
export async function readRange(
  ctx: StepContext,
  key: string,
  offset: number,
  length: number,
): Promise<BodyInit> {
  if (!ctx.media) {
    fail(
      "MEDIA_SOURCE_MISSING",
      "Video dosyası okunamadı: yükleme kaynağı (MediaReader) verilmedi.",
      {
        action: "manual_check",
      },
    );
  }
  const data = await ctx.media.read(key, { offset, length });
  if (data instanceof ReadableStream || data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return data;
  return data as Uint8Array<ArrayBuffer>;
}

/** Same as readRange but materialised as a Blob (multipart chunk uploads). */
export async function readRangeBlob(
  ctx: StepContext,
  key: string,
  offset: number,
  length: number,
): Promise<Blob> {
  const body = await readRange(ctx, key, offset, length);
  if (body instanceof Blob) return body;
  return new Response(body).blob();
}

// --- driver ----------------------------------------------------------------------------

export interface RunOptions<S> {
  clock: Clock;
  sleep: Sleep;
  /** Called with every new state before acting on it (persist here). */
  onState?: (state: S, outcome: StepOutcome<S>) => void | Promise<void>;
  /** Safety valve against bugs. */
  maxSteps?: number;
}

/**
 * Convenience driver for tests, scripts and the Mac worker: loops `step`
 * and sleeps through `wait` outcomes. A Workers scheduler should instead
 * persist the state and schedule itself for `resumeAt`.
 */
export async function runToCompletion<S>(
  publisher: Pick<Publisher<PublishRequest, S>, "step">,
  initial: S,
  ctx: StepContext,
  opts: RunOptions<S>,
): Promise<StepOutcome<S>> {
  let state = initial;
  const max = opts.maxSteps ?? 500;
  for (let i = 0; i < max; i++) {
    const out = await publisher.step(state, ctx);
    await opts.onState?.(out.state, out);
    state = out.state;
    if (out.status === "done" || out.status === "failed") return out;
    if (out.status === "wait") await opts.sleep(Math.max(0, out.resumeAt - opts.clock.now()));
  }
  throw new Error(`runToCompletion: exceeded ${max} steps`);
}
