import type { Content } from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi } from "../../api.ts";
import { queryKeys } from "../../lib/query-keys.ts";

export function useContentVersion(
  contentId: string,
  version: number | null | undefined,
  enabled = true,
) {
  const api = useApi();
  return useQuery({
    queryKey: queryKeys.contents.version(contentId, version ?? 0),
    queryFn: ({ signal }) => api.contents.versions.get(contentId, version ?? 0, { signal }),
    enabled: enabled && Boolean(version),
    // Versions are immutable apart from note/render refs.
    staleTime: 5 * 60_000,
  });
}

/** After any mutation that returns the content: update caches and refresh lists. */
export function useContentCacheUpdate() {
  const qc = useQueryClient();
  return (content: Content) => {
    qc.setQueryData(queryKeys.contents.one(content.id), content);
    void qc.invalidateQueries({ queryKey: ["contents", "list"] });
    void qc.invalidateQueries({ queryKey: queryKeys.contents.versions(content.id) });
    void qc.invalidateQueries({ queryKey: queryKeys.schedules.all });
  };
}
