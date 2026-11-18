/**
 * A small, runtime-agnostic Graph API client.
 *
 * - Versioned base URLs (graph, graph-video, rupload).
 * - The access token is passed per call and sent as `Authorization: OAuth`,
 *   so it never appears in a URL. It is redacted from every error and log.
 * - Typed error parsing (code, subcode, is_transient, fbtrace_id).
 * - Retry with exponential backoff and jitter on transient errors and rate
 *   limits. Non-idempotent calls are retried only when Meta rejected them
 *   before executing (rate limits); anything ambiguous is surfaced to the
 *   state machine, which reconciles before trying again.
 * - `fetch`, clock, sleep and randomness are injectable.
 */

import { classifyGraphError, GraphError, type GraphErrorInfo } from "../errors.ts";
import { redact } from "../redact.ts";
import {
  type Clock,
  defaultRandom,
  type FetchLike,
  globalFetch,
  type Logger,
  noopLogger,
  type Random,
  realSleep,
  type Sleep,
  systemClock,
} from "../runtime.ts";
import { encodeParamPairs, type Params, toSearchParams } from "./encode.ts";

/** Graph API version this package was written and tested against (current on 2026-11-04). */
export const GRAPH_API_VERSION = "v27.0";

export interface GraphHosts {
  graph: string;
  graphVideo: string;
  rupload: string;
}

export const DEFAULT_GRAPH_HOSTS: GraphHosts = {
  graph: "https://graph.facebook.com",
  graphVideo: "https://graph-video.facebook.com",
  rupload: "https://rupload.facebook.com",
};

export interface RetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Longest wait the client will sleep through inline. Longer waits (e.g. a
   * rate limit that resets in 10 minutes) are thrown with `retryAfterMs` so
   * the caller can persist state and come back later instead of holding a
   * Worker invocation open.
   */
  maxInlineWaitMs: number;
}

/** One Graph call gives up after this long; a call with a body (upload) after `DEFAULT_UPLOAD_TIMEOUT_MS`. */
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_UPLOAD_TIMEOUT_MS = 10 * 60_000;

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxInlineWaitMs: 60_000,
};

export interface GraphClientOptions {
  version?: string;
  hosts?: Partial<GraphHosts>;
  fetch?: FetchLike;
  clock?: Clock;
  sleep?: Sleep;
  random?: Random;
  logger?: Logger;
  retry?: Partial<RetryPolicy>;
  /**
   * Per-call timeouts (ms). A call that times out is a network error: an idempotent one is
   * retried, a non-idempotent one goes back to the state machine, which reconciles first.
   */
  timeoutMs?: number;
  uploadTimeoutMs?: number;
  /**
   * When set, every call carrying an access token also sends
   * `appsecret_proof` (HMAC-SHA256 of the token keyed by the app secret).
   * Needed if "Require App Secret" is enabled in the Meta app.
   */
  appSecret?: string;
}

export interface GraphRequest {
  method: "GET" | "POST" | "DELETE";
  /**
   * Path after the version, e.g. `/123/media`. With `versioned: false` it is
   * the full path (rupload). An absolute `https://*.facebook.com/...` URL is
   * also accepted (Meta-provided `upload_url`).
   */
  path: string;
  host?: keyof GraphHosts;
  versioned?: boolean;
  query?: Params;
  form?: Params;
  json?: unknown;
  multipart?: Record<string, string | Blob>;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Sent as `Authorization: OAuth <token>`; never put in the URL. */
  accessToken?: string;
  /**
   * Whether repeating the call is harmless. Reads and uploads-to-offset are
   * idempotent; creating containers or publishing are not.
   */
  idempotent: boolean;
  /** Keys encoded as `key[0]=...` instead of a JSON array. */
  indexedArrays?: readonly string[];
  /** Extra secrets (app secret, input tokens) to redact from errors. */
  secrets?: readonly (string | undefined)[];
  /** Override the client's retry policy for this call. */
  retry?: Partial<RetryPolicy>;
}

export interface GraphResponse<T> {
  data: T;
  status: number;
  headers: Headers;
}

const META_HOST_RE = /(^|\.)facebook\.com$/;

export class GraphClient {
  readonly version: string;
  readonly hosts: GraphHosts;
  private readonly fetchImpl: FetchLike;
  readonly clock: Clock;
  readonly sleep: Sleep;
  private readonly random: Random;
  private readonly logger: Logger;
  private readonly retry: RetryPolicy;
  private readonly appSecret: string | undefined;
  private readonly timeoutMs: number;
  private readonly uploadTimeoutMs: number;
  private readonly proofCache = new Map<string, string>();

  constructor(options: GraphClientOptions = {}) {
    this.version = options.version ?? GRAPH_API_VERSION;
    this.hosts = { ...DEFAULT_GRAPH_HOSTS, ...options.hosts };
    this.fetchImpl = options.fetch ?? globalFetch;
    this.clock = options.clock ?? systemClock;
    this.sleep = options.sleep ?? realSleep;
    this.random = options.random ?? defaultRandom;
    this.logger = options.logger ?? noopLogger;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.appSecret = options.appSecret;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.uploadTimeoutMs = options.uploadTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  async get<T>(
    path: string,
    query: Params,
    accessToken: string | undefined,
    extra: Partial<GraphRequest> = {},
  ) {
    return (
      await this.request<T>({ method: "GET", path, query, accessToken, idempotent: true, ...extra })
    ).data;
  }

  /** Build the URL (without secrets) for a request. */
  url(req: Pick<GraphRequest, "path" | "host" | "versioned">): URL {
    if (/^https?:\/\//.test(req.path)) {
      const u = new URL(req.path);
      if (u.protocol !== "https:" || !META_HOST_RE.test(u.hostname)) {
        // Never send a token to a host a response suggested unless it is Meta's.
        throw new Error(`Refusing non-Meta upload URL host: ${u.hostname}`);
      }
      return u;
    }
    const base = this.hosts[req.host ?? "graph"];
    const versioned = req.versioned ?? true;
    const path = req.path.startsWith("/") ? req.path : `/${req.path}`;
    return new URL(`${base}${versioned ? `/${this.version}` : ""}${path}`);
  }

  async request<T>(req: GraphRequest): Promise<GraphResponse<T>> {
    const policy = { ...this.retry, ...req.retry };
    // A stream can be read only once; the state machine re-opens it from the
    // server-reported offset instead of retrying here.
    if (req.body instanceof ReadableStream) policy.maxAttempts = 1;
    const secrets = [req.accessToken, this.appSecret, ...(req.secrets ?? [])];
    const url = this.url(req);
    const label = `${req.method} ${url.host}${url.pathname}`;

    const query = { ...req.query };
    if (req.accessToken && this.appSecret) {
      query.appsecret_proof = await this.proof(req.accessToken);
    }
    for (const [k, v] of encodeParamPairs(query, req.indexedArrays)) url.searchParams.append(k, v);

    for (let attempt = 1; ; attempt++) {
      const init = this.buildInit(req);
      init.signal = AbortSignal.timeout(
        req.body !== undefined || req.multipart !== undefined
          ? this.uploadTimeoutMs
          : this.timeoutMs,
      );
      const started = this.clock.now();
      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), init);
      } catch (cause) {
        const err = new GraphError(
          this.info({
            httpStatus: null,
            body: null,
            request: label,
            secrets,
            fallbackMessage: redact(
              cause instanceof Error ? cause.message : String(cause),
              secrets,
            ),
          }),
        );
        this.log("warn", "graph.network_error", { request: label, attempt });
        if (!req.idempotent) throw err;
        if (!(await this.backoff(err, attempt, policy, label))) throw err;
        continue;
      }

      const text = await response.text();
      const body = parseJson(text);
      const elapsed = this.clock.now() - started;
      const graphError = isErrorBody(body);
      if (response.ok && !graphError) {
        this.log("debug", "graph.request", {
          request: label,
          status: response.status,
          attempt,
          ms: elapsed,
        });
        return { data: body as T, status: response.status, headers: response.headers };
      }

      const info = this.info({
        httpStatus: response.status,
        body,
        request: label,
        secrets,
        headers: response.headers,
        fallbackMessage: redact(text.slice(0, 300), secrets),
      });
      const err = new GraphError(info);
      this.log("warn", "graph.error", {
        request: label,
        status: response.status,
        code: info.code,
        subcode: info.subcode,
        category: info.category,
        fbtraceId: info.fbtraceId,
        attempt,
      });
      // A non-idempotent call that Meta rejected for throttling was not
      // executed, so retrying is safe. Anything else might have been applied.
      if (!req.idempotent && info.category !== "rate_limit") throw err;
      if (!(await this.backoff(err, attempt, policy, label))) throw err;
    }
  }

  /** Sleep before the next attempt; returns false when we should give up. */
  private async backoff(err: GraphError, attempt: number, policy: RetryPolicy, label: string) {
    const retryable = ["transient", "network", "rate_limit"].includes(err.info.category);
    if (!retryable || attempt >= policy.maxAttempts) return false;
    const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
    // "Equal jitter": half fixed, half random. Keeps a floor so we never hammer.
    const jittered = Math.round(exp / 2 + (exp / 2) * this.random());
    const delay = Math.max(jittered, err.info.retryAfterMs ?? 0);
    if (delay > policy.maxInlineWaitMs) {
      err.info.retryAfterMs = delay;
      return false;
    }
    this.log("info", "graph.retry", {
      request: label,
      attempt,
      delayMs: delay,
      category: err.info.category,
    });
    await this.sleep(delay);
    return true;
  }

  private buildInit(req: GraphRequest): RequestInit & { duplex?: "half" } {
    const headers = new Headers(req.headers);
    if (req.accessToken) headers.set("Authorization", `OAuth ${req.accessToken}`);
    let body: BodyInit | undefined;
    if (req.form) {
      body = toSearchParams(req.form, req.indexedArrays);
    } else if (req.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(req.json);
    } else if (req.multipart) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(req.multipart)) fd.append(k, v);
      body = fd;
    } else if (req.body !== undefined) {
      body = req.body;
    }
    const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
    if (body !== undefined) init.body = body;
    // Streaming request bodies need `duplex: "half"` in Node/undici; workerd ignores it.
    if (body instanceof ReadableStream) init.duplex = "half";
    return init;
  }

  private info(args: {
    httpStatus: number | null;
    body: unknown;
    request: string;
    secrets: readonly (string | undefined)[];
    headers?: Headers;
    fallbackMessage: string;
  }): GraphErrorInfo {
    const e = extractError(args.body);
    const code = e.code;
    const subcode = e.subcode;
    const isTransient = e.isTransient;
    const r = (s: string | null) => (s === null ? null : redact(s, args.secrets));
    const partial = { httpStatus: args.httpStatus, code, subcode, isTransient };
    return {
      ...partial,
      type: e.type,
      message: r(e.message) ?? args.fallbackMessage,
      userTitle: r(e.userTitle),
      userMessage: r(e.userMessage),
      fbtraceId: e.fbtraceId,
      category: classifyGraphError(partial),
      retryAfterMs: args.headers ? retryAfterFromHeaders(args.headers) : null,
      request: args.request,
    };
  }

  private async proof(token: string): Promise<string> {
    const cached = this.proofCache.get(token);
    if (cached) return cached;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(this.appSecret ?? ""),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(token)));
    const hex = Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
    this.proofCache.set(token, hex);
    return hex;
  }

  private log(
    level: "debug" | "info" | "warn" | "error",
    event: string,
    data: Record<string, unknown>,
  ) {
    this.logger({ level, event, data });
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isErrorBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (b.error && typeof b.error === "object") return true;
  // rupload failure shape: {"debug_info": {"retriable": false, "type": "...", "message": "..."}}
  return !!b.debug_info && typeof b.debug_info === "object" && b.success !== true;
}

interface ExtractedError {
  code: number | null;
  subcode: number | null;
  type: string | null;
  message: string | null;
  userTitle: string | null;
  userMessage: string | null;
  fbtraceId: string | null;
  isTransient: boolean;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  return null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function extractError(body: unknown): ExtractedError {
  const empty: ExtractedError = {
    code: null,
    subcode: null,
    type: null,
    message: null,
    userTitle: null,
    userMessage: null,
    fbtraceId: null,
    isTransient: false,
  };
  if (!body || typeof body !== "object") return empty;
  const b = body as Record<string, unknown>;
  if (b.error && typeof b.error === "object") {
    const e = b.error as Record<string, unknown>;
    return {
      code: num(e.code),
      subcode: num(e.error_subcode),
      type: str(e.type),
      message: str(e.message),
      userTitle: str(e.error_user_title),
      userMessage: str(e.error_user_msg),
      fbtraceId: str(e.fbtrace_id),
      isTransient: e.is_transient === true,
    };
  }
  if (b.debug_info && typeof b.debug_info === "object") {
    const d = b.debug_info as Record<string, unknown>;
    return {
      ...empty,
      type: str(d.type),
      message: str(d.message),
      isTransient: d.retriable === true,
    };
  }
  return empty;
}

/**
 * Meta reports throttling recovery in `X-Business-Use-Case-Usage`
 * (`estimated_time_to_regain_access`, minutes); generic HTTP uses `Retry-After`.
 */
export function retryAfterFromHeaders(headers: Headers): number | null {
  let best: number | null = null;
  const retryAfter = headers.get("retry-after");
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) best = Number(retryAfter.trim()) * 1000;
  const buc = headers.get("x-business-use-case-usage");
  if (buc) {
    try {
      const parsed = JSON.parse(buc) as Record<
        string,
        { estimated_time_to_regain_access?: number }[]
      >;
      for (const entries of Object.values(parsed)) {
        for (const entry of Array.isArray(entries) ? entries : []) {
          const minutes = entry?.estimated_time_to_regain_access;
          if (typeof minutes === "number" && minutes > 0) {
            best = Math.max(best ?? 0, minutes * 60_000);
          }
        }
      }
    } catch {
      // Malformed header: ignore, fall back to backoff.
    }
  }
  return best;
}
