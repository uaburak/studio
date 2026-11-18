// Server data of the statistics views (N15): the brand's performance page, a post's numbers, and
// "Şimdi güncelle" (queues `insights.sync`). Finished statistics reads refresh them.
import type { Job, Platform } from "@studio/contract";
import { type QueryKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { isHostUp, useHost, useJobList } from "../../state/studio.tsx";
import { jobSignature } from "../job-refresh.ts";

export const performanceKeys = {
  all: ["performance"] as const,
  brand: (brandId: string | null, days: number, platform: Platform | null) =>
    ["performance", "brand", brandId, days, platform] as const,
  content: (contentId: string | null) => ["performance", "content", contentId] as const,
};

/**
 * Refetch `keys` when jobs of `types` start or finish (any brand: the Hub's own syncs have none).
 * Works outside the app's providers too (no live feed: nothing happens).
 */
export function useRefreshOnJobList(types: readonly string[], keys: readonly QueryKey[]): void {
  const jobs = useJobList();
  const queryClient = useQueryClient();
  const signature = jobSignature(jobs, types, null);
  const last = useRef(signature);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  useEffect(() => {
    if (last.current === signature) return;
    last.current = signature;
    for (const queryKey of keysRef.current) void queryClient.invalidateQueries({ queryKey });
  }, [signature, queryClient]);
}

export function useBrandPerformance(
  brandId: string | null,
  days: number,
  platform: Platform | null,
) {
  const api = useApi();
  const up = isHostUp(useHost());
  useRefreshOnJobList(["insights.sync"], [performanceKeys.all]);
  return useQuery({
    queryKey: performanceKeys.brand(brandId, days, platform),
    queryFn: () =>
      api.insights.brand(brandId as string, { days, ...(platform ? { platform } : {}) }),
    enabled: up && brandId !== null,
    staleTime: 60_000,
  });
}

export function useContentPerformance(contentId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  useRefreshOnJobList(["insights.sync"], [performanceKeys.content(contentId)]);
  return useQuery({
    queryKey: performanceKeys.content(contentId),
    queryFn: () => api.contents.performance(contentId as string),
    enabled: up && contentId !== null,
    staleTime: 60_000,
  });
}

/**
 * "Şimdi güncelle": queue a statistics read (a brand or a post) and refetch when it ends.
 * `busy` while the job waits or runs.
 */
export function useInsightsSync(target: { brandId?: string; contentId?: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const showToast = useAppStore((s) => s.showToast);
  const jobs = useJobList();
  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const job: Job | undefined = jobId ? jobs.find((j) => j.id === jobId) : undefined;
  const running = job ? job.status === "queued" || job.status === "running" : false;
  useEffect(() => {
    if (!job || running) return;
    void queryClient.invalidateQueries({ queryKey: performanceKeys.all });
    if (job.status === "failed")
      showToast({ message: job.error ?? "İstatistikler okunamadı.", tone: "danger" });
    setJobId(null);
  }, [job, running, queryClient, showToast]);
  const start = useCallback(async () => {
    setStarting(true);
    try {
      const created = await api.insights.sync(target);
      setJobId(created.id);
      showToast({ message: "İstatistikler okunuyor; Mac'teki worker bitirince güncellenir." });
    } catch (error) {
      showToast({ message: describeError(error), tone: "danger" });
    } finally {
      setStarting(false);
    }
  }, [api, target, showToast]);
  return { start, busy: starting || running };
}
