import { describe, expect, it } from "vitest";
import {
  AiPreferencesPut,
  AiSpendSummary,
  AiUsageRecordInput,
  aiCallCostUsd,
  ClaudeAccount,
  elevenLabsCostUsd,
  geminiCostUsd,
  geminiPriceFor,
  openAiCostUsd,
  WorkerAiSettings,
} from "../src/index.ts";

describe("AI prices (S7, U8)", () => {
  it("prices Gemini, OpenAI and ElevenLabs calls from dated tables", () => {
    expect(
      geminiCostUsd({
        model: "gemini-2.5-flash",
        promptTokens: 1_000_000,
        cachedTokens: 0,
        candidatesTokens: 1_000_000,
        thoughtsTokens: 0,
      }),
    ).toBeCloseTo(0.3 + 2.5, 9);
    expect(
      openAiCostUsd({
        model: "gpt-5",
        inputTokens: 1_000_000,
        cachedTokens: 500_000,
        outputTokens: 100_000,
      }),
    ).toBeCloseTo(0.5 * 1.25 + 0.5 * 0.125 + 0.1 * 10, 9);
    expect(elevenLabsCostUsd("eleven_multilingual_v2", 2_000)).toBeCloseTo(0.6, 9);
    expect(elevenLabsCostUsd("eleven_flash_v2_5", 2_000)).toBeCloseTo(0.3, 9);
  });

  it("does not price a sibling model with a bigger one's entry", () => {
    expect(geminiPriceFor("gemini-3.8-flash-lite")).toBeNull();
    expect(geminiPriceFor("gemini-2.5-flash-lite-preview-09-2025")?.input).toBe(0.1);
    expect(geminiPriceFor("gemini-2.5-flash-preview-09-2025")?.input).toBe(0.3);
    expect(
      openAiCostUsd({
        model: "gpt-5-chat-latest",
        inputTokens: 1,
        cachedTokens: 0,
        outputTokens: 1,
      }),
    ).toBeNull();
    expect(
      openAiCostUsd({ model: "gpt-6-sol", inputTokens: 1, cachedTokens: 0, outputTokens: 1 }),
    ).toBeNull();
  });

  it("estimates one call for any provider (subscriptions cost nothing per call)", () => {
    expect(
      aiCallCostUsd({
        provider: "gemini",
        model: "gemini-nano-banana-2.1",
        inputTokens: 1_000,
        imageOutputTokens: 1_290,
      }),
    ).toBeCloseTo((1_000 * 1.5 + 1_290 * 30) / 1e6, 9);
    expect(aiCallCostUsd({ provider: "claude", model: "opus", inputTokens: 5 })).toBe(0);
    expect(aiCallCostUsd({ provider: "openai", model: "unknown", inputTokens: 5 })).toBeNull();
  });
});

describe("S7 schemas", () => {
  it("accepts the new spend providers and the limit state, and older payloads", () => {
    expect(
      AiUsageRecordInput.parse({
        provider: "elevenlabs",
        model: "eleven_multilingual_v2",
        kind: "tts",
        inputTokens: 300,
        outputTokens: 0,
        costUsd: 0.09,
        occurredAt: "2026-11-18T10:00:00.000Z",
      }).provider,
    ).toBe("elevenlabs");
    const account = ClaudeAccount.parse({
      status: "signed_in",
      email: null,
      plan: null,
      cliVersion: null,
      loginUrl: null,
      detail: null,
      limit: {
        resetsAt: "2026-11-18T15:00:00.000Z",
        mode: "ask",
        decision: null,
        waiting: 3,
        geminiReady: true,
      },
      checkedAt: "2026-11-18T10:00:00.000Z",
    });
    expect(account.limit?.waiting).toBe(3);
    const totals = {
      costUsd: 0,
      calls: 0,
      unpricedCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      thoughtsTokens: 0,
    };
    const old = AiSpendSummary.parse({
      provider: "gemini",
      currency: "USD",
      today: totals,
      month: totals,
      byModel: [],
      budget: { monthlyUsd: null, remainingUsd: null, usedPercent: null, warning: false },
      balance: { known: false, remainingUsd: null, billingUrl: "x" },
      pricingVersion: null,
      dayStart: "2026-11-18T00:00:00.000Z",
      monthStart: "2026-11-01T00:00:00.000Z",
    });
    expect(old.byProvider).toBeUndefined();
    expect(AiPreferencesPut.parse({ claudeLimit: "wait" })).toEqual({ claudeLimit: "wait" });
    expect(() => AiPreferencesPut.parse({ claudeLimit: "maybe" })).toThrow();
    expect(
      WorkerAiSettings.parse({
        claudeLimit: "gemini",
        limitDecision: null,
        budget: {
          monthlyUsd: 20,
          stopAtBudget: true,
          spentUsd: 3.2,
          monthStart: "2026-10-31T21:00:00.000Z",
        },
      }).budget.stopAtBudget,
    ).toBe(true);
  });
});
