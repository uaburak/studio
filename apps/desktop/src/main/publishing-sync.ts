// "Öne gelince bulut eşitleme" (the AppKit app's PublishingModel.appBecameActive): when Studio
// comes to the front, the worker is asked to push / pull cloud publishing orders right away
// (`POST /api/publishing/sync`) instead of waiting for its next round. At most once per
// `minIntervalMs` (switching windows back and forth asks once), never while the host is down;
// a failure is only logged (the worker's own round still runs).
export const OWNER_HEADER = "X-Studio-Owner";

export interface PublishingSyncDeps {
  target(): { port: number; ownerSecret: string } | null;
  fetch?: typeof fetch;
  now?: () => number;
  minIntervalMs?: number;
  log?(message: string): void;
}

export class PublishingSync {
  private last = Number.NEGATIVE_INFINITY;
  private running: Promise<boolean> | null = null;

  constructor(private readonly deps: PublishingSyncDeps) {}

  /** The app came to the front. Resolves true when a sync was asked for. */
  focused(): Promise<boolean> {
    const now = (this.deps.now ?? Date.now)();
    if (this.running) return this.running;
    if (now - this.last < (this.deps.minIntervalMs ?? 30_000)) return Promise.resolve(false);
    const target = this.deps.target();
    if (!target) return Promise.resolve(false);
    this.last = now;
    const fetchFn = this.deps.fetch ?? fetch;
    this.running = fetchFn(`http://127.0.0.1:${target.port}/api/publishing/sync`, {
      method: "POST",
      headers: { accept: "application/json", [OWNER_HEADER]: target.ownerSecret },
      signal: AbortSignal.timeout(5_000),
    })
      .then((res) => {
        if (!res.ok) this.deps.log?.(`publishing sync: HTTP ${res.status}`);
        return res.ok;
      })
      .catch((error: unknown) => {
        this.deps.log?.(`publishing sync: ${(error as Error).message}`);
        return false;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
