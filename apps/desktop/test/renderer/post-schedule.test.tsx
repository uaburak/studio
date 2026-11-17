import type { ApiClient, Content, Schedule } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  blockingReason,
  dateError,
  defaultAccountIds,
  defaultScheduleDate,
  defaultTime,
  needsApproval,
  publishNowConfirmation,
  type ScheduleApi,
  SubmitError,
  schedulableAccounts,
  scheduleDisplay,
  submitSchedule,
} from "../../src/renderer/features/post-detail/schedule.ts";
import { ScheduleSheet } from "../../src/renderer/features/post-detail/schedule-sheet.tsx";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import {
  account,
  content,
  contentFor,
  HASH0,
  preflight,
  schedule,
  version,
} from "./post-fixtures.ts";

const NOW = new Date("2026-11-17T10:00:00.000Z"); // 13:00 in Istanbul

afterEach(() => {
  useAppStore.setState({ toasts: [] });
});

describe("schedule rules", () => {
  it("defaults to the pending schedule, else the plan day at 10:00, else tomorrow 10:00", () => {
    const pending = schedule({ scheduledAt: "2026-11-20T07:00:00.000Z" });
    expect(defaultScheduleDate({ schedule: pending, planItem: null }, NOW).toISOString()).toBe(
      "2026-11-20T07:00:00.000Z",
    );
    const plan = defaultScheduleDate({ schedule: null, planItem: { date: "2026-11-24" } }, NOW);
    expect([plan.getDate(), plan.getHours(), plan.getMinutes()]).toEqual([24, 10, 0]);
    // A plan day in the past falls back to tomorrow.
    const past = defaultScheduleDate({ schedule: null, planItem: { date: "2026-11-01" } }, NOW);
    expect([past.getDate(), past.getHours()]).toEqual([18, 10]);
    // Today after 10:00: the next half hour.
    const today = defaultTime(NOW, NOW);
    expect([today.getHours(), today.getMinutes()]).toEqual([13, 30]);
  });

  it("validates the time", () => {
    expect(dateError(null, NOW)).toMatch(/Geçerli/);
    expect(dateError(new Date(NOW.getTime() + 30_000), NOW)).toMatch(/bir dakika/);
    expect(dateError(new Date(NOW.getTime() + 3_600_000), NOW)).toBeNull();
  });

  it("offers the brand's enabled accounts on the post's platforms", () => {
    const accounts = [
      account(),
      account({ id: "a2", platform: "facebook", handle: "MTM" }),
      account({ id: "a3", status: "disabled" }),
      account({ id: "a4", brandId: "b2" }),
      account({ id: "a5", status: "needs_reauth" }),
    ];
    const list = schedulableAccounts(accounts, content({ targetPlatforms: ["instagram"] }));
    expect(list.map((a) => a.id)).toEqual(["a1", "a5"]);
    expect(defaultAccountIds(list)).toEqual(["a1"]);
  });

  it("blocks with the first reason in order", () => {
    const c = contentFor(version("p1", 1), { status: "approved" });
    const accounts = [account()];
    expect(blockingReason({ content: null, accounts, selected: [], preflight: null })).toMatch(
      /onaylı bir post/,
    );
    expect(blockingReason({ content: c, accounts: [], selected: [], preflight: null })).toMatch(
      /bağlı hesap yok/,
    );
    expect(blockingReason({ content: c, accounts, selected: [], preflight: null })).toBe(
      "En az bir hesap seçin.",
    );
    expect(blockingReason({ content: c, accounts, selected: ["a1"], preflight: null })).toBeNull();
    const failing = preflight({
      ok: false,
      targets: [
        {
          socialAccountId: "a1",
          platform: "instagram",
          handle: "@mtmagro",
          kind: "instagram.image",
          ok: false,
          errors: [{ code: "x", path: "caption", message: "Açıklama çok uzun." }],
          warnings: [],
        },
      ],
    });
    expect(blockingReason({ content: c, accounts, selected: ["a1"], preflight: failing })).toBe(
      "@mtmagro: Açıklama çok uzun.",
    );
    const draft = contentFor(version("p1", 1));
    expect(needsApproval(draft)).toBe(true);
    expect(
      blockingReason({
        content: draft,
        accounts,
        selected: ["a1"],
        preflight: null,
        approvable: false,
      }),
    ).toMatch(/doğrulanamadı/);
    // A reel too long for Facebook Reels.
    expect(
      blockingReason({
        content: { ...c, type: "reel" },
        accounts: [account({ platform: "facebook" })],
        selected: ["a1"],
        preflight: null,
        reelDurationMs: 120_000,
      }),
    ).toMatch(/Facebook Reels en fazla/);
    expect(publishNowConfirmation("Post", [account()])).toBe(
      "“Post” şu hesaplarda hemen paylaşılacak: Instagram · @mtmagro. Paylaşılan gönderi Studio'dan geri alınamaz.",
    );
  });

  it("describes a schedule's state by publishing mode", () => {
    expect(scheduleDisplay(schedule(), "local").detail).toMatch(/Mac açık olmalı/);
    expect(scheduleDisplay(schedule(), "cloud").label).toBe("Buluta gönderiliyor");
    expect(
      scheduleDisplay(schedule({ delivery: "cloud", cloudSyncedAt: NOW.toISOString() }), "cloud")
        .label,
    ).toBe("Bulutta");
    expect(scheduleDisplay(schedule({ status: "failed", lastError: "Token" }), "local")).toEqual({
      label: "Hata",
      detail: "Token",
      tone: "danger",
    });
  });
});

function fakeScheduleApi(c: Content, pending: Schedule[] = []) {
  const calls: string[] = [];
  const api = {
    contents: {
      get: vi.fn(async () => ({ ...c, status: "scheduled" as const })),
      approve: vi.fn(async (_id: string, hash: string) => {
        calls.push(`approve:${hash.slice(0, 4)}`);
        return { ...c, status: "approved" as const };
      }),
    },
    schedules: {
      list: vi.fn(async () => ({ items: pending, nextCursor: null })),
      create: vi.fn(async (input: { socialAccountId: string; scheduledAt: string }) => {
        calls.push(`create:${input.socialAccountId}`);
        return schedule({
          id: `new-${input.socialAccountId}`,
          socialAccountId: input.socialAccountId,
          scheduledAt: input.scheduledAt,
        });
      }),
      update: vi.fn(async (id: string, input: { scheduledAt: string }) => {
        calls.push(`move:${id}`);
        return schedule({ id, scheduledAt: input.scheduledAt });
      }),
      publishNow: vi.fn(async () => ({ schedules: [], jobs: [] })),
      preflight: vi.fn(async () => preflight()),
    },
    publishing: { requestSync: vi.fn(async () => ({})) },
  };
  return { api, calls };
}

describe("submitting a schedule", () => {
  const at = new Date("2026-11-20T07:00:00.000Z");

  it("approves with the verified hash first, then one schedule per account", async () => {
    const draft = contentFor(version("p1", 1));
    const { api, calls } = fakeScheduleApi(draft);
    const result = await submitSchedule(api as unknown as ScheduleApi, {
      content: draft,
      hash: "abcd".padEnd(64, "0"),
      accountIds: ["a2", "a1"],
      date: at,
    });
    expect(calls).toEqual(["approve:abcd", "create:a1", "create:a2"]);
    expect(api.schedules.create).toHaveBeenCalledWith({
      contentId: "p1",
      socialAccountId: "a1",
      scheduledAt: "2026-11-20T07:00:00.000Z",
    });
    expect(result.content.status).toBe("scheduled");
  });

  it("moves a pending schedule instead of doubling it", async () => {
    const approved = contentFor(version("p1", 1), { status: "scheduled" });
    const { api, calls } = fakeScheduleApi(approved, [
      schedule({ id: "s9", socialAccountId: "a1" }),
    ]);
    await submitSchedule(api as unknown as ScheduleApi, {
      content: approved,
      hash: null,
      accountIds: ["a1", "a2"],
      date: at,
    });
    expect(calls).toEqual(["move:s9", "create:a2"]);
  });

  it("refuses to approve without a verified hash and keeps what went through", async () => {
    const draft = contentFor(version("p1", 1));
    const { api } = fakeScheduleApi(draft);
    await expect(
      submitSchedule(api as unknown as ScheduleApi, {
        content: draft,
        hash: null,
        accountIds: ["a1"],
        date: at,
      }),
    ).rejects.toThrow(/onaylanması gerekiyor/);
    expect(api.contents.approve).not.toHaveBeenCalled();

    const approved = { ...draft, status: "approved" as const };
    const failing = fakeScheduleApi(approved);
    failing.api.schedules.create
      .mockImplementationOnce(async () => schedule({ id: "ok" }))
      .mockImplementationOnce(async () => {
        throw new Error("rate limited");
      });
    const error = await submitSchedule(failing.api as unknown as ScheduleApi, {
      content: approved,
      hash: null,
      accountIds: ["a1", "a2"],
      date: at,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(SubmitError);
    expect((error as SubmitError).created.map((s) => s.id)).toEqual(["ok"]);
  });
});

function wrap(ui: ReactNode, api: unknown) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ApiContext.Provider value={api as ApiClient}>{ui}</ApiContext.Provider>
    </QueryClientProvider>,
  );
}

describe("schedule sheet", () => {
  it("checks the platform rules for the picked accounts and schedules", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const c = contentFor(version("p1", 1), {
        status: "approved",
        targetPlatforms: ["instagram"],
      });
      const { api } = fakeScheduleApi(c);
      api.schedules.preflight.mockResolvedValue(
        preflight({
          targets: [
            {
              socialAccountId: "a1",
              platform: "instagram",
              handle: "@mtmagro",
              kind: "instagram.image",
              ok: true,
              errors: [],
              warnings: [{ code: "w", path: "caption", message: "Etiket sayısı yüksek." }],
            },
          ],
        }),
      );
      const onDone = vi.fn();
      const onClose = vi.fn();
      wrap(
        <ScheduleSheet
          open
          content={c}
          slideHtml={null}
          hash={null}
          accounts={[account(), account({ id: "a2", handle: "@yan", status: "needs_reauth" })]}
          initialDate={new Date(Date.now() + 2 * 86_400_000)}
          onClose={onClose}
          onDone={onDone}
        />,
        api,
      );
      expect(screen.getByRole("dialog", { name: "Postu zamanla" })).toBeInTheDocument();
      // Only the connected account starts checked; the other says why.
      expect(screen.getByRole("checkbox", { name: "Instagram · @mtmagro" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Instagram · @yan" })).not.toBeChecked();
      expect(screen.getByText(/Yeniden bağlanması gerekiyor/)).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      await waitFor(() => expect(screen.getByText("! Etiket sayısı yüksek.")).toBeInTheDocument());
      expect(api.schedules.preflight).toHaveBeenCalledWith(
        expect.objectContaining({ contentId: "p1", socialAccountIds: ["a1"] }),
      );
      expect(screen.getByText(/Yayını bu Mac yapar/)).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Zamanla" }));
      await waitFor(() => expect(onDone).toHaveBeenCalled());
      expect(api.schedules.create).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disables scheduling while nothing is picked or the time has passed", async () => {
    const c = contentFor(version("p1", 1), { status: "approved" });
    const { api } = fakeScheduleApi(c);
    wrap(
      <ScheduleSheet
        open
        content={c}
        slideHtml={null}
        hash={null}
        accounts={[account()]}
        initialDate={new Date(Date.now() - 86_400_000)}
        onClose={() => undefined}
        onDone={() => undefined}
      />,
      api,
    );
    expect(screen.getByText("Yayın zamanı en az bir dakika sonrası olmalı.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Zamanla" })).toBeDisabled();
    await userEvent.click(screen.getByRole("checkbox", { name: "Instagram · @mtmagro" }));
    expect(screen.getByText("En az bir hesap seçin.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Şimdi yayınla" })).toBeDisabled();
  });

  it("names approval in the button when the post is not approved yet", () => {
    const c = contentFor(version("p1", 1, undefined, { contentHash: HASH0 }));
    const { api } = fakeScheduleApi(c);
    wrap(
      <ScheduleSheet
        open
        content={c}
        slideHtml={null}
        hash={HASH0}
        accounts={[account()]}
        initialDate={new Date(Date.now() + 86_400_000)}
        onClose={() => undefined}
        onDone={() => undefined}
      />,
      api,
    );
    expect(screen.getByRole("button", { name: "Onayla ve zamanla" })).toBeInTheDocument();
    expect(screen.getByText(/Önce bu sürüm onaylanacak/)).toBeInTheDocument();
  });
});
