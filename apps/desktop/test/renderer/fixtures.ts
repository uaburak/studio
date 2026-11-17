import type {
  AgentRun,
  Conversation,
  ConversationAlias,
  ConversationState,
  Message,
  MessagePart,
  WorkerPresence,
} from "@studio/contract";

export const T = "2026-11-17T10:00:00.000Z";

export function conversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: "c1",
    brandId: "b1",
    title: "Kasım kampanya postları",
    status: "active",
    activeRunId: null,
    lastSeq: 0,
    agentSession: null,
    lastActivityAt: T,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function message(
  id: string,
  role: Message["role"],
  parts: MessagePart[],
  over: Partial<Message> = {},
): Message {
  return {
    id,
    conversationId: "c1",
    role,
    status: "complete",
    runId: role === "assistant" ? "r1" : null,
    parts,
    mentions: [],
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export const text = (t: string): MessagePart => ({ type: "text", text: t });

export function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "r1",
    conversationId: "c1",
    triggerMessageId: "u1",
    jobId: "j1",
    status: "running",
    attempt: 1,
    model: "opus",
    effort: "medium",
    usage: null,
    error: null,
    createdAt: T,
    updatedAt: T,
    startedAt: T,
    finishedAt: null,
    ...over,
  };
}

export const presence: WorkerPresence = {
  online: true,
  lastSeenAt: T,
  workers: [
    {
      workerId: "w",
      capabilities: ["chat.turn"],
      concurrency: 1,
      connectedAt: T,
      lastSeenAt: T,
      draining: false,
    },
  ],
  currentJobs: [],
  queueLength: 0,
};

export function alias(name: string, over: Partial<ConversationAlias> = {}): ConversationAlias {
  return {
    id: `a-${name}`,
    conversationId: "c1",
    alias: name,
    previousAliases: [],
    assetId: `asset-${name}`,
    kind: "image",
    mimeType: "image/png",
    width: 800,
    height: 1000,
    filename: `${name}.png`,
    contentPath: `/api/assets/asset-${name}/content`,
    messageId: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

export function state(over: Partial<ConversationState> = {}): ConversationState {
  return {
    seq: 1,
    conversation: conversation(),
    messages: [],
    hasMoreMessages: false,
    activeRun: null,
    plans: [],
    aliases: [],
    presence,
    stale: false,
    ...over,
  };
}
