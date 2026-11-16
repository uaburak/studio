import { DurableObject } from "cloudflare:workers";
import {
  type DemoEchoPayload,
  decodeMessage,
  encodeMessage,
  type Job,
  type JobProgressMessage,
  type JobResultMessage,
  PROTOCOL_VERSION,
  type ProtocolMessage,
} from "@studio/contract";

/** Per-socket state that survives hibernation. */
interface SocketAttachment {
  workerId?: string;
  capabilities?: string[];
}

const JOB_PREFIX = "job:";

/**
 * Hub — one Durable Object instance ("main") that Mac workers connect to over
 * WebSocket (Hibernation API). Skeleton scope:
 * - answers protocol pings,
 * - tracks connected workers via `hello`,
 * - dispatches the demo job and records progress/results.
 * The real job queue (F1-6) will replace the in-DO job storage used here.
 */
export class Hub extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({} satisfies SocketAttachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const decoded = decodeMessage(raw);
    if (!decoded.ok) {
      console.warn("hub: dropped malformed frame:", decoded.error);
      return;
    }
    await this.handle(ws, decoded.message);
  }

  override async webSocketClose(): Promise<void> {
    // compatibility_date >= 2026-04-07 auto-replies to Close frames; nothing to do.
  }

  // --- RPC (called from the Worker) ---------------------------------------

  /** Number of workers that completed the `hello` handshake. */
  async connectedWorkers(): Promise<number> {
    return this.workerSockets().length;
  }

  async enqueueDemoJob(payload: DemoEchoPayload): Promise<Job> {
    const now = new Date().toISOString();
    const job: Job = {
      id: crypto.randomUUID(),
      type: "demo.echo",
      status: "queued",
      payload,
      createdAt: now,
      updatedAt: now,
    };
    await this.saveJob(job);
    return (await this.tryDispatch(job)) ?? job;
  }

  async getJob(id: string): Promise<Job | null> {
    return (await this.ctx.storage.get<Job>(JOB_PREFIX + id)) ?? null;
  }

  // --- internals -------------------------------------------------------------

  private async handle(ws: WebSocket, message: ProtocolMessage): Promise<void> {
    switch (message.type) {
      case "ping":
        ws.send(encodeMessage({ type: "pong", ts: message.ts }));
        return;
      case "pong":
        return;
      case "hello": {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          ws.close(4000, `unsupported protocol version ${message.protocolVersion}`);
          return;
        }
        ws.serializeAttachment({
          workerId: message.workerId,
          capabilities: message.capabilities,
        } satisfies SocketAttachment);
        await this.dispatchQueued();
        return;
      }
      case "job.progress":
        await this.applyProgress(message);
        return;
      case "job.result":
        await this.applyResult(message);
        return;
      case "job.dispatch":
        // Hub -> worker only; a worker must never send this.
        console.warn("hub: ignoring job.dispatch sent by a client");
        return;
    }
  }

  private workerSockets(): Array<{ ws: WebSocket; att: SocketAttachment }> {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, att: (ws.deserializeAttachment() ?? {}) as SocketAttachment }))
      .filter(({ att }) => att.workerId !== undefined);
  }

  private async tryDispatch(job: Job): Promise<Job | null> {
    const target = this.workerSockets().find(({ att }) => att.capabilities?.includes(job.type));
    if (!target) return null;
    const now = new Date().toISOString();
    const running: Job = { ...job, status: "running", startedAt: now, updatedAt: now };
    await this.saveJob(running);
    target.ws.send(encodeMessage({ type: "job.dispatch", job: running }));
    return running;
  }

  private async dispatchQueued(): Promise<void> {
    const jobs = await this.ctx.storage.list<Job>({ prefix: JOB_PREFIX });
    for (const job of jobs.values()) {
      if (job.status === "queued") await this.tryDispatch(job);
    }
  }

  private async applyProgress(message: JobProgressMessage): Promise<void> {
    const job = await this.getJob(message.jobId);
    if (job?.status !== "running") return;
    await this.saveJob({
      ...job,
      progress: message.progress,
      updatedAt: new Date().toISOString(),
    });
  }

  private async applyResult(message: JobResultMessage): Promise<void> {
    const job = await this.getJob(message.jobId);
    if (!job) return;
    const now = new Date().toISOString();
    const done: Job = {
      ...job,
      status: message.status,
      updatedAt: now,
      finishedAt: now,
      ...(message.status === "succeeded" ? { progress: 1 } : {}),
      ...(message.output !== undefined ? { output: message.output } : {}),
      ...(message.error !== undefined ? { error: message.error } : {}),
    };
    await this.saveJob(done);
  }

  private async saveJob(job: Job): Promise<void> {
    await this.ctx.storage.put(JOB_PREFIX + job.id, job);
  }
}
