// Every job live (GET /api/jobs/stream): the background jobs pane and worker presence (usage
// ring, Mac status). Notifications for finished work come from the main process (A8), which
// follows the same stream also while the window is closed.
import type {
  ApiClient,
  ApprovalRequest,
  Job,
  JobStreamMessage,
  JobWatch,
  JobWatchStatus,
  WorkerPresence,
} from "@studio/contract";
import { describeError } from "../lib/api.ts";

export interface JobsSnapshot {
  jobs: Job[];
  presence: WorkerPresence | null;
  status: JobWatchStatus;
}

export class JobsController {
  private snapshotValue: JobsSnapshot = { jobs: [], presence: null, status: "connecting" };
  private listeners = new Set<() => void>();
  private watch: JobWatch | undefined;
  private approvalListeners = new Set<(approval: ApprovalRequest) => void>();
  /** Called for every job that changed (after the first snapshot). */
  onJobChange: ((job: Job, previous: Job | undefined) => void) | undefined;

  constructor(private readonly client: ApiClient) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): JobsSnapshot => this.snapshotValue;

  /** `approval.updated`: an approval request was created or decided (any brand). */
  onApproval = (listener: (approval: ApprovalRequest) => void): (() => void) => {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  };

  private set(next: Partial<JobsSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...next };
    for (const l of this.listeners) l();
  }

  start(): void {
    if (this.watch) return;
    this.watch = this.client.jobs.watch(
      {},
      {
        onMessage: (message) => this.apply(message),
        onStatus: (status) => this.set({ status }),
      },
    );
  }

  stop(): void {
    this.watch?.close();
    this.watch = undefined;
  }

  apply(message: JobStreamMessage): void {
    switch (message.type) {
      case "jobs.snapshot":
        this.set({ jobs: message.jobs, presence: message.presence });
        return;
      case "job.updated": {
        const jobs = this.snapshotValue.jobs;
        const previous = jobs.find((j) => j.id === message.job.id);
        const next = previous
          ? jobs.map((j) => (j.id === message.job.id ? message.job : j))
          : [message.job, ...jobs];
        this.set({ jobs: next.slice(0, 200) });
        this.onJobChange?.(message.job, previous);
        return;
      }
      case "presence":
        this.set({ presence: message.presence });
        return;
      case "approval.updated":
        for (const l of this.approvalListeners) l(message.approval);
        return;
      default:
        return;
    }
  }

  /** Called with the reason when a cancel (the stop button) failed. */
  onCancelError: ((message: string) => void) | undefined;

  /** Stop a job. Never rejects: a failure goes to `onCancelError` (a toast). */
  async cancel(id: string): Promise<boolean> {
    try {
      const job = await this.client.jobs.cancel(id);
      this.apply({ type: "job.updated", job });
      return true;
    } catch (error) {
      this.onCancelError?.(`İş durdurulamadı: ${describeError(error)}`);
      return false;
    }
  }
}
