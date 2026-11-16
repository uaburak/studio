import { z } from "zod";
import { Asset, AssetKind } from "./asset.ts";
import { Brand } from "./brand.ts";
import { BrandProfile } from "./brand-profile.ts";
import {
  EntityId,
  jsonWithin,
  nonEmptyUpdate,
  PageQuery,
  pageOf,
  Timestamp,
  utf8Length,
} from "./common.ts";
import { MAX_PLAN_ITEMS, Plan, PlanItemInput } from "./plan.ts";

/*
 * Conversations (task A2): the AI chat that is Studio's main surface.
 *
 * A conversation holds ordered messages. A message has a role, a status and
 * an ordered list of typed parts (text, attachment, plan proposal, content
 * reference, question, progress, error). Every user message starts an agent
 * run, which the API turns into a `chat.turn` job; the Mac worker runs the
 * agent and writes the assistant message back through the turn API
 * (`/api/worker/runs/{runId}/...`). Clients follow everything live on
 * `/api/conversations/{id}/stream` (see chat-stream.ts).
 */

// --- limits ---------------------------------------------------------------------

/** User message text (UTF-8 bytes). */
export const MAX_USER_TEXT_BYTES = 20_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
/** One text part of an assistant message (UTF-8 bytes). */
export const MAX_TEXT_PART_BYTES = 100_000;
/** One streamed text delta (UTF-8 bytes). Batch more often rather than sending bigger deltas. */
export const MAX_TEXT_DELTA_BYTES = 16_384;
export const MAX_PARTS_PER_MESSAGE = 64;
/** Whole message as stored (JSON of all parts). */
export const MAX_MESSAGE_BYTES = 512_000;
/** Operations in one `POST /api/worker/runs/{id}/ops` call. */
export const MAX_TURN_OPS = 100;
/** Messages handed to the agent in the turn context (newest ones). */
export const TURN_CONTEXT_MESSAGES = 100;

/** Agent-chosen identifiers inside a message (question ids, option ids, progress step ids). */
export const PartKey = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.:-]+$/, "letters, digits and _ . : - only");

const bytesAtMost = (max: number) => (s: string) => utf8Length(s) <= max;

// --- conversations ------------------------------------------------------------------

export const ConversationStatus = z.enum(["active", "archived"]).meta({ id: "ConversationStatus" });
export type ConversationStatus = z.infer<typeof ConversationStatus>;

const ConversationTitle = z.string().trim().max(200);

export const Conversation = z
  .object({
    id: EntityId,
    /** Optional: a chat can start without a brand; the agent or the user sets it later (once). */
    brandId: EntityId.nullable(),
    /** "" until set; the first user message fills it when empty. */
    title: z.string(),
    status: ConversationStatus,
    /** The queued or running agent run, if any (at most one per conversation). */
    activeRunId: EntityId.nullable(),
    /** Sequence number of the last stream event (0 = none yet). */
    lastSeq: z.number().int().min(0),
    lastActivityAt: Timestamp,
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Conversation" });
export type Conversation = z.infer<typeof Conversation>;

export const ConversationCreate = z
  .object({
    brandId: EntityId.optional(),
    title: ConversationTitle.default(""),
  })
  .meta({ id: "ConversationCreate" });
export type ConversationCreate = z.input<typeof ConversationCreate>;

/** Rename, archive / unarchive, or set the brand of a brand-less conversation. */
export const ConversationUpdate = z
  .object({
    title: ConversationTitle.optional(),
    status: ConversationStatus.optional(),
    /** Only while the conversation has no brand yet; a brand is never changed afterwards. */
    brandId: EntityId.optional(),
  })
  .refine(nonEmptyUpdate, "at least one field is required")
  .meta({ id: "ConversationUpdate" });
export type ConversationUpdate = z.input<typeof ConversationUpdate>;

export const ConversationListQuery = PageQuery.extend({
  brandId: EntityId.optional(),
  status: ConversationStatus.optional(),
});
export type ConversationListQuery = z.input<typeof ConversationListQuery>;

/** Most recently active first. */
export const ConversationList = pageOf(Conversation, "ConversationList");
export type ConversationList = z.infer<typeof ConversationList>;

// --- message parts ----------------------------------------------------------------------

export const MessageRole = z.enum(["user", "assistant", "system"]).meta({ id: "MessageRole" });
export type MessageRole = z.infer<typeof MessageRole>;

/**
 * `streaming` while the agent is still writing it; `complete` / `failed` /
 * `cancelled` follow the run. User and system messages are `complete`.
 */
export const MessageStatus = z
  .enum(["streaming", "complete", "failed", "cancelled"])
  .meta({ id: "MessageStatus" });
export type MessageStatus = z.infer<typeof MessageStatus>;

export const MessagePartType = z
  .enum(["text", "attachment", "plan_proposal", "content_ref", "question", "progress", "error"])
  .meta({ id: "MessagePartType" });
export type MessagePartType = z.infer<typeof MessagePartType>;

export const TextPart = z
  .object({ type: z.literal("text"), text: z.string() })
  .meta({ id: "TextPart" });

/** An uploaded asset; the server copies the metadata a chat bubble needs. */
export const AttachmentPart = z
  .object({
    type: z.literal("attachment"),
    assetId: EntityId,
    kind: AssetKind,
    mimeType: z.string(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    filename: z.string().nullable(),
  })
  .meta({ id: "AttachmentPart" });

/** A plan card; the plan itself comes with the snapshot and `plan.updated` events. */
export const PlanProposalPart = z
  .object({ type: z.literal("plan_proposal"), planId: EntityId })
  .meta({ id: "PlanProposalPart" });

/** Points at a content item (and optionally one version of it). */
export const ContentRefPart = z
  .object({
    type: z.literal("content_ref"),
    contentId: EntityId,
    version: z.number().int().min(1).nullable(),
    note: z.string().nullable(),
  })
  .meta({ id: "ContentRefPart" });

/** `single`: pick one option; `multiple`: pick one or more; `text`: free text only. */
export const QuestionMode = z.enum(["single", "multiple", "text"]).meta({ id: "QuestionMode" });
export type QuestionMode = z.infer<typeof QuestionMode>;

export const QuestionOption = z
  .object({
    id: PartKey,
    label: z.string().trim().min(1).max(200),
    description: z.string().max(1_000).nullable().default(null),
  })
  .meta({ id: "QuestionOption" });
export type QuestionOption = z.output<typeof QuestionOption>;

export const QuestionAnswer = z
  .object({
    optionIds: z.array(PartKey),
    text: z.string().nullable(),
    answeredAt: Timestamp,
  })
  .meta({ id: "QuestionAnswer" });
export type QuestionAnswer = z.infer<typeof QuestionAnswer>;

export const QuestionPart = z
  .object({
    type: z.literal("question"),
    /** Unique inside the message; the answer endpoint addresses the question by it. */
    questionId: PartKey,
    prompt: z.string(),
    mode: QuestionMode,
    options: z.array(QuestionOption),
    /** Choice questions may also accept a free-text answer ("başka bir şey"). */
    allowText: z.boolean(),
    /** Null until the user answers; an answer is final. */
    answer: QuestionAnswer.nullable(),
  })
  .meta({ id: "QuestionPart" });

export const ProgressState = z
  .enum(["pending", "running", "done", "failed", "skipped"])
  .meta({ id: "ProgressState" });
export type ProgressState = z.infer<typeof ProgressState>;

/** One step of the agent's work ("Marka profili okunuyor", "3/12 post"). Replace it to update. */
export const ProgressPart = z
  .object({
    type: z.literal("progress"),
    stepId: PartKey,
    label: z.string(),
    state: ProgressState,
    detail: z.string().nullable(),
    current: z.number().int().min(0).nullable(),
    total: z.number().int().min(0).nullable(),
  })
  .meta({ id: "ProgressPart" });

export const ErrorPart = z
  .object({
    type: z.literal("error"),
    message: z.string(),
    code: z.string().nullable(),
    retryable: z.boolean(),
  })
  .meta({ id: "ErrorPart" });

export const MessagePart = z
  .discriminatedUnion("type", [
    TextPart,
    AttachmentPart,
    PlanProposalPart,
    ContentRefPart,
    QuestionPart,
    ProgressPart,
    ErrorPart,
  ])
  .meta({ id: "MessagePart" });
export type MessagePart = z.infer<typeof MessagePart>;
export type TextPart = z.infer<typeof TextPart>;
export type AttachmentPart = z.infer<typeof AttachmentPart>;
export type PlanProposalPart = z.infer<typeof PlanProposalPart>;
export type ContentRefPart = z.infer<typeof ContentRefPart>;
export type QuestionPart = z.infer<typeof QuestionPart>;
export type ProgressPart = z.infer<typeof ProgressPart>;
export type ErrorPart = z.infer<typeof ErrorPart>;

// --- part inputs (what the agent writes) -------------------------------------------------

export const TextPartInput = z
  .object({
    type: z.literal("text"),
    text: z.string().refine(bytesAtMost(MAX_TEXT_PART_BYTES), "text part is too large"),
  })
  .meta({ id: "TextPartInput" });

/** The asset must belong to the conversation's brand. */
export const AttachmentPartInput = z
  .object({ type: z.literal("attachment"), assetId: EntityId })
  .meta({ id: "AttachmentPartInput" });

/** The plan must belong to the conversation (normally added by `PUT .../plan`). */
export const PlanProposalPartInput = z
  .object({ type: z.literal("plan_proposal"), planId: EntityId })
  .meta({ id: "PlanProposalPartInput" });

export const ContentRefPartInput = z
  .object({
    type: z.literal("content_ref"),
    contentId: EntityId,
    version: z.number().int().min(1).nullable().default(null),
    note: z.string().max(2_000).nullable().default(null),
  })
  .meta({ id: "ContentRefPartInput" });

export const QuestionPartInput = z
  .object({
    type: z.literal("question"),
    questionId: PartKey,
    prompt: z.string().trim().min(1).max(2_000),
    mode: QuestionMode,
    options: z.array(QuestionOption).max(12).default([]),
    allowText: z.boolean().default(false),
  })
  .refine(
    (q) => (q.mode === "text" ? q.options.length === 0 : q.options.length >= 2),
    "choice questions need at least 2 options; text questions take none",
  )
  .refine(
    (q) => new Set(q.options.map((o) => o.id)).size === q.options.length,
    "option ids must be unique",
  )
  .meta({ id: "QuestionPartInput" });

export const ProgressPartInput = z
  .object({
    type: z.literal("progress"),
    stepId: PartKey,
    label: z.string().trim().min(1).max(200),
    state: ProgressState,
    detail: z.string().max(2_000).nullable().default(null),
    current: z.number().int().min(0).nullable().default(null),
    total: z.number().int().min(0).nullable().default(null),
  })
  .meta({ id: "ProgressPartInput" });

export const ErrorPartInput = z
  .object({
    type: z.literal("error"),
    message: z.string().trim().min(1).max(4_000),
    code: z.string().max(100).nullable().default(null),
    retryable: z.boolean().default(false),
  })
  .meta({ id: "ErrorPartInput" });

export const MessagePartInput = z
  .discriminatedUnion("type", [
    TextPartInput,
    AttachmentPartInput,
    PlanProposalPartInput,
    ContentRefPartInput,
    QuestionPartInput,
    ProgressPartInput,
    ErrorPartInput,
  ])
  .meta({ id: "MessagePartInput" });
export type MessagePartInput = z.input<typeof MessagePartInput>;

// --- messages ----------------------------------------------------------------------------

export const Message = z
  .object({
    id: EntityId,
    conversationId: EntityId,
    role: MessageRole,
    status: MessageStatus,
    /** Agent run that produced the message (assistant messages); null for user messages. */
    runId: EntityId.nullable(),
    parts: z.array(MessagePart),
    createdAt: Timestamp,
    updatedAt: Timestamp,
  })
  .meta({ id: "Message" });
export type Message = z.infer<typeof Message>;

export const MessageListQuery = PageQuery;
export type MessageListQuery = z.input<typeof MessageListQuery>;

/** Newest first (page backwards with `cursor`); reverse for display. */
export const MessageList = pageOf(Message, "MessageList");
export type MessageList = z.infer<typeof MessageList>;

export const UserMessageCreate = z
  .object({
    text: z
      .string()
      .trim()
      .max(MAX_USER_TEXT_BYTES)
      .refine(bytesAtMost(MAX_USER_TEXT_BYTES), "text is too large")
      .optional(),
    /** Existing assets of the conversation's brand (upload them first with POST /api/assets). */
    attachmentAssetIds: z
      .array(EntityId)
      .max(MAX_ATTACHMENTS_PER_MESSAGE)
      .refine((ids) => new Set(ids).size === ids.length, "attachments must be unique")
      .default([]),
    /**
     * Client-generated idempotency key. Sending the same key again returns
     * the original message and run (`replayed: true`) instead of a second turn.
     */
    clientMessageId: z.string().min(1).max(128).optional(),
  })
  .refine(
    (m) => (m.text !== undefined && m.text.length > 0) || m.attachmentAssetIds.length > 0,
    "a message needs text or at least one attachment",
  )
  .meta({ id: "UserMessageCreate" });
export type UserMessageCreate = z.input<typeof UserMessageCreate>;

export const QuestionAnswerCreate = z
  .object({
    questionId: PartKey,
    optionIds: z.array(PartKey).max(12).default([]),
    text: z.string().trim().max(4_000).optional(),
  })
  .meta({ id: "QuestionAnswerCreate" });
export type QuestionAnswerCreate = z.input<typeof QuestionAnswerCreate>;

/** Answer check shared by the server and clients; returns an error message or null. */
export function checkQuestionAnswer(
  question: Pick<QuestionPart, "mode" | "options" | "allowText">,
  answer: { optionIds: readonly string[]; text?: string | null | undefined },
): string | null {
  const text = answer.text?.trim() ?? "";
  const ids = answer.optionIds;
  if (new Set(ids).size !== ids.length) return "option ids must be unique";
  const known = new Set(question.options.map((o) => o.id));
  const unknown = ids.find((id) => !known.has(id));
  if (unknown) return `unknown option ${unknown}`;
  if (question.mode === "text") {
    if (ids.length > 0) return "this question takes a text answer, not options";
    return text ? null : "a text answer is required";
  }
  if (text && !question.allowText) return "this question does not accept free text";
  if (question.mode === "single" && ids.length > 1) return "pick exactly one option";
  if (ids.length === 0 && !text) return "pick an option";
  return null;
}

// --- agent runs ------------------------------------------------------------------------------

export const AgentRunStatus = z
  .enum(["queued", "running", "completed", "failed", "cancelled"])
  .meta({ id: "AgentRunStatus" });
export type AgentRunStatus = z.infer<typeof AgentRunStatus>;

/**
 *   queued  -> running (worker start) | cancelled (user) | failed (job failed before start)
 *   running -> running (new attempt after the worker lost the job) | queued (job requeued)
 *            | completed | failed | cancelled
 *   completed, failed, cancelled: final
 */
export const RUN_TRANSITIONS = {
  queued: ["running", "cancelled", "failed", "completed"],
  running: ["queued", "completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<AgentRunStatus, readonly AgentRunStatus[]>;

export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const satisfies AgentRunStatus[];
export function isActiveRunStatus(status: AgentRunStatus): boolean {
  return (ACTIVE_RUN_STATUSES as readonly AgentRunStatus[]).includes(status);
}

/** Model usage as the worker reports it; known fields are typed, extra numeric/string fields are kept. */
export const RunUsage = z
  .object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    cacheReadTokens: z.number().int().min(0).optional(),
    cacheWriteTokens: z.number().int().min(0).optional(),
    costUsd: z.number().min(0).optional(),
    durationMs: z.number().int().min(0).optional(),
  })
  .catchall(z.union([z.number(), z.string().max(200)]))
  .refine(jsonWithin(4_000), "usage is too large")
  .meta({ id: "RunUsage" });
export type RunUsage = z.infer<typeof RunUsage>;

export const AgentRun = z
  .object({
    id: EntityId,
    conversationId: EntityId,
    /** The user message (or the answered assistant message) that started the run. */
    triggerMessageId: EntityId,
    /** The `chat.turn` job that executes the run. */
    jobId: EntityId.nullable(),
    status: AgentRunStatus,
    /** Worker attempt currently writing (0 until the worker starts). */
    attempt: z.number().int().min(0),
    model: z.string().nullable(),
    usage: RunUsage.nullable(),
    error: z.string().nullable(),
    createdAt: Timestamp,
    updatedAt: Timestamp,
    startedAt: Timestamp.nullable(),
    finishedAt: Timestamp.nullable(),
  })
  .meta({ id: "AgentRun" });
export type AgentRun = z.infer<typeof AgentRun>;

export const AgentRunListQuery = PageQuery;
export type AgentRunListQuery = z.input<typeof AgentRunListQuery>;

export const AgentRunList = pageOf(AgentRun, "AgentRunList");
export type AgentRunList = z.infer<typeof AgentRunList>;

export const UserMessageResult = z
  .object({
    message: Message,
    run: AgentRun,
    /** True when `clientMessageId` matched an earlier send. */
    replayed: z.boolean(),
  })
  .meta({ id: "UserMessageResult" });
export type UserMessageResult = z.infer<typeof UserMessageResult>;

export const QuestionAnswerResult = z
  .object({
    message: Message,
    /** New run started by the answer; null when the asking run is still active (it reads the answer itself) or another run is. */
    run: AgentRun.nullable(),
  })
  .meta({ id: "QuestionAnswerResult" });
export type QuestionAnswerResult = z.infer<typeof QuestionAnswerResult>;

// --- worker turn protocol (/api/worker/runs/{runId}/...) ------------------------------------

/** The attempt number from `job.dispatch`. Writes carrying an older attempt are refused. */
export const RunAttempt = z.number().int().min(1);

export const RunStart = z.object({ attempt: RunAttempt }).meta({ id: "RunStart" });
export type RunStart = z.input<typeof RunStart>;

/** Everything the agent needs for one turn. */
export const TurnContext = z
  .object({
    run: AgentRun,
    conversation: Conversation,
    brand: Brand.nullable(),
    /** The brand's current approved profile; null without brand or approved profile. */
    brandProfile: BrandProfile.nullable(),
    /** Oldest first; the last `TURN_CONTEXT_MESSAGES` messages. */
    messages: z.array(Message),
    /** True when older messages were left out. */
    messagesTruncated: z.boolean(),
    /** Metadata of every asset attached in `messages`. */
    assets: z.array(Asset),
    /** Latest plan of the conversation that is not rejected or superseded. */
    openPlan: Plan.nullable(),
    /** The run's assistant message so far (null before the first write). */
    assistantMessage: Message.nullable(),
  })
  .meta({ id: "TurnContext" });
export type TurnContext = z.infer<typeof TurnContext>;

const PartIndex = z
  .number()
  .int()
  .min(0)
  .max(MAX_PARTS_PER_MESSAGE - 1);

/**
 * Append `text` to the text part at `index` (creating it when `index` is the
 * next free position and `seq` is 1). `seq` counts deltas per part from 1:
 * a `seq` already applied is skipped (safe retries), a gap is refused (409).
 */
export const TextDeltaOp = z
  .object({
    op: z.literal("text.delta"),
    index: PartIndex,
    seq: z.number().int().min(1),
    text: z
      .string()
      .min(1)
      .refine(
        bytesAtMost(MAX_TEXT_DELTA_BYTES),
        `a delta is at most ${MAX_TEXT_DELTA_BYTES} bytes`,
      ),
  })
  .meta({ id: "TextDeltaOp" });
export type TextDeltaOp = z.input<typeof TextDeltaOp>;

/**
 * Put a part at `index`: append when `index` is the next free position,
 * replace when a part of the same type is there (identical = no-op). An
 * answered question cannot be replaced.
 */
export const PartSetOp = z
  .object({ op: z.literal("part.set"), index: PartIndex, part: MessagePartInput })
  .meta({ id: "PartSetOp" });
export type PartSetOp = z.input<typeof PartSetOp>;

export const TurnOp = z.discriminatedUnion("op", [TextDeltaOp, PartSetOp]).meta({ id: "TurnOp" });
export type TurnOp = z.input<typeof TurnOp>;

/** Applied in order, all or nothing. */
export const TurnOps = z
  .object({
    attempt: RunAttempt.optional(),
    ops: z.array(TurnOp).min(1).max(MAX_TURN_OPS),
  })
  .meta({ id: "TurnOps" });
export type TurnOps = z.input<typeof TurnOps>;

export const TurnWriteResult = z
  .object({ run: AgentRun, message: Message })
  .meta({ id: "TurnWriteResult" });
export type TurnWriteResult = z.infer<typeof TurnWriteResult>;

/**
 * Create the run's plan proposal, or replace it while it is still draft /
 * proposed (same plan id, revision + 1). Other open plans of the conversation
 * become `superseded`. A `plan_proposal` part is appended to the assistant
 * message the first time. Sending the same body again changes nothing.
 */
export const PlanProposalPut = z
  .object({
    attempt: RunAttempt.optional(),
    /** Needed when the conversation has no brand yet (it then gets this one). */
    brandId: EntityId.optional(),
    title: z.string().trim().max(200).default(""),
    periodStart: z.iso.date(),
    periodEnd: z.iso.date(),
    summary: z.string().max(20_000).default(""),
    status: z.enum(["draft", "proposed"]).default("proposed"),
    items: z
      .array(PlanItemInput.omit({ id: true }))
      .min(1)
      .max(MAX_PLAN_ITEMS),
  })
  .meta({ id: "PlanProposalPut" });
export type PlanProposalPut = z.input<typeof PlanProposalPut>;

export const PlanProposalResult = z
  .object({ plan: Plan, message: Message })
  .meta({ id: "PlanProposalResult" });
export type PlanProposalResult = z.infer<typeof PlanProposalResult>;

export const RunComplete = z
  .object({
    attempt: RunAttempt.optional(),
    model: z.string().max(200).optional(),
    usage: RunUsage.optional(),
  })
  .meta({ id: "RunComplete" });
export type RunComplete = z.input<typeof RunComplete>;

/** The server appends an `error` part with `error` to the assistant message. */
export const RunFail = z
  .object({
    attempt: RunAttempt.optional(),
    error: z.string().trim().min(1).max(10_000),
    model: z.string().max(200).optional(),
    usage: RunUsage.optional(),
  })
  .meta({ id: "RunFail" });
export type RunFail = z.input<typeof RunFail>;
