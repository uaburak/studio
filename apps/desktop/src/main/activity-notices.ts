// macOS notifications for what happens while the user looks elsewhere (A8): finished jobs
// (replies, posts, images, brand analyses), publish results, and chat cards that wait for the
// user (a consent, a question). The main process follows the job stream itself — with the
// app's owner secret, like its other API calls — so notices also come while the window is
// closed; the page posts none of these (one source, no doubles).
//
// A running chat turn's conversation is followed too, only while the turn runs, to see a
// consent or question card appear. Frames are read loosely (no contract runtime here).
import type { NoticeInput } from "../shared/ipc.ts";
import { conversationIdOf, finishedNotice, jobTitle, waitingNotice } from "../shared/notices.ts";

export interface ActivitySocket {
  close(): void;
}

export interface ActivitySocketEvents {
  onOpen(): void;
  onMessage(data: unknown): void;
  onClose(): void;
}

export type ActivitySocketFactory = (
  url: string,
  headers: Record<string, string>,
  events: ActivitySocketEvents,
) => ActivitySocket;

export interface ActivityTarget {
  port: number;
  ownerSecret: string;
}

export interface ActivityDeps {
  /** The local API (null while the host is down). */
  target(): ActivityTarget | null;
  socket: ActivitySocketFactory;
  /** GET a JSON document from the local API (a conversation's title). */
  getJson(target: ActivityTarget, path: string): Promise<unknown>;
  /** Shows a notice (the Notifier: setting, de-duplication). */
  post(notice: NoticeInput): void;
  /** The user is looking at the window: the page shows the change itself. */
  windowFocused(): boolean;
  log?(message: string): void;
  retryMs?: number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export const OWNER_HEADER = "X-Studio-Owner";

interface JobFrame {
  id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  brandId?: string;
  error?: string;
}

const ACTIVE = new Set(["queued", "running"]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

function asJob(value: unknown): JobFrame | null {
  const job = value as Partial<JobFrame> | null;
  if (!job || typeof job.id !== "string" || typeof job.type !== "string") return null;
  if (typeof job.status !== "string") return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    payload: job.payload && typeof job.payload === "object" ? job.payload : {},
    ...(typeof job.brandId === "string" ? { brandId: job.brandId } : {}),
    ...(typeof job.error === "string" ? { error: job.error } : {}),
  };
}

function parse(data: unknown): Record<string, unknown> | null {
  try {
    const text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString();
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface Watched {
  socket: ActivitySocket | null;
  title: string;
  retry: unknown;
}

export class ActivityNotices {
  private socket: ActivitySocket | null = null;
  private connectedTo: string | null = null;
  private retry: unknown;
  private failures = 0;
  private running = false;
  /** Last status of each job seen (null until the first snapshot: nothing is announced). */
  private known: Map<string, string> | null = null;
  private readonly conversations = new Map<string, Watched>();
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: ActivityDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  start(): void {
    this.running = true;
    this.refresh();
  }

  stop(): void {
    this.running = false;
    this.disconnect();
  }

  /** The host changed (up, down, another port): follow the stream where the API is now. */
  refresh(): void {
    const target = this.running ? this.deps.target() : null;
    const key = target ? `${target.port}` : null;
    if (key === this.connectedTo && (this.socket || this.retry !== undefined)) return;
    this.disconnect();
    if (!target || !key) return;
    this.connectedTo = key;
    this.connect(target);
  }

  private disconnect(): void {
    if (this.retry !== undefined) this.clearTimer(this.retry);
    this.retry = undefined;
    const socket = this.socket;
    this.socket = null;
    this.connectedTo = null;
    socket?.close();
    for (const id of [...this.conversations.keys()]) this.unwatch(id);
  }

  private headers(target: ActivityTarget): Record<string, string> {
    return { [OWNER_HEADER]: target.ownerSecret };
  }

  private connect(target: ActivityTarget): void {
    let socket: ActivitySocket | null = null;
    const url = `ws://127.0.0.1:${target.port}/api/jobs/stream`;
    socket = this.deps.socket(url, this.headers(target), {
      onOpen: () => {
        this.failures = 0;
      },
      onMessage: (data) => {
        if (this.socket === socket) this.onJobFrame(target, parse(data));
      },
      onClose: () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (!this.running || this.connectedTo === null) return;
        this.failures += 1;
        const base = this.deps.retryMs ?? 1_000;
        const delay = Math.min(base * 2 ** Math.min(this.failures - 1, 5), 30_000);
        this.retry = this.setTimer(() => {
          this.retry = undefined;
          const now = this.deps.target();
          if (this.running && now && `${now.port}` === this.connectedTo) this.connect(now);
          else this.refresh();
        }, delay);
      },
    });
    this.socket = socket;
  }

  // --- jobs ------------------------------------------------------------------------------------

  private onJobFrame(target: ActivityTarget, frame: Record<string, unknown> | null): void {
    if (!frame) return;
    if (frame.type === "jobs.snapshot" && Array.isArray(frame.jobs)) {
      const jobs = frame.jobs.map(asJob).filter((j): j is JobFrame => j !== null);
      const first = this.known === null;
      const known = this.known ?? new Map<string, string>();
      this.known = known;
      for (const job of jobs) {
        const previous = known.get(job.id);
        known.set(job.id, job.status);
        // A short reconnect: what finished meanwhile is still announced.
        if (!first && previous !== undefined) this.changed(target, job, previous);
        this.follow(target, job);
      }
      return;
    }
    if (frame.type === "job.updated") {
      const job = asJob(frame.job);
      if (!job || this.known === null) return;
      const previous = this.known.get(job.id);
      this.known.set(job.id, job.status);
      if (this.known.size > 2_000) {
        const oldest = this.known.keys().next().value as string;
        this.known.delete(oldest);
      }
      if (previous !== undefined) this.changed(target, job, previous);
      this.follow(target, job);
    }
  }

  private changed(target: ActivityTarget, job: JobFrame, previous: string): void {
    if (previous === job.status || !ACTIVE.has(previous) || !TERMINAL.has(job.status)) return;
    if (job.type !== "chat.turn") {
      this.announce(finishedNotice(job, jobTitle(job)));
      return;
    }
    if (job.status !== "succeeded") return;
    const conversationId = conversationIdOf(job);
    const known = conversationId ? this.conversations.get(conversationId)?.title : undefined;
    if (!conversationId || known) {
      this.announce(finishedNotice(job, known || "Studio"));
      return;
    }
    void this.deps
      .getJson(target, `/api/conversations/${encodeURIComponent(conversationId)}`)
      .then((value) => (value as { title?: unknown } | null)?.title)
      .catch(() => undefined)
      .then((title) =>
        this.announce(finishedNotice(job, typeof title === "string" && title ? title : "Studio")),
      );
  }

  private announce(notice: NoticeInput | null): void {
    if (!notice || this.deps.windowFocused()) return;
    try {
      this.deps.post(notice);
    } catch (error) {
      this.deps.log?.(`notice failed: ${(error as Error).message}`);
    }
  }

  // --- conversations of running chat turns ------------------------------------------------------

  /** A running chat turn: watch its conversation for cards that wait on the user. */
  private follow(target: ActivityTarget, job: JobFrame): void {
    if (job.type !== "chat.turn") return;
    const id = conversationIdOf(job);
    if (!id) return;
    if (ACTIVE.has(job.status)) this.watch(target, id);
    else this.unwatch(id);
  }

  get watchedConversations(): string[] {
    return [...this.conversations.keys()];
  }

  private watch(target: ActivityTarget, id: string): void {
    if (this.conversations.has(id)) return;
    const entry: Watched = { socket: null, title: "", retry: undefined };
    this.conversations.set(id, entry);
    this.openConversation(target, id, entry);
  }

  private openConversation(target: ActivityTarget, id: string, entry: Watched): void {
    const url = `ws://127.0.0.1:${target.port}/api/conversations/${encodeURIComponent(id)}/stream`;
    const socket = this.deps.socket(url, this.headers(target), {
      onOpen: () => undefined,
      onMessage: (data) => {
        if (entry.socket === socket) this.onConversationFrame(id, entry, parse(data));
      },
      onClose: () => {
        if (entry.socket !== socket) return;
        entry.socket = null;
        // Still running: look again shortly (the job stream ends the watch when the turn ends).
        if (this.conversations.get(id) === entry && this.socket) {
          entry.retry = this.setTimer(() => {
            entry.retry = undefined;
            if (this.conversations.get(id) === entry) this.openConversation(target, id, entry);
          }, 2_000);
        }
      },
    });
    entry.socket = socket;
  }

  private unwatch(id: string): void {
    const entry = this.conversations.get(id);
    if (!entry) return;
    this.conversations.delete(id);
    if (entry.retry !== undefined) this.clearTimer(entry.retry);
    const socket = entry.socket;
    entry.socket = null;
    socket?.close();
  }

  private onConversationFrame(
    id: string,
    entry: Watched,
    frame: Record<string, unknown> | null,
  ): void {
    if (!frame) return;
    const titleOf = (value: unknown) => {
      const title = (value as { title?: unknown } | null)?.title;
      if (typeof title === "string") entry.title = title;
    };
    const message = (value: unknown) => {
      const m = value as { id?: unknown; role?: unknown; status?: unknown; parts?: unknown } | null;
      if (!m || typeof m.id !== "string" || m.role !== "assistant" || !Array.isArray(m.parts))
        return;
      for (const part of m.parts as Record<string, unknown>[]) {
        // A question waits only while its reply is still being written.
        if (part?.type === "question" && m.status !== "streaming") continue;
        this.announce(waitingNotice(id, entry.title, m.id, part ?? {}));
      }
    };
    switch (frame.type) {
      case "conversation.snapshot":
        titleOf(frame.conversation);
        if (Array.isArray(frame.messages)) for (const m of frame.messages) message(m);
        return;
      case "conversation.updated":
        titleOf(frame.conversation);
        return;
      case "message.created":
      case "message.updated":
        message(frame.message);
        return;
      case "part.added":
      case "part.updated":
        if (typeof frame.messageId === "string" && frame.part && typeof frame.part === "object") {
          this.announce(
            waitingNotice(id, entry.title, frame.messageId, frame.part as Record<string, unknown>),
          );
        }
        return;
      default:
        return;
    }
  }
}

/** Node's WebSocket (Electron's main process) with the owner header. */
export const nodeActivitySocket: ActivitySocketFactory = (url, headers, events) => {
  const NodeWebSocket = WebSocket as unknown as new (
    url: string,
    init?: { headers?: Record<string, string> },
  ) => WebSocket;
  const ws = new NodeWebSocket(url, { headers });
  ws.addEventListener("open", () => events.onOpen());
  ws.addEventListener("message", (event) => events.onMessage(event.data));
  ws.addEventListener("close", () => events.onClose());
  // An error is followed by "close".
  ws.addEventListener("error", () => undefined);
  return { close: () => ws.close() };
};

/** GET with the owner header (2 s at most). */
export async function getOwnerJson(target: ActivityTarget, path: string): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${target.port}${path}`, {
    headers: { accept: "application/json", [OWNER_HEADER]: target.ownerSecret },
    signal: AbortSignal.timeout(2_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
