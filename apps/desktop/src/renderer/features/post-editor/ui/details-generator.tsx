// "Bilgileri üret" at the top of the Açıklama tab: a `content.details` job reads the design (its
// renders and text layers) and writes the caption, hashtags, title, alt texts and first comment
// by the brand's rules — never the design. Its progress and result show here; the post's fields
// refresh when it ends (posts/data.ts follows the job).
import type { Content } from "@studio/contract";
import { useMemo, useState } from "react";
import { Button, Spinner } from "../../../components/ui/controls.tsx";
import { describeError, useApi } from "../../../lib/api.ts";
import { useJobsSnapshot } from "../../../state/studio.tsx";
import { detailsBlocker, detailsState, latestDetailsJob } from "../details.ts";

export function DetailsGenerator({
  content,
  captionDirty,
}: {
  content: Content;
  captionDirty: boolean;
}) {
  const api = useApi();
  const { jobs } = useJobsSnapshot();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const job = useMemo(() => latestDetailsJob(jobs, content.id), [jobs, content.id]);
  const state = detailsState(job);
  const blocker = detailsBlocker({
    status: content.status,
    hasVersion: content.currentVersion !== null,
    running: starting || state.kind === "running",
    captionDirty,
  });

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      await api.jobs.create({
        type: "content.details",
        brandId: content.brandId,
        contentId: content.id,
        payload: content.currentVersion ? { version: content.currentVersion.version } : {},
      });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5 border-b border-hairline px-4 py-3">
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={blocker !== null}
          title={blocker ?? "Tasarıma göre açıklama, hashtag, başlık ve post bilgilerini yazar"}
          onClick={() => void start()}
        >
          Bilgileri üret
        </Button>
        {state.kind === "running" && (
          <span role="status" className="flex items-center gap-1.5 text-footnote text-fg-2">
            <Spinner size={12} />
            {state.message}
            {state.progress !== null && ` %${Math.round(state.progress * 100)}`}
          </span>
        )}
      </div>
      {state.kind === "done" && (
        <p role="status" className="text-footnote text-fg-2">
          {state.message}
          {state.notes.length > 0 && ` ${state.notes.join(" ")}`}
        </p>
      )}
      {(error || state.kind === "failed") && (
        <p role="alert" className="text-footnote text-danger">
          {error ?? (state.kind === "failed" ? state.message : "")}
        </p>
      )}
    </div>
  );
}
