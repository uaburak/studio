/**
 * Background schedule loop (`PLAN.md` §4 & §8, P3).
 *
 * - Cloud mode (a cloud publisher is configured in Ayarlar → Yayın, or in the worker's
 *   environment): every pending schedule is pushed to the cloud publisher as an order
 *   (media uploaded, token sealed there) so it publishes while the Mac is off; moved
 *   schedules are pushed again, cancelled ones are cancelled there, and order status
 *   (`publishing` / `published` with permalink / `failed` with reason) is pulled back
 *   into the local schedules and publish logs. Each round is reported to the API.
 * - Local mode: due schedules (`scheduledAt <= now`) are published by this worker
 *   with `@studio/publishers`; the Mac must be on at that time.
 *
 * Timing: a light control check every `controlIntervalMs` (5 s) reads the config from
 * the local API; a full round runs every `intervalMs` (30 s by default) and at once
 * when the app asks for it (`POST /api/publishing/sync`, sent on app focus).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { cloudState, pushKey, resolveCloudPublisherConfig } from "./cloud-state.ts";
import {
  cancelCloudOrders,
  publishScheduleLocally,
  pushScheduleToCloudPublisher,
  reportDelivery,
  type SchedulePublishDeps,
  syncCloudPublisherOutcomes,
} from "./handler.ts";

interface PersistedCloudSyncState {
  pushedVersions: Record<string, string>;
  reportedStates: Record<string, string>;
  updatedSince?: string;
}

export interface SchedulePollerOptions {
  /** How often the cheap config check runs (default 5 s). */
  controlIntervalMs?: number;
}

export class SchedulePoller {
  private timer: ReturnType<typeof setInterval> | undefined;
  private controller: AbortController | undefined;
  private ticking: Promise<void> | undefined;
  private loaded = false;
  private readonly reportedStates = new Map<string, string>();
  private updatedSince: string | undefined;
  private readonly stateFile: string;
  private lastTickAt = 0;
  private lastSyncRequest: string | null = null;
  private intervalMs = 0;

  constructor(
    private readonly deps: SchedulePublishDeps,
    private readonly options: SchedulePollerOptions = {},
  ) {
    this.stateFile = path.join(deps.stateDir, "schedule-sync.json");
  }

  private get pushedVersions(): Map<string, string> {
    return cloudState(this.deps).pushed;
  }

  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.intervalMs = intervalMs;
    this.controller = new AbortController();
    const control = Math.min(intervalMs, this.options.controlIntervalMs ?? 5_000);
    this.timer = setInterval(() => {
      void this.control().catch((err: unknown) => {
        this.deps.logger.warn(`schedule poller tick failed: ${(err as Error).message}`);
      });
    }, control);
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

  /** Run a round when it is time, or when the app asked for a sync since the last one. */
  private async control(): Promise<void> {
    if (this.ticking) return;
    const signal = this.controller?.signal;
    const { syncRequestedAt } = await resolveCloudPublisherConfig(this.deps, {
      maxAgeMs: 0,
      ...(signal ? { signal } : {}),
    });
    const requested = syncRequestedAt !== null && syncRequestedAt !== this.lastSyncRequest;
    if (requested || Date.now() - this.lastTickAt >= this.intervalMs) {
      this.lastSyncRequest = syncRequestedAt;
      await this.tick();
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
      this.lastTickAt = Date.now();
      if (this.ticking === run) this.ticking = undefined;
    }
  }

  private async loadState(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await readFile(this.stateFile, "utf8")) as PersistedCloudSyncState;
      for (const [k, v] of Object.entries(raw.pushedVersions ?? {})) {
        if (!this.pushedVersions.has(k)) this.pushedVersions.set(k, v);
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

  private async report(ok: boolean, error: string | null, signal: AbortSignal): Promise<void> {
    try {
      await this.deps.api.client.workerPublishing.report({ ok, error }, { signal });
    } catch {
      // Older API: nothing to report to.
    }
  }

  private async runTick(): Promise<void> {
    await this.loadState();
    const signal = this.controller?.signal ?? new AbortController().signal;
    if (signal.aborted) return;

    const { cloud } = await resolveCloudPublisherConfig(this.deps, { signal });
    const lockSet = this.deps.inFlightSchedules;

    if (cloud) {
      const before = JSON.stringify([...this.pushedVersions]);
      const errors: string[] = [];

      // 1. Push new and moved pending schedules.
      const pending = await this.deps.api.client.workerSchedules.due({ limit: 100 }, { signal });
      for (const sched of pending.items) {
        if (signal.aborted) return;
        if (lockSet?.has(sched.id)) continue;
        if (this.pushedVersions.get(sched.id) === pushKey(sched)) {
          // Already there; make sure the calendar knows (e.g. after an app update).
          if (!sched.cloudSyncedAt || sched.delivery !== "cloud") {
            await reportDelivery(
              this.deps,
              sched.id,
              { delivery: "cloud", cloudSyncedAt: new Date().toISOString(), error: null },
              signal,
            );
          }
          continue;
        }
        lockSet?.add(sched.id);
        try {
          await pushScheduleToCloudPublisher({
            scheduleId: sched.id,
            cloud,
            deps: this.deps,
            signal,
          });
        } catch (err) {
          const message = (err as Error).message;
          errors.push(message);
          this.deps.logger.warn(
            `could not push schedule ${sched.id} to cloud publisher: ${message}`,
          );
        } finally {
          lockSet?.delete(sched.id);
        }
      }

      // 2. Cancel orders whose schedules were cancelled here.
      try {
        await cancelCloudOrders({ cloud, deps: this.deps, signal });
      } catch (err) {
        errors.push((err as Error).message);
      }

      // 3. Pull order status back.
      let syncError: string | null = null;
      try {
        const synced = await syncCloudPublisherOutcomes({
          cloud,
          deps: this.deps,
          updatedSince: this.updatedSince,
          reportedStates: this.reportedStates,
          signal,
        });
        if (synced.synced > 0 || synced.latestUpdatedAt !== this.updatedSince) {
          this.updatedSince = synced.latestUpdatedAt;
        }
      } catch (err) {
        syncError = (err as Error).message;
      }
      if (syncError) errors.unshift(syncError);
      await this.report(errors.length === 0, errors[0] ?? null, signal);
      if (before !== JSON.stringify([...this.pushedVersions]) || this.updatedSince) {
        await this.saveState();
      }
      return;
    }

    // Local mode: publish schedules whose time has come.
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
