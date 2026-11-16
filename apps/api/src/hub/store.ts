import { and, asc, count, desc, eq, inArray, isNull, lte, min, type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import type { JobRow } from "../db/mappers.ts";
import { jobs } from "../db/schema.ts";

/**
 * D1 access for the Hub. D1 is the source of truth for jobs; every state
 * change here is a conditional UPDATE ... WHERE status = <expected> RETURNING,
 * so a duplicate message, a retried alarm or a restarted Hub can never apply
 * a transition twice. A `undefined` return means "the row was not in the
 * expected state" (already handled, or never ours).
 */
export class JobStore {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<JobRow | undefined> {
    return this.db.query.jobs.findFirst({ where: eq(jobs.id, id) });
  }

  async getMany(ids: string[]): Promise<JobRow[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(jobs).where(inArray(jobs.id, ids));
  }

  /** Next queued jobs for a worker with these capabilities: priority desc, then FIFO. */
  async nextQueued(types: string[], limit: number): Promise<JobRow[]> {
    if (types.length === 0 || limit <= 0) return [];
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "queued"), inArray(jobs.type, types)))
      .orderBy(desc(jobs.priority), asc(jobs.id))
      .limit(limit);
  }

  async runningFor(workerId: string): Promise<JobRow[]> {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "running"), eq(jobs.workerId, workerId)));
  }

  async running(limit = 100): Promise<JobRow[]> {
    return this.db
      .select()
      .from(jobs)
      .where(eq(jobs.status, "running"))
      .orderBy(asc(jobs.id))
      .limit(limit);
  }

  async queueLength(): Promise<number> {
    const [row] = await this.db.select({ n: count() }).from(jobs).where(eq(jobs.status, "queued"));
    return row?.n ?? 0;
  }

  /** Jobs for a stream snapshot, newest first. */
  async recent(filter: { jobId?: string; brandId?: string }, limit: number): Promise<JobRow[]> {
    const where: SQL[] = [];
    if (filter.jobId) where.push(eq(jobs.id, filter.jobId));
    if (filter.brandId) where.push(eq(jobs.brandId, filter.brandId));
    return this.db
      .select()
      .from(jobs)
      .where(and(...where))
      .orderBy(desc(jobs.id))
      .limit(limit);
  }

  async expiredLeases(now: number): Promise<JobRow[]> {
    return this.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.status, "running"), lte(jobs.leaseExpiresAt, new Date(now))));
  }

  async nextLeaseDeadline(): Promise<number | null> {
    const [row] = await this.db
      .select({ at: min(jobs.leaseExpiresAt) })
      .from(jobs)
      .where(eq(jobs.status, "running"));
    const at = row?.at;
    return at ? at.getTime() : null;
  }

  // --- transitions -------------------------------------------------------------

  /** queued -> running (assigned, not yet acknowledged). Consumes an attempt; refunded if never acked. */
  claim(id: string, workerId: string, now: number, ackDeadline: number) {
    return this.one(
      this.db
        .update(jobs)
        .set({
          status: "running",
          workerId,
          attempts: sql`${jobs.attempts} + 1`,
          dispatchedAt: new Date(now),
          ackedAt: null,
          leaseExpiresAt: new Date(ackDeadline),
          updatedAt: new Date(now),
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, "queued")))
        .returning(),
    );
  }

  /**
   * The worker confirmed it holds the job (ack, progress or heartbeat).
   * Starts/extends the lease, except after a cancel request: then the cancel
   * grace deadline stays in force.
   */
  touch(
    id: string,
    workerId: string,
    now: number,
    leaseUntil: number,
    progress?: { value: number; message: string | null },
  ) {
    return this.one(
      this.db
        .update(jobs)
        .set({
          ackedAt: sql`coalesce(${jobs.ackedAt}, ${now})`,
          startedAt: sql`coalesce(${jobs.startedAt}, ${now})`,
          leaseExpiresAt: sql`case when ${jobs.cancelRequestedAt} is null then ${leaseUntil} else ${jobs.leaseExpiresAt} end`,
          updatedAt: new Date(now),
          ...(progress ? { progress: progress.value, progressMessage: progress.message } : {}),
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, "running"), eq(jobs.workerId, workerId)))
        .returning(),
    );
  }

  /** Worker holds the job again after a reconnect although the Hub had requeued it. */
  reclaim(id: string, workerId: string, now: number, leaseUntil: number) {
    return this.one(
      this.db
        .update(jobs)
        .set({
          status: "running",
          ackedAt: new Date(now),
          dispatchedAt: sql`coalesce(${jobs.dispatchedAt}, ${now})`,
          leaseExpiresAt: new Date(leaseUntil),
          updatedAt: new Date(now),
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, "queued"), eq(jobs.workerId, workerId)))
        .returning(),
    );
  }

  /** running -> queued. `refundAttempt` when the attempt never really started (no ack, or released). */
  requeue(id: string, now: number, opts: { refundAttempt: boolean; error?: string | null }) {
    return this.one(
      this.db
        .update(jobs)
        .set({
          status: "queued",
          ...(opts.refundAttempt ? { attempts: sql`max(${jobs.attempts} - 1, 0)` } : {}),
          leaseExpiresAt: null,
          dispatchedAt: null,
          ackedAt: null,
          progress: null,
          progressMessage: null,
          ...(opts.error !== undefined ? { error: opts.error } : {}),
          updatedAt: new Date(now),
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
        .returning(),
    );
  }

  /** queued|running -> terminal. The first caller wins; later ones get undefined. */
  finish(
    id: string,
    now: number,
    result:
      | { status: "succeeded"; output: Record<string, unknown> | null }
      | { status: "failed"; error: string }
      | { status: "cancelled"; error?: string | null },
  ) {
    return this.one(
      this.db
        .update(jobs)
        .set({
          status: result.status,
          ...(result.status === "succeeded"
            ? { output: result.output, error: null, progress: 1 }
            : { error: result.error ?? null }),
          leaseExpiresAt: null,
          finishedAt: new Date(now),
          updatedAt: new Date(now),
        })
        .where(and(eq(jobs.id, id), inArray(jobs.status, ["queued", "running"])))
        .returning(),
    );
  }

  /** queued -> cancelled. */
  cancelQueued(id: string, now: number) {
    return this.one(
      this.db
        .update(jobs)
        .set({
          status: "cancelled",
          cancelRequestedAt: new Date(now),
          finishedAt: new Date(now),
          updatedAt: new Date(now),
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, "queued")))
        .returning(),
    );
  }

  /** Mark a running job for cancellation; the lease shrinks to the cancel grace deadline. */
  requestCancel(id: string, now: number, graceUntil: number) {
    return this.one(
      this.db
        .update(jobs)
        .set({
          cancelRequestedAt: sql`coalesce(${jobs.cancelRequestedAt}, ${now})`,
          leaseExpiresAt: sql`min(coalesce(${jobs.leaseExpiresAt}, ${graceUntil}), ${graceUntil})`,
          updatedAt: new Date(now),
        })
        .where(and(eq(jobs.id, id), eq(jobs.status, "running")))
        .returning(),
    );
  }

  /** Extend leases of jobs the worker says it still runs (cancel-pending jobs excluded). */
  async renew(workerId: string, ids: string[], now: number, leaseUntil: number): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(jobs)
      .set({
        ackedAt: sql`coalesce(${jobs.ackedAt}, ${now})`,
        startedAt: sql`coalesce(${jobs.startedAt}, ${now})`,
        leaseExpiresAt: new Date(leaseUntil),
      })
      .where(
        and(
          inArray(jobs.id, ids),
          eq(jobs.status, "running"),
          eq(jobs.workerId, workerId),
          isNull(jobs.cancelRequestedAt),
        ),
      );
  }

  private async one(query: Promise<JobRow[]>): Promise<JobRow | undefined> {
    const rows = await query;
    return rows[0];
  }
}
