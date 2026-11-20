import type { z } from "zod";
import { ClaudeControl, type ConsentDecisionCreate, GeminiControl } from "./agent.ts";
import {
  type AiBudgetPut,
  AiKeyList,
  type AiKeyProvider,
  type AiKeyPut,
  AiKeyState,
  AiPreferences,
  type AiPreferencesPut,
  AiProvidersControl,
  type AiSpendQuery,
  AiSpendSummary,
  type ClaudeLimitDecisionCreate,
  WorkerAiCredentials,
  WorkerAiSettings,
  type WorkerAiSettingsQuery,
  WorkerAiUsageAck,
  type WorkerAiUsageReport,
} from "./ai.ts";
import {
  ApprovalActionResult,
  type ApprovalApprove,
  type ApprovalCreate,
  ApprovalList,
  type ApprovalListQuery,
  type ApprovalRegenerate,
  type ApprovalReject,
  ApprovalRequest,
} from "./approval.ts";
import {
  Asset,
  AssetAnalysisPendingList,
  AssetList,
  type AssetListQuery,
  AssetSimilarList,
  type AssetSimilarQuery,
  type AssetUploadFields,
  AssetUsageList,
  assetThumbnailPath,
} from "./asset.ts";
import {
  type AssetAnalysisBackfillInput,
  AssetAnalysisBackfillResult,
  type AssetAnalysisPendingQuery,
  type AssetAnalysisPut,
} from "./asset-analysis.ts";
import {
  Brand,
  type BrandCreate,
  BrandList,
  type BrandListQuery,
  type BrandUpdate,
} from "./brand.ts";
import { BrandKit, type BrandKitPut } from "./brand-kit.ts";
import {
  BrandProduct,
  type BrandProductCreate,
  BrandProductList,
  type BrandProductListQuery,
  type BrandProductUpdate,
} from "./brand-product.ts";
import {
  BrandProfile,
  type BrandProfileCreate,
  BrandProfileList,
  type BrandProfileListQuery,
  type BrandProfileUpdate,
} from "./brand-profile.ts";
import {
  BrandSkill,
  type BrandSkillCreate,
  BrandSkillList,
  type BrandSkillListQuery,
  type BrandSkillUpdate,
  BrandSkillVersion,
  BrandSkillVersionList,
  type BrandSkillVersionListQuery,
} from "./brand-skill.ts";
import {
  type ContentReviseRequest,
  ContentReviseResult,
  GenerationEstimate,
  type GenerationEstimateQuery,
  PurgeResult,
} from "./bulk.ts";
import {
  AgentRun,
  AgentRunList,
  type AgentRunListQuery,
  ConsentDecisionResult,
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
  TurnMessageResult,
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
import {
  CommentList,
  type CommentListQuery,
  type CommentModerate,
  type CommentReadInput,
  CommentReadResult,
  type CommentReplyCreate,
  type CommentSuggestInput,
  CommentSummary,
  type CommentSummaryQuery,
  type CommentsSyncInput,
  CommentThread,
} from "./comments.ts";
import { ApiErrorBody, type ErrorCode, type ErrorIssue } from "./common.ts";
import {
  Content,
  type ContentApprove,
  type ContentCreate,
  type ContentDeleteQuery,
  type ContentDuplicate,
  ContentList,
  type ContentListQuery,
  type ContentTransition,
  type ContentUpdate,
  ContentVersion,
  type ContentVersionCreate,
  ContentVersionList,
  type ContentVersionListQuery,
  type ContentVersionRestore,
  type ContentVersionUpdate,
} from "./content.ts";
import {
  BrandCheckSettings,
  type BrandCheckSettingsPut,
  ContentCheckRun,
  type ContentCheckRunCreate,
  ContentCheckRunList,
  type ContentCheckRunListQuery,
} from "./content-check.ts";
import {
  Device,
  DeviceList,
  MacRoutes,
  type MacRoutesInput,
  type PairingClaim,
  PairingCode,
  PairingResult,
} from "./device.ts";
import {
  type WorkerCommentActionUpdate,
  WorkerCommentContext,
  type WorkerCommentSuggestion,
  WorkerCommentsAck,
  type WorkerCommentsReport,
  WorkerEngagementTargets,
  type WorkerEngagementTargetsQuery,
  WorkerInsightsAck,
  type WorkerInsightsReport,
} from "./engagement.ts";
import { HealthResponse } from "./health.ts";
import {
  BestTimes,
  type BestTimesQuery,
  BrandPerformance,
  ContentPerformance,
  type InsightsSyncInput,
  type PerformanceQuery,
  PerformanceSummary,
} from "./insights.ts";
import {
  Job,
  type JobCreate,
  JobList,
  type JobListQuery,
  type JobStreamQuery,
  WorkerPresence,
} from "./job.ts";
import { MentionCandidateList } from "./mention.ts";
import {
  Plan,
  type PlanAccept,
  type PlanGenerate,
  PlanGenerateResult,
  type PlanItemCreate,
  type PlanItemPatch,
  PlanItemRemoveResult,
  PlanList,
  type PlanListQuery,
  type PlanReject,
  type PlanUpdate,
} from "./plan.ts";
import {
  BrandPlanningSettings,
  type BrandPlanningSettingsPut,
  PlanningContext,
  type PlanningContextQuery,
  SpecialDayList,
  SpecialDayOverrides,
  type SpecialDayOverridesPut,
  type SpecialDaysQuery,
} from "./planning.ts";
import { decodeJobStreamMessage, type JobStreamMessage } from "./protocol.ts";
import {
  type KnownLocationCreate,
  KnownLocationList,
  type PublishDetailsPut,
} from "./publish-details.ts";
import {
  type PublishingCloudPut,
  type PublishingSettingsPatch,
  PublishingStatus,
  PublishLogFeed,
  type PublishLogFeedQuery,
  type PublishNowInput,
  PublishNowResult,
  SchedulePreflight,
  type SchedulePreflightInput,
  WorkerPublishingConfig,
  type WorkerPublishingSyncReport,
} from "./publishing.ts";
import {
  PublishLogList,
  type PublishLogListQuery,
  Schedule,
  type ScheduleCreate,
  ScheduleList,
  type ScheduleListQuery,
  type ScheduleUpdate,
  WorkerDueSchedules,
  type WorkerDueSchedulesQuery,
  type WorkerScheduleClaim,
  WorkerScheduleClaimResult,
  WorkerScheduleCredentials,
  type WorkerScheduleDelivery,
  type WorkerScheduleOutcome,
  type WorkerSchedulePublishState,
  type WorkerStaleSchedulesQuery,
} from "./schedule.ts";
import {
  type LinkedInConnectInput,
  type LinkedInOAuthInput,
  type MetaDiscoverInput,
  MetaDiscoverResult,
  type MetaExchangeInput,
  MetaExchangeResult,
  SocialAccount,
  type SocialAccountCheckInput,
  type SocialAccountCreate,
  SocialAccountList,
  type SocialAccountListQuery,
  type SocialAccountTokenPut,
  type SocialAccountUpdate,
} from "./social-account.ts";
import {
  type ContentRepurpose,
  type ContentRepurposeMany,
  ContentRepurposeManyResult,
  ContentRepurposeResult,
  ContentTemplate,
  type ContentTemplateCreate,
  ContentTemplateDetail,
  ContentTemplateList,
  type ContentTemplateListQuery,
  type ContentTemplateUpdate,
  type TemplateUse,
  TemplateUseResult,
} from "./template.ts";

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
      /** Products and posts the chat composer offers after `@` (mention.ts). */
      mentionCandidates: (id: string, init?: RequestInit) =>
        call(MentionCandidateList, `/api/brands/${enc(id)}/mention-candidates`, { init }),
    },

    approvals: {
      /** Newest first; `status` defaults to `pending` (`all` for every status). */
      list: (query?: ApprovalListQuery, init?: RequestInit) =>
        call(ApprovalList, "/api/approvals", { query: q(query), init }),
      get: (id: string, init?: RequestInit) =>
        call(ApprovalRequest, `/api/approvals/${enc(id)}`, { init }),
      approve: (id: string, input: ApprovalApprove = {}, init?: RequestInit) =>
        call(ApprovalActionResult, `/api/approvals/${enc(id)}/approve`, {
          method: "POST",
          json: input,
          init,
        }),
      reject: (id: string, input: ApprovalReject = {}, init?: RequestInit) =>
        call(ApprovalActionResult, `/api/approvals/${enc(id)}/reject`, {
          method: "POST",
          json: input,
          init,
        }),
      /** The owner's consent to run the same generation again (paid). */
      regenerate: (id: string, input: ApprovalRegenerate = {}, init?: RequestInit) =>
        call(ApprovalActionResult, `/api/approvals/${enc(id)}/regenerate`, {
          method: "POST",
          json: input,
          init,
        }),
    },

    workerApprovals: {
      /** A finished generation asks for the owner's word (worker token). */
      create: (input: ApprovalCreate, init?: RequestInit) =>
        call(ApprovalRequest, "/api/worker/approvals", { method: "POST", json: input, init }),
    },

    brandKits: {
      /** The brand's kit; an empty kit (`updatedAt: null`) until it was saved once. */
      get: (brandId: string, init?: RequestInit) =>
        call(BrandKit, `/api/brands/${enc(brandId)}/kit`, { init }),
      put: (brandId: string, input: BrandKitPut, init?: RequestInit) =>
        call(BrandKit, `/api/brands/${enc(brandId)}/kit`, { method: "PUT", json: input, init }),
    },

    brandProducts: {
      /** Oldest first. */
      list: (brandId: string, query?: BrandProductListQuery, init?: RequestInit) =>
        call(BrandProductList, `/api/brands/${enc(brandId)}/products`, { query: q(query), init }),
      get: (brandId: string, productId: string, init?: RequestInit) =>
        call(BrandProduct, `/api/brands/${enc(brandId)}/products/${enc(productId)}`, { init }),
      create: (brandId: string, input: BrandProductCreate, init?: RequestInit) =>
        call(BrandProduct, `/api/brands/${enc(brandId)}/products`, {
          method: "POST",
          json: input,
          init,
        }),
      update: (brandId: string, productId: string, input: BrandProductUpdate, init?: RequestInit) =>
        call(BrandProduct, `/api/brands/${enc(brandId)}/products/${enc(productId)}`, {
          method: "PATCH",
          json: input,
          init,
        }),
      delete: async (brandId: string, productId: string, init?: RequestInit): Promise<void> => {
        await send(`/api/brands/${enc(brandId)}/products/${enc(productId)}`, {
          method: "DELETE",
          init,
        });
      },
    },

    brandSkills: {
      /** Oldest first. */
      list: (brandId: string, query?: BrandSkillListQuery, init?: RequestInit) =>
        call(BrandSkillList, `/api/brands/${enc(brandId)}/skills`, { query: q(query), init }),
      get: (brandId: string, skillId: string, init?: RequestInit) =>
        call(BrandSkill, `/api/brands/${enc(brandId)}/skills/${enc(skillId)}`, { init }),
      create: (brandId: string, input: BrandSkillCreate, init?: RequestInit) =>
        call(BrandSkill, `/api/brands/${enc(brandId)}/skills`, {
          method: "POST",
          json: input,
          init,
        }),
      /** Name, description or body changes store a new version; `enabled` alone does not. */
      update: (brandId: string, skillId: string, input: BrandSkillUpdate, init?: RequestInit) =>
        call(BrandSkill, `/api/brands/${enc(brandId)}/skills/${enc(skillId)}`, {
          method: "PATCH",
          json: input,
          init,
        }),
      delete: async (brandId: string, skillId: string, init?: RequestInit): Promise<void> => {
        await send(`/api/brands/${enc(brandId)}/skills/${enc(skillId)}`, {
          method: "DELETE",
          init,
        });
      },
      versions: {
        /** Newest first. */
        list: (
          brandId: string,
          skillId: string,
          query?: BrandSkillVersionListQuery,
          init?: RequestInit,
        ) =>
          call(
            BrandSkillVersionList,
            `/api/brands/${enc(brandId)}/skills/${enc(skillId)}/versions`,
            { query: q(query), init },
          ),
        get: (brandId: string, skillId: string, version: number, init?: RequestInit) =>
          call(
            BrandSkillVersion,
            `/api/brands/${enc(brandId)}/skills/${enc(skillId)}/versions/${version}`,
            { init },
          ),
        /** Stores that version's text as a new current version. */
        restore: (brandId: string, skillId: string, version: number, init?: RequestInit) =>
          call(
            BrandSkill,
            `/api/brands/${enc(brandId)}/skills/${enc(skillId)}/versions/${version}/restore`,
            { method: "POST", init },
          ),
      },
    },

    brandCheckSettings: {
      /** The brand's check settings (defaults with `updatedAt: null` until saved once). */
      get: (brandId: string, init?: RequestInit) =>
        call(BrandCheckSettings, `/api/brands/${enc(brandId)}/check-settings`, { init }),
      put: (brandId: string, input: BrandCheckSettingsPut, init?: RequestInit) =>
        call(BrandCheckSettings, `/api/brands/${enc(brandId)}/check-settings`, {
          method: "PUT",
          json: input,
          init,
        }),
    },

    /** Special days and planning context (N5, N6). */
    planning: {
      /** The brand's sector tags and switched-off special-day categories (defaults until saved). */
      settings: (brandId: string, init?: RequestInit) =>
        call(BrandPlanningSettings, `/api/brands/${enc(brandId)}/planning-settings`, { init }),
      putSettings: (brandId: string, input: BrandPlanningSettingsPut, init?: RequestInit) =>
        call(BrandPlanningSettings, `/api/brands/${enc(brandId)}/planning-settings`, {
          method: "PUT",
          json: input,
          init,
        }),
      /** Special days, history and settings the plan agent reads before planning a period. */
      context: (brandId: string, query: PlanningContextQuery, init?: RequestInit) =>
        call(PlanningContext, `/api/brands/${enc(brandId)}/planning-context`, {
          query: q(query),
          init,
        }),
      /** Special days between two dates (with `brandId`: that brand's tags and categories). */
      specialDays: (query: SpecialDaysQuery, init?: RequestInit) =>
        call(SpecialDayList, "/api/special-days", { query: q(query), init }),
      /** Owner corrections of the bayram dates (every brand). */
      overrides: (init?: RequestInit) =>
        call(SpecialDayOverrides, "/api/special-days/overrides", { init }),
      putOverrides: (input: SpecialDayOverridesPut, init?: RequestInit) =>
        call(SpecialDayOverrides, "/api/special-days/overrides", {
          method: "PUT",
          json: input,
          init,
        }),
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
      putToken: (id: string, input: SocialAccountTokenPut, init?: RequestInit) =>
        call(SocialAccount, `/api/social-accounts/${enc(id)}/token`, {
          method: "PUT",
          json: input,
          init,
        }),
      checkToken: (id: string, input?: SocialAccountCheckInput, init?: RequestInit) =>
        call(SocialAccount, `/api/social-accounts/${enc(id)}/check`, {
          method: "POST",
          ...(input ? { json: input } : {}),
          init,
        }),
      exchangeMeta: (input: MetaExchangeInput, init?: RequestInit) =>
        call(MetaExchangeResult, "/api/social-accounts/meta/exchange", {
          method: "POST",
          json: input,
          init,
        }),
      linkedInOAuth: (input: LinkedInOAuthInput, init?: RequestInit) =>
        call(SocialAccount, "/api/social-accounts/linkedin/oauth", {
          method: "POST",
          json: input,
          init,
        }),
      discoverMeta: (input: MetaDiscoverInput, init?: RequestInit) =>
        call(MetaDiscoverResult, "/api/social-accounts/meta/discover", {
          method: "POST",
          json: input,
          init,
        }),
      connectLinkedIn: (input: LinkedInConnectInput, init?: RequestInit) =>
        call(SocialAccount, "/api/social-accounts/linkedin/connect", {
          method: "POST",
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
      /** URL of a resized copy (`width` px, rounded up to THUMBNAIL_WIDTHS; WebP). */
      thumbnailUrl: (id: string, width: number) => url(assetThumbnailPath(id, width)),
      /** Where the file is used; `deletable` false when a post, product or the kit needs it. */
      usage: (id: string, init?: RequestInit) =>
        call(AssetUsageList, `/api/assets/${enc(id)}/usage`, { init }),
      /** Move to the trash (409 with the blocking usages as `issues` while it is used). */
      delete: async (id: string, init?: RequestInit): Promise<void> => {
        await send(`/api/assets/${enc(id)}`, { method: "DELETE", init });
      },
      /** Take it back out of the trash. */
      restore: (id: string, init?: RequestInit) =>
        call(Asset, `/api/assets/${enc(id)}/restore`, { method: "POST", init }),
      /** The brand's pictures that look most like this one ("Benzerleri", N12). */
      similar: (id: string, query?: AssetSimilarQuery, init?: RequestInit) =>
        call(AssetSimilarList, `/api/assets/${enc(id)}/similar`, { query: q(query), init }),
      /** Queue tagging of every picture not read yet (N12; at most one waiting job). */
      backfillAnalysis: (input: AssetAnalysisBackfillInput = {}, init?: RequestInit) =>
        call(AssetAnalysisBackfillResult, "/api/assets/analysis/backfill", {
          method: "POST",
          json: input,
          init,
        }),
    },

    /** Mac worker: storing what Vision read in pictures (N12). Needs `workerToken`. */
    workerAssets: {
      pending: (query?: AssetAnalysisPendingQuery, init?: RequestInit) =>
        call(AssetAnalysisPendingList, "/api/worker/assets/analysis/pending", {
          query: q(query),
          init,
        }),
      putAnalysis: (id: string, input: AssetAnalysisPut, init?: RequestInit) =>
        call(Asset, `/api/worker/assets/${enc(id)}/analysis`, {
          method: "PUT",
          json: input,
          init,
        }),
    },

    contents: {
      list: (query?: ContentListQuery, init?: RequestInit) =>
        call(ContentList, "/api/contents", { query: q(query), init }),
      get: (id: string, init?: RequestInit) => call(Content, `/api/contents/${enc(id)}`, { init }),
      create: (input: ContentCreate, init?: RequestInit) =>
        call(Content, "/api/contents", { method: "POST", json: input, init }),
      update: (id: string, input: ContentUpdate, init?: RequestInit) =>
        call(Content, `/api/contents/${enc(id)}`, { method: "PATCH", json: input, init }),
      /**
       * Move the post to the trash ("Silinenler"; undo with `restore`). `{ permanent: true }`
       * removes a post that is already in the trash for good.
       */
      delete: async (
        id: string,
        init?: RequestInit,
        options?: { permanent?: boolean },
      ): Promise<void> => {
        const query: ContentDeleteQuery | undefined = options?.permanent
          ? { permanent: "true" }
          : undefined;
        await send(`/api/contents/${enc(id)}`, { method: "DELETE", query: q(query), init });
      },
      /** Take a post back out of the trash. */
      restore: (id: string, init?: RequestInit) =>
        call(Content, `/api/contents/${enc(id)}/restore`, { method: "POST", init }),
      /**
       * Replace the publish details (N13: first comment, alt texts, location, collaborators,
       * people tags, Reels cover). Does not revoke the approval; pending cloud orders are pushed
       * again. Refused (409) while the post is publishing or published.
       */
      setPublishDetails: (id: string, input: PublishDetailsPut, init?: RequestInit) =>
        call(Content, `/api/contents/${enc(id)}/publish-details`, {
          method: "PUT",
          json: input,
          init,
        }),
      /** Statistics of every account the post went to, with their history (N15). */
      performance: (id: string, init?: RequestInit) =>
        call(ContentPerformance, `/api/contents/${enc(id)}/performance`, { init }),
      /** One instruction applied to many posts (N3): revision jobs, canvas posts via the chat. */
      revise: (input: ContentReviseRequest, init?: RequestInit) =>
        call(ContentReviseResult, "/api/contents/revise", { method: "POST", json: input, init }),
      /**
       * Approve the current version; `hash` must equal its `contentHash`. Pass
       * `{ hash, acknowledgeChecks: true }` to approve although its checks did not pass
       * (otherwise 409, see `ContentApprove`).
       */
      approve: (id: string, input: string | ContentApprove, init?: RequestInit) =>
        call(Content, `/api/contents/${enc(id)}/approve`, {
          method: "POST",
          json: typeof input === "string" ? { hash: input } : input,
          init,
        }),
      transition: (id: string, to: ContentTransition["to"], init?: RequestInit) =>
        call(Content, `/api/contents/${enc(id)}/transition`, {
          method: "POST",
          json: { to },
          init,
        }),
      /** New draft copy with the current version (no approval, no schedules). */
      duplicate: (id: string, input: ContentDuplicate = {}, init?: RequestInit) =>
        call(Content, `/api/contents/${enc(id)}/duplicate`, {
          method: "POST",
          json: input,
          init,
        }),
      /** Convert a post into a story or a Reels (N10): a new linked post and its job. */
      repurpose: (id: string, input: ContentRepurpose, init?: RequestInit) =>
        call(ContentRepurposeResult, `/api/contents/${enc(id)}/repurpose`, {
          method: "POST",
          json: input,
          init,
        }),
      /** The same conversion for many posts (Postlar's "Dönüştür"). */
      repurposeMany: (input: ContentRepurposeMany, init?: RequestInit) =>
        call(ContentRepurposeManyResult, "/api/contents/repurpose", {
          method: "POST",
          json: input,
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
        /** Add a new version that copies `version` exactly (renders and layouts reused). */
        restore: (
          contentId: string,
          version: number,
          input: ContentVersionRestore = {},
          init?: RequestInit,
        ) =>
          call(ContentVersion, `/api/contents/${enc(contentId)}/versions/${version}/restore`, {
            method: "POST",
            json: input,
            init,
          }),
      },
      checks: {
        /** Check runs of the content (newest first); `version` narrows to one version. */
        list: (contentId: string, query?: ContentCheckRunListQuery, init?: RequestInit) =>
          call(ContentCheckRunList, `/api/contents/${enc(contentId)}/checks`, {
            query: q(query),
            init,
          }),
        /** Store a run (the worker does, after checking a version). */
        create: (contentId: string, input: ContentCheckRunCreate, init?: RequestInit) =>
          call(ContentCheckRun, `/api/contents/${enc(contentId)}/checks`, {
            method: "POST",
            json: input,
            init,
          }),
      },
    },

    /** Known locations of a brand for Instagram's location (N13). */
    publishLocations: {
      list: (brandId: string, init?: RequestInit) =>
        call(KnownLocationList, `/api/brands/${enc(brandId)}/publish-locations`, { init }),
      add: (brandId: string, input: KnownLocationCreate, init?: RequestInit) =>
        call(KnownLocationList, `/api/brands/${enc(brandId)}/publish-locations`, {
          method: "POST",
          json: input,
          init,
        }),
      remove: (brandId: string, locationId: string, init?: RequestInit) =>
        call(
          KnownLocationList,
          `/api/brands/${enc(brandId)}/publish-locations/${enc(locationId)}`,
          { method: "DELETE", init },
        ),
    },

    /** Statistics (N15). */
    insights: {
      /** The brand's performance page: top posts, pillars, formats, weekday / hour, trend. */
      brand: (brandId: string, query?: PerformanceQuery, init?: RequestInit) =>
        call(BrandPerformance, `/api/brands/${enc(brandId)}/performance`, {
          query: q(query),
          init,
        }),
      /** Hour × weekday grid and suggested slots ("Önerilen saatler"). */
      bestTimes: (brandId: string, query?: BestTimesQuery, init?: RequestInit) =>
        call(BestTimes, `/api/brands/${enc(brandId)}/best-times`, { query: q(query), init }),
      /** What worked lately, in short (the plan agent and the brand analysis read it). */
      summary: (brandId: string, query?: PerformanceQuery, init?: RequestInit) =>
        call(PerformanceSummary, `/api/brands/${enc(brandId)}/performance-summary`, {
          query: q(query),
          init,
        }),
      /** Read statistics now (a brand, a post, or everything due). */
      sync: (input: InsightsSyncInput = {}, init?: RequestInit) =>
        call(Job, "/api/insights/sync", { method: "POST", json: input, init }),
    },

    /** Comment inbox (N16). */
    comments: {
      list: (query?: CommentListQuery, init?: RequestInit) =>
        call(CommentList, "/api/comments", { query: q(query), init }),
      get: (id: string, init?: RequestInit) =>
        call(CommentThread, `/api/comments/${enc(id)}`, { init }),
      summary: (query?: CommentSummaryQuery, init?: RequestInit) =>
        call(CommentSummary, "/api/comments/summary", { query: q(query), init }),
      /** Queue a reply (the worker sends it; never sent without the owner). */
      reply: (id: string, input: CommentReplyCreate, init?: RequestInit) =>
        call(CommentThread, `/api/comments/${enc(id)}/reply`, {
          method: "POST",
          json: input,
          init,
        }),
      moderate: (id: string, input: CommentModerate, init?: RequestInit) =>
        call(CommentThread, `/api/comments/${enc(id)}/moderate`, {
          method: "POST",
          json: input,
          init,
        }),
      /** Retry a failed reply / moderation. */
      retryAction: (id: string, init?: RequestInit) =>
        call(CommentThread, `/api/comments/${enc(id)}/retry`, { method: "POST", init }),
      read: (input: CommentReadInput, init?: RequestInit) =>
        call(CommentReadResult, "/api/comments/read", { method: "POST", json: input, init }),
      /** "Yanıt öner": queue `comments.suggest`; the draft lands on the comment. */
      suggest: (id: string, input: CommentSuggestInput = {}, init?: RequestInit) =>
        call(Job, `/api/comments/${enc(id)}/suggest`, { method: "POST", json: input, init }),
      /** Read new comments now. */
      sync: (input: CommentsSyncInput = {}, init?: RequestInit) =>
        call(Job, "/api/comments/sync", { method: "POST", json: input, init }),
    },

    templates: {
      /** The brand's templates (N9), newest first. */
      list: (brandId: string, query?: ContentTemplateListQuery, init?: RequestInit) =>
        call(ContentTemplateList, `/api/brands/${enc(brandId)}/templates`, {
          query: q(query),
          init,
        }),
      /** A template with its slides. */
      get: (id: string, init?: RequestInit) =>
        call(ContentTemplateDetail, `/api/templates/${enc(id)}`, { init }),
      /** Save an approved / published post as a template of its brand. */
      create: (input: ContentTemplateCreate, init?: RequestInit) =>
        call(ContentTemplate, "/api/templates", { method: "POST", json: input, init }),
      update: (id: string, input: ContentTemplateUpdate, init?: RequestInit) =>
        call(ContentTemplate, `/api/templates/${enc(id)}`, { method: "PATCH", json: input, init }),
      delete: async (id: string, init?: RequestInit): Promise<void> => {
        await send(`/api/templates/${enc(id)}`, { method: "DELETE", init });
      },
      /** A new draft post from the template; a `content.generate` job fills it. */
      use: (id: string, input: TemplateUse = {}, init?: RequestInit) =>
        call(TemplateUseResult, `/api/templates/${enc(id)}/use`, {
          method: "POST",
          json: input,
          init,
        }),
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
      /**
       * Queue a failed or cancelled job again (`RETRYABLE_JOB_TYPES`): the new job (same type,
       * brand, content and payload; a plan item's generation goes through its plan).
       */
      retry: (id: string, init?: RequestInit) =>
        call(Job, `/api/jobs/${enc(id)}/retry`, { method: "POST", init }),
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
      /** The Mac's Claude sign-in as the worker last reported it. */
      claude: (init?: RequestInit) => call(ClaudeControl, "/api/workers/claude", { init }),
      /**
       * Ask the worker to start `claude auth login` (the sign-in page opens in
       * the Mac's browser; the Mac itself only). Follow presence `claude`.
       */
      claudeLogin: (init?: RequestInit) =>
        call(ClaudeControl, "/api/workers/claude/login", { method: "POST", init }),
      /** Ask the worker to read `claude auth status` again. */
      claudeRefresh: (init?: RequestInit) =>
        call(ClaudeControl, "/api/workers/claude/status", { method: "POST", init }),
      /** The Mac's Gemini API / CLI readiness as the worker last reported it. */
      gemini: (init?: RequestInit) => call(GeminiControl, "/api/workers/gemini", { init }),
      /** Ask the worker to re-check Gemini API key / CLI readiness. */
      geminiRefresh: (init?: RequestInit) =>
        call(GeminiControl, "/api/workers/gemini/status", { method: "POST", init }),
      /** Codex CLI, OpenAI API and Antigravity CLI as the worker last reported them. */
      providers: (init?: RequestInit) =>
        call(AiProvidersControl, "/api/workers/providers", { init }),
      /** Ask the worker to re-check Codex / OpenAI / Antigravity. */
      providersRefresh: (init?: RequestInit) =>
        call(AiProvidersControl, "/api/workers/providers/status", { method: "POST", init }),
      /** Ask the worker to start `codex login` (sign-in page in the Mac's browser; Mac only). */
      codexLogin: (init?: RequestInit) =>
        call(AiProvidersControl, "/api/workers/codex/login", { method: "POST", init }),
      /** Ask the worker to start `agy acp --login` (Google sign-in in the browser; Mac only). */
      antigravityLogin: (init?: RequestInit) =>
        call(AiProvidersControl, "/api/workers/antigravity/login", { method: "POST", init }),
    },

    pairing: {
      /** New 6-digit code (the Mac itself only; invalidates the previous unused code). */
      createCode: (init?: RequestInit) =>
        call(PairingCode, "/api/pairing/codes", { method: "POST", init }),
      /** Phone side: trade a code or QR secret for a device token (public, rate-limited). */
      claim: (input: PairingClaim, init?: RequestInit) =>
        call(PairingResult, "/api/pairing/claim", { method: "POST", json: input, init }),
      /** Where phones can reach this Mac (paired devices and the Mac itself). */
      routes: (init?: RequestInit) => call(MacRoutes, "/api/pairing/routes", { init }),
      /** Publish where phones can reach this Mac (the Mac itself only). */
      updateRoutes: (input: MacRoutesInput, init?: RequestInit) =>
        call(MacRoutes, "/api/pairing/routes", { method: "PUT", json: input, init }),
    },

    devices: {
      /** Paired devices, newest first (the Mac itself only). */
      list: (init?: RequestInit) => call(DeviceList, "/api/devices", { init }),
      /** Revoke a device: its token stops working immediately. */
      revoke: (id: string, init?: RequestInit) =>
        call(Device, `/api/devices/${enc(id)}/revoke`, { method: "POST", init }),
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
      /** Move a pending schedule (calendar drag). */
      update: (id: string, input: ScheduleUpdate, init?: RequestInit) =>
        call(Schedule, `/api/schedules/${enc(id)}`, { method: "PATCH", json: input, init }),
      logs: (id: string, query?: PublishLogListQuery, init?: RequestInit) =>
        call(PublishLogList, `/api/schedules/${enc(id)}/logs`, { query: q(query), init }),
      /** Platform rules for the content on each account, before scheduling. */
      preflight: (input: SchedulePreflightInput, init?: RequestInit) =>
        call(SchedulePreflight, "/api/schedules/preflight", { method: "POST", json: input, init }),
      publishNow: (input: PublishNowInput, init?: RequestInit) =>
        call(PublishNowResult, "/api/schedules/publish-now", {
          method: "POST",
          json: input,
          init,
        }),
    },

    publishing: {
      status: (init?: RequestInit) => call(PublishingStatus, "/api/publishing/status", { init }),
      setCloud: (input: PublishingCloudPut, init?: RequestInit) =>
        call(PublishingStatus, "/api/publishing/cloud", { method: "PUT", json: input, init }),
      /**
       * Forget the cloud publisher. Refused (409) while schedules handed to it are pending or
       * still to be cancelled there, unless `force` (those orders then stay in the cloud).
       */
      clearCloud: (init?: RequestInit, opts?: { force?: boolean }) =>
        call(PublishingStatus, "/api/publishing/cloud", {
          method: "DELETE",
          ...(opts?.force ? { query: q({ force: "true" }) } : {}),
          init,
        }),
      /** Publishing settings (maximum lateness). */
      updateSettings: (input: PublishingSettingsPatch, init?: RequestInit) =>
        call(PublishingStatus, "/api/publishing/settings", { method: "PATCH", json: input, init }),
      /** Ask the worker to push and pull cloud orders now (app focus). */
      requestSync: (init?: RequestInit) =>
        call(PublishingStatus, "/api/publishing/sync", { method: "POST", init }),
      /** Publish attempts with schedule, title and account (log screen, notifications). */
      logs: (query?: PublishLogFeedQuery, init?: RequestInit) =>
        call(PublishLogFeed, "/api/publish-logs", { query: q(query), init }),
    },

    conversations: {
      /** Most recently active first. */
      list: (query?: ConversationListQuery, init?: RequestInit) =>
        call(ConversationList, "/api/conversations", { query: q(query), init }),
      get: (id: string, init?: RequestInit) =>
        call(Conversation, `/api/conversations/${enc(id)}`, { init }),
      create: (input: ConversationCreate = {}, init?: RequestInit) =>
        call(Conversation, "/api/conversations", { method: "POST", json: input, init }),
      /** Rename, archive (`status: "archived"`), unarchive, or set the brand (until the first message). */
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
        /** Allow once / deny a `consent` card while its run waits for it. */
        consent: (
          conversationId: string,
          messageId: string,
          input: ConsentDecisionCreate,
          init?: RequestInit,
        ) =>
          call(
            ConsentDecisionResult,
            `/api/conversations/${enc(conversationId)}/messages/${enc(messageId)}/consent`,
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
      /** Add an item at the end (accepted plans: accepted at once, with its draft post). */
      addItem: (id: string, input: PlanItemCreate, init?: RequestInit) =>
        call(Plan, `/api/plans/${enc(id)}/items`, { method: "POST", json: input, init }),
      /** Edit one item (accepted plans: its draft post follows). */
      updateItem: (id: string, itemId: string, input: PlanItemPatch, init?: RequestInit) =>
        call(Plan, `/api/plans/${enc(id)}/items/${enc(itemId)}`, {
          method: "PATCH",
          json: input,
          init,
        }),
      /** Remove one item (its empty draft post goes to the trash). */
      removeItem: (id: string, itemId: string, init?: RequestInit) =>
        call(PlanItemRemoveResult, `/api/plans/${enc(id)}/items/${enc(itemId)}`, {
          method: "DELETE",
          init,
        }),
    },

    estimates: {
      /** How long and how much N post generations will take (N4). */
      generation: (query: GenerationEstimateQuery, init?: RequestInit) =>
        call(GenerationEstimate, "/api/estimates/generation", { query: q(query), init }),
    },

    maintenance: {
      /** Purge what has been in the trash longer than TRASH_RETENTION_DAYS (also runs hourly). */
      purge: (init?: RequestInit) =>
        call(PurgeResult, "/api/maintenance/purge", { method: "POST", init }),
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
      /** The run and its assistant message only (cheap; for waiting on an answer). */
      message: (runId: string, init?: RequestInit) =>
        call(TurnMessageResult, `/api/worker/runs/${enc(runId)}/message`, { init }),
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

    workerSchedules: {
      due: (query?: WorkerDueSchedulesQuery, init?: RequestInit) =>
        call(WorkerDueSchedules, "/api/worker/schedules/due", { query: q(query), init }),
      credentials: (id: string, init?: RequestInit) =>
        call(WorkerScheduleCredentials, `/api/worker/schedules/${enc(id)}/credentials`, { init }),
      outcome: (id: string, input: WorkerScheduleOutcome, init?: RequestInit) =>
        call(Schedule, `/api/worker/schedules/${enc(id)}/outcome`, {
          method: "POST",
          json: input,
          init,
        }),
      /** Record who publishes the schedule (cloud push result or local). */
      delivery: (id: string, input: WorkerScheduleDelivery, init?: RequestInit) =>
        call(Schedule, `/api/worker/schedules/${enc(id)}/delivery`, {
          method: "POST",
          json: input,
          init,
        }),
      /** Schedules that were sent to the cloud and later cancelled (cancel the orders). */
      cancelled: (query?: { since?: string; limit?: number }, init?: RequestInit) =>
        call(WorkerDueSchedules, "/api/worker/schedules/cancelled", { query: q(query), init }),
      /** Take a schedule to publish it on this Mac (atomic; resumes a stale local claim). */
      claim: (id: string, input: WorkerScheduleClaim = {}, init?: RequestInit) =>
        call(WorkerScheduleClaimResult, `/api/worker/schedules/${enc(id)}/claim`, {
          method: "POST",
          json: input,
          init,
        }),
      /** Save the publisher state before acting on it (also the claim's heartbeat). */
      publishState: (id: string, input: WorkerSchedulePublishState, init?: RequestInit) =>
        call(Schedule, `/api/worker/schedules/${enc(id)}/publish-state`, {
          method: "PUT",
          json: input,
          init,
        }),
      /** Local `publishing` claims whose worker stopped (resume them). */
      stale: (query?: WorkerStaleSchedulesQuery, init?: RequestInit) =>
        call(WorkerDueSchedules, "/api/worker/schedules/stale", { query: q(query), init }),
    },

    /** AI provider keys in the vault and Gemini spend (Ayarlar → Yapay zekâ / Kullanım). */
    ai: {
      keys: (init?: RequestInit) => call(AiKeyList, "/api/ai/keys", { init }),
      /** Check (models.list) and store a key (the Mac itself only). */
      setKey: (provider: AiKeyProvider, input: AiKeyPut, init?: RequestInit) =>
        call(AiKeyState, `/api/ai/keys/${enc(provider)}`, { method: "PUT", json: input, init }),
      /** Check the stored key again (models.list; free). */
      checkKey: (provider: AiKeyProvider, init?: RequestInit) =>
        call(AiKeyState, `/api/ai/keys/${enc(provider)}/check`, { method: "POST", init }),
      deleteKey: (provider: AiKeyProvider, init?: RequestInit) =>
        call(AiKeyState, `/api/ai/keys/${enc(provider)}`, { method: "DELETE", init }),
      spend: (query?: AiSpendQuery, init?: RequestInit) =>
        call(AiSpendSummary, "/api/ai/spend", { query: q(query), init }),
      setBudget: (input: AiBudgetPut, init?: RequestInit) =>
        call(AiSpendSummary, "/api/ai/budget", { method: "PUT", json: input, init }),
      /** Claude-limit behaviour and the monthly budget (S7). */
      preferences: (init?: RequestInit) => call(AiPreferences, "/api/ai/preferences", { init }),
      setPreferences: (input: AiPreferencesPut, init?: RequestInit) =>
        call(AiPreferences, "/api/ai/preferences", { method: "PUT", json: input, init }),
      /** Answer presence `claude.limit` ("Gemini ile devam et" / "Sınırı bekle"). */
      decideClaudeLimit: (input: ClaudeLimitDecisionCreate, init?: RequestInit) =>
        call(AiPreferences, "/api/ai/claude-limit/decision", {
          method: "POST",
          json: input,
          init,
        }),
    },

    workerAi: {
      credentials: (init?: RequestInit) =>
        call(WorkerAiCredentials, "/api/worker/ai/credentials", { init }),
      /** Claude-limit preference, the owner's answer and the budget state (S7). */
      settings: (query?: WorkerAiSettingsQuery, init?: RequestInit) =>
        call(WorkerAiSettings, "/api/worker/ai/settings", { query: q(query), init }),
      reportUsage: (input: WorkerAiUsageReport, init?: RequestInit) =>
        call(WorkerAiUsageAck, "/api/worker/ai/usage", { method: "POST", json: input, init }),
    },

    /** Statistics and comments for the worker (N15, N16). */
    workerEngagement: {
      targets: (query: WorkerEngagementTargetsQuery, init?: RequestInit) =>
        call(WorkerEngagementTargets, "/api/worker/engagement/targets", {
          query: q(query),
          init,
        }),
      reportInsights: (input: WorkerInsightsReport, init?: RequestInit) =>
        call(WorkerInsightsAck, "/api/worker/engagement/insights", {
          method: "POST",
          json: input,
          init,
        }),
      reportComments: (input: WorkerCommentsReport, init?: RequestInit) =>
        call(WorkerCommentsAck, "/api/worker/engagement/comments", {
          method: "POST",
          json: input,
          init,
        }),
      action: (id: string, input: WorkerCommentActionUpdate, init?: RequestInit) =>
        send(`/api/worker/engagement/actions/${enc(id)}`, {
          method: "POST",
          json: input,
          init,
        }).then(() => undefined),
      commentContext: (id: string, init?: RequestInit) =>
        call(WorkerCommentContext, `/api/worker/comments/${enc(id)}/context`, { init }),
      putSuggestion: (id: string, input: WorkerCommentSuggestion, init?: RequestInit) =>
        call(CommentThread, `/api/worker/comments/${enc(id)}/suggestion`, {
          method: "PUT",
          json: input,
          init,
        }),
    },

    workerPublishing: {
      config: (init?: RequestInit) =>
        call(WorkerPublishingConfig, "/api/worker/publishing/config", { init }),
      report: (input: WorkerPublishingSyncReport, init?: RequestInit) =>
        call(WorkerPublishingConfig, "/api/worker/publishing/report", {
          method: "POST",
          json: input,
          init,
        }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
