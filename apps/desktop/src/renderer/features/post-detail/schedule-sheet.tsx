// "Postu zamanla" sheet: local date and time, the brand's accounts on the post's platforms
// (with the platform rules each one reports — preflight, rechecked on every change), the
// publishing mode, then "Zamanla" (approving first when needed) or "Şimdi yayınla" after a
// confirmation. Rescheduling starts from the accounts the post already waits on; unticking one
// cancels its schedule. "Zamanlamayı iptal et" cancels without a new time.
// N13 / N15: "Önerilen saatler" (the brand's best slots; a click sets the time) and the post's
// "Yayın ayrıntıları" (folded; saving them rechecks the platform rules).
import type { Content, Schedule, SchedulePreflight, SocialAccount } from "@studio/contract";
import { nextSlotTime, readReelVersionInfo, slotLabel } from "@studio/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  cn,
  Spinner,
  TagPill,
  TextField,
} from "../../components/ui/controls.tsx";
import { ConfirmDialog, Dialog } from "../../components/ui/dialog.tsx";
import { PlatformIcon } from "../../components/ui/icons.tsx";
import { describeError, useApi } from "../../lib/api.ts";
import { useAppStore } from "../../state/app-store.ts";
import { invalidatePosts, postKeys, storeContent, usePublishingStatus } from "../posts/data.ts";
import { dateInput, dayTime, fromInputs, timeInput, timeZoneLabel } from "../posts/dates.ts";
import { useCancelSchedule } from "./cancel-schedule.tsx";
import { PublishDetailsSection } from "./publish-details.tsx";
import {
  accountLabel,
  blockingReason,
  dateError,
  defaultAccountIds,
  modeSummary,
  needsApproval,
  preflightIssues,
  publishNowConfirmation,
  SubmitError,
  schedulableAccounts,
  submitPublishNow,
  submitSchedule,
} from "./schedule.ts";

const NO_SCHEDULES: readonly Schedule[] = [];

/** The platform best times are asked for: the post's only Instagram / Facebook platform, if one. */
export function bestTimesPlatform(
  content: Pick<Content, "targetPlatforms">,
): "instagram" | "facebook" | undefined {
  const meta = content.targetPlatforms.filter((p) => p === "instagram" || p === "facebook");
  return meta.length === 1 ? (meta[0] as "instagram" | "facebook") : undefined;
}

const STATUS_NOTE: Partial<Record<SocialAccount["status"], string>> = {
  pending: "Bağlantı tamamlanmadı — önce Ayarlar → Hesaplar'dan bağlayın.",
  needs_reauth: "Yeniden bağlanması gerekiyor — Ayarlar → Hesaplar.",
};

export function ScheduleSheet({
  open,
  content,
  slideHtml,
  hash,
  accounts,
  schedules = NO_SCHEDULES,
  initialDate,
  acknowledgeChecks = false,
  onClose,
  onDone,
}: {
  open: boolean;
  content: Content;
  /** First slide of the current version (a reel's duration). */
  slideHtml: string | null;
  /** The verified hash, for approving first (null: not verified). */
  hash: string | null;
  accounts: SocialAccount[];
  /** The post's schedules (rescheduling preselects the accounts it waits on). */
  schedules?: readonly Schedule[];
  initialDate: Date;
  /** The approve guard asked about the checks and the user approves anyway (E7). */
  acknowledgeChecks?: boolean;
  onClose(): void;
  onDone(content: Content): void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const publishing = usePublishingStatus();
  const candidates = useMemo(() => schedulableAccounts(accounts, content), [accounts, content]);
  const [date, setDate] = useState(dateInput(initialDate));
  const [time, setTime] = useState(timeInput(initialDate));
  const [selected, setSelected] = useState<string[]>(() =>
    defaultAccountIds(candidates, schedules),
  );
  const [preflight, setPreflight] = useState<SchedulePreflight | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmNow, setConfirmNow] = useState(false);
  const generation = useRef(0);
  const opening = useRef({ initialDate, candidates, schedules });
  opening.current = { initialDate, candidates, schedules };
  const cancel = useCancelSchedule({
    content,
    schedules,
    accounts,
    onDone: (fresh) => {
      if (fresh) onDone(fresh);
      onClose();
    },
  });

  // Reset when it opens again.
  useEffect(() => {
    if (!open) return;
    const { initialDate: start, candidates: list, schedules: current } = opening.current;
    setDate(dateInput(start));
    setTime(timeInput(start));
    setSelected(defaultAccountIds(list, current));
    setError(null);
    setPreflight(null);
    setConfirmNow(false);
  }, [open]);

  const at = fromInputs(date, time);
  const dateProblem = dateError(at);
  const reelDurationMs =
    content.type === "reel" && slideHtml ? readReelVersionInfo(slideHtml).durationMs : null;
  const approvalNeeded = needsApproval(content);
  const block = blockingReason({
    content,
    accounts: candidates,
    selected,
    preflight,
    reelDurationMs,
    approvable: approvalNeeded ? hash !== null : true,
  });
  const atIso = at && !dateProblem ? at.toISOString() : null;
  const selectedKey = [...selected].sort().join(",");
  // Publish details take part in the platform rules (first comment length …).
  const detailsKey = JSON.stringify(content.publishDetails ?? {});
  const versionNumber = content.currentVersion?.version ?? 0;
  const version = useQuery({
    queryKey: postKeys.version(content.id, versionNumber),
    queryFn: () => api.contents.versions.get(content.id, versionNumber),
    enabled: open && versionNumber > 0,
    staleTime: 60_000,
  });
  const platform = bestTimesPlatform(content);
  const bestTimes = useQuery({
    queryKey: ["insights", "best-times", content.brandId, platform ?? "all"],
    queryFn: () => api.insights.bestTimes(content.brandId, platform ? { platform } : {}),
    enabled: open,
    staleTime: 10 * 60_000,
  });
  const pickSlot = (slot: { weekday: number; hour: number }) => {
    const next = new Date(nextSlotTime(slot));
    setDate(dateInput(next));
    setTime(timeInput(next));
  };

  // Platform rules: debounced, rechecked when the accounts or the time change.
  useEffect(() => {
    if (!open) return;
    const ids = selectedKey ? selectedKey.split(",") : [];
    if (ids.length === 0) {
      setPreflight(null);
      setChecking(false);
      return;
    }
    const mine = ++generation.current;
    setChecking(true);
    const timer = setTimeout(() => {
      api.schedules
        .preflight({
          contentId: content.id,
          socialAccountIds: ids,
          ...(atIso ? { scheduledAt: atIso } : {}),
        })
        .then((result) => {
          if (mine !== generation.current) return;
          setPreflight(result);
          setError(null);
        })
        .catch((e) => {
          if (mine === generation.current) setError(describeError(e));
        })
        .finally(() => {
          if (mine === generation.current) setChecking(false);
        });
    }, 250);
    return () => clearTimeout(timer);
    // `detailsKey`: saved publish details are checked again.
  }, [open, api, content.id, selectedKey, atIso, detailsKey]);

  const finish = async (result: { content: Content; schedules: unknown[] }, message: string) => {
    storeContent(queryClient, result.content);
    await invalidatePosts(queryClient, content.id);
    void api.publishing.requestSync().catch(() => undefined);
    useAppStore.getState().showToast({ message });
    onDone(result.content);
    onClose();
  };

  const schedule = async () => {
    if (!at || dateProblem || block) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitSchedule(api, {
        content,
        hash,
        accountIds: selected,
        date: at,
        offeredAccountIds: candidates.map((a) => a.id),
        acknowledgeChecks,
      });
      const dropped = result.cancelled.length;
      await finish(
        result,
        `Zamanlandı: ${dayTime(at)}${dropped > 0 ? ` · ${dropped} hesapta zamanlama iptal edildi` : ""}`,
      );
    } catch (e) {
      setError(describeError(e));
      if (e instanceof SubmitError && e.created.length > 0)
        await invalidatePosts(queryClient, content.id);
    } finally {
      setSubmitting(false);
    }
  };

  const publishNow = async () => {
    setConfirmNow(false);
    setSubmitting(true);
    setError(null);
    try {
      const result = await submitPublishNow(api, {
        content,
        hash,
        accountIds: selected,
        acknowledgeChecks,
      });
      await finish(result, "Yayın başladı.");
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const mode = publishing.data?.mode ?? "local";
  const chosen = candidates.filter((a) => selected.includes(a.id));
  const canSchedule = !block && !dateProblem && !submitting && !checking;
  const canPublishNow = !block && !submitting && !checking;

  return (
    <>
      <Dialog
        open={open && !confirmNow && !cancel.isOpen}
        title={content.status === "scheduled" ? "Zamanlamayı değiştir" : "Postu zamanla"}
        onClose={onClose}
        width={480}
        footer={
          <>
            {cancel.targets.length > 0 && (
              <Button
                variant="ghost"
                className="mr-auto"
                disabled={submitting}
                onClick={() => cancel.open()}
              >
                Zamanlamayı iptal et
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Vazgeç
            </Button>
            <Button
              variant="secondary"
              disabled={!canPublishNow}
              onClick={() => setConfirmNow(true)}
            >
              Şimdi yayınla
            </Button>
            <Button
              variant="primary"
              disabled={!canSchedule}
              onClick={() => void schedule()}
              data-autofocus=""
            >
              {submitting ? "Gönderiliyor…" : approvalNeeded ? "Onayla ve zamanla" : "Zamanla"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="truncate text-body text-fg-2">
            <span className="text-fg">{content.title}</span>
          </p>
          <div className="flex flex-col gap-1.5">
            <span className="text-footnote text-fg-2">Yayın zamanı</span>
            <div className="flex items-center gap-2">
              <TextField
                type="date"
                aria-label="Tarih"
                className="w-[160px]"
                value={date}
                min={dateInput(new Date())}
                invalid={!!dateProblem}
                onChange={(e) => setDate(e.target.value)}
              />
              <TextField
                type="time"
                aria-label="Saat"
                className="w-[110px]"
                value={time}
                invalid={!!dateProblem}
                onChange={(e) => setTime(e.target.value)}
              />
              <span className="text-footnote text-fg-3">{timeZoneLabel()}</span>
            </div>
            {dateProblem && <span className="text-footnote text-danger">{dateProblem}</span>}
            {bestTimes.data && bestTimes.data.suggestions.length > 0 && (
              <div className="flex flex-col gap-1 pt-1">
                <span className="text-footnote text-fg-2">Önerilen saatler</span>
                <div className="flex flex-wrap gap-1.5">
                  {bestTimes.data.suggestions.slice(0, 5).map((slot) => (
                    <Button
                      key={`${slot.weekday}:${slot.hour}`}
                      size="sm"
                      variant="secondary"
                      onClick={() => pickSlot(slot)}
                    >
                      {slotLabel(slot)}
                    </Button>
                  ))}
                </div>
                <span className="text-footnote text-fg-3">{bestTimes.data.note}</span>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-footnote text-fg-2">Hesaplar</span>
            {candidates.length === 0 && (
              <p className="text-body text-fg-3">
                Bu postun platformlarında bağlı hesap yok. Ayarlar → Hesaplar'dan bağlayın.
              </p>
            )}
            <div className="flex flex-col gap-1">
              {candidates.map((account) => {
                const isSelected = selected.includes(account.id);
                const issues = preflightIssues(preflight, account.id);
                const target = preflight?.targets.find((t) => t.socialAccountId === account.id);
                return (
                  <div
                    key={account.id}
                    className="flex flex-col gap-1 rounded-[10px] px-2.5 py-2 shadow-[inset_0_0_0_1px_var(--border-hairline)]"
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox
                        label={accountLabel(account)}
                        checked={isSelected}
                        onChange={(on) =>
                          setSelected((list) =>
                            on ? [...list, account.id] : list.filter((id) => id !== account.id),
                          )
                        }
                      />
                      <PlatformIcon platform={account.platform} size={15} className="text-icon" />
                      <span className="min-w-0 flex-1 truncate text-body text-fg">
                        {accountLabel(account)}
                      </span>
                      {isSelected && target && (
                        <TagPill tone={target.ok ? "success" : "danger"}>
                          {target.ok ? "Uygun" : "Sorunlu"}
                        </TagPill>
                      )}
                    </div>
                    {STATUS_NOTE[account.status] && (
                      <span className="pl-6 text-footnote text-accent-text">
                        {STATUS_NOTE[account.status]}
                      </span>
                    )}
                    {isSelected &&
                      issues.errors.map((issue) => (
                        <span
                          key={issue.code + issue.path}
                          className="pl-6 text-footnote text-danger"
                        >
                          ✕ {issue.message}
                        </span>
                      ))}
                    {isSelected &&
                      issues.warnings.map((issue) => (
                        <span
                          key={issue.code + issue.path}
                          className="pl-6 text-footnote text-fg-2"
                        >
                          ! {issue.message}
                        </span>
                      ))}
                  </div>
                );
              })}
            </div>
            {checking && (
              <span className="flex items-center gap-1.5 text-footnote text-fg-2">
                <Spinner size={11} /> Platform kuralları denetleniyor…
              </span>
            )}
          </div>

          <PublishDetailsSection
            content={content}
            slides={version.data?.slides ?? []}
            collapsible
            defaultOpen={false}
            onSaved={(fresh) => onDone(fresh)}
          />

          <p className="text-footnote text-fg-2">
            {approvalNeeded && "Önce bu sürüm onaylanacak. "}
            {modeSummary(mode)}
          </p>
          {block && (
            <p className="text-footnote text-accent-text" role="status">
              {block}
            </p>
          )}
          {error && (
            <p className={cn("selectable text-footnote text-danger")} role="alert">
              {error}
            </p>
          )}
        </div>
      </Dialog>
      <ConfirmDialog
        open={open && confirmNow}
        title="Şimdi yayınlansın mı?"
        message={publishNowConfirmation(content.title, chosen)}
        confirmLabel="Yayınla"
        busy={submitting}
        onConfirm={() => void publishNow()}
        onClose={() => setConfirmNow(false)}
      />
      {open && cancel.dialog}
    </>
  );
}
