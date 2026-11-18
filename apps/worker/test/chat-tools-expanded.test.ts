import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  Content,
  ConversationAlias,
  Job,
  Message,
  SocialAccount,
  TurnContext,
} from "@studio/contract";
import { describe, expect, it } from "vitest";
import { loadAgentSettings } from "../src/agent.ts";
import { createChatTurnHandler } from "../src/chat/turn.ts";
import { ClaudeGate } from "../src/claude/gate.ts";
import { silentLogger } from "../src/log.ts";
import type { JobContext } from "../src/registry.ts";
import { createFakeApi, fakeRun, NOW } from "./fake-api.ts";

function sseResponse(events: unknown[]): Response {
  const full = events.map((ev) => `data: ${JSON.stringify(ev)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(full);
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
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

function jobCtx(): JobContext {
  const job: Job = {
    id: "job_chat_exp",
    type: "chat.turn",
    status: "running",
    payload: { conversationId: "conv_1", runId: "run_1" },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    jobId: job.id,
    job,
    attempt: 1,
    workerId: "mac",
    signal: new AbortController().signal,
    progress: () => {},
    log: () => {},
  };
}

describe("Expanded Studio Chat Agent Tools (Wave 2A)", () => {
  it("orchestrates create_brand, analyze_brand, generate_ai_image (@alias + preserveProductLabel), fill_post_slot, export_content_pdf, and consent-gated publish_now", async () => {
    const context: TurnContext = {
      run: fakeRun({ model: "gemini-flash-lite" }),
      conversation: {
        id: "conv_1",
        brandId: null,
        title: "Yeni Marka Kurulumu",
        status: "active",
        activeRunId: "run_1",
        lastSeq: 1,
        agentSession: null,
        lastActivityAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      },
      brand: null,
      brandProfile: null,
      messages: [userMsg("Yeni markayı kur, görsel üret ve LinkedIn'de yayınla")],
      messagesTruncated: false,
      assets: [],
      openPlan: null,
      assistantMessage: null,
      aliases: [
        {
          id: "alias_pack",
          conversationId: "conv_1",
          alias: "urun-paketi",
          previousAliases: [],
          assetId: "asset_pack_1",
          kind: "image",
          mimeType: "image/png",
          width: 1200,
          height: 1200,
          filename: "paket.png",
          contentPath: "/api/assets/asset_pack_1/content",
          objectKey: "brands/brand_1/paket.png",
          messageId: "msg_1",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      messageCount: 1,
    };

    const aliasRecord: ConversationAlias = {
      id: "alias_pack",
      conversationId: "conv_1",
      alias: "urun-paketi",
      previousAliases: [],
      assetId: "asset_pack_1",
      kind: "image",
      mimeType: "image/png",
      width: 1200,
      height: 1200,
      filename: "paket.png",
      contentPath: "/api/assets/asset_pack_1/content",
      messageId: "msg_1",
      createdAt: NOW,
      updatedAt: NOW,
    };

    const contentItem: Content = {
      id: "cnt_1",
      brandId: "brand_1",
      type: "carousel",
      title: "Ürün Tanıtım Carousel",
      brief: "Tanıtım",
      status: "in_review",
      targetPlatforms: ["linkedin", "instagram"],
      caption: "Yeni sezon.",
      currentVersion: { id: "ver_1", version: 1, contentHash: "d".repeat(64) },
      approval: null,
      createdAt: NOW,
      updatedAt: NOW,
    };

    const account: SocialAccount = {
      id: "acc_li",
      brandId: "brand_1",
      platform: "linkedin",
      handle: "Burak Koç",
      externalId: "urn:li:person:bkoc",
      status: "connected",
      createdAt: NOW,
      updatedAt: NOW,
    };

    const { api, state } = createFakeApi({
      context,
      contents: new Map([["cnt_1", contentItem]]),
      socialAccounts: [account],
      aliases: new Map([["conv_1", [aliasRecord]]]),
    });

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
                    {
                      functionCall: {
                        id: "t1",
                        name: "create_brand",
                        args: { name: "MTM Agro", defaultLanguage: "tr" },
                      },
                    },
                    {
                      functionCall: {
                        id: "t2",
                        name: "analyze_brand",
                        args: { notes: "Kurumsal yeşil kimlik", autoApprove: true },
                      },
                    },
                    {
                      functionCall: {
                        id: "t3",
                        name: "generate_ai_image",
                        args: {
                          prompt: "Sabah ışığında buğday tarlası",
                          aspectRatio: "4:5",
                          imageSize: "2K",
                          referenceAliases: ["@urun-paketi"],
                          preserveProductLabel: true,
                          targetContentId: "cnt_1",
                          targetSlotId: "hero-slot",
                        },
                      },
                    },
                    {
                      functionCall: {
                        id: "t4",
                        name: "fill_post_slot",
                        args: {
                          contentId: "cnt_1",
                          slotId: "hero-slot",
                          alias: "@urun-paketi",
                        },
                      },
                    },
                    {
                      functionCall: {
                        id: "t5",
                        name: "export_content_pdf",
                        args: { contentId: "cnt_1" },
                      },
                    },
                    {
                      functionCall: {
                        id: "t6",
                        name: "publish_now",
                        args: {
                          contentId: "cnt_1",
                          socialAccountId: "acc_li",
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
            {
              content: {
                role: "model",
                parts: [{ text: "Marka kuruldu, görseller ve LinkedIn yayını başlatıldı." }],
              },
            },
          ],
        },
      ]);
    };

    try {
      const out = await createChatTurnHandler({
        api,
        gate: new ClaudeGate({
          runner: async () => {
            throw new Error("unused");
          },
        }),
        settings: loadAgentSettings({ GEMINI_API_KEY: "fake-key" }),
        logger: silentLogger,
        health: () => ({ state: "ok", message: "ok", checkedAt: NOW }),
        stateDir: mkdtempSync(path.join(tmpdir(), "chat-exp-")),
        geminiFetch: fakeFetch,
        consentPollIntervalMs: 15,
        consentTimeoutMs: 2000,
      }).run({ conversationId: "conv_1", runId: "run_1" }, jobCtx());

      expect(out.toolCalls).toEqual([
        "create_brand",
        "analyze_brand",
        "generate_ai_image",
        "fill_post_slot",
        "export_content_pdf",
        "publish_now",
      ]);
    } finally {
      clearInterval(autoAllow);
    }

    // 1. create_brand created `mtm-agro` and attached it to conv_1
    expect(state.brands[0]).toMatchObject({ id: "brand_1", name: "MTM Agro", slug: "mtm-agro" });
    expect(state.conversationUpdates[0]).toEqual({
      id: "conv_1",
      input: { brandId: "brand_1" },
    });

    // 2..6. Queued jobs in exact order:
    expect(state.jobs.map((j) => [j.type, j.payload])).toEqual([
      [
        "brand.analyze",
        {
          notes: "Kurumsal yeşil kimlik",
          includeApprovedContentFeedback: true,
          autoApprove: true,
        },
      ],
      [
        "image.generate",
        {
          prompt: "Sabah ışığında buğday tarlası",
          aspectRatio: "4:5",
          imageSize: "2K",
          referenceAssetIds: ["asset_pack_1"],
          preserveProductLabel: true,
          targetContentId: "cnt_1",
          targetSlotId: "hero-slot",
        },
      ],
      [
        "content.render",
        {
          format: "jpeg",
          slotAssignments: { "hero-slot": "asset_pack_1" },
        },
      ],
      [
        "content.render",
        {
          format: "pdf",
        },
      ],
      [
        "schedule.publish",
        {
          scheduleId: "sched_1",
        },
      ],
    ]);

    // `publish_now` auto-approved the in_review content after owner consent and created sched_1
    expect(state.contentApprovals).toEqual([{ id: "cnt_1", hash: "d".repeat(64) }]);
    expect(state.schedules).toHaveLength(1);
    const consentPart = state.parts.find((p) => p.type === "consent" && p.tool === "publish_now");
    expect(consentPart).toMatchObject({ tool: "publish_now", state: "allowed" });
    // The paid AI image asked first, with its model and estimated cost (U7).
    const imageConsent = state.parts.find(
      (p) => p.type === "consent" && p.tool === "generate_ai_image",
    );
    expect(imageConsent).toMatchObject({ state: "allowed", title: "AI görsel üret (ücretli)" });
    expect(imageConsent?.type === "consent" && imageConsent.detail).toContain("tahmini");
  });
});
