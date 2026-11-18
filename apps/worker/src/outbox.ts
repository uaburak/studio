import { mkdirSync, readFileSync, renameSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { JobResultMessage } from "@studio/contract";
import { z } from "zod";
import { type Logger, silentLogger } from "./log.ts";

/**
 * Results waiting for the hub's `job.result.ack`. A result stays here until
 * the hub confirms it, so it survives disconnects (resent after `hello`)
 * and, with FileOutbox, worker restarts.
 */
export interface Outbox {
  list(): JobResultMessage[];
  get(jobId: string): JobResultMessage | undefined;
  put(result: JobResultMessage): Promise<void>;
  delete(jobId: string): Promise<void>;
  readonly size: number;
}

export class MemoryOutbox implements Outbox {
  protected readonly entries = new Map<string, JobResultMessage>();

  list(): JobResultMessage[] {
    return [...this.entries.values()];
  }
  get(jobId: string): JobResultMessage | undefined {
    return this.entries.get(jobId);
  }
  get size(): number {
    return this.entries.size;
  }
  async put(result: JobResultMessage): Promise<void> {
    this.entries.set(result.jobId, result);
    await this.persist();
  }
  async delete(jobId: string): Promise<void> {
    if (this.entries.delete(jobId)) await this.persist();
  }
  protected async persist(): Promise<void> {}
}

const OutboxFile = z.object({ version: z.literal(1), results: z.array(z.unknown()) });

export interface FileOutboxOptions {
  logger?: Logger;
  /** Tries per write before giving up on it (default 3). */
  writeAttempts?: number;
  /** Wait before the 2nd try, doubled for each later one (default 100 ms). */
  retryDelayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * JSON file under the state directory; writes are atomic (tmp + rename) and serialized.
 *
 * Each write stands on its own: it writes the outbox as it is when the write starts (the latest
 * snapshot wins), retries a few times, and a write that still fails is logged and dropped without
 * blocking later ones; the results stay in memory and the next change writes them again.
 * An unreadable file is moved aside (`<file>.corrupt-<time>`) and the outbox starts empty.
 */
export class FileOutbox extends MemoryOutbox {
  private writing: Promise<void> = Promise.resolve();
  /** A write that is queued but has not started yet; later changes ride along with it. */
  private queued: Promise<void> | undefined;
  private failing = false;
  private readonly logger: Logger;
  private readonly writeAttempts: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly file: string,
    options: FileOutboxOptions = {},
  ) {
    super();
    this.logger = options.logger ?? silentLogger;
    this.writeAttempts = Math.max(1, options.writeAttempts ?? 3);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 100);
    mkdirSync(path.dirname(file), { recursive: true });
    let raw: string | undefined;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      return; // no file yet
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      data = undefined;
    }
    const parsed = OutboxFile.safeParse(data);
    if (!parsed.success) {
      this.moveAside("unreadable");
      return;
    }
    let dropped = 0;
    for (const item of parsed.data.results) {
      const result = JobResultMessage.safeParse(item);
      if (result.success) this.entries.set(result.data.jobId, result.data);
      else dropped++;
    }
    if (dropped > 0) this.moveAside(`${dropped} unreadable result(s) dropped`);
  }

  /** Keep the bad file for inspection; the next write starts a fresh one. */
  private moveAside(reason: string): void {
    const aside = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
      renameSync(this.file, aside);
      this.logger.warn(
        `outbox file ${this.file} is corrupt (${reason}); moved to ${aside}, starting with ${this.entries.size} result(s)`,
      );
    } catch (error) {
      this.logger.warn(
        `outbox file ${this.file} is corrupt (${reason}) and could not be moved aside; it will be overwritten`,
        error,
      );
    }
  }

  protected override persist(): Promise<void> {
    if (this.queued) return this.queued;
    const next = this.writing.then(() => {
      this.queued = undefined;
      return this.writeLatest();
    });
    this.queued = next;
    this.writing = next;
    return next;
  }

  /** Never rejects: a failed write must not stop the ones after it. */
  private async writeLatest(): Promise<void> {
    const tmp = `${this.file}.tmp`;
    for (let attempt = 1; ; attempt++) {
      const snapshot = JSON.stringify({ version: 1, results: this.list() });
      try {
        await writeFile(tmp, snapshot, "utf8");
        await rename(tmp, this.file);
        if (this.failing) this.logger.info(`outbox file ${this.file} written again`);
        this.failing = false;
        return;
      } catch (error) {
        if (attempt >= this.writeAttempts) {
          this.failing = true;
          this.logger.warn(
            `could not write the outbox file ${this.file} (${attempt} tries); ${this.entries.size} result(s) kept in memory, the next change writes them again`,
            error,
          );
          return;
        }
        this.logger.debug(`outbox write failed (try ${attempt}), retrying`, error);
        await sleep(this.retryDelayMs * 2 ** (attempt - 1));
      }
    }
  }
}
