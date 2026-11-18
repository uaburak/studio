// The edit panel's Kontroller tab (E6): the latest check run of the version on the canvas, as
// the post detail's Kontroller shows it, with the canvas's own actions — "Göster" selects the
// offending layer (else its slide) and zooms to it; slides have no automatic fix on the canvas
// (they are fixed by hand: "Tuvalde düzelt" shows the layer and opens Tasarım), caption findings
// open Açıklama ("Açıklamada düzelt"), and "Düzelt" stays where the worker can fix (the caption).
// "Yeniden kontrol et" runs them again; while a check runs (a save starts one) it says so.
import type { CheckRef, ContentCheckResult, ContentVersion } from "@studio/contract";
import { useState } from "react";
import type { EditorController } from "@/editor/controller";
import {
  useCheckActions,
  useCheckJobs,
  useCheckRun,
  useCheckSettings,
} from "../../checks/checks-data.ts";
import { failureCount } from "../../checks/checks-model.ts";
import { ChecksList } from "../../checks/checks-panel.tsx";
import { showCheck } from "../wecra/locate.ts";
import type { EditTab } from "../workspace-store.ts";

interface CheckedContent {
  id: string;
  brandId: string;
  status: string;
}

const LOCKED = new Set(["publishing", "published"]);

/** Failures of the shown version's latest run (the tab's badge), the brand's switched-off left out. */
export function useCheckFailures(content: CheckedContent, version: number | null): number {
  const run = useCheckRun(content, version);
  const settings = useCheckSettings(content.brandId);
  return failureCount(run.data, settings.data);
}

export function CanvasChecks({
  content,
  version,
  isCurrent,
  ed,
  waiting = false,
  onTab,
}: {
  content: CheckedContent;
  /** The version on the canvas (its run is listed; its slide HTML names the layers). */
  version: ContentVersion | null;
  isCurrent: boolean;
  /** Wecra's editor, once it is up. */
  ed: EditorController | null;
  /** Approving waits for this version's checks. */
  waiting?: boolean;
  onTab(tab: EditTab): void;
}) {
  const number = version?.version ?? null;
  const run = useCheckRun(content, number);
  const jobs = useCheckJobs(content.id);
  const actions = useCheckActions(content);
  const [actionError, setActionError] = useState<unknown>(null);
  const running = jobs.running
    ? `${jobs.running.progressMessage ?? "Kontroller çalışıyor"}…`.replace(/……$/, "…")
    : waiting
      ? "Kontroller çalışıyor…"
      : null;
  const fixBlocker = LOCKED.has(content.status)
    ? "Yayınlanan post düzeltilemez."
    : !isCurrent
      ? "Eski sürüm: düzeltme güncel sürümde yapılır."
      : null;
  const act = (p: Promise<unknown>) => {
    setActionError(null);
    p.catch((e: unknown) => setActionError(e));
  };
  const show = (ref: CheckRef): boolean =>
    ed !== null &&
    ref.slide !== null &&
    showCheck(ed, ref, version?.slides[ref.slide]?.html ?? null);
  const manualFix = (r: ContentCheckResult) => {
    if (r.status !== "fail" && r.status !== "warn") return null;
    const ref = r.refs.find((x) => x.slide !== null);
    if (ref)
      return {
        label: "Tuvalde düzelt",
        run: () => {
          show(ref);
          onTab("design");
        },
      };
    if (r.checkId.startsWith("text."))
      return { label: "Açıklamada düzelt", run: () => onTab("caption") };
    return null;
  };
  return (
    <div className="flex flex-col gap-3 px-3 py-3" data-canvas-checks="">
      <ChecksList
        run={run.data ?? null}
        version={number}
        loading={run.isLoading}
        error={actionError ?? run.error}
        running={running}
        fixBlocker={fixBlocker}
        runLabel="Yeniden kontrol et"
        onRun={number !== null ? () => act(actions.run(number)) : undefined}
        onFix={number !== null ? (checks) => act(actions.fix(number, checks)) : undefined}
        onShow={ed ? (ref) => void show(ref) : undefined}
        manualFix={manualFix}
      />
    </div>
  );
}
