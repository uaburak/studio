import {
  type AgentRun,
  type AttachmentPart,
  ContentGeneratePayload,
  type Conversation,
  ConversationEvent,
  type ConversationUpdate,
  checkPlanPeriod,
  checkQuestionAnswer,
  DEFAULT_JOB_MAX_ATTEMPTS,
  isActiveRunStatus,
  isPlanEditable,
  isTerminalJobStatus,
  type Job,
  MAX_MESSAGE_BYTES,
  MAX_TEXT_PART_BYTES,
  type Message,
  type MessagePart,
  type MessagePartInput,
  type Plan,
  type PlanAccept,
  type PlanGenerate,
  type PlanGenerateResult,
  type PlanItemInput,
  type PlanProposalPut,
  type PlanProposalResult,
  type PlanReject,
  type PlanUpdate,
  type QuestionAnswerCreate,
  type QuestionAnswerResult,
  type QuestionPart,
  type RunComplete,
  type RunFail,
  type RunUsage,
  type TurnContext,
  type TurnOps,
  type TurnWriteResult,
  type UserMessageCreate,
  type UserMessageResult,
  utf8Length,
} from "@studio/contract";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  type AgentRunRow,
  type ConversationRow,
  type JobRow,
  type MessageRow,
  type PlanItemRow,
  type PlanRow,
  toAgentRun,
  toConversation,
  toJob,
  toMessage,
  toPlan,
  toPlanItem,
} from "../db/mappers.ts";
import {
  agentRuns,
  assets,
  brandProfiles,
  brands,
  contentPlans,
  contents,
  contentVersions,
  conversationEvents,
  conversations,
  jobs,
  messages,
  planItems,
} from "../db/schema.ts";
import { ApiProblem, badRequest, conflict, invalidTransition, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import {
  activeRunOf,
  assistantMessageOf,
  loadPlan,
  plansWithItems,
  requireConversation,
  requireRun,
  turnContext,
} from "./read.ts";

/*
 * Every conversation/plan mutation (from clients, from the worker's turn API
 * and from job-status hooks) runs here, inside the Hub Durable Object's serial
 * queue. That gives three guarantees without database locks:
 * - check-then-write sequences (one active run, run still writable, plan
 *   revision) cannot interleave;
 * - stream sequence numbers are assigned in order without gaps;
 * - each change and its stream events land in the same D1 batch (atomic),
 *   so a client resuming from `seq` never misses or double-applies a change.
 */

/** chat.turn jobs jump ahead of batch work (generation); a lost turn is retried once. */
export const CHAT_TURN_PRIORITY = 10;
export const CHAT_TURN_MAX_ATTEMPTS = 2;

export type ChatCommand =
  | { kind: "updateConversation"; id: string; input: z.output<typeof ConversationUpdate> }
  | { kind: "sendUserMessage"; conversationId: string; input: z.output<typeof UserMessageCreate> }
  | {
      kind: "answerQuestion";
      conversationId: string;
      messageId: string;
      input: z.output<typeof QuestionAnswerCreate>;
    }
  | { kind: "cancelRun"; runId: string }
  | { kind: "updatePlan"; planId: string; input: z.output<typeof PlanUpdate> }
  | { kind: "acceptPlan"; planId: string; input: z.output<typeof PlanAccept> }
  | { kind: "rejectPlan"; planId: string; input: z.output<typeof PlanReject> }
  | { kind: "generatePlan"; planId: string; input: z.output<typeof PlanGenerate> }
  | { kind: "startRun"; runId: string; attempt: number }
  | { kind: "applyOps"; runId: string; input: z.output<typeof TurnOps> }
  | { kind: "putPlan"; runId: string; input: z.output<typeof PlanProposalPut> }
  | { kind: "completeRun"; runId: string; input: z.output<typeof RunComplete> }
  | { kind: "failRun"; runId: string; input: z.output<typeof RunFail> };

export interface ChatResults {
  updateConversation: Conversation;
  sendUserMessage: UserMessageResult;
  answerQuestion: QuestionAnswerResult;
  cancelRun: AgentRun;
  updatePlan: Plan;
  acceptPlan: Plan;
  rejectPlan: Plan;
  generatePlan: PlanGenerateResult;
  startRun: TurnContext;
  applyOps: TurnWriteResult;
  putPlan: PlanProposalResult;
  completeRun: AgentRun;
  failRun: AgentRun;
}

/** What the Hub must do after a committed change. */
export interface ChatEffects {
  /** Conversations with new events to push. */
  conversations: Set<string>;
  /** Jobs inserted as `queued`: publish and dispatch. */
  jobsCreated: string[];
  /** Jobs to cancel (their run was cancelled). */
  jobsToCancel: string[];
}

export function newEffects(): ChatEffects {
  return { conversations: new Set(), jobsCreated: [], jobsToCancel: [] };
}

type Batch = [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]];
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EventBody = DistributiveOmit<ConversationEvent, "seq">;

/**
 * One atomic change: statements plus the stream events they cause. `commit`
 * assigns seqs (conversation.last_seq + 1, + 2, ...) and writes everything in
 * a single D1 batch. The (conversation_id, seq) primary key makes a double
 * assignment fail the whole batch instead of corrupting the log.
 */
class Change {
  private readonly stmts: BatchItem<"sqlite">[] = [];
  private readonly events = new Map<string, EventBody[]>();
  private readonly created: string[] = [];
  private readonly cancels: string[] = [];

  constructor(
    readonly db: Db,
    readonly now: Date,
    private readonly effects: ChatEffects,
  ) {}

  add(stmt: BatchItem<"sqlite">): void {
    this.stmts.push(stmt);
  }

  emit(conversationId: string | null, event: EventBody): void {
    if (!conversationId) return;
    // Validate now: a malformed event must fail the change, not the stream later.
    ConversationEvent.parse({ ...event, seq: 1 });
    const list = this.events.get(conversationId) ?? [];
    list.push(event);
    this.events.set(conversationId, list);
  }

  jobCreated(id: string): void {
    this.created.push(id);
  }

  cancelJob(id: string): void {
    this.cancels.push(id);
  }

  get empty(): boolean {
    return this.stmts.length === 0 && this.events.size === 0;
  }

  async commit(): Promise<void> {
    const stmts = [...this.stmts];
    for (const [conversationId, list] of this.events) {
      const conv = await requireConversation(this.db, conversationId);
      let seq = conv.lastSeq;
      for (const event of list) {
        seq++;
        const data =
          event.type === "conversation.updated"
            ? { ...event, conversation: { ...event.conversation, lastSeq: seq } }
            : event;
        stmts.push(
          this.db.insert(conversationEvents).values({
            conversationId,
            seq,
            type: event.type,
            data: data as Record<string, unknown>,
            createdAt: this.now,
          }),
        );
      }
      stmts.push(
        this.db
          .update(conversations)
          .set({ lastSeq: seq, lastActivityAt: this.now })
          .where(
            and(eq(conversations.id, conversationId), eq(conversations.lastSeq, conv.lastSeq)),
          ),
      );
    }
    if (stmts.length > 0) await this.db.batch(stmts as Batch);
    for (const id of this.events.keys()) this.effects.conversations.add(id);
    this.effects.jobsCreated.push(...this.created);
    this.effects.jobsToCancel.push(...this.cancels);
  }
}

// --- small helpers ------------------------------------------------------------------

const iso = (d: Date) => d.toISOString();

/** JSON with sorted keys, for "is this the same part/plan" comparisons. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
}

function deriveTitle(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
}

function assertWritable(run: AgentRunRow, attempt: number | undefined): void {
  if (run.status === "queued") {
    throw conflict(`run ${run.id} has not been started; call start first`);
  }
  if (!isActiveRunStatus(run.status)) {
    throw invalidTransition(`run ${run.id} is ${run.status}; it accepts no more writes`);
  }
  if (attempt !== undefined && attempt !== run.attempt) {
    throw conflict(`stale attempt ${attempt}; run ${run.id} is on attempt ${run.attempt}`);
  }
}

async function requireActiveBrand(db: Db, brandId: string) {
  const brand = await db.query.brands.findFirst({ where: eq(brands.id, brandId) });
  if (!brand) throw notFound("brand", brandId);
  if (brand.status !== "active") throw conflict(`brand ${brandId} is archived`);
  return brand;
}

function convView(row: ConversationRow, activeRunId: string | null): Conversation {
  return toConversation(row, activeRunId);
}

function messageRowView(row: MessageRow): Message {
  return toMessage(row);
}

async function attachmentParts(
  db: Db,
  conv: ConversationRow,
  ids: readonly string[],
  pathOf: (index: number) => string,
): Promise<AttachmentPart[]> {
  if (ids.length === 0) return [];
  if (!conv.brandId) {
    throw badRequest("this conversation has no brand yet; set one before attaching files", [
      { path: pathOf(0), message: "conversation has no brand" },
    ]);
  }
  const rows = await db
    .select()
    .from(assets)
    .where(inArray(assets.id, [...ids]));
  return ids.map((id, i) => {
    const asset = rows.find((a) => a.id === id);
    if (!asset) throw notFound("asset", id);
    if (asset.brandId !== conv.brandId) {
      throw badRequest(`asset ${id} belongs to another brand`, [
        { path: pathOf(i), message: "asset must belong to the conversation's brand" },
      ]);
    }
    return {
      type: "attachment",
      assetId: asset.id,
      kind: asset.kind,
      mimeType: asset.mimeType,
      width: asset.width,
      height: asset.height,
      filename: asset.originalFilename,
    };
  });
}

/** Turn a validated part input into the stored part (lookups and brand checks included). */
async function buildPart(
  db: Db,
  conv: ConversationRow,
  input: z.output<typeof MessagePartInput>,
  path: string,
): Promise<MessagePart> {
  switch (input.type) {
    case "text":
    case "progress":
    case "error":
      return input;
    case "attachment": {
      const [part] = await attachmentParts(db, conv, [input.assetId], () => `${path}.assetId`);
      if (!part) throw new Error("attachment lookup returned nothing");
      return part;
    }
    case "plan_proposal": {
      const plan = await db.query.contentPlans.findFirst({
        where: eq(contentPlans.id, input.planId),
      });
      if (!plan) throw notFound("plan", input.planId);
      if (plan.conversationId !== conv.id) {
        throw badRequest(`plan ${input.planId} belongs to another conversation`, [
          { path: `${path}.planId`, message: "plan must belong to this conversation" },
        ]);
      }
      return input;
    }
    case "content_ref": {
      const content = await db.query.contents.findFirst({
        where: eq(contents.id, input.contentId),
      });
      if (!content) throw notFound("content", input.contentId);
      if (conv.brandId && content.brandId !== conv.brandId) {
        throw badRequest(`content ${input.contentId} belongs to another brand`, [
          { path: `${path}.contentId`, message: "content must belong to the conversation's brand" },
        ]);
      }
      if (input.version !== null) {
        const version = await db.query.contentVersions.findFirst({
          where: and(
            eq(contentVersions.contentId, input.contentId),
            eq(contentVersions.version, input.version),
          ),
        });
        if (!version) throw notFound(`content ${input.contentId} version`, input.version);
      }
      return input;
    }
    case "question":
      return { ...input, answer: null };
  }
}

/** Insert a queued agent run and its chat.turn job; returns the run row (not yet written). */
function startTurn(change: Change, conv: ConversationRow, triggerMessageId: string): AgentRunRow {
  const { db, now } = change;
  const runId = newId();
  const jobId = newId();
  change.add(
    db.insert(jobs).values({
      id: jobId,
      type: "chat.turn",
      status: "queued",
      brandId: conv.brandId,
      contentId: null,
      payload: { conversationId: conv.id, runId },
      priority: CHAT_TURN_PRIORITY,
      maxAttempts: CHAT_TURN_MAX_ATTEMPTS,
      createdAt: now,
      updatedAt: now,
    }),
  );
  const run: AgentRunRow = {
    id: runId,
    conversationId: conv.id,
    triggerMessageId,
    jobId,
    status: "queued",
    attempt: 0,
    model: null,
    usage: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
  };
  change.add(db.insert(agentRuns).values(run));
  change.jobCreated(jobId);
  change.emit(conv.id, { type: "run.updated", run: toAgentRun(run) });
  return run;
}

type RunOutcome =
  | { status: "completed"; model?: string | undefined; usage?: RunUsage | undefined }
  | { status: "failed"; error: string; model?: string | undefined; usage?: RunUsage | undefined }
  | { status: "cancelled" };

/** Move an active run to a final status and settle its assistant message. */
async function finishRun(change: Change, run: AgentRunRow, outcome: RunOutcome): Promise<void> {
  const { db, now } = change;
  const conv = await requireConversation(db, run.conversationId);
  const next: AgentRunRow = {
    ...run,
    status: outcome.status,
    error: outcome.status === "failed" ? outcome.error : null,
    model: "model" in outcome && outcome.model !== undefined ? outcome.model : run.model,
    usage:
      "usage" in outcome && outcome.usage !== undefined
        ? (outcome.usage as Record<string, unknown>)
        : run.usage,
    finishedAt: now,
    updatedAt: now,
  };
  change.add(
    db
      .update(agentRuns)
      .set({
        status: next.status,
        error: next.error,
        model: next.model,
        usage: next.usage,
        finishedAt: now,
        updatedAt: now,
      })
      .where(and(eq(agentRuns.id, run.id), inArray(agentRuns.status, ["queued", "running"]))),
  );

  const messageStatus =
    outcome.status === "completed"
      ? "complete"
      : outcome.status === "failed"
        ? "failed"
        : "cancelled";
  const msg = await assistantMessageOf(db, run.id);
  const errorText = outcome.status === "failed" ? outcome.error : null;
  const errorPart: MessagePart | null =
    errorText !== null ? { type: "error", message: errorText, code: null, retryable: false } : null;

  if (msg) {
    const parts = [...(msg.parts as MessagePart[])];
    const deltaSeqs = [...msg.deltaSeqs];
    const last = parts.at(-1);
    if (errorPart && !(last?.type === "error" && last.message === errorText)) {
      parts.push(errorPart);
      deltaSeqs.push(0);
    }
    const updated: MessageRow = {
      ...msg,
      parts,
      deltaSeqs,
      status: msg.status === "streaming" ? messageStatus : msg.status,
      updatedAt: now,
    };
    change.add(
      db
        .update(messages)
        .set({ parts, deltaSeqs, status: updated.status, updatedAt: now })
        .where(eq(messages.id, msg.id)),
    );
    change.emit(conv.id, { type: "message.updated", message: messageRowView(updated) });
  } else if (errorPart) {
    const created: MessageRow = {
      id: newId(),
      conversationId: conv.id,
      role: "assistant",
      status: "failed",
      runId: run.id,
      parts: [errorPart],
      deltaSeqs: [0],
      clientMessageId: null,
      createdAt: now,
      updatedAt: now,
    };
    change.add(db.insert(messages).values(created));
    change.emit(conv.id, { type: "message.created", message: messageRowView(created) });
  }
  change.emit(conv.id, { type: "run.updated", run: toAgentRun(next) });
  change.emit(conv.id, { type: "conversation.updated", conversation: convView(conv, null) });
}

/** Load the run's assistant message, or plan to create it (status streaming). */
async function assistantDraft(change: Change, run: AgentRunRow) {
  const existing = await assistantMessageOf(change.db, run.id);
  if (existing) return { row: { ...existing }, created: false };
  const row: MessageRow = {
    id: newId(),
    conversationId: run.conversationId,
    role: "assistant",
    status: "streaming",
    runId: run.id,
    parts: [],
    deltaSeqs: [],
    clientMessageId: null,
    createdAt: change.now,
    updatedAt: change.now,
  };
  change.emit(run.conversationId, { type: "message.created", message: messageRowView(row) });
  return { row, created: true };
}

function persistMessage(change: Change, row: MessageRow, created: boolean): void {
  const size = utf8Length(JSON.stringify(row.parts));
  if (size > MAX_MESSAGE_BYTES) {
    throw new ApiProblem(
      "payload_too_large",
      `the message would exceed ${MAX_MESSAGE_BYTES} bytes`,
    );
  }
  if (created) {
    change.add(change.db.insert(messages).values(row));
  } else {
    change.add(
      change.db
        .update(messages)
        .set({
          parts: row.parts,
          deltaSeqs: row.deltaSeqs,
          status: row.status,
          updatedAt: change.now,
        })
        .where(eq(messages.id, row.id)),
    );
  }
}

// --- plans --------------------------------------------------------------------------

type ItemInput = z.output<typeof PlanItemInput>;

function newItemRow(planId: string, position: number, input: ItemInput, now: Date): PlanItemRow {
  return {
    id: newId(),
    planId,
    position,
    date: input.date,
    platforms: input.platforms,
    contentType: input.contentType,
    title: input.title,
    brief: input.brief,
    pillar: input.pillar,
    imageSlot: input.imageSlot,
    imageBrief: input.imageBrief,
    status: "planned",
    contentId: null,
    generationJobId: null,
    generationStatus: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Comparable shape of an item's editable fields. */
function itemFields(
  i: Pick<
    PlanItemRow,
    "date" | "platforms" | "contentType" | "title" | "brief" | "pillar" | "imageSlot" | "imageBrief"
  >,
) {
  return {
    date: i.date,
    platforms: i.platforms,
    contentType: i.contentType,
    title: i.title,
    brief: i.brief,
    pillar: i.pillar,
    imageSlot: i.imageSlot,
    imageBrief: i.imageBrief,
  };
}

async function requirePlanRows(db: Db, id: string) {
  const plan = await db.query.contentPlans.findFirst({ where: eq(contentPlans.id, id) });
  if (!plan) throw notFound("plan", id);
  const items = await db.select().from(planItems).where(eq(planItems.planId, id));
  items.sort((a, b) => a.position - b.position);
  return { plan, items };
}

function planView(
  plan: PlanRow,
  items: PlanItemRow[],
  jobsById: Map<string, JobRow> = new Map(),
): Plan {
  return toPlan(
    plan,
    items.map((i) => {
      const job = i.generationJobId ? jobsById.get(i.generationJobId) : undefined;
      return toPlanItem(i, job ? { id: job.id, status: job.status, error: job.error } : null);
    }),
  );
}

function checkRevision(plan: PlanRow, revision: number): void {
  if (plan.revision !== revision) {
    throw conflict(`plan ${plan.id} is at revision ${plan.revision}, not ${revision}; reload it`);
  }
}

function replaceItems(change: Change, planId: string, rows: PlanItemRow[]): void {
  change.add(change.db.delete(planItems).where(eq(planItems.planId, planId)));
  // One insert per item: D1 binds at most 100 parameters per statement.
  for (const row of rows) change.add(change.db.insert(planItems).values(row));
}

// --- commands -------------------------------------------------------------------------

export async function executeChat(
  db: Db,
  command: ChatCommand,
  effects: ChatEffects,
): Promise<ChatResults[ChatCommand["kind"]]> {
  const change = new Change(db, new Date(), effects);
  switch (command.kind) {
    case "updateConversation":
      return updateConversation(change, command.id, command.input);
    case "sendUserMessage":
      return sendUserMessage(change, command.conversationId, command.input);
    case "answerQuestion":
      return answerQuestion(change, command.conversationId, command.messageId, command.input);
    case "cancelRun":
      return cancelRun(change, command.runId);
    case "updatePlan":
      return updatePlan(change, command.planId, command.input);
    case "acceptPlan":
      return acceptPlan(change, command.planId, command.input);
    case "rejectPlan":
      return rejectPlan(change, command.planId, command.input);
    case "generatePlan":
      return generatePlan(change, command.planId, command.input);
    case "startRun":
      return startRun(change, command.runId, command.attempt);
    case "applyOps":
      return applyOps(change, command.runId, command.input);
    case "putPlan":
      return putPlan(change, command.runId, command.input);
    case "completeRun":
      return completeRun(change, command.runId, command.input);
    case "failRun":
      return failRun(change, command.runId, command.input);
  }
}

async function updateConversation(
  change: Change,
  id: string,
  input: z.output<typeof ConversationUpdate>,
): Promise<Conversation> {
  const { db, now } = change;
  const conv = await requireConversation(db, id);
  const set: Partial<ConversationRow> = {};
  if (input.title !== undefined && input.title !== conv.title) set.title = input.title;
  if (input.status !== undefined && input.status !== conv.status) set.status = input.status;
  if (input.brandId !== undefined && input.brandId !== conv.brandId) {
    if (conv.brandId) {
      throw conflict(`conversation ${id} already belongs to brand ${conv.brandId}`);
    }
    await requireActiveBrand(db, input.brandId);
    set.brandId = input.brandId;
  }
  const active = await activeRunOf(db, id);
  if (Object.keys(set).length > 0) {
    change.add(
      db
        .update(conversations)
        .set({ ...set, updatedAt: now })
        .where(eq(conversations.id, id)),
    );
    change.emit(id, {
      type: "conversation.updated",
      conversation: convView({ ...conv, ...set, updatedAt: now }, active?.id ?? null),
    });
    await change.commit();
  }
  return convView(await requireConversation(db, id), active?.id ?? null);
}

async function sendUserMessage(
  change: Change,
  conversationId: string,
  input: z.output<typeof UserMessageCreate>,
): Promise<UserMessageResult> {
  const { db, now } = change;
  const conv = await requireConversation(db, conversationId);

  if (input.clientMessageId) {
    const earlier = await db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, conversationId),
        eq(messages.clientMessageId, input.clientMessageId),
      ),
    });
    if (earlier) {
      const run = await db.query.agentRuns.findFirst({
        where: eq(agentRuns.triggerMessageId, earlier.id),
      });
      if (run) return { message: toMessage(earlier), run: toAgentRun(run), replayed: true };
    }
  }
  if (conv.status === "archived") {
    throw conflict(`conversation ${conversationId} is archived; unarchive it to continue`);
  }
  const active = await activeRunOf(db, conversationId);
  if (active) {
    throw conflict(
      `agent run ${active.id} is still ${active.status}; wait for it to finish or cancel it`,
    );
  }

  const parts: MessagePart[] = [];
  if (input.text) parts.push({ type: "text", text: input.text });
  parts.push(
    ...(await attachmentParts(
      db,
      conv,
      input.attachmentAssetIds,
      (i) => `attachmentAssetIds.${i}`,
    )),
  );

  const message: MessageRow = {
    id: newId(),
    conversationId,
    role: "user",
    status: "complete",
    runId: null,
    parts,
    deltaSeqs: parts.map(() => 0),
    clientMessageId: input.clientMessageId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  change.add(db.insert(messages).values(message));
  change.emit(conversationId, { type: "message.created", message: messageRowView(message) });
  const run = startTurn(change, conv, message.id);

  const title = conv.title === "" && input.text ? deriveTitle(input.text) : conv.title;
  if (title !== conv.title) {
    change.add(
      db.update(conversations).set({ title, updatedAt: now }).where(eq(conversations.id, conv.id)),
    );
  }
  change.emit(conversationId, {
    type: "conversation.updated",
    conversation: convView(
      { ...conv, title, updatedAt: title !== conv.title ? now : conv.updatedAt },
      run.id,
    ),
  });
  await change.commit();
  return { message: messageRowView(message), run: toAgentRun(run), replayed: false };
}

async function answerQuestion(
  change: Change,
  conversationId: string,
  messageId: string,
  input: z.output<typeof QuestionAnswerCreate>,
): Promise<QuestionAnswerResult> {
  const { db, now } = change;
  const conv = await requireConversation(db, conversationId);
  const msg = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)),
  });
  if (!msg) throw notFound("message", messageId);
  const parts = [...(msg.parts as MessagePart[])];
  const index = parts.findIndex((p) => p.type === "question" && p.questionId === input.questionId);
  const question = parts[index] as QuestionPart | undefined;
  if (!question) throw notFound(`message ${messageId} question`, input.questionId);

  const text = input.text?.trim() ? input.text.trim() : null;
  if (question.answer) {
    const same =
      stableJson(question.answer.optionIds) === stableJson(input.optionIds) &&
      question.answer.text === text;
    if (same) return { message: toMessage(msg), run: null };
    throw conflict(`question ${input.questionId} was already answered`);
  }
  if (conv.status === "archived") {
    throw conflict(`conversation ${conversationId} is archived; unarchive it to continue`);
  }
  const problem = checkQuestionAnswer(question, { optionIds: input.optionIds, text });
  if (problem) throw badRequest(problem, [{ path: "optionIds", message: problem }]);

  const answered: QuestionPart = {
    ...question,
    answer: { optionIds: input.optionIds, text, answeredAt: iso(now) },
  };
  parts[index] = answered;
  const updated: MessageRow = { ...msg, parts, updatedAt: now };
  change.add(db.update(messages).set({ parts, updatedAt: now }).where(eq(messages.id, msg.id)));
  change.emit(conversationId, { type: "part.updated", messageId, index, part: answered });

  // The asking run (or any other active run) reads the answer itself; otherwise the answer starts a turn.
  let run: AgentRunRow | null = null;
  if (!(await activeRunOf(db, conversationId))) {
    run = startTurn(change, conv, msg.id);
    change.emit(conversationId, {
      type: "conversation.updated",
      conversation: convView(conv, run.id),
    });
  }
  await change.commit();
  return { message: messageRowView(updated), run: run ? toAgentRun(run) : null };
}

async function cancelRun(change: Change, runId: string): Promise<AgentRun> {
  const run = await requireRun(change.db, runId);
  if (run.status === "cancelled") return toAgentRun(run);
  if (!isActiveRunStatus(run.status)) {
    throw invalidTransition(`run ${runId} is already ${run.status}`);
  }
  await finishRun(change, run, { status: "cancelled" });
  if (run.jobId) change.cancelJob(run.jobId);
  await change.commit();
  return toAgentRun(await requireRun(change.db, runId));
}

async function startRun(change: Change, runId: string, attempt: number): Promise<TurnContext> {
  const { db, now } = change;
  const run = await requireRun(db, runId);
  if (!isActiveRunStatus(run.status)) {
    throw invalidTransition(`run ${runId} is ${run.status}; it cannot start`);
  }
  if (attempt < run.attempt) {
    throw conflict(`stale attempt ${attempt}; run ${runId} is on attempt ${run.attempt}`);
  }
  if (!(run.status === "running" && attempt === run.attempt)) {
    const next: AgentRunRow = {
      ...run,
      status: "running",
      attempt,
      startedAt: run.startedAt ?? now,
      updatedAt: now,
    };
    change.add(
      db
        .update(agentRuns)
        .set({ status: "running", attempt, startedAt: next.startedAt, updatedAt: now })
        .where(eq(agentRuns.id, runId)),
    );
    // A new attempt starts the assistant message over.
    if (run.attempt > 0 && attempt > run.attempt) {
      const msg = await assistantMessageOf(db, runId);
      if (msg) {
        const reset: MessageRow = {
          ...msg,
          parts: [],
          deltaSeqs: [],
          status: "streaming",
          updatedAt: now,
        };
        persistMessage(change, reset, false);
        change.emit(run.conversationId, {
          type: "message.updated",
          message: messageRowView(reset),
        });
      }
    }
    change.emit(run.conversationId, { type: "run.updated", run: toAgentRun(next) });
    await change.commit();
  }
  return turnContext(db, runId);
}

async function applyOps(
  change: Change,
  runId: string,
  input: z.output<typeof TurnOps>,
): Promise<TurnWriteResult> {
  const { db, now } = change;
  const run = await requireRun(db, runId);
  assertWritable(run, input.attempt);
  const conv = await requireConversation(db, run.conversationId);
  const { row, created } = await assistantDraft(change, run);
  const parts = [...(row.parts as MessagePart[])];
  const seqs = [...row.deltaSeqs];
  let changed = created;

  for (const [n, op] of input.ops.entries()) {
    const at = `ops.${n}`;
    if (op.index > parts.length) {
      throw conflict(
        `${at}: part index ${op.index} leaves a gap (message has ${parts.length} parts)`,
      );
    }
    if (op.op === "text.delta") {
      const current = parts[op.index];
      if (!current) {
        if (op.seq !== 1) throw conflict(`${at}: a new text part starts with seq 1, got ${op.seq}`);
        parts.push({ type: "text", text: op.text });
        seqs[op.index] = 1;
      } else {
        if (current.type !== "text") {
          throw conflict(`${at}: part ${op.index} is ${current.type}, not text`);
        }
        const last = seqs[op.index] ?? 0;
        if (op.seq <= last) continue; // already applied (retry)
        if (op.seq !== last + 1) {
          throw conflict(
            `${at}: delta gap on part ${op.index}: expected seq ${last + 1}, got ${op.seq}`,
          );
        }
        const text = current.text + op.text;
        if (utf8Length(text) > MAX_TEXT_PART_BYTES) {
          throw new ApiProblem(
            "payload_too_large",
            `${at}: text part ${op.index} would exceed ${MAX_TEXT_PART_BYTES} bytes`,
          );
        }
        parts[op.index] = { type: "text", text };
        seqs[op.index] = op.seq;
      }
      change.emit(conv.id, {
        type: "text.delta",
        messageId: row.id,
        index: op.index,
        text: op.text,
      });
      changed = true;
      continue;
    }

    const part = await buildPart(db, conv, op.part, `${at}.part`);
    if (part.type === "question") {
      const clash = parts.some(
        (p, i) => i !== op.index && p.type === "question" && p.questionId === part.questionId,
      );
      if (clash)
        throw conflict(`${at}: question id ${part.questionId} is already used in this message`);
    }
    const current = parts[op.index];
    if (!current) {
      parts.push(part);
      seqs[op.index] = 0;
      change.emit(conv.id, { type: "part.added", messageId: row.id, index: op.index, part });
      changed = true;
      continue;
    }
    if (current.type !== part.type) {
      throw conflict(
        `${at}: part ${op.index} is ${current.type}; cannot replace it with ${part.type}`,
      );
    }
    if (current.type === "question" && current.answer) {
      if (stableJson({ ...current, answer: null }) === stableJson(part)) continue;
      throw conflict(`${at}: question ${current.questionId} was already answered`);
    }
    if (stableJson(current) === stableJson(part)) continue; // identical: retry
    parts[op.index] = part;
    change.emit(conv.id, { type: "part.updated", messageId: row.id, index: op.index, part });
    changed = true;
  }

  const next: MessageRow = {
    ...row,
    parts,
    deltaSeqs: seqs,
    updatedAt: changed ? now : row.updatedAt,
  };
  if (changed) {
    persistMessage(change, next, created);
    await change.commit();
  }
  return { run: toAgentRun(run), message: messageRowView(next) };
}

async function putPlan(
  change: Change,
  runId: string,
  input: z.output<typeof PlanProposalPut>,
): Promise<PlanProposalResult> {
  const { db, now } = change;
  const run = await requireRun(db, runId);
  assertWritable(run, input.attempt);
  const conv = await requireConversation(db, run.conversationId);

  if (input.brandId && conv.brandId && input.brandId !== conv.brandId) {
    throw badRequest("brandId differs from the conversation's brand", [
      { path: "brandId", message: `conversation belongs to brand ${conv.brandId}` },
    ]);
  }
  const brandId = conv.brandId ?? input.brandId;
  if (!brandId) {
    throw badRequest("the conversation has no brand yet; pass brandId", [
      { path: "brandId", message: "required while the conversation has no brand" },
    ]);
  }
  await requireActiveBrand(db, brandId);
  const periodProblem = checkPlanPeriod(
    input.periodStart,
    input.periodEnd,
    input.items.map((i) => i.date),
  );
  if (periodProblem) throw badRequest(periodProblem, [{ path: "items", message: periodProblem }]);

  if (!conv.brandId) {
    const active = await activeRunOf(db, conv.id);
    change.add(
      db
        .update(conversations)
        .set({ brandId, updatedAt: now })
        .where(eq(conversations.id, conv.id)),
    );
    change.emit(conv.id, {
      type: "conversation.updated",
      conversation: convView({ ...conv, brandId, updatedAt: now }, active?.id ?? null),
    });
  }

  // The run's own plan, while still open, is replaced in place; otherwise a new plan.
  const own = await db.query.contentPlans.findFirst({
    where: and(eq(contentPlans.runId, runId), eq(contentPlans.conversationId, conv.id)),
    orderBy: desc(contentPlans.id),
  });
  let planRow: PlanRow;
  let itemRows: PlanItemRow[];
  let planChanged = true;

  if (own && isPlanEditable(own.status)) {
    if (own.status === "proposed" && input.status === "draft") {
      throw invalidTransition(`plan ${own.id} is already proposed; it cannot go back to draft`);
    }
    const { items: currentItems } = await requirePlanRows(db, own.id);
    const same =
      own.title === input.title &&
      own.periodStart === input.periodStart &&
      own.periodEnd === input.periodEnd &&
      own.summary === input.summary &&
      own.status === input.status &&
      stableJson(currentItems.map(itemFields)) === stableJson(input.items.map(itemFields));
    if (same) {
      planRow = own;
      itemRows = currentItems;
      planChanged = false;
    } else {
      planRow = {
        ...own,
        title: input.title,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        summary: input.summary,
        status: input.status,
        revision: own.revision + 1,
        updatedAt: now,
      };
      itemRows = input.items.map((item, i) => newItemRow(own.id, i, item, now));
      change.add(
        db
          .update(contentPlans)
          .set({
            title: planRow.title,
            periodStart: planRow.periodStart,
            periodEnd: planRow.periodEnd,
            summary: planRow.summary,
            status: planRow.status,
            revision: planRow.revision,
            updatedAt: now,
          })
          .where(eq(contentPlans.id, own.id)),
      );
      replaceItems(change, own.id, itemRows);
    }
  } else {
    // Older open proposals of this conversation are superseded by the new one.
    const open = await db
      .select()
      .from(contentPlans)
      .where(
        and(
          eq(contentPlans.conversationId, conv.id),
          inArray(contentPlans.status, ["draft", "proposed"]),
        ),
      );
    for (const old of await plansWithItems(db, open)) {
      change.add(
        db
          .update(contentPlans)
          .set({ status: "superseded", updatedAt: now })
          .where(eq(contentPlans.id, old.id)),
      );
      change.emit(conv.id, {
        type: "plan.updated",
        plan: { ...old, status: "superseded", updatedAt: iso(now) },
      });
    }
    planRow = {
      id: newId(),
      brandId,
      conversationId: conv.id,
      runId,
      title: input.title,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: input.status,
      summary: input.summary,
      revision: 1,
      decidedAt: null,
      rejectionReason: null,
      createdAt: now,
      updatedAt: now,
    };
    itemRows = input.items.map((item, i) => newItemRow(planRow.id, i, item, now));
    change.add(db.insert(contentPlans).values(planRow));
    for (const row of itemRows) change.add(db.insert(planItems).values(row));
  }
  if (planChanged)
    change.emit(conv.id, { type: "plan.updated", plan: planView(planRow, itemRows) });

  // The assistant message shows the plan card once.
  const { row: msg, created } = await assistantDraft(change, run);
  const parts = [...(msg.parts as MessagePart[])];
  const hasCard = parts.some((p) => p.type === "plan_proposal" && p.planId === planRow.id);
  if (!hasCard) {
    const part: MessagePart = { type: "plan_proposal", planId: planRow.id };
    parts.push(part);
    const next: MessageRow = { ...msg, parts, deltaSeqs: [...msg.deltaSeqs, 0], updatedAt: now };
    change.emit(conv.id, { type: "part.added", messageId: msg.id, index: parts.length - 1, part });
    persistMessage(change, next, created);
  }
  if (!change.empty) await change.commit();
  const message = await assistantMessageOf(db, runId);
  if (!message) throw new Error("assistant message vanished");
  return { plan: await loadPlan(db, planRow.id), message: toMessage(message) };
}

async function completeRun(
  change: Change,
  runId: string,
  input: z.output<typeof RunComplete>,
): Promise<AgentRun> {
  const run = await requireRun(change.db, runId);
  if (run.status === "completed") return toAgentRun(run);
  assertWritable(run, input.attempt);
  await finishRun(change, run, { status: "completed", model: input.model, usage: input.usage });
  await change.commit();
  return toAgentRun(await requireRun(change.db, runId));
}

async function failRun(
  change: Change,
  runId: string,
  input: z.output<typeof RunFail>,
): Promise<AgentRun> {
  const run = await requireRun(change.db, runId);
  if (run.status === "failed") return toAgentRun(run);
  if (run.status !== "queued") assertWritable(run, input.attempt);
  await finishRun(change, run, {
    status: "failed",
    error: input.error,
    model: input.model,
    usage: input.usage,
  });
  await change.commit();
  return toAgentRun(await requireRun(change.db, runId));
}

async function updatePlan(
  change: Change,
  planId: string,
  input: z.output<typeof PlanUpdate>,
): Promise<Plan> {
  const { db, now } = change;
  const { plan, items } = await requirePlanRows(db, planId);
  if (!isPlanEditable(plan.status)) {
    throw invalidTransition(
      `plan ${planId} is ${plan.status}; only draft or proposed plans can be edited`,
    );
  }
  checkRevision(plan, input.revision);

  const next: PlanRow = {
    ...plan,
    title: input.title ?? plan.title,
    summary: input.summary ?? plan.summary,
    periodStart: input.periodStart ?? plan.periodStart,
    periodEnd: input.periodEnd ?? plan.periodEnd,
    revision: plan.revision + 1,
    updatedAt: now,
  };
  let nextItems = items;
  if (input.items) {
    const ids = input.items.map((i) => i.id).filter((id): id is string => id !== undefined);
    if (new Set(ids).size !== ids.length) throw badRequest("item ids must be unique");
    nextItems = input.items.map((item, position) => {
      if (item.id === undefined) return newItemRow(planId, position, item, now);
      const existing = items.find((i) => i.id === item.id);
      if (!existing) throw notFound(`plan ${planId} item`, item.id);
      return {
        ...existing,
        ...itemFields(newItemRow(planId, position, item, now)),
        position,
        updatedAt: now,
      };
    });
  }
  const periodProblem = checkPlanPeriod(
    next.periodStart,
    next.periodEnd,
    nextItems.map((i) => i.date),
  );
  if (periodProblem) throw badRequest(periodProblem, [{ path: "items", message: periodProblem }]);

  change.add(
    db
      .update(contentPlans)
      .set({
        title: next.title,
        summary: next.summary,
        periodStart: next.periodStart,
        periodEnd: next.periodEnd,
        revision: next.revision,
        updatedAt: now,
      })
      .where(and(eq(contentPlans.id, planId), eq(contentPlans.revision, plan.revision))),
  );
  if (input.items) replaceItems(change, planId, nextItems);
  change.emit(plan.conversationId, { type: "plan.updated", plan: planView(next, nextItems) });
  await change.commit();
  return loadPlan(db, planId);
}

async function acceptPlan(
  change: Change,
  planId: string,
  input: z.output<typeof PlanAccept>,
): Promise<Plan> {
  const { db, now } = change;
  const { plan, items } = await requirePlanRows(db, planId);
  if (plan.status !== "proposed") {
    throw invalidTransition(
      `plan ${planId} is ${plan.status}; only a proposed plan can be accepted`,
    );
  }
  checkRevision(plan, input.revision);
  const skip = new Set(input.skipItemIds);
  for (const id of skip)
    if (!items.some((i) => i.id === id)) throw notFound(`plan ${planId} item`, id);
  if (items.every((i) => skip.has(i.id))) {
    throw badRequest("every item is skipped; reject the plan instead", [
      { path: "skipItemIds", message: "at least one item must remain" },
    ]);
  }
  await requireActiveBrand(db, plan.brandId);

  const nextItems = items.map((item): PlanItemRow => {
    if (skip.has(item.id)) return { ...item, status: "skipped", updatedAt: now };
    const contentId = newId();
    change.add(
      db.insert(contents).values({
        id: contentId,
        brandId: plan.brandId,
        type: item.contentType,
        title: item.title,
        brief: item.brief,
        status: "draft",
        targetPlatforms: item.platforms,
        caption: "",
        createdAt: now,
        updatedAt: now,
      }),
    );
    return { ...item, status: "accepted", contentId, updatedAt: now };
  });
  for (const item of nextItems) {
    change.add(
      db
        .update(planItems)
        .set({ status: item.status, contentId: item.contentId, updatedAt: now })
        .where(eq(planItems.id, item.id)),
    );
  }
  const next: PlanRow = { ...plan, status: "accepted", decidedAt: now, updatedAt: now };
  change.add(
    db
      .update(contentPlans)
      .set({ status: "accepted", decidedAt: now, updatedAt: now })
      .where(and(eq(contentPlans.id, planId), eq(contentPlans.status, "proposed"))),
  );
  change.emit(plan.conversationId, { type: "plan.updated", plan: planView(next, nextItems) });
  await change.commit();
  return loadPlan(db, planId);
}

async function rejectPlan(
  change: Change,
  planId: string,
  input: z.output<typeof PlanReject>,
): Promise<Plan> {
  const { db, now } = change;
  const { plan, items } = await requirePlanRows(db, planId);
  if (plan.status === "rejected") return loadPlan(db, planId);
  if (!isPlanEditable(plan.status)) {
    throw invalidTransition(`plan ${planId} is ${plan.status}; it cannot be rejected`);
  }
  const reason = input.reason?.trim() ? input.reason.trim() : null;
  const next: PlanRow = {
    ...plan,
    status: "rejected",
    decidedAt: now,
    rejectionReason: reason,
    updatedAt: now,
  };
  change.add(
    db
      .update(contentPlans)
      .set({ status: "rejected", decidedAt: now, rejectionReason: reason, updatedAt: now })
      .where(eq(contentPlans.id, planId)),
  );
  change.emit(plan.conversationId, { type: "plan.updated", plan: planView(next, items) });
  await change.commit();
  return loadPlan(db, planId);
}

async function generatePlan(
  change: Change,
  planId: string,
  input: z.output<typeof PlanGenerate>,
): Promise<PlanGenerateResult> {
  const { db, now } = change;
  const { plan, items } = await requirePlanRows(db, planId);
  if (plan.status !== "accepted") {
    throw invalidTransition(`plan ${planId} is ${plan.status}; accept it before generating`);
  }
  const jobIds = items.map((i) => i.generationJobId).filter((id): id is string => id !== null);
  const currentJobs = jobIds.length
    ? await db.select().from(jobs).where(inArray(jobs.id, jobIds))
    : [];
  const jobsById = new Map(currentJobs.map((j) => [j.id, j]));
  const busy = (item: PlanItemRow) => {
    const job = item.generationJobId ? jobsById.get(item.generationJobId) : undefined;
    return job !== undefined && !isTerminalJobStatus(job.status);
  };

  let targets: PlanItemRow[];
  if (input.itemIds) {
    targets = input.itemIds.map((id) => {
      const item = items.find((i) => i.id === id);
      if (!item) throw notFound(`plan ${planId} item`, id);
      if (item.status !== "accepted") throw conflict(`item ${id} is ${item.status}, not accepted`);
      if (!item.contentId)
        throw conflict(`item ${id} has no content item any more (it was deleted)`);
      if (busy(item)) throw conflict(`item ${id} is already being generated`);
      return item;
    });
  } else {
    targets = items.filter((i) => i.status === "accepted" && i.contentId !== null && !busy(i));
  }

  const contentIds = targets.map((t) => t.contentId as string);
  const contentRows = contentIds.length
    ? await db
        .select({ row: contents, version: contentVersions.version })
        .from(contents)
        .leftJoin(contentVersions, eq(contents.currentVersionId, contentVersions.id))
        .where(inArray(contents.id, contentIds))
    : [];
  const profile = await db.query.brandProfiles.findFirst({
    where: and(eq(brandProfiles.brandId, plan.brandId), eq(brandProfiles.isCurrent, true)),
  });

  const created: JobRow[] = [];
  const nextItems = items.map((item) => {
    if (!targets.includes(item)) return item;
    const found = contentRows.find((c) => c.row.id === item.contentId);
    if (!found) throw conflict(`item ${item.id} has no content item any more (it was deleted)`);
    const content = found.row;
    const payload = ContentGeneratePayload.parse({
      brandId: plan.brandId,
      contentId: content.id,
      title: content.title,
      brief: content.brief,
      type: content.type,
      targetPlatforms: content.targetPlatforms,
      ...(found.version ? { baseVersion: found.version } : {}),
      imageSlot: item.imageSlot,
      imageBrief: item.imageBrief,
      planItem: { planId, itemId: item.id, date: item.date, pillar: item.pillar },
      ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
      ...(profile ? { brandProfileVersion: profile.version } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
    });
    const job: JobRow = {
      id: newId(),
      type: "content.generate",
      status: "queued",
      brandId: plan.brandId,
      contentId: content.id,
      payload,
      output: null,
      error: null,
      progress: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      finishedAt: null,
      priority: 0,
      attempts: 0,
      maxAttempts: DEFAULT_JOB_MAX_ATTEMPTS,
      workerId: null,
      leaseExpiresAt: null,
      dispatchedAt: null,
      ackedAt: null,
      cancelRequestedAt: null,
      progressMessage: null,
    };
    change.add(db.insert(jobs).values(job));
    change.add(
      db
        .update(planItems)
        .set({ generationJobId: job.id, generationStatus: "queued", updatedAt: now })
        .where(eq(planItems.id, item.id)),
    );
    change.jobCreated(job.id);
    created.push(job);
    jobsById.set(job.id, job);
    return { ...item, generationJobId: job.id, generationStatus: "queued", updatedAt: now };
  });

  if (created.length > 0) {
    change.emit(plan.conversationId, {
      type: "plan.updated",
      plan: planView(plan, nextItems, jobsById),
    });
    await change.commit();
  }
  return { plan: await loadPlan(db, planId), jobs: created.map((j): Job => toJob(j)) };
}

// --- job hooks (called by the Hub after every job change) ----------------------------------

/**
 * Keep runs and plan items in step with their jobs:
 * - chat.turn finished without the worker closing the run (crash, lost
 *   lease, cancel through /api/jobs) -> the run ends the same way;
 * - chat.turn requeued (worker lost it) -> the run goes back to queued;
 * - content.generate of a plan item changed status -> plan.updated.
 */
export async function onJobChanged(db: Db, job: JobRow, effects: ChatEffects): Promise<void> {
  const change = new Change(db, new Date(), effects);
  if (job.type === "chat.turn") {
    const run = await db.query.agentRuns.findFirst({ where: eq(agentRuns.jobId, job.id) });
    if (!run || !isActiveRunStatus(run.status)) return;
    if (isTerminalJobStatus(job.status)) {
      const outcome: RunOutcome =
        job.status === "succeeded"
          ? { status: "completed" }
          : job.status === "cancelled"
            ? { status: "cancelled" }
            : { status: "failed", error: job.error ?? "the agent run failed" };
      await finishRun(change, run, outcome);
      await change.commit();
    } else if (job.status === "queued" && run.status === "running") {
      const next: AgentRunRow = { ...run, status: "queued", updatedAt: change.now };
      change.add(
        db
          .update(agentRuns)
          .set({ status: "queued", updatedAt: change.now })
          .where(and(eq(agentRuns.id, run.id), eq(agentRuns.status, "running"))),
      );
      change.emit(run.conversationId, { type: "run.updated", run: toAgentRun(next) });
      await change.commit();
    }
    return;
  }
  if (job.type === "content.generate") {
    const item = await db.query.planItems.findFirst({
      where: eq(planItems.generationJobId, job.id),
    });
    if (!item || item.generationStatus === job.status) return;
    change.add(
      db.update(planItems).set({ generationStatus: job.status }).where(eq(planItems.id, item.id)),
    );
    const plan = await loadPlan(db, item.planId); // generation is read live from jobs
    change.emit(plan.conversationId, { type: "plan.updated", plan });
    await change.commit();
  }
}
