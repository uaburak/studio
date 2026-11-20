// The Mac app's canvas runner on the hub (S1): a worker connection of its own that announces only
// the canvas job types (`canvas.read`, `canvas.apply`, `canvas.create`) — the hub gives it those jobs and nothing
// else, and does not count it as "the Mac worker" (presence `online`, Claude / Gemini commands).
// The main process holds the connection and the worker token; each job runs in the hidden runner
// page (runner-window.ts) and its result goes back as the worker protocol says: ack, progress and
// heartbeats while it runs, the result kept until the hub acknowledges it (resent after a
// reconnect), a cancel aborts it. One job at a time.
import {
  CANVAS_JOB_TYPES,
  decodeMessage,
  encodeMessage,
  type Job,
  type JobResultMessage,
  PROTOCOL_VERSION,
  type ProtocolMessage,
  type WorkerToHubMessage,
} from "@studio/contract";

export interface HubSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface HubSocketEvents {
  onOpen(): void;
  onMessage(data: unknown): void;
  onClose(code: number, reason: string): void;
  onError(error: unknown): void;
}

export type HubSocketFactory = (url: string, token: string, events: HubSocketEvents) => HubSocket;

export interface CanvasJobContext {
  signal: AbortSignal;
  progress(value: number, message?: string): void;
}

/** Where jobs run (the hidden page; a fake in tests). */
export interface CanvasJobRunner {
  run(job: Job, ctx: CanvasJobContext): Promise<Record<string, unknown>>;
}

export interface HubTarget {
  url: string;
  token: string;
}

export interface CanvasExecutorOptions {
  workerId: string;
  version: string;
  /** The hub's WebSocket URL and the worker token; null while the host is not up. */
  target(): HubTarget | null;
  socket: HubSocketFactory;
  runner: CanvasJobRunner;
  /** Lease heartbeat while a job runs (and resend of unacknowledged results). */
  heartbeatMs?: number;
  /** Keepalive ping (the hub closes sockets silent for 90 s). */
  pingMs?: number;
  /** Wait before reconnecting after `failures` failures in a row. */
  retryMs?: (failures: number) => number;
  log?: (message: string) => void;
}

interface Active {
  job: Job;
  attempt: number | undefined;
  controller: AbortController;
  /** Why it was aborted: a cancel from the hub, or the app stopping (handed back). */
  reason: "cancel" | "stop" | null;
}

const defaultRetry = (failures: number) => Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));

/** The hub's WebSocket from the main process (Node's client, the token as a header). */
export const nodeHubSocket: HubSocketFactory = (url, token, events) => {
  const NodeWebSocket = WebSocket as unknown as new (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => WebSocket;
  const ws = new NodeWebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  ws.addEventListener("open", () => events.onOpen());
  ws.addEventListener("message", (event) => events.onMessage(event.data));
  ws.addEventListener("close", (event) => events.onClose(event.code, event.reason));
  ws.addEventListener("error", (event) => events.onError(event));
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
  };
};

export class CanvasExecutor {
  private socket: HubSocket | null = null;
  private open = false;
  private connectedTo: string | null = null;
  private generation = 0;
  private failures = 0;
  private stopped = true;
  private active: Active | null = null;
  /** Results the hub has not acknowledged yet (resent after a reconnect). */
  private readonly results = new Map<string, JobResultMessage>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private beatTimer: ReturnType<typeof setInterval> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly o: CanvasExecutorOptions) {}

  get connected(): boolean {
    return this.open;
  }

  get running(): string | null {
    return this.active?.job.id ?? null;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.beatTimer = setInterval(() => this.beat(), this.o.heartbeatMs ?? 15_000);
    this.pingTimer = setInterval(
      () => this.send({ type: "ping", ts: Date.now() }),
      this.o.pingMs ?? 30_000,
    );
    this.connect();
  }

  /** The host changed (started, stopped, another port): connect, reconnect or drop. */
  refresh(): void {
    if (this.stopped) return;
    const target = this.o.target();
    if (!target) {
      if (this.socket) this.drop("host stopped");
      return;
    }
    if (this.socket && this.connectedTo === target.url) return;
    if (this.socket) this.drop("host moved");
    this.connect();
  }

  /** The app quits: a running job is handed back (`job.release`), the socket closed. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.beatTimer);
    clearInterval(this.pingTimer);
    const active = this.active;
    if (active) {
      active.reason = "stop";
      active.controller.abort();
      this.send({
        type: "job.release",
        jobId: active.job.id,
        attempt: active.attempt,
        reason: "app quit",
      });
    }
    this.drop("app quit");
  }

  private log(message: string): void {
    this.o.log?.(`canvas runner: ${message}`);
  }

  private connect(): void {
    clearTimeout(this.retryTimer);
    if (this.stopped || this.socket) return;
    const target = this.o.target();
    if (!target) return;
    const generation = ++this.generation;
    this.connectedTo = target.url;
    const mine = () => generation === this.generation;
    try {
      this.socket = this.o.socket(target.url, target.token, {
        onOpen: () => {
          if (!mine()) return;
          this.open = true;
          this.failures = 0;
          this.hello();
        },
        onMessage: (data) => {
          if (mine()) this.receive(data);
        },
        onClose: (code, reason) => {
          if (!mine()) return;
          this.log(`hub closed (${code} ${reason})`);
          this.lost();
        },
        onError: () => {
          if (mine()) this.log("hub socket error");
        },
      });
    } catch (e) {
      this.log(`cannot connect: ${e instanceof Error ? e.message : String(e)}`);
      this.lost();
    }
  }

  private drop(reason: string): void {
    this.generation++;
    const socket = this.socket;
    this.socket = null;
    this.open = false;
    this.connectedTo = null;
    try {
      socket?.close(1000, reason);
    } catch {
      // already closed
    }
  }

  private lost(): void {
    this.generation++;
    this.socket = null;
    this.open = false;
    this.connectedTo = null;
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => this.connect(),
      (this.o.retryMs ?? defaultRetry)(++this.failures),
    );
  }

  private send(message: WorkerToHubMessage): boolean {
    if (!this.socket || !this.open) return false;
    try {
      this.socket.send(encodeMessage(message));
      return true;
    } catch {
      return false;
    }
  }

  private hello(): void {
    const held = [...(this.active ? [this.active.job.id] : []), ...this.results.keys()];
    this.send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      workerId: this.o.workerId,
      capabilities: [...CANVAS_JOB_TYPES],
      workerVersion: this.o.version,
      concurrency: 1,
      activeJobIds: [...new Set(held)].slice(0, 100),
    });
    for (const result of this.results.values()) this.send(result);
  }

  private beat(): void {
    if (this.active) this.send({ type: "job.heartbeat", jobIds: [this.active.job.id] });
    for (const result of this.results.values()) this.send(result);
  }

  private receive(data: unknown): void {
    const decoded = decodeMessage(data);
    if (!decoded.ok) {
      this.log(`dropped a frame: ${decoded.error}`);
      return;
    }
    const message: ProtocolMessage = decoded.message;
    switch (message.type) {
      case "ping":
        this.send({ type: "pong", ts: message.ts });
        return;
      case "job.dispatch":
        this.dispatch(message.job, message.attempt);
        return;
      case "job.cancel":
        if (this.active?.job.id === message.jobId) {
          this.active.reason = "cancel";
          this.active.controller.abort();
        }
        return;
      case "job.result.ack":
        this.results.delete(message.jobId);
        return;
      default:
        // pong, worker.command (Claude / Gemini are the Mac worker's): nothing to do here.
        return;
    }
  }

  private dispatch(job: Job, attempt: number | undefined): void {
    if (this.active?.job.id === job.id) return;
    if (this.results.has(job.id)) {
      // Finished already (the ack got lost): the result again.
      const result = this.results.get(job.id);
      if (result) this.send(result);
      return;
    }
    if (this.active || !(CANVAS_JOB_TYPES as readonly string[]).includes(job.type)) {
      this.send({ type: "job.release", jobId: job.id, attempt, reason: "busy" });
      return;
    }
    this.send({ type: "job.ack", jobId: job.id, attempt });
    const active: Active = { job, attempt, controller: new AbortController(), reason: null };
    this.active = active;
    void this.o.runner
      .run(job, {
        signal: active.controller.signal,
        progress: (value, message) =>
          this.send({
            type: "job.progress",
            jobId: job.id,
            progress: Math.max(0, Math.min(1, value)),
            ...(message ? { message: message.slice(0, 2_000) } : {}),
            attempt,
          }),
      })
      .then(
        (output) => this.finish(active, { status: "succeeded", output }),
        (error: unknown) =>
          this.finish(active, {
            status: "failed",
            error: (error instanceof Error ? error.message : String(error)).slice(0, 10_000),
          }),
      );
  }

  private finish(
    active: Active,
    end:
      | { status: "succeeded"; output: Record<string, unknown> }
      | { status: "failed"; error: string },
  ): void {
    if (this.active === active) this.active = null;
    // Handed back on quit: the hub runs it again later.
    if (active.reason === "stop") return;
    const result: JobResultMessage =
      active.reason === "cancel"
        ? { type: "job.result", jobId: active.job.id, status: "cancelled", attempt: active.attempt }
        : end.status === "succeeded"
          ? {
              type: "job.result",
              jobId: active.job.id,
              status: "succeeded",
              output: end.output,
              attempt: active.attempt,
            }
          : {
              type: "job.result",
              jobId: active.job.id,
              status: "failed",
              error: end.error,
              attempt: active.attempt,
            };
    this.results.set(active.job.id, result);
    this.send(result);
  }
}
