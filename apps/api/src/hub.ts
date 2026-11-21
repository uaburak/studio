import { DurableObject } from "cloudflare:workers";
import {
  type AiProviderStatus,
  type AiProvidersControl,
  type ApprovalRequest,
  type ClaudeAccount,
  type ClaudeCommand,
  type ClaudeControl,
  CONVERSATION_REPLAY_LIMIT,
  type ConversationStreamMessage,
  decodeMessage,
  type ErrorCode,
  type ErrorIssue,
  encodeConversationStreamMessage,
  encodeJobStreamMessage,
  encodeMessage,
  type GeminiAccount,
  type GeminiCommand,
  type GeminiControl,
  type HubToWorkerMessage,
  isCanvasRunner,
  isTerminalJobStatus,
  type Job,
  type JobResultMessage,
  type JobStreamMessage,
  PROTOCOL_VERSION,
  type ToolStatus,
  type ToolsControl,
  type WorkerCommand,
  type WorkerPresence,
  type WorkerToHubMessage,
  type WorkerUsage,
} from "@studio/contract";
import { conversationSnapshot, eventsAfter, requireConversation } from "./chat/read.ts";
import {
  type ChatCommand,
  type ChatEffects,
  executeChat,
  newEffects,
  onJobChanged,
} from "./chat/service.ts";
import { createDb } from "./db/client.ts";
import { type JobRow, toJob } from "./db/mappers.ts";
import { CLOSE, HUB_TIMING, SNAPSHOT_LIMIT } from "./hub/config.ts";
import { JobStore } from "./hub/store.ts";
import { toProblem } from "./lib/errors.ts";
import { dueEngagementJobs, insertQueuedJob } from "./lib/insights.ts";
import { purgeTrash } from "./lib/purge.ts";

/** Per-socket state; survives hibernation (serializeAttachment, max 2 KB). */
type WorkerAttachment = {
  role: "worker";
  connectedAt: number;
  lastSeenAt: number;
  /** Set by `hello`; a worker socket without it has not identified itself yet. */
  workerId?: string;
  workerVersion?: string;
  capabilities?: string[];
  concurrency?: number;
  draining?: boolean;
  persistedAt?: number;
};
type ClientAttachment = { role: "client"; connectedAt: number };
/** A client following one conversation; `lastSentSeq` is -1 until the snapshot/replay went out. */
type ConversationAttachment = {
  role: "conversation";
  connectedAt: number;
  conversationId: string;
  lastSentSeq: number;
};
type Attachment = WorkerAttachment | ClientAttachment | ConversationAttachment;

interface WorkerSocket {
  ws: WebSocket;
  att: WorkerAttachment & { workerId: string };
}

/** Result of a chat command run inside the Hub (errors travel as data, not as thrown RPC errors). */
export type ChatOutcome =
  | { ok: true; value: unknown }
  | { ok: false; problem: { code: ErrorCode; message: string; issues?: ErrorIssue[] } };

export type CancelJobResult =
  | { ok: true; job: Job }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "terminal"; status: Job["status"] };

const LAST_SEEN_KEY = "presence:lastSeenAt";
/** Latest `worker.usage` report (subscription limits), shown in presence as `usage`. */
const USAGE_KEY = "presence:usage";
/** Latest `worker.claude` report (the Mac's Claude sign-in), shown in presence as `claude`. */
const CLAUDE_KEY = "presence:claude";
/** Latest `worker.gemini` report (the Mac's Gemini readiness), shown in presence as `gemini`. */
const GEMINI_KEY = "presence:gemini";
/** Latest `worker.providers` report (Codex / OpenAI / Antigravity), shown in presence as `providers`. */
const PROVIDERS_KEY = "presence:providers";
/** Latest `worker.tools` report (ffmpeg, Claude Code …), shown in presence as `tools`. */
const TOOLS_KEY = "presence:tools";
const TOOLS_AT_KEY = "presence:toolsAt";
/** When the alarm last looked for due statistics / comment reads (ms), and queued comments. */
const ENGAGEMENT_CHECK_KEY = "engagement:checkedAt";
const COMMENTS_QUEUED_KEY = "engagement:commentsQueuedAt";
const ENGAGEMENT_CHECK_MS = 5 * 60_000;
/** When the trash was last purged (ms); the alarm purges at most once per PURGE_INTERVAL_MS. */
const PURGE_KEY = "purge:lastAt";
const PURGE_INTERVAL_MS = 60 * 60_000;

/**
 * Hub — the job dispatcher (one instance, "main").
 *
 * D1 `jobs` is the source of truth. The Hub never keeps job state in memory:
 * every decision reads D1 and every transition is a conditional update
 * (see hub/store.ts), so eviction or a restart loses nothing. What the Hub
 * adds on top:
 * - WebSockets (Hibernation API) for the Mac worker (`/worker`) and for
 *   clients following jobs live (`/clients`), told apart by tag/attachment;
 * - leases: a running job must be acked / heartbeated; when the lease runs
 *   out the alarm requeues it (or fails it after `max_attempts`);
 * - a serial queue so that messages, RPCs and alarms never interleave their
 *   D1 reads and writes (D1 calls open the input gate, so without this two
 *   events could both see the same `queued` row);
 * - DO storage only for presence: the worker's last-seen time and its latest
 *   usage report.
 *
 * Chat (A2): every conversation / plan mutation runs through `chat()` in the
 * same serial queue (src/chat/service.ts), which writes the change and its
 * sequenced stream events in one D1 batch; the Hub then pushes the new events
 * to the conversation's sockets (`/conversations`), reading them back from D1
 * by seq so delivery is ordered and gap-free even after hibernation.
 */
export class Hub extends DurableObject<Env> {
  private readonly db = createDb(this.env.DB);
  private readonly store = new JobStore(this.db);
  private chain: Promise<unknown> = Promise.resolve();

  // --- HTTP / WebSocket entry ------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const url = new URL(request.url);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    const now = Date.now();

    if (url.pathname === "/worker") {
      // Authentication happened in the Worker route (/api/hub) before we got here.
      this.ctx.acceptWebSocket(server, ["worker"]);
      server.serializeAttachment({
        role: "worker",
        connectedAt: now,
        lastSeenAt: now,
      } satisfies WorkerAttachment);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/clients") {
      const jobId = url.searchParams.get("jobId") ?? undefined;
      const brandId = url.searchParams.get("brandId") ?? undefined;
      const tag = jobId ? `job:${jobId}` : brandId ? `brand:${brandId}` : "all";
      const device = deviceTags(url);
      await this.serial(async () => {
        // Inside the serial queue: no update can slip in between the
        // snapshot query and the socket joining the broadcast set.
        this.ctx.acceptWebSocket(server, ["client", tag, ...device]);
        server.serializeAttachment({ role: "client", connectedAt: now } satisfies ClientAttachment);
        const rows = await this.store.recent(
          { ...(jobId ? { jobId } : {}), ...(brandId ? { brandId } : {}) },
          SNAPSHOT_LIMIT,
        );
        this.sendClient(server, {
          type: "jobs.snapshot",
          jobs: rows.map(toJob),
          presence: await this.computePresence(),
        });
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/conversations") {
      const conversationId = url.searchParams.get("conversationId");
      if (!conversationId) return new Response("conversationId is required", { status: 400 });
      const afterRaw = url.searchParams.get("after");
      const after = afterRaw === null ? undefined : Number(afterRaw);
      // Mark the socket before any await so an early frame is never mistaken for a worker's.
      this.ctx.acceptWebSocket(server, [
        "conversation",
        `conv:${conversationId}`,
        ...deviceTags(url),
      ]);
      server.serializeAttachment({
        role: "conversation",
        connectedAt: now,
        conversationId,
        lastSentSeq: -1,
      } satisfies ConversationAttachment);
      await this.serial(() => this.openConversation(server, conversationId, after));
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("not found", { status: 404 });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const att = attachmentOf(ws);
    const decoded = decodeMessage(raw);
    if (!decoded.ok) {
      console.warn(`hub: dropped malformed frame from ${att.role}:`, decoded.error);
      return;
    }
    const message = decoded.message;
    if (att.role === "client") {
      // Clients are read-only: they may only ping. Never treat them as workers.
      if (message.type === "ping") this.sendClient(ws, { type: "pong", ts: message.ts });
      return;
    }
    if (att.role === "conversation") {
      if (message.type === "ping") this.sendConversation(ws, { type: "pong", ts: message.ts });
      return;
    }
    await this.serial(() => this.onWorkerMessage(ws, att, message as WorkerToHubMessage));
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.onSocketGone(ws);
  }

  override async alarm(): Promise<void> {
    await this.serial(async () => {
      try {
        await this.sweep(Date.now());
        await this.dispatchQueued();
        await this.purgeIfDue(Date.now());
        await this.queueEngagementIfDue(Date.now());
      } finally {
        await this.scheduleAlarm();
      }
    });
  }

  // --- RPC (called from the Worker) ---------------------------------------------

  /**
   * A paired device was revoked: close its job and conversation streams, which authenticated
   * only when they were opened (G8). Returns how many were closed.
   */
  async closeDeviceSockets(deviceId: string): Promise<number> {
    const sockets = this.ctx.getWebSockets(`device:${deviceId}`);
    for (const ws of sockets) {
      try {
        ws.close(CLOSE.revoked, "device revoked");
      } catch {
        // already closing
      }
    }
    return sockets.length;
  }

  /**
   * An approval request was created or decided: tell the job-stream clients watching its brand
   * or everything (lists showing "Onay bekliyor" refresh).
   */
  async approvalChanged(approval: ApprovalRequest): Promise<void> {
    const targets = new Set<WebSocket>([
      ...this.ctx.getWebSockets(`brand:${approval.brandId}`),
      ...this.ctx.getWebSockets("all"),
    ]);
    if (targets.size === 0) return;
    const frame = encodeJobStreamMessage({ type: "approval.updated", approval });
    for (const ws of targets) trySend(ws, frame);
  }

  /** The API inserted a queued job: tell watchers and try to dispatch it. */
  async jobCreated(jobId: string): Promise<void> {
    await this.serial(() => this.onJobCreated(jobId));
  }

  async cancelJob(jobId: string): Promise<CancelJobResult> {
    return this.serial(() => this.cancelJobNow(jobId));
  }

  /**
   * Run one chat command (see ChatCommand) in the serial queue, then push its
   * stream events and dispatch / cancel the jobs it created or stopped.
   */
  async chat(command: ChatCommand): Promise<ChatOutcome> {
    return this.serial(async (): Promise<ChatOutcome> => {
      const effects = newEffects();
      let outcome: ChatOutcome;
      try {
        outcome = { ok: true, value: await executeChat(this.db, command, effects) };
      } catch (error) {
        const problem = toProblem(error);
        if (problem.code === "internal_error") console.error("hub: chat command failed", error);
        outcome = {
          ok: false,
          problem: {
            code: problem.code,
            message: problem.message,
            ...(problem.issues ? { issues: problem.issues } : {}),
          },
        };
      }
      // Effects only hold committed changes.
      await this.applyChatEffects(effects);
      return outcome;
    });
  }

  private async onJobCreated(jobId: string): Promise<void> {
    const row = await this.store.get(jobId);
    if (row) await this.publish(row);
    await this.dispatchQueued();
    await this.broadcastPresence();
  }

  private async cancelJobNow(jobId: string): Promise<CancelJobResult> {
    {
      const now = Date.now();
      const row = await this.store.get(jobId);
      if (!row) return { ok: false, reason: "not_found" };
      if (isTerminalJobStatus(row.status))
        return { ok: false, reason: "terminal", status: row.status };

      if (row.status === "queued") {
        const done = await this.store.cancelQueued(jobId, now);
        if (done) {
          await this.publish(done);
          await this.broadcastPresence();
          return { ok: true, job: toJob(done) };
        }
      }

      const graceUntil = now + HUB_TIMING.cancelGraceMs;
      const pending = await this.store.requestCancel(jobId, now, graceUntil);
      if (!pending) {
        const current = await this.store.get(jobId);
        return current
          ? { ok: false, reason: "terminal", status: current.status }
          : { ok: false, reason: "not_found" };
      }
      if (pending.workerId) {
        this.sendToWorker(pending.workerId, {
          type: "job.cancel",
          jobId,
          reason: "cancelled by user",
        });
      }
      await this.ensureAlarmBy(graceUntil);
      await this.publish(pending);
      return { ok: true, job: toJob(pending) };
    }
  }

  async presence(): Promise<WorkerPresence> {
    return this.computePresence();
  }

  /** Number of workers that completed the `hello` handshake. */
  async connectedWorkers(): Promise<number> {
    return this.workerSockets().length;
  }

  /**
   * The Mac's Claude sign-in (A5). With a command, forward it to every
   * connected worker (`worker.command`); they answer with `worker.claude`.
   */
  async claudeControl(command?: ClaudeCommand): Promise<ClaudeControl> {
    return this.serial(async () => {
      const workers = this.macWorkers().filter((w) => !w.att.draining);
      let sent = 0;
      if (command) {
        for (const { ws } of workers) {
          try {
            sendWorker(ws, { type: "worker.command", command });
            sent++;
          } catch {
            // closing
          }
        }
      }
      const account = (await this.ctx.storage.get<ClaudeAccount>(CLAUDE_KEY)) ?? null;
      return { account, online: workers.length > 0, sent };
    });
  }

  /** The Mac's Gemini readiness. With a command, asks connected workers to re-check. */
  async geminiControl(command?: GeminiCommand): Promise<GeminiControl> {
    return this.serial(async () => {
      const workers = this.macWorkers().filter((w) => !w.att.draining);
      let sent = 0;
      if (command) {
        for (const { ws } of workers) {
          try {
            sendWorker(ws, { type: "worker.command", command });
            sent++;
          } catch {
            // closing
          }
        }
      }
      const account = (await this.ctx.storage.get<GeminiAccount>(GEMINI_KEY)) ?? null;
      return { account, online: workers.length > 0, sent };
    });
  }

  /**
   * Codex CLI, OpenAI API and Antigravity CLI as the worker last reported them. With a
   * command (`providers.status`, `codex.login`, `ai.credentials`), forward it to the workers.
   */
  async providersControl(command?: WorkerCommand): Promise<AiProvidersControl> {
    return this.serial(async () => {
      const workers = this.macWorkers().filter((w) => !w.att.draining);
      let sent = 0;
      if (command) {
        for (const { ws } of workers) {
          try {
            sendWorker(ws, { type: "worker.command", command });
            sent++;
          } catch {
            // closing
          }
        }
      }
      const providers = (await this.ctx.storage.get<AiProviderStatus[]>(PROVIDERS_KEY)) ?? [];
      return { providers, online: workers.length > 0, sent };
    });
  }

  /**
   * The tools Studio uses on the Mac as the worker last reported them. With `refresh`, ask the
   * connected workers to look again (`tools.status`).
   */
  async toolsControl(refresh = false): Promise<ToolsControl> {
    return this.serial(async () => {
      const workers = this.macWorkers().filter((w) => !w.att.draining);
      let sent = 0;
      if (refresh) {
        for (const { ws } of workers) {
          try {
            sendWorker(ws, { type: "worker.command", command: "tools.status" });
            sent++;
          } catch {
            // closing
          }
        }
      }
      const [tools, at] = await Promise.all([
        this.ctx.storage.get<ToolStatus[]>(TOOLS_KEY),
        this.ctx.storage.get<number>(TOOLS_AT_KEY),
      ]);
      return {
        tools: tools ?? [],
        online: workers.length > 0,
        reportedAt: at ? new Date(at).toISOString() : null,
        sent,
      };
    });
  }

  // --- worker messages -----------------------------------------------------------

  private async onWorkerMessage(
    ws: WebSocket,
    att: WorkerAttachment,
    message: WorkerToHubMessage,
  ): Promise<void> {
    const now = Date.now();
    att.lastSeenAt = now;
    if (
      att.workerId &&
      !isCanvasRunner(att.capabilities ?? []) &&
      now - (att.persistedAt ?? 0) > HUB_TIMING.presencePersistMs
    ) {
      att.persistedAt = now;
      await this.ctx.storage.put(LAST_SEEN_KEY, now);
    }
    ws.serializeAttachment(att);

    if (message.type === "ping") {
      sendWorker(ws, { type: "pong", ts: message.ts });
      return;
    }
    if (message.type === "pong") return;
    if (message.type === "hello") {
      await this.onHello(ws, att, message);
      return;
    }

    const workerId = att.workerId;
    if (!workerId) {
      console.warn(`hub: ${message.type} before hello; ignored`);
      return;
    }

    switch (message.type) {
      case "job.ack": {
        const row = await this.store.touch(
          message.jobId,
          workerId,
          now,
          now + HUB_TIMING.leaseTtlMs,
        );
        if (!row) {
          await this.stopIfNotOurs(ws, workerId, message.jobId);
          return;
        }
        if (row.cancelRequestedAt) {
          sendWorker(ws, { type: "job.cancel", jobId: row.id, reason: "cancelled by user" });
        }
        await this.publish(row);
        return;
      }
      case "job.progress": {
        if (message.attempt !== undefined) {
          const current = await this.store.get(message.jobId);
          if (current && current.attempts !== message.attempt) return; // stale attempt
        }
        const row = await this.store.touch(
          message.jobId,
          workerId,
          now,
          now + HUB_TIMING.leaseTtlMs,
          { value: message.progress, message: message.message ?? null },
        );
        if (!row) {
          await this.stopIfNotOurs(ws, workerId, message.jobId);
          return;
        }
        await this.publish(row);
        return;
      }
      case "job.heartbeat": {
        const rows = await this.store.getMany(message.jobIds);
        const known = new Map(rows.map((r) => [r.id, r]));
        for (const id of message.jobIds) {
          const row = known.get(id);
          if (row?.status !== "running" || row.workerId !== workerId) {
            sendWorker(ws, {
              type: "job.cancel",
              jobId: id,
              reason: "job is no longer assigned to this worker",
            });
          }
        }
        await this.store.renew(workerId, message.jobIds, now, now + HUB_TIMING.leaseTtlMs);
        return;
      }
      case "job.result":
        await this.onResult(ws, workerId, message, now);
        return;
      case "job.release": {
        const row = await this.store.get(message.jobId);
        if (row?.status !== "running" || row.workerId !== workerId) return;
        const next = row.cancelRequestedAt
          ? await this.store.finish(row.id, now, { status: "cancelled" })
          : await this.store.requeue(row.id, now, { refundAttempt: true });
        if (next) await this.publish(next);
        await this.dispatchQueued();
        await this.broadcastPresence();
        return;
      }
      case "worker.usage": {
        const usage: WorkerUsage = {
          windows: message.windows,
          source: message.source,
          observedAt: message.observedAt,
        };
        await this.ctx.storage.put(USAGE_KEY, usage);
        await this.broadcastPresence();
        return;
      }
      case "worker.claude": {
        await this.ctx.storage.put(CLAUDE_KEY, message.account);
        await this.broadcastPresence();
        return;
      }
      case "worker.gemini": {
        await this.ctx.storage.put(GEMINI_KEY, message.account);
        await this.broadcastPresence();
        return;
      }
      case "worker.providers": {
        await this.ctx.storage.put(PROVIDERS_KEY, message.providers);
        await this.broadcastPresence();
        return;
      }
      case "worker.tools": {
        await this.ctx.storage.put({ [TOOLS_KEY]: message.tools, [TOOLS_AT_KEY]: now });
        await this.broadcastPresence();
        return;
      }
      case "worker.drain":
        att.draining = true;
        ws.serializeAttachment(att);
        await this.broadcastPresence();
        return;
    }
  }

  private async onHello(
    ws: WebSocket,
    att: WorkerAttachment,
    hello: Extract<WorkerToHubMessage, { type: "hello" }>,
  ): Promise<void> {
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      ws.close(CLOSE.unsupportedProtocol, `unsupported protocol version ${hello.protocolVersion}`);
      return;
    }
    // One connection per worker id: a reconnect replaces a half-open socket.
    for (const other of this.workerSockets()) {
      if (other.ws !== ws && other.att.workerId === hello.workerId) {
        // Forget its identity first so nothing is dispatched to it any more.
        other.ws.serializeAttachment({ ...other.att, workerId: undefined });
        try {
          other.ws.close(CLOSE.superseded, "superseded by a newer connection");
        } catch {
          // already closed
        }
      }
    }
    Object.assign(att, {
      workerId: hello.workerId,
      capabilities: hello.capabilities,
      concurrency: hello.concurrency ?? 1,
      draining: false,
      persistedAt: Date.now(),
      ...(hello.workerVersion ? { workerVersion: hello.workerVersion } : {}),
    });
    ws.serializeAttachment(att);
    if (!isCanvasRunner(hello.capabilities))
      await this.ctx.storage.put(LAST_SEEN_KEY, att.lastSeenAt);

    if (hello.activeJobIds) await this.reconcile(ws, hello.workerId, hello.activeJobIds);
    await this.dispatchQueued();
    await this.scheduleAlarm();
    await this.broadcastPresence();
  }

  /**
   * After a (re)connect the worker lists the jobs it still holds. Jobs the
   * Hub assigned to it that are not in the list were lost (worker restart);
   * jobs in the list that the Hub requeued meanwhile are taken back.
   */
  private async reconcile(ws: WebSocket, workerId: string, activeIds: string[]): Promise<void> {
    const now = Date.now();
    const active = new Set(activeIds);
    for (const row of await this.store.runningFor(workerId)) {
      if (!active.has(row.id)) await this.loseJob(row, now, "the worker restarted without it");
    }
    for (const row of await this.store.getMany(activeIds)) {
      if (row.status === "running" && row.workerId === workerId) {
        if (row.cancelRequestedAt) {
          sendWorker(ws, { type: "job.cancel", jobId: row.id, reason: "cancelled by user" });
        } else {
          await this.store.renew(workerId, [row.id], now, now + HUB_TIMING.leaseTtlMs);
        }
      } else if (row.status === "queued" && row.workerId === workerId) {
        const back = await this.store.reclaim(row.id, workerId, now, now + HUB_TIMING.leaseTtlMs);
        if (back) await this.publish(back);
      } else if (!isTerminalJobStatus(row.status)) {
        // Someone else has it now.
        sendWorker(ws, { type: "job.cancel", jobId: row.id, reason: "reassigned" });
      }
      // Terminal jobs: if the worker still has a result it will resend it and
      // get a result.ack; if it is still running it, its next heartbeat gets
      // a job.cancel. Nothing to do here.
    }
  }

  private async onResult(
    ws: WebSocket,
    workerId: string,
    message: JobResultMessage,
    now: number,
  ): Promise<void> {
    const row = await this.store.get(message.jobId);
    // A worker that no longer holds the job may still deliver a finished
    // result (the work is done), but its failure or cancellation must not end
    // the attempt someone else is running now.
    const holder = row?.workerId === workerId;
    if (row && !isTerminalJobStatus(row.status) && (holder || message.status === "succeeded")) {
      if (row.status === "running" && row.workerId && !holder) {
        // A late result from a previous holder wins; stop the current one.
        this.sendToWorker(row.workerId, { type: "job.cancel", jobId: row.id, reason: "finished" });
      }
      const retry =
        message.status === "failed" &&
        message.retryable === true &&
        row.status === "running" &&
        row.attempts < row.maxAttempts &&
        !row.cancelRequestedAt;
      const next = retry
        ? await this.store.requeue(row.id, now, {
            refundAttempt: false,
            error: message.error ?? null,
          })
        : await this.store.finish(row.id, now, resultOf(message));
      if (next) {
        await this.publish(next);
        await this.broadcastPresence();
      }
    }
    // Always acknowledge, also duplicates and unknown jobs, so the worker can
    // drop the result from its outbox. Written to D1 first, acked second:
    // a crash in between only causes a resend, which lands in the branch above.
    sendWorker(ws, { type: "job.result.ack", jobId: message.jobId });
    await this.dispatchQueued();
  }

  /** The worker reports on a job the Hub does not have assigned to it: tell it to stop. */
  private async stopIfNotOurs(ws: WebSocket, workerId: string, jobId: string): Promise<void> {
    const row = await this.store.get(jobId);
    if (row?.status !== "running" || row.workerId !== workerId) {
      sendWorker(ws, {
        type: "job.cancel",
        jobId,
        reason: "job is no longer assigned to this worker",
      });
    }
  }

  // --- queue mechanics --------------------------------------------------------------

  /** Fill every connected worker up to its concurrency, highest priority first, then FIFO. */
  private async dispatchQueued(): Promise<void> {
    for (const { ws, att } of this.workerSockets()) {
      if (att.draining) continue;
      const running = (await this.store.runningFor(att.workerId)).length;
      const free = (att.concurrency ?? 1) - running;
      if (free <= 0) continue;
      for (const row of await this.store.nextQueued(att.capabilities ?? [], free)) {
        const now = Date.now();
        const deadline = now + HUB_TIMING.ackTimeoutMs;
        const claimed = await this.store.claim(row.id, att.workerId, now, deadline);
        if (!claimed) continue;
        try {
          sendWorker(ws, { type: "job.dispatch", job: toJob(claimed), attempt: claimed.attempts });
        } catch (error) {
          console.warn(`hub: dispatch of ${row.id} failed, requeueing`, error);
          const back = await this.store.requeue(row.id, now, { refundAttempt: true });
          if (back) await this.publish(back);
          return;
        }
        await this.ensureAlarmBy(deadline);
        await this.publish(claimed);
      }
    }
  }

  /** Lease expiry and stale sockets. */
  private async sweep(now: number): Promise<void> {
    for (const { ws, att } of this.workerSockets()) {
      if (now - att.lastSeenAt > HUB_TIMING.staleWorkerMs) {
        console.warn(`hub: worker ${att.workerId} silent for too long; closing`);
        if (!isCanvasRunner(att.capabilities ?? []))
          await this.ctx.storage.put(LAST_SEEN_KEY, att.lastSeenAt);
        ws.serializeAttachment({ ...att, workerId: undefined });
        try {
          ws.close(CLOSE.stale, "no message within the stale timeout");
        } catch {
          // already closed
        }
      }
    }
    let changed = false;
    for (const row of await this.store.expiredLeases(now)) {
      await this.loseJob(row, now, "its lease expired");
      changed = true;
    }
    if (changed) await this.broadcastPresence();
  }

  /**
   * Empty the trash of what is older than the retention (P7), at most once an hour. A purge
   * failure is logged and never breaks the sweep.
   */
  /**
   * N15 / N16: while the worker is connected (the alarm runs then), queue `insights.sync` when a
   * post's statistics are due and `comments.sync` every 15 minutes or when replies wait. Looked
   * at every 5 minutes at most; never two of a type.
   */
  private async queueEngagementIfDue(now: number): Promise<void> {
    if (this.workerSockets().length === 0) return;
    const last = (await this.ctx.storage.get<number>(ENGAGEMENT_CHECK_KEY)) ?? 0;
    if (now - last < ENGAGEMENT_CHECK_MS) return;
    await this.ctx.storage.put(ENGAGEMENT_CHECK_KEY, now);
    try {
      const lastComments = (await this.ctx.storage.get<number>(COMMENTS_QUEUED_KEY)) ?? 0;
      const due = await dueEngagementJobs(this.db, new Date(now), lastComments);
      if (due.insights) {
        await this.onJobCreated(await insertQueuedJob(this.db, "insights.sync", {}, new Date(now)));
      }
      if (due.comments) {
        await this.ctx.storage.put(COMMENTS_QUEUED_KEY, now);
        await this.onJobCreated(await insertQueuedJob(this.db, "comments.sync", {}, new Date(now)));
      }
    } catch (error) {
      console.warn("hub: engagement sync check failed", error);
    }
  }

  private async purgeIfDue(now: number): Promise<void> {
    const last = (await this.ctx.storage.get<number>(PURGE_KEY)) ?? 0;
    if (now - last < PURGE_INTERVAL_MS) return;
    await this.ctx.storage.put(PURGE_KEY, now);
    try {
      const result = await purgeTrash(this.env, this.db, new Date(now));
      if (result.contents + result.assets > 0) {
        console.log(
          `hub: purged ${result.contents} post(s), ${result.assets} file(s), ${result.objects} object(s) from the trash`,
        );
      }
    } catch (error) {
      console.warn("hub: trash purge failed", error);
    }
  }

  /** The worker no longer has this running job: cancel, requeue, or give up. */
  private async loseJob(row: JobRow, now: number, why: string): Promise<void> {
    let next: JobRow | undefined;
    if (row.cancelRequestedAt) {
      next = await this.store.finish(row.id, now, { status: "cancelled" });
    } else if (!row.ackedAt) {
      // Never acknowledged: the worker probably never got it. Not an attempt.
      next = await this.store.requeue(row.id, now, { refundAttempt: true });
    } else if (row.attempts >= row.maxAttempts) {
      next = await this.store.finish(row.id, now, {
        status: "failed",
        error: `worker ${row.workerId ?? "?"} lost the job (${why}); gave up after ${row.attempts} attempt(s)`,
      });
    } else {
      next = await this.store.requeue(row.id, now, { refundAttempt: false });
    }
    if (next) await this.publish(next);
  }

  private async scheduleAlarm(): Promise<void> {
    const now = Date.now();
    let next = await this.store.nextLeaseDeadline();
    if (this.workerSockets().length > 0) {
      next = Math.min(next ?? Number.POSITIVE_INFINITY, now + HUB_TIMING.sweepIntervalMs);
    }
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(Math.max(next, now + 50));
    }
  }

  /** Make sure the alarm fires no later than `deadline`. */
  private async ensureAlarmBy(deadline: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > deadline) await this.ctx.storage.setAlarm(deadline);
  }

  // --- presence and fan-out ------------------------------------------------------------

  private async onSocketGone(ws: WebSocket): Promise<void> {
    const att = attachmentOf(ws);
    if (att.role !== "worker" || !att.workerId) return;
    if (!isCanvasRunner(att.capabilities ?? []))
      await this.ctx.storage.put(LAST_SEEN_KEY, att.lastSeenAt);
    // Running jobs keep their lease: a quick reconnect (hello.activeJobIds)
    // keeps them; otherwise the alarm requeues them when the lease runs out.
    await this.serial(async () => {
      await this.broadcastPresence(ws);
      await this.scheduleAlarm();
    });
  }

  private async computePresence(exclude?: WebSocket): Promise<WorkerPresence> {
    // The Mac worker first; the Mac app's canvas runner (canvas jobs only) after it, never what
    // makes the Mac "online" or its last-seen time.
    const all = this.workerSockets().filter(({ ws }) => ws !== exclude);
    const mac = all.filter((w) => !isCanvasRunner(w.att.capabilities ?? []));
    const workers = [...mac, ...all.filter((w) => !mac.includes(w))];
    const [running, queueLength, stored, usage, claude, gemini, providers, tools] =
      await Promise.all([
        this.store.running(),
        this.store.queueLength(),
        this.ctx.storage.get<number>(LAST_SEEN_KEY),
        this.ctx.storage.get<WorkerUsage>(USAGE_KEY),
        this.ctx.storage.get<ClaudeAccount>(CLAUDE_KEY),
        this.ctx.storage.get<GeminiAccount>(GEMINI_KEY),
        this.ctx.storage.get<AiProviderStatus[]>(PROVIDERS_KEY),
        this.ctx.storage.get<ToolStatus[]>(TOOLS_KEY),
      ]);
    const lastSeen = Math.max(stored ?? 0, ...mac.map((w) => w.att.lastSeenAt));
    return {
      online: mac.some((w) => !w.att.draining),
      lastSeenAt: lastSeen > 0 ? new Date(lastSeen).toISOString() : null,
      workers: workers.map(({ att }) => ({
        workerId: att.workerId,
        ...(att.workerVersion ? { workerVersion: att.workerVersion } : {}),
        capabilities: att.capabilities ?? [],
        concurrency: att.concurrency ?? 1,
        connectedAt: new Date(att.connectedAt).toISOString(),
        lastSeenAt: new Date(att.lastSeenAt).toISOString(),
        draining: att.draining ?? false,
      })),
      currentJobs: running.map((r) => {
        const job = toJob(r);
        return {
          id: job.id,
          type: job.type,
          ...(job.brandId ? { brandId: job.brandId } : {}),
          ...(job.workerId ? { workerId: job.workerId } : {}),
          ...(job.progress !== undefined ? { progress: job.progress } : {}),
          ...(job.progressMessage ? { progressMessage: job.progressMessage } : {}),
          ...(job.startedAt ? { startedAt: job.startedAt } : {}),
        };
      }),
      queueLength,
      ...(usage ? { usage } : {}),
      ...(claude ? { claude } : {}),
      ...(gemini ? { gemini } : {}),
      ...(providers ? { providers } : {}),
      ...(tools ? { tools } : {}),
    };
  }

  private async broadcastPresence(exclude?: WebSocket): Promise<void> {
    const clients = this.ctx.getWebSockets("client");
    const followers = this.ctx.getWebSockets("conversation");
    if (clients.length === 0 && followers.length === 0) return;
    const presence = await this.computePresence(exclude);
    for (const ws of clients) this.sendClient(ws, { type: "presence", presence });
    for (const ws of followers) this.sendConversation(ws, { type: "presence", presence });
  }

  /**
   * Send a job change to every client watching that job, its brand, or
   * everything; then let the chat layer react (run / plan item status).
   */
  private async publish(row: JobRow): Promise<void> {
    const targets = new Set<WebSocket>([
      ...this.ctx.getWebSockets(`job:${row.id}`),
      ...(row.brandId ? this.ctx.getWebSockets(`brand:${row.brandId}`) : []),
      ...this.ctx.getWebSockets("all"),
    ]);
    if (targets.size > 0) {
      const frame = encodeJobStreamMessage({ type: "job.updated", job: toJob(row) });
      for (const ws of targets) trySend(ws, frame);
    }
    if (row.type === "chat.turn" || row.type === "content.generate") {
      const effects = newEffects();
      try {
        await onJobChanged(this.db, row, effects);
      } catch (error) {
        // Never let chat bookkeeping break job dispatch.
        console.error(`hub: chat hook for job ${row.id} failed`, error);
      }
      await this.applyChatEffects(effects);
    }
  }

  // --- conversations -----------------------------------------------------------------------

  private async applyChatEffects(effects: ChatEffects): Promise<void> {
    for (const id of effects.conversations) await this.pushConversation(id);
    for (const id of effects.jobsCreated) await this.onJobCreated(id);
    for (const id of effects.jobsToCancel) await this.cancelJobNow(id);
  }

  /** First frames of a conversation socket: replay since `after`, or a snapshot. */
  private async openConversation(
    ws: WebSocket,
    conversationId: string,
    after: number | undefined,
  ): Promise<void> {
    const conv = await requireConversation(this.db, conversationId);
    const presence = await this.computePresence();
    let lastSent: number;
    const canResume =
      after !== undefined &&
      Number.isInteger(after) &&
      after >= 0 &&
      after <= conv.lastSeq &&
      conv.lastSeq - after <= CONVERSATION_REPLAY_LIMIT;
    if (canResume) {
      const events = await eventsAfter(this.db, conversationId, after, CONVERSATION_REPLAY_LIMIT);
      for (const event of events) this.sendConversation(ws, event);
      lastSent = events.at(-1)?.seq ?? after;
      this.sendConversation(ws, {
        type: "conversation.resumed",
        seq: lastSent,
        replayed: events.length,
        presence,
      });
    } else {
      const snapshot = await conversationSnapshot(this.db, conversationId);
      lastSent = snapshot.seq;
      this.sendConversation(ws, { type: "conversation.snapshot", ...snapshot, presence });
    }
    try {
      ws.serializeAttachment({
        role: "conversation",
        connectedAt: Date.now(),
        conversationId,
        lastSentSeq: lastSent,
      } satisfies ConversationAttachment);
    } catch {
      // closed meanwhile
    }
  }

  /** Send each socket of the conversation the stored events it has not seen yet, in seq order. */
  private async pushConversation(conversationId: string): Promise<void> {
    const sockets: Array<{ ws: WebSocket; att: ConversationAttachment }> = [];
    for (const ws of this.ctx.getWebSockets(`conv:${conversationId}`)) {
      const att = attachmentOf(ws);
      if (att.role === "conversation" && att.lastSentSeq >= 0) sockets.push({ ws, att });
    }
    if (sockets.length === 0) return;
    let from = Math.min(...sockets.map((s) => s.att.lastSentSeq));
    for (;;) {
      const events = await eventsAfter(this.db, conversationId, from, CONVERSATION_REPLAY_LIMIT);
      for (const { ws, att } of sockets) {
        const fresh = events.filter((e) => e.seq > att.lastSentSeq);
        const last = fresh.at(-1);
        if (!last) continue;
        for (const event of fresh) this.sendConversation(ws, event);
        att.lastSentSeq = last.seq;
        try {
          ws.serializeAttachment(att);
        } catch {
          // closing
        }
      }
      const tail = events.at(-1);
      if (!tail || events.length < CONVERSATION_REPLAY_LIMIT) break;
      from = tail.seq;
    }
  }

  private sendConversation(ws: WebSocket, message: ConversationStreamMessage): void {
    trySend(ws, encodeConversationStreamMessage(message));
  }

  private sendClient(ws: WebSocket, message: JobStreamMessage): void {
    trySend(ws, encodeJobStreamMessage(message));
  }

  private sendToWorker(workerId: string, message: HubToWorkerMessage): void {
    const target = this.workerSockets().find((w) => w.att.workerId === workerId);
    if (target) trySend(target.ws, encodeMessage(message));
  }

  /** The Mac worker's sockets: every identified worker but the Mac app's canvas runner. */
  private macWorkers(): WorkerSocket[] {
    return this.workerSockets().filter((w) => !isCanvasRunner(w.att.capabilities ?? []));
  }

  /** Identified (post-hello) worker sockets. */
  private workerSockets(): WorkerSocket[] {
    const out: WorkerSocket[] = [];
    for (const ws of this.ctx.getWebSockets("worker")) {
      const att = attachmentOf(ws);
      if (att.role === "worker" && att.workerId) {
        out.push({ ws, att: att as WorkerSocket["att"] });
      }
    }
    return out;
  }

  /** Run `fn` after everything queued before it; failures do not block the queue. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch((error: unknown) => console.error("hub: operation failed", error));
    return run;
  }
}

/** `device:<id>` when a paired device opened the stream (set by the Worker route, not the client). */
function deviceTags(url: URL): string[] {
  const device = url.searchParams.get("device");
  return device ? [`device:${device}`] : [];
}

function attachmentOf(ws: WebSocket): Attachment {
  const raw = ws.deserializeAttachment() as Partial<Attachment> | null;
  if (raw?.role === "client") return raw as ClientAttachment;
  if (raw?.role === "conversation") return raw as ConversationAttachment;
  return { role: "worker", connectedAt: 0, lastSeenAt: 0, ...(raw ?? {}) } as WorkerAttachment;
}

function sendWorker(ws: WebSocket, message: HubToWorkerMessage): void {
  ws.send(encodeMessage(message));
}

function trySend(ws: WebSocket, frame: string): void {
  try {
    ws.send(frame);
  } catch {
    // Socket is closing; the close handler cleans up.
  }
}

function resultOf(message: JobResultMessage) {
  switch (message.status) {
    case "succeeded":
      return { status: "succeeded" as const, output: message.output ?? null };
    case "failed":
      return { status: "failed" as const, error: message.error ?? "job failed" };
    case "cancelled":
      return { status: "cancelled" as const, error: message.error ?? null };
  }
}
