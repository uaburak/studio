// N15 on the desktop: number formatting and the heatmap's levels, the Performans page (tiles,
// best posts, groups, best-time grid, account states, "Şimdi güncelle") and the post detail's
// Performans panel.
import {
  type ApiClient,
  type BestTimes,
  type BrandPerformance,
  type ContentPerformance,
  computeBestTimes,
} from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ago,
  followerChange,
  formatCount,
  formatIndex,
  formatMetric,
  formatRate,
  gridRange,
  heatLevel,
  hoursLabel,
  metricEntries,
  signed,
  syncStateText,
} from "../../src/renderer/features/performance/performance-model.ts";
import {
  BestTimeGrid,
  PerformanceBody,
  PerformanceView,
} from "../../src/renderer/features/performance/performance-page.tsx";
import {
  hasReadablePublish,
  PostPerformancePanel,
} from "../../src/renderer/features/post-detail/post-performance.tsx";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import { schedule } from "./post-fixtures.ts";

// The host is up (queries run against the fake client); no live job feed.
vi.mock("../../src/renderer/state/studio.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/renderer/state/studio.tsx")>();
  return { ...actual, isHostUp: () => true, useJobList: () => [] };
});

const NOW = new Date("2026-11-19T10:00:00.000Z");

function providers(ui: ReactNode, api: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
    </QueryClientProvider>,
  );
}

function bestTimes(): BestTimes {
  const posts = Array.from({ length: 10 }, (_, i) => ({
    publishedAt: new Date(Date.UTC(2026, 9, 6 + i * 7, 16)).toISOString(),
    score: 1.5,
  }));
  return computeBestTimes(posts, { days: 90 });
}

function perf(over: Partial<BrandPerformance> = {}): BrandPerformance {
  const group = (key: string, label: string, index: number) => ({
    key,
    label,
    posts: 3,
    avgReach: 900,
    avgEngagementRate: 0.05,
    index,
  });
  return {
    brandId: "b1",
    from: "2026-08-21T10:00:00.000Z",
    to: NOW.toISOString(),
    posts: 12,
    totals: { reach: 15_400, likes: 800 },
    avgReach: 1283,
    avgEngagementRate: 0.0542,
    topPosts: [
      {
        scheduleId: "s1",
        contentId: "p1",
        title: "Hasat zamanı",
        platform: "instagram",
        contentType: "carousel",
        pillar: "eğitim",
        hook: "Toprağı tanı",
        publishedAt: "2026-11-10T16:00:00.000Z",
        permalink: null,
        metrics: { reach: 3200, likes: 210 },
        engagementRate: 0.081,
        score: 1.62,
      },
    ],
    byPillar: [group("eğitim", "eğitim", 1.4), group("kampanya", "kampanya", 0.6)],
    byFormat: [group("carousel", "Carousel", 1.3)],
    byWeekday: [group("1", "Salı", 1.2)],
    byHour: [group("19", "19:00", 1.25)],
    trend: [
      { week: "2026-11-02", posts: 3, reach: 4000, interactions: 220, avgEngagementRate: 0.055 },
      { week: "2026-11-09", posts: 4, reach: 6000, interactions: 300, avgEngagementRate: 0.05 },
    ],
    followers: [
      {
        socialAccountId: "a1",
        platform: "instagram",
        handle: "@mtmagro",
        points: [
          { day: "2026-11-01", followers: 1200 },
          { day: "2026-11-19", followers: 1240 },
        ],
      },
    ],
    bestTimes: bestTimes(),
    accounts: [
      {
        socialAccountId: "a1",
        platform: "instagram",
        handle: "@mtmagro",
        insightsSyncedAt: "2026-11-19T09:30:00.000Z",
        commentsSyncedAt: null,
        error: null,
        needsReconnect: false,
        retryAt: null,
      },
      {
        socialAccountId: "a2",
        platform: "facebook",
        handle: "MTM Agro",
        insightsSyncedAt: null,
        commentsSyncedAt: null,
        error: null,
        needsReconnect: true,
        retryAt: null,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  useAppStore.setState({
    route: { kind: "performance" },
    post: null,
    back: [],
    forward: [],
    toasts: [],
  });
});

afterEach(() => {
  useAppStore.setState({ toasts: [] });
});

describe("statistics in words", () => {
  it("formats counts, rates, indexes and metrics in Turkish", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(12_345)).toMatch(/^12,3\s?B$/);
    expect(formatCount(null)).toBe("—");
    expect(formatRate(0.0542)).toBe("%5,4");
    expect(formatRate(null)).toBe("—");
    expect(formatIndex(1.4)).toBe("1,40×");
    expect(formatMetric("avgWatchMs", 4200)).toBe("4,2 sn");
    expect(metricEntries({ likes: 3, reach: 100, avgWatchMs: 10 }).map(([k]) => k)).toEqual([
      "reach",
      "likes",
      "avgWatchMs",
    ]);
    expect(signed(40)).toBe("+40");
    expect(signed(-3)).toBe("−3");
    expect(followerChange([{ followers: 10 }, { followers: 7 }])).toEqual({ last: 7, delta: -3 });
    expect(followerChange([])).toEqual({ last: null, delta: null });
  });

  it("names reads after publishing and their age", () => {
    expect(hoursLabel(1)).toBe("1. saat");
    expect(hoursLabel(24)).toBe("24. saat");
    expect(hoursLabel(72)).toBe("3. gün");
    expect(hoursLabel(null)).toBe("—");
    expect(ago(null, NOW)).toBe("henüz okunmadı");
    expect(ago("2026-11-19T09:55:00.000Z", NOW)).toBe("5 dk önce");
    expect(ago("2026-11-19T07:00:00.000Z", NOW)).toBe("3 sa önce");
    expect(ago("2026-11-17T10:00:00.000Z", NOW)).toBe("2 gün önce");
  });

  it("scales heatmap cells into four levels and leaves empty hours blank", () => {
    const grid = [[null, 0.5, 1, 1.5, 2]];
    const range = gridRange(grid);
    expect(range).toEqual({ min: 0.5, max: 2 });
    expect(grid[0]?.map((v) => heatLevel(v, range))).toEqual([0, 1, 2, 3, 4]);
    expect(heatLevel(1, { min: 1, max: 1 })).toBe(2);
    expect(gridRange([[null, null]])).toBeNull();
  });

  it("explains an account's reads", () => {
    const base = perf().accounts[0] as BrandPerformance["accounts"][number];
    expect(syncStateText(base, NOW)).toBe("Son okuma: 30 dk önce");
    expect(syncStateText({ ...base, needsReconnect: true }, NOW)).toMatch(/^Yeniden bağlayın/);
    expect(syncStateText({ ...base, retryAt: "2026-11-19T11:00:00.000Z" }, NOW)).toMatch(
      /^Meta istek sınırı: 14:00 sonrası/,
    );
  });
});

describe("Performans page", () => {
  it("shows tiles, best posts, groups, the trend, account states and the best times", async () => {
    const user = userEvent.setup();
    providers(<PerformanceView perf={perf()} now={NOW} />, {});
    const summary = screen.getByRole("region", { name: "Özet" });
    expect(within(summary).getByText("Ortalama etkileşim oranı")).toBeInTheDocument();
    expect(within(summary).getByText("%5,4")).toBeInTheDocument();
    expect(within(summary).getByText("Takipçi · @mtmagro")).toBeInTheDocument();
    expect(within(summary).getByText("dönemde +40")).toBeInTheDocument();
    expect(screen.getByText(/MTM Agro/).closest("p")?.textContent).toMatch(/Yeniden bağlayın/);

    const best = screen.getByRole("region", { name: "En iyi postlar" });
    expect(within(best).getByText("Hasat zamanı")).toBeInTheDocument();
    expect(within(best).getByText("1,62×")).toBeInTheDocument();
    await user.click(within(best).getByRole("button", { name: /Hasat zamanı/ }));
    expect(useAppStore.getState().post).toBe("p1");

    const pillars = screen.getByRole("region", { name: "Sütunlar" });
    expect(
      within(pillars)
        .getAllByRole("row")
        .map((r) => r.textContent),
    ).toEqual([
      expect.stringContaining("Sütun"),
      expect.stringContaining("1,40×"),
      expect.stringContaining("0,60×"),
    ]);
    expect(screen.getByRole("region", { name: "Haftalık gidiş" })).toBeInTheDocument();

    const grid = screen.getByRole("table", { name: "Saat ve gün ısı haritası" });
    expect(within(grid).getAllByRole("row")).toHaveLength(8);
    // Tuesday 19:00 (16:00 UTC) is the brand's strongest cell.
    const strong = grid.querySelector('td[title^="Salı 19:00"]');
    expect(strong?.getAttribute("data-level")).not.toBe("0");
    expect(grid.querySelector('td[title^="Pazartesi 03:00"]')?.getAttribute("data-level")).toBe(
      "0",
    );
    expect(screen.getByText(/Son 90 günün 10 postuna göre/)).toBeInTheDocument();
  });

  it("says when nothing was read yet and offers general slots", () => {
    const general = computeBestTimes([]);
    providers(
      <PerformanceView perf={perf({ posts: 0, topPosts: [], bestTimes: general })} now={NOW} />,
      {},
    );
    expect(screen.getByText("Bu dönemde istatistiği okunmuş post yok.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "En iyi postlar" })).toBeNull();
    const times = screen.getByRole("region", { name: "En iyi saatler" });
    expect(within(times).getByText(/genel olarak iyi giden saatler/)).toBeInTheDocument();
    expect(within(times).getByText("Salı 19:00")).toBeInTheDocument();
  });

  it("loads the brand's numbers for the period and platform; Şimdi güncelle queues a read", async () => {
    const user = userEvent.setup();
    const brand = vi.fn(async () => perf());
    const sync = vi.fn(async () => ({ id: "job1", type: "insights.sync", status: "queued" }));
    providers(<PerformanceBody brandId="b1" brandName="MTM Agro" />, {
      insights: { brand, sync },
    });
    await screen.findByText("Hasat zamanı");
    expect(brand).toHaveBeenCalledWith("b1", { days: 90 });
    await user.click(screen.getByRole("radio", { name: /Instagram/ }));
    await waitFor(() =>
      expect(brand).toHaveBeenLastCalledWith("b1", { days: 90, platform: "instagram" }),
    );
    await user.click(screen.getByRole("radio", { name: /30 gün/ }));
    await waitFor(() =>
      expect(brand).toHaveBeenLastCalledWith("b1", { days: 30, platform: "instagram" }),
    );
    await user.click(screen.getByRole("button", { name: "Şimdi güncelle" }));
    expect(sync).toHaveBeenCalledWith({ brandId: "b1" });
    expect(useAppStore.getState().toasts.at(-1)?.message).toMatch(/İstatistikler okunuyor/);
  });

  it("the grid lists suggestions with their index", () => {
    providers(<BestTimeGrid best={bestTimes()} />, {});
    const region = screen.getByRole("region", { name: "En iyi saatler" });
    expect(within(region).getByText(/^Salı (18|19|20):00 · 1,50×$/)).toBeInTheDocument();
  });
});

describe("post detail Performans", () => {
  const performance: ContentPerformance = {
    contentId: "p1",
    posts: [
      {
        scheduleId: "s1",
        contentId: "p1",
        brandId: "b1",
        socialAccountId: "a1",
        platform: "instagram",
        externalPostId: "1789",
        contentType: "post",
        publishedAt: "2026-11-18T07:00:00.000Z",
        permalink: null,
        status: "ok",
        metrics: { reach: 1000, views: 1800, likes: 60, comments: 4, saves: 9, shares: 2 },
        engagementRate: 0.075,
        note: null,
        syncedAt: "2026-11-19T07:00:00.000Z",
        nextSyncAt: "2026-11-21T07:00:00.000Z",
        accountHandle: "@mtmagro",
        snapshots: [
          {
            at: "2026-11-18T08:00:00.000Z",
            hoursAfterPublish: 1,
            metrics: { reach: 200, likes: 12 },
          },
          {
            at: "2026-11-19T07:00:00.000Z",
            hoursAfterPublish: 24,
            metrics: { reach: 1000, likes: 60 },
          },
        ],
      },
      {
        scheduleId: "s2",
        contentId: "p1",
        brandId: "b1",
        socialAccountId: "a2",
        platform: "facebook",
        externalPostId: "100_200",
        contentType: "post",
        publishedAt: "2026-11-18T07:00:00.000Z",
        permalink: null,
        status: "partial",
        metrics: { likes: 5, comments: 1 },
        engagementRate: null,
        note: "Yalnızca beğeni ve yorum sayıları okundu; erişim için hesabı yeniden bağlayıp istatistik iznini verin.",
        syncedAt: "2026-11-19T07:00:00.000Z",
        nextSyncAt: null,
        accountHandle: "MTM Agro",
        snapshots: [],
      },
    ],
    totals: { reach: 1000, likes: 65 },
    needsReconnect: ["a2"],
  };

  it("appears only for posts published on Instagram or Facebook", () => {
    expect(hasReadablePublish([schedule({ status: "pending" })])).toBe(false);
    expect(hasReadablePublish([schedule({ status: "published", platform: "linkedin" })])).toBe(
      false,
    );
    expect(hasReadablePublish([schedule({ status: "published" })])).toBe(true);
    const { container } = providers(
      <PostPerformancePanel contentId="p1" schedules={[schedule({ status: "pending" })]} />,
      {},
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows each account's numbers, history, missing permissions; Şimdi güncelle reads the post", async () => {
    const user = userEvent.setup();
    const sync = vi.fn(async () => ({ id: "job2", type: "insights.sync", status: "queued" }));
    providers(
      <PostPerformancePanel contentId="p1" schedules={[schedule({ status: "published" })]} />,
      { contents: { performance: vi.fn(async () => performance) }, insights: { sync } },
    );
    const panel = await screen.findByRole("region", { name: "Performans" });
    await within(panel).findByText("@mtmagro");
    expect(within(panel).getByText("etkileşim %7,5")).toBeInTheDocument();
    expect(within(panel).getByText("Erişim")).toBeInTheDocument();
    expect(within(panel).getByText("1.800")).toBeInTheDocument();
    expect(within(panel).getByText(/Yalnızca beğeni ve yorum sayıları okundu/)).toBeInTheDocument();
    expect(
      within(panel).getByText(/hesabı yeniden bağlayıp istatistik iznini verin \(Ayarlar/),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Geçmiş (2)" }));
    const history = within(panel).getByRole("table", { name: "Okuma geçmişi" });
    expect(
      within(history)
        .getAllByRole("row")
        .map((r) => r.firstChild?.textContent),
    ).toEqual(["Zaman", "1. saat", "24. saat"]);
    await user.click(within(panel).getByRole("button", { name: "Şimdi güncelle" }));
    expect(sync).toHaveBeenCalledWith({ contentId: "p1" });
  });
});
