import type {
  ApiClient,
  ApprovalActionResult,
  ApprovalRequest,
  MentionCandidate,
} from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { textMentions } from "../../src/renderer/components/chat/messages.tsx";
import { ApprovalCardBody } from "../../src/renderer/features/approvals/approval-card.tsx";
import {
  approvalKeys,
  storeApproval,
} from "../../src/renderer/features/approvals/approvals-data.ts";
import {
  badgeText,
  checkSummaryLine,
  checkTone,
  chosenAsset,
  outcomeText,
  reducePending,
  successorOf,
  upsertApproval,
} from "../../src/renderer/features/approvals/approvals-model.ts";
import { engineChoice, engineOptions } from "../../src/renderer/features/brand/brand-model.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import {
  entityCandidates,
  mentionQuery,
  mentionSuggestions,
} from "../../src/renderer/lib/composer.ts";
import { buildTranscript } from "../../src/renderer/lib/transcript.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import { focusMessage, useFocusRequests } from "../../src/renderer/state/focus-requests.ts";
import { JobsController } from "../../src/renderer/state/jobs.ts";
import { message, text } from "./fixtures.ts";

const at = (minute: number) => `2026-11-20T10:${String(minute).padStart(2, "0")}:00.000Z`;

function approval(id: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id,
    brandId: "b1",
    contentId: "p1",
    productId: "pr1",
    conversationId: "c1",
    messageId: "m1",
    kind: "product_image",
    assetIds: ["a1"],
    checkReport: {
      passed: false,
      items: [
        { aspect: "Etiket yazısı", ok: true, note: "" },
        { aspect: "Kapak rengi", ok: false, note: "Beyaz yerine gri" },
        { aspect: "Şişe şekli", ok: false, note: "Daha ince" },
        { aspect: "Desen", ok: false, note: "Eksik" },
      ],
      summary: "Şu kısımlar hatalı geldi: kapak, şekil, desen.",
    },
    status: "pending",
    slotId: "hero",
    replacesAssetId: null,
    approvedAssetId: null,
    sourceJobId: "j0",
    regenerateJobId: null,
    canRegenerate: true,
    decisionNote: null,
    createdAt: at(0),
    updatedAt: at(0),
    decidedAt: null,
    ...over,
  };
}

describe("approval list (Onay bekleyenler)", () => {
  it("keeps a brand's pending requests newest first and drops decided ones", () => {
    const a = approval("a", { createdAt: at(1) });
    const b = approval("b", { createdAt: at(2) });
    let list = reducePending([], a, "b1");
    list = reducePending(list, b, "b1");
    expect(list.map((x) => x.id)).toEqual(["b", "a"]);
    // Another brand's request never enters.
    expect(reducePending(list, approval("c", { brandId: "b2" }), "b1")).toBe(list);
    // An update replaces in place; a decision removes it.
    const updated = reducePending(list, { ...a, checkReport: null }, "b1");
    expect(updated.find((x) => x.id === "a")?.checkReport).toBeNull();
    expect(reducePending(list, { ...b, status: "approved" }, "b1").map((x) => x.id)).toEqual(["a"]);
  });

  it("upserts into lists of every status", () => {
    const list = [approval("a", { createdAt: at(1) })];
    expect(upsertApproval(list, approval("b", { createdAt: at(3) })).map((x) => x.id)).toEqual([
      "b",
      "a",
    ]);
    expect(
      upsertApproval(list, { ...list[0], status: "rejected" } as ApprovalRequest)[0]?.status,
    ).toBe("rejected");
  });

  it("summarises the check in one line", () => {
    expect(checkSummaryLine(approval("a").checkReport)).toBe("3 sorun: Kapak rengi, Şişe şekli +1");
    expect(checkSummaryLine({ passed: true, items: [], summary: "" })).toBe("Kontrol geçti");
    expect(checkSummaryLine(null)).toBe("Kontrol çalışmadı");
    expect(checkTone(null)).toBe("neutral");
    expect(checkTone({ passed: true, items: [], summary: "" })).toBe("success");
    expect(checkTone(approval("a").checkReport)).toBe("danger");
  });

  it("finds the request that replaced a regenerated one", () => {
    const old = approval("a", { status: "superseded", regenerateJobId: "j2" });
    const next = approval("b", { sourceJobId: "j2" });
    expect(successorOf(old, [old, approval("c", { sourceJobId: "j9" }), next])?.id).toBe("b");
    expect(successorOf({ ...old, status: "pending" }, [next])).toBeNull();
    expect(successorOf({ ...old, regenerateJobId: null }, [next])).toBeNull();
  });

  it("approves the picked candidate (else the first) and says what happened", () => {
    const many = approval("a", { assetIds: ["x", "y", "z"] });
    expect(chosenAsset(many, "y")).toBe("y");
    expect(chosenAsset(many, "nope")).toBe("x");
    expect(chosenAsset(many, null)).toBe("x");
    expect(outcomeText(many)).toBeNull();
    expect(outcomeText({ ...many, status: "approved", approvedAssetId: "z" })).toBe(
      "Onaylandı; 3. seçenek posta yerleşti.",
    );
    expect(outcomeText({ ...many, status: "rejected", decisionNote: "Işık soğuk" })).toBe(
      "Reddedildi: Işık soğuk",
    );
    expect(outcomeText({ ...many, status: "superseded" })).toBe("Yerine yenisi üretildi.");
    expect(badgeText(0)).toBeNull();
    expect(badgeText(4)).toBe("4");
    expect(badgeText(120)).toBe("99+");
  });

  it("updates every cached copy from approval.updated", () => {
    const queryClient = new QueryClient();
    const a = approval("a");
    queryClient.setQueryData(approvalKeys.pending("b1"), [a]);
    queryClient.setQueryData(approvalKeys.conversation("c1"), [a]);
    queryClient.setQueryData(approvalKeys.one("a"), a);
    const decided = { ...a, status: "approved" as const, updatedAt: at(5) };
    storeApproval(queryClient, decided);
    expect(queryClient.getQueryData(approvalKeys.pending("b1"))).toEqual([]);
    expect(
      queryClient.getQueryData<ApprovalRequest[]>(approvalKeys.conversation("c1"))?.[0],
    ).toEqual(decided);
    expect(queryClient.getQueryData(approvalKeys.one("a"))).toEqual(decided);
  });

  it("hands approval.updated from the job stream to its listeners", () => {
    const jobs = new JobsController({} as ApiClient);
    const seen: string[] = [];
    const off = jobs.onApproval((a) => seen.push(a.id));
    jobs.apply({ type: "approval.updated", approval: approval("a") });
    off();
    jobs.apply({ type: "approval.updated", approval: approval("b") });
    expect(seen).toEqual(["a"]);
  });

  it("goes to the message that shows a request", () => {
    focusMessage("c9", "m9");
    expect(useAppStore.getState().route).toEqual({ kind: "conversation", id: "c9" });
    const request = useFocusRequests.getState().message;
    expect(request).toMatchObject({ conversationId: "c9", messageId: "m9" });
    useFocusRequests.getState().takeMessage((request?.nonce ?? 0) + 1);
    expect(useFocusRequests.getState().message).not.toBeNull();
    useFocusRequests.getState().takeMessage(request?.nonce ?? 0);
    expect(useFocusRequests.getState().message).toBeNull();
  });
});

describe("approval card", () => {
  function renderCard(a: ApprovalRequest, api: Partial<ApiClient>) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrap = (ui: ReactNode) => (
      <ApiContext.Provider value={api as ApiClient}>
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      </ApiContext.Provider>
    );
    return render(wrap(<ApprovalCardBody approval={a} />));
  }
  const result = (a: ApprovalRequest): ApprovalActionResult => ({
    approval: a,
    content: null,
    product: null,
    job: null,
  });

  it("shows the candidates, the report and approves the picked one", async () => {
    const a = approval("a", { assetIds: ["x", "y"] });
    const approve = vi.fn(async () => result({ ...a, status: "approved", approvedAssetId: "y" }));
    renderCard(a, { approvals: { approve } as unknown as ApiClient["approvals"] });
    expect(screen.getByText("Onay bekliyor")).toBeInTheDocument();
    const report = screen.getByRole("list", { name: "Kontrol raporu" });
    expect(within(report).getAllByRole("listitem")).toHaveLength(4);
    expect(within(report).getByText(/Beyaz yerine gri/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: "Seçenek 2 seç" }));
    await userEvent.click(screen.getByRole("button", { name: /2\. seçeneği onayla/ }));
    expect(approve).toHaveBeenCalledWith("a", { assetId: "y" });
  });

  it("asks before regenerating, with the label choice and an instruction", async () => {
    const a = approval("a");
    const regenerate = vi.fn(async () =>
      result({ ...a, status: "superseded", regenerateJobId: "j2" }),
    );
    renderCard(a, { approvals: { regenerate } as unknown as ApiClient["approvals"] });
    await userEvent.click(screen.getByRole("button", { name: /Yeniden üret/ }));
    const form = screen.getByRole("form", { name: "Yeniden üret" });
    await userEvent.type(within(form).getByRole("textbox"), "daha sıcak ışık");
    await userEvent.click(
      within(form).getByRole("checkbox", { name: "Etiketi birebir koruyarak yerleştir" }),
    );
    await userEvent.click(within(form).getByRole("button", { name: "Yeniden üret" }));
    expect(regenerate).toHaveBeenCalledWith("a", {
      preserveLabelComposite: true,
      instructions: "daha sıcak ışık",
    });
  });

  it("shows the outcome instead of the buttons once decided", () => {
    renderCard(approval("a", { status: "rejected", decisionNote: null }), {});
    expect(screen.getByText("Reddedildi")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Onayla" })).toBeNull();
    expect(screen.getByText(/medya kütüphanesinde kaldı/)).toBeInTheDocument();
  });
});

describe("@product / @post mentions", () => {
  const candidate = (kind: MentionCandidate["kind"], slug: string, label: string) => ({
    kind,
    id: `${kind}-${slug}`,
    slug,
    label,
    imageAssetId: null,
    detail: kind === "product" ? "Gübre" : "draft",
    pendingApprovals: 0,
  });

  it("reads a query with Turkish letters", () => {
    expect(mentionQuery("bak @Bö", 7)).toEqual({ start: 4, query: "bö" });
    expect(mentionQuery("@venta-b", 8)).toEqual({ start: 0, query: "venta-b" });
  });

  it("offers files, then products, then posts; labels match too", () => {
    const entities = entityCandidates(
      [
        candidate("content", "boro-kampanyasi", "Boro kampanyası"),
        candidate("product", "boro", "Boro"),
        candidate("product", "venta-boro", "Venta Böro"),
        candidate("product", "image", "Image"),
      ],
      new Set(["image"]),
    );
    // A product named like a file of the chat is left out (the file wins).
    expect(entities.map((e) => e.alias)).toEqual(["boro-kampanyasi", "boro", "venta-boro"]);
    const file = { alias: "boro-foto", assetId: "a", previewUrl: null, isDraft: false };
    expect(mentionSuggestions([file, ...entities], "bö").map((s) => s.alias)).toEqual([
      "boro-foto",
      "boro",
      "boro-kampanyasi",
      "venta-boro",
    ]);
    // "kampanya" is in the post's title and its name.
    expect(mentionSuggestions(entities, "kampanya").map((s) => s.alias)).toEqual([
      "boro-kampanyasi",
    ]);
  });

  it("puts sent product / post names between the file mentions", () => {
    const list = textMentions(
      [{ aliasId: "al1", alias: "image", assetId: "a1", start: 20, end: 26 }],
      [
        { kind: "product", id: "p1", name: "boro", start: 0, end: 5 },
        { kind: "content", id: "c1", name: "hasat", start: 30, end: 36 },
      ],
    );
    expect(list.map((m) => m.type)).toEqual(["entity", "file", "entity"]);
  });

  it("carries entity mentions and approval cards into the transcript", () => {
    const items = buildTranscript({
      hasState: true,
      messages: [
        message("u1", "user", [text("@boro için görsel")], {
          entityMentions: [{ kind: "product", id: "p1", name: "boro", start: 0, end: 5 }],
        }),
        message("m1", "assistant", [
          text("Hazır:"),
          { type: "approval_request", approvalId: "ap1" },
        ]),
      ],
    });
    const user = items.find((i) => i.kind === "user");
    expect(user?.kind === "user" && user.entityMentions).toHaveLength(1);
    const reply = items.find((i) => i.kind === "assistant");
    expect(reply?.kind === "assistant" && reply.blocks.map((b) => b.kind)).toEqual([
      "text",
      "approval",
    ]);
  });
});

describe("brand production engine", () => {
  it("lists every engine, only the ready ones selectable", () => {
    const options = engineOptions();
    expect(options.map((o) => o.label)).toEqual(["Wecra", "HTML", "SVG", "Kod"]);
    expect(options.filter((o) => o.ready).map((o) => o.value)).toEqual([
      "wecra",
      "html",
      "svg",
      "code",
    ]);
    expect(engineChoice("")).toBeNull();
    expect(engineChoice("html")).toBe("html");
    expect(engineChoice("nope")).toBeNull();
  });
});
