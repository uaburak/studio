/**
 * Audit Faz 4 (production line and chat): the Claude gate at the usage limit (S7, U3) and during
 * a turn's waits (U6), the turn clock (U1), the budget and spend (S7, U8), Gemini 429 (U4), the
 * idempotent tool ledger and the paid-image consent text (U7).
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { aiCallCostUsd, openAiCostUsd, type WorkerAiSettings } from "@studio/contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { AiPolicy, BudgetExceededError } from "../src/ai/policy.ts";
import { AiUsageRecorder, geminiUsageSink } from "../src/ai/usage-recorder.ts";
import { ToolCallLedger, toolCallKey } from "../src/chat/tool-ledger.ts";
import { aiImageConsentDetail } from "../src/chat/tools.ts";
import { interruptionOf } from "../src/chat/turn.ts";
import { ClaudeError, ClaudeUsageLimitError } from "../src/claude/errors.ts";
import { ClaudeGate, type ParkInfo } from "../src/claude/gate.ts";
import { limitParkMessage } from "../src/claude/limit-text.ts";
import type { ClaudeCallOptions, ClaudeCallResult } from "../src/claude/runner.ts";
import { startTurnTimer, TurnWaits } from "../src/claude/turn-waits.ts";
import { GeminiError } from "../src/gemini/errors.ts";
import {
  callGeminiJson,
  callStructuredAi,
  resolveStructuredRoute,
} from "../src/gemini/json-call.ts";
import { rateLimitDelayMs } from "../src/gemini/retry.ts";
import { silentLogger } from "../src/log.ts";
import { ProviderError } from "../src/providers/cli.ts";
import { runOpenAiTurn } from "../src/providers/openai.ts";
import { NOW } from "./fake-api.ts";

const ok = (label: string): ClaudeCallResult => ({
  output: { label },
  text: "",
  model: "claude-opus-5-5",
  cliVersion: "2.1.292",
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    durationMs: 1,
    durationApiMs: 1,
    wallMs: 1,
  },
  rateLimit: undefined,
});
const call = (label: string, extra: Partial<ClaudeCallOptions> = {}): ClaudeCallOptions => ({
  label,
  system: "s",
  content: [],
  ...extra,
});

function settings(
  overrides: Partial<Omit<WorkerAiSettings, "budget">> & {
    budget?: Partial<WorkerAiSettings["budget"]>;
  } = {},
): WorkerAiSettings {
  return {
    claudeLimit: overrides.claudeLimit ?? "ask",
    limitDecision: overrides.limitDecision ?? null,
    budget: {
      monthlyUsd: null,
      stopAtBudget: false,
      spentUsd: 0,
      monthStart: new Date(2026, 10, 1).toISOString(),
      ...overrides.budget,
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ClaudeGate at the usage limit (S7, U3)", () => {
  it("hands a fallback-capable call back at once when the choice is Gemini", async () => {
    let calls = 0;
    const gate = new ClaudeGate({
      limitChoice: () => "gemini",
      runner: async () => {
        calls++;
        throw new ClaudeUsageLimitError("limit", new Date(Date.now() + 60_000), "rate_limit_event");
      },
    });
    // The call hits the limit, parks the gate and is handed back instead of sleeping.
    await expect(gate.call(call("a"), { fallback: true })).rejects.toBeInstanceOf(
      ClaudeUsageLimitError,
    );
    expect(calls).toBe(1);
    // The next one does not even reach the CLI.
    await expect(gate.call(call("b"), { fallback: true })).rejects.toBeInstanceOf(
      ClaudeUsageLimitError,
    );
    expect(calls).toBe(1);
  });

  it("parks in ask mode, tells why, and switches when the owner answers Gemini", async () => {
    let choice: "ask" | "gemini" = "ask";
    const gate = new ClaudeGate({
      limitChoice: () => choice,
      runner: async () => ok("x"),
      maxSleepChunkMs: 60_000,
    });
    gate.park(new Date(Date.now() + 3_600_000), "limit", "rate_limit_event");
    const parks: ParkInfo[] = [];
    const pending = gate.call(call("job"), { fallback: true, onPark: (i) => void parks.push(i) });
    await vi.waitFor(() => expect(parks).toHaveLength(1));
    expect(parks[0]).toMatchObject({ choice: "ask", canFallback: true });
    expect(gate.status().parked).toBe(1);
    expect(limitParkMessage(parks[0] as ParkInfo)).toContain("Seçiminiz bekleniyor");
    choice = "gemini";
    gate.wake();
    await expect(pending).rejects.toBeInstanceOf(ClaudeUsageLimitError);
    expect(gate.status().parked).toBe(0);
  });

  it("keeps waiting in wait mode and runs the call after the reset", async () => {
    let now = 1_000_000;
    const gate = new ClaudeGate({
      limitChoice: () => "wait",
      runner: async () => ok("x"),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      resetSlackMs: 0,
    });
    gate.park(new Date(now + 120_000), "limit", "rate_limit_event");
    const parks: ParkInfo[] = [];
    const res = await gate.call(call("job"), { fallback: true, onPark: (i) => void parks.push(i) });
    expect(res.output).toEqual({ label: "x" });
    expect(parks[0]?.choice).toBe("wait");
    expect(limitParkMessage(parks[0] as ParkInfo)).toMatch(/civarında devam edecek/);
  });

  it("a call that cannot fall back waits even when the choice is Gemini", async () => {
    let now = 1_000_000;
    const gate = new ClaudeGate({
      limitChoice: () => "gemini",
      runner: async () => ok("x"),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      resetSlackMs: 0,
    });
    gate.park(new Date(now + 60_000), "limit", "rate_limit_event");
    const parks: ParkInfo[] = [];
    await gate.call(call("explicit-opus"), { onPark: (i) => void parks.push(i) });
    expect(limitParkMessage(parks[0] as ParkInfo)).toContain("Gemini'ye geçemiyor");
  });
});

describe("ClaudeGate during a turn's waits (U6)", () => {
  it("gives the slot back while the turn waits and takes it again before going on", async () => {
    const waits = new TurnWaits();
    const order: string[] = [];
    let releaseWait!: () => void;
    const gate = new ClaudeGate({
      concurrency: 1,
      runner: async (o) => {
        if (o.label === "chat") {
          order.push("chat start");
          // The chat's tool waits for the owner (ask_user).
          await waits.around(
            () =>
              new Promise<void>((r) => {
                releaseWait = r;
              }),
          );
          order.push("chat continues");
          return ok("chat");
        }
        order.push(`${o.label} runs`);
        await new Promise((r) => setTimeout(r, 5));
        order.push(`${o.label} done`);
        return ok(o.label);
      },
    });
    const chat = gate.call(call("chat", { waits }));
    await vi.waitFor(() => expect(order).toContain("chat start"));
    // Generation is not blocked by the waiting chat.
    await gate.call(call("generate"));
    expect(order).toEqual(["chat start", "generate runs", "generate done"]);
    releaseWait();
    await chat;
    expect(order.at(-1)).toBe("chat continues");
    expect(gate.status().running).toBe(0);
  });

  it("a chat coming back from its wait goes before the queued generation calls", async () => {
    const waits = new TurnWaits();
    const order: string[] = [];
    let releaseWait!: () => void;
    let releaseFirst!: () => void;
    const gate = new ClaudeGate({
      concurrency: 1,
      runner: async (o) => {
        if (o.label === "chat") {
          await waits.around(() => new Promise<void>((r) => (releaseWait = r)));
          order.push("chat continues");
          return ok("chat");
        }
        order.push(`${o.label} runs`);
        if (o.label === "gen1") await new Promise<void>((r) => (releaseFirst = r));
        return ok(o.label);
      },
    });
    const chat = gate.call(call("chat", { waits }));
    await vi.waitFor(() => expect(releaseWait).toBeTypeOf("function"));
    const gen1 = gate.call(call("gen1"));
    await vi.waitFor(() => expect(order).toContain("gen1 runs"));
    const gen2 = gate.call(call("gen2"));
    releaseWait();
    await vi.waitFor(() => expect(gate.status().queued).toBe(2));
    releaseFirst();
    await Promise.all([chat, gen1, gen2]);
    expect(order).toEqual(["gen1 runs", "chat continues", "gen2 runs"]);
  });
});

describe("turn clock (U1)", () => {
  it("does not count the waits towards the time cap", async () => {
    vi.useFakeTimers();
    const waits = new TurnWaits();
    let fired = false;
    const timer = startTurnTimer({ timeoutMs: 1_000, waits, onTimeout: () => (fired = true) });
    vi.advanceTimersByTime(600);
    let done!: () => void;
    const waiting = waits.around(() => new Promise<void>((r) => (done = r)));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    vi.advanceTimersByTime(10_000); // a long ask_user
    expect(fired).toBe(false);
    done();
    await waiting;
    vi.advanceTimersByTime(399);
    expect(fired).toBe(false);
    vi.advanceTimersByTime(2);
    expect(fired).toBe(true);
    timer.cancel();
  });

  it("says in Turkish how to go on after an interruption", () => {
    const now = new Date(NOW);
    expect(interruptionOf(new ClaudeError("timeout", "x"), 900_000, now)).toContain(
      '"devam et" yazın',
    );
    expect(interruptionOf(new ClaudeError("timeout", "x"), 900_000, now)).toContain("15 dakika");
    expect(
      interruptionOf(new ClaudeUsageLimitError("l", new Date(NOW), "message"), 900_000, now),
    ).toContain("Claude kullanım sınırı doldu");
    expect(interruptionOf(new GeminiError("transient", "x"), 900_000, now)).toContain(
      "bağlantı koptu",
    );
    expect(interruptionOf(new ClaudeError("output", "x"), 900_000, now)).toBeNull();
  });
});

describe("AiPolicy (S7)", () => {
  it("uses the owner's answer until the reset, then the mode", () => {
    let now = new Date("2026-11-18T10:00:00Z");
    const policy = new AiPolicy({ now: () => now });
    expect(policy.limitChoice()).toBe("ask");
    policy.apply(
      settings({
        claudeLimit: "ask",
        limitDecision: {
          choice: "gemini",
          until: "2026-11-18T12:00:00Z",
          decidedAt: "2026-11-18T10:00:00Z",
        },
      }),
    );
    expect(policy.limitChoice()).toBe("gemini");
    now = new Date("2026-11-18T12:00:01Z");
    expect(policy.limitChoice()).toBe("ask");
    policy.apply(settings({ claudeLimit: "wait" }));
    expect(policy.limitChoice()).toBe("wait");
  });

  it("stops paid calls at the budget, counting what this worker spent since the read", () => {
    const now = new Date(2026, 10, 18, 12);
    const policy = new AiPolicy({ now: () => now });
    policy.apply(settings({ budget: { monthlyUsd: 10, stopAtBudget: true, spentUsd: 9.5 } }));
    expect(() => policy.assertBudget()).not.toThrow();
    policy.addSpend(0.6);
    expect(() => policy.assertBudget()).toThrow(BudgetExceededError);
    try {
      policy.assertBudget();
    } catch (error) {
      expect((error as Error).message).toContain("Aylık yapay zekâ bütçesi doldu");
      expect((error as Error).message).toContain("10,00 $");
    }
    // Without "bütçe dolunca dur" the budget only warns (in the app).
    policy.apply(settings({ budget: { monthlyUsd: 10, stopAtBudget: false, spentUsd: 50 } }));
    expect(() => policy.assertBudget()).not.toThrow();
  });

  it("starts a new month at zero", () => {
    let now = new Date(2026, 10, 30, 23);
    const policy = new AiPolicy({ now: () => now });
    policy.apply(settings({ budget: { monthlyUsd: 5, stopAtBudget: true, spentUsd: 6 } }));
    expect(() => policy.assertBudget()).toThrow(BudgetExceededError);
    now = new Date(2026, 11, 1, 1);
    expect(policy.spentUsd()).toBe(0);
    expect(() => policy.assertBudget()).not.toThrow();
  });
});

describe("spend recording (U8)", () => {
  it("records OpenAI and ElevenLabs calls with dated prices and counts them for the budget", async () => {
    const sent: unknown[] = [];
    const policy = new AiPolicy();
    policy.apply(settings({ budget: { monthlyUsd: 1, stopAtBudget: true, spentUsd: 0 } }));
    const recorder = new AiUsageRecorder({
      api: {
        client: {
          workerAi: {
            reportUsage: async (input: { records: unknown[] }) => {
              sent.push(...input.records);
              return { stored: input.records.length };
            },
          },
        },
      } as never,
      logger: silentLogger,
      policy,
      flushDelayMs: 60_000,
    });
    recorder.openai(
      { model: "gpt-5-mini", inputTokens: 1_000_000, cachedTokens: 0, outputTokens: 100_000 },
      { kind: "chat", runId: "run_1" },
    );
    recorder.elevenLabs({ model: "eleven_multilingual_v2", characters: 1_000 }, { kind: "tts" });
    recorder.openai(
      { model: "gpt-6-sol", inputTokens: 10, cachedTokens: 0, outputTokens: 10 },
      { kind: "chat" },
    );
    expect(recorder.pendingCostUsd()).toBeCloseTo(0.25 + 0.2 + 0.3, 6);
    expect(policy.spentUsd()).toBeCloseTo(0.75, 6);
    await recorder.flush();
    expect(sent).toMatchObject([
      { provider: "openai", model: "gpt-5-mini", costUsd: expect.closeTo(0.45, 6) },
      { provider: "elevenlabs", inputTokens: 1_000, costUsd: expect.closeTo(0.3, 6) },
      // Not in the table yet: recorded unpriced, never guessed.
      { provider: "openai", model: "gpt-6-sol", costUsd: null },
    ]);
    // The sink of a Gemini job checks the same budget.
    policy.addSpend(0.5);
    const sink = geminiUsageSink(recorder, { kind: "generate" });
    expect(() => sink?.assertBudget?.()).toThrow(BudgetExceededError);
  });

  it("prices models by their own entry (a -lite or -mini is not its bigger sibling)", () => {
    expect(
      aiCallCostUsd({ provider: "gemini", model: "gemini-3.8-flash-lite", inputTokens: 1000 }),
    ).toBeNull();
    expect(
      openAiCostUsd({
        model: "gpt-5-mini-2025-08-07",
        inputTokens: 1e6,
        cachedTokens: 0,
        outputTokens: 0,
      }),
    ).toBeCloseTo(0.25, 9);
    expect(aiCallCostUsd({ provider: "claude", model: "opus", inputTokens: 1e6 })).toBe(0);
  });
});

describe("Gemini 429 (U4)", () => {
  const body = (text: string) =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text }] } }],
        modelVersion: "gemini-2.5-flash",
      }),
      { status: 200 },
    );
  const tooMany = (delay = "2s") =>
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          message: "Resource exhausted",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: delay }],
        },
      }),
      { status: 429 },
    );

  it("waits as long as Google says and asks again", async () => {
    const responses = [tooMany("3s"), tooMany("1.5s"), body('{"ok":true}')];
    const sleeps: number[] = [];
    const res = await callGeminiJson({
      apiKey: "k-123456",
      modelId: "gemini-2.5-flash",
      system: "s",
      content: [{ type: "text", text: "t" }],
      fetch: async () => responses.shift() as Response,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(res.output).toEqual({ ok: true });
    expect(sleeps).toEqual([3_250, 1_750]);
  });

  it("is a rate-limit error only after several tries, and a long announced wait is not waited", async () => {
    let calls = 0;
    await expect(
      callGeminiJson({
        apiKey: "k-123456",
        modelId: "gemini-2.5-flash",
        system: "s",
        content: [{ type: "text", text: "t" }],
        fetch: async () => {
          calls++;
          return tooMany("1s");
        },
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ code: "rate_limit" });
    expect(calls).toBe(4);
    expect(rateLimitDelayMs(undefined, JSON.stringify({}), 0)).toBe(2_000);
    expect(
      rateLimitDelayMs(
        undefined,
        JSON.stringify({
          error: { details: [{ "@type": "x.RetryInfo", retryDelay: "3600s" }] },
        }),
        0,
      ),
    ).toBeNull();
  });

  it("checks the budget before a paid request", async () => {
    let calls = 0;
    const sink = Object.assign(() => {}, {
      assertBudget: () => {
        throw new BudgetExceededError(12, 10);
      },
    });
    await expect(
      callGeminiJson({
        apiKey: "k-123456",
        modelId: "gemini-2.5-flash",
        system: "s",
        content: [{ type: "text", text: "t" }],
        onUsage: sink,
        fetch: async () => {
          calls++;
          return body("{}");
        },
      }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toBe(0);
  });
});

describe("structured calls at Claude's limit (S7, U3)", () => {
  const geminiDesign = async () =>
    new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"title":"Gemini"}' }] } }],
        modelVersion: "gemini-2.5-flash",
      }),
      { status: 200 },
    );

  it("switches to Gemini with a note when the owner's choice is Gemini (it used to sleep for hours)", async () => {
    const agentSettings = loadAgentSettings({ GEMINI_API_KEY: "gem-key-123" });
    const gate = new ClaudeGate({
      limitChoice: () => "gemini",
      runner: async () => {
        throw new ClaudeUsageLimitError("limit", new Date(Date.now() + 3_600_000), "message");
      },
    });
    const route = resolveStructuredRoute({
      settings: agentSettings,
      claudeHealth: { state: "ok", message: "ok", checkedAt: NOW },
      limitChoice: "gemini",
    });
    expect(route).toMatchObject({ provider: "claude", canFallbackToGemini: true });
    const fallbacks: unknown[] = [];
    const res = await callStructuredAi({
      label: "x",
      system: "s",
      content: [{ type: "text", text: "t" }],
      schema: {},
      route,
      gate,
      settings: agentSettings,
      timeoutMs: 1_000,
      signal: new AbortController().signal,
      geminiFetch: geminiDesign,
      onFallback: (f) => void fallbacks.push(f),
    });
    expect(res.provider).toBe("gemini");
    expect(res.fallback?.reason).toBe("claude_limit");
    expect(fallbacks).toHaveLength(1);
  });

  it("stays on Claude when Claude is already limited and the owner asks or waits", () => {
    const agentSettings = loadAgentSettings({ GEMINI_API_KEY: "gem-key-123" });
    const limited = {
      state: "limited" as const,
      message: "limit",
      checkedAt: NOW,
      resetsAt: "2026-11-18T15:00:00Z",
    };
    expect(
      resolveStructuredRoute({
        settings: agentSettings,
        claudeHealth: limited,
        limitChoice: "ask",
      }),
    ).toMatchObject({ provider: "claude", canFallbackToGemini: true });
    expect(
      resolveStructuredRoute({
        settings: agentSettings,
        claudeHealth: limited,
        limitChoice: "gemini",
      }),
    ).toMatchObject({ provider: "gemini", fallback: { reason: "claude_limit" } });
    // A Claude model named by the owner is never replaced.
    expect(
      resolveStructuredRoute({
        settings: agentSettings,
        claudeHealth: limited,
        limitChoice: "gemini",
        requestedModel: "opus",
      }),
    ).toMatchObject({ provider: "claude", canFallbackToGemini: false });
  });
});

describe("idempotent tools (U7)", () => {
  it("finds the same call by its arguments, within the window, across restarts", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ledger-"));
    const file = path.join(dir, "tool-calls.json");
    let now = new Date("2026-11-18T10:00:00Z");
    const ledger = new ToolCallLedger(file, () => now);
    const key = toolCallKey("generate_post", { brief: "Hasat", brandId: "b1", title: undefined });
    expect(key).toBe(toolCallKey("generate_post", { brandId: "b1", brief: "Hasat" }));
    expect(key).not.toBe(toolCallKey("generate_post", { brandId: "b1", brief: "Hasat 2" }));
    await ledger.put({ key, tool: "generate_post", callId: "toolu_1", data: { contentId: "c1" } });
    expect((await ledger.find(key))?.data).toEqual({ contentId: "c1" });
    expect(await ledger.find("other")).toBeNull();
    // A new worker process reads the file.
    const reopened = new ToolCallLedger(file, () => now);
    expect(await reopened.find(key)).not.toBeNull();
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(1);
    now = new Date("2026-11-18T17:00:00Z");
    expect(await reopened.find(key)).toBeNull();
  });

  it("shows the model and the estimated cost on the paid image's consent card", () => {
    const detail = aiImageConsentDetail({
      model: "gemini-nano-banana-2.1",
      prompt: "Sabah ışığında tarla",
      aspectRatio: "4:5",
      imageSize: "2K",
      references: 1,
      preserveLabel: true,
    });
    expect(detail).toContain("Model: gemini-nano-banana-2.1 · 2K · 4:5 · tahmini ≈ 0,040 $");
    expect(detail).toContain("ürün etiketi korunacak");
    expect(
      aiImageConsentDetail({
        model: "unknown-image",
        prompt: "x",
        aspectRatio: "1:1",
        imageSize: "1K",
        references: 0,
        preserveLabel: false,
      }),
    ).toContain("tahmini tutar bilinmiyor");
  });
});

describe("OpenAI turns (U8)", () => {
  const executor = {
    geminiFunctionDeclarations: () => [],
    execute: async () => ({ data: {}, isError: false }),
  } as never;

  it("reports each request's tokens and checks the budget first", async () => {
    const samples: unknown[] = [];
    let checks = 0;
    const res = await runOpenAiTurn({
      apiKey: "sk-test-123456",
      model: "gpt-5-mini",
      system: "s",
      contents: [{ role: "user", parts: [{ text: "merhaba" }] }],
      executor,
      beforeRequest: () => void checks++,
      onUsage: (s) => void samples.push(s),
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: "resp_1",
            model: "gpt-5-mini",
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "Selam" }] }],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 40 },
              output_tokens_details: { reasoning_tokens: 5 },
            },
          }),
          { status: 200 },
        ),
    });
    expect(res.model).toBe("gpt-5-mini");
    expect(checks).toBe(1);
    expect(samples).toEqual([
      {
        model: "gpt-5-mini",
        inputTokens: 100,
        cachedTokens: 40,
        outputTokens: 20,
        reasoningTokens: 5,
      },
    ]);
  });

  it("has a time cap now (it had none)", async () => {
    await expect(
      runOpenAiTurn({
        apiKey: "sk-test-123456",
        model: "gpt-5-mini",
        system: "s",
        contents: [{ role: "user", parts: [{ text: "merhaba" }] }],
        executor,
        timeoutMs: 30,
        fetch: (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          }),
      }),
    ).rejects.toMatchObject({ code: "timeout", provider: "openai" });
    expect(new ProviderError("openai", "timeout", "x").code).toBe("timeout");
  });
});
