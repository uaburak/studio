/**
 * Records paid AI calls for the spend view (roadmap 11, U8): each Gemini / OpenAI API call's
 * tokens and each ElevenLabs voice-over's characters, with the cost from the dated pricing tables
 * (`@studio/contract` ai-pricing.ts), go to `POST /api/worker/ai/usage`, batched and retried in the
 * background. A call is never slowed down or failed by the recording; at most `maxQueue` records
 * wait while the API is unreachable (older ones are dropped with a warning).
 *
 * The recorder also carries the budget (S7, `AiPolicy`): `assertBudget()` before a paid call, and
 * every recorded cost counts towards this month's spend at once.
 */
import {
  type AiUsageRecordInput,
  ELEVENLABS_PRICING_CHECKED_AT,
  elevenLabsCostUsd,
  OPENAI_PRICING_CHECKED_AT,
  type OpenAiUsageSample,
  openAiCostUsd,
} from "@studio/contract";
import type { StudioApi } from "../api.ts";
import { type GeminiUsageSample, geminiCostUsd, PRICING_CHECKED_AT } from "../gemini/pricing.ts";
import type { Logger } from "../log.ts";
import type { AiPolicy } from "./policy.ts";

export interface AiUsageContext {
  /** chat | generate | brand | image | transcribe | reel | other */
  kind: string;
  jobId?: string | undefined;
  runId?: string | undefined;
}

export interface AiUsageRecorderOptions {
  api: Pick<StudioApi, "client">;
  logger: Logger;
  /** Wait this long to batch records (default 1.5 s). */
  flushDelayMs?: number;
  maxQueue?: number;
  now?: () => Date;
  /** Budget and limit preferences (S7); without it no budget is enforced. */
  policy?: AiPolicy;
}

const BATCH = 100;

export class AiUsageRecorder {
  private queue: AiUsageRecordInput[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flushing: Promise<void> | undefined;
  private failures = 0;

  constructor(private readonly options: AiUsageRecorderOptions) {}

  /** Queue one Gemini call (cost from the pricing table; null when the model is not priced). */
  gemini(sample: GeminiUsageSample, context: AiUsageContext): void {
    const at = this.at();
    const cachedTokens = Math.min(sample.cachedTokens, sample.promptTokens);
    this.record({
      provider: "gemini",
      model: sample.model.replace(/^models\//, "").slice(0, 128) || "gemini",
      kind: context.kind,
      jobId: context.jobId ?? null,
      runId: context.runId ?? null,
      inputTokens: sample.promptTokens,
      outputTokens: sample.candidatesTokens,
      thoughtsTokens: sample.thoughtsTokens,
      cachedTokens,
      costUsd: geminiCostUsd(sample, at),
      pricingVersion: PRICING_CHECKED_AT,
      occurredAt: at.toISOString(),
    });
  }

  /** Queue one OpenAI Responses API request (U8). */
  openai(sample: OpenAiUsageSample, context: AiUsageContext): void {
    const at = this.at();
    this.record({
      provider: "openai",
      model: sample.model.slice(0, 128) || "openai",
      kind: context.kind,
      jobId: context.jobId ?? null,
      runId: context.runId ?? null,
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      thoughtsTokens: sample.reasoningTokens ?? 0,
      cachedTokens: Math.min(sample.cachedTokens, sample.inputTokens),
      costUsd: openAiCostUsd(sample, at),
      pricingVersion: OPENAI_PRICING_CHECKED_AT,
      occurredAt: at.toISOString(),
    });
  }

  /** Queue one ElevenLabs voice-over (characters as `inputTokens`) (U8). */
  elevenLabs(input: { model: string; characters: number }, context: AiUsageContext): void {
    const at = this.at();
    this.record({
      provider: "elevenlabs",
      model: input.model.slice(0, 128) || "elevenlabs",
      kind: context.kind,
      jobId: context.jobId ?? null,
      runId: context.runId ?? null,
      inputTokens: Math.max(0, Math.round(input.characters)),
      outputTokens: 0,
      costUsd: elevenLabsCostUsd(input.model, input.characters, at),
      pricingVersion: ELEVENLABS_PRICING_CHECKED_AT,
      occurredAt: at.toISOString(),
    });
  }

  /** Throws `BudgetExceededError` when "bütçe dolunca dur" stops paid calls (S7). */
  assertBudget(): void {
    this.options.policy?.assertBudget();
  }

  /** Cost of the records not sent yet (counted when the budget is read again). */
  pendingCostUsd(): number {
    return this.queue.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  }

  record(entry: AiUsageRecordInput): void {
    this.options.policy?.addSpend(entry.costUsd);
    this.queue.push(entry);
    const max = this.options.maxQueue ?? 1_000;
    if (this.queue.length > max) {
      const dropped = this.queue.length - max;
      this.queue.splice(0, dropped);
      this.options.logger.warn(`ai usage: API unreachable, dropped ${dropped} old record(s)`);
    }
    this.schedule(this.options.flushDelayMs ?? 1_500);
  }

  pending(): number {
    return this.queue.length;
  }

  /** Send everything queued now (one request per 100 records). */
  flush(): Promise<void> {
    this.flushing ??= (async () => {
      try {
        while (this.queue.length > 0) {
          const batch = this.queue.slice(0, BATCH);
          await this.options.api.client.workerAi.reportUsage({ records: batch });
          this.queue.splice(0, batch.length);
          this.failures = 0;
        }
      } catch (error) {
        this.failures++;
        if (this.failures === 1 || this.failures % 10 === 0) {
          this.options.logger.warn(
            `ai usage: could not report ${this.queue.length} record(s): ${(error as Error).message}`,
          );
        }
        // Retry later, backing off up to a minute.
        this.schedule(Math.min(60_000, 2_000 * 2 ** Math.min(this.failures, 5)));
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  async stop(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.queue.length > 0) await this.flush().catch(() => undefined);
  }

  private at(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }
}

/**
 * A Gemini usage callback for one job (no-op without a recorder). It carries the budget check
 * (`assertBudget`), which the Gemini callers run before each paid request.
 */
export type GeminiUsageSink = ((sample: GeminiUsageSample) => void) & {
  assertBudget?: () => void;
};

export function geminiUsageSink(
  recorder: AiUsageRecorder | undefined,
  context: AiUsageContext,
): GeminiUsageSink | undefined {
  if (!recorder) return undefined;
  const sink: GeminiUsageSink = (sample) => recorder.gemini(sample, context);
  sink.assertBudget = () => recorder.assertBudget();
  return sink;
}

/** Run a sink's budget check, if it has one (before a paid request). */
export function assertSinkBudget(sink: unknown): void {
  const check = (sink as GeminiUsageSink | undefined)?.assertBudget;
  if (typeof check === "function") check();
}
