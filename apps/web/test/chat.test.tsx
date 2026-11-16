import type { Conversation, ConversationStreamMessage, Message, Plan } from "@studio/contract";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { brand, createMockApi, page, renderRoute } from "./helpers.tsx";

const T = "2026-11-16T10:00:00.000Z";

const convFixture = (patch: Partial<Conversation> = {}): Conversation => ({
  id: "conv-1",
  brandId: "brand-1",
  title: "Kasım İçerik Planı",
  status: "active",
  activeRunId: null,
  lastSeq: 1,
  agentSession: null,
  lastActivityAt: T,
  createdAt: T,
  updatedAt: T,
  ...patch,
});

const planFixture = (patch: Partial<Plan> = {}): Plan => ({
  id: "plan-1",
  brandId: "brand-1",
  conversationId: "conv-1",
  runId: "run-1",
  title: "Kasım Ayı Lansman Planı",
  periodStart: "2026-11-16",
  periodEnd: "2026-11-30",
  status: "proposed",
  summary: "İki haftalık ürün tanıtım planı.",
  revision: 2,
  decidedAt: null,
  rejectionReason: null,
  items: [
    {
      id: "item-1",
      planId: "plan-1",
      position: 0,
      date: "2026-11-20",
      platforms: ["instagram", "linkedin"],
      contentType: "carousel",
      title: "Bor ve Çinko Rehberi",
      brief: "5 slaytlık eğitici carousel",
      pillar: "Eğitim",
      imageSlot: "ai_generate",
      imageBrief: "Tarla görseli",
      status: "planned",
      contentId: null,
      generation: null,
      createdAt: T,
      updatedAt: T,
    },
  ],
  createdAt: T,
  updatedAt: T,
  ...patch,
});

describe("Wecra-style Chat & Plan Surface (/chat)", () => {
  it("renders tool_step rows, handles consent Allow/Deny, accepts & generates plans with selected model/effort, and shows /usage", async () => {
    const api = createMockApi();
    api.brands.list.mockImplementation(() => page([brand()]));

    const conv = convFixture();
    const plan = planFixture();

    const assistantMessage: Message = {
      id: "msg-assistant-1",
      conversationId: "conv-1",
      role: "assistant",
      status: "complete",
      runId: "run-1",
      parts: [
        {
          type: "tool_step",
          id: "step-1",
          name: "propose_plan",
          label: "Plan hazırlandı",
          state: "done",
          summary: "1 içerik önerildi",
        },
        {
          type: "consent",
          consentId: "consent-1",
          tool: "schedule_post",
          title: "Postu Instagram için zamanla",
          detail: "20 Kasım 10:00 tarihinde paylaşılacak",
          state: "pending",
          decidedAt: null,
        },
        {
          type: "plan_proposal",
          planId: "plan-1",
        },
      ],
      mentions: [],
      createdAt: T,
      updatedAt: T,
    };

    let pushFrame: ((msg: ConversationStreamMessage) => void) | undefined;
    api.conversations.list.mockImplementation(() => page([conv]));
    api.conversations.watch.mockImplementation((_id, handlers) => {
      pushFrame = handlers.onMessage;
      handlers.onStatus?.("open");
      return { close: vi.fn(), lastSeq: 1 };
    });

    api.conversations.messages.consent.mockImplementation(async (_cid, _mid, input) => ({
      message: {
        ...assistantMessage,
        parts: assistantMessage.parts.map((p) =>
          p.type === "consent" && p.consentId === input.consentId
            ? {
                ...p,
                state: input.allow ? ("allowed" as const) : ("denied" as const),
                decidedAt: T,
              }
            : p,
        ),
      },
    }));

    const acceptedPlan = planFixture({
      status: "accepted",
      items: plan.items.map((it) => ({ ...it, status: "accepted", contentId: "content-101" })),
    });
    api.plans.accept.mockResolvedValue(acceptedPlan);
    api.plans.generate.mockResolvedValue({
      plan: acceptedPlan,
      jobs: [
        {
          id: "job-gen-1",
          type: "content.generate",
          status: "queued",
          payload: {},
          brandId: "brand-1",
          contentId: "content-101",
          createdAt: T,
          updatedAt: T,
        },
      ],
    });

    api.conversations.runs.mockResolvedValue({
      items: [
        {
          id: "run-1",
          conversationId: "conv-1",
          triggerMessageId: "msg-u-1",
          jobId: "job-1",
          status: "completed",
          attempt: 1,
          model: "sonnet",
          effort: "high",
          usage: { inputTokens: 1200, outputTokens: 450, costUsd: 0.012, durationMs: 4200 },
          error: null,
          createdAt: T,
          updatedAt: T,
          startedAt: T,
          finishedAt: T,
        },
      ],
      nextCursor: null,
    });

    const user = userEvent.setup();
    renderRoute("/chat/conv-1", api);

    await act(async () => {
      pushFrame?.({
        type: "conversation.snapshot",
        seq: 1,
        conversation: conv,
        messages: [assistantMessage],
        hasMoreMessages: false,
        activeRun: null,
        plans: [plan],
        aliases: [
          {
            id: "alias-1",
            conversationId: "conv-1",
            alias: "image",
            previousAliases: [],
            assetId: "asset-1",
            kind: "image",
            mimeType: "image/jpeg",
            width: 1080,
            height: 1350,
            filename: "urun.jpg",
            contentPath: "/api/assets/asset-1/content",
            messageId: null,
            createdAt: T,
            updatedAt: T,
          },
        ],
        presence: {
          online: true,
          lastSeenAt: T,
          workers: [],
          currentJobs: [],
          queueLength: 0,
        },
      });
    });

    // Verify tool_step row
    expect(await screen.findByTestId("tool-step-step-1")).toHaveTextContent("Plan hazırlandı");

    // Select Gemini Pro + Yüksek effort
    await user.selectOptions(screen.getByLabelText("Model seç"), "gemini-pro");
    await user.selectOptions(screen.getByLabelText("Çaba düzeyi"), "high");

    // Approve interactive Consent card
    await user.click(screen.getByRole("button", { name: "Bir kez izin ver" }));
    await waitFor(() =>
      expect(api.conversations.messages.consent).toHaveBeenCalledWith("conv-1", "msg-assistant-1", {
        consentId: "consent-1",
        allow: true,
      }),
    );
    expect(await screen.findByText("İzin verildi")).toBeInTheDocument();

    // Accept & Generate Plan
    await user.click(screen.getByRole("button", { name: "Kabul et ve üret" }));
    await waitFor(() =>
      expect(api.plans.accept).toHaveBeenCalledWith("plan-1", {
        revision: 2,
        skipItemIds: [],
      }),
    );
    await waitFor(() =>
      expect(api.plans.generate).toHaveBeenCalledWith("plan-1", {
        model: "gemini-pro",
        effort: "high",
      }),
    );

    // Run /usage command in composer
    const composer = screen.getByLabelText("Mesaj");
    await user.type(composer, "/usage");
    await user.click(screen.getByRole("button", { name: "Gönder" }));
    expect(await screen.findByText(/Kullanım ve AI Durumu/)).toBeInTheDocument();
    expect(await screen.findByText(/1\.200 \/ 450/)).toBeInTheDocument();
  });
});
