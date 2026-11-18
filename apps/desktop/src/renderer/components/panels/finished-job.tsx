// A finished job in "Arka plan işleri" (A3): a success with its time; a failure with the reason
// in plain Turkish on its own line (the original message as the tooltip), "Yeniden dene" (the same
// job queued again — `POST /api/jobs/{id}/retry`; a plan item's generation goes through its plan)
// and "Postu aç" when the job worked on a post.
import { isRetryableJob, type Job } from "@studio/contract";
import { useState } from "react";
import { failureText } from "../../features/posts/failure.ts";
import { openPostDetail } from "../../features/posts/store.ts";
import { describeError, useApi } from "../../lib/api.ts";
import { formatAgo } from "../../lib/format.ts";
import { jobStatusText, jobTitle } from "../../lib/usage.ts";
import { useAppStore } from "../../state/app-store.ts";
import { cn } from "../ui/controls.tsx";
import { IconRetry } from "../ui/icons.tsx";

export function FinishedJobRow({ job }: { job: Job }) {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const failed = job.status === "failed";
  const reason = failed ? failureText(job.error) : null;
  const retryable = isRetryableJob(job);
  const retry = async () => {
    setBusy(true);
    try {
      await api.jobs.retry(job.id);
      useAppStore.getState().showToast({ message: `${jobTitle(job)} yeniden kuyruğa alındı.` });
    } catch (e) {
      useAppStore.getState().showToast({ message: describeError(e), tone: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex flex-col gap-1 rounded-[10px] px-3 py-2 text-body hover:bg-control">
      <div className="flex min-h-7 items-center gap-2">
        <span className={cn("min-w-0 flex-1 truncate", failed ? "text-danger" : "text-fg-2")}>
          {jobTitle(job)}
        </span>
        <span className="shrink-0 text-footnote text-fg-3">
          {job.status === "succeeded"
            ? formatAgo(job.finishedAt ?? job.updatedAt)
            : jobStatusText(job.status)}
        </span>
      </div>
      {reason && (
        <p className="line-clamp-3 text-footnote text-fg-2" title={reason.detail ?? undefined}>
          {reason.text}
        </p>
      )}
      {(failed || job.status === "cancelled") && (retryable || job.contentId) && (
        <div className="flex items-center gap-1.5">
          {retryable && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void retry()}
              className="flex h-6 items-center gap-1 rounded-full bg-control-hover px-2 text-footnote text-fg hover:bg-control-pressed disabled:opacity-40"
            >
              <IconRetry size={12} strokeWidth={1.75} />
              {busy ? "Gönderiliyor…" : "Yeniden dene"}
            </button>
          )}
          {job.contentId && (
            <button
              type="button"
              onClick={() => openPostDetail(job.contentId as string)}
              className="flex h-6 items-center rounded-full px-2 text-footnote text-accent-text hover:underline"
            >
              Postu aç
            </button>
          )}
        </div>
      )}
    </li>
  );
}
