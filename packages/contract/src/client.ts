import type { z } from "zod";
import { Asset, AssetList, type AssetListQuery, type AssetUploadFields } from "./asset.ts";
import {
  Brand,
  type BrandCreate,
  BrandList,
  type BrandListQuery,
  type BrandUpdate,
} from "./brand.ts";
import {
  BrandProfile,
  type BrandProfileCreate,
  BrandProfileList,
  type BrandProfileListQuery,
  type BrandProfileUpdate,
} from "./brand-profile.ts";
import {
  AgentRun,
  AgentRunList,
  type AgentRunListQuery,
  Conversation,
  type ConversationCreate,
  ConversationList,
  type ConversationListQuery,
  type ConversationUpdate,
  MessageList,
  type MessageListQuery,
  type PlanProposalPut,
  PlanProposalResult,
  type QuestionAnswerCreate,
  QuestionAnswerResult,
  type RunComplete,
  type RunFail,
  TurnContext,
  type TurnOps,
  TurnWriteResult,
  type UserMessageCreate,
  UserMessageResult,
} from "./chat.ts";
import {
  ConversationAlias,
  ConversationAliasList,
  type ConversationAliasUpdate,
} from "./chat-alias.ts";
import {
  type ConversationStreamMessage,
  type ConversationStreamQuery,
  decodeConversationStreamMessage,
} from "./chat-stream.ts";
import { ApiErrorBody, type ErrorCode, type ErrorIssue } from "./common.ts";
import {
  Content,
  type ContentCreate,
  ContentList,
  type ContentListQuery,
  type ContentTransition,
  type ContentUpdate,
  ContentVersion,
  type ContentVersionCreate,
  ContentVersionList,
  type ContentVersionListQuery,
  type ContentVersionUpdate,
} from "./content.ts";
import { HealthResponse } from "./health.ts";
import {
  Job,
  type JobCreate,
  JobList,
  type JobListQuery,
  type JobStreamQuery,
  WorkerPresence,
} from "./job.ts";
import {
  Plan,
  type PlanAccept,
  type PlanGenerate,
  PlanGenerateResult,
  PlanList,
  type PlanListQuery,
  type PlanReject,
  type PlanUpdate,
} from "./plan.ts";
import { decodeJobStreamMessage, type JobStreamMessage } from "./protocol.ts";
import {
  PublishLogList,
  type PublishLogListQuery,
  Schedule,
  type ScheduleCreate,
  ScheduleList,
  type ScheduleListQuery,
} from "./schedule.ts";
import {
  SocialAccount,
  type SocialAccountCreate,
  SocialAccountList,
  type SocialAccountListQuery,
  type SocialAccountUpdate,
} from "./social-account.ts";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Present when the server answered with the contract error shape. */
    readonly code?: ErrorCode,
    readonly issues?: ErrorIssue[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiClientOptions {
  /** Base URL of the API, e.g. "" (same origin) or "http://localhost:8787". */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** WebSocket implementation for `jobs.watch` (defaults to the global one). */
  WebSocket?: typeof WebSocket;
  /**
   * Mac worker only: sent as `Authorization: Bearer <token>` on every request
   * (needed by the `workerTurns` methods). Never set this in a UI client.
   */
  workerToken?: string;
}

export type JobWatchStatus = "connecting" | "open" | "closed";

export interface JobWatchHandlers {
  /** Every decoded stream frame; a `jobs.snapshot` follows each (re)connect. */
  onMessage: (message: JobStreamMessage) => void;
  onStatus?: (status: JobWatchStatus) => void;
}

export interface JobWatchOptions {
  /** Reconnect automatically after a drop (default true). */
  reconnect?: boolean;
  /** First reconnect delay; doubles up to 30 s (default 1000). */
  reconnectDelayMs?: number;
}

export interface JobWatch {
  /** Stop watching; no further reconnects. */
  close(): void;
}

export interface ConversationWatchHandlers {
  /**
   * Every decoded frame. After each (re)connect either a
   * `conversation.snapshot` or the missed events + `conversation.resumed`
   * arrive first; feed them to `applyConversationStreamMessage`.
   */
  onMessage: (message: ConversationStreamMessage) => void;
  onStatus?: (status: JobWatchStatus) => void;
}

export interface ConversationWatchOptions extends JobWatchOptions {
  /** Last seq already applied (e.g. from a cached state); resumes from there. */
  after?: number;
}

export interface ConversationWatch extends JobWatch {
  /** Highest seq seen so far (used as `after` on reconnect). */
  readonly lastSeq: number | undefined;
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Query | undefined;
  json?: unknown;
  form?: FormData;
  init?: RequestInit | undefined;
}

/** Fields for `assets.upload`; `file` is any Blob (a `File` keeps its name). */
export type AssetUploadInput = AssetUploadFields & { file: Blob; filename?: string };

const enc = encodeURIComponent;

/**
 * Typed client for the Studio API. Every response is validated against the
 * contract schema, so a server/client mismatch fails loudly instead of
 * silently. Non-2xx responses throw `ApiError` with the server's `code`.
 */
export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);

  function url(path: string, query?: Query): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) params.set(key, String(value));
    }
    const qs = params.toString();
    return `${baseUrl}${path}${qs ? `?${qs}` : ""}`;
  }

  async function send(path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers = new Headers(opts.init?.headers);
    headers.set("accept", "application/json");
    if (options.workerToken && !headers.has("authorization")) {
      headers.set("authorization", `Bearer ${options.workerToken}`);
    }
    let body: FormData | string | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(opts.json);
    }
    const res = await doFetch(url(path, opts.query), {
      ...opts.init,
      method: opts.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    if (!res.ok) {
      const parsed = ApiErrorBody.safeParse(await res.json().catch(() => null));
      if (parsed.success) {
        const { code, message, issues } = parsed.data.error;
        throw new ApiError(`${path}: ${message}`, res.status, code, issues);
      }
      throw new ApiError(`${path} returned HTTP ${res.status}`, res.status);
    }
    return res;
  }

  async function call<S extends z.ZodType>(
    schema: S,
    path: string,
    opts?: RequestOptions,
  ): Promise<z.output<S>> {
    const res = await send(path, opts);
    const parsed = schema.safeParse(await res.json());
    if (!parsed.success) {
      throw new ApiError(`${path} response does not match the contract`, res.status);
    }
    return parsed.data;
  }

  const q = (query: object | undefined) => query as Query | undefined;

  /** http(s) -> ws(s); relative URLs resolve against `location` when there is one. */
  function wsUrl(httpUrl: string): string {
    const loc = (globalThis as { location?: { href: string } }).location;
    if (!/^https?:/i.test(httpUrl)) {
      if (!loc) return httpUrl;
      httpUrl = new URL(httpUrl, loc.href).toString();
    }
    return httpUrl.replace(/^http/i, "ws");
  }

  function watchStream(
    target: string,
    handlers: JobWatchHandlers,
    opts: JobWatchOptions,
  ): JobWatch {
    return openSocketLoop(() => target, decodeJobStreamMessage, handlers, opts);
  }

  /** Reconnecting WebSocket loop shared by the job and conversation streams. */
  function openSocketLoop<M>(
    target: () => string,
    decode: (raw: unknown) => { ok: true; message: M } | { ok: false; error: string },
    handlers: { onMessage: (message: M) => void; onStatus?: (status: JobWatchStatus) => void },
    opts: JobWatchOptions,
  ): JobWatch {
    const Impl = options.WebSocket ?? globalThis.WebSocket;
    if (!Impl) throw new ApiError("no WebSocket implementation available");
    const reconnect = opts.reconnect ?? true;
    const baseDelay = opts.reconnectDelayMs ?? 1000;
    let delay = baseDelay;
    let closed = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      if (closed) return;
      handlers.onStatus?.("connecting");
      const ws = new Impl(target());
      socket = ws;
      ws.addEventListener("open", () => {
        delay = baseDelay;
        handlers.onStatus?.("open");
      });
      ws.addEventListener("message", (event: MessageEvent) => {
        const decoded = decode(event.data);
        if (decoded.ok) handlers.onMessage(decoded.message);
      });
      ws.addEventListener("close", () => {
        if (socket !== ws) return;
        socket = undefined;
        handlers.onStatus?.("closed");
        if (closed || !reconnect) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      });
    };
    connect();

    return {
      close() {
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
        socket?.close(1000, "client closed");
      },
    };
  }

  function watchConversation(
    id: string,
    handlers: ConversationWatchHandlers,
    opts: ConversationWatchOptions,
  ): ConversationWatch {
    let lastSeq = opts.after;
    const loop = openSocketLoop(
      () =>
        wsUrl(
          url(
            `/api/conversations/${enc(id)}/stream`,
            lastSeq !== undefined ? { after: lastSeq } : {},
          ),
        ),
      decodeConversationStreamMessage,
      {
        onMessage: (message) => {
          if ("seq" in message && (lastSeq === undefined || message.seq > lastSeq)) {
            lastSeq = message.seq;
          }
          handlers.onMessage(message);
        },
        ...(handlers.onStatus ? { onStatus: handlers.onStatus } : {}),
      },
      opts,
    );
    return {
      close: () => loop.close(),
      get lastSeq() {
        return lastSeq;
      },
    };
  }

  return {
    async health(init?: RequestInit): Promise<HealthResponse> {
      return call(HealthResponse, "/api/health", { init });
    },

    brands: {
      list: (query?: BrandListQuery, init?: RequestInit) =>
        call(BrandList, "/api/brands", { query: q(query), init }),
      get: (id: string, init?: RequestInit) => call(Brand, `/api/brands/${enc(id)}`, { init }),
      create: (input: BrandCreate, init?: RequestInit) =>
        call(Brand, "/api/brands", { method: "POST", json: input, init }),
      update: (id: string, input: BrandUpdate, init?: RequestInit) =>
        call(Brand, `/api/brands/${enc(id)}`, { method: "PATCH", json: input, init }),
    },

    brandProfiles: {
      list: (brandId: string, query?: BrandProfileListQuery, init?: RequestInit) =>
        call(BrandProfileList, `/api/brands/${enc(brandId)}/profiles`, { query: q(query), init }),
      /** Throws ApiError 404 when the brand has no approved profile yet. */
      current: (brandId: string, init?: RequestInit) =>
        call(BrandProfile, `/api/brands/${enc(brandId)}/profiles/current`, { init }),
      get: (brandId: string, version: number, init?: RequestInit) =>
        call(BrandProfile, `/api/brands/${enc(brandId)}/profiles/${version}`, { init }),
      create: (brandId: string, input: BrandProfileCreate = {}, init?: RequestInit) =>
        call(BrandProfile, `/api/brands/${enc(brandId)}/profiles`, {
          method: "POST",
          json: input,
          init,
        }),
      update: (brandId: string, version: number, input: BrandProfileUpdate, init?: RequestInit) =>
        call(BrandProfile, `/api/brands/${enc(brandId)}/profiles/${version}`, {
          method: "PATCH",
          json: input,
          init,
        }),
      approve: (brandId: string, version: number, init?: RequestInit) =>
        call(BrandProfile, `/api/brands/${enc(brandId)}/profiles/${version}/approve`, {
          method: "POST",
          init,
        }),
    },

    socialAccounts: {
      list: (query?: SocialAccountListQuery, init?: RequestInit) =>
        call(SocialAccountList, "/api/social-accounts", { query: q(query), init }),
      get: (id: string, init?: RequestInit) =>
        call(SocialAccount, `/api/social-accounts/${enc(id)}`, { init }),
      create: (input: SocialAccountCreate, init?: RequestInit) =>
        call(SocialAccount, "/api/social-accounts", { method: "POST", json: input, init }),
      update: (id: string, input: SocialAccountUpdate, init?: RequestInit) =>
        call(SocialAccount, `/api/social-accounts/${enc(id)}`, {
          method: "PATCH",
          json: input,
          init,
        }),
    },

    assets: {
      list: (query?: AssetListQuery, init?: RequestInit) =>
        call(AssetList, "/api/assets", { query: q(query), init }),
      get: (id: string, init?: RequestInit) => call(Asset, `/api/assets/${enc(id)}`, { init }),
      upload: (input: AssetUploadInput, init?: RequestInit) => {
        const { file, filename, ...fields } = input;
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined && value !== null) form.set(key, String(value));
        }
        const name = filename ?? (file instanceof File ? file.name : "upload");
        form.set("file", file, name);
        return call(Asset, "/api/assets", { method: "POST", form, init });
      },
      /** URL that streams the stored bytes (usable as `<img src>`). */
      contentUrl: (id: string) => url(`/api/assets/${enc(id)}/content`),
    },

    contents: {
      list: (query?: ContentListQuery, init?: RequestInit) =>
        call(ContentList, "/api/contents", { query: q(query), init }),
      get: (id: string, init?: RequestInit) => call(Content, `/api/contents/${enc(id)}`, { init }),
      create: (input: ContentCreate, init?: RequestInit) =>
        call(Content, "/api/contents", { method: "POST", json: input, init }),
      update: (id: string, input: ContentUpdate, init?: RequestInit) =>
        call(Content, `/api/contents/${enc(id)}`, { method: "PATCH", json: input, init }),
      delete: async (id: string, init?: RequestInit): Promise<void> => {
        await send(`/api/contents/${enc(id)}`, { method: "DELETE", init });
      },
      /** Approve the current version; `hash` must equal its `contentHash`. */
      approve: (id: string, hash: string, init?: RequestInit) =>
        call(Content, `/api/contents/${enc(id)}/approve`, {
          method: "POST",
          json: { hash },
          init,
        }),
      transition: (id: string, to: ContentTransition["to"], init?: RequestInit) =>
        call(Content, `/api/contents/${enc(id)}/transition`, {
          method: "POST",
          json: { to },
          init,
        }),
      versions: {
        list: (contentId: string, query?: ContentVersionListQuery, init?: RequestInit) =>
          call(ContentVersionList, `/api/contents/${enc(contentId)}/versions`, {
            query: q(query),
            init,
          }),
        get: (contentId: string, version: number, init?: RequestInit) =>
          call(ContentVersion, `/api/contents/${enc(contentId)}/versions/${version}`, { init }),
        create: (contentId: string, input: ContentVersionCreate, init?: RequestInit) =>
          call(ContentVersion, `/api/contents/${enc(contentId)}/versions`, {
            method: "POST",
            json: input,
            init,
          }),
        update: (
          contentId: string,
          version: number,
          input: ContentVersionUpdate,
          init?: RequestInit,
        ) =>
          call(ContentVersion, `/api/contents/${enc(contentId)}/versions/${version}`, {
            method: "PATCH",
            json: input,
            init,
          }),
      },
    },

    jobs: {
      list: (query?: JobListQuery, init?: RequestInit) =>
        call(JobList, "/api/jobs", { query: q(query), init }),
      get: (id: string, init?: RequestInit) => call(Job, `/api/jobs/${enc(id)}`, { init }),
      create: (input: JobCreate, init?: RequestInit) =>
        call(Job, "/api/jobs", { method: "POST", json: input, init }),
      /**
       * Cancel a job. A queued job comes back `cancelled`; a running one comes
       * back still `running` with `cancelRequestedAt` set, and turns
       * `cancelled` once the worker confirms (watch the stream). 409 when the
       * job already finished.
       */
      cancel: (id: string, init?: RequestInit) =>
        call(Job, `/api/jobs/${enc(id)}/cancel`, { method: "POST", init }),
      /** WebSocket URL of the live job stream (relative when baseUrl is ""). */
      streamUrl: (query?: JobStreamQuery) => wsUrl(url("/api/jobs/stream", q(query))),
      /**
       * Follow one job (`{ jobId }`), one brand (`{ brandId }`) or every job
       * (`{}`) live. Reconnects with backoff; each connect starts with a
       * `jobs.snapshot` that replaces local state.
       */
      watch: (query: JobStreamQuery, handlers: JobWatchHandlers, opts: JobWatchOptions = {}) =>
        watchStream(wsUrl(url("/api/jobs/stream", q(query))), handlers, opts),
    },

    workers: {
      /** Is the Mac worker online, what is it running, how long is the queue. */
      presence: (init?: RequestInit) => call(WorkerPresence, "/api/workers/presence", { init }),
    },

    schedules: {
      list: (query?: ScheduleListQuery, init?: RequestInit) =>
        call(ScheduleList, "/api/schedules", { query: q(query), init }),
      get: (id: string, init?: RequestInit) =>
        call(Schedule, `/api/schedules/${enc(id)}`, { init }),
      create: (input: ScheduleCreate, init?: RequestInit) =>
        call(Schedule, "/api/schedules", { method: "POST", json: input, init }),
      cancel: (id: string, init?: RequestInit) =>
        call(Schedule, `/api/schedules/${enc(id)}/cancel`, { method: "POST", init }),
      logs: (id: string, query?: PublishLogListQuery, init?: RequestInit) =>
        call(PublishLogList, `/api/schedules/${enc(id)}/logs`, { query: q(query), init }),
    },

    conversations: {
      /** Most recently active first. */
      list: (query?: ConversationListQuery, init?: RequestInit) =>
        call(ConversationList, "/api/conversations", { query: q(query), init }),
      get: (id: string, init?: RequestInit) =>
        call(Conversation, `/api/conversations/${enc(id)}`, { init }),
      create: (input: ConversationCreate = {}, init?: RequestInit) =>
        call(Conversation, "/api/conversations", { method: "POST", json: input, init }),
      /** Rename, archive (`status: "archived"`), unarchive, or set the brand once. */
      update: (id: string, input: ConversationUpdate, init?: RequestInit) =>
        call(Conversation, `/api/conversations/${enc(id)}`, { method: "PATCH", json: input, init }),
      messages: {
        /** Newest first; pass `nextCursor` to load older messages. */
        list: (conversationId: string, query?: MessageListQuery, init?: RequestInit) =>
          call(MessageList, `/api/conversations/${enc(conversationId)}/messages`, {
            query: q(query),
            init,
          }),
        /**
         * Send a user message; starts an agent run (a `chat.turn` job). 409
         * `conflict` while another run is active. Retry with the same
         * `clientMessageId` after a network error.
         */
        send: (conversationId: string, input: UserMessageCreate, init?: RequestInit) =>
          call(UserMessageResult, `/api/conversations/${enc(conversationId)}/messages`, {
            method: "POST",
            json: input,
            init,
          }),
        /** Answer a `question` part of an assistant message. */
        answer: (
          conversationId: string,
          messageId: string,
          input: QuestionAnswerCreate,
          init?: RequestInit,
        ) =>
          call(
            QuestionAnswerResult,
            `/api/conversations/${enc(conversationId)}/messages/${enc(messageId)}/answer`,
            { method: "POST", json: input, init },
          ),
      },
      aliases: {
        /** Every attachment alias of the conversation, oldest first. */
        list: (conversationId: string, init?: RequestInit) =>
          call(ConversationAliasList, `/api/conversations/${enc(conversationId)}/aliases`, {
            init,
          }),
        /**
         * Rename an alias (by its stable id). 409 `conflict` when the name is
         * or was used by another alias of the conversation. Stored messages
         * keep their text; show names through `aliasId`.
         */
        rename: (
          conversationId: string,
          aliasId: string,
          input: ConversationAliasUpdate,
          init?: RequestInit,
        ) =>
          call(
            ConversationAlias,
            `/api/conversations/${enc(conversationId)}/aliases/${enc(aliasId)}`,
            { method: "PATCH", json: input, init },
          ),
      },
      runs: (conversationId: string, query?: AgentRunListQuery, init?: RequestInit) =>
        call(AgentRunList, `/api/conversations/${enc(conversationId)}/runs`, {
          query: q(query),
          init,
        }),
      /** WebSocket URL of the conversation stream. */
      streamUrl: (id: string, query?: ConversationStreamQuery) =>
        wsUrl(url(`/api/conversations/${enc(id)}/stream`, q(query))),
      /**
       * Follow a conversation live. Reconnects with backoff and resumes from
       * the last seq it saw (`?after=`), so no event is lost or applied twice.
       */
      watch: (
        id: string,
        handlers: ConversationWatchHandlers,
        opts: ConversationWatchOptions = {},
      ) => watchConversation(id, handlers, opts),
    },

    agentRuns: {
      get: (id: string, init?: RequestInit) =>
        call(AgentRun, `/api/agent-runs/${enc(id)}`, { init }),
      /** Cancel a queued or running run (and its job). 409 when it already finished. */
      cancel: (id: string, init?: RequestInit) =>
        call(AgentRun, `/api/agent-runs/${enc(id)}/cancel`, { method: "POST", init }),
    },

    plans: {
      list: (query?: PlanListQuery, init?: RequestInit) =>
        call(PlanList, "/api/plans", { query: q(query), init }),
      get: (id: string, init?: RequestInit) => call(Plan, `/api/plans/${enc(id)}`, { init }),
      /** Edit a draft/proposed plan; `revision` must be the one you edited. */
      update: (id: string, input: PlanUpdate, init?: RequestInit) =>
        call(Plan, `/api/plans/${enc(id)}`, { method: "PATCH", json: input, init }),
      /** Accept by revision: creates one draft content item per (non-skipped) item. */
      accept: (id: string, input: PlanAccept, init?: RequestInit) =>
        call(Plan, `/api/plans/${enc(id)}/accept`, { method: "POST", json: input, init }),
      reject: (id: string, input: PlanReject = {}, init?: RequestInit) =>
        call(Plan, `/api/plans/${enc(id)}/reject`, { method: "POST", json: input, init }),
      /** Queue `content.generate` jobs for accepted items (all, or `itemIds`). */
      generate: (id: string, input: PlanGenerate = {}, init?: RequestInit) =>
        call(PlanGenerateResult, `/api/plans/${enc(id)}/generate`, {
          method: "POST",
          json: input,
          init,
        }),
    },

    /**
     * Mac worker: the agent's side of a `chat.turn` job. Needs `workerToken`.
     * Order: start -> ops / plan (any number) -> complete | fail.
     */
    workerTurns: {
      start: (runId: string, attempt: number, init?: RequestInit) =>
        call(TurnContext, `/api/worker/runs/${enc(runId)}/start`, {
          method: "POST",
          json: { attempt },
          init,
        }),
      context: (runId: string, init?: RequestInit) =>
        call(TurnContext, `/api/worker/runs/${enc(runId)}/context`, { init }),
      ops: (runId: string, input: TurnOps, init?: RequestInit) =>
        call(TurnWriteResult, `/api/worker/runs/${enc(runId)}/ops`, {
          method: "POST",
          json: input,
          init,
        }),
      putPlan: (runId: string, input: PlanProposalPut, init?: RequestInit) =>
        call(PlanProposalResult, `/api/worker/runs/${enc(runId)}/plan`, {
          method: "PUT",
          json: input,
          init,
        }),
      complete: (runId: string, input: RunComplete = {}, init?: RequestInit) =>
        call(AgentRun, `/api/worker/runs/${enc(runId)}/complete`, {
          method: "POST",
          json: input,
          init,
        }),
      fail: (runId: string, input: RunFail, init?: RequestInit) =>
        call(AgentRun, `/api/worker/runs/${enc(runId)}/fail`, {
          method: "POST",
          json: input,
          init,
        }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
