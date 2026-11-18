import {
  type AgentEffort,
  AgentModel,
  type AgentRun,
  type AttachmentPart,
  aliasBaseFor,
  autoAlias,
  briefWithHook,
  type ConsentDecisionCreate,
  type ConsentDecisionResult,
  type ConsentPart,
  ContentGeneratePayload,
  type Conversation,
  type ConversationAlias,
  type ConversationAliasUpdate,
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
  MAX_PLAN_ITEMS,
  MAX_TEXT_PART_BYTES,
  type Message,
  type MessagePart,
  type MessagePartInput,
  type Plan,
  type PlanAccept,
  type PlanGenerate,
  type PlanGenerateResult,
  type PlanGenerateSkip,
  type PlanItemCreate,
  type PlanItemInput,
  type PlanItemPatch,
  type PlanItemRemoveResult,
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
  resolveAliasMentions,
  type TurnContext,
  type TurnOps,
  type TurnWriteResult,
  type UserMessageCreate,
  type UserMessageResult,
  utf8Length,
} from "@studio/contract";
import { and, count, desc, eq, inArray, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { z } from "zod";
import type { Db } from "../db/client.ts";
import {
  type AgentRunRow,
  type AliasRecord,
  type AssetRow,
  type ConversationRow,
  type JobRow,
  type MessageRow,
  type PlanItemRow,
  type PlanRow,
  toAgentRun,
  toConversation,
  toConversationAlias,
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
  contentVersionDocuments,
  contentVersions,
  conversationAliases,
  conversationAliasNames,
  conversationEvents,
  conversations,
  jobs,
  messages,
  planItems,
} from "../db/schema.ts";
import { ApiProblem, badRequest, conflict, invalidTransition, notFound } from "../lib/errors.ts";
import { newId } from "../lib/ids.ts";
import { assertPlanTemplates } from "../lib/templates.ts";
import { marksChanged, similarityMarks, storedMarks } from "../lib/planning.ts";
import {
  activeRunOf,
  assistantMessageOf,
  loadAliases,
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
  | {
      kind: "decideConsent";
      conversationId: string;
      messageId: string;
      input: z.output<typeof ConsentDecisionCreate>;
    }
  | { kind: "cancelRun"; runId: string }
  | { kind: "updatePlan"; planId: string; input: z.output<typeof PlanUpdate> }
  | { kind: "acceptPlan"; planId: string; input: z.output<typeof PlanAccept> }
  | { kind: "rejectPlan"; planId: string; input: z.output<typeof PlanReject> }
  | { kind: "generatePlan"; planId: string; input: z.output<typeof PlanGenerate> }
  | { kind: "addPlanItem"; planId: string; input: z.output<typeof PlanItemCreate> }
  | {
      kind: "updatePlanItem";
      planId: string;
      itemId: string;
      input: z.output<typeof PlanItemPatch>;
    }
  | { kind: "removePlanItem"; planId: string; itemId: string }
  | { kind: "startRun"; runId: string; attempt: number }
  | { kind: "applyOps"; runId: string; input: z.output<typeof TurnOps> }
  | { kind: "putPlan"; runId: string; input: z.output<typeof PlanProposalPut> }
  | { kind: "completeRun"; runId: string; input: z.output<typeof RunComplete> }
  | { kind: "failRun"; runId: string; input: z.output<typeof RunFail> }
  | {
      kind: "renameAlias";
      conversationId: string;
      aliasId: string;
      input: z.output<typeof ConversationAliasUpdate>;
    };

export interface ChatResults {
  updateConversation: Conversation;
  sendUserMessage: UserMessageResult;
  answerQuestion: QuestionAnswerResult;
  decideConsent: ConsentDecisionResult;
  cancelRun: AgentRun;
  updatePlan: Plan;
  acceptPlan: Plan;
  rejectPlan: Plan;
  generatePlan: PlanGenerateResult;
  addPlanItem: Plan;
  updatePlanItem: Plan;
  removePlanItem: PlanItemRemoveResult;
  startRun: TurnContext;
  applyOps: TurnWriteResult;
  putPlan: PlanProposalResult;
  completeRun: AgentRun;
  failRun: AgentRun;
  renameAlias: ConversationAlias;
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

/** The assets of attachments, in order, after the existence and brand checks. */
async function attachmentAssets(
  db: Db,
  conv: ConversationRow,
  ids: readonly string[],
  pathOf: (index: number) => string,
): Promise<AssetRow[]> {
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
    return asset;
  });
}

function attachmentPart(asset: AssetRow, alias: AliasRecord): AttachmentPart {
  return {
    type: "attachment",
    assetId: asset.id,
    kind: asset.kind,
    mimeType: asset.mimeType,
    width: asset.width,
    height: asset.height,
    filename: asset.originalFilename,
    alias: alias.row.alias,
    aliasId: alias.row.id,
  };
}

// --- attachment aliases -----------------------------------------------------------------

/**
 * A conversation's aliases during one change. Allocation happens in memory
 * (inside the Hub's serial queue, so nothing else allocates meanwhile);
 * `flush` adds the inserts/updates to the change after the message rows they
 * reference. A name is taken when any alias has ever had it, so names are
 * never reused; auto names take the lowest free `base`, `base-1`, ... which
 * only ever grows because names are never released.
 */
class AliasBook {
  private readonly stmts: BatchItem<"sqlite">[] = [];
  private readonly touched = new Map<string, AliasRecord>();
  /** name -> alias id, every name ever used in the conversation. */
  private readonly owners = new Map<string, string>();

  private constructor(
    private readonly conversationId: string,
    private readonly records: AliasRecord[],
  ) {
    for (const r of records) for (const n of r.names) this.owners.set(n, r.row.id);
  }

  static async load(db: Db, conversationId: string): Promise<AliasBook> {
    return new AliasBook(conversationId, await loadAliases(db, conversationId));
  }

  byId(id: string): AliasRecord | undefined {
    return this.records.find((r) => r.row.id === id);
  }

  /** For mention resolution: current and previous names of every alias. */
  targets() {
    return this.records.map((r) => ({
      id: r.row.id,
      alias: r.row.alias,
      previousAliases: r.names.filter((n) => n !== r.row.alias),
      assetId: r.asset.id,
    }));
  }

  /**
   * The asset's alias, created when it has none. `requested` must be free (or
   * one of the asset's own names when it already has an alias).
   */
  ensure(
    change: Change,
    asset: AssetRow,
    messageId: string,
    requested: string | undefined,
    path: string,
  ): AliasRecord {
    const existing = this.records.find((r) => r.asset.id === asset.id);
    if (existing) {
      if (requested !== undefined && !existing.names.includes(requested)) {
        throw conflict(
          `${path}: asset ${asset.id} already has the alias @${existing.row.alias} in this conversation; rename it instead`,
        );
      }
      return existing;
    }
    let name: string;
    if (requested !== undefined) {
      if (this.owners.has(requested)) {
        throw conflict(`${path}: the alias @${requested} is already used in this conversation`);
      }
      name = requested;
    } else {
      const base = aliasBaseFor(asset.mimeType);
      let n = 0;
      while (this.owners.has(autoAlias(base, n))) n++;
      name = autoAlias(base, n);
    }
    const record: AliasRecord = {
      row: {
        id: newId(),
        conversationId: this.conversationId,
        assetId: asset.id,
        alias: name,
        messageId,
        createdAt: change.now,
        updatedAt: change.now,
      },
      asset,
      names: [name],
    };
    this.records.push(record);
    this.owners.set(name, record.row.id);
    this.touched.set(record.row.id, record);
    this.stmts.push(change.db.insert(conversationAliases).values(record.row));
    this.stmts.push(
      change.db.insert(conversationAliasNames).values({
        conversationId: this.conversationId,
        name,
        aliasId: record.row.id,
        createdAt: change.now,
      }),
    );
    return record;
  }

  /** Rename; false when the name is already the current one. */
  rename(change: Change, record: AliasRecord, name: string): boolean {
    if (record.row.alias === name) return false;
    const owner = this.owners.get(name);
    if (owner !== undefined && owner !== record.row.id) {
      throw conflict(`the alias @${name} is already used in this conversation`);
    }
    if (owner === undefined) {
      this.owners.set(name, record.row.id);
      record.names.push(name);
      this.stmts.push(
        change.db.insert(conversationAliasNames).values({
          conversationId: this.conversationId,
          name,
          aliasId: record.row.id,
          createdAt: change.now,
        }),
      );
    }
    record.row = { ...record.row, alias: name, updatedAt: change.now };
    this.touched.set(record.row.id, record);
    this.stmts.push(
      change.db
        .update(conversationAliases)
        .set({ alias: name, updatedAt: change.now })
        .where(eq(conversationAliases.id, record.row.id)),
    );
    return true;
  }

  /** Aliases added or renamed in this change (for `conversation.updated.aliases`). */
  changed(): ConversationAlias[] {
    return [...this.touched.values()].map(toConversationAlias);
  }

  /** Add the pending writes to the change (after the rows they reference). */
  flush(change: Change): void {
    for (const stmt of this.stmts.splice(0)) change.add(stmt);
  }
}

/** Turn a validated part input into the stored part (lookups and brand checks included). */
async function buildPart(
  change: Change,
  conv: ConversationRow,
  input: z.output<typeof MessagePartInput>,
  path: string,
  aliases: { book: () => Promise<AliasBook>; messageId: string },
): Promise<MessagePart> {
  const { db } = change;
  switch (input.type) {
    case "text":
    case "progress":
    case "error":
    case "tool_step":
      return input;
    case "consent":
      return { ...input, decidedAt: input.state === "expired" ? iso(change.now) : null };
    case "attachment": {
      const [asset] = await attachmentAssets(db, conv, [input.assetId], () => `${path}.assetId`);
      if (!asset) throw new Error("attachment lookup returned nothing");
      const alias = (await aliases.book()).ensure(
        change,
        asset,
        aliases.messageId,
        input.alias,
        `${path}.alias`,
      );
      return attachmentPart(asset, alias);
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

type TurnChoice = { model?: AgentModel | undefined; effort?: AgentEffort | undefined };

/** Insert a queued agent run and its chat.turn job; returns the run row (not yet written). */
function startTurn(
  change: Change,
  conv: ConversationRow,
  triggerMessageId: string,
  choice: TurnChoice = {},
): AgentRunRow {
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
    model: choice.model ?? null,
    effort: choice.effort ?? null,
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
  | {
      status: "completed";
      model?: string | undefined;
      usage?: RunUsage | undefined;
      /** Claude Code session of the run (stored on the conversation with the message count). */
      session?: { id: string } | undefined;
    }
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
    // Nobody can answer a consent card once its run is over.
    const parts = (msg.parts as MessagePart[]).map(
      (p): MessagePart =>
        p.type === "consent" && p.state === "pending"
          ? { ...p, state: "expired", decidedAt: iso(now) }
          : p,
    );
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
      mentions: null,
      clientMessageId: null,
      createdAt: now,
      updatedAt: now,
    };
    change.add(db.insert(messages).values(created));
    change.emit(conv.id, { type: "message.created", message: messageRowView(created) });
  }
  let convAfter = conv;
  if (outcome.status === "completed" && outcome.session) {
    // The count includes the run's own assistant message (written before complete).
    const [row] = await db
      .select({ n: count() })
      .from(messages)
      .where(eq(messages.conversationId, conv.id));
    const session = {
      agentSessionId: outcome.session.id,
      agentSessionMessages: row?.n ?? 0,
      agentSessionRunId: run.id,
      agentSessionAt: now,
    };
    change.add(db.update(conversations).set(session).where(eq(conversations.id, conv.id)));
    convAfter = { ...conv, ...session };
  }
  change.emit(conv.id, { type: "run.updated", run: toAgentRun(next) });
  change.emit(conv.id, { type: "conversation.updated", conversation: convView(convAfter, null) });
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
    mentions: null,
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
    hook: input.hook,
    imageSlot: input.imageSlot,
    imageBrief: input.imageBrief,
    templateId: input.templateId ?? null,
    status: "planned",
    contentId: null,
    generationJobId: null,
    generationStatus: null,
    similar: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Comparable shape of an item's editable fields. */
function itemFields(
  i: Pick<
    PlanItemRow,
    | "date"
    | "platforms"
    | "contentType"
    | "title"
    | "brief"
    | "pillar"
    | "hook"
    | "imageSlot"
    | "imageBrief"
  > & { templateId?: string | null | undefined },
) {
  return {
    date: i.date,
    platforms: i.platforms,
    contentType: i.contentType,
    title: i.title,
    brief: i.brief,
    pillar: i.pillar,
    hook: i.hook,
    imageSlot: i.imageSlot,
    imageBrief: i.imageBrief,
    templateId: i.templateId ?? null,
  };
}

/**
 * The rows with their near-duplicate marks (N6): compared with the brand's posts, plans and
 * rejections of the last months and with each other. Marks are advice; when they cannot be
 * computed the rows keep the marks they had.
 */
async function withMarks(
  db: Db,
  plan: Pick<PlanRow, "id" | "brandId" | "conversationId" | "periodStart" | "periodEnd">,
  rows: PlanItemRow[],
): Promise<PlanItemRow[]> {
  try {
    const marks = await similarityMarks(db, plan, rows);
    return rows.map((row, i) => ({ ...row, similar: storedMarks(marks[i] ?? []) }));
  } catch (error) {
    console.warn(`plan ${plan.id}: similarity marks failed`, error);
    return rows;
  }
}

/** Saves marks that changed on rows an edit did not rewrite anyway. */
function saveChangedMarks(
  change: Change,
  before: readonly PlanItemRow[],
  after: readonly PlanItemRow[],
): void {
  for (const row of after) {
    const old = before.find((b) => b.id === row.id);
    if (!old || !marksChanged(old.similar, row.similar)) continue;
    change.add(
      change.db.update(planItems).set({ similar: row.similar }).where(eq(planItems.id, row.id)),
    );
  }
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
    case "decideConsent":
      return decideConsent(change, command.conversationId, command.messageId, command.input);
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
    case "addPlanItem":
      return addPlanItem(change, command.planId, command.input);
    case "updatePlanItem":
      return updatePlanItem(change, command.planId, command.itemId, command.input);
    case "removePlanItem":
      return removePlanItem(change, command.planId, command.itemId);
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
    case "renameAlias":
      return renameAlias(change, command.conversationId, command.aliasId, command.input);
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
    // A conversation without messages may still move (a first send that failed before the
    // brand was changed); once something was said, the brand stays.
    if (conv.brandId) {
      const [row] = await db
        .select({ n: count() })
        .from(messages)
        .where(eq(messages.conversationId, id));
      if ((row?.n ?? 0) > 0) {
        throw conflict(`conversation ${id} already belongs to brand ${conv.brandId}`);
      }
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

  const attachments =
    input.attachments ?? input.attachmentAssetIds.map((assetId) => ({ assetId, alias: undefined }));
  const field = input.attachments ? "attachments" : "attachmentAssetIds";
  const assetRows = await attachmentAssets(
    db,
    conv,
    attachments.map((a) => a.assetId),
    (i) => (input.attachments ? `attachments.${i}.assetId` : `attachmentAssetIds.${i}`),
  );
  const messageId = newId();
  const book = await AliasBook.load(db, conversationId);
  // Requested names first, so an auto name never takes a name asked for in the same message.
  const records: AliasRecord[] = new Array(attachments.length);
  for (const pass of ["requested", "auto"] as const) {
    for (const [i, a] of attachments.entries()) {
      const asset = assetRows[i];
      if (!asset || (a.alias !== undefined) !== (pass === "requested")) continue;
      records[i] = book.ensure(change, asset, messageId, a.alias, `${field}.${i}.alias`);
    }
  }

  const parts: MessagePart[] = [];
  if (input.text) parts.push({ type: "text", text: input.text });
  for (const [i, asset] of assetRows.entries()) {
    const alias = records[i];
    if (!alias) throw new Error("alias allocation skipped an attachment");
    parts.push(attachmentPart(asset, alias));
  }
  const mentions = input.text ? resolveAliasMentions(input.text, book.targets()) : [];

  const message: MessageRow = {
    id: messageId,
    conversationId,
    role: "user",
    status: "complete",
    runId: null,
    parts,
    deltaSeqs: parts.map(() => 0),
    mentions: mentions.length > 0 ? mentions : null,
    clientMessageId: input.clientMessageId ?? null,
    createdAt: now,
    updatedAt: now,
  };
  change.add(db.insert(messages).values(message));
  book.flush(change);
  change.emit(conversationId, { type: "message.created", message: messageRowView(message) });
  const run = startTurn(change, conv, message.id, { model: input.model, effort: input.effort });

  const title = conv.title === "" && input.text ? deriveTitle(input.text) : conv.title;
  if (title !== conv.title) {
    change.add(
      db.update(conversations).set({ title, updatedAt: now }).where(eq(conversations.id, conv.id)),
    );
  }
  const newAliases = book.changed();
  change.emit(conversationId, {
    type: "conversation.updated",
    conversation: convView(
      { ...conv, title, updatedAt: title !== conv.title ? now : conv.updatedAt },
      run.id,
    ),
    ...(newAliases.length > 0 ? { aliases: newAliases } : {}),
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
    // Keep the asking run's model / effort choice for the turn the answer starts.
    const asking = msg.runId
      ? await db.query.agentRuns.findFirst({ where: eq(agentRuns.id, msg.runId) })
      : undefined;
    const model = AgentModel.safeParse(asking?.model);
    run = startTurn(change, conv, msg.id, {
      model: model.success ? model.data : undefined,
      effort: asking?.effort ?? undefined,
    });
    change.emit(conversationId, {
      type: "conversation.updated",
      conversation: convView(conv, run.id),
    });
  }
  await change.commit();
  return { message: messageRowView(updated), run: run ? toAgentRun(run) : null };
}

/** The owner allows or denies a pending consent card; the asking run reads it (no new run). */
async function decideConsent(
  change: Change,
  conversationId: string,
  messageId: string,
  input: z.output<typeof ConsentDecisionCreate>,
): Promise<ConsentDecisionResult> {
  const { db, now } = change;
  await requireConversation(db, conversationId);
  const msg = await db.query.messages.findFirst({
    where: and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)),
  });
  if (!msg) throw notFound("message", messageId);
  const parts = [...(msg.parts as MessagePart[])];
  const index = parts.findIndex((p) => p.type === "consent" && p.consentId === input.consentId);
  const card = parts[index] as ConsentPart | undefined;
  if (!card) throw notFound(`message ${messageId} consent`, input.consentId);
  const state = input.allow ? "allowed" : "denied";
  if (card.state === state) return { message: toMessage(msg) };
  if (card.state === "expired") {
    throw conflict(`consent ${input.consentId} expired; ask the agent again`);
  }
  if (card.state !== "pending") throw conflict(`consent ${input.consentId} was already answered`);
  const run = msg.runId ? await requireRun(db, msg.runId) : undefined;
  if (!run || !isActiveRunStatus(run.status)) {
    throw conflict(`the run that asked for consent ${input.consentId} is over`);
  }
  const decided: ConsentPart = { ...card, state, decidedAt: iso(now) };
  parts[index] = decided;
  const updated: MessageRow = { ...msg, parts, updatedAt: now };
  change.add(db.update(messages).set({ parts, updatedAt: now }).where(eq(messages.id, msg.id)));
  change.emit(conversationId, { type: "part.updated", messageId, index, part: decided });
  await change.commit();
  return { message: messageRowView(updated) };
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
  // Loaded only when the batch attaches something (most batches are text deltas).
  let book: AliasBook | undefined;
  const loadBook = async () => {
    book ??= await AliasBook.load(db, conv.id);
    return book;
  };

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

    const part = await buildPart(change, conv, op.part, `${at}.part`, {
      book: loadBook,
      messageId: row.id,
    });
    if (part.type === "question") {
      const clash = parts.some(
        (p, i) => i !== op.index && p.type === "question" && p.questionId === part.questionId,
      );
      if (clash)
        throw conflict(`${at}: question id ${part.questionId} is already used in this message`);
    }
    if (part.type === "consent") {
      const clash = parts.some(
        (p, i) => i !== op.index && p.type === "consent" && p.consentId === part.consentId,
      );
      if (clash)
        throw conflict(`${at}: consent id ${part.consentId} is already used in this message`);
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
    if (current.type === "consent" && part.type === "consent") {
      if (current.state !== "pending") {
        // Decided or expired: final. A retry of the same card (or a late expiry) is a no-op.
        if (current.consentId === part.consentId) continue;
        throw conflict(`${at}: consent ${current.consentId} is already ${current.state}`);
      }
      if (
        part.state === "pending" &&
        stableJson({ ...current, decidedAt: null }) === stableJson(part)
      ) {
        continue;
      }
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
    book?.flush(change);
    const newAliases = book?.changed() ?? [];
    if (newAliases.length > 0) {
      change.emit(conv.id, {
        type: "conversation.updated",
        conversation: convView(conv, run.id),
        aliases: newAliases,
      });
    }
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
  await assertPlanTemplates(db, brandId, input.items);
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
      itemRows = await withMarks(
        db,
        planRow,
        input.items.map((item, i) => newItemRow(own.id, i, item, now)),
      );
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
    itemRows = await withMarks(
      db,
      planRow,
      input.items.map((item, i) => newItemRow(planRow.id, i, item, now)),
    );
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
  await finishRun(change, run, {
    status: "completed",
    model: input.model,
    usage: input.usage,
    session: input.session,
  });
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
    await assertPlanTemplates(db, plan.brandId, input.items);
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
  if (input.items) nextItems = await withMarks(db, next, nextItems);

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

/** Live state of an accepted item's post, for deciding what (re)generation may do. */
interface ItemPost {
  row: typeof contents.$inferSelect;
  /** Current version: its number, origin and whether it was saved from the canvas. */
  current: { version: number; origin: string; canvas: boolean } | null;
}

async function itemPosts(db: Db, contentIds: string[]): Promise<Map<string, ItemPost>> {
  const out = new Map<string, ItemPost>();
  if (contentIds.length === 0) return out;
  const rows = await db
    .select({
      row: contents,
      versionId: contentVersions.id,
      version: contentVersions.version,
      origin: contentVersions.origin,
    })
    .from(contents)
    .leftJoin(contentVersions, eq(contents.currentVersionId, contentVersions.id))
    .where(inArray(contents.id, contentIds));
  const versionIds = rows.flatMap((r) => (r.versionId ? [r.versionId] : []));
  const canvas = new Set(
    versionIds.length
      ? (
          await db
            .select({ versionId: contentVersionDocuments.versionId })
            .from(contentVersionDocuments)
            .where(inArray(contentVersionDocuments.versionId, versionIds))
        ).map((d) => d.versionId)
      : [],
  );
  for (const r of rows) {
    out.set(r.row.id, {
      row: r.row,
      current:
        r.versionId && r.version !== null && r.origin !== null
          ? { version: r.version, origin: r.origin, canvas: canvas.has(r.versionId) }
          : null,
    });
  }
  return out;
}

/** The plan items' latest generation jobs, by id. */
async function generationJobs(db: Db, items: PlanItemRow[]): Promise<Map<string, JobRow>> {
  const ids = items.map((i) => i.generationJobId).filter((id): id is string => id !== null);
  const rows = ids.length ? await db.select().from(jobs).where(inArray(jobs.id, ids)) : [];
  return new Map(rows.map((j) => [j.id, j]));
}

/**
 * What a generation of `item` would meet (U2): why it must not run by default, and what an
 * explicit request needs (`force`: the post already has a design; `overwrite`: hand / AI edits
 * or an approval would be replaced).
 */
function itemVerdict(
  item: PlanItemRow,
  post: ItemPost | undefined,
  job: JobRow | undefined,
): {
  blocked: "no_content" | "generating" | "published" | null;
  generated: boolean;
  approved: boolean;
  edited: boolean;
} {
  const none = { generated: false, approved: false, edited: false };
  if (item.status !== "accepted" || !item.contentId || !post || post.row.deletedAt) {
    return { blocked: "no_content", ...none };
  }
  if (job && !isTerminalJobStatus(job.status)) return { blocked: "generating", ...none };
  const status = post.row.status;
  if (status === "publishing" || status === "published") return { blocked: "published", ...none };
  const lastFailed = job?.status === "failed" || job?.status === "cancelled";
  return {
    blocked: null,
    generated: post.current !== null && !lastFailed,
    approved: status === "approved" || status === "scheduled",
    edited: post.current !== null && post.current.origin !== "generated",
  };
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
  if (input.force && !input.itemIds) {
    throw badRequest("force needs itemIds", [
      { path: "force", message: "name the items to regenerate in itemIds" },
    ]);
  }
  const jobsById = await generationJobs(db, items);
  const posts = await itemPosts(
    db,
    items.flatMap((i) => (i.status === "accepted" && i.contentId ? [i.contentId] : [])),
  );
  const verdictOf = (item: PlanItemRow) =>
    itemVerdict(
      item,
      item.contentId ? posts.get(item.contentId) : undefined,
      item.generationJobId ? jobsById.get(item.generationJobId) : undefined,
    );

  let targets: PlanItemRow[];
  const skipped: PlanGenerateSkip[] = [];
  if (input.itemIds) {
    const issues: { path: string; message: string }[] = [];
    targets = input.itemIds.map((id, index) => {
      const item = items.find((i) => i.id === id);
      if (!item) throw notFound(`plan ${planId} item`, id);
      const path = `itemIds.${index}`;
      // Turkish: the plan page shows these to the user.
      const name = `“${item.title}”`;
      if (item.status !== "accepted") {
        issues.push({ path, message: `${name} kabul edilmiş bir plan kalemi değil.` });
        return item;
      }
      const v = verdictOf(item);
      if (v.blocked === "no_content") {
        issues.push({ path, message: `${name} kaleminin postu silinmiş.` });
      } else if (v.blocked === "generating") {
        issues.push({ path, message: `${name} zaten üretiliyor.` });
      } else if (v.blocked === "published") {
        issues.push({ path, message: `${name} yayında ya da yayınlanıyor; yeniden üretilmez.` });
      } else if (v.generated && !input.force) {
        issues.push({
          path,
          message: `${name} zaten üretilmiş; yeniden üretmek için onay gerekiyor (force).`,
        });
      } else if ((v.edited || v.approved) && !input.overwriteEdits) {
        issues.push({
          path,
          message: v.approved
            ? `${name} onaylı ya da zamanlanmış: yeniden üretmek onayı kaldırır (overwriteEdits).`
            : `${name} elle ya da yapay zekâyla düzenlenmiş: yeniden üretmek bu düzenlemelerin yerine geçer (overwriteEdits).`,
        });
      }
      return item;
    });
    const first = issues[0];
    if (first) throw new ApiProblem("conflict", first.message, issues);
  } else {
    targets = [];
    for (const item of items) {
      if (item.status !== "accepted") continue;
      const v = verdictOf(item);
      const reason: PlanGenerateSkip["reason"] | null =
        v.blocked ??
        (v.approved ? "approved" : v.edited ? "edited" : v.generated ? "generated" : null);
      if (reason) skipped.push({ itemId: item.id, reason });
      else targets.push(item);
    }
  }

  const profile = await db.query.brandProfiles.findFirst({
    where: and(eq(brandProfiles.brandId, plan.brandId), eq(brandProfiles.isCurrent, true)),
  });

  const created: JobRow[] = [];
  const nextItems = items.map((item) => {
    if (!targets.includes(item)) return item;
    const post = item.contentId ? posts.get(item.contentId) : undefined;
    if (!post) throw conflict(`item ${item.id} has no content item any more (it was deleted)`);
    const content = post.row;
    // A canvas version's slide HTML only shows its render: a regeneration starts afresh.
    const baseVersion = post.current && !post.current.canvas ? post.current.version : undefined;
    const payload = ContentGeneratePayload.parse({
      brandId: plan.brandId,
      contentId: content.id,
      title: content.title,
      // The planned opening line (N6) travels with the brief, not into the post's own brief.
      brief: briefWithHook(content.brief, item.hook).slice(0, 20_000),
      type: content.type,
      targetPlatforms: content.targetPlatforms,
      ...(baseVersion ? { baseVersion } : {}),
      imageSlot: item.imageSlot,
      imageBrief: item.imageBrief,
      // A template keeps its layout; the AI fills its fields from the item's brief (N9).
      ...(item.templateId
        ? { template: { templateId: item.templateId, fill: "ai", values: {}, images: {} } }
        : {}),
      planItem: { planId, itemId: item.id, date: item.date, pillar: item.pillar },
      ...(plan.conversationId ? { conversationId: plan.conversationId } : {}),
      ...(profile ? { brandProfileVersion: profile.version } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
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
  return {
    plan: await loadPlan(db, planId),
    jobs: created.map((j): Job => toJob(j)),
    skipped,
  };
}

// --- plan item edits (N2) -------------------------------------------------------------------

const ITEM_EDITABLE_PLAN_STATUSES = ["draft", "proposed", "accepted"] as const;

function assertItemsEditable(plan: PlanRow): void {
  if (!(ITEM_EDITABLE_PLAN_STATUSES as readonly string[]).includes(plan.status)) {
    throw invalidTransition(`plan ${plan.id} is ${plan.status}; its items cannot change`);
  }
}

function assertItemDate(plan: PlanRow, date: string | null): void {
  const problem = checkPlanPeriod(plan.periodStart, plan.periodEnd, [date]);
  if (problem) throw badRequest(problem, [{ path: "date", message: problem }]);
}

/**
 * The plan row after an item edit: an open plan's revision goes up (accepting needs the revision
 * the user saw), an accepted plan only changes its `updatedAt`.
 */
function touchPlan(change: Change, plan: PlanRow): PlanRow {
  const { db, now } = change;
  const open = isPlanEditable(plan.status);
  const next: PlanRow = {
    ...plan,
    revision: open ? plan.revision + 1 : plan.revision,
    updatedAt: now,
  };
  change.add(
    db
      .update(contentPlans)
      .set({ revision: next.revision, updatedAt: now })
      .where(and(eq(contentPlans.id, plan.id), eq(contentPlans.revision, plan.revision))),
  );
  return next;
}

/** A new draft post for an accepted item (what accepting the plan makes). */
function draftPostFor(
  change: Change,
  plan: PlanRow,
  item: Pick<PlanItemRow, "contentType" | "title" | "brief" | "platforms">,
): string {
  const { db, now } = change;
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
  return contentId;
}

async function addPlanItem(
  change: Change,
  planId: string,
  input: z.output<typeof PlanItemCreate>,
): Promise<Plan> {
  const { db, now } = change;
  const { plan, items } = await requirePlanRows(db, planId);
  assertItemsEditable(plan);
  if (items.length >= MAX_PLAN_ITEMS) {
    throw badRequest(`a plan has at most ${MAX_PLAN_ITEMS} items`, [
      { path: "items", message: "too many items" },
    ]);
  }
  assertItemDate(plan, input.date);
  await assertPlanTemplates(db, plan.brandId, [input]);
  const position = items.reduce((max, i) => Math.max(max, i.position + 1), 0);
  let row = newItemRow(planId, position, input, now);
  if (plan.status === "accepted") {
    await requireActiveBrand(db, plan.brandId);
    row = { ...row, status: "accepted", contentId: draftPostFor(change, plan, row) };
  }
  const nextItems = await withMarks(db, plan, [...items, row]);
  row = nextItems[nextItems.length - 1] ?? row;
  change.add(db.insert(planItems).values(row));
  saveChangedMarks(change, items, nextItems.slice(0, -1));
  const next = touchPlan(change, plan);
  change.emit(plan.conversationId, {
    type: "plan.updated",
    plan: planView(next, nextItems, await generationJobs(db, nextItems)),
  });
  await change.commit();
  return loadPlan(db, planId);
}

async function updatePlanItem(
  change: Change,
  planId: string,
  itemId: string,
  input: z.output<typeof PlanItemPatch>,
): Promise<Plan> {
  const { db, now } = change;
  const { plan, items } = await requirePlanRows(db, planId);
  assertItemsEditable(plan);
  const item = items.find((i) => i.id === itemId);
  if (!item) throw notFound(`plan ${planId} item`, itemId);
  if (item.status === "skipped") {
    throw conflict(`item ${itemId} was left out when the plan was accepted`);
  }
  const fields = {
    ...(input.date !== undefined ? { date: input.date } : {}),
    ...(input.platforms !== undefined ? { platforms: input.platforms } : {}),
    ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
    ...(input.pillar !== undefined ? { pillar: input.pillar } : {}),
    ...(input.hook !== undefined ? { hook: input.hook } : {}),
    ...(input.imageSlot !== undefined ? { imageSlot: input.imageSlot } : {}),
    ...(input.imageBrief !== undefined ? { imageBrief: input.imageBrief } : {}),
    ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
  };
  const nextItem: PlanItemRow = { ...item, ...fields, updatedAt: now };
  if (fields.templateId !== undefined || fields.contentType !== undefined)
    await assertPlanTemplates(db, plan.brandId, [nextItem]);
  if (fields.date !== undefined) assertItemDate(plan, nextItem.date);

  if (item.status === "accepted" && item.contentId) {
    const post = (await itemPosts(db, [item.contentId])).get(item.contentId);
    if (post && !post.row.deletedAt) {
      const set: Partial<typeof contents.$inferInsert> = {};
      if (fields.title !== undefined && fields.title !== post.row.title) set.title = fields.title;
      if (fields.brief !== undefined && fields.brief !== post.row.brief) set.brief = fields.brief;
      const samePlatforms =
        fields.platforms === undefined ||
        (fields.platforms.length === post.row.targetPlatforms.length &&
          fields.platforms.every((p) => post.row.targetPlatforms.includes(p)));
      if (!samePlatforms && fields.platforms) {
        if (post.row.status !== "draft" && post.row.status !== "in_review") {
          throw conflict(
            "Onaylı ya da zamanlanmış postun platformları plandan değiştirilemez; postu açıp düzenle.",
          );
        }
        set.targetPlatforms = fields.platforms;
      }
      if (fields.contentType !== undefined && fields.contentType !== post.row.type) {
        if (post.current) {
          throw conflict(
            "Postun tasarımı var; türünü değiştirmek için yeni bir post ya da yeniden üretim gerekir.",
          );
        }
        set.type = fields.contentType;
      }
      if (Object.keys(set).length > 0) {
        change.add(
          db
            .update(contents)
            .set({ ...set, updatedAt: now })
            .where(eq(contents.id, item.contentId)),
        );
      }
    }
  }

  // A new topic, opening line or day can make (or clear) near-duplicates, of this item and of
  // the items after it.
  const textChanged =
    fields.title !== undefined ||
    fields.brief !== undefined ||
    fields.hook !== undefined ||
    fields.date !== undefined;
  const edited = items.map((i) => (i.id === itemId ? nextItem : i));
  const nextItems = textChanged ? await withMarks(db, plan, edited) : edited;
  const marked = nextItems.find((i) => i.id === itemId) ?? nextItem;
  change.add(
    db
      .update(planItems)
      .set({ ...fields, similar: marked.similar, updatedAt: now })
      .where(eq(planItems.id, itemId)),
  );
  saveChangedMarks(
    change,
    items.filter((i) => i.id !== itemId),
    nextItems.filter((i) => i.id !== itemId),
  );
  const next = touchPlan(change, plan);
  change.emit(plan.conversationId, {
    type: "plan.updated",
    plan: planView(next, nextItems, await generationJobs(db, nextItems)),
  });
  await change.commit();
  return loadPlan(db, planId);
}

async function removePlanItem(
  change: Change,
  planId: string,
  itemId: string,
): Promise<PlanItemRemoveResult> {
  const { db, now } = change;
  const { plan, items } = await requirePlanRows(db, planId);
  assertItemsEditable(plan);
  const item = items.find((i) => i.id === itemId);
  if (!item) throw notFound(`plan ${planId} item`, itemId);
  if (isPlanEditable(plan.status) && items.length <= 1) {
    throw badRequest("a plan needs at least one item; reject the plan instead", [
      { path: "itemId", message: "last item" },
    ]);
  }
  let trashedContentId: string | null = null;
  if (item.contentId) {
    const post = (await itemPosts(db, [item.contentId])).get(item.contentId);
    const jobsById = await generationJobs(db, [item]);
    const job = item.generationJobId ? jobsById.get(item.generationJobId) : undefined;
    const [active] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.contentId, item.contentId), inArray(jobs.status, ["queued", "running"])))
      .limit(1);
    const busy = (job && !isTerminalJobStatus(job.status)) || active !== undefined;
    // An empty draft would only clutter the board: it goes to the trash (restorable). A post
    // with a design stays; only the plan forgets it.
    if (post && !post.row.deletedAt && !post.current && !busy) {
      change.add(
        db
          .update(contents)
          .set({ deletedAt: now, updatedAt: now })
          .where(and(eq(contents.id, item.contentId), isNull(contents.deletedAt))),
      );
      trashedContentId = item.contentId;
    }
  }
  change.add(db.delete(planItems).where(eq(planItems.id, itemId)));
  // Keep positions 0..n-1; marks pointing at the removed item go with it.
  const rest = items
    .filter((i) => i.id !== itemId)
    .map((i, position) => {
      const similar = (i.similar ?? []).filter((s) => s.planItemId !== itemId);
      return { ...i, position, similar: similar.length > 0 ? similar : null };
    });
  for (const i of rest) {
    const before = items.find((x) => x.id === i.id);
    if (before && before.position !== i.position) {
      change.add(db.update(planItems).set({ position: i.position }).where(eq(planItems.id, i.id)));
    }
  }
  saveChangedMarks(change, items, rest);
  const next = touchPlan(change, plan);
  change.emit(plan.conversationId, {
    type: "plan.updated",
    plan: planView(next, rest, await generationJobs(db, rest)),
  });
  await change.commit();
  return { plan: await loadPlan(db, planId), trashedContentId };
}

async function renameAlias(
  change: Change,
  conversationId: string,
  aliasId: string,
  input: z.output<typeof ConversationAliasUpdate>,
): Promise<ConversationAlias> {
  const { db } = change;
  const conv = await requireConversation(db, conversationId);
  const book = await AliasBook.load(db, conversationId);
  const record = book.byId(aliasId);
  if (!record) throw notFound(`conversation ${conversationId} alias`, aliasId);
  if (book.rename(change, record, input.alias)) {
    book.flush(change);
    const active = await activeRunOf(db, conversationId);
    change.emit(conversationId, {
      type: "conversation.updated",
      conversation: convView(conv, active?.id ?? null),
      aliases: book.changed(),
    });
    await change.commit();
  }
  return toConversationAlias(record);
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
