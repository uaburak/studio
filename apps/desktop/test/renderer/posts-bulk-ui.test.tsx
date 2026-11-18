// The audit's posts screens in use (A3, N1–N4, 7): picking cards and the bulk bar (approve
// through the checks gate, delete with undo), a failed generation's "Yeniden dene", the trash,
// the plans view (statuses, "Yalnızca başarısızları üret", the estimate before many posts), the
// jobs pane's failed job, the chat plan card's "Düzenle", and a media file that is in use.
import type {
  ApiClient,
  Brand,
  ContentCheckResult,
  ContentCheckRun,
  ContentVersion,
  GenerationEstimate,
  Plan,
  PlanItem,
} from "@studio/contract";
import { ApiError } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlanProposalCard } from "../../src/renderer/components/chat/blocks.tsx";
import { FinishedJobRow } from "../../src/renderer/components/panels/finished-job.tsx";
import { useAssetDelete } from "../../src/renderer/features/media/asset-delete.tsx";
import { buildBoard } from "../../src/renderer/features/posts/board.ts";
import { postKeys } from "../../src/renderer/features/posts/data.ts";
import { PlansView } from "../../src/renderer/features/posts/plans-view.tsx";
import { Board } from "../../src/renderer/features/posts/posts-page.tsx";
import { usePostsStore } from "../../src/renderer/features/posts/store.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import { content, contentFor, hashedVersion, job, T, version } from "./post-fixtures.ts";

const NOW = new Date("2026-11-17T10:00:00.000Z");
const brands = [{ id: "b1", name: "MTM Agro", status: "active" }] as Brand[];

function providers(ui: ReactNode, api: unknown = {}, seed?: (q: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  usePostsStore.setState({
    month: null,
    filter: "all",
    query: "",
    selectedId: null,
    opened: null,
    deleting: null,
    allBrands: false,
    picked: [],
    anchorId: null,
    trash: false,
    view: "board",
    planId: null,
  });
});

afterEach(() => {
  useAppStore.setState({ toasts: [], lightbox: null });
});

const result = (checkId: string, status: ContentCheckResult["status"]): ContentCheckResult => ({
  checkId,
  category: checkId.split(".")[0] as ContentCheckResult["category"],
  status,
  message: `${checkId} mesajı`,
  refs: [],
  evidence: null,
  source: "deterministic",
  fixable: false,
});

function checkRun(v: ContentVersion, results: ContentCheckResult[]): ContentCheckRun {
  const fails = results.filter((r) => r.status === "fail").length;
  return {
    id: `run-${v.id}`,
    contentId: v.contentId,
    brandId: "b1",
    version: v.version,
    versionId: v.id,
    trigger: "generate",
    jobId: null,
    strictness: "standard",
    summary: { pass: results.length - fails, warn: 0, fail: fails, fixed: 0, skipped: 0 },
    blocking: fails,
    results,
    model: null,
    fromVersion: null,
    fixedVersion: null,
    note: "",
    createdAt: T,
  };
}

const settings = {
  brandId: "b1",
  disabledChecks: [],
  bannedWords: [],
  strictness: "standard",
  autoFix: true,
  updatedAt: null,
};

describe("multi-select and the bulk bar (N1)", () => {
  async function setup() {
    const v1 = await hashedVersion("p1", 1);
    const v2 = await hashedVersion("p2", 1);
    const cards = buildBoard({
      contents: [
        contentFor(v1, { title: "Hasat", createdAt: "2026-11-02T09:00:00.000Z" }),
        contentFor(v2, { id: "p2", title: "Bayi", createdAt: "2026-11-03T09:00:00.000Z" }),
        content({ id: "p3", title: "Damla", createdAt: "2026-11-05T09:00:00.000Z" }),
      ],
      versions: new Map([
        ["p1", v1],
        ["p2", v2],
      ]),
    });
    const approve = vi.fn(async (id: string, _input: unknown) =>
      content({ id, status: "approved" }),
    );
    const remove = vi.fn(async () => undefined);
    const restore = vi.fn(async (id: string) => content({ id }));
    const api = {
      contents: {
        approve,
        delete: remove,
        restore,
        checks: {
          list: async (id: string) => ({
            items: [
              id === "p1"
                ? checkRun(v1, [result("layout.overflow", "pass")])
                : checkRun(v2, [result("layout.overflow", "fail")]),
            ],
            nextCursor: null,
          }),
        },
      },
      jobs: { list: async () => ({ items: [], nextCursor: null }) },
      brandCheckSettings: { get: async () => settings },
    };
    providers(
      <Board
        cards={cards}
        loading={false}
        error={null}
        onRetry={() => undefined}
        brands={brands}
        brandName={() => "MTM Agro"}
        grouped={false}
        brandId="b1"
        now={NOW}
      />,
      api,
    );
    return { approve, remove, restore };
  }

  const cardButton = (title: string) => screen.getByRole("button", { name: `Postu aç: ${title}` });

  it("picks with ⌘-click and ⇧-click, selects the month and clears with Esc", async () => {
    await setup();
    fireEvent.click(cardButton("Hasat"), { metaKey: true });
    expect(usePostsStore.getState().picked).toEqual(["p1"]);
    expect(usePostsStore.getState().opened).toBeNull();
    expect(screen.getByRole("toolbar", { name: "Seçili postlar" })).toHaveTextContent(
      "1 post seçili",
    );
    fireEvent.click(cardButton("Damla"), { shiftKey: true });
    expect(usePostsStore.getState().picked).toEqual(["p1", "p2", "p3"]);
    fireEvent.click(cardButton("Bayi"), { metaKey: true });
    expect(usePostsStore.getState().picked).toEqual(["p1", "p3"]);
    await userEvent.click(screen.getByRole("button", { name: "Tümünü seç (3)" }));
    expect(usePostsStore.getState().picked).toHaveLength(3);
    const region = screen.getByRole("region", { name: "Postlar" });
    fireEvent.keyDown(region, { key: "Escape" });
    expect(usePostsStore.getState().picked).toEqual([]);
    expect(screen.queryByRole("toolbar", { name: "Seçili postlar" })).toBeNull();
    // ⌘A picks the month's cards.
    fireEvent.keyDown(region, { key: "a", metaKey: true });
    expect(usePostsStore.getState().picked).toEqual(["p1", "p2", "p3"]);
  });

  it("approves through the checks gate: the blocked post is listed, only the clean one goes", async () => {
    const { approve } = await setup();
    act(() => usePostsStore.getState().setPicked(["p1", "p2", "p3"]));
    const bar = screen.getByRole("toolbar", { name: "Seçili postlar" });
    await userEvent.click(within(bar).getByRole("button", { name: "Onayla" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Bazı postların kontrolleri geçmedi",
    });
    expect(within(dialog).getByText("Bayi")).toBeInTheDocument();
    expect(within(dialog).getByText(/1 kontrol geçmedi/)).toBeInTheDocument();
    // p3 has no design: left out with the reason.
    expect(within(dialog).getByText("Damla: Henüz tasarımı yok.")).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Yalnızca sorunsuzları onayla (1)" }),
    );
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve.mock.calls[0]?.[0]).toBe("p1");
    expect(approve.mock.calls[0]?.[1]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("approves every post anyway with the checks acknowledged", async () => {
    const { approve } = await setup();
    act(() => usePostsStore.getState().setPicked(["p1", "p2"]));
    await userEvent.click(
      within(screen.getByRole("toolbar", { name: "Seçili postlar" })).getByRole("button", {
        name: "Onayla",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Yine de hepsini onayla (2)" }),
    );
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
    expect(
      approve.mock.calls.map((c) => (c[1] as { acknowledgeChecks?: boolean }).acknowledgeChecks),
    ).toEqual([true, true]);
  });

  it("moves the picked posts to the trash and takes them all back", async () => {
    const { remove, restore } = await setup();
    act(() => usePostsStore.getState().setPicked(["p1", "p3"]));
    await userEvent.click(
      within(screen.getByRole("toolbar", { name: "Seçili postlar" })).getByRole("button", {
        name: "Sil",
      }),
    );
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
    const toast = useAppStore.getState().toasts.at(-1);
    expect(toast?.message).toBe("2 post Silinenler'e taşındı.");
    expect(usePostsStore.getState().picked).toEqual([]);
    toast?.action?.run();
    await waitFor(() => expect(restore).toHaveBeenCalledTimes(2));
  });
});

describe("failed generation (A3)", () => {
  it("shows the reason on the card and queues the job again", async () => {
    const retry = vi.fn(async () => job({ id: "g2", status: "queued" }));
    const cards = buildBoard({
      contents: [content({ id: "p1", title: "Hasat" })],
      jobs: [
        job({
          id: "g1",
          type: "content.generate",
          status: "failed",
          error: "worker w lost the job (lease); gave up after 3 attempt(s)",
        }),
      ],
    });
    providers(
      <Board
        cards={cards}
        loading={false}
        error={null}
        onRetry={() => undefined}
        brands={brands}
        brandName={() => "MTM Agro"}
        grouped={false}
        brandId="b1"
        now={NOW}
      />,
      { jobs: { retry } },
    );
    const card = screen.getAllByRole("listitem")[0] as HTMLElement;
    expect(within(card).getByText("Üretilemedi")).toBeInTheDocument();
    expect(within(card).getByText("Mac'teki işçi işi yarıda bıraktı.")).toBeInTheDocument();
    await userEvent.click(within(card).getByRole("button", { name: "Yeniden dene" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith("g1"));
    // The "Hata" filter counts it.
    expect(screen.getByRole("radio", { name: /^Hata/ })).toHaveTextContent("Hata1");
  });

  it("offers Yeniden dene and Postu aç for a failed job in the jobs pane", async () => {
    const retry = vi.fn(async () => job({ id: "g2", status: "queued" }));
    providers(
      <ul>
        <FinishedJobRow
          job={job({
            id: "g1",
            type: "content.generate",
            status: "failed",
            error: "render failed: chromium crashed",
          })}
        />
        <FinishedJobRow job={job({ id: "s1", type: "schedule.publish", status: "failed" })} />
      </ul>,
      { jobs: { retry } },
    );
    expect(screen.getByText("Görsel oluşturulamadı.")).toHaveAttribute(
      "title",
      "render failed: chromium crashed",
    );
    const buttons = screen.getAllByRole("button", { name: "Yeniden dene" });
    // A publish is never queued twice from here.
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(retry).toHaveBeenCalledWith("g1"));
    await userEvent.click(screen.getAllByRole("button", { name: "Postu aç" })[0] as HTMLElement);
    expect(usePostsStore.getState().opened?.contentId).toBe("p1");
    usePostsStore.getState().close();
  });
});

describe("trash (7)", () => {
  it("lists the trashed posts with their purge day and restores one", async () => {
    const restore = vi.fn(async (id: string) => content({ id }));
    act(() => usePostsStore.getState().setTrash(true));
    providers(
      <Board
        cards={[]}
        loading={false}
        error={null}
        onRetry={() => undefined}
        brands={brands}
        brandName={() => "MTM Agro"}
        grouped={false}
        brandId="b1"
        now={NOW}
      />,
      { contents: { restore } },
      (q) =>
        q.setQueryData(postKeys.trash("b1"), [
          content({ id: "t1", title: "Eski kampanya", deletedAt: "2026-11-10T09:00:00.000Z" }),
        ]),
    );
    expect(screen.getByText("1 silinen post")).toBeInTheDocument();
    expect(screen.getByText("Instagram · 10 Ara tarihinde kalıcı silinir")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Geri al" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("t1"));
    await userEvent.click(screen.getByRole("button", { name: "Kalıcı olarak sil…" }));
    expect(usePostsStore.getState().deleting?.id).toBe("t1");
  });
});

describe("plans view (N2, N4)", () => {
  function planItem(id: string, over: Partial<PlanItem> = {}): PlanItem {
    return {
      id,
      planId: "pl1",
      position: Number(id.replace(/\D/g, "")) || 0,
      date: "2026-11-20",
      platforms: ["instagram"],
      contentType: "carousel",
      title: `Konu ${id}`,
      brief: "",
      pillar: null,
      imageSlot: "none",
      imageBrief: null,
      status: "accepted",
      contentId: `c${id}`,
      generation: null,
      createdAt: T,
      updatedAt: T,
      ...over,
    };
  }
  const failedGen = { jobId: "g", status: "failed" as const, error: "render failed" };

  function renderPlans(items: PlanItem[], api: Record<string, unknown>) {
    const p: Plan = {
      id: "pl1",
      brandId: "b1",
      conversationId: null,
      runId: null,
      title: "Kasım içerikleri",
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      status: "accepted",
      summary: "",
      revision: 2,
      decidedAt: T,
      rejectionReason: null,
      items,
      createdAt: T,
      updatedAt: T,
    };
    const contents = items.map((i) =>
      i.id === "i1"
        ? contentFor(version(`c${i.id}`, 1), { id: `c${i.id}`, status: "approved" })
        : content({ id: `c${i.id}` }),
    );
    return providers(<PlansView brandId="b1" brandName={() => "MTM Agro"} />, api, (q) => {
      q.setQueryData(postKeys.plans("b1"), [p]);
      q.setQueryData(postKeys.contents("b1"), contents);
    });
  }

  it("shows each item's state with human labels and generates only the failed ones", async () => {
    const generate = vi.fn(async () => ({ plan: {}, jobs: [job()], skipped: [] }));
    renderPlans([planItem("i1"), planItem("i2", { generation: failedGen }), planItem("i3")], {
      plans: { generate },
    });
    expect(screen.getByRole("heading", { name: /Kasım içerikleri/ })).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getByText("Onaylandı")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("Kaydırmalı")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Başarısız")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Görsel oluşturulamadı.")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Bekliyor")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Yalnızca başarısızları üret (1)" }));
    await waitFor(() => expect(generate).toHaveBeenCalledWith("pl1", { itemIds: ["i2"] }));
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe("1 post üretime alındı.");
    // One item: "Üret" goes at once.
    await userEvent.click(within(rows[2] as HTMLElement).getByRole("button", { name: "Üret" }));
    await waitFor(() => expect(generate).toHaveBeenLastCalledWith("pl1", { itemIds: ["i3"] }));
  });

  it("shows the estimate before generating many posts and starts after the yes", async () => {
    const generate = vi.fn(async () => ({ plan: {}, jobs: [], skipped: [] }));
    const estimate: GenerationEstimate = {
      count: 7,
      perItemSeconds: 180,
      totalSeconds: 1_260,
      basis: "default",
      sampleSize: 0,
      defaultsAsOf: "2026-11-18",
      perItemUsd: 0,
      textUsd: 0,
      imageSlots: 0,
      perImageUsd: 0.04,
      imagesIncluded: false,
      imageUsd: 0,
      totalUsd: 0,
      budgetRemainingUsd: null,
    };
    const generation = vi.fn(async () => estimate);
    renderPlans(
      Array.from({ length: 7 }, (_, i) => planItem(`i${i + 2}`)),
      { plans: { generate }, estimates: { generation } },
    );
    await userEvent.click(screen.getByRole("button", { name: "Bekleyenleri üret (7)" }));
    const dialog = await screen.findByRole("dialog", { name: "Üretim başlasın mı?" });
    await within(dialog).findByText(/≈ 21 dakika, ≈ \$0 \(Claude aboneliği: ücretsiz/);
    expect(generation).toHaveBeenCalledWith({ count: 7, brandId: "b1", imageSlots: 0 });
    expect(generate).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Başlat" }));
    await waitFor(() => expect(generate).toHaveBeenCalledWith("pl1", {}));
  });

  it("asks twice before regenerating a post that was edited or approved", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("Post onaylı.", 409, "conflict"))
      .mockResolvedValueOnce({ plan: {}, jobs: [job()], skipped: [] });
    renderPlans([planItem("i1")], { plans: { generate } });
    await userEvent.click(screen.getByRole("button", { name: "Yeniden üret" }));
    await userEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Yeniden üret" }),
    );
    await waitFor(() =>
      expect(generate).toHaveBeenCalledWith("pl1", { itemIds: ["i1"], force: true }),
    );
    const second = await screen.findByRole("button", { name: "Yine de yeniden üret" });
    await userEvent.click(second);
    await waitFor(() =>
      expect(generate).toHaveBeenLastCalledWith("pl1", {
        itemIds: ["i1"],
        force: true,
        overwriteEdits: true,
      }),
    );
  });

  it("edits an item in place", async () => {
    const updateItem = vi.fn(async () => ({}));
    renderPlans([planItem("i3")], { plans: { updateItem } });
    await userEvent.click(screen.getByRole("button", { name: "Düzenle: Konu i3" }));
    const dialog = await screen.findByRole("dialog", { name: "Kalemi düzenle" });
    const topic = within(dialog).getByRole("textbox", { name: "Konu" });
    await userEvent.clear(topic);
    await userEvent.type(topic, "Kış bakımı");
    await userEvent.click(within(dialog).getByRole("radio", { name: "Reels" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Kaydet" }));
    await waitFor(() =>
      expect(updateItem).toHaveBeenCalledWith("pl1", "i3", {
        title: "Kış bakımı",
        contentType: "reel",
      }),
    );
  });
});

describe("the chat plan card's Düzenle (N2)", () => {
  it("opens the plan on the posts screen with human type names", async () => {
    const onEdit = vi.fn();
    const plan = {
      id: "pl9",
      brandId: "b7",
      conversationId: "c1",
      runId: null,
      title: "Aralık",
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
      status: "proposed",
      summary: "",
      revision: 1,
      decidedAt: null,
      rejectionReason: null,
      items: [
        {
          id: "x",
          planId: "pl9",
          position: 0,
          date: "2026-12-02",
          platforms: ["instagram"],
          contentType: "story",
          title: "Yılbaşı",
          brief: "",
          pillar: null,
          imageSlot: "none",
          imageBrief: null,
          status: "planned",
          contentId: null,
          generation: null,
          createdAt: T,
          updatedAt: T,
        },
      ],
      createdAt: T,
      updatedAt: T,
    } satisfies Plan;
    render(<PlanProposalCard plan={plan} busy={false} controller={{} as never} onEdit={onEdit} />);
    expect(screen.getByText("Hikâye")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));
    expect(useAppStore.getState().route).toEqual({ kind: "posts" });
    expect(useAppStore.getState().currentBrandId).toBe("b7");
    expect(usePostsStore.getState()).toMatchObject({ view: "plans", planId: "pl9" });
  });

  it("shows the time and cost before generating more than five posts", async () => {
    const item = (i: number) => ({
      id: `x${i}`,
      planId: "pl9",
      position: i,
      date: "2026-12-02",
      platforms: ["instagram" as const],
      contentType: "post" as const,
      title: `Konu ${i}`,
      brief: "",
      pillar: null,
      imageSlot: (i === 0 ? "ai_generate" : "none") as PlanItem["imageSlot"],
      imageBrief: null,
      status: "planned" as const,
      contentId: null,
      generation: null,
      createdAt: T,
      updatedAt: T,
    });
    const plan = {
      id: "pl9",
      brandId: "b7",
      conversationId: "c1",
      runId: null,
      title: "Aralık",
      periodStart: "2026-12-01",
      periodEnd: "2026-12-31",
      status: "proposed",
      summary: "",
      revision: 1,
      decidedAt: null,
      rejectionReason: null,
      items: Array.from({ length: 6 }, (_, i) => item(i)),
      createdAt: T,
      updatedAt: T,
    } as Plan;
    const acceptAndGenerate = vi.fn(async () => undefined);
    const generation = vi.fn(async () => ({
      count: 6,
      perItemSeconds: 180,
      totalSeconds: 1_080,
      basis: "default" as const,
      sampleSize: 0,
      defaultsAsOf: "2026-11-18",
      perItemUsd: 0,
      textUsd: 0,
      imageSlots: 1,
      perImageUsd: 0.04,
      imagesIncluded: false,
      imageUsd: 0.04,
      totalUsd: 0,
      budgetRemainingUsd: null,
    }));
    providers(
      <PlanProposalCard
        plan={plan}
        busy={false}
        controller={{ acceptAndGenerate } as never}
        onEdit={() => undefined}
      />,
      { estimates: { generation } },
    );
    await userEvent.click(screen.getByRole("button", { name: "Onayla ve üret" }));
    const dialog = await screen.findByRole("dialog", { name: "Üretim başlasın mı?" });
    await within(dialog).findByText(/≈ 18 dakika/);
    expect(generation).toHaveBeenCalledWith({ count: 6, brandId: "b7", imageSlots: 1 });
    expect(acceptAndGenerate).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Onayla ve üret" }));
    await waitFor(() => expect(acceptAndGenerate).toHaveBeenCalledWith(plan));
  });
});

describe("media delete (7)", () => {
  function Harness({ onReady }: { onReady(remove: (a: never) => Promise<void>): void }) {
    const deletion = useAssetDelete("b1");
    onReady(deletion.remove as never);
    return deletion.dialog;
  }
  const asset = {
    id: "a1",
    brandId: "b1",
    kind: "image",
    source: "upload",
    objectKey: "k",
    mimeType: "image/png",
    bytes: 10,
    sha256: "x",
    width: 10,
    height: 10,
    durationMs: null,
    originalFilename: "gubre.png",
    createdAt: T,
  };

  it("lists where a used file is, and moves an unused one to the trash with undo", async () => {
    const del = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("used", 409, "conflict"))
      .mockResolvedValueOnce(undefined);
    const restore = vi.fn(async () => asset);
    const usage = vi.fn(async () => ({
      assetId: "a1",
      deletable: false,
      usages: [
        {
          kind: "version",
          blocking: true,
          label: "“Kış” v2, 1. kare",
          contentId: "p1",
          version: 2,
          productId: null,
          conversationId: null,
        },
      ],
    }));
    let remove: ((a: never) => Promise<void>) | null = null;
    providers(<Harness onReady={(r) => (remove = r)} />, {
      assets: { delete: del, restore, usage },
    });
    await act(async () => {
      await remove?.(asset as never);
    });
    const dialog = await screen.findByRole("dialog", { name: "Bu dosya kullanılıyor" });
    expect(within(dialog).getByText("“Kış” v2, 1. kare")).toBeInTheDocument();
    expect(within(dialog).getByText("Postlarda")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Tamam" }));
    await act(async () => {
      await remove?.(asset as never);
    });
    const toast = useAppStore.getState().toasts.at(-1);
    expect(toast?.message).toBe("“gubre.png” Silinenler'e taşındı.");
    expect(toast?.durationMs).toBe(10_000);
    toast?.action?.run();
    await waitFor(() => expect(restore).toHaveBeenCalledWith("a1"));
  });
});
