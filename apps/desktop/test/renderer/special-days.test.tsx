// Special days and plan similarity in the desktop (N5, N6): the labels Takvim and Planlar show,
// the "Benzer: 12 Ekim postu" mark on the Planlar view and the chat's plan card, the planned hook
// in the item form, and the brand's special-day settings (sector tags, categories, bayram dates).
import {
  type ApiClient,
  type BrandPlanningSettings,
  type Plan,
  type PlanItem,
  type PlanItemSimilar,
  specialDaysBetween,
} from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PlanProposalCard } from "../../src/renderer/components/chat/blocks.tsx";
import {
  SpecialDaysForm,
  SpecialDaysSection,
} from "../../src/renderer/features/brand/special-days-section.tsx";
import { DayLabels } from "../../src/renderer/features/calendar/special-day-views.tsx";
import { specialDayKeys } from "../../src/renderer/features/calendar/special-days-data.ts";
import {
  bayramRows,
  dayLabelTone,
  gridRange,
  labelsByDay,
  overridesPut,
  planningDraft,
  planningPut,
  similarText,
  similarTitle,
  toggleDayCategory,
  toggleTag,
} from "../../src/renderer/features/calendar/special-days-model.ts";
import { postKeys } from "../../src/renderer/features/posts/data.ts";
import { draftOf, draftPatch } from "../../src/renderer/features/posts/plan-model.ts";
import { PlansView } from "../../src/renderer/features/posts/plans-view.tsx";
import { usePostsStore } from "../../src/renderer/features/posts/store.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { content, T } from "./post-fixtures.ts";

const MARK: PlanItemSimilar = {
  kind: "post",
  contentId: "c_old",
  planItemId: null,
  title: "Kış öncesi toprak analizi",
  date: "2026-10-12",
  field: "title",
  score: 0.62,
};

function planItem(id: string, over: Partial<PlanItem> = {}): PlanItem {
  return {
    id,
    planId: "pl1",
    position: Number(id.replace(/\D/g, "")) || 0,
    date: "2026-11-20",
    platforms: ["instagram"],
    productIds: [],
    imageView: null,
    contentType: "post",
    title: `Konu ${id}`,
    brief: "",
    pillar: null,
    hook: null,
    imageSlot: "none",
    imageBrief: null,
    status: "planned",
    similar: [],
    contentId: null,
    generation: null,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

function plan(items: PlanItem[], over: Partial<Plan> = {}): Plan {
  return {
    id: "pl1",
    brandId: "b1",
    conversationId: null,
    runId: null,
    title: "Kasım içerikleri",
    periodStart: "2026-11-01",
    periodEnd: "2026-11-30",
    status: "proposed",
    summary: "",
    revision: 1,
    decidedAt: null,
    rejectionReason: null,
    items,
    createdAt: T,
    updatedAt: T,
    ...over,
  };
}

/** Without a running host the queries do not fetch: tests seed what the server would answer. */
function providers(ui: ReactNode, api: unknown = {}, seed?: (q: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePostsStore.setState({ view: "plans", planId: null });
});

describe("special-day labels (N5)", () => {
  it("puts a bayram on each of its days and holidays first", () => {
    const days = specialDaysBetween("2026-03-01", "2026-03-31");
    const labels = labelsByDay(days);
    expect(labels.get("2026-03-20")?.[0]).toMatchObject({
      text: "Ramazan Bayramı",
      tone: "holiday",
    });
    expect(labels.get("2026-03-22")?.[0]?.text).toBe("Ramazan Bayramı (3. gün)");
    expect(labels.get("2026-03-19")?.[0]).toMatchObject({
      text: "Ramazan Bayramı arifesi",
      tone: "religious",
    });
    expect(labels.get("2026-03-18")?.[0]?.tone).toBe("remembrance"); // Çanakkale
    expect(labels.get("2026-03-20")?.[0]?.title).toContain("Resmî tatil");
    // A computed kandil says so in its tooltip.
    const kandil = labelsByDay(specialDaysBetween("2026-12-01", "2026-12-31")).get("2026-12-10");
    expect(kandil?.[0]?.title).toContain("±1 gün");
    expect(dayLabelTone({ holiday: null, category: "ticari", tone: "ticari" })).toBe("other");
  });

  it("covers a month grid's leading and trailing days", () => {
    expect(gridRange({ year: 2026, month: 11 })).toEqual({ from: "2026-10-26", to: "2026-12-06" });
  });

  it("shows a few labels and counts the rest", () => {
    const labels = [
      { key: "a", text: "Bir", title: "Bir", tone: "holiday" as const },
      { key: "b", text: "İki", title: "İki", tone: "other" as const },
      { key: "c", text: "Üç", title: "Üç gün", tone: "other" as const },
    ];
    render(<DayLabels labels={labels} max={2} />);
    expect(screen.getByText("Bir")).toHaveClass("text-danger");
    expect(screen.getByText("+1 özel gün")).toHaveAttribute("title", "Üç gün");
  });
});

describe("plan similarity marks (N6)", () => {
  it("reads as plain Turkish with every match in the tooltip", () => {
    expect(similarText({ similar: [MARK] })).toBe("Benzer: 12 Ekim postu");
    expect(similarText({ similar: [] })).toBeNull();
    expect(similarText({})).toBeNull(); // a plan cached from an older server
    expect(similarTitle({ similar: [MARK] })).toBe(
      "12 Ekim postu: “Kış öncesi toprak analizi” (konu benzerliği %62)",
    );
  });

  it("marks items and lists the period's special days on the Planlar view", () => {
    const items = [
      planItem("i1", { date: "2026-11-24", title: "Öğretmenlerimize teşekkür" }),
      planItem("i2", { title: "Kışa hazırlık: toprak analizi", similar: [MARK] }),
    ];
    providers(<PlansView brandId="b1" brandName={() => "MTM Agro"} />, {}, (q) => {
      q.setQueryData(postKeys.plans("b1"), [plan(items)]);
      q.setQueryData(postKeys.contents("b1"), [content({ id: "c1" })]);
      q.setQueryData(
        specialDayKeys.range("b1", "2026-11-01", "2026-11-30"),
        specialDaysBetween("2026-11-01", "2026-11-30"),
      );
    });
    const header = screen.getByRole("list", { name: "Dönemin özel günleri" });
    expect(within(header).getByText(/Atatürk'ü Anma Günü/)).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getByText("Öğretmenler Günü")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("Benzer: 12 Ekim postu")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).queryByText(/Benzer/)).toBeNull();
  });

  it("marks items on the chat's plan card", () => {
    const controller = {
      acceptAndGenerate: vi.fn(),
      acceptPlan: vi.fn(),
      rejectPlan: vi.fn(),
      generatePlan: vi.fn(),
    } as unknown as Parameters<typeof PlanProposalCard>[0]["controller"];
    providers(
      <PlanProposalCard
        plan={plan([planItem("i1"), planItem("i2", { similar: [MARK] })])}
        busy={false}
        controller={controller}
        onEdit={() => {}}
      />,
    );
    expect(screen.getByText("Benzer: 12 Ekim postu")).toBeInTheDocument();
    expect(screen.getAllByText(/Benzer/)).toHaveLength(1);
  });

  it("edits the planned hook with the item", () => {
    const item = planItem("i1", { hook: "Toprağın hazır mı?" });
    const draft = draftOf(item);
    expect(draft.hook).toBe("Toprağın hazır mı?");
    expect(draftPatch(item, { ...draft, hook: "  Yeni kanca " })).toEqual({ hook: "Yeni kanca" });
    expect(draftPatch(item, { ...draft, hook: "" })).toEqual({ hook: null });
    expect(draftPatch(item, draft)).toEqual({});
  });
});

describe("brand special-day settings (N5)", () => {
  const suggested: BrandPlanningSettings = {
    brandId: "b1",
    sectorTags: [],
    disabledCategories: [],
    suggestedTags: ["tarim"],
    updatedAt: null,
  };

  it("starts from the suggestion and saves tags and categories in catalogue order", () => {
    const draft = planningDraft(suggested);
    expect(draft.suggested).toBe(true);
    expect([...draft.tags]).toEqual(["tarim"]);
    const next = toggleDayCategory(toggleTag(toggleTag(draft, "gida"), "tarim"), "ticari", false);
    expect(next.suggested).toBe(false);
    expect(planningPut(next)).toEqual({ sectorTags: ["gida"], disabledCategories: ["ticari"] });
  });

  it("toggles tags and categories in the form", async () => {
    const onChange = vi.fn();
    render(<SpecialDaysForm draft={planningDraft(suggested)} onChange={onChange} />);
    expect(screen.getByText(/Marka profilinden ve ürünlerden önerildi/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tarım" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Sağlık" }));
    expect([...(onChange.mock.calls[0]?.[0].tags ?? [])]).toEqual(["tarim", "saglik"]);
    await userEvent.click(screen.getByRole("switch", { name: "Dinî bayramlar ve günler açık" }));
    expect([...(onChange.mock.calls[1]?.[0].disabled ?? [])]).toEqual(["dini"]);
  });

  it("saves the brand's choices shortly after a change", async () => {
    const putSettings = vi.fn(async (_id: string, input: unknown) => ({
      ...suggested,
      ...(input as object),
      updatedAt: T,
    }));
    const api = { planning: { putSettings, putOverrides: vi.fn() } };
    providers(<SpecialDaysSection brand={{ id: "b1" }} />, api, (q) => {
      q.setQueryData(specialDayKeys.settings("b1"), suggested);
      q.setQueryData(specialDayKeys.overrides, { overrides: [], updatedAt: null });
    });
    await userEvent.click(await screen.findByRole("button", { name: "Kültür ve sanat" }));
    await waitFor(() =>
      expect(putSettings).toHaveBeenCalledWith("b1", {
        sectorTags: ["tarim", "kultur"],
        disabledCategories: [],
      }),
    );
    expect(await screen.findByRole("region", { name: "Bayram tarihleri" })).toBeInTheDocument();
  });

  it("keeps only bayram dates that differ from Diyanet's or the computed ones", () => {
    const rows = bayramRows(
      [2026, 2031],
      [{ year: 2031, ramazanBayrami: null, kurbanBayrami: null }],
    );
    expect(rows[0]).toMatchObject({
      year: 2026,
      ramazan: "2026-03-20",
      kurban: "2026-05-27",
      approximate: false,
    });
    expect(rows[1]?.approximate).toBe(true);
    const edited = rows.map((r) => (r.year === 2026 ? { ...r, kurban: "2026-05-28" } : r));
    expect(
      overridesPut(edited, [{ year: 2040, ramazanBayrami: "2040-10-07", kurbanBayrami: null }]),
    ).toEqual([
      { year: 2026, ramazanBayrami: null, kurbanBayrami: "2026-05-28" },
      { year: 2040, ramazanBayrami: "2040-10-07", kurbanBayrami: null },
    ]);
    expect(overridesPut(rows, [])).toEqual([]);
  });
});
