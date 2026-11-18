import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Content, Job, Message, Plan, SocialAccount, TurnContext } from "@studio/contract";
import { describe, expect, it } from "vitest";
import { type AgentDeps, loadAgentSettings } from "../src/agent.ts";
import { createChatTurnHandler } from "../src/chat/turn.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { checkGeminiHealth } from "../src/gemini/health.ts";
import {
  DEFAULT_GEMINI_MODELS,
  GEMINI_MODELS_CHECKED_AT,
  pickGeminiModel,
  resolveGeminiModel,
  resolveGeminiModelId,
  thinkingConfigFor,
} from "../src/gemini/models.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeBrand, fakeRun, NOW } from "./fake-api.ts";

function sseResponse(events: unknown[], splitEvery = 0): Response {
  const full = events.map((ev) => `data: ${JSON.stringify(ev)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(full);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (splitEvery > 0) {
        for (let i = 0; i < bytes.length; i += splitEvery) {
          controller.enqueue(bytes.slice(i, i + splitEvery));
        }
      } else {
        controller.enqueue(bytes);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function userMsg(text: string): Message {
  return {
    id: "msg_1",
    conversationId: "conv_1",
    role: "user",
    status: "complete",
    runId: null,
    parts: [{ type: "text", text }],
    mentions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function baseContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    run: fakeRun({ model: "gemini-flash-lite" }),
    conversation: {
      id: "conv_1",
      brandId: "brand_1",
      title: "Test",
      status: "active",
      activeRunId: "run_1",
      lastSeq: 1,
      agentSession: null,
      lastActivityAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    },
    brand: fakeBrand(),
    brandProfile: null,
    messages: [userMsg("Kasım planı yap")],
    messagesTruncated: false,
    assets: [],
    openPlan: null,
    assistantMessage: null,
    aliases: [],
    messageCount: 1,
    ...overrides,
  };
}

function jobCtx(): JobContext {
  const job: Job = {
    id: "job_1",
    type: "chat.turn",
    status: "running",
    payload: { conversationId: "conv_1", runId: "run_1" },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    jobId: "job_1",
    job,
    attempt: 1,
    workerId: "mac",
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
  };
}

function openPlanFixture(): Plan {
  return {
    id: "plan_open",
    brandId: "brand_1",
    conversationId: "conv_1",
    runId: "run_0",
    title: "Kasım Planı",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    status: "proposed",
    summary: "Özet",
    revision: 1,
    decidedAt: null,
    rejectionReason: null,
    items: [
      {
        id: "item_1",
        planId: "plan_open",
        position: 0,
        date: "2026-11-20",
        platforms: ["instagram"],
        contentType: "post",
        title: "Post 1",
        brief: "Brief 1",
        pillar: "tanıtım",
        imageSlot: "none",
        imageBrief: null,
        status: "planned",
        contentId: null,
        generation: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe("Gemini health & thinkingConfig", () => {
  it("reports api, cli, both, and none modes accurately", async () => {
    const apiOnly = await checkGeminiHealth({
      apiKey: "test-key",
      cliVersion: async () => null,
    });
    expect(apiOnly).toMatchObject({
      status: "ready",
      mode: "api",
      apiKeyConfigured: true,
      cliVersion: null,
      defaultModel: "gemini-2.5-flash-lite",
    });
    expect(apiOnly.detail).toContain("GEMINI_API_KEY hazır");

    const both = await checkGeminiHealth({
      apiKey: "test-key",
      cliVersion: async () => "0.9.1",
    });
    expect(both).toMatchObject({
      status: "ready",
      mode: "both",
      apiKeyConfigured: true,
      cliVersion: "0.9.1",
    });

    const cliOnly = await checkGeminiHealth({
      cliVersion: async () => "0.9.1",
    });
    expect(cliOnly).toMatchObject({
      status: "ready",
      mode: "cli",
      apiKeyConfigured: false,
      cliVersion: "0.9.1",
    });

    const none = await checkGeminiHealth({
      cliVersion: async () => null,
    });
    expect(none).toMatchObject({
      status: "not_configured",
      mode: "none",
      apiKeyConfigured: false,
      cliVersion: null,
    });
  });

  it("maps effort to thinkingConfig budgets respecting 2.5-pro >= 128 minimum", () => {
    expect(thinkingConfigFor("gemini-2.5-flash-lite", "low")).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfigFor("gemini-2.5-flash", "medium")).toEqual({ thinkingBudget: 2048 });
    expect(thinkingConfigFor("gemini-2.5-flash", "high")).toEqual({ thinkingBudget: 8192 });
    expect(thinkingConfigFor("gemini-2.5-pro", "low")).toEqual({ thinkingBudget: 1024 });
    expect(thinkingConfigFor("gemini-2.5-pro", "xhigh")).toEqual({ thinkingBudget: 24576 });
    expect(thinkingConfigFor("gemini-custom-future", "high")).toBeUndefined();
  });

  it("maps effort to thinkingLevel on Gemini 3 and newer (medium only on Flash)", () => {
    expect(thinkingConfigFor("gemini-3-flash-preview", "low")).toEqual({ thinkingLevel: "low" });
    expect(thinkingConfigFor("gemini-3-flash-preview", "medium")).toEqual({
      thinkingLevel: "medium",
    });
    expect(thinkingConfigFor("gemini-3.1-flash-lite", undefined)).toEqual({
      thinkingLevel: "medium",
    });
    expect(thinkingConfigFor("gemini-3.1-pro-preview", "medium")).toEqual({
      thinkingLevel: "low",
    });
    expect(thinkingConfigFor("gemini-3.1-pro-preview", "max")).toEqual({ thinkingLevel: "high" });
    expect(thinkingConfigFor("models/gemini-3.8-flash", "xhigh")).toEqual({
      thinkingLevel: "high",
    });
    expect(thinkingConfigFor("gemini-4-carbon", "medium")).toEqual({ thinkingLevel: "low" });
    expect(thinkingConfigFor("gemini-3.8-flash-tts", "high")).toBeUndefined();
    expect(thinkingConfigFor("gemini-2.0-flash", "high")).toBeUndefined();
  });
});

describe("Gemini model resolution", () => {
  const listed = [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.8-flash",
    "gemini-3.8-flash-tts",
    "gemini-3.8-flash-lite", // listed but the price table has no flash-lite 3.8 entry
    "gemini-9-pro", // listed but unpriced
    "gemini-flash-latest",
    "gemini-3.1-flash-image",
    "text-embedding-004",
  ];

  it("picks the newest priced, stable model of each tier the key lists", () => {
    expect(pickGeminiModel("gemini-flash-lite", listed)).toBe("gemini-3.5-flash-lite");
    expect(pickGeminiModel("gemini-flash", listed)).toBe("gemini-3.8-flash");
    // Stable 2.5 Pro before the 3.1 preview.
    expect(pickGeminiModel("gemini-pro", listed)).toBe("gemini-2.5-pro");
    // A preview only when the tier has no stable priced model.
    expect(pickGeminiModel("gemini-pro", ["gemini-3.1-pro-preview", "gemini-9-pro"])).toBe(
      "gemini-3.1-pro-preview",
    );
    expect(
      pickGeminiModel("gemini-flash", ["models/gemini-2.5-flash-001", "gemini-2.5-flash"]),
    ).toBe("gemini-2.5-flash");
    expect(pickGeminiModel("gemini-flash", [])).toBeUndefined();
    expect(pickGeminiModel("gemini-flash", undefined)).toBeUndefined();
  });

  it("env override → key's list → dated static fallback", () => {
    expect(resolveGeminiModel("gemini-flash", { available: [] })).toBe(
      DEFAULT_GEMINI_MODELS["gemini-flash"],
    );
    expect(resolveGeminiModel("gemini-flash", { available: listed })).toBe("gemini-3.8-flash");
    expect(
      resolveGeminiModel("gemini-flash", {
        overrides: { "gemini-flash": "gemini-custom" },
        available: listed,
      }),
    ).toBe("gemini-custom");
    expect(GEMINI_MODELS_CHECKED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("settings.geminiModels follows the vault key's list live; STUDIO_GEMINI_MODEL_* wins", () => {
    const settings = loadAgentSettings({ STUDIO_GEMINI_MODEL_PRO: "gemini-pinned-pro" });
    expect(settings.geminiModelOverrides).toEqual({ "gemini-pro": "gemini-pinned-pro" });
    expect(settings.geminiModels["gemini-flash"]).toBe("gemini-2.5-flash");
    settings.vault = { gemini: { apiKey: "fake-key", models: listed } };
    expect(settings.geminiModels["gemini-flash"]).toBe("gemini-3.8-flash");
    expect(resolveGeminiModelId("gemini-flash-lite", settings.geminiModels)).toBe(
      "gemini-3.5-flash-lite",
    );
    expect(settings.geminiModels["gemini-pro"]).toBe("gemini-pinned-pro");
    // A new key (new list object) re-resolves.
    settings.vault.gemini = { apiKey: "fake-key-2", models: ["gemini-2.5-flash"] };
    expect(settings.geminiModels["gemini-flash"]).toBe("gemini-2.5-flash");
    // Assigning an alias pins it.
    settings.geminiModels["gemini-flash"] = "gemini-assigned";
    expect(settings.geminiModels["gemini-flash"]).toBe("gemini-assigned");
    expect({ ...settings.geminiModels }).toEqual({
      "gemini-flash-lite": "gemini-2.5-flash-lite",
      "gemini-flash": "gemini-assigned",
      "gemini-pro": "gemini-pinned-pro",
    });
  });
});

describe("Direct Gemini SSE API runner & Studio tools", () => {
  it("streams non-thought text, preserves thoughtSignature verbatim, executes propose_plan, and aggregates usage", async () => {
    const { api, state } = createFakeApi({ context: baseContext() });
    const requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];

    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url, headers, body });

      if (requests.length === 1) {
        return sseResponse(
          [
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: "internal reasoning...", thought: true }],
                  },
                },
              ],
            },
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [{ text: "Planı oluşturuyorum." }],
                  },
                },
              ],
            },
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      {
                        functionCall: {
                          id: "fc_1",
                          name: "propose_plan",
                          args: {
                            title: "MTM Kasım",
                            periodStart: "2026-11-01",
                            periodEnd: "2026-11-30",
                            summary: "Strateji",
                            items: [
                              {
                                date: "2026-11-19",
                                platforms: ["instagram"],
                                contentType: "post",
                                title: "Toprak hazırlığı",
                                brief: "Kasım uygulaması.",
                                pillar: "uygulama",
                                imageSlot: "none",
                              },
                            ],
                          },
                        },
                        thoughtSignature: "sig_round_1_xyz",
                      },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 400,
                candidatesTokenCount: 60,
                cachedContentTokenCount: 100,
                thoughtsTokenCount: 25,
              },
              modelVersion: "gemini-2.5-flash-lite-001",
            },
          ],
          19, // exercise arbitrary byte-boundary SSE chunk splitting!
        );
      }

      return sseResponse([
        {
          candidates: [
            {
              content: {
                role: "model",
                parts: [{ text: "Kasım planınız hazır; onaylarsanız üretime geçebiliriz." }],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 550,
            candidatesTokenCount: 40,
            cachedContentTokenCount: 300,
          },
          modelVersion: "gemini-2.5-flash-lite-001",
        },
      ]);
    };

    const settings = loadAgentSettings({ GEMINI_API_KEY: "fake-test-gemini-key" });
    const d: AgentDeps = {
      api,
      gate: new ClaudeGate({
        runner: async () => {
          throw new Error("claude should not run");
        },
      }),
      settings,
      logger: silentLogger,
      health: () => ({ state: "unauthenticated", message: "signed out", checkedAt: NOW }),
      stateDir: mkdtempSync(path.join(tmpdir(), "gem-state-")),
      geminiFetch: fakeFetch,
      now: () => new Date("2026-11-16T09:00:00Z"),
    };

    const out = await createChatTurnHandler(d).run(
      { conversationId: "conv_1", runId: "run_1" },
      jobCtx(),
    );

    expect(out).toMatchObject({
      provider: "gemini",
      action: "plan",
      planId: "plan_1",
      planItems: 1,
      model: "gemini-2.5-flash-lite-001",
    });

    // Header auth, never query-param API key
    expect(requests[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?alt=sse",
    );
    expect(requests[0]?.headers.get("x-goog-api-key")).toBe("fake-test-gemini-key");

    // Round 2 request preserved thought & thoughtSignature verbatim and appended functionResponse!
    const round2Contents = requests[1]?.body.contents as {
      role: string;
      parts: Record<string, unknown>[];
    }[];
    const modelTurn = round2Contents.at(-2);
    expect(modelTurn?.role).toBe("model");
    expect(modelTurn?.parts).toEqual([
      { text: "internal reasoning...", thought: true },
      { text: "Planı oluşturuyorum." },
      {
        functionCall: expect.objectContaining({ name: "propose_plan" }),
        thoughtSignature: "sig_round_1_xyz",
      },
    ]);
    const fnRespTurn = round2Contents.at(-1);
    expect(fnRespTurn?.role).toBe("user");
    expect(fnRespTurn?.parts[0]).toMatchObject({
      functionResponse: {
        id: "fc_1",
        name: "propose_plan",
        response: expect.objectContaining({ ok: true, planId: "plan_1", itemCount: 1 }),
      },
    });

    // Thoughts were NOT leaked into assistant text; parts interleaved cleanly!
    expect(state.parts.map((p) => p.type)).toEqual(["text", "tool_step", "plan_proposal", "text"]);
    expect(state.parts[0]).toEqual({ type: "text", text: "Planı oluşturuyorum." });
    expect(state.parts[3]).toEqual({
      type: "text",
      text: "Kasım planınız hazır; onaylarsanız üretime geçebiliriz.",
    });

    // Aggregated usage across both rounds
    expect(state.completed[0]).toMatchObject({
      model: "gemini-2.5-flash-lite-001",
      usage: expect.objectContaining({
        inputTokens: 950,
        outputTokens: 100,
        cacheReadTokens: 400,
        calls: 2,
      }),
    });
  });

  it("automatically routes unset run.model to gemini-flash-lite when Claude is limited or signed out", async () => {
    const ctx = baseContext({ run: fakeRun({ model: null }) });
    const { api, state } = createFakeApi({ context: ctx });
    const fakeFetch: typeof fetch = async () =>
      sseResponse([
        {
          candidates: [
            { content: { role: "model", parts: [{ text: "Gemini otomatik devreye girdi." }] } },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
      ]);
    const settings = loadAgentSettings({ GEMINI_API_KEY: "fake-key" });
    const d: AgentDeps = {
      api,
      gate: new ClaudeGate({
        runner: async () => {
          throw new Error("claude should not be called");
        },
      }),
      settings,
      logger: silentLogger,
      health: () => ({
        state: "limited",
        message: "limit dolu",
        checkedAt: NOW,
        resetsAt: "2026-11-16T18:00:00Z",
      }),
      stateDir: mkdtempSync(path.join(tmpdir(), "gem-auto-")),
      geminiFetch: fakeFetch,
    };

    const out = await createChatTurnHandler(d).run(
      { conversationId: "conv_1", runId: "run_1" },
      jobCtx(),
    );
    expect(out.provider).toBe("gemini");
    expect(out.fallback).toBe("claude_limit");
    // S7: the switch is visible on the message, then the answer follows.
    expect(state.parts[0]).toMatchObject({
      type: "progress",
      stepId: "claude-fallback",
      label: "Claude sınırı doldu, Gemini Flash-Lite ile yanıtlanıyor",
    });
    expect(state.parts[1]).toEqual({ type: "text", text: "Gemini otomatik devreye girdi." });
  });

  it("executes safe brand, content, and social account tools accurately", async () => {
    const contentItem: Content = {
      id: "cnt_1",
      brandId: "brand_1",
      type: "post",
      title: "Kış Bakımı",
      brief: "Brief",
      status: "draft",
      targetPlatforms: ["instagram"],
      caption: "Kış bakımı zamanı",
      currentVersion: { id: "ver_1", version: 1, contentHash: "a".repeat(64) },
      approval: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const account: SocialAccount = {
      id: "acc_1",
      brandId: "brand_1",
      platform: "instagram",
      handle: "@mtmagro",
      externalId: null,
      status: "connected",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const ctx = baseContext({
      conversation: { ...baseContext().conversation, brandId: null },
      brand: null,
    });
    const { api, state } = createFakeApi({
      context: ctx,
      brands: [fakeBrand()],
      contents: new Map([["cnt_1", contentItem]]),
      versions: [
        {
          id: "ver_1",
          contentId: "cnt_1",
          version: 1,
          origin: "generated",
          contentHash: "a".repeat(64),
          slideCount: 1,
          note: "Temiz",
          jobId: null,
          createdAt: NOW,
          updatedAt: NOW,
          slides: [
            { html: "<html>Slide 1</html>", width: 1080, height: 1350, renderedAssetId: null },
          ],
        },
      ],
      socialAccounts: [account],
    });

    let callNum = 0;
    const fakeFetch: typeof fetch = async () => {
      callNum++;
      if (callNum === 1) {
        return sseResponse([
          {
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [
                    { functionCall: { id: "1", name: "list_brands", args: {} } },
                    {
                      functionCall: {
                        id: "2",
                        name: "set_conversation_brand",
                        args: { brandId: "mtm-agro" },
                      },
                    },
                    { functionCall: { id: "3", name: "get_brand_profile", args: {} } },
                    { functionCall: { id: "4", name: "list_contents", args: {} } },
                    {
                      functionCall: { id: "5", name: "get_content", args: { contentId: "cnt_1" } },
                    },
                    { functionCall: { id: "6", name: "list_social_accounts", args: {} } },
                  ],
                },
              },
            ],
          },
        ]);
      }
      return sseResponse([
        { candidates: [{ content: { role: "model", parts: [{ text: "Hepsi okundu." }] } }] },
      ]);
    };

    const settings = loadAgentSettings({ GEMINI_API_KEY: "fake-key" });
    await createChatTurnHandler({
      api,
      gate: new ClaudeGate({
        runner: async () => {
          throw new Error("unused");
        },
      }),
      settings,
      logger: silentLogger,
      health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
      stateDir: mkdtempSync(path.join(tmpdir(), "gem-tools-")),
      geminiFetch: fakeFetch,
    }).run({ conversationId: "conv_1", runId: "run_1" }, jobCtx());

    expect(state.conversationUpdates[0]).toEqual({
      id: "conv_1",
      input: { brandId: "brand_1" },
    });
    const labels = state.parts
      .filter((p): p is Extract<typeof p, { type: "tool_step" }> => p.type === "tool_step")
      .map((p) => [p.name, p.state, p.label]);
    expect(labels).toEqual([
      ["list_brands", "done", "Markalar okundu"],
      ["set_conversation_brand", "done", "Sohbet markası ayarlandı"],
      ["get_brand_profile", "done", "Marka profili okundu"],
      ["list_contents", "done", "Postlar okundu"],
      ["get_content", "done", "Post incelendi"],
      ["list_social_accounts", "done", "Sosyal hesaplar okundu"],
    ]);
  });

  it("handles consent-gated tools: allowed, denied, and timeout-expired", async () => {
    // 1) ALLOWED: accept_and_generate_plan + approve_content + schedule_content
    const contentItem: Content = {
      id: "cnt_1",
      brandId: "brand_1",
      type: "post",
      title: "Kış Bakımı",
      brief: "Brief",
      status: "draft",
      targetPlatforms: ["instagram"],
      caption: "",
      currentVersion: { id: "ver_1", version: 1, contentHash: "b".repeat(64) },
      approval: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const account: SocialAccount = {
      id: "acc_1",
      brandId: "brand_1",
      platform: "instagram",
      handle: "@mtmagro",
      externalId: null,
      status: "connected",
      createdAt: NOW,
      updatedAt: NOW,
    };

    {
      const ctx = baseContext({ openPlan: openPlanFixture() });
      const { api, state } = createFakeApi({
        context: ctx,
        contents: new Map([["cnt_1", contentItem]]),
        socialAccounts: [account],
      });

      // Auto-allow any pending consent card as soon as it appears!
      const autoAllow = setInterval(() => {
        for (const p of state.parts) {
          if (p.type === "consent" && p.state === "pending") {
            state.decideConsent(p.consentId, true);
          }
        }
      }, 10);

      let round = 0;
      const fakeFetch: typeof fetch = async () => {
        round++;
        if (round === 1) {
          return sseResponse([
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      { text: "İzin kartlarını gönderiyorum." },
                      { functionCall: { id: "c1", name: "accept_and_generate_plan", args: {} } },
                      {
                        functionCall: {
                          id: "c2",
                          name: "approve_content",
                          args: { contentId: "cnt_1" },
                        },
                      },
                      {
                        functionCall: {
                          id: "c3",
                          name: "schedule_content",
                          args: {
                            contentId: "cnt_1",
                            socialAccountId: "acc_1",
                            scheduledAt: "2026-11-25T09:00:00.000Z",
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ]);
        }
        return sseResponse([
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "Tüm işlemler tamamlandı." }] } },
            ],
          },
        ]);
      };

      try {
        await createChatTurnHandler({
          api,
          gate: new ClaudeGate({
            runner: async () => {
              throw new Error("unused");
            },
          }),
          settings: loadAgentSettings({ GEMINI_API_KEY: "fake-key" }),
          logger: silentLogger,
          health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
          stateDir: mkdtempSync(path.join(tmpdir(), "consent-allow-")),
          geminiFetch: fakeFetch,
          consentPollIntervalMs: 15,
          consentTimeoutMs: 2_000,
        }).run({ conversationId: "conv_1", runId: "run_1" }, jobCtx());
      } finally {
        clearInterval(autoAllow);
      }

      expect(state.planAccepts).toHaveLength(1);
      expect(state.planGenerates).toHaveLength(1);
      // Gemini chat run should NOT pass a Gemini model alias into content.generate!
      expect(state.planGenerates[0]?.input.model).toBeUndefined();
      expect(state.contentApprovals).toEqual([{ id: "cnt_1", hash: "b".repeat(64) }]);
      expect(state.schedules).toHaveLength(1);
      expect(state.parts.map((p) => p.type)).toEqual([
        "text",
        "tool_step",
        "consent",
        "tool_step",
        "consent",
        "tool_step",
        "consent",
        "text",
      ]);
    }

    // 2) DENIED: owner denies accept_and_generate_plan
    {
      const ctx = baseContext({ openPlan: openPlanFixture() });
      const { api, state } = createFakeApi({ context: ctx });
      const autoDeny = setInterval(() => {
        for (const p of state.parts) {
          if (p.type === "consent" && p.state === "pending") {
            state.decideConsent(p.consentId, false);
          }
        }
      }, 10);

      const seenResponses: unknown[] = [];
      let round = 0;
      const fakeFetch: typeof fetch = async (_url, init) => {
        round++;
        if (round === 1) {
          return sseResponse([
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      { functionCall: { id: "d1", name: "accept_and_generate_plan", args: {} } },
                    ],
                  },
                },
              ],
            },
          ]);
        }
        seenResponses.push(JSON.parse(String(init?.body)));
        return sseResponse([
          {
            candidates: [
              { content: { role: "model", parts: [{ text: "İzin verilmedi, plan bekliyor." }] } },
            ],
          },
        ]);
      };

      try {
        await createChatTurnHandler({
          api,
          gate: new ClaudeGate({
            runner: async () => {
              throw new Error("unused");
            },
          }),
          settings: loadAgentSettings({ GEMINI_API_KEY: "fake-key" }),
          logger: silentLogger,
          health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
          stateDir: mkdtempSync(path.join(tmpdir(), "consent-deny-")),
          geminiFetch: fakeFetch,
          consentPollIntervalMs: 15,
          consentTimeoutMs: 2_000,
        }).run({ conversationId: "conv_1", runId: "run_1" }, jobCtx());
      } finally {
        clearInterval(autoDeny);
      }

      expect(state.planAccepts).toEqual([]);
      const step = state.parts.find((p) => p.type === "tool_step");
      expect(step).toMatchObject({ state: "done", summary: "Kullanıcı izin vermedi" });
      const body2 = seenResponses[0] as {
        contents: { parts: { functionResponse?: { response: unknown } }[] }[];
      };
      expect(body2.contents.at(-1)?.parts[0]?.functionResponse?.response).toEqual({
        allowed: false,
        reason: "denied_by_owner",
      });
    }

    // 3) EXPIRED: consent times out while still pending
    {
      const ctx = baseContext({ openPlan: openPlanFixture() });
      const { api, state } = createFakeApi({ context: ctx });
      const seenResponses: unknown[] = [];
      let round = 0;
      const fakeFetch: typeof fetch = async (_url, init) => {
        round++;
        if (round === 1) {
          return sseResponse([
            {
              candidates: [
                {
                  content: {
                    role: "model",
                    parts: [
                      { functionCall: { id: "e1", name: "accept_and_generate_plan", args: {} } },
                    ],
                  },
                },
              ],
            },
          ]);
        }
        seenResponses.push(JSON.parse(String(init?.body)));
        return sseResponse([
          { candidates: [{ content: { role: "model", parts: [{ text: "Onay süresi doldu." }] } }] },
        ]);
      };

      await createChatTurnHandler({
        api,
        gate: new ClaudeGate({
          runner: async () => {
            throw new Error("unused");
          },
        }),
        settings: loadAgentSettings({ GEMINI_API_KEY: "fake-key" }),
        logger: silentLogger,
        health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
        stateDir: mkdtempSync(path.join(tmpdir(), "consent-exp-")),
        geminiFetch: fakeFetch,
        consentPollIntervalMs: 10,
        consentTimeoutMs: 40,
      }).run({ conversationId: "conv_1", runId: "run_1" }, jobCtx());

      const consentCard = state.parts.find((p) => p.type === "consent");
      expect(consentCard).toMatchObject({ state: "expired" });
      const body2 = seenResponses[0] as {
        contents: { parts: { functionResponse?: { response: unknown } }[] }[];
      };
      expect(body2.contents.at(-1)?.parts[0]?.functionResponse?.response).toEqual({
        allowed: false,
        reason: "expired",
      });
    }
  });
});

describe("Gemini CLI runner fallback", () => {
  it("runs headless gemini CLI wired to .gemini/settings.json + studio-mcp.mjs when STUDIO_GEMINI_MODE=cli", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-gemini-cli-"));
    const scriptMjs = path.join(dir, "fake-gemini-impl.mjs");
    writeFileSync(
      scriptMjs,
      `import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

// Read .gemini/settings.json from cwd and call list_brands via studio-mcp.mjs!
const settings = JSON.parse(readFileSync(path.join(process.cwd(), ".gemini", "settings.json"), "utf8"));
const srv = settings.mcpServers.studio;

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "init", model: "gemini-2.5-flash-lite" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "message", role: "assistant", content: "Markaları kontrol ediyorum. ", delta: true }) + "\\n");

  const child = spawn(srv.command, srv.args, {
    env: { ...process.env, ...srv.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id === 2) {
        child.stdin.end();
        process.stdout.write(JSON.stringify({ type: "message", role: "assistant", content: "CLI yanıtı tamam.", delta: true }) + "\\n");
        process.stdout.write(JSON.stringify({ type: "result", status: "success", stats: { input_tokens: 77, output_tokens: 33 } }) + "\\n");
      }
    }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_brands", arguments: {} } }) + "\\n");
});
`,
    );
    const bin = path.join(dir, "gemini");
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${scriptMjs}" "$@"\n`);
    chmodSync(bin, 0o755);

    const { api, state } = createFakeApi({
      context: baseContext(),
      brands: [fakeBrand()],
    });
    const settings = loadAgentSettings({
      STUDIO_GEMINI_BIN: bin,
      STUDIO_GEMINI_MODE: "cli",
    });

    const out = await createChatTurnHandler({
      api,
      gate: new ClaudeGate({
        runner: async () => {
          throw new Error("unused");
        },
      }),
      settings,
      logger: silentLogger,
      health: () => ({ state: "unauthenticated", message: "yok", checkedAt: NOW }),
      geminiAccount: () => ({
        status: "ready",
        mode: "cli",
        apiKeyConfigured: false,
        cliVersion: "0.9.0",
        defaultModel: "gemini-2.5-flash-lite",
        detail: "CLI hazır",
        checkedAt: NOW,
      }),
      stateDir: mkdtempSync(path.join(tmpdir(), "gem-cli-state-")),
    }).run({ conversationId: "conv_1", runId: "run_1" }, jobCtx());

    expect(out.provider).toBe("gemini");
    expect(state.parts.map((p) => p.type)).toEqual(["text", "tool_step", "text"]);
    expect(state.parts[0]).toEqual({ type: "text", text: "Markaları kontrol ediyorum. " });
    expect(state.parts[1]).toMatchObject({
      type: "tool_step",
      name: "list_brands",
      label: "Markalar okundu",
      state: "done",
    });
    expect(state.parts[2]).toEqual({ type: "text", text: "CLI yanıtı tamam." });
    expect(state.completed[0]).toMatchObject({
      model: "gemini-2.5-flash-lite",
      usage: expect.objectContaining({ inputTokens: 77, outputTokens: 33 }),
    });
  });
});
