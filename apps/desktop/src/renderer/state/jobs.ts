// Every job live (GET /api/jobs/stream): the background jobs pane, worker presence (usage ring,
// Mac status) and notices when long work finishes.
import {
  type ApiClient,
  isTerminalJobStatus,
  type Job,
  type JobStreamMessage,
  type JobWatch,
  type JobWatchStatus,
  type WorkerPresence,
} from "@studio/contract";

export interface JobsSnapshot {
  jobs: Job[];
  presence: WorkerPresence | null;
  status: JobWatchStatus;
}

export interface JobNotice {
  id: string;
  title: string;
  body: string;
  /** Renderer route opened by a click ("c:<conversationId>"). */
  route?: string;
}

const NOTICE_TYPES = new Set([
  "content.generate",
  "content.render",
  "brand.analyze",
  "brand.skill_draft",
  "image.generate",
  "schedule.publish",
]);

/** The notice for a job that just finished (null: not worth a notification). */
export function finishedNotice(job: Job, title: string): JobNotice | null {
  if (job.type === "chat.turn") {
    if (job.status !== "succeeded") return null;
    const conversationId = (job.payload as { conversationId?: unknown }).conversationId;
    return {
      id: `reply-${job.id}`,
      title: "Yanıt hazır",
      body: title,
      ...(typeof conversationId === "string" ? { route: `c:${conversationId}` } : {}),
    };
  }
  if (!NOTICE_TYPES.has(job.type) || !isTerminalJobStatus(job.status)) return null;
  if (job.status === "cancelled") return null;
  const ok = job.status === "succeeded";
  return {
    id: `job-${job.id}-${job.status}`,
    title: ok ? `${title} bitti` : `${title} başarısız`,
    body: ok ? "Sonuç Studio'da hazır." : (job.error ?? "Ayrıntılar Arka plan işleri'nde."),
  };
}

export class JobsController {
  private snapshotValue: JobsSnapshot = { jobs: [], presence: null, status: "connecting" };
  private listeners = new Set<() => void>();
  private watch: JobWatch | undefined;
  /** Called for every job that changed (after the first snapshot). */
  onJobChange: ((job: Job, previous: Job | undefined) => void) | undefined;

  constructor(private readonly client: ApiClient) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): JobsSnapshot => this.snapshotValue;

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
      default:
        return;
    }
  }

  async cancel(id: string): Promise<void> {
    const job = await this.client.jobs.cancel(id);
    this.apply({ type: "job.updated", job });
  }
}
