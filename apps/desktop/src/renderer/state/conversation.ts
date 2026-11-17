// One open conversation (port of StudioMac/Chat/ConversationModel.swift): live state from the
// conversation stream (contract reducer), the queue of messages written while a reply runs
// (Claude Code's queue: sent one by one when the run ends, "Şimdi gönder" first), and the
// actions on cards (consent, questions, plans). Framework-free; React reads it through
// `useConversation` (useSyncExternalStore).
import {
  type AgentRun,
  type ApiClient,
  applyConversationStreamMessage,
  type ConsentPart,
  type Conversation,
  type ConversationState,
  type ConversationStreamMessage,
  type ConversationWatch,
  checkQuestionAnswer,
  isActiveRunStatus,
  type JobWatchStatus,
  type Message,
  type Plan,
  type QuestionPart,
} from "@studio/contract";
import { describeError } from "../lib/api.ts";
import type { AgentChoice } from "../lib/models.ts";
import { type OutgoingMessage, type QueuedMessage, runningStepKeys } from "../lib/transcript.ts";

export interface ConversationSnapshot {
  state: ConversationState | null;
  live: JobWatchStatus;
  queue: QueuedMessage[];
  busyPlans: ReadonlySet<string>;
  busyQuestions: ReadonlySet<string>;
  busyConsents: ReadonlySet<string>;
  expandedSteps: ReadonlySet<string>;
  stepStarts: Readonly<Record<string, number>>;
  isSending: boolean;
  error: string | null;
  /** A reply runs, or a send just started one the stream has not shown yet. */
  isReplyActive: boolean;
}

export interface ConversationDeps {
  choice(): AgentChoice;
  saveChoice(choice: AgentChoice): void;
  onConversation?(conversation: Conversation): void;
  now?(): number;
  newId?(): string;
}

type Listener = () => void;

export function newClientMessageId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ?? `m-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

export class ConversationController {
  private stateValue: ConversationState | null = null;
  private live: JobWatchStatus = "connecting";
  private queue: QueuedMessage[] = [];
  private busyPlans = new Set<string>();
  private busyQuestions = new Set<string>();
  private busyConsents = new Set<string>();
  private expandedSteps = new Set<string>();
  private stepStarts: Record<string, number> = {};
  private isSending = false;
  private isFlushing = false;
  private error: string | null = null;
  /** The run a send just started, until the stream shows it (busy until then: no 409). */
  private awaitingRunId: string | null = null;
  private watch: ConversationWatch | undefined;
  private listeners = new Set<Listener>();
  private snapshotValue: ConversationSnapshot;

  constructor(
    readonly id: string,
    private readonly client: ApiClient,
    private readonly deps: ConversationDeps,
  ) {
    this.snapshotValue = this.makeSnapshot();
  }

  // --- subscription --------------------------------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ConversationSnapshot => this.snapshotValue;

  private makeSnapshot(): ConversationSnapshot {
    return {
      state: this.stateValue,
      live: this.live,
      queue: this.queue,
      busyPlans: new Set(this.busyPlans),
      busyQuestions: new Set(this.busyQuestions),
      busyConsents: new Set(this.busyConsents),
      expandedSteps: new Set(this.expandedSteps),
      stepStarts: { ...this.stepStarts },
      isSending: this.isSending,
      error: this.error,
      isReplyActive: this.isReplyActive,
    };
  }

  private emit(): void {
    this.snapshotValue = this.makeSnapshot();
    for (const listener of this.listeners) listener();
  }

  // --- stream ----------------------------------------------------------------------------------

  start(): void {
    if (this.watch) return;
    this.open(this.stateValue?.seq);
  }

  private open(after: number | undefined): void {
    this.watch = this.client.conversations.watch(
      this.id,
      {
        onMessage: (message) => this.apply(message),
        onStatus: (status) => {
          this.live = status;
          this.emit();
        },
      },
      after !== undefined ? { after } : {},
    );
  }

  stop(): void {
    this.watch?.close();
    this.watch = undefined;
  }

  get state(): ConversationState | null {
    return this.stateValue;
  }

  /** Apply one stream frame (also used by tests). */
  apply(message: ConversationStreamMessage): void {
    const previous = this.stateValue;
    const next = applyConversationStreamMessage(previous, message);
    if (next === previous) return;
    if (next?.stale) {
      // A seq gap: reconnect from the last applied event.
      this.stateValue = { ...next, stale: false };
      this.watch?.close();
      this.watch = undefined;
      this.open(next.seq);
      return;
    }
    this.stateValue = next;
    if (!next) {
      this.emit();
      return;
    }
    if (previous?.conversation !== next.conversation) this.deps.onConversation?.(next.conversation);
    this.noteStepStarts(next);
    if (this.awaitingRunId) {
      const awaiting = this.awaitingRunId;
      const finished = next.messages.some(
        (m) => m.runId === awaiting && m.role !== "user" && m.status !== "streaming",
      );
      if (next.activeRun || finished) this.awaitingRunId = null;
    }
    this.emit();
    // The reply ended: the next queued message goes out.
    if (
      !next.activeRun &&
      !this.awaitingRunId &&
      this.queue.some((q) => q.state.kind === "waiting")
    ) {
      void this.flushQueue();
    }
  }

  private noteStepStarts(state: ConversationState): void {
    const now = this.deps.now?.() ?? Date.now();
    const run = state.activeRun;
    if (run?.status === "running" && this.stepStarts[`run-${run.id}`] === undefined) {
      this.stepStarts[`run-${run.id}`] = now;
    }
    for (const key of runningStepKeys({
      hasState: true,
      messages: state.messages,
      activeRun: run,
    })) {
      if (this.stepStarts[key] === undefined) this.stepStarts[key] = now;
    }
  }

  get isReplyActive(): boolean {
    return this.stateValue?.activeRun != null || this.awaitingRunId !== null;
  }

  // --- sending ---------------------------------------------------------------------------------

  private requestBody(message: OutgoingMessage) {
    const choice = this.deps.choice();
    return {
      ...(message.text.trim() ? { text: message.text.trim() } : {}),
      ...(message.attachments.length > 0
        ? {
            attachments: message.attachments.map((a) => ({
              assetId: a.assetId,
              ...(a.alias ? { alias: a.alias } : {}),
            })),
          }
        : {}),
      clientMessageId: message.clientMessageId,
      model: choice.model,
      effort: choice.effort,
    };
  }

  /** A send started `run`: busy until the stream shows it. */
  private noteStarted(run: AgentRun): void {
    if (isActiveRunStatus(run.status) && this.stateValue?.activeRun?.id !== run.id) {
      this.awaitingRunId = run.id;
    }
  }

  /** Send now, or queue it while a reply runs. Returns false when the send failed. */
  async send(message: OutgoingMessage): Promise<boolean> {
    if (this.isSending) return false;
    if (!message.text.trim() && message.attachments.length === 0) return false;
    if (this.isReplyActive || this.queue.length > 0) {
      this.queue = [...this.queue, { message, state: { kind: "waiting" }, sendNow: false }];
      this.deps.saveChoice(this.deps.choice());
      this.error = null;
      this.emit();
      if (!this.isReplyActive) await this.flushQueue();
      return true;
    }
    this.isSending = true;
    this.emit();
    try {
      const result = await this.client.conversations.messages.send(
        this.id,
        this.requestBody(message),
      );
      this.noteStarted(result.run);
      this.deps.saveChoice(this.deps.choice());
      this.error = null;
      return true;
    } catch (error) {
      this.error = describeError(error);
      return false;
    } finally {
      this.isSending = false;
      this.emit();
    }
  }

  /** Sends the next waiting message when no reply runs (sendNow first, then in order). */
  async flushQueue(): Promise<void> {
    if (this.isReplyActive || this.isFlushing || this.isSending) return;
    const index =
      this.queue.findIndex((q) => q.sendNow && q.state.kind === "waiting") >= 0
        ? this.queue.findIndex((q) => q.sendNow && q.state.kind === "waiting")
        : this.queue.findIndex((q) => q.state.kind === "waiting");
    const queued = this.queue[index];
    if (!queued) return;
    this.isFlushing = true;
    const id = queued.message.clientMessageId;
    this.updateQueued(id, { state: { kind: "sending" } });
    try {
      const result = await this.client.conversations.messages.send(
        this.id,
        this.requestBody(queued.message),
      );
      this.queue = this.queue.filter((q) => q.message.clientMessageId !== id);
      this.noteStarted(result.run);
      this.error = null;
    } catch (error) {
      this.updateQueued(id, { state: { kind: "failed", error: describeError(error) } });
    } finally {
      this.isFlushing = false;
      this.emit();
    }
  }

  private updateQueued(id: string, patch: Partial<QueuedMessage>): void {
    this.queue = this.queue.map((q) => (q.message.clientMessageId === id ? { ...q, ...patch } : q));
    this.emit();
  }

  retryQueued(id: string): void {
    this.updateQueued(id, { state: { kind: "waiting" } });
    void this.flushQueue();
  }

  removeQueued(id: string): void {
    this.queue = this.queue.filter(
      (q) => q.message.clientMessageId !== id || q.state.kind === "sending",
    );
    this.emit();
  }

  /** Back into the composer (text only); returns the text to put there. */
  takeQueuedForEdit(id: string): string | null {
    const queued = this.queue.find((q) => q.message.clientMessageId === id);
    if (!queued || queued.state.kind === "sending" || queued.message.attachments.length > 0)
      return null;
    this.queue = this.queue.filter((q) => q.message.clientMessageId !== id);
    this.emit();
    return queued.message.text;
  }

  /** "Şimdi gönder": stop the running reply; this message goes out first when it ends. */
  async sendQueuedNow(id: string): Promise<void> {
    if (!this.queue.some((q) => q.message.clientMessageId === id)) return;
    this.queue = this.queue.map((q) => {
      const isTarget = q.message.clientMessageId === id;
      return {
        ...q,
        sendNow: isTarget,
        state: isTarget && q.state.kind === "failed" ? { kind: "waiting" } : q.state,
      };
    });
    this.emit();
    if (this.stateValue?.activeRun) {
      await this.cancelRun();
    } else {
      // Nothing runs on screen: do not wait for a run the stream never showed.
      this.awaitingRunId = null;
      await this.flushQueue();
    }
  }

  async cancelRun(): Promise<void> {
    const run = this.stateValue?.activeRun;
    if (!run) return;
    try {
      await this.client.agentRuns.cancel(run.id);
    } catch (error) {
      this.error = describeError(error);
      this.emit();
    }
  }

  // --- cards -----------------------------------------------------------------------------------

  async decideConsent(message: Message, consent: ConsentPart, allow: boolean): Promise<void> {
    const key = message.id + consent.consentId;
    this.busyConsents.add(key);
    this.emit();
    try {
      await this.client.conversations.messages.consent(this.id, message.id, {
        consentId: consent.consentId,
        allow,
      });
      this.error = null;
    } catch (error) {
      this.error = describeError(error);
    } finally {
      this.busyConsents.delete(key);
      this.emit();
    }
  }

  async answer(
    message: Message,
    question: QuestionPart,
    optionIds: string[],
    text: string | null,
  ): Promise<void> {
    const problem = checkQuestionAnswer(question, { optionIds, text });
    if (problem) {
      this.error = problem;
      this.emit();
      return;
    }
    const key = message.id + question.questionId;
    this.busyQuestions.add(key);
    this.emit();
    try {
      await this.client.conversations.messages.answer(this.id, message.id, {
        questionId: question.questionId,
        optionIds,
        ...(text?.trim() ? { text: text.trim() } : {}),
      });
      this.error = null;
    } catch (error) {
      this.error = describeError(error);
    } finally {
      this.busyQuestions.delete(key);
      this.emit();
    }
  }

  async acceptAndGenerate(plan: Plan): Promise<void> {
    await this.withPlan(plan.id, async () => {
      const choice = this.deps.choice();
      if (plan.status !== "accepted")
        await this.client.plans.accept(plan.id, { revision: plan.revision });
      await this.client.plans.generate(plan.id, { model: choice.model, effort: choice.effort });
    });
  }

  async rejectPlan(plan: Plan): Promise<void> {
    await this.withPlan(plan.id, () => this.client.plans.reject(plan.id, {}).then(() => undefined));
  }

  private async withPlan(planId: string, run: () => Promise<void>): Promise<void> {
    if (this.busyPlans.has(planId)) return;
    this.busyPlans.add(planId);
    this.emit();
    try {
      await run();
      this.error = null;
    } catch (error) {
      this.error = describeError(error);
    } finally {
      this.busyPlans.delete(planId);
      this.emit();
    }
  }

  toggleSteps(key: string): void {
    if (this.expandedSteps.has(key)) this.expandedSteps.delete(key);
    else this.expandedSteps.add(key);
    this.emit();
  }

  clearError(): void {
    this.error = null;
    this.emit();
  }
}

// --- cache --------------------------------------------------------------------------------------

/** Open conversations keep their stream; the least recently used ones beyond `limit` stop. */
export class ConversationCache {
  private controllers = new Map<string, ConversationController>();

  constructor(
    private readonly make: (id: string) => ConversationController,
    private readonly limit = 6,
  ) {}

  get(id: string): ConversationController {
    let controller = this.controllers.get(id);
    if (controller) {
      this.controllers.delete(id);
    } else {
      controller = this.make(id);
    }
    this.controllers.set(id, controller);
    controller.start();
    while (this.controllers.size > this.limit) {
      const oldest = this.controllers.keys().next().value as string;
      const stale = this.controllers.get(oldest);
      if (stale?.isReplyActive) {
        // Keep a working conversation alive; drop the next one instead.
        this.controllers.delete(oldest);
        this.controllers.set(oldest, stale);
        if ([...this.controllers.values()].every((c) => c.isReplyActive)) break;
        continue;
      }
      stale?.stop();
      this.controllers.delete(oldest);
    }
    return controller;
  }

  peek(id: string): ConversationController | undefined {
    return this.controllers.get(id);
  }

  clear(): void {
    for (const controller of this.controllers.values()) controller.stop();
    this.controllers.clear();
  }
}
