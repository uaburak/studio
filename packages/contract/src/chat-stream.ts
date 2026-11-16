import { z } from "zod";
import {
  AgentRun,
  Conversation,
  isActiveRunStatus,
  Message,
  MessagePart,
  type TextPart,
} from "./chat.ts";
import { WorkerPresence } from "./job.ts";
import { Plan } from "./plan.ts";
import { PongMessage, PresenceEvent } from "./protocol.ts";

/*
 * Conversation stream: GET /api/conversations/{id}/stream[?after=<seq>] (WebSocket).
 *
 * Every change to a conversation is stored as an event with a per-conversation
 * sequence number (1, 2, 3, ... no gaps) in the same D1 batch as the change
 * itself, then pushed to the conversation's sockets in order.
 *
 * On connect the server sends either
 *   - `conversation.snapshot` (no `after`, or `after` too old / unknown):
 *     the state as of `seq`; apply only events with a larger seq; or
 *   - the stored events with seq > `after`, followed by `conversation.resumed`.
 * Then live events follow. `presence` and `pong` frames carry no seq.
 * Clients remember the last seq they applied and reconnect with `?after=`.
 * A seq gap (should not happen) means: reconnect with `after` = last applied.
 */

/** Messages in a snapshot (newest ones, oldest first); page older ones via GET .../messages. */
export const CONVERSATION_SNAPSHOT_MESSAGES = 50;
/** Most events replayed on resume; further behind gets a snapshot instead. */
export const CONVERSATION_REPLAY_LIMIT = 1_000;

const Seq = z.number().int().min(1);

export const MessageCreatedEvent = z.object({
  type: z.literal("message.created"),
  seq: Seq,
  message: Message,
});
/** Message status changed (or several parts at once); replaces the whole message. */
export const MessageUpdatedEvent = z.object({
  type: z.literal("message.updated"),
  seq: Seq,
  message: Message,
});
export const PartAddedEvent = z.object({
  type: z.literal("part.added"),
  seq: Seq,
  messageId: z.string(),
  index: z.number().int().min(0),
  part: MessagePart,
});
/** Part replaced (progress update, answered question, ...). */
export const PartUpdatedEvent = z.object({
  type: z.literal("part.updated"),
  seq: Seq,
  messageId: z.string(),
  index: z.number().int().min(0),
  part: MessagePart,
});
/** Append `text` to the text part at `index`; when `index` is the next free position it starts a new text part. */
export const TextDeltaEvent = z.object({
  type: z.literal("text.delta"),
  seq: Seq,
  messageId: z.string(),
  index: z.number().int().min(0),
  text: z.string(),
});
export const RunUpdatedEvent = z.object({
  type: z.literal("run.updated"),
  seq: Seq,
  run: AgentRun,
});
export const PlanUpdatedEvent = z.object({
  type: z.literal("plan.updated"),
  seq: Seq,
  plan: Plan,
});
export const ConversationUpdatedEvent = z.object({
  type: z.literal("conversation.updated"),
  seq: Seq,
  conversation: Conversation,
});

/** Stored, sequenced events. */
export const ConversationEvent = z.discriminatedUnion("type", [
  MessageCreatedEvent,
  MessageUpdatedEvent,
  PartAddedEvent,
  PartUpdatedEvent,
  TextDeltaEvent,
  RunUpdatedEvent,
  PlanUpdatedEvent,
  ConversationUpdatedEvent,
]);
export type ConversationEvent = z.infer<typeof ConversationEvent>;
export type ConversationEventType = ConversationEvent["type"];

export const ConversationSnapshotEvent = z.object({
  type: z.literal("conversation.snapshot"),
  /** State as of this seq. */
  seq: z.number().int().min(0),
  conversation: Conversation,
  /** Oldest first. */
  messages: z.array(Message),
  hasMoreMessages: z.boolean(),
  activeRun: AgentRun.nullable(),
  /** Plans of the conversation except superseded ones, newest first (at most 20). */
  plans: z.array(Plan),
  presence: WorkerPresence,
});

/** Sent after the replayed events of a resume. */
export const ConversationResumedEvent = z.object({
  type: z.literal("conversation.resumed"),
  seq: z.number().int().min(0),
  replayed: z.number().int().min(0),
  presence: WorkerPresence,
});

export const ConversationStreamMessage = z.discriminatedUnion("type", [
  MessageCreatedEvent,
  MessageUpdatedEvent,
  PartAddedEvent,
  PartUpdatedEvent,
  TextDeltaEvent,
  RunUpdatedEvent,
  PlanUpdatedEvent,
  ConversationUpdatedEvent,
  ConversationSnapshotEvent,
  ConversationResumedEvent,
  PresenceEvent,
  PongMessage,
]);
export type ConversationStreamMessage = z.infer<typeof ConversationStreamMessage>;
export type ConversationSnapshotEvent = z.infer<typeof ConversationSnapshotEvent>;
export type ConversationResumedEvent = z.infer<typeof ConversationResumedEvent>;

export const ConversationStreamQuery = z.object({
  /** Last seq the client applied; omit for a fresh snapshot. */
  after: z.coerce.number().int().min(0).optional(),
});
export type ConversationStreamQuery = z.input<typeof ConversationStreamQuery>;

export function encodeConversationStreamMessage(message: ConversationStreamMessage): string {
  return JSON.stringify(ConversationStreamMessage.parse(message));
}

export type ConversationStreamDecodeResult =
  | { ok: true; message: ConversationStreamMessage }
  | { ok: false; error: string };

/** Parse a frame from the conversation stream. Never throws. */
export function decodeConversationStreamMessage(raw: unknown): ConversationStreamDecodeResult {
  if (typeof raw !== "string") return { ok: false, error: "frame must be a text (JSON) message" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "frame is not valid JSON" };
  }
  const parsed = ConversationStreamMessage.safeParse(data);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, error: z.prettifyError(parsed.error) };
}

// --- reference reducer -----------------------------------------------------------------

/** Client-side view of one conversation, built from stream frames. */
export interface ConversationState {
  /** Last applied seq; reconnect with `?after=` this value. */
  seq: number;
  conversation: Conversation;
  /** Oldest first. */
  messages: Message[];
  hasMoreMessages: boolean;
  activeRun: AgentRun | null;
  plans: Plan[];
  presence: WorkerPresence | null;
  /** Set when a seq gap was seen; reconnect with `after = seq` to recover. */
  stale: boolean;
}

function upsertById<T extends { id: string }>(list: T[], item: T, prepend = false): T[] {
  const index = list.findIndex((x) => x.id === item.id);
  if (index === -1) return prepend ? [item, ...list] : [...list, item];
  const next = [...list];
  next[index] = item;
  return next;
}

function mapMessage(state: ConversationState, id: string, fn: (m: Message) => Message): Message[] {
  return state.messages.map((m) => (m.id === id ? fn(m) : m));
}

function setPart(message: Message, index: number, part: MessagePart): Message {
  const parts = [...message.parts];
  parts[index] = part;
  return { ...message, parts };
}

/**
 * Apply one stream frame. Pure: returns a new state (or the same one when
 * the frame changes nothing). Before the first snapshot only a snapshot
 * creates state; events at or below `state.seq` are ignored (duplicates).
 * Swift/Kotlin clients can port this as-is.
 */
export function applyConversationStreamMessage(
  state: ConversationState | null,
  message: ConversationStreamMessage,
): ConversationState | null {
  if (message.type === "conversation.snapshot") {
    return {
      seq: message.seq,
      conversation: message.conversation,
      messages: message.messages,
      hasMoreMessages: message.hasMoreMessages,
      activeRun: message.activeRun,
      plans: message.plans,
      presence: message.presence,
      stale: false,
    };
  }
  if (!state) return null;
  switch (message.type) {
    case "presence":
      return { ...state, presence: message.presence };
    case "pong":
      return state;
    case "conversation.resumed":
      return {
        ...state,
        presence: message.presence,
        stale: state.stale || message.seq !== state.seq,
      };
  }
  if (message.seq <= state.seq) return state;
  if (message.seq !== state.seq + 1) return { ...state, stale: true };
  const next: ConversationState = { ...state, seq: message.seq };
  switch (message.type) {
    case "message.created":
    case "message.updated":
      next.messages = upsertById(state.messages, message.message);
      return next;
    case "part.added":
    case "part.updated":
      next.messages = mapMessage(state, message.messageId, (m) =>
        setPart(m, message.index, message.part),
      );
      return next;
    case "text.delta":
      next.messages = mapMessage(state, message.messageId, (m) => {
        const current = m.parts[message.index];
        const text: TextPart = {
          type: "text",
          text: (current?.type === "text" ? current.text : "") + message.text,
        };
        return setPart(m, message.index, text);
      });
      return next;
    case "run.updated":
      if (isActiveRunStatus(message.run.status)) next.activeRun = message.run;
      else if (state.activeRun?.id === message.run.id) next.activeRun = null;
      return next;
    case "plan.updated":
      next.plans = upsertById(state.plans, message.plan, true);
      return next;
    case "conversation.updated":
      next.conversation = message.conversation;
      return next;
  }
}
