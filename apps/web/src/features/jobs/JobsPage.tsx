import {
  type Job,
  type JobStatus,
  JobStatus as JobStatusEnum,
  type JobType,
  JobType as JobTypeEnum,
} from "@studio/contract";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { useApi } from "../../api.ts";
import { IconJobs } from "../../components/icons.tsx";
import { BrandMark, FilterBar, PageHeader, StatusBadge } from "../../components/page.tsx";
import { EmptyState, ErrorState, Notice, SkeletonRows } from "../../components/states.tsx";
import { Badge, Button, FilterSelect, Progress } from "../../components/ui.tsx";
import { useBrandName, useBrands } from "../../lib/brand-context.tsx";
import { formatRelative } from "../../lib/datetime.ts";
import { formatPercent } from "../../lib/format.ts";
import { JOB_STATUS, JOB_TYPE_LABELS } from "../../lib/labels.ts";
import { CancelJobButton, useLiveJobs } from "../../lib/live-jobs.tsx";
import { queryKeys } from "../../lib/query-keys.ts";

export const isActiveJob = (j: Pick<Job, "status">) =>
  j.status === "queued" || j.status === "running";

/** Poll fast while something is moving, slowly otherwise (fallback when WebSocket is closed). */
export function jobsPollInterval(jobs: Pick<Job, "status">[]): number {
  return jobs.some((j) => j.status === "running") ? 2000 : jobs.some(isActiveJob) ? 5000 : 15000;
}

export function JobsPage() {
  const api = useApi();
  const { brandId } = useBrands();
  const brandName = useBrandName();
  const { streamStatus, presence, summary, jobsById } = useLiveJobs();
  const [params, setParams] = useSearchParams();
  const statusParam = params.get("durum");
  const typeParam = params.get("tur");
  const status = JobStatusEnum.safeParse(statusParam).success
    ? (statusParam as JobStatus)
    : undefined;
  const type = JobTypeEnum.safeParse(typeParam).success ? (typeParam as JobType) : undefined;

  const filters = { brandId: brandId ?? undefined, status, type };
  const query = useInfiniteQuery({
    queryKey: queryKeys.jobs.list(filters),
    queryFn: ({ pageParam, signal }) =>
      api.jobs.list(
        { ...filters, limit: 30, ...(pageParam ? { cursor: pageParam } : {}) },
        { signal },
      ),
    initialPageParam: "",
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (q) =>
      streamStatus === "open"
        ? false
        : jobsPollInterval(q.state.data?.pages.flatMap((p) => p.items) ?? []),
  });

  const fetchedItems = query.data?.pages.flatMap((p) => p.items) ?? [];
  // Merge live stream snapshots/updates seamlessly with paginated items.
  const mergedMap = new Map<string, Job>();
  for (const j of jobsById.values()) {
    if (brandId && j.brandId !== brandId) continue;
    if (status && j.status !== status) continue;
    if (type && j.type !== type) continue;
    mergedMap.set(j.id, j);
  }
  for (const j of fetchedItems) {
    if (!mergedMap.has(j.id)) mergedMap.set(j.id, j);
  }
  const items = [...mergedMap.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const queued = items.filter((j) => j.status === "queued").length;

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  return (
    <>
      <PageHeader
        title="İşler"
        description="Üretim, render, görsel ve analiz işleri. Canlı akış üzerinden anlık güncellenir."
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={streamStatus === "open" ? "good" : "neutral"}>
              {streamStatus === "open" ? "Canlı akış" : "Yoklama modu"}
            </Badge>
            {query.isFetching && !query.isPending ? (
              <span className="text-[12px] text-ink-3" aria-live="polite">
                Yenileniyor…
              </span>
            ) : null}
          </div>
        }
      />

      <FilterBar>
        <FilterSelect
          label="Durum"
          value={status ?? ""}
          onChange={(e) => setParam("durum", e.target.value)}
        >
          <option value="">Tüm durumlar</option>
          {JobStatusEnum.options.map((s) => (
            <option key={s} value={s}>
              {JOB_STATUS[s].label}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect
          label="Tür"
          value={type ?? ""}
          onChange={(e) => setParam("tur", e.target.value)}
        >
          <option value="">Tüm türler</option>
          {JobTypeEnum.options.map((t) => (
            <option key={t} value={t}>
              {JOB_TYPE_LABELS[t]}
            </option>
          ))}
        </FilterSelect>
      </FilterBar>

      {queued > 0 && (
        <div className="mb-5">
          <Notice tone={presence?.online === false ? "warn" : "info"}>
            <strong>{queued} iş sırada.</strong>{" "}
            {presence?.online === false
              ? "Mac çevrimdışı — Mac worker bağlandığında sıradaki işler otomatik başlar."
              : summary.macDetail}
          </Notice>
        </div>
      )}

      {query.isPending && jobsById.size === 0 ? (
        <SkeletonRows rows={6} />
      ) : query.error && jobsById.size === 0 ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="İş yok" glyph={<IconJobs size={24} />}>
          Bir içerikte “Üret”e bastığınızda ya da sohbet başlattığınızda işler burada görünür.
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col overflow-hidden rounded-2xl bg-surface shadow-card ring-1 ring-line/70">
            {items.map((job) => (
              <li
                key={job.id}
                className="flex flex-col gap-2 border-b border-line px-4 py-3.5 last:border-b-0 hover:bg-surface-2 sm:flex-row sm:items-center sm:gap-4 sm:px-5"
              >
                <Link to={`/isler/${job.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  {job.brandId ? (
                    <BrandMark id={job.brandId} name={brandName(job.brandId)} size={28} />
                  ) : (
                    <span
                      className="size-7 shrink-0 rounded-[30%] bg-surface-3"
                      aria-hidden="true"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-ink">
                      {JOB_TYPE_LABELS[job.type]}
                    </p>
                    <p className="truncate text-[12px] text-ink-3">
                      {job.brandId ? brandName(job.brandId) : "Markasız"} ·{" "}
                      {formatRelative(job.createdAt)}
                      {job.progressMessage ? ` · ${job.progressMessage}` : ""}
                    </p>
                  </div>
                </Link>
                <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                  {job.status === "running" && job.progress !== undefined && (
                    <div className="flex w-36 items-center gap-2">
                      <Progress value={job.progress} label="İlerleme" />
                      <span className="font-mono text-[12px] text-ink-3 tabular-nums">
                        {formatPercent(job.progress)}
                      </span>
                    </div>
                  )}
                  <StatusBadge meta={JOB_STATUS[job.status]} />
                  <CancelJobButton job={job} size="sm" />
                </div>
              </li>
            ))}
          </ul>
          {query.hasNextPage && (
            <div className="mt-6 flex justify-center">
              <Button onClick={() => void query.fetchNextPage()} loading={query.isFetchingNextPage}>
                Daha fazla yükle
              </Button>
            </div>
          )}
        </>
      )}
    </>
  );
}
