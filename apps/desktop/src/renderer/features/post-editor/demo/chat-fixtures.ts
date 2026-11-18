// An in-memory conversation server for the editor demo (`?demo=post-editor`) and the tests:
// create, watch (snapshot + events, as the real stream sends them), send (a user message, a run,
// a short assistant reply), cancel. Enough for the post's Sohbet panel without a host.
import type {
  AgentRun,
  Conversation,
  ConversationStreamMessage,
  Message,
  WorkerPresence,
} from "@studio/contract";

type Handlers = {
  onMessage(message: ConversationStreamMessage): void;
  onStatus?(status: "connecting" | "open" | "closed"): void;
};

interface Room {
  conversation: Conversation;
  messages: Message[];
  seq: number;
  run: AgentRun | null;
  watchers: Set<Handlers>;
}

const NOW = () => new Date().toISOString();

const PRESENCE: WorkerPresence = {
  online: true,
  lastSeenAt: NOW(),
  workers: [
    {
      workerId: "demo",
      capabilities: ["chat.turn"],
      concurrency: 1,
      connectedAt: NOW(),
      lastSeenAt: NOW(),
      draining: false,
    },
  ],
  currentJobs: [],
  queueLength: 0,
};

export class DemoChat {
  private rooms = new Map<string, Room>();
  private next = 1;
  /** Every created conversation and sent message (tests read them). */
  created: { brandId: string | null; title: string }[] = [];
  sent: { conversationId: string; text: string }[] = [];
  /** How long the demo agent "works" before its reply (ms). */
  replyMs = 700;
  reply: (text: string) => string = () =>
    "Demo: bu yanıt uygulamanın içinden geliyor. Gerçek düzenlemeyi Mac'teki ajan yapar; bitince yeni sürüm tuvale gelir.";
  /** Called when a run ends (the demo can make a version meanwhile). */
  onRunEnd: ((conversationId: string, text: string) => Promise<void> | void) | null = null;

  private emit(room: Room, make: (seq: number) => ConversationStreamMessage): void {
    room.seq += 1;
    const message = make(room.seq);
    room.conversation = { ...room.conversation, lastSeq: room.seq };
    for (const w of room.watchers) w.onMessage(message);
  }

  private run(room: Room, trigger: string, status: AgentRun["status"]): AgentRun {
    const id = room.run?.id ?? `demo-run-${this.next++}`;
    const run: AgentRun = {
      id,
      conversationId: room.conversation.id,
      triggerMessageId: trigger,
      jobId: `demo-job-${id}`,
      status,
      attempt: 1,
      model: "opus",
      effort: "medium",
      usage: null,
      error: null,
      createdAt: NOW(),
      updatedAt: NOW(),
      startedAt: NOW(),
      finishedAt: status === "running" || status === "queued" ? null : NOW(),
    } as AgentRun;
    room.run = status === "running" || status === "queued" ? run : null;
    return run;
  }

  conversations = {
    create: async (input: { brandId?: string; title?: string } = {}) => {
      const id = `demo-c${this.next++}`;
      const conversation: Conversation = {
        id,
        brandId: input.brandId ?? null,
        title: input.title ?? "",
        status: "active",
        activeRunId: null,
        lastSeq: 0,
        agentSession: null,
        lastActivityAt: NOW(),
        createdAt: NOW(),
        updatedAt: NOW(),
      };
      this.created.push({ brandId: conversation.brandId, title: conversation.title });
      this.rooms.set(id, { conversation, messages: [], seq: 0, run: null, watchers: new Set() });
      return conversation;
    },
    watch: (id: string, handlers: Handlers) => {
      const room = this.rooms.get(id);
      let open = true;
      queueMicrotask(() => {
        if (!open) return;
        if (!room) {
          handlers.onStatus?.("closed");
          return;
        }
        room.watchers.add(handlers);
        handlers.onStatus?.("open");
        handlers.onMessage({
          type: "conversation.snapshot",
          seq: room.seq,
          conversation: room.conversation,
          messages: room.messages,
          hasMoreMessages: false,
          activeRun: room.run,
          plans: [],
          aliases: [],
          presence: PRESENCE,
        } as ConversationStreamMessage);
      });
      return {
        close: () => {
          open = false;
          room?.watchers.delete(handlers);
        },
      };
    },
    messages: {
      send: async (id: string, input: { text?: string; clientMessageId?: string }) => {
        const room = this.rooms.get(id);
        if (!room) throw new Error("Sohbet bulunamadı.");
        const text = input.text ?? "";
        this.sent.push({ conversationId: id, text });
        const user: Message = {
          id: `demo-m${this.next++}`,
          conversationId: id,
          role: "user",
          status: "complete",
          runId: null,
          parts: [{ type: "text", text }],
          mentions: [],
          createdAt: NOW(),
          updatedAt: NOW(),
        } as Message;
        room.messages = [...room.messages, user];
        this.emit(room, (seq) => ({ type: "message.created", seq, message: user }) as never);
        const run = this.run(room, user.id, "running");
        this.emit(room, (seq) => ({ type: "run.updated", seq, run }) as never);
        setTimeout(async () => {
          const reply: Message = {
            id: `demo-m${this.next++}`,
            conversationId: id,
            role: "assistant",
            status: "complete",
            runId: run.id,
            parts: [{ type: "text", text: this.reply(text) }],
            mentions: [],
            createdAt: NOW(),
            updatedAt: NOW(),
          } as Message;
          await this.onRunEnd?.(id, text);
          room.messages = [...room.messages, reply];
          this.emit(room, (seq) => ({ type: "message.created", seq, message: reply }) as never);
          const done = this.run(room, user.id, "completed");
          this.emit(room, (seq) => ({ type: "run.updated", seq, run: done }) as never);
        }, this.replyMs);
        return { message: user, run, replayed: false };
      },
    },
  };

  agentRuns = {
    cancel: async (runId: string) => {
      for (const room of this.rooms.values()) {
        if (room.run?.id !== runId) continue;
        const run = this.run(room, room.run.triggerMessageId, "cancelled");
        this.emit(room, (seq) => ({ type: "run.updated", seq, run }) as never);
        return run;
      }
      throw new Error("Çalışan bir yanıt yok.");
    },
  };
}
