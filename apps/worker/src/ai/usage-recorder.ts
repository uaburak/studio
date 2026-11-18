/**
 * Records paid AI calls for the spend view (roadmap 11): each Gemini API call's tokens and its
 * cost from the pricing table go to `POST /api/worker/ai/usage`, batched and retried in the
 * background. A call is never slowed down or failed by this; at most `maxQueue` records wait
 * while the API is unreachable (older ones are dropped with a warning).
 */
import type { AiUsageRecordInput } from "@studio/contract";
import type { StudioApi } from "../api.ts";
import { type GeminiUsageSample, geminiCostUsd, PRICING_CHECKED_AT } from "../gemini/pricing.ts";
import type { Logger } from "../log.ts";

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
    const at = (this.options.now ?? (() => new Date()))();
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

  record(entry: AiUsageRecordInput): void {
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

  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
    this.timer.unref?.();
  }
}

/** A Gemini usage callback for one job (no-op without a recorder). */
export function geminiUsageSink(
  recorder: AiUsageRecorder | undefined,
  context: AiUsageContext,
): ((sample: GeminiUsageSample) => void) | undefined {
  if (!recorder) return undefined;
  return (sample) => recorder.gemini(sample, context);
}
