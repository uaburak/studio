/**
 * Hub timing. All deadlines are absolute ms timestamps stored in D1
 * (`jobs.lease_expires_at`), so they survive Durable Object restarts; the DO
 * alarm only decides *when* the Hub looks at them again.
 */
export const HUB_TIMING = {
  /** A dispatched job must be acknowledged within this time, else it is requeued (no attempt consumed). */
  ackTimeoutMs: 20_000,
  /** Lease granted by ack / progress / heartbeat. The worker heartbeats every 15 s by default. */
  leaseTtlMs: 60_000,
  /** After a cancel request the worker has this long to confirm before the Hub marks the job cancelled. */
  cancelGraceMs: 30_000,
  /** A worker socket silent for this long (pings included) is treated as gone and closed. */
  staleWorkerMs: 90_000,
  /** While a worker is connected the Hub re-checks the queue at least this often (safety net). */
  sweepIntervalMs: 60_000,
  /** lastSeen is written to DO storage at most this often per socket. */
  presencePersistMs: 30_000,
} as const;

/** Jobs sent in a `jobs.snapshot`. */
export const SNAPSHOT_LIMIT = 50;

/** WebSocket close codes the Hub uses (4000-4999 are application codes). */
export const CLOSE = {
  unsupportedProtocol: 4000,
  superseded: 4002,
  stale: 4003,
} as const;
