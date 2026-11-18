/**
 * The owner's AI preferences as the worker enforces them (S7, Ayarlar → Yapay zekâ):
 * - what a Claude call does at the usage limit (`ask` / `gemini` / `wait`) and the owner's answer
 *   for the current window (`limitChoice`);
 * - the monthly budget of the paid calls (Gemini, OpenAI, ElevenLabs): with "bütçe dolunca dur"
 *   every paid call checks it first and is refused once the month's spend reached it
 *   (`assertBudget`). The spend is the API's figure when last read plus what this worker recorded
 *   since, so the stop does not wait for the next read.
 * Read from `GET /api/worker/ai/settings` at start, every few minutes and on `ai.credentials`
 * (`AgentRuntime.refreshAiSettings`).
 */
import {
  type ClaudeLimitChoice,
  type ClaudeLimitMode,
  DEFAULT_CLAUDE_LIMIT_MODE,
  type WorkerAiSettings,
} from "@studio/contract";
import type { LimitChoice } from "../claude/gate.ts";
import type { Logger } from "../log.ts";
import { silentLogger } from "../log.ts";

/** A paid call refused because the month's budget is used up ("bütçe dolunca dur"). */
export class BudgetExceededError extends Error {
  override name = "BudgetExceededError";
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(
      `Aylık yapay zekâ bütçesi doldu (${formatUsd(spentUsd)} / ${formatUsd(budgetUsd)}); ücretli çağrı yapılmadı. Ayarlar → Yapay zekâ → Kullanım'dan bütçeyi artırabilir ya da "Bütçe dolunca dur"u kapatabilirsiniz.`,
    );
  }
}

export function isBudgetExceeded(error: unknown): error is BudgetExceededError {
  return error instanceof BudgetExceededError;
}

function formatUsd(value: number): string {
  return `${value.toFixed(2).replace(".", ",")} $`;
}

export interface AiPolicyOptions {
  logger?: Logger;
  now?: () => Date;
}

export class AiPolicy {
  private mode: ClaudeLimitMode = DEFAULT_CLAUDE_LIMIT_MODE;
  private decision: { choice: ClaudeLimitChoice; until: number } | null = null;
  private monthlyUsd: number | null = null;
  private stopAtBudget = false;
  /** The API's figure at the last read, and the month it belongs to. */
  private baseSpentUsd = 0;
  private monthStart = 0;
  /** Recorded on this worker since the last read. */
  private localSpentUsd = 0;
  private readonly listeners = new Set<() => void>();
  private readonly logger: Logger;
  private readonly now: () => Date;
  /** True once settings were read from the API (until then: defaults). */
  loaded = false;

  constructor(options: AiPolicyOptions = {}) {
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
    this.monthStart = localMonthStart(this.now());
  }

  /**
   * Settings from `GET /api/worker/ai/settings`; `pendingUsd` is the spend recorded here but not
   * sent yet (it is not in the API's figure).
   */
  apply(settings: WorkerAiSettings, pendingUsd = 0): void {
    const before = JSON.stringify(this.snapshot());
    this.mode = settings.claudeLimit;
    this.decision = settings.limitDecision
      ? {
          choice: settings.limitDecision.choice,
          until: new Date(settings.limitDecision.until).getTime(),
        }
      : null;
    this.monthlyUsd = settings.budget.monthlyUsd;
    this.stopAtBudget = settings.budget.stopAtBudget;
    this.baseSpentUsd = settings.budget.spentUsd;
    this.monthStart = new Date(settings.budget.monthStart).getTime();
    this.localSpentUsd = pendingUsd;
    this.loaded = true;
    if (JSON.stringify(this.snapshot()) !== before) {
      this.logger.info(
        `ai settings: claude limit ${this.mode}${this.decision ? ` (answer: ${this.decision.choice})` : ""}, budget ${this.monthlyUsd ?? "none"}${this.stopAtBudget ? " (stop)" : ""}`,
      );
      for (const fn of this.listeners) fn();
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** The owner's limit mode. */
  claudeLimitMode(): ClaudeLimitMode {
    return this.mode;
  }

  /** The owner's answer for the current limit window, when one holds. */
  limitDecision(): ClaudeLimitChoice | null {
    if (!this.decision) return null;
    if (this.decision.until <= this.now().getTime()) return null;
    return this.decision.choice;
  }

  /** What a call does at the limit now: the answer, else the mode. */
  limitChoice(): LimitChoice {
    return this.limitDecision() ?? this.mode;
  }

  /** Spend of this month as far as the worker knows. */
  spentUsd(): number {
    this.rollMonth();
    return this.baseSpentUsd + this.localSpentUsd;
  }

  /** A paid call this worker recorded (cost from the pricing tables). */
  addSpend(usd: number | null | undefined): void {
    if (!usd || !Number.isFinite(usd) || usd <= 0) return;
    this.rollMonth();
    this.localSpentUsd += usd;
  }

  budget(): { monthlyUsd: number | null; stopAtBudget: boolean; spentUsd: number } {
    return {
      monthlyUsd: this.monthlyUsd,
      stopAtBudget: this.stopAtBudget,
      spentUsd: this.spentUsd(),
    };
  }

  /** Throws `BudgetExceededError` before a paid call when the budget stops it. */
  assertBudget(): void {
    if (!this.stopAtBudget || this.monthlyUsd === null) return;
    const spent = this.spentUsd();
    if (spent >= this.monthlyUsd) throw new BudgetExceededError(spent, this.monthlyUsd);
  }

  private snapshot() {
    return {
      mode: this.mode,
      decision: this.decision,
      monthlyUsd: this.monthlyUsd,
      stopAtBudget: this.stopAtBudget,
    };
  }

  /** A new month started since the last read: its spend starts at zero. */
  private rollMonth(): void {
    const start = localMonthStart(this.now());
    if (start > this.monthStart) {
      this.monthStart = start;
      this.baseSpentUsd = 0;
      this.localSpentUsd = 0;
    }
  }
}

/** Start of the local month (this Mac's time zone) as UTC ms. */
export function localMonthStart(at: Date): number {
  return new Date(at.getFullYear(), at.getMonth(), 1).getTime();
}
