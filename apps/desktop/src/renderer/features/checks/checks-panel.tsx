// "Kontroller" in the opened post (roadmap 13): the latest check run of the version shown —
// problems first with their place (click: the slide and the layer on Düzenle), "Düzelt" where an
// automatic fix exists, the passed checks folded — "Yeniden çalıştır", and the approve guard that
// asks before approving a version whose checks did not pass.
//
// Mounted into the post detail with one line each (the post detail itself is not changed).
import type {
  CheckId,
  CheckRef,
  CheckStatus,
  ContentCheckResult,
  ContentCheckRun,
} from "@studio/contract";
import { type ReactNode, useCallback, useState } from "react";
import { Button, cn, Spinner, TagPill } from "../../components/ui/controls.tsx";
import { ConfirmDialog } from "../../components/ui/dialog.tsx";
import {
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconCircleDashed,
  IconCircleX,
  IconRefresh,
  IconSparkles,
  IconWarning,
} from "../../components/ui/icons.tsx";
import { describeError } from "../../lib/api.ts";
import { formatAgo } from "../../lib/format.ts";
import { usePostsStore } from "../posts/store.ts";
import { useCheckActions, useCheckJobs, useCheckRun } from "./checks-data.ts";
import {
  approvalWarning,
  checkLabel,
  fixableChecks,
  fromVersion,
  listView,
  overallStatus,
  placeLabel,
  STATUS_LABEL,
  STATUS_TONE,
  summaryText,
} from "./checks-model.ts";

// --- presentational -------------------------------------------------------------------------------

export function StatusIcon({ status, size = 15 }: { status: CheckStatus; size?: number }) {
  const common = { size, strokeWidth: 1.75, className: "shrink-0", "aria-hidden": true } as const;
  switch (status) {
    case "fail":
      return <IconCircleX {...common} className="shrink-0 text-danger" />;
    case "warn":
      return <IconWarning {...common} className="shrink-0 text-warning" />;
    case "fixed":
      return <IconSparkles {...common} className="shrink-0 text-accent-text" />;
    case "pass":
      return <IconCircleCheck {...common} className="shrink-0 text-success" />;
    case "skipped":
      return <IconCircleDashed {...common} className="shrink-0 text-fg-3" />;
  }
}

export interface ChecksListProps {
  run: ContentCheckRun | null;
  /** The version shown (the run belongs to it). */
  version: number | null;
  loading?: boolean;
  error?: unknown;
  /** Progress line of a running `content.check` job (or the generation still running). */
  running?: string | null;
  /** Why "Düzelt" is not possible (an old version, a published post). */
  fixBlocker?: string | null;
  onRun?(): void;
  onFix?(checks: CheckId[]): void;
  onLocate?(ref: CheckRef): void;
}

/** The list itself (also in the component gallery). */
export function ChecksList({
  run,
  version,
  loading,
  error,
  running,
  fixBlocker,
  onRun,
  onFix,
  onLocate,
}: ChecksListProps) {
  const [showRest, setShowRest] = useState(false);
  const view = run ? listView(run) : null;
  const fixable = run ? fixableChecks(run) : [];
  const canFix = !!onFix && !fixBlocker && !running;

  return (
    <section aria-label="Kontroller" className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-footnote font-medium text-fg-2">Kontroller</h3>
        {running ? (
          <span className="flex items-center gap-1.5 text-footnote text-fg-2" role="status">
            <Spinner size={11} /> {running}
          </span>
        ) : (
          onRun &&
          version !== null && (
            <Button
              size="sm"
              variant="ghost"
              icon={<IconRefresh size={12} strokeWidth={2} />}
              onClick={onRun}
            >
              {run ? "Yeniden çalıştır" : "Kontrolleri çalıştır"}
            </Button>
          )
        )}
      </div>

      <div className="flex flex-col overflow-hidden rounded-[12px] shadow-[inset_0_0_0_1px_var(--border-hairline)]">
        {error ? (
          <p className="px-3 py-2.5 text-body text-danger">{describeError(error)}</p>
        ) : loading ? (
          <p className="flex items-center gap-1.5 px-3 py-2.5 text-body text-fg-3">
            <Spinner size={12} /> Kontroller yükleniyor…
          </p>
        ) : !run || !view ? (
          <p className="px-3 py-2.5 text-body text-fg-3">
            {version === null
              ? "Henüz tasarım yok."
              : running
                ? "Kontroller çalışıyor…"
                : `v${version} henüz denetlenmedi.`}
          </p>
        ) : (
          <>
            <div className="flex min-h-10 items-center gap-2.5 px-3 py-2">
              <StatusIcon status={overallStatus(run)} />
              <span className="min-w-0 flex-1">
                <span className="block text-body text-fg">{summaryText(run)}</span>
                <span className="block truncate text-footnote text-fg-3">
                  v{run.version} · {formatAgo(run.createdAt)}
                  {run.fixedVersion ? ` · v${run.fixedVersion} olarak düzeltildi` : ""}
                  {run.fromVersion ? ` · ${fromVersion(run.fromVersion)} otomatik düzeltildi` : ""}
                </span>
              </span>
              {fixable.length > 1 && onFix && (
                <span title={fixBlocker ?? "Düzeltilebilen bulguların hepsi (yeni sürüm)"}>
                  <Button size="sm" disabled={!canFix} onClick={() => onFix(fixable)}>
                    Tümünü düzelt
                  </Button>
                </span>
              )}
            </div>
            {view.problems.map((r, i) => (
              <ResultRow
                key={`${r.checkId}-${i}`}
                result={r}
                onLocate={onLocate}
                fix={
                  r.fixable && (r.status === "fail" || r.status === "warn") && onFix
                    ? {
                        disabledReason: fixBlocker ?? (running ? "Kontroller çalışıyor." : null),
                        onFix: () => onFix([r.checkId as CheckId]),
                      }
                    : null
                }
              />
            ))}
            {view.rest.length > 0 && (
              <button
                type="button"
                aria-expanded={showRest}
                onClick={() => setShowRest((s) => !s)}
                className="flex min-h-9 items-center gap-2 border-t border-hairline px-3 py-1.5 text-left text-footnote text-fg-2 hover:bg-control"
              >
                {showRest ? (
                  <IconChevronDown size={13} className="shrink-0" />
                ) : (
                  <IconChevronRight size={13} className="shrink-0" />
                )}
                {[
                  view.passed ? `${view.passed} kontrol geçti` : "",
                  view.skipped ? `${view.skipped} atlandı` : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </button>
            )}
            {showRest &&
              view.rest.map((r, i) => (
                <ResultRow key={`rest-${r.checkId}-${i}`} result={r} compact />
              ))}
          </>
        )}
      </div>
    </section>
  );
}

function ResultRow({
  result,
  compact = false,
  fix = null,
  onLocate,
}: {
  result: ContentCheckResult;
  compact?: boolean;
  fix?: { disabledReason: string | null; onFix(): void } | null;
  onLocate?: ((ref: CheckRef) => void) | undefined;
}) {
  const place = placeLabel(result);
  const ref = result.refs.find((r) => r.slide !== null);
  const locate = ref && onLocate ? () => onLocate(ref) : null;
  const body = (
    <>
      <span className="pt-0.5">
        <StatusIcon status={result.status} size={compact ? 13 : 15} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className={cn("truncate text-fg", compact ? "text-footnote" : "text-body")}>
            {checkLabel(result.checkId)}
          </span>
          {result.source === "model" && !compact && <TagPill>AI</TagPill>}
        </span>
        <span
          className={cn(
            "selectable block text-footnote [overflow-wrap:anywhere]",
            compact ? "text-fg-3" : "text-fg-2",
          )}
        >
          {result.message}
        </span>
        {place && !compact && (
          <span className={cn("block text-caption", locate ? "text-accent-text" : "text-fg-3")}>
            {place}
          </span>
        )}
      </span>
    </>
  );
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-t border-hairline",
        compact ? "px-3 py-1.5" : "px-3 py-2",
      )}
      data-status={result.status}
    >
      {locate ? (
        <button
          type="button"
          onClick={locate}
          title="Slaytta göster"
          className="-m-1 flex min-w-0 flex-1 items-start gap-2.5 rounded-[8px] p-1 text-left hover:bg-control"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2.5">{body}</div>
      )}
      {!compact && result.status !== "pass" && result.status !== "skipped" && (
        <span className="flex shrink-0 items-center gap-1.5 pt-0.5">
          {fix ? (
            <span title={fix.disabledReason ?? "Otomatik düzelt (yeni sürüm)"}>
              <Button size="sm" disabled={!!fix.disabledReason} onClick={fix.onFix}>
                Düzelt
              </Button>
            </span>
          ) : (
            <TagPill tone={STATUS_TONE[result.status]}>{STATUS_LABEL[result.status]}</TagPill>
          )}
        </span>
      )}
    </div>
  );
}

// --- connected ------------------------------------------------------------------------------------

/** What the panel needs from the post detail (its snapshot and its editor). */
export interface ChecksHost {
  snapshot: {
    content: { id: string; brandId: string; status: string; type: string };
    current: { version: number } | null;
    displayed: { version: number } | null;
  };
  editor: { selectSlide(index: number): void; selectLayer(layerId: string | null): void };
}

const LOCKED = new Set(["publishing", "published"]);

/** "Kontroller" of the version shown in the post detail. */
export function ChecksPanel({ snapshot, editor }: ChecksHost) {
  const { content } = snapshot;
  const shown = snapshot.displayed ?? snapshot.current;
  const version = shown?.version ?? null;
  const isCurrent = version !== null && version === snapshot.current?.version;
  const run = useCheckRun(content, version);
  const jobs = useCheckJobs(content.id);
  const actions = useCheckActions(content);
  const [actionError, setActionError] = useState<unknown>(null);
  const running = jobs.running
    ? `${jobs.running.progressMessage ?? "Kontroller çalışıyor"}…`.replace(/……$/, "…")
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
  return (
    <ChecksList
      run={run.data ?? null}
      version={version}
      loading={run.isLoading}
      error={actionError ?? run.error}
      running={running}
      fixBlocker={fixBlocker}
      onRun={version !== null ? () => act(actions.run(version)) : undefined}
      onFix={version !== null ? (checks) => act(actions.fix(version, checks)) : undefined}
      onLocate={(ref) => {
        if (ref.slide !== null) editor.selectSlide(ref.slide);
        if (ref.layer && content.type !== "reel") {
          usePostsStore.getState().setTab("edit");
          editor.selectLayer(ref.layer);
        }
      }}
    />
  );
}

/**
 * Approval with a question first when the current version's checks did not pass ("Yine de
 * onayla" approves anyway). `guard(approve)` runs `approve` right away when nothing blocks.
 */
export function useApproveGuard(snapshot: ChecksHost["snapshot"]): {
  guard(approve: () => void): void;
  dialog: ReactNode;
} {
  const { content } = snapshot;
  const run = useCheckRun(content, snapshot.current?.version ?? null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const warning = approvalWarning(run.data);
  const guard = useCallback(
    (approve: () => void) => {
      if (!warning) approve();
      else setPending(() => approve);
    },
    [warning],
  );
  // Keys typed in the dialog stay there (the post detail's shortcuts listen on its root).
  const dialog = (
    // biome-ignore lint/a11y/noStaticElementInteractions: only stops key events bubbling out of the dialog
    <div className="contents" onKeyDown={(e) => e.stopPropagation()}>
      <ConfirmDialog
        open={pending !== null && warning !== null}
        title={warning?.title ?? ""}
        message={
          <div className="flex flex-col gap-2">
            <ul className="flex flex-col gap-1">
              {warning?.lines.map((line) => (
                <li key={line} className="flex gap-1.5">
                  <IconCircleX size={14} className="mt-0.5 shrink-0 text-danger" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            <span>Yine de onaylamak istiyor musun?</span>
          </div>
        }
        confirmLabel="Yine de onayla"
        onClose={() => setPending(null)}
        onConfirm={() => {
          const approve = pending;
          setPending(null);
          approve?.();
        }}
      />
    </div>
  );
  return { guard, dialog };
}
