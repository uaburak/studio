import { describe, expect, it } from "vitest";
import {
  AgentRun,
  applyConversationStreamMessage,
  ChatTurnPayload,
  ContentGeneratePayload,
  type Conversation,
  type ConversationState,
  type ConversationStreamMessage,
  canTransitionPlan,
  checkPlanPeriod,
  checkQuestionAnswer,
  createApiClient,
  decodeConversationStreamMessage,
  encodeConversationStreamMessage,
  INTERNAL_JOB_TYPES,
  JOB_PAYLOAD_SCHEMAS,
  JobType,
  MAX_TEXT_DELTA_BYTES,
  type Message,
  MessagePart,
  monthPeriod,
  PlanGenerate,
  PlanItemInput,
  PlanProposalPut,
  parseContentGenerateJob,
  QuestionPartInput,
  RunUsage,
  TurnOps,
  UserMessageCreate,
  type WorkerPresence,
} from "../src/index.ts";

const T = "2026-11-16T10:00:00.000Z";

const conversation: Conversation = {
  id: "c1",
  brandId: null,
  title: "",
  status: "active",
  activeRunId: null,
  lastSeq: 0,
  lastActivityAt: T,
  createdAt: T,
  updatedAt: T,
};

const presence: WorkerPresence = {
  online: false,
  lastSeenAt: null,
  workers: [],
  currentJobs: [],
  queueLength: 0,
};

const run: AgentRun = {
  id: "r1",
  conversationId: "c1",
  triggerMessageId: "m1",
  jobId: "j1",
  status: "running",
  attempt: 1,
  model: null,
  usage: null,
  error: null,
  createdAt: T,
  updatedAt: T,
  startedAt: T,
  finishedAt: null,
};

const assistant: Message = {
  id: "m2",
  conversationId: "c1",
  role: "assistant",
  status: "streaming",
  runId: "r1",
  parts: [],
  createdAt: T,
  updatedAt: T,
};

describe("chat schemas", () => {
  it("adds chat.turn as an internal job type with a payload schema", () => {
    expect(JobType.options).toContain("chat.turn");
    expect(INTERNAL_JOB_TYPES).toEqual(["chat.turn"]);
    expect(JOB_PAYLOAD_SCHEMAS["chat.turn"]).toBe(ChatTurnPayload);
    expect(ChatTurnPayload.safeParse({ conversationId: "c", runId: "r" }).success).toBe(true);
    expect(ChatTurnPayload.safeParse({ conversationId: "c" }).success).toBe(false);
  });

  it("needs text or attachments in a user message", () => {
    expect(UserMessageCreate.safeParse({ text: "selam" }).success).toBe(true);
    expect(UserMessageCreate.safeParse({ attachmentAssetIds: ["a1"] }).success).toBe(true);
    expect(UserMessageCreate.safeParse({}).success).toBe(false);
    expect(UserMessageCreate.safeParse({ text: "   " }).success).toBe(false);
    expect(UserMessageCreate.safeParse({ text: "x", attachmentAssetIds: ["a", "a"] }).success).toBe(
      false,
    );
    expect(UserMessageCreate.safeParse({ text: "x".repeat(20_001) }).success).toBe(false);
  });

  it("validates the part union and question shapes", () => {
    expect(MessagePart.safeParse({ type: "text", text: "hi" }).success).toBe(true);
    expect(MessagePart.safeParse({ type: "video", url: "x" }).success).toBe(false);
    const choice = QuestionPartInput.parse({
      type: "question",
      questionId: "q1",
      prompt: "Kaç post?",
      mode: "single",
      options: [
        { id: "a", label: "8" },
        { id: "b", label: "12" },
      ],
    });
    expect(choice).toMatchObject({ allowText: false, options: [{ description: null }, {}] });
    expect(
      QuestionPartInput.safeParse({
        type: "question",
        questionId: "q",
        prompt: "?",
        mode: "single",
      }).success,
    ).toBe(false);
    expect(
      QuestionPartInput.safeParse({
        type: "question",
        questionId: "q",
        prompt: "?",
        mode: "text",
        options: [{ id: "a", label: "x" }],
      }).success,
    ).toBe(false);
    expect(
      QuestionPartInput.safeParse({
        type: "question",
        questionId: "has space",
        prompt: "?",
        mode: "text",
      }).success,
    ).toBe(false);
  });

  it("checks question answers", () => {
    const single = {
      mode: "single" as const,
      allowText: false,
      options: [
        { id: "a", label: "A", description: null },
        { id: "b", label: "B", description: null },
      ],
    };
    expect(checkQuestionAnswer(single, { optionIds: ["a"] })).toBeNull();
    expect(checkQuestionAnswer(single, { optionIds: ["a", "b"] })).toMatch(/exactly one/);
    expect(checkQuestionAnswer(single, { optionIds: [] })).toMatch(/pick/);
    expect(checkQuestionAnswer(single, { optionIds: ["z"] })).toMatch(/unknown/);
    expect(checkQuestionAnswer(single, { optionIds: [], text: "başka" })).toMatch(/free text/);
    expect(
      checkQuestionAnswer({ ...single, allowText: true }, { optionIds: [], text: "başka" }),
    ).toBeNull();
    expect(
      checkQuestionAnswer({ ...single, mode: "multiple" }, { optionIds: ["a", "b"] }),
    ).toBeNull();
    const text = { mode: "text" as const, allowText: false, options: [] };
    expect(checkQuestionAnswer(text, { optionIds: [], text: "12" })).toBeNull();
    expect(checkQuestionAnswer(text, { optionIds: [], text: " " })).toMatch(/required/);
  });

  it("bounds turn ops", () => {
    const delta = (text: string) => ({ op: "text.delta", index: 0, seq: 1, text });
    expect(TurnOps.safeParse({ ops: [delta("ok")] }).success).toBe(true);
    expect(TurnOps.safeParse({ ops: [delta("x".repeat(MAX_TEXT_DELTA_BYTES + 1))] }).success).toBe(
      false,
    );
    // Multi-byte characters count in bytes.
    expect(
      TurnOps.safeParse({ ops: [delta("ş".repeat(MAX_TEXT_DELTA_BYTES / 2 + 1))] }).success,
    ).toBe(false);
    expect(TurnOps.safeParse({ ops: [] }).success).toBe(false);
    expect(TurnOps.safeParse({ ops: [{ ...delta("x"), seq: 0 }] }).success).toBe(false);
    expect(TurnOps.safeParse({ ops: [{ ...delta("x"), index: 64 }] }).success).toBe(false);
    expect(RunUsage.safeParse({ inputTokens: 10, provider: "anthropic" }).success).toBe(true);
    expect(RunUsage.safeParse({ inputTokens: -1 }).success).toBe(false);
  });
});

describe("plans", () => {
  it("fills item defaults and checks periods", () => {
    expect(
      PlanItemInput.parse({ platforms: ["instagram"], contentType: "post", title: "Hasat" }),
    ).toEqual({
      date: null,
      platforms: ["instagram"],
      contentType: "post",
      title: "Hasat",
      brief: "",
      pillar: null,
      imageSlot: "none",
      imageBrief: null,
    });
    expect(
      PlanItemInput.safeParse({ platforms: [], contentType: "post", title: "x" }).success,
    ).toBe(false);
    expect(monthPeriod("2026-12")).toEqual({ periodStart: "2026-12-01", periodEnd: "2026-12-31" });
    expect(monthPeriod("2028-02")).toEqual({ periodStart: "2028-02-01", periodEnd: "2028-02-29" });
    expect(() => monthPeriod("2026-13")).toThrow();
    expect(checkPlanPeriod("2026-12-01", "2026-12-31", ["2026-12-05", null])).toBeNull();
    expect(checkPlanPeriod("2026-12-31", "2026-12-01")).toMatch(/before/);
    expect(checkPlanPeriod("2026-01-01", "2026-12-31")).toMatch(/at most/);
    expect(checkPlanPeriod("2026-12-01", "2026-12-31", ["2027-01-01"])).toMatch(/outside/);
    expect(
      PlanProposalPut.safeParse({
        periodStart: "2026-12-01",
        periodEnd: "2026-12-31",
        items: [{ id: "x", platforms: ["instagram"], contentType: "post", title: "a" }],
      }).data?.items[0],
    ).not.toHaveProperty("id");
  });

  it("encodes the plan lifecycle", () => {
    expect(canTransitionPlan("proposed", "accepted")).toBe(true);
    expect(canTransitionPlan("draft", "accepted")).toBe(false);
    expect(canTransitionPlan("accepted", "rejected")).toBe(false);
    expect(canTransitionPlan("proposed", "superseded")).toBe(true);
  });

  it("defines the content.generate payload, compatible with older callers", () => {
    // What the web app sends today (F1-5) still parses.
    const legacy = {
      brief: "Hasat",
      title: "Hasat",
      type: "post",
      targetPlatforms: ["instagram"],
      baseVersion: 2,
    };
    expect(ContentGeneratePayload.safeParse(legacy).success).toBe(true);
    const parsed = parseContentGenerateJob({ payload: legacy, brandId: "b1", contentId: "c1" });
    expect(parsed).toMatchObject({ ok: true, payload: { brandId: "b1", contentId: "c1" } });
    expect(parseContentGenerateJob({ payload: legacy }).ok).toBe(false);
    expect(parseContentGenerateJob({ payload: { title: "no brief" } }).ok).toBe(false);
    const full = ContentGeneratePayload.parse({
      ...legacy,
      brandId: "b1",
      contentId: "c1",
      imageSlot: "user_upload",
      imageBrief: "tarla",
      planItem: { planId: "p1", itemId: "i1", date: "2026-12-03", pillar: null },
      conversationId: "conv",
      brandProfileVersion: 3,
    });
    expect(full.planItem?.itemId).toBe("i1");
    const chosen = ContentGeneratePayload.parse({ ...legacy, model: "haiku", effort: "low" });
    expect(chosen).toMatchObject({ model: "haiku", effort: "low" });
    expect(ContentGeneratePayload.safeParse({ ...legacy, model: "gpt" }).success).toBe(false);
  });

  it("carries the model and effort choice on messages, runs and plan generation", () => {
    const msg = UserMessageCreate.parse({ text: "selam", model: "opus", effort: "xhigh" });
    expect(msg).toMatchObject({ model: "opus", effort: "xhigh" });
    expect(UserMessageCreate.parse({ text: "selam" })).not.toHaveProperty("model");
    expect(UserMessageCreate.safeParse({ text: "selam", effort: "max" }).success).toBe(false);
    expect(PlanGenerate.parse({ model: "sonnet", effort: "medium" })).toEqual({
      model: "sonnet",
      effort: "medium",
    });
    expect(PlanGenerate.safeParse({ model: "Opus" }).success).toBe(false);
    const run = {
      id: "r1",
      conversationId: "c1",
      triggerMessageId: "m1",
      jobId: null,
      status: "queued",
      attempt: 0,
      model: "opus",
      effort: "high",
      usage: null,
      error: null,
      createdAt: "2026-11-16T10:00:00.000Z",
      updatedAt: "2026-11-16T10:00:00.000Z",
      startedAt: null,
      finishedAt: null,
    };
    expect(AgentRun.parse(run)).toEqual(run);
    const { effort: _e, ...older } = run;
    expect(AgentRun.parse({ ...older, model: null })).not.toHaveProperty("effort");
    expect(AgentRun.parse({ ...run, effort: null }).effort).toBeNull();
    expect(AgentRun.safeParse({ ...run, effort: "max" }).success).toBe(false);
  });
});

describe("conversation stream", () => {
  const snapshot: ConversationStreamMessage = {
    type: "conversation.snapshot",
    seq: 3,
    conversation,
    messages: [],
    hasMoreMessages: false,
    activeRun: null,
    plans: [],
    presence,
  };

  it("round-trips frames and rejects junk", () => {
    const frame = encodeConversationStreamMessage(snapshot);
    expect(decodeConversationStreamMessage(frame)).toEqual({ ok: true, message: snapshot });
    expect(decodeConversationStreamMessage("{").ok).toBe(false);
    expect(decodeConversationStreamMessage(new ArrayBuffer(2)).ok).toBe(false);
    expect(
      decodeConversationStreamMessage(JSON.stringify({ type: "text.delta", seq: 0, text: "x" })).ok,
    ).toBe(false);
  });

  it("reduces snapshot + events, ignores duplicates and flags gaps", () => {
    const events: ConversationStreamMessage[] = [
      { type: "run.updated", seq: 4, run },
      { type: "message.created", seq: 5, message: assistant },
      { type: "text.delta", seq: 6, messageId: "m2", index: 0, text: "Mer" },
      { type: "text.delta", seq: 6, messageId: "m2", index: 0, text: "Mer" }, // duplicate
      { type: "text.delta", seq: 7, messageId: "m2", index: 0, text: "haba" },
      {
        type: "part.added",
        seq: 8,
        messageId: "m2",
        index: 1,
        part: { type: "plan_proposal", planId: "p1" },
      },
      { type: "presence", presence: { ...presence, online: true } },
    ];
    let state: ConversationState | null = applyConversationStreamMessage(
      null,
      events[0] as ConversationStreamMessage,
    );
    expect(state).toBeNull(); // nothing before a snapshot
    state = applyConversationStreamMessage(null, snapshot);
    for (const e of events) state = applyConversationStreamMessage(state, e);
    expect(state?.seq).toBe(8);
    expect(state?.activeRun?.id).toBe("r1");
    expect(state?.messages[0]?.parts).toEqual([
      { type: "text", text: "Merhaba" },
      { type: "plan_proposal", planId: "p1" },
    ]);
    expect(state?.presence?.online).toBe(true);
    expect(state?.stale).toBe(false);

    const done = applyConversationStreamMessage(state, {
      type: "run.updated",
      seq: 9,
      run: { ...run, status: "completed" },
    });
    expect(done?.activeRun).toBeNull();
    const gap = applyConversationStreamMessage(done, {
      type: "conversation.updated",
      seq: 11,
      conversation: { ...conversation, title: "x" },
    });
    expect(gap?.stale).toBe(true);
    expect(gap?.conversation.title).toBe("");
  });
});

describe("api client: chat", () => {
  function recordingFetch(body: unknown, status = 200) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it("sends messages and worker calls to the right routes", async () => {
    const result = {
      message: { ...assistant, role: "user", status: "complete", runId: null },
      run: { ...run, status: "queued", attempt: 0 },
      replayed: false,
    };
    const { calls, fetchImpl } = recordingFetch(result, 201);
    const client = createApiClient({ baseUrl: "http://api.test", fetch: fetchImpl });
    await expect(
      client.conversations.messages.send("c1", { text: "selam", clientMessageId: "k1" }),
    ).resolves.toMatchObject({ replayed: false });
    expect(calls[0]?.url).toBe("http://api.test/api/conversations/c1/messages");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBeNull();

    const w = recordingFetch({ ...run, status: "completed" });
    const workerClient = createApiClient({ fetch: w.fetchImpl, workerToken: "secret" });
    await workerClient.workerTurns.complete("r1", { usage: { inputTokens: 1 } });
    expect(w.calls[0]?.url).toBe("/api/worker/runs/r1/complete");
    expect(w.calls[0]?.init?.method).toBe("POST");
    expect(new Headers(w.calls[0]?.init?.headers).get("authorization")).toBe("Bearer secret");
    expect(client.conversations.streamUrl("c1", { after: 4 })).toBe(
      "ws://api.test/api/conversations/c1/stream?after=4",
    );
  });

  it("resumes the conversation stream from the last seq it saw", async () => {
    const sockets: FakeWs[] = [];
    class FakeWs extends EventTarget {
      constructor(readonly url: string) {
        super();
        sockets.push(this);
      }
      close() {
        this.dispatchEvent(new Event("close"));
      }
      emit(frame: ConversationStreamMessage) {
        const data = encodeConversationStreamMessage(frame);
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
    const client = createApiClient({
      baseUrl: "http://api.test",
      WebSocket: FakeWs as unknown as typeof WebSocket,
    });
    const seen: string[] = [];
    const watch = client.conversations.watch(
      "c1",
      { onMessage: (m) => seen.push(m.type) },
      { reconnectDelayMs: 5 },
    );
    expect(sockets[0]?.url).toBe("ws://api.test/api/conversations/c1/stream");
    sockets[0]?.emit({
      type: "conversation.snapshot",
      seq: 3,
      conversation,
      messages: [],
      hasMoreMessages: false,
      activeRun: null,
      plans: [],
      presence,
    });
    sockets[0]?.emit({ type: "run.updated", seq: 4, run });
    sockets[0]?.emit({ type: "presence", presence });
    expect(watch.lastSeq).toBe(4);
    sockets[0]?.dispatchEvent(new Event("close"));
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets[1]?.url).toBe("ws://api.test/api/conversations/c1/stream?after=4");
    watch.close();
    expect(seen).toEqual(["conversation.snapshot", "run.updated", "presence"]);
  });

  it("validates Gemini models, tool_step and consent parts, and AI worker endpoints", async () => {
    for (const model of ["gemini-flash-lite", "gemini-flash", "gemini-pro"] as const) {
      const msg = UserMessageCreate.parse({ text: "Merhaba", model, effort: "medium" });
      expect(msg.model).toBe(model);
    }

    const step = MessagePart.parse({
      type: "tool_step",
      id: "call_1",
      name: "propose_plan",
      label: "İçerik planı hazırlandı",
      state: "done",
      summary: "8 post önerildi",
    });
    expect(step.type).toBe("tool_step");

    const consent = MessagePart.parse({
      type: "consent",
      consentId: "c_1",
      tool: "schedule_content",
      title: "Postu zamanla",
      detail: "Instagram · Yarın 09:00",
      state: "pending",
      decidedAt: null,
    });
    expect(consent.type).toBe("consent");

    const ops = TurnOps.parse({
      attempt: 1,
      ops: [
        {
          op: "part.set",
          index: 0,
          part: {
            type: "tool_step",
            id: "call_1",
            name: "propose_plan",
            label: "Plan hazırlanıyor…",
            state: "running",
          },
        },
        {
          op: "part.set",
          index: 1,
          part: {
            type: "consent",
            consentId: "c_1",
            tool: "schedule_content",
            title: "Postu zamanla",
          },
        },
      ],
    });
    expect(ops.ops).toHaveLength(2);

    const g = recordingFetch({
      account: {
        status: "ready",
        mode: "api",
        apiKeyConfigured: true,
        cliVersion: null,
        defaultModel: "gemini-2.5-flash-lite",
        detail: "GEMINI_API_KEY hazır",
        checkedAt: T,
      },
      online: true,
      sent: 1,
    });
    const client = createApiClient({ baseUrl: "http://api.test", fetch: g.fetchImpl });
    await expect(client.workers.gemini()).resolves.toMatchObject({ online: true });
    await expect(client.workers.geminiRefresh()).resolves.toMatchObject({ sent: 1 });
    expect(g.calls.map((c) => `${c.init?.method ?? "GET"} ${c.url}`)).toEqual([
      "GET http://api.test/api/workers/gemini",
      "POST http://api.test/api/workers/gemini/status",
    ]);
  });
});
