import {
  isTerminalJobStatus,
  type Job,
  type JobList,
  type JobStreamMessage,
  type JobWatchStatus,
  type WorkerPresence,
} from "@studio/contract";
import { type InfiniteData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useApi } from "../api.ts";
import { IconStop } from "../components/icons.tsx";
import { useToast } from "../components/toast.tsx";
import { Button } from "../components/ui.tsx";
import type { Tone } from "./labels.ts";
import { queryKeys } from "./query-keys.ts";

export interface PresenceSummary {
  macLabel: "Mac hazır" | "Mac çevrimdışı" | "Mac durumu bekleniyor";
  macTone: Tone;
  macDetail: string;
  claudePercent: number | null;
  claudeLimited: boolean;
  claudeLabel: string;
  claudeTone: Tone;
  geminiReady: boolean;
  geminiLabel: string;
  geminiTone: Tone;
}

/** Pure summary of worker presence, Claude subscription usage, and Gemini readiness. */
export function describePresence(presence: WorkerPresence | null): PresenceSummary {
  if (!presence) {
    return {
      macLabel: "Mac durumu bekleniyor",
      macTone: "neutral",
      macDetail: "Worker bağlantısı kontrol ediliyor.",
      claudePercent: null,
      claudeLimited: false,
      claudeLabel: "Claude —",
      claudeTone: "neutral",
      geminiReady: false,
      geminiLabel: "Gemini —",
      geminiTone: "neutral",
    };
  }

  const runningCount = presence.currentJobs.length;
  const macLabel = presence.online ? "Mac hazır" : "Mac çevrimdışı";
  const macTone: Tone = presence.online ? "good" : "warn";
  const macDetail = presence.online
    ? runningCount > 0
      ? `${runningCount} iş çalışıyor${presence.queueLength > 0 ? ` · ${presence.queueLength} sırada` : ""}`
      : presence.queueLength > 0
        ? `${presence.queueLength} iş sırada`
        : "Üretim ve render için bağlı"
    : presence.queueLength > 0
      ? `${presence.queueLength} iş sırada bekler; Mac açılınca başlar`
      : "İşler kuyruğa alınır, Mac açılınca çalışır";

  const windows = presence.usage?.windows ?? [];
  const primaryWindow =
    windows.find((w) => w.kind === "five_hour" && w.usedPercent !== undefined) ??
    windows.find((w) => w.kind === "weekly" && w.usedPercent !== undefined) ??
    windows.find((w) => w.usedPercent !== undefined);
  const claudePercent =
    primaryWindow?.usedPercent !== undefined ? Math.round(primaryWindow.usedPercent) : null;
  const claudeLimited = windows.some((w) => w.limited);

  const claudeStatus = presence.claude?.status;
  let claudeLabel = claudePercent !== null ? `Claude %${claudePercent}` : "Claude";
  let claudeTone: Tone = "neutral";
  if (claudeLimited) {
    claudeLabel = claudePercent !== null ? `Claude %${claudePercent} (sınırda)` : "Claude sınırda";
    claudeTone = "bad";
  } else if (claudeStatus === "signed_in") {
    claudeLabel = claudePercent !== null ? `Claude %${claudePercent}` : "Claude bağlı";
    claudeTone = claudePercent !== null && claudePercent >= 85 ? "warn" : "good";
  } else if (claudeStatus === "signing_in") {
    claudeLabel = "Claude giriş yapılıyor…";
    claudeTone = "warn";
  } else if (claudeStatus === "signed_out") {
    claudeLabel = "Claude oturumu kapalı";
    claudeTone = "warn";
  } else if (claudeStatus === "not_installed" || claudeStatus === "error") {
    claudeLabel = "Claude hatası";
    claudeTone = "bad";
  } else if (claudePercent !== null) {
    claudeTone = claudePercent >= 85 ? "warn" : "info";
  }

  const geminiStatus = presence.gemini?.status;
  let geminiReady = false;
  let geminiLabel = "Gemini —";
  let geminiTone: Tone = "neutral";
  if (geminiStatus === "ready") {
    geminiReady = true;
    geminiLabel = "Gemini hazır";
    geminiTone = "good";
  } else if (geminiStatus === "not_configured") {
    geminiLabel = "Gemini yapılandırılmadı";
    geminiTone = "warn";
  } else if (geminiStatus === "error") {
    geminiLabel = "Gemini hatası";
    geminiTone = "bad";
  }

  return {
    macLabel,
    macTone,
    macDetail,
    claudePercent,
    claudeLimited,
    claudeLabel,
    claudeTone,
    geminiReady,
    geminiLabel,
    geminiTone,
  };
}

interface JobListFilters {
  brandId?: string | undefined;
  contentId?: string | undefined;
  status?: string | undefined;
  type?: string | undefined;
}

function matchesJobFilters(job: Job, filters: JobListFilters): boolean {
  if (filters.brandId && job.brandId !== filters.brandId) return false;
  if (filters.contentId && job.contentId !== filters.contentId) return false;
  if (filters.status && job.status !== filters.status) return false;
  if (filters.type && job.type !== filters.type) return false;
  return true;
}

function patchJobList(list: JobList, job: Job, matches: boolean): JobList {
  const idx = list.items.findIndex((item) => item.id === job.id);
  if (!matches) {
    if (idx === -1) return list;
    return { ...list, items: list.items.filter((item) => item.id !== job.id) };
  }
  if (idx === -1) {
    return { ...list, items: [job, ...list.items] };
  }
  const next = [...list.items];
  next[idx] = job;
  return { ...list, items: next };
}

export interface LiveJobsContextValue {
  streamStatus: JobWatchStatus;
  presence: WorkerPresence | null;
  summary: PresenceSummary;
  jobsById: ReadonlyMap<string, Job>;
  activeJobs: Job[];
  refreshStatus: () => Promise<void>;
  startClaudeLogin: () => Promise<void>;
}

const DEFAULT_VALUE: LiveJobsContextValue = {
  streamStatus: "closed",
  presence: null,
  summary: describePresence(null),
  jobsById: new Map(),
  activeJobs: [],
  refreshStatus: async () => undefined,
  startClaudeLogin: async () => undefined,
};

const LiveJobsContext = createContext<LiveJobsContextValue>(DEFAULT_VALUE);

export function LiveJobsProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [streamStatus, setStreamStatus] = useState<JobWatchStatus>("closed");
  const [streamPresence, setStreamPresence] = useState<WorkerPresence | null>(null);
  const [jobsById, setJobsById] = useState<Map<string, Job>>(() => new Map());
  const prevStatuses = useRef<Map<string, Job["status"]>>(new Map());

  const syncJobToCaches = useCallback(
    (job: Job) => {
      qc.setQueryData(queryKeys.jobs.one(job.id), job);

      const listEntries = qc.getQueriesData<JobList | InfiniteData<JobList>>({
        queryKey: ["jobs", "list"],
      });
      for (const [key, data] of listEntries) {
        if (!data) continue;
        const filters = (
          typeof key[2] === "object" && key[2] !== null ? key[2] : {}
        ) as JobListFilters;
        const matches = matchesJobFilters(job, filters);
        if ("pages" in data && Array.isArray(data.pages)) {
          const hasExisting = data.pages.some((p) => p.items.some((i) => i.id === job.id));
          const pages = data.pages.map((page, pageIndex) => {
            if (!matches) {
              return page.items.some((i) => i.id === job.id)
                ? { ...page, items: page.items.filter((i) => i.id !== job.id) }
                : page;
            }
            if (hasExisting) {
              return page.items.some((i) => i.id === job.id)
                ? { ...page, items: page.items.map((i) => (i.id === job.id ? job : i)) }
                : page;
            }
            return pageIndex === 0 ? { ...page, items: [job, ...page.items] } : page;
          });
          qc.setQueryData(key, { ...data, pages });
        } else if ("items" in data && Array.isArray(data.items)) {
          qc.setQueryData(key, patchJobList(data, job, matches));
        }
      }

      const prev = prevStatuses.current.get(job.id);
      prevStatuses.current.set(job.id, job.status);
      if (prev && !isTerminalJobStatus(prev) && isTerminalJobStatus(job.status)) {
        if (job.type === "content.generate" || job.type === "content.render") {
          void qc.invalidateQueries({ queryKey: queryKeys.contents.all });
          void qc.invalidateQueries({ queryKey: queryKeys.assets.all });
          void qc.invalidateQueries({ queryKey: queryKeys.plans.all });
        } else if (job.type === "image.generate") {
          void qc.invalidateQueries({ queryKey: queryKeys.assets.all });
          if (job.contentId) {
            void qc.invalidateQueries({ queryKey: queryKeys.contents.one(job.contentId) });
            void qc.invalidateQueries({ queryKey: queryKeys.contents.versions(job.contentId) });
          }
        } else if (job.type === "brand.analyze") {
          if (job.brandId) {
            void qc.invalidateQueries({ queryKey: queryKeys.profiles.all(job.brandId) });
          } else {
            void qc.invalidateQueries({ queryKey: ["profiles"] });
          }
        } else if (job.type === "schedule.publish") {
          void qc.invalidateQueries({ queryKey: queryKeys.schedules.all });
          void qc.invalidateQueries({ queryKey: queryKeys.contents.all });
        }
      }
    },
    [qc],
  );

  const handleStreamMessage = useCallback(
    (message: JobStreamMessage) => {
      if (message.type === "jobs.snapshot") {
        setStreamPresence(message.presence);
        setJobsById(() => {
          const next = new Map<string, Job>();
          for (const j of message.jobs) {
            next.set(j.id, j);
            prevStatuses.current.set(j.id, j.status);
            qc.setQueryData(queryKeys.jobs.one(j.id), j);
          }
          return next;
        });
        return;
      }
      if (message.type === "presence") {
        setStreamPresence(message.presence);
        return;
      }
      if (message.type === "job.updated") {
        const { job } = message;
        setJobsById((prev) => {
          const next = new Map(prev);
          next.set(job.id, job);
          return next;
        });
        syncJobToCaches(job);
      }
    },
    [qc, syncJobToCaches],
  );

  useEffect(() => {
    const watchFn = api.jobs?.watch;
    if (typeof watchFn !== "function") {
      setStreamStatus("closed");
      return;
    }
    let watch: { close(): void } | undefined;
    try {
      watch = watchFn(
        {},
        {
          onMessage: handleStreamMessage,
          onStatus: setStreamStatus,
        },
      );
    } catch {
      setStreamStatus("closed");
    }
    return () => {
      watch?.close();
    };
  }, [api, handleStreamMessage]);

  // Graceful fallback to polling when WebSocket is closed or unavailable.
  const hasPresenceEndpoint = typeof api.workers?.presence === "function";
  const polledPresence = useQuery({
    queryKey: queryKeys.presence,
    queryFn: async ({ signal }) => {
      try {
        return await api.workers.presence({ signal });
      } catch {
        return null;
      }
    },
    enabled: hasPresenceEndpoint && streamStatus === "closed",
    refetchInterval: streamStatus === "closed" ? 10_000 : false,
    retry: false,
  });

  const presence = streamPresence ?? polledPresence.data ?? null;
  const summary = useMemo(() => describePresence(presence), [presence]);

  const activeJobs = useMemo(
    () =>
      [...jobsById.values()]
        .filter((j) => j.status === "running" || j.status === "queued")
        .sort((a, b) => {
          if (a.status !== b.status) return a.status === "running" ? -1 : 1;
          return b.createdAt.localeCompare(a.createdAt);
        }),
    [jobsById],
  );

  const refreshStatus = useCallback(async () => {
    try {
      await Promise.allSettled([
        api.workers?.claudeRefresh?.(),
        api.workers?.geminiRefresh?.(),
        polledPresence.refetch(),
      ]);
      toast.success("AI ve Mac durumu yenilendi");
    } catch (error) {
      toast.error(error);
    }
  }, [api, polledPresence, toast]);

  const startClaudeLogin = useCallback(async () => {
    try {
      if (!api.workers?.claudeLogin) return;
      const res = await api.workers.claudeLogin();
      if (res.account?.loginUrl) {
        toast.success("Claude giriş bağlantısı hazır", "Mac üzerindeki tarayıcıdan giriş yapın.");
      } else {
        toast.success("Mac'te Claude girişi başlatıldı");
      }
    } catch (error) {
      toast.error(error, "Claude girişi başlatılamadı");
    }
  }, [api, toast]);

  const value = useMemo<LiveJobsContextValue>(
    () => ({
      streamStatus,
      presence,
      summary,
      jobsById,
      activeJobs,
      refreshStatus,
      startClaudeLogin,
    }),
    [streamStatus, presence, summary, jobsById, activeJobs, refreshStatus, startClaudeLogin],
  );

  return <LiveJobsContext.Provider value={value}>{children}</LiveJobsContext.Provider>;
}

export function useLiveJobs(): LiveJobsContextValue {
  return useContext(LiveJobsContext);
}

/** Shared mutation to cancel a queued or running job. */
export function useCancelJob() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();

  return useMutation({
    mutationFn: (jobId: string) => api.jobs.cancel(jobId),
    onSuccess: (updated) => {
      qc.setQueryData(queryKeys.jobs.one(updated.id), updated);
      void qc.invalidateQueries({ queryKey: queryKeys.jobs.all });
      toast.success(
        updated.status === "cancelled" ? "İş iptal edildi" : "İptal isteği worker'a iletildi",
      );
    },
    onError: (e) => toast.error(e, "İş iptal edilemedi"),
  });
}

/** Reusable "İptal et" button for queued or running jobs. */
export function CancelJobButton({
  job,
  size = "sm",
}: {
  job: Pick<Job, "id" | "status" | "cancelRequestedAt">;
  size?: "sm" | "md";
}) {
  const cancel = useCancelJob();
  if (job.status !== "queued" && job.status !== "running") return null;
  const pendingCancel = Boolean(job.cancelRequestedAt) || cancel.isPending;

  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    cancel.mutate(job.id);
  };

  return (
    <Button
      size={size}
      variant="danger"
      icon={<IconStop size={14} />}
      loading={cancel.isPending}
      disabled={pendingCancel}
      onClick={handleClick}
    >
      {job.cancelRequestedAt ? "İptal ediliyor…" : "İptal et"}
    </Button>
  );
}
