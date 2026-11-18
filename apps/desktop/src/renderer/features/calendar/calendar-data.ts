// Server data of the calendar (react-query): a brand's schedules, posts and plans, the
// publishing mode, and moving a pending schedule (optimistic, rolled back on error). The posts
// screens keep their own copies (`["posts", …]`); a move refreshes both.
import type { Content, Plan, PublishingMode, Schedule } from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { describeError, useApi } from "../../lib/api.ts";
import { fetchAllPages } from "../../lib/paging.ts";
import { useAppStore } from "../../state/app-store.ts";
import { isHostUp, useAccounts, useBrands, useHost } from "../../state/studio.tsx";
import { useRefreshOnJobs } from "../job-refresh.ts";
import { invalidatePosts } from "../posts/data.ts";
import {
  buildEntries,
  type CalendarEntry,
  checkMove,
  type DayKey,
  withMovedSchedule,
} from "./calendar-model.ts";

export const calendarKeys = {
  all: ["calendar"] as const,
  schedules: (brandId: string | null) => ["calendar", "schedules", brandId] as const,
  contents: (brandId: string | null) => ["calendar", "contents", brandId] as const,
  plans: (brandId: string | null) => ["calendar", "plans", brandId] as const,
  publishing: ["calendar", "publishing-status"] as const,
};

export function useCalendarData(brandId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  const enabled = up && brandId !== null;
  const schedules = useQuery({
    queryKey: calendarKeys.schedules(brandId),
    queryFn: (): Promise<Schedule[]> =>
      fetchAllPages((cursor) =>
        api.schedules.list({
          brandId: brandId as string,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      ),
    enabled,
    refetchInterval: 30_000,
  });
  const contents = useQuery({
    queryKey: calendarKeys.contents(brandId),
    queryFn: (): Promise<Content[]> =>
      fetchAllPages((cursor) =>
        api.contents.list({
          brandId: brandId as string,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        }),
      ),
    enabled,
    refetchInterval: 60_000,
  });
  const plans = useQuery({
    queryKey: calendarKeys.plans(brandId),
    queryFn: (): Promise<Plan[]> =>
      fetchAllPages(
        (cursor) =>
          api.plans.list({ brandId: brandId as string, limit: 100, ...(cursor ? { cursor } : {}) }),
        3,
      ),
    enabled,
    staleTime: 30_000,
  });
  const publishing = useQuery({
    queryKey: calendarKeys.publishing,
    queryFn: async (): Promise<PublishingMode> => (await api.publishing.status()).mode,
    enabled: up,
    staleTime: 60_000,
  });
  const accounts = useAccounts();
  const brands = useBrands();
  const brandName = brands.data?.find((b) => b.id === brandId)?.name ?? null;

  // A publish, a generation or a render changes what the calendar shows.
  useRefreshOnJobs(["schedule.publish", "content.generate", "content.render"], brandId, [
    calendarKeys.schedules(brandId),
    calendarKeys.contents(brandId),
    calendarKeys.plans(brandId),
  ]);

  const entries = useMemo<CalendarEntry[]>(
    () =>
      buildEntries({
        schedules: schedules.data ?? [],
        contents: contents.data ?? [],
        plans: plans.data ?? [],
        accounts: (accounts.data ?? []).filter((a) => a.brandId === brandId),
        brandName,
        mode: publishing.data ?? "local",
      }),
    [schedules.data, contents.data, plans.data, accounts.data, brandId, brandName, publishing.data],
  );

  return {
    entries,
    loaded: schedules.isSuccess && contents.isSuccess,
    loading: enabled && (schedules.isLoading || contents.isLoading),
    error: schedules.error ?? contents.error ?? null,
    refetch: () => {
      void schedules.refetch();
      void contents.refetch();
      void plans.refetch();
    },
  };
}

/** Move a pending schedule to `day` (same time, or `hour` in the week view). */
export function useReschedule(brandId: string | null) {
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  return useCallback(
    async (entry: CalendarEntry, day: DayKey, hour?: number): Promise<boolean> => {
      const check = checkMove(entry, day, Date.now(), hour);
      if (check.kind === "same") return true;
      if (check.kind === "refused") {
        showToast({ message: check.reason, tone: "danger" });
        return false;
      }
      const key = calendarKeys.schedules(brandId);
      const before = queryClient.getQueryData<Schedule[]>(key);
      const id = entry.scheduleId as string;
      if (before) queryClient.setQueryData(key, withMovedSchedule(before, id, check.target));
      try {
        const moved = await api.schedules.update(id, {
          scheduledAt: new Date(check.target).toISOString(),
        });
        queryClient.setQueryData<Schedule[]>(key, (list) =>
          list?.map((s) => (s.id === moved.id ? moved : s)),
        );
        // The calendar's contents and the posts screens (board, open post) show the new time too.
        void invalidatePosts(queryClient, entry.contentId);
        return true;
      } catch (error) {
        if (before) queryClient.setQueryData(key, before);
        showToast({ message: describeError(error), tone: "danger" });
        return false;
      }
    },
    [api, brandId, queryClient, showToast],
  );
}
