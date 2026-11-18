// The posts screens and the calendar keep separate react-query copies of schedules and
// contents; every schedule change (cancel, move, schedule, approve) refreshes both.
import type { ApiClient, Content } from "@studio/contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { calendarKeys } from "../../src/renderer/features/calendar/calendar-data.ts";
import type { CalendarEntry } from "../../src/renderer/features/calendar/calendar-model.ts";
import {
  CancelEntryButton,
  useCancelEntry,
} from "../../src/renderer/features/calendar/calendar-views.tsx";
import { invalidatePosts, postKeys, storeContent } from "../../src/renderer/features/posts/data.ts";
import { ApiContext } from "../../src/renderer/lib/api.ts";
import { useAppStore } from "../../src/renderer/state/app-store.ts";
import { content, schedule } from "./post-fixtures.ts";

afterEach(() => {
  useAppStore.setState({ toasts: [] });
});

function seeded() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const c = content({ id: "p1", status: "scheduled" });
  queryClient.setQueryData(postKeys.contents("b1"), [c]);
  queryClient.setQueryData(postKeys.schedules("b1"), [schedule()]);
  queryClient.setQueryData(calendarKeys.contents("b1"), [c]);
  queryClient.setQueryData(calendarKeys.schedules("b1"), [schedule()]);
  return { queryClient, c };
}

const invalidated = (queryClient: QueryClient, key: readonly unknown[]) =>
  queryClient.getQueryState(key)?.isInvalidated;

describe("posts and calendar caches", () => {
  it("refreshes the calendar's lists with the posts'", async () => {
    const { queryClient } = seeded();
    await invalidatePosts(queryClient, "p1");
    expect(invalidated(queryClient, postKeys.contents("b1"))).toBe(true);
    expect(invalidated(queryClient, postKeys.schedules("b1"))).toBe(true);
    expect(invalidated(queryClient, calendarKeys.contents("b1"))).toBe(true);
    expect(invalidated(queryClient, calendarKeys.schedules("b1"))).toBe(true);
  });

  it("puts a changed post into the calendar's list too", () => {
    const { queryClient, c } = seeded();
    storeContent(queryClient, { ...c, status: "approved" });
    expect(queryClient.getQueryData<Content[]>(calendarKeys.contents("b1"))?.[0]?.status).toBe(
      "approved",
    );
    expect(queryClient.getQueryData<Content[]>(postKeys.contents("b1"))?.[0]?.status).toBe(
      "approved",
    );
  });
});

function entry(over: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    id: "sch-s1",
    day: "2026-11-20",
    at: 0,
    time: "10:00",
    title: "Hasat sonrası",
    platform: "instagram",
    contentType: "post",
    meta: "",
    handle: "@mtmagro",
    status: "Zamanlandı",
    tone: "accent",
    kind: "scheduled",
    detail: null,
    contentId: "p1",
    scheduleId: "s1",
    scheduledAt: 0,
    canMove: true,
    canCancel: true,
    needsOwner: false,
    ...over,
  };
}

function Row({ e }: { e: CalendarEntry }) {
  const cancel = useCancelEntry();
  return (
    <>
      <CancelEntryButton entry={e} onCancel={cancel.ask} />
      {cancel.dialog}
    </>
  );
}

describe("calendar: cancel a pending schedule", () => {
  it("confirms, cancels and refreshes both caches", async () => {
    const { queryClient, c } = seeded();
    const api = {
      schedules: { cancel: vi.fn(async (id: string) => schedule({ id, status: "cancelled" })) },
      contents: { get: vi.fn(async () => ({ ...c, status: "approved" as const })) },
    };
    render(
      <QueryClientProvider client={queryClient}>
        <ApiContext.Provider value={api as unknown as ApiClient}>
          <Row e={entry()} />
        </ApiContext.Provider>
      </QueryClientProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Zamanlamayı iptal et" }));
    const dialog = await screen.findByRole("dialog", { name: "Zamanlama iptal edilsin mi?" });
    expect(dialog).toHaveTextContent("Instagram · @mtmagro · 20 Kas 10:00");
    await userEvent.click(within(dialog).getByRole("button", { name: "Zamanlamayı iptal et" }));
    await waitFor(() => expect(api.schedules.cancel).toHaveBeenCalledWith("s1"));
    await waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)?.message).toBe("Zamanlama iptal edildi."),
    );
    expect(invalidated(queryClient, calendarKeys.schedules("b1"))).toBe(true);
    expect(invalidated(queryClient, postKeys.schedules("b1"))).toBe(true);
    expect(queryClient.getQueryData<Content[]>(calendarKeys.contents("b1"))?.[0]?.status).toBe(
      "approved",
    );
  });

  it("shows no cancel control on a schedule that is not pending", () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <ApiContext.Provider value={{} as ApiClient}>
          <Row e={entry({ canCancel: false, status: "Yayınlandı" })} />
        </ApiContext.Provider>
      </QueryClientProvider>,
    );
    expect(screen.queryByRole("button", { name: "Zamanlamayı iptal et" })).toBeNull();
  });
});
