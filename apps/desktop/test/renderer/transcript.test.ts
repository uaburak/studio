import type { ApiClient, ConversationStreamMessage, ToolStepPart } from "@studio/contract";
import { describe, expect, it, vi } from "vitest";
import {
  buildTranscript,
  stepGroupKey,
  stepSummary,
  workingLabel,
} from "../../src/renderer/lib/transcript.ts";
import {
  ConversationCache,
  ConversationController,
} from "../../src/renderer/state/conversation.ts";
import { alias, message, presence, run, state, text } from "./fixtures.ts";

const step = (
  id: string,
  name: string,
  s: ToolStepPart["state"],
  summary: string | null = null,
): ToolStepPart => ({
  type: "tool_step",
  id,
  name,
  label: s === "running" ? "Görsel üretiliyor…" : "Görsel üretildi",
  state: s,
  summary,
});

describe("buildTranscript", () => {
  it("shows loading until the first snapshot", () => {
    expect(buildTranscript({ hasState: false, connectionTrouble: true })).toEqual([
      { kind: "loading", key: "loading", trouble: true },
    ]);
  });

  it("builds user, assistant and system items with stable keys", () => {
    const items = buildTranscript({
      hasState: true,
      aliases: [alias("image")],
      messages: [
        message(
          "u1",
          "user",
          [
            text("Şuna bak @image"),
            {
              type: "attachment",
              assetId: "asset-image",
              kind: "image",
              mimeType: "image/png",
              width: 10,
              height: 12,
              filename: "a.png",
              aliasId: "a-image",
            },
          ],
          { mentions: undefined },
        ),
        message("a1", "assistant", [
          text("**Plan hazır**"),
          step("1", "generate_ai_image", "done", "@image"),
          step("2", "generate_post", "done"),
        ]),
        message("s1", "system", [text("Zamanlanmış post yayınlandı · Instagram")]),
      ],
    });
    expect(items.map((i) => i.key)).toEqual(["m-u1", "m-a1", "m-s1"]);
    const user = items[0];
    if (user?.kind !== "user") throw new Error("user");
    expect(user.mentions.map((m) => m.alias)).toEqual(["image"]);
    expect(user.images[0]).toMatchObject({ assetId: "asset-image", caption: "@image" });
    const assistant = items[1];
    if (assistant?.kind !== "assistant") throw new Error("assistant");
    expect(assistant.blocks.map((b) => b.kind)).toEqual(["text", "steps"]);
    const group = assistant.blocks[1];
    if (group?.kind !== "steps") throw new Error("steps");
    expect(group.key).toBe(stepGroupKey("a1", 1));
    expect(group.group.summary).toBe("1 görsel üretti, 1 post oluşturdu");
    expect(group.group.thumbnails.map((t) => t.caption)).toEqual(["@image"]);
    expect(items[2]).toEqual({
      kind: "event",
      key: "m-s1",
      text: "Zamanlanmış post yayınlandı · Instagram",
    });
  });

  it("puts a live reply's running step on the working line with its start time", () => {
    const live = message(
      "a1",
      "assistant",
      [step("1", "get_brand_profile", "done"), step("2", "generate_ai_image", "running")],
      { status: "streaming" },
    );
    const items = buildTranscript({
      hasState: true,
      messages: [message("u1", "user", [text("hadi")]), live],
      activeRun: run(),
      stepStarts: { "2": 5_000 },
    });
    const working = items.find((i) => i.kind === "working");
    if (working?.kind !== "working") throw new Error("working");
    expect(working.working).toEqual({
      phase: { kind: "step", label: "Görsel üretiliyor" },
      since: 5_000,
      cancellable: false,
      groupKey: stepGroupKey("a1", 0),
    });
    const assistant = items.find((i) => i.kind === "assistant");
    if (assistant?.kind !== "assistant") throw new Error("assistant");
    const group = assistant.blocks[0];
    if (group?.kind !== "steps") throw new Error("steps");
    // The summary leaves the running step out (it is on the working line).
    expect(group.group.summary).toBe("Görsel üretildi");
  });

  it("thinking → writing → queued phases", () => {
    const thinking = buildTranscript({ hasState: true, messages: [], activeRun: run() });
    expect(thinking.at(-1)).toMatchObject({
      kind: "working",
      working: { phase: { kind: "thinking" } },
    });
    const writing = buildTranscript({
      hasState: true,
      messages: [message("a1", "assistant", [text("Mer")], { status: "streaming" })],
      activeRun: run(),
    });
    const w = writing.at(-1);
    if (w?.kind !== "working") throw new Error("working");
    expect(workingLabel(w.working.phase)).toBe("Yazıyor…");
    const queued = buildTranscript({
      hasState: true,
      messages: [],
      activeRun: run({ status: "queued" }),
      runWaitingForMac: true,
      isOnline: false,
    });
    expect(queued.at(-1)).toMatchObject({
      working: {
        phase: { kind: "queued", text: "Mac sırada bekliyor: Mac çevrimdışı." },
        cancellable: true,
      },
    });
  });

  it("groups progress steps into the plan card and hides the done thinking step", () => {
    const p = (stepId: string, s: "done" | "running" | "pending") => ({
      type: "progress" as const,
      stepId,
      label: stepId,
      state: s,
      detail: null,
      current: null,
      total: null,
    });
    const items = buildTranscript({
      hasState: true,
      messages: [
        message("a1", "assistant", [
          p("thinking", "done"),
          p("oku", "done"),
          p("yaz", "running"),
          p("üret", "pending"),
        ]),
      ],
    });
    const a = items[0];
    if (a?.kind !== "assistant") throw new Error("assistant");
    expect(a.blocks).toHaveLength(1);
    expect(a.blocks[0]).toMatchObject({
      kind: "progress",
      steps: [{ stepId: "oku" }, { stepId: "yaz" }, { stepId: "üret" }],
    });
  });

  it("lists queued messages after the working line and notes stopped replies", () => {
    const items = buildTranscript({
      hasState: true,
      messages: [message("a1", "assistant", [text("yarım")], { status: "cancelled" })],
      queue: [
        {
          message: { clientMessageId: "q1", text: "sonra", attachments: [] },
          state: { kind: "waiting" },
          sendNow: false,
        },
      ],
    });
    expect(items.map((i) => i.kind)).toEqual(["assistant", "queued"]);
    const a = items[0];
    if (a?.kind !== "assistant") throw new Error("assistant");
    expect(a.blocks.at(-1)).toEqual({ kind: "notice", key: "status", text: "Yanıt durduruldu." });
    expect(items[1]).toMatchObject({ kind: "queued", text: "sonra", canEdit: true });
  });
});

describe("stepSummary", () => {
  it("summarises like Claude Code's 'Ran 3 commands, read 2 files'", () => {
    expect(
      stepSummary([
        step("1", "generate_ai_image", "done"),
        step("2", "generate_ai_image", "done"),
        step("3", "generate_post", "error"),
      ]),
    ).toBe("2 görsel üretti, 1 post oluşturdu, 1 başarısız");
    expect(stepSummary([step("1", "get_brand_profile", "done")])).toBe("Görsel üretildi");
    expect(stepSummary([step("1", "x", "error")])).toBe("Görsel üretildi · başarısız");
  });
});

// --- the conversation controller (stream + queue) -------------------------------------------------

function fakeClient() {
  let onMessage: ((m: ConversationStreamMessage) => void) | undefined;
  const sends: unknown[] = [];
  const client = {
    conversations: {
      watch: vi.fn(
        (
          _id: string,
          handlers: { onMessage: (m: ConversationStreamMessage) => void },
          _options?: { after?: number },
        ) => {
          onMessage = handlers.onMessage;
          return { close: vi.fn(), lastSeq: undefined };
        },
      ),
      messages: {
        send: vi.fn(async (_id: string, body: unknown) => {
          sends.push(body);
          return {
            message: message("u9", "user", [text("x")]),
            run: run({ id: `r${sends.length + 1}`, status: "queued" }),
            replayed: false,
          };
        }),
        consent: vi.fn(async () => ({})),
        answer: vi.fn(async () => ({})),
      },
    },
    agentRuns: { cancel: vi.fn(async () => run({ status: "cancelled" })) },
    plans: {
      accept: vi.fn(async () => ({})),
      generate: vi.fn(async () => ({})),
      reject: vi.fn(async () => ({})),
    },
  };
  return {
    client: client as unknown as ApiClient,
    raw: client,
    sends,
    push: (m: ConversationStreamMessage) => onMessage?.(m),
  };
}

function snapshot(
  seq: number,
  over: Partial<ReturnType<typeof state>> = {},
): ConversationStreamMessage {
  const s = state({ seq, ...over });
  return {
    type: "conversation.snapshot",
    seq,
    conversation: s.conversation,
    messages: s.messages,
    hasMoreMessages: false,
    activeRun: s.activeRun,
    plans: [],
    aliases: s.aliases,
    presence,
  };
}

const deps = {
  choice: () => ({ model: "opus" as const, effort: "high" as const }),
  saveChoice: vi.fn(),
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("ConversationController", () => {
  it("applies the stream and sends with the chosen model", async () => {
    const f = fakeClient();
    const c = new ConversationController("c1", f.client, deps);
    c.start();
    f.push(snapshot(3));
    expect(c.getSnapshot().state?.seq).toBe(3);
    await c.send({ clientMessageId: "m1", text: " merhaba ", attachments: [] });
    expect(f.sends[0]).toEqual({
      text: "merhaba",
      clientMessageId: "m1",
      model: "opus",
      effort: "high",
    });
    // Busy until the stream shows the new run.
    expect(c.getSnapshot().isReplyActive).toBe(true);
  });

  it("queues messages while a reply runs and sends them when it ends", async () => {
    const f = fakeClient();
    const c = new ConversationController("c1", f.client, deps);
    c.start();
    f.push(snapshot(1, { activeRun: run() }));
    await c.send({ clientMessageId: "q1", text: "sonra", attachments: [] });
    await c.send({ clientMessageId: "q2", text: "daha sonra", attachments: [] });
    expect(f.sends).toHaveLength(0);
    expect(c.getSnapshot().queue.map((q) => q.message.clientMessageId)).toEqual(["q1", "q2"]);
    f.push({ type: "run.updated", seq: 2, run: run({ status: "completed" }) });
    await flush();
    expect(f.sends).toHaveLength(1);
    expect(c.getSnapshot().queue.map((q) => q.message.clientMessageId)).toEqual(["q2"]);
  });

  it("'Şimdi gönder' stops the running reply and goes first", async () => {
    const f = fakeClient();
    const c = new ConversationController("c1", f.client, deps);
    c.start();
    f.push(snapshot(1, { activeRun: run() }));
    await c.send({ clientMessageId: "q1", text: "bir", attachments: [] });
    await c.send({ clientMessageId: "q2", text: "iki", attachments: [] });
    await c.sendQueuedNow("q2");
    expect(f.raw.agentRuns.cancel).toHaveBeenCalledWith("r1");
    f.push({ type: "run.updated", seq: 2, run: run({ status: "cancelled" }) });
    await flush();
    expect((f.sends[0] as { clientMessageId: string }).clientMessageId).toBe("q2");
  });

  it("reconnects from the last applied seq after a gap", () => {
    const f = fakeClient();
    const c = new ConversationController("c1", f.client, deps);
    c.start();
    f.push(snapshot(5));
    f.push({ type: "text.delta", seq: 7, messageId: "x", index: 0, text: "?" });
    expect(f.raw.conversations.watch).toHaveBeenCalledTimes(2);
    expect(f.raw.conversations.watch.mock.calls[1]?.[2]).toEqual({ after: 5 });
  });

  it("remembers when running steps started (for the elapsed timer)", () => {
    const f = fakeClient();
    let now = 1_000;
    const c = new ConversationController("c1", f.client, { ...deps, now: () => now });
    c.start();
    f.push(
      snapshot(1, {
        activeRun: run(),
        messages: [
          message("a1", "assistant", [step("s1", "generate_ai_image", "running")], {
            status: "streaming",
          }),
        ],
      }),
    );
    now = 9_000;
    f.push({ type: "text.delta", seq: 2, messageId: "a1", index: 1, text: "…" });
    expect(c.getSnapshot().stepStarts).toMatchObject({ s1: 1_000, "run-r1": 1_000 });
  });

  it("the cache keeps a few conversations open and stops the oldest idle one", () => {
    const made: ConversationController[] = [];
    const f = fakeClient();
    const cache = new ConversationCache((id) => {
      const c = new ConversationController(id, f.client, deps);
      made.push(c);
      return c;
    }, 2);
    cache.get("a");
    cache.get("b");
    cache.get("c");
    expect(cache.peek("a")).toBeUndefined();
    expect(cache.peek("c")).toBe(made[2]);
  });
});
