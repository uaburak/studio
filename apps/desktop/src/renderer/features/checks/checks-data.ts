// Server data of the generation checks: the latest check run of a version, the running
// `content.check` job of a post, "Kontrolleri çalıştır" / "Düzelt", and the brand's check
// settings. Runs are refreshed when a generation, an edit render or a check job ends.
import {
  type BrandCheckSettings,
  type BrandCheckSettingsPut,
  type CheckId,
  type ContentCheckRun,
  isTerminalJobStatus,
  type Job,
} from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useApi } from "../../lib/api.ts";
import { isHostUp, useHost, useJobList } from "../../state/studio.tsx";
import { jobSignature } from "../job-refresh.ts";

export const checkKeys = {
  all: ["checks"] as const,
  run: (contentId: string, version: number | null) =>
    ["checks", "run", contentId, version] as const,
  settings: (brandId: string | null) => ["checks", "settings", brandId] as const,
};

/** Jobs that store check runs. */
export const CHECK_JOB_TYPES = ["content.check", "content.generate", "content.render"] as const;

/** The latest check run of a version (`null` when it was never checked). */
export function useCheckRun(
  content: { id: string; brandId: string } | null,
  version: number | null,
) {
  const api = useApi();
  const up = isHostUp(useHost());
  const contentId = content?.id ?? "";
  // A generation, an edit render or a check job of the brand moved on: read the run again.
  const queryClient = useQueryClient();
  const signature = jobSignature(useJobList(), CHECK_JOB_TYPES, content?.brandId ?? null);
  const last = useRef(signature);
  useEffect(() => {
    if (last.current === signature) return;
    last.current = signature;
    void queryClient.invalidateQueries({ queryKey: ["checks", "run", contentId] });
  }, [signature, queryClient, contentId]);
  return useQuery({
    queryKey: checkKeys.run(contentId, version),
    queryFn: async (): Promise<ContentCheckRun | null> =>
      (await api.contents.checks.list(contentId, { version: version as number, limit: 1 }))
        .items[0] ?? null,
    enabled: up && content !== null && version !== null,
    staleTime: 15_000,
  });
}

/** This post's `content.check` jobs from the live feed: the running one and the last one. */
export function useCheckJobs(contentId: string | null): { running: Job | null; last: Job | null } {
  const mine = useJobList().filter((j) => j.type === "content.check" && j.contentId === contentId);
  return {
    running: mine.find((j) => !isTerminalJobStatus(j.status)) ?? null,
    last: mine[0] ?? null,
  };
}

export function useCheckActions(content: { id: string; brandId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const create = async (payload: Record<string, unknown>) => {
    const job = await api.jobs.create({
      type: "content.check",
      brandId: content.brandId,
      contentId: content.id,
      payload,
    });
    void queryClient.invalidateQueries({ queryKey: ["checks", "run", content.id] });
    return job;
  };
  return {
    /** "Kontrolleri çalıştır" / "Yeniden çalıştır" (with the model pass). */
    run: (version: number) => create({ version }),
    /** "Düzelt": fix these checks' findings (all fixable ones without a list). */
    fix: (version: number, checks?: readonly CheckId[]) =>
      create({ version, fix: checks && checks.length > 0 ? [...checks] : true, model: false }),
  };
}

/** The brand's check settings (defaults until saved). */
export function useCheckSettings(brandId: string | null) {
  const api = useApi();
  const up = isHostUp(useHost());
  return useQuery({
    queryKey: checkKeys.settings(brandId),
    queryFn: (): Promise<BrandCheckSettings> => api.brandCheckSettings.get(brandId as string),
    enabled: up && brandId !== null,
    staleTime: 30_000,
  });
}

export function useCheckSettingsActions(brandId: string) {
  const api = useApi();
  const queryClient = useQueryClient();
  return {
    put: async (input: BrandCheckSettingsPut) => {
      const saved = await api.brandCheckSettings.put(brandId, input);
      queryClient.setQueryData(checkKeys.settings(brandId), saved);
      return saved;
    },
  };
}
