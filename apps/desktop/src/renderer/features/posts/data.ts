// Server data of the posts screens (react-query): contents of a brand (or all), their current
// versions, schedules, plans; one post, its versions, schedules and publish logs; the
// publishing mode; the trash. Finished generation / render jobs refresh what they touched.
//
// A4: the post list itself is small (metadata only); the expensive part — one version request per
// post, with its rendered pictures — is loaded only for the month on screen (the months next to it
// are prefetched), a version still waiting for its renders is polled with a growing pause and not
// at all once its render failed, and the cards keep their identity across job events so only the
// card that changed draws again.
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
import { boardMonths, buildBoard, cardMonth, nearestMonth, type PostCard } from "./board.ts";
import { addMonths, type MonthKey, monthKeyOf } from "./dates.ts";

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
  trash: (scope: string) => ["posts", "trash", scope] as const,
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

/** First pause before asking again for a version whose renders are missing. */
export const RENDER_POLL_FIRST_MS = 8_000;
const RENDER_POLL_MAX_MS = 120_000;
/** After this many polls (≈ 15 min) a version without renders is left alone until a job ends. */
const RENDER_POLL_LIMIT = 10;

/**
 * Pause before the next poll of a version that still waits for renders: 8 s, doubling up to
 * 2 min, none after RENDER_POLL_LIMIT polls or when its render failed (a finished job refreshes
 * it anyway, see useFinishedContentJobs). False: no polling.
 */
export function renderPollInterval(
  version: Pick<ContentVersion, "slides"> | undefined,
  polls: number,
  renderFailed = false,
): number | false {
  if (!version || renderFailed) return false;
  if (!version.slides.some((s) => !s.renderedAssetId)) return false;
  if (polls >= RENDER_POLL_LIMIT) return false;
  return Math.min(RENDER_POLL_FIRST_MS * 2 ** Math.max(0, polls - 1), RENDER_POLL_MAX_MS);
}

/** A version is immutable except for renders: refetch (with backoff) while a slide waits for one. */
function versionQuery(
  api: ApiClient,
  contentId: string,
  version: number,
  renderFailed?: (contentId: string) => boolean,
) {
  return {
    queryKey: postKeys.version(contentId, version),
    queryFn: () => api.contents.versions.get(contentId, version),
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: (query: {
      state: { data: ContentVersion | undefined; dataUpdateCount: number };
    }) =>
      renderPollInterval(
        query.state.data,
        query.state.dataUpdateCount,
        renderFailed?.(contentId) ?? false,
      ),
  };
}

/** Contents whose latest render or generation job failed (their versions are not polled). */
function useFailedRenders(): (contentId: string) => boolean {
  const { jobs } = useJobsSnapshot();
  const failed = useMemo(() => {
    const latest = new Map<string, Job>();
    for (const job of jobs) {
      if (job.type !== "content.render" && job.type !== "content.generate") continue;
      if (!job.contentId) continue;
      const seen = latest.get(job.contentId);
      if (!seen || Date.parse(seen.createdAt) < Date.parse(job.createdAt))
        latest.set(job.contentId, job);
    }
    return new Set(
      [...latest.values()].filter((j) => j.status === "failed").map((j) => j.contentId as string),
    );
  }, [jobs]);
  const ref = useRef(failed);
  ref.current = failed;
  return useMemo(() => (id: string) => ref.current.has(id), []);
}

/** The current version of each content (one request each, cached by version). */
export function useCurrentVersions(contents: readonly Content[]): Map<string, ContentVersion> {
  const api = useApi();
  const up = useUp();
  const renderFailed = useFailedRenders();
  const refs = contents.flatMap((c) =>
    c.currentVersion ? [{ id: c.id, version: c.currentVersion.version }] : [],
  );
  const results = useQueries({
    queries: refs.map((r) => ({
      ...versionQuery(api, r.id, r.version, renderFailed),
      enabled: up,
    })),
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
  /** Every card; only the month on screen carries its loaded version. */
  cards: PostCard[];
  isLoading: boolean;
  error: unknown;
  refetch(): void;
}

/** "id:status" of the jobs the board shows (progress reports do not change it). */
export function boardJobSignature(jobs: readonly Job[]): string {
  let out = "";
  for (const j of jobs) {
    if ((j.type === "content.generate" || j.type === "content.render") && j.contentId)
      out += `${j.id}:${j.status}|`;
  }
  return out;
}

/** The board's jobs, the same array while none of them changed status. */
function useBoardJobs(): Job[] {
  const { jobs } = useJobs();
  const signature = boardJobSignature(jobs);
  const latest = useRef(jobs);
  latest.current = jobs;
  return useMemo(
    () =>
      latest.current.filter(
        (j) => (j.type === "content.generate" || j.type === "content.render") && j.contentId,
      ),
    // `signature` stands for the jobs that matter.
    [signature],
  );
}

/**
 * Cards of `next` that equal the previous build (same content, version, plan item, schedule and
 * job objects) keep the previous card object, so a memoized card does not draw again.
 */
export function reuseCards(previous: readonly PostCard[], next: PostCard[]): PostCard[] {
  if (previous.length === 0) return next;
  const old = new Map(previous.map((c) => [c.id, c]));
  let same = previous.length === next.length;
  const out = next.map((card, index) => {
    const before = old.get(card.id);
    const keep =
      before &&
      before.content === card.content &&
      before.version === card.version &&
      before.planItem === card.planItem &&
      before.schedule === card.schedule &&
      before.job === card.job;
    if (!keep || previous[index] !== before) same = false;
    return keep ? before : card;
  });
  return same ? (previous as PostCard[]) : out;
}

/** The months whose versions are loaded: the shown one first, then the ones beside it. */
export function versionMonths(month: MonthKey): MonthKey[] {
  return [month, addMonths(month, -1), addMonths(month, 1)];
}

/**
 * The board of one brand (null: every brand). `month`: the month on screen (null: the one with
 * the nearest posts, as the board picks it) — only its posts' versions are loaded, the months
 * beside it are prefetched.
 */
export function useBoard(
  brandId: string | null,
  enabled = true,
  wanted: MonthKey | null = null,
  now: Date = new Date(),
): BoardData {
  const api = useApi();
  const queryClient = useQueryClient();
  const up = useUp();
  const contents = useContents(brandId, enabled);
  const schedules = useSchedules(brandId, enabled);
  const plans = usePlans(brandId, enabled);
  const jobs = useBoardJobs();
  const base = useMemo(
    () =>
      buildBoard({
        contents: contents.data ?? [],
        plans: plans.data ?? [],
        schedules: schedules.data ?? [],
        jobs,
      }),
    [contents.data, plans.data, schedules.data, jobs],
  );
  const thisMonth = monthKeyOf(now);
  const month = useMemo(
    () => wanted ?? nearestMonth(boardMonths(base), thisMonth),
    [wanted, base, thisMonth],
  );
  const shown = useMemo(
    () => base.filter((c) => cardMonth(c) === month).map((c) => c.content),
    [base, month],
  );
  const versions = useCurrentVersions(shown);
  // The months beside the shown one load in the background (‹ › then shows them at once).
  useEffect(() => {
    if (!up) return;
    const near = new Set(versionMonths(month).slice(1));
    for (const card of base) {
      const ref = card.content.currentVersion;
      if (!ref || !near.has(cardMonth(card))) continue;
      void queryClient.prefetchQuery(versionQuery(api, card.id, ref.version));
    }
  }, [base, month, up, api, queryClient]);
  const previous = useRef<PostCard[]>([]);
  const cards = useMemo(() => {
    const next = base.map((card) => {
      const loaded = versions.get(card.id);
      return loaded && loaded.version === card.content.currentVersion?.version
        ? { ...card, version: loaded }
        : card;
    });
    const out = reuseCards(previous.current, next);
    previous.current = out;
    return out;
  }, [base, versions]);
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

/** The trash ("Silinenler") of one brand (null: every brand), newest deletion first. */
export function useTrash(brandId: string | null, enabled = true) {
  const api = useApi();
  const up = useUp();
  return useQuery({
    queryKey: postKeys.trash(scopeKey(brandId)),
    queryFn: async (): Promise<Content[]> => {
      const list = await allPages(
        (cursor) =>
          api.contents.list({
            ...brandQuery(brandId),
            deleted: "only",
            limit: 100,
            ...(cursor ? { cursor } : {}),
          }),
        5,
      );
      return list.sort((a, b) => (b.deletedAt ?? "").localeCompare(a.deletedAt ?? ""));
    },
    enabled: up && enabled,
    staleTime: 15_000,
  });
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

/**
 * The calendar keeps its own copies of schedules and contents (`["calendar", …]`, see
 * calendar-data.ts); whatever changes a post or its schedules refreshes those too.
 */
const CALENDAR_SCHEDULES = ["calendar", "schedules"] as const;
const CALENDAR_CONTENTS = ["calendar", "contents"] as const;

/** Put a changed content into every cached list (the posts' and the calendar's) and its own query. */
export function storeContent(queryClient: QueryClient, content: Content): void {
  queryClient.setQueryData(postKeys.content(content.id), content);
  for (const queryKey of [["posts", "contents"], CALENDAR_CONTENTS]) {
    queryClient.setQueriesData<Content[]>({ queryKey }, (list) =>
      list?.map((c) => (c.id === content.id ? content : c)),
    );
  }
}

export function storeVersion(queryClient: QueryClient, version: ContentVersion): void {
  queryClient.setQueryData(postKeys.version(version.contentId, version.version), version);
}

/**
 * Refresh the lists after something changed (create, delete, approve, schedule, cancel, move):
 * the posts' and the calendar's.
 */
export function invalidatePosts(queryClient: QueryClient, contentId?: string): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["posts", "contents"] }),
    queryClient.invalidateQueries({ queryKey: ["posts", "trash"] }),
    queryClient.invalidateQueries({ queryKey: ["posts", "plans"] }),
    queryClient.invalidateQueries({ queryKey: ["posts", "schedules"] }),
    queryClient.invalidateQueries({ queryKey: CALENDAR_SCHEDULES }),
    queryClient.invalidateQueries({ queryKey: CALENDAR_CONTENTS }),
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
  // The agent's edit of a canvas document (any conversation, the iPhone): a new version.
  "canvas.apply",
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
      // Renders land on an existing version (its query is never stale on its own).
      void queryClient.invalidateQueries({ queryKey: ["posts", "version", job.contentId] });
      callback.current?.(job.contentId, job);
    }
  }, [jobs, queryClient]);
}
