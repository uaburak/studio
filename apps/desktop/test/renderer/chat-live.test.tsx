// Chat fixes of Faz 5: reconnect after a host restart (A1), a plan whose generation failed (A2),
// brand switch in a new chat (A5), the composer's keys and previews (A7, A10), the question card
// (A10), the error block's "Yeniden dene".
import {
  type ApiClient,
  ApiError,
  type Asset,
  type ConversationStreamMessage,
  type Plan,
} from "@studio/contract";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generationNotStarted,
  PlanProposalCard,
  QuestionCard,
} from "../../src/renderer/components/chat/blocks.tsx";
import { TranscriptItems } from "../../src/renderer/components/chat/chat-view.tsx";
import { Composer } from "../../src/renderer/components/chat/composer.tsx";
import { NewChatView } from "../../src/renderer/components/chat/new-chat-view.tsx";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { sendProblem } from "../../src/renderer/lib/composer.ts";
import { buildTranscript } from "../../src/renderer/lib/transcript.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import {
  ConversationCache,
  ConversationController,
} from "../../src/renderer/state/conversation.ts";
import { ownerName } from "../../src/renderer/state/owner-name.ts";
import { useConversation } from "../../src/renderer/state/studio.tsx";
import { conversation, message, presence, run, state, T, text } from "./fixtures.ts";
import { apiError, brand, FakeSocket, page, renderLive, resetLive } from "./live-harness.tsx";
import { plan } from "./post-fixtures.ts";

afterEach(() => {
  resetLive();
  useAppStore.setState({ route: { kind: "new" }, back: [], forward: [], toasts: [] });
});

function snapshotFrame(seq: number, title: string): ConversationStreamMessage {
  const s = state({ seq, conversation: conversation({ title, lastSeq: seq }) });
  return {
    type: "conversation.snapshot",
    seq,
    conversation: s.conversation,
    messages: [],
    hasMoreMessages: false,
    activeRun: null,
    plans: [],
    aliases: [],
    presence,
  };
}

// --- A1 -------------------------------------------------------------------------------------------

function Probe({ id }: { id: string }) {
  const c = useConversation(id);
  return <p data-testid="title">{c.state?.conversation.title ?? "yok"}</p>;
}

describe("A1: an open conversation after a host restart", () => {
  it("reconnects from its last event when the host is back (up → down → up)", async () => {
    const live = renderLive(<Probe id="c1" />);
    await waitFor(() => expect(FakeSocket.find("/api/conversations/c1/stream")).toBeDefined());
    const first = FakeSocket.find("/api/conversations/c1/stream") as FakeSocket;
    act(() => {
      first.open();
      first.push(snapshotFrame(3, "Kasım"));
    });
    expect(screen.getByTestId("title")).toHaveTextContent("Kasım");

    act(() => live.setHost("down"));
    expect(first.readyState).toBe(3);
    const before = FakeSocket.all.length;
    act(() => live.setHost("up"));
    await waitFor(() =>
      expect(FakeSocket.find("/api/conversations/c1/stream", before)).toBeDefined(),
    );
    const second = FakeSocket.find("/api/conversations/c1/stream", before) as FakeSocket;
    expect(second.url).toContain("after=3");
    act(() => {
      second.open();
      second.push({
        type: "conversation.updated",
        seq: 4,
        conversation: conversation({ title: "Aralık", lastSeq: 4 }),
      });
    });
    // The same view (no navigation) shows the new event.
    expect(screen.getByTestId("title")).toHaveTextContent("Aralık");
  });

  it("the cache pauses and resumes its controllers instead of dropping them", () => {
    const watch = vi.fn(() => ({ close: vi.fn(), lastSeq: undefined }));
    const client = { conversations: { watch } } as unknown as ApiClient;
    const cache = new ConversationCache((id) => new ConversationController(id, client, deps));
    const controller = cache.get("c1");
    cache.pause();
    expect(cache.peek("c1")).toBe(controller);
    cache.resume();
    expect(watch).toHaveBeenCalledTimes(2);
  });
});

// --- A2 -------------------------------------------------------------------------------------------

const deps = {
  choice: () => ({ model: "opus" as const, effort: "high" as const }),
  saveChoice: vi.fn(),
};

describe("A2: Onayla ve üret when the generation cannot start", () => {
  it("shows the failure on the card and Yeniden dene runs only the generate step", async () => {
    const accept = vi.fn(async () => ({}));
    const generate = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError("/api/plans/pl1/generate: worker is offline", 409, "conflict"),
      )
      .mockResolvedValueOnce({});
    const client = {
      plans: { accept, generate, reject: vi.fn() },
      conversations: { watch: vi.fn(() => ({ close: vi.fn() })) },
    } as unknown as ApiClient;
    const controller = new ConversationController("c1", client, deps);
    const proposed = { ...plan([{ contentId: "x", date: "2026-12-01" }]), status: "proposed" };
    await controller.acceptAndGenerate(proposed as Plan);
    expect(accept).toHaveBeenCalledOnce();
    const failure = controller.getSnapshot().planErrors.pl1;
    expect(failure).toMatch(/çakışıyor/);
    // The general error line stays clear: the failure belongs to the card.
    expect(controller.getSnapshot().error).toBeNull();

    const accepted = { ...proposed, status: "accepted" } as Plan;
    const view = render(
      <PlanProposalCard
        plan={accepted}
        busy={false}
        controller={controller}
        onEdit={() => undefined}
        generateError={failure ?? null}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("üretim başlatılamadı");
    expect(screen.queryByText(/üretime alındı/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    expect(accept).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().planErrors.pl1).toBeUndefined();
    view.unmount();
  });

  it("an accepted plan that never got a generation offers it again; a started one does not", () => {
    const accepted = plan([{ contentId: "x", date: "2026-12-01" }]);
    expect(generationNotStarted(accepted)).toBe(true);
    const started = {
      ...accepted,
      items: accepted.items.map((i) => ({
        ...i,
        generation: { jobId: "j", status: "running", error: null },
      })),
    } as Plan;
    expect(generationNotStarted(started)).toBe(false);
    const stub = {
      acceptAndGenerate: vi.fn(),
      acceptPlan: vi.fn(),
      generatePlan: vi.fn(),
      rejectPlan: vi.fn(),
      decideConsent: vi.fn(),
      answer: vi.fn(),
    };
    render(<PlanProposalCard plan={started} busy={false} controller={stub} onEdit={() => {}} />);
    expect(screen.getByText(/Postlar üretime alındı/)).toBeInTheDocument();
  });

  const cardStub = () => ({
    acceptAndGenerate: vi.fn(async () => undefined),
    acceptPlan: vi.fn(async () => undefined),
    generatePlan: vi.fn(async () => undefined),
    rejectPlan: vi.fn(async () => undefined),
    decideConsent: vi.fn(async () => undefined),
    answer: vi.fn(async () => undefined),
  });
  const handMade = (p: Plan, generate = false): Plan => ({
    ...p,
    items: p.items.map((i) => ({ ...i, generate })),
  });

  it("offers accepting without generation next to Onayla ve üret", async () => {
    const proposed = {
      ...plan([{ contentId: "x", date: "2026-12-01" }]),
      status: "proposed",
    } as Plan;
    const stub = cardStub();
    render(<PlanProposalCard plan={proposed} busy={false} controller={stub} onEdit={() => {}} />);
    expect(screen.getByRole("button", { name: "Onayla ve üret" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yalnızca onayla (üretme)" }));
    expect(stub.acceptPlan).toHaveBeenCalledWith(proposed);
    expect(stub.acceptAndGenerate).not.toHaveBeenCalled();
  });

  it("a plan of hand-made posts is accepted without generation (no Onayla ve üret)", async () => {
    const proposed = handMade({
      ...plan([
        { contentId: "x", date: "2026-12-01" },
        { contentId: "y", date: "2026-12-02" },
      ]),
      status: "proposed",
    } as Plan);
    const stub = cardStub();
    render(<PlanProposalCard plan={proposed} busy={false} controller={stub} onEdit={() => {}} />);
    expect(screen.queryByRole("button", { name: "Onayla ve üret" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Yalnızca onayla (üretme)" }));
    expect(stub.acceptPlan).toHaveBeenCalledOnce();
    expect(stub.acceptAndGenerate).not.toHaveBeenCalled();
  });

  it("acceptPlan accepts and never asks for generation", async () => {
    const accept = vi.fn(async () => ({}));
    const generate = vi.fn(async () => ({}));
    const client = {
      plans: { accept, generate, reject: vi.fn() },
      conversations: { watch: vi.fn(() => ({ close: vi.fn() })) },
    } as unknown as ApiClient;
    const controller = new ConversationController("c1", client, deps);
    const proposed = { ...plan([{ contentId: "x", date: "2026-12-01" }]), status: "proposed" };
    await controller.acceptPlan(proposed as Plan);
    expect(accept).toHaveBeenCalledWith("pl1", { revision: 1 });
    expect(generate).not.toHaveBeenCalled();
    expect(controller.getSnapshot().planErrors.pl1).toBeUndefined();
  });

  it("an accepted plan without generation offers Üret; a hand-made one does not", async () => {
    const accepted = plan([{ contentId: "x", date: "2026-12-01" }]);
    const stub = cardStub();
    const view = render(
      <PlanProposalCard plan={accepted} busy={false} controller={stub} onEdit={() => {}} />,
    );
    expect(screen.getByText(/üretim başlamadı/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Üret" }));
    expect(stub.generatePlan).toHaveBeenCalledWith(accepted);
    view.unmount();

    const manual = handMade(accepted);
    expect(generationNotStarted(manual)).toBe(false);
    render(<PlanProposalCard plan={manual} busy={false} controller={stub} onEdit={() => {}} />);
    expect(screen.getByText(/elle yüklenecek/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Üret" })).toBeNull();
  });

  it("transcript blocks carry the plan's failure", () => {
    const items = buildTranscript({
      hasState: true,
      messages: [message("a1", "assistant", [{ type: "plan_proposal", planId: "pl1" }])],
      plans: [plan([])],
      planErrors: { pl1: "olmadı" },
    });
    const assistant = items.find((i) => i.kind === "assistant");
    expect(assistant?.kind === "assistant" && assistant.blocks[0]).toMatchObject({
      kind: "plan",
      generateError: "olmadı",
    });
  });
});

// --- A5 -------------------------------------------------------------------------------------------

let assetCount = 0;
function asset(brandId: string): Asset {
  assetCount += 1;
  return {
    id: `asset-${brandId}-${assetCount}`,
    brandId,
    kind: "image",
    source: "upload",
    objectKey: `k${assetCount}`,
    mimeType: "image/png",
    bytes: 10,
    sha256: "0".repeat(64),
    width: null,
    height: null,
    durationMs: null,
    originalFilename: "tarla.png",
    createdAt: T,
  };
}

function newChatApi(sendFailures: number) {
  let sends = 0;
  let current = conversation({ id: "cnew", title: "", brandId: null, lastSeq: 0 });
  return (method: string, path: string, body: unknown) => {
    const b = body as Record<string, unknown> | undefined;
    if (method === "GET" && path.startsWith("/api/brands"))
      return page([brand("b1", "MTM Agro"), brand("b2", "Partner Agro")]);
    if (method === "POST" && path === "/api/assets") return asset(String(b?.brandId));
    if (method === "POST" && path === "/api/conversations") {
      current = { ...current, brandId: (b?.brandId as string) ?? null, title: String(b?.title) };
      return current;
    }
    if (method === "PATCH" && path === "/api/conversations/cnew") {
      current = { ...current, ...(b as object) };
      return current;
    }
    if (method === "GET" && path === "/api/conversations/cnew") return current;
    if (method === "POST" && path === "/api/conversations/cnew/messages") {
      sends += 1;
      if (sends <= sendFailures)
        return apiError(400, "validation_error", "asset belongs to another brand");
      return {
        message: message("u1", "user", [text("x")], { conversationId: "cnew" }),
        run: run({ conversationId: "cnew", status: "queued" }),
        replayed: false,
      };
    }
    return undefined;
  };
}

const posts = (calls: { method: string; path: string; body: unknown }[], path: string) =>
  calls.filter((c) => c.method !== "GET" && c.path === path);

async function attach(container: HTMLElement) {
  const input = container.querySelector("input[type=file]") as HTMLInputElement;
  const file = new File(["png"], "tarla.png", { type: "image/png" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("A5: a new chat's images follow the brand; no empty conversations", () => {
  beforeEach(() => {
    useAppStore.setState({ currentBrandId: "b1", route: { kind: "new" } });
  });

  it("uploads the images again to the new brand, and reuses the conversation of a failed send", async () => {
    const live = renderLive(<NewChatView />, newChatApi(1));
    const box = await screen.findByRole("textbox", { name: "Mesaj" });
    await waitFor(() => expect(box).toBeEnabled());
    await attach(live.container);
    await waitFor(() => expect(posts(live.calls, "/api/assets")).toHaveLength(1));
    expect(posts(live.calls, "/api/assets")[0]?.body).toMatchObject({ brandId: "b1" });

    // The title menu picks another brand: the image goes to that brand too.
    act(() => useAppStore.getState().setCurrentBrand("b2"));
    expect(await screen.findByText(/görseller yeni markaya yükleniyor/)).toBeInTheDocument();
    await waitFor(() => expect(posts(live.calls, "/api/assets")).toHaveLength(2));
    expect(posts(live.calls, "/api/assets")[1]?.body).toMatchObject({ brandId: "b2" });

    // A send the API refuses: plain Turkish, with the server's text under "Ayrıntı".
    await userEvent.type(box, "merhaba{Enter}");
    const alert = await screen.findByText(/Gönderilen bilgilerde bir sorun var/);
    expect(within(alert).getByText("asset belongs to another brand")).toBeInTheDocument();
    expect(posts(live.calls, "/api/conversations")).toHaveLength(1);
    expect(posts(live.calls, "/api/conversations")[0]?.body).toMatchObject({ brandId: "b2" });
    // Nothing shows in the list before the first message went through.
    expect(useAppStore.getState().route).toEqual({ kind: "new" });

    // Back to the first brand, send again: the same conversation moves along.
    act(() => useAppStore.getState().setCurrentBrand("b1"));
    await waitFor(() => expect(posts(live.calls, "/api/assets")).toHaveLength(3));
    await waitFor(() => expect(box).toHaveValue("merhaba"));
    await userEvent.type(box, "{Enter}");
    await waitFor(() =>
      expect(useAppStore.getState().route).toEqual({ kind: "conversation", id: "cnew" }),
    );
    expect(posts(live.calls, "/api/conversations")).toHaveLength(1);
    expect(posts(live.calls, "/api/conversations/cnew")[0]?.body).toEqual({ brandId: "b1" });
    const sent = posts(live.calls, "/api/conversations/cnew/messages").at(-1)?.body as {
      attachments: { assetId: string }[];
    };
    expect(sent.attachments[0]?.assetId).toMatch(/^asset-b1-/);
  });

  it("archives the empty conversation of a failed send when the view goes away", async () => {
    const live = renderLive(<NewChatView />, newChatApi(5));
    const box = await screen.findByRole("textbox", { name: "Mesaj" });
    await waitFor(() => expect(box).toBeEnabled());
    await userEvent.type(box, "selam{Enter}");
    await screen.findByText(/Gönderilen bilgilerde bir sorun var/);
    live.unmount();
    await waitFor(() =>
      expect(posts(live.calls, "/api/conversations/cnew").at(-1)?.body).toEqual({
        status: "archived",
      }),
    );
  });

  it("drops the images when no brand is left, saying so", async () => {
    const onSend = vi.fn(async () => true);
    const upload = vi.fn(async (input: { brandId: string }) => asset(input.brandId));
    const api = { assets: { upload } } as unknown as ApiClient;
    const view = render(
      <ApiContext.Provider value={api}>
        <Composer placeholder="x" working={false} brandId="b1" onSend={onSend} />
      </ApiContext.Provider>,
    );
    await attach(view.container);
    await waitFor(() => expect(screen.getByText("@image")).toBeInTheDocument());
    view.rerender(
      <ApiContext.Provider value={api}>
        <Composer
          placeholder="x"
          working={false}
          brandId={null}
          attachDisabledReason="Marka seç"
          onSend={onSend}
        />
      </ApiContext.Provider>,
    );
    expect(await screen.findByText(/eklenen görseller çıkarıldı/)).toBeInTheDocument();
    expect(screen.queryByText("@image")).not.toBeInTheDocument();
  });
});

// --- A10 composer, A7 ---------------------------------------------------------------------------

describe("composer previews and failed uploads (A10)", () => {
  it("keeps previews alive across a failed send and frees them when it goes away", async () => {
    let n = 0;
    const create = vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:p${++n}`);
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    try {
      const onSend = vi.fn(async () => false);
      const upload = vi.fn(async () => asset("b1"));
      const api = { assets: { upload } } as unknown as ApiClient;
      const view = render(
        <ApiContext.Provider value={api}>
          <Composer placeholder="x" working={false} brandId="b1" onSend={onSend} />
        </ApiContext.Provider>,
      );
      await attach(view.container);
      await waitFor(() => expect(upload).toHaveBeenCalled());
      await userEvent.type(screen.getByRole("textbox"), "bak{Enter}");
      await waitFor(() => expect(onSend).toHaveBeenCalled());
      // The chip is back with a preview that still works.
      expect(await screen.findByText("@image")).toBeInTheDocument();
      expect(revoke).not.toHaveBeenCalled();
      view.unmount();
      expect(revoke).toHaveBeenCalledWith("blob:p1");
    } finally {
      create.mockRestore();
      revoke.mockRestore();
    }
  });

  it("does not send while an image failed to upload (its @alias is in the text)", async () => {
    const onSend = vi.fn(async () => true);
    const upload = vi.fn(async () => {
      throw new ApiError("/api/assets: too big", 413, "payload_too_large");
    });
    const api = { assets: { upload } } as unknown as ApiClient;
    const view = render(
      <ApiContext.Provider value={api}>
        <Composer placeholder="x" working={false} brandId="b1" onSend={onSend} />
      </ApiContext.Provider>,
    );
    await attach(view.container);
    await waitFor(() => expect(upload).toHaveBeenCalled());
    await userEvent.type(screen.getByRole("textbox"), "@image kullan{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("@image yüklenemedi ama mesajda geçiyor");
  });

  it("names failed images (pure)", () => {
    const failed = {
      id: "d",
      alias: "logo",
      previewUrl: "blob:x",
      filename: "logo.png",
      state: { kind: "failed" as const, error: "x" },
    };
    expect(sendProblem("@logo burada", [failed])).toMatch(/@logo yüklenemedi ama mesajda/);
    expect(sendProblem("metin", [failed])).toMatch(/@logo yüklenemedi\. Göndermek için/);
    expect(sendProblem("metin", [])).toBeNull();
  });
});

describe("question card (A10)", () => {
  const question = {
    type: "question" as const,
    questionId: "q1",
    prompt: "Hangi gün?",
    mode: "text" as const,
    options: [],
    allowText: true,
    answer: null,
  };
  it("Enter answers once, never while the answer is on its way", async () => {
    const answer = vi.fn(async () => undefined);
    const actions = {
      acceptAndGenerate: vi.fn(),
      acceptPlan: vi.fn(),
      generatePlan: vi.fn(),
      rejectPlan: vi.fn(),
      decideConsent: vi.fn(),
      answer,
    };
    const m = message("a1", "assistant", [question as never]);
    const view = render(
      <QuestionCard message={m} question={question as never} busy={true} controller={actions} />,
    );
    await userEvent.type(screen.getByPlaceholderText("Yanıtın"), "Salı{Enter}{Enter}");
    expect(answer).not.toHaveBeenCalled();
    view.rerender(
      <QuestionCard message={m} question={question as never} busy={false} controller={actions} />,
    );
    await userEvent.type(screen.getByPlaceholderText("Yanıtın"), "{Enter}");
    expect(answer).toHaveBeenCalledTimes(1);
  });
});

// --- chat error: Yeniden dene ----------------------------------------------------------------------

describe("the error block's Yeniden dene", () => {
  const errorPart = {
    type: "error" as const,
    message: "Model yanıt vermedi",
    code: null,
    retryable: true,
  };

  it("sends the last user message again (text and images)", async () => {
    const sends: unknown[] = [];
    const client = {
      conversations: {
        watch: vi.fn((_id: string, h: { onMessage: (m: ConversationStreamMessage) => void }) => {
          queueMicrotask(() =>
            h.onMessage({
              type: "conversation.snapshot",
              seq: 2,
              conversation: conversation(),
              messages: [
                message("u1", "user", [
                  text("Kasım planı"),
                  {
                    type: "attachment",
                    assetId: "img1",
                    kind: "image",
                    mimeType: "image/png",
                    width: null,
                    height: null,
                    filename: null,
                    alias: "image",
                  },
                ]),
                message("a1", "assistant", [errorPart], { status: "failed" }),
              ],
              hasMoreMessages: false,
              activeRun: null,
              plans: [],
              aliases: [],
              presence,
            }),
          );
          return { close: vi.fn(), lastSeq: undefined };
        }),
        messages: {
          send: vi.fn(async (_id: string, body: unknown) => {
            sends.push(body);
            return {
              message: message("u2", "user", []),
              run: run({ status: "queued" }),
              replayed: false,
            };
          }),
        },
      },
    } as unknown as ApiClient;
    const controller = new ConversationController("c1", client, {
      ...deps,
      newId: () => "retry-1",
    });
    controller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(await controller.retryLast()).toBe(true);
    expect(sends[0]).toEqual({
      text: "Kasım planı",
      attachments: [{ assetId: "img1" }],
      clientMessageId: "retry-1",
      model: "opus",
      effort: "high",
    });
  });

  it("is offered only on the last reply, when nothing runs", async () => {
    const retryLast = vi.fn(async () => true);
    const stub = { retryLast, toggleSteps: vi.fn() } as unknown as ConversationController;
    const items = (extra: ReturnType<typeof message>[] = []) =>
      buildTranscript({
        hasState: true,
        messages: [
          message("u1", "user", [text("bir")]),
          message("a1", "assistant", [errorPart], { status: "failed" }),
          ...extra,
        ],
      });
    const view = render(
      <TranscriptItems
        items={items()}
        aliases={[]}
        controller={stub}
        onMention={() => {}}
        onEditPlan={() => {}}
        onEditQueued={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Yeniden dene" }));
    expect(retryLast).toHaveBeenCalledOnce();
    view.rerender(
      <TranscriptItems
        items={items([message("u2", "user", [text("iki")])])}
        aliases={[]}
        controller={stub}
        onMention={() => {}}
        onEditPlan={() => {}}
        onEditQueued={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: "Yeniden dene" })).not.toBeInTheDocument();
  });
});

describe("owner name (A10)", () => {
  it("prefers Ayarlar, then the Claude account, then the Mac user; never a fixed name", () => {
    expect(ownerName({ setting: " Ayşe ", claude: "Claude Adı", mac: "Mac Adı" })).toBe("Ayşe");
    expect(ownerName({ setting: "", claude: "Claude Adı", mac: "Mac Adı" })).toBe("Claude Adı");
    expect(ownerName({ setting: "", claude: null, mac: "Mac Adı" })).toBe("Mac Adı");
    expect(ownerName({ setting: "", claude: null, mac: "" })).toBe("");
  });
});
