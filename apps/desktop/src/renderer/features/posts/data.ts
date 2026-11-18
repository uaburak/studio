// Server data of the posts screens (react-query): contents of a brand (or all), their current
// versions, schedules, plans; one post, its versions, schedules and publish logs; the
// publishing mode. Finished generation / render jobs refresh what they touched.
import {
  type ApiClient,
  type Content,
  type ContentVersion,
  isTerminalJobStatus,
  type Job,
  type Plan,
  type PublishingStatus,
  type Schedule,
} from "@studio/contract";
import { type QueryClient, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { useApi } from "../../lib/api.ts";
import { isHostUp, useHost, useJobs, useJobsSnapshot } from "../../state/studio.tsx";
import { buildBoard, type PostCard } from "./board.ts";

export const postKeys = {
  all: ["posts"] as const,
  contents: (scope: string) => ["posts", "contents", scope] as const,
  content: (id: string) => ["posts", "content", id] as const,
  version: (id: string, version: number) => ["posts", "version", id, version] as const,
  versions: (id: string) => ["posts", "versions", id] as const,
  schedules: (scope: string) => ["posts", "schedules", scope] as const,
  contentSchedules: (id: string) => ["posts", "content-schedules", id] as const,
  plans: (scope: string) => ["posts", "plans", scope] as const,
  logs: (scheduleId: string) => ["posts", "logs", scheduleId] as const,
  publishing: ["posts", "publishing-status"] as const,
};

/** Every page of a cursor list (bounded). */
export async function allPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  maxPages = 10,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const list = await fetchPage(cursor);
    items.push(...list.items);
    if (!list.nextCursor) break;
    cursor = list.nextCursor;
  }
  return items;
}

const scopeKey = (brandId: string | null) => brandId ?? "all";
const brandQuery = (brandId: string | null) => (brandId ? { brandId } : {});

function useUp(): boolean {
  return isHostUp(useHost());
}

export function useContents(brandId: string | null, enabled = true) {
  const api = useApi();
  const up = useUp();
  return useQuery({
    queryKey: postKeys.contents(scopeKey(brandId)),
    queryFn: (): Promise<Content[]> =>
      allPages((cursor) =>
        api.contents.list({ ...brandQuery(brandId), limit: 100, ...(cursor ? { cursor } : {}) }),
      ),
    enabled: up && enabled,
    staleTime: 15_000,
  });
}

export function useSchedules(brandId: string | null, enabled = true) {
  const api = useApi();
  const up = useUp();
  return useQuery({
    queryKey: postKeys.schedules(scopeKey(brandId)),
    queryFn: (): Promise<Schedule[]> =>
      allPages((cursor) =>
        api.schedules.list({ ...brandQuery(brandId), limit: 100, ...(cursor ? { cursor } : {}) }),
      ),
    enabled: up && enabled,
    staleTime: 15_000,
  });
}

export function usePlans(brandId: string | null, enabled = true) {
  const api = useApi();
  const up = useUp();
  return useQuery({
    queryKey: postKeys.plans(scopeKey(brandId)),
    queryFn: (): Promise<Plan[]> =>
      allPages(
        (cursor) =>
          api.plans.list({ ...brandQuery(brandId), limit: 100, ...(cursor ? { cursor } : {}) }),
        3,
      ),
    enabled: up && enabled,
    staleTime: 30_000,
  });
}

/** A version is immutable except for renders: refetch while a slide still waits for one. */
function versionQuery(api: ApiClient, contentId: string, version: number) {
  return {
    queryKey: postKeys.version(contentId, version),
    queryFn: () => api.contents.versions.get(contentId, version),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (query: { state: { data: ContentVersion | undefined } }) =>
      query.state.data?.slides.some((s) => !s.renderedAssetId) ? 8_000 : false,
  };
}

/** The current version of each content (one request each, cached by version). */
export function useCurrentVersions(contents: readonly Content[]): Map<string, ContentVersion> {
  const api = useApi();
  const up = useUp();
  const refs = contents.flatMap((c) =>
    c.currentVersion ? [{ id: c.id, version: c.currentVersion.version }] : [],
  );
  const results = useQueries({
    queries: refs.map((r) => ({ ...versionQuery(api, r.id, r.version), enabled: up })),
  });
  const data = results.map((r) => r.data);
  // A new map only when a loaded version (or one of its renders) changed.
  const key = data
    .map((v) => (v ? `${v.id}:${v.slides.map((s) => s.renderedAssetId ?? "").join(",")}` : "-"))
    .join("|");
  const latest = useRef(data);
  latest.current = data;
  return useMemo(() => {
    const map = new Map<string, ContentVersion>();
    for (const v of latest.current) if (v) map.set(v.contentId, v);
    return map;
    // `key` stands for the loaded versions.
  }, [key]);
}

export interface BoardData {
  cards: PostCard[];
  isLoading: boolean;
  error: unknown;
  refetch(): void;
}

/** The board of one brand (null: every brand). */
export function useBoard(brandId: string | null, enabled = true): BoardData {
  const contents = useContents(brandId, enabled);
  const schedules = useSchedules(brandId, enabled);
  const plans = usePlans(brandId, enabled);
  const { jobs } = useJobs();
  const versions = useCurrentVersions(contents.data ?? []);
  const cards = useMemo(
    () =>
      buildBoard({
        contents: contents.data ?? [],
        versions,
        plans: plans.data ?? [],
        schedules: schedules.data ?? [],
        jobs,
      }),
    [contents.data, versions, plans.data, schedules.data, jobs],
  );
  return {
    cards,
    isLoading: contents.isLoading,
    error: contents.error,
    refetch: () => {
      void contents.refetch();
      void schedules.refetch();
      void plans.refetch();
    },
  };
}

// --- one post ---------------------------------------------------------------------------------

export function useContent(id: string | null) {
  const api = useApi();
  const up = useUp();
  return useQuery({
    queryKey: postKeys.content(id ?? ""),
    queryFn: () => api.contents.get(id as string),
    enabled: up && !!id,
    staleTime: 10_000,
  });
}

export function useVersion(contentId: string | null, version: number | null | undefined) {
  const api = useApi();
  const up = useUp();
  return useQuery({
    ...versionQuery(api, contentId ?? "", version ?? 0),
    enabled: up && !!contentId && !!version,
  });
}

export function useContentSchedules(contentId: string | null) {
  const api = useApi();
  const up = useUp();
  return useQuery({
    queryKey: postKeys.contentSchedules(contentId ?? ""),
    queryFn: async (): Promise<Schedule[]> =>
      (await api.schedules.list({ contentId: contentId as string, limit: 100 })).items,
    enabled: up && !!contentId,
    staleTime: 10_000,
  });
}

export function usePublishLogs(scheduleId: string | null) {
  const api = useApi();
  const up = useUp();
  return useQuery({
    queryKey: postKeys.logs(scheduleId ?? ""),
    queryFn: async () => (await api.schedules.logs(scheduleId as string, { limit: 20 })).items,
    enabled: up && !!scheduleId,
    staleTime: 15_000,
  });
}

export function usePublishingStatus() {
  const api = useApi();
  const up = useUp();
  return useQuery({
    queryKey: postKeys.publishing,
    queryFn: (): Promise<PublishingStatus> => api.publishing.status(),
    enabled: up,
    staleTime: 60_000,
  });
}

// --- cache updates ----------------------------------------------------------------------------

/** Put a changed content into every cached list and its own query. */
export function storeContent(queryClient: QueryClient, content: Content): void {
  queryClient.setQueryData(postKeys.content(content.id), content);
  queryClient.setQueriesData<Content[]>({ queryKey: ["posts", "contents"] }, (list) =>
    list?.map((c) => (c.id === content.id ? content : c)),
  );
}

export function storeVersion(queryClient: QueryClient, version: ContentVersion): void {
  queryClient.setQueryData(postKeys.version(version.contentId, version.version), version);
}

/** Refresh the lists after something changed (create, delete, schedule). */
export function invalidatePosts(queryClient: QueryClient, contentId?: string): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["posts", "contents"] }),
    queryClient.invalidateQueries({ queryKey: ["posts", "schedules"] }),
    contentId
      ? queryClient.invalidateQueries({ queryKey: postKeys.content(contentId) })
      : Promise.resolve(),
    contentId
      ? queryClient.invalidateQueries({ queryKey: postKeys.contentSchedules(contentId) })
      : Promise.resolve(),
  ]).then(() => undefined);
}

const CONTENT_JOBS = new Set<Job["type"]>([
  "content.generate",
  "content.render",
  "schedule.publish",
  // "Düzelt" stores a fixed version / a shorter caption (roadmap 13).
  "content.check",
]);

/**
 * When a generation, render or publish job finishes (chat, the Mac, another device), the
 * posts it touched are refetched. Returns the ids that just finished (for the open editor).
 */
export function useFinishedContentJobs(onFinished?: (contentId: string, job: Job) => void): void {
  const queryClient = useQueryClient();
  const { jobs } = useJobsSnapshot();
  const seen = useRef(new Map<string, Job["status"]>());
  const callback = useRef(onFinished);
  callback.current = onFinished;
  useEffect(() => {
    const first = seen.current.size === 0;
    for (const job of jobs) {
      const previous = seen.current.get(job.id);
      seen.current.set(job.id, job.status);
      if (first || !CONTENT_JOBS.has(job.type) || !job.contentId) continue;
      if (previous === job.status || !isTerminalJobStatus(job.status)) continue;
      void invalidatePosts(queryClient, job.contentId);
      callback.current?.(job.contentId, job);
    }
  }, [jobs, queryClient]);
}
