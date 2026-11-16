import { mkdirSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { JobResultMessage } from "@studio/contract";
import { z } from "zod";

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

const OutboxFile = z.object({ version: z.literal(1), results: z.array(JobResultMessage) });

/** JSON file under the state directory; writes are atomic (tmp + rename) and serialized. */
export class FileOutbox extends MemoryOutbox {
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    super();
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
      throw new Error(`outbox file ${file} is corrupt; move it away to start fresh`);
    }
    for (const result of parsed.data.results) this.entries.set(result.jobId, result);
  }

  protected override persist(): Promise<void> {
    const snapshot = JSON.stringify({ version: 1, results: this.list() });
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, snapshot, "utf8");
      await rename(tmp, this.file);
    });
    return this.writing;
  }
}
