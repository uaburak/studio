// Refetch server data when background jobs of some types (for one brand) change status:
// a publish finished, an image was generated, a brand analysis ended.
import type { Job } from "@studio/contract";
import { type QueryKey, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useJobs } from "../state/studio.tsx";

/** "id:status|…" of the matching jobs (changes when one starts, moves on or ends). */
export function jobSignature(
  jobs: readonly Job[],
  types: readonly string[],
  brandId: string | null,
): string {
  return jobs
    .filter((j) => types.includes(j.type) && (brandId === null || j.brandId === brandId))
    .map((j) => `${j.id}:${j.status}`)
    .sort()
    .join("|");
}

export function useRefreshOnJobs(
  types: readonly string[],
  brandId: string | null,
  keys: readonly QueryKey[],
): void {
  const { jobs } = useJobs();
  const queryClient = useQueryClient();
  const signature = jobSignature(jobs, types, brandId);
  const last = useRef(signature);
  const keysRef = useRef(keys);
  keysRef.current = keys;
  useEffect(() => {
    if (last.current === signature) return;
    last.current = signature;
    for (const queryKey of keysRef.current) void queryClient.invalidateQueries({ queryKey });
  }, [signature, queryClient]);
}
