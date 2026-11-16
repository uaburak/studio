/**
 * Writes the assistant message of one run through the worker turn API.
 * - Text deltas are buffered and sent about every 250 ms (the API asks for batching),
 *   split into ≤ 16 KiB deltas, with per-part `seq` from 1 (a retried request is
 *   skipped by the server, so network retries are safe).
 * - Multi-part interleaving: when non-text parts (`tool_step`, `consent`, `plan_proposal`,
 *   `question`, `progress`) are appended after streamed text, buffered text is flushed
 *   first and subsequent `appendText` calls open a new text part with its own `seq` from 1.
 * - All writes go through one queue, so parts land in execution order.
 */
import {
  ApiError,
  MAX_TEXT_DELTA_BYTES,
  MAX_TURN_OPS,
  type Message,
  type MessagePartInput,
  type PlanProposalPut,
  type PlanProposalResult,
  type RunUsage,
  type TurnOp,
} from "@studio/contract";
import { isTransientApiError, type StudioApi } from "../api.ts";
import type { Logger } from "../log.ts";
import { silentLogger } from "../log.ts";

/** The run was cancelled or finished by someone else; stop writing. */
export class RunClosedError extends Error {
  override name = "RunClosedError";
}

export interface TurnWriterOptions {
  api: StudioApi;
  runId: string;
  attempt: number;
  /** Parts already in the assistant message (a resumed attempt). */
  initialParts?: number;
  flushIntervalMs?: number;
  signal?: AbortSignal;
  logger?: Logger;
  /** Network retries per request (default 4). */
  retries?: number;
  retryDelayMs?: number;
}

const encoder = new TextEncoder();

/** Split text into pieces of at most `maxBytes` UTF-8 bytes without breaking a code point. */
export function splitUtf8(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  for (const ch of text) {
    const size = encoder.encode(ch).byteLength;
    if (bytes + size > maxBytes && current) {
      out.push(current);
      current = "";
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  if (current) out.push(current);
  return out;
}

export class TurnWriter {
  private nextPartIndex: number;
  private activeTextIndex: number | null = null;
  private textSeq = 0;
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private failure: unknown;
  private readonly logger: Logger;
  /** Text written so far (all text parts). */
  written = "";
  lastMessage: Message | undefined;

  constructor(private readonly options: TurnWriterOptions) {
    this.nextPartIndex = options.initialParts ?? 0;
    this.logger = options.logger ?? silentLogger;
  }

  /** Index the next appended part will get. */
  get partCount(): number {
    return this.nextPartIndex;
  }

  /** Append streamed text to the active trailing text part (or a new text part when needed). */
  appendText(text: string): void {
    if (!text) return;
    this.buffer += text;
    this.written += text;
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(() => undefined);
      }, this.options.flushIntervalMs ?? 250);
      this.timer.unref?.();
    }
  }

  /** Later text goes into a new text part (e.g. after a boundary). */
  endTextPart(): void {
    if (this.buffer) void this.flush().catch(() => undefined);
    void this.enqueue(async () => {
      this.activeTextIndex = null;
      this.textSeq = 0;
    });
  }

  /** Send buffered text now; resolves when everything queued so far is written. */
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const text = this.buffer;
    this.buffer = "";
    if (text) {
      await this.enqueue(async () => {
        if (this.activeTextIndex === null || this.activeTextIndex !== this.nextPartIndex - 1) {
          this.activeTextIndex = this.nextPartIndex++;
          this.textSeq = 0;
        }
        const index = this.activeTextIndex;
        const ops: TurnOp[] = splitUtf8(text, MAX_TEXT_DELTA_BYTES - 64).map((piece) => ({
          op: "text.delta",
          index,
          seq: ++this.textSeq,
          text: piece,
        }));
        for (let i = 0; i < ops.length; i += MAX_TURN_OPS) {
          await this.send(ops.slice(i, i + MAX_TURN_OPS));
        }
      });
    } else {
      await this.enqueue(async () => undefined);
    }
    if (this.failure) throw this.failure;
  }

  /** Append a part (or replace the part at `index`). Flushes buffered text first. */
  async setPart(part: MessagePartInput, index?: number): Promise<number> {
    await this.flush();
    let at = index ?? -1;
    await this.enqueue(async () => {
      if (at < 0) {
        at = this.nextPartIndex++;
        this.activeTextIndex = null;
        this.textSeq = 0;
      } else if (at >= this.nextPartIndex) {
        this.nextPartIndex = at + 1;
        this.activeTextIndex = null;
        this.textSeq = 0;
      } else if (at === this.activeTextIndex) {
        // Replaced via part.set rather than text.delta; do not resume delta seqs on it.
        this.activeTextIndex = null;
        this.textSeq = 0;
      }
      await this.send([{ op: "part.set", index: at, part }]);
    });
    if (this.failure) throw this.failure;
    return at;
  }

  async putPlan(input: PlanProposalPut): Promise<PlanProposalResult> {
    await this.flush();
    let result: PlanProposalResult | undefined;
    await this.enqueue(async () => {
      const before = this.nextPartIndex;
      result = await this.retry(() =>
        this.options.api.client.workerTurns.putPlan(
          this.options.runId,
          { ...input, attempt: this.options.attempt },
          this.init(),
        ),
      );
      this.lastMessage = result.message;
      this.nextPartIndex = Math.max(this.nextPartIndex, result.message.parts.length);
      if (this.nextPartIndex > before || this.activeTextIndex !== this.nextPartIndex - 1) {
        this.activeTextIndex = null;
        this.textSeq = 0;
      }
    });
    if (this.failure) throw this.failure;
    return result as PlanProposalResult;
  }

  async complete(
    model: string | undefined,
    usage: RunUsage | undefined,
    session?: { id: string },
  ): Promise<void> {
    await this.flush();
    await this.retry(() =>
      this.options.api.client.workerTurns.complete(
        this.options.runId,
        {
          attempt: this.options.attempt,
          ...(model ? { model } : {}),
          ...(usage ? { usage } : {}),
          ...(session ? { session } : {}),
        },
        this.init(),
      ),
    );
  }

  /** Close the run as failed; the server adds the error as an `error` part. */
  async fail(error: string, model?: string, usage?: RunUsage): Promise<void> {
    clearTimeout(this.timer);
    await this.queue.catch(() => undefined);
    await this.retry(() =>
      this.options.api.client.workerTurns.fail(
        this.options.runId,
        {
          attempt: this.options.attempt,
          error: error.slice(0, 10_000),
          ...(model ? { model } : {}),
          ...(usage ? { usage } : {}),
        },
        // No abort signal here: failing must still reach the server.
      ),
    );
  }

  /** Stop the timer (cancellation). */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      if (this.failure) return;
      try {
        await task();
      } catch (error) {
        this.failure = error;
      }
    });
    this.queue = next;
    return next;
  }

  private async send(ops: TurnOp[]): Promise<void> {
    const res = await this.retry(() =>
      this.options.api.client.workerTurns.ops(
        this.options.runId,
        { attempt: this.options.attempt, ops },
        this.init(),
      ),
    );
    this.lastMessage = res.message;
  }

  private init(): RequestInit | undefined {
    return this.options.signal ? { signal: this.options.signal } : undefined;
  }

  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    const retries = this.options.retries ?? 4;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (this.options.signal?.aborted) throw this.options.signal.reason ?? error;
        if (
          error instanceof ApiError &&
          error.status === 409 &&
          error.code === "invalid_transition"
        ) {
          throw new RunClosedError(error.message);
        }
        if (!isTransientApiError(error) || attempt >= retries) throw error;
        const delay = (this.options.retryDelayMs ?? 500) * 2 ** attempt;
        this.logger.warn(
          `turn write failed (${(error as Error).message}); retrying in ${delay} ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
}
