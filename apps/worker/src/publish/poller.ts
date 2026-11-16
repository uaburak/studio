/**
 * Background 30-second schedule sync loop (`PLAN.md` §4 & §8):
 * - Mode A (Cloud Publisher configured): pushes any newly created `pending` schedules
 *   to Cloud Publisher and syncs `publishing` / `published` (with `permalink`) / `failed`
 *   outcomes back to `workerSchedules.outcome`.
 * - Mode B (Local Direct Publisher): checks `workerSchedules.due({ before: now })` and
 *   publishes due schedules directly from the Mac worker.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  getCloudPublisherConfig,
  publishScheduleLocally,
  pushScheduleToCloudPublisher,
  type SchedulePublishDeps,
  syncCloudPublisherOutcomes,
} from "./handler.ts";

interface PersistedCloudSyncState {
  pushedVersions: Record<string, string>;
  reportedStates: Record<string, string>;
  updatedSince?: string;
}

export class SchedulePoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private controller: AbortController | undefined;
  private ticking: Promise<void> | undefined;
  private loaded = false;
  private readonly pushedVersions = new Map<string, string>();
  private readonly reportedStates = new Map<string, string>();
  private updatedSince: string | undefined;
  private readonly stateFile: string;

  constructor(private readonly deps: SchedulePublishDeps) {
    this.stateFile = path.join(deps.stateDir, "schedule-sync.json");
  }

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.controller = new AbortController();
    this.timer = setInterval(() => {
      void this.tick().catch((err: unknown) => {
        this.deps.logger.warn(`schedule poller tick failed: ${(err as Error).message}`);
      });
    }, intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.controller?.abort();
    if (this.ticking) {
      await this.ticking.catch(() => undefined);
    }
  }

  /** Run one sync/publish cycle immediately (also callable directly in tests). */
  async tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const run = this.runTick();
    this.ticking = run;
    try {
      await run;
    } finally {
      if (this.ticking === run) this.ticking = undefined;
    }
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.stateFile, "utf8")) as PersistedCloudSyncState;
      for (const [k, v] of Object.entries(raw.pushedVersions ?? {})) {
        this.pushedVersions.set(k, v);
      }
      for (const [k, v] of Object.entries(raw.reportedStates ?? {})) {
        this.reportedStates.set(k, v);
      }
      if (typeof raw.updatedSince === "string") {
        this.updatedSince = raw.updatedSince;
      }
    } catch {
      // Fresh state
    }
  }

  private async saveState(): Promise<void> {
    try {
      await mkdir(path.dirname(this.stateFile), { recursive: true });
      const data: PersistedCloudSyncState = {
        pushedVersions: Object.fromEntries(this.pushedVersions),
        reportedStates: Object.fromEntries(this.reportedStates),
        ...(this.updatedSince ? { updatedSince: this.updatedSince } : {}),
      };
      await writeFile(this.stateFile, JSON.stringify(data, null, 2));
    } catch {
      // Non-fatal persistence failure
    }
  }

  private async runTick(): Promise<void> {
    await this.loadState();
    const signal = this.controller?.signal ?? new AbortController().signal;
    if (signal.aborted) return;

    const cloud = getCloudPublisherConfig(this.deps);
    const lockSet = this.deps.inFlightSchedules;

    if (cloud) {
      // Mode A: Push pending schedules to Cloud Publisher + sync outcomes back
      const pending = await this.deps.api.client.workerSchedules.due({ limit: 100 }, { signal });
      let dirty = false;

      for (const sched of pending.items) {
        if (signal.aborted) return;
        if (lockSet?.has(sched.id)) continue;
        const versionKey = `${sched.versionId}:${sched.scheduledAt}:${sched.contentHash}`;
        if (this.pushedVersions.get(sched.id) === versionKey) continue;

        lockSet?.add(sched.id);
        try {
          await pushScheduleToCloudPublisher({
            scheduleId: sched.id,
            cloud,
            deps: this.deps,
            signal,
          });
          this.pushedVersions.set(sched.id, versionKey);
          dirty = true;
        } catch (err) {
          this.deps.logger.warn(
            `could not push schedule ${sched.id} to cloud publisher: ${(err as Error).message}`,
          );
        } finally {
          lockSet?.delete(sched.id);
        }
      }

      const synced = await syncCloudPublisherOutcomes({
        cloud,
        deps: this.deps,
        updatedSince: this.updatedSince,
        reportedStates: this.reportedStates,
        signal,
      });
      if (synced.synced > 0 || synced.latestUpdatedAt !== this.updatedSince) {
        this.updatedSince = synced.latestUpdatedAt;
        dirty = true;
      }
      if (dirty) await this.saveState();
      return;
    }

    // Mode B: Local direct publishing for schedules with `scheduledAt <= now`
    const nowIso = (this.deps.now ?? (() => new Date()))().toISOString();
    const due = await this.deps.api.client.workerSchedules.due(
      { before: nowIso, limit: 50 },
      { signal },
    );

    for (const sched of due.items) {
      if (signal.aborted) return;
      if (Date.parse(sched.scheduledAt) > Date.parse(nowIso)) continue;
      if (lockSet?.has(sched.id)) continue;

      lockSet?.add(sched.id);
      try {
        await publishScheduleLocally({
          scheduleId: sched.id,
          attempt: 1,
          deps: this.deps,
          signal,
        });
      } catch (err) {
        this.deps.logger.warn(
          `local publish of due schedule ${sched.id} failed: ${(err as Error).message}`,
        );
      } finally {
        lockSet?.delete(sched.id);
      }
    }
  }
}
